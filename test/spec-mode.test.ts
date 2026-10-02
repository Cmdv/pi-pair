import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import pair from "../src/index.ts";

// Only RPC sessions look for an adapter, so this matters only to harnesses with an editor.
process.env.PI_PAIR_EDITOR = "test";

/** With EDITOR, the session is in RPC mode and EDITOR answers each pi-pair:v1 request. */
function harness(cwd: string, editor?: (method: string, args: any) => unknown) {
	const handlers = new Map<string, (...args: any[]) => any>();
	const entries: unknown[] = [];
	const messages: { content: unknown; options: unknown }[] = [];
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const sent: unknown[][] = [];
	const sessions: any[] = [];
	let active: string[] = [];
	pair({
		on(name: string, handler: any) { handlers.set(name, handler); },
		registerTool(tool: any) { tools.set(tool.name, tool); },
		registerCommand(name: string, options: any) { commands.set(name, options); },
		getActiveTools: () => active, setActiveTools(names: string[]) { active = names; },
		appendEntry(_type: string, data: unknown) { entries.push(data); },
		sendMessage(message: any, options: unknown) { messages.push({ content: message.content, options }); },
		sendUserMessage(...args: unknown[]) { sent.push(args); },
	} as unknown as ExtensionAPI);
	const status: (string | undefined)[] = [];
	const notices: unknown[][] = [];
	const ui = {
		setStatus: (_key: string, text?: string) => status.push(text),
		notify: (...args: unknown[]) => notices.push(args),
		select: async (_title: string, _options: string[]): Promise<string | undefined> => undefined,
		input: async (title: string, body?: string) => {
			const reply = editor?.(title.split(":").at(-1)!, JSON.parse(body ?? "null"));
			return reply === undefined ? undefined : JSON.stringify(reply);
		},
	};
	const ctx = {
		cwd, mode: editor ? "rpc" : "tui", hasUI: true, isIdle: () => true, hasPendingMessages: () => false, ui,
		sessionManager: { getBranch: () => entries.map((data) => ({ type: "custom", customType: "pi-pair", data })), getSessionFile: () => "/sessions/parent.jsonl" },
		newSession: async (options: unknown) => (sessions.push(options), { cancelled: false }),
	} as unknown as ExtensionCommandContext;
	const edit = (path: string) => handlers.get("tool_call")!({ toolName: "write", input: { path, content: "x" } }, ctx);
	const prompt = async () => (await handlers.get("before_agent_start")!({ systemPrompt: "base" }, ctx))?.systemPrompt as string;
	const result = (toolName: string, path: string, input: Record<string, unknown> = {}, isError = false) =>
		handlers.get("tool_result")!({ toolName, input: { path, ...input }, content: [], isError }, ctx);
	return {
		ctx, ui, entries, messages, status, notices, edit, prompt, result, tools, commands, sent, sessions, active: () => active,
		pair: (args: string) => commands.get("pair").handler(args, ctx),
		start: () => handlers.get("session_start")!({}, ctx),
		settle: () => handlers.get("agent_settled")!({}, ctx),
	};
}

test("picking a spec creates it, starts the interview, summarises, hands off and restores", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-pair-spec-"));
	try {
		const h = harness(cwd);
		await h.pair("both Reconnect after sleep");
		const file = join(cwd, ".pi/pi-pair/specs/reconnect-after-sleep.md");
		assert.match(readFileSync(file, "utf8"), /^# Reconnect after sleep\n/);
		// A new spec starts the interview rather than waiting for a prompt.
		assert.match(String(h.messages[0].content), /^Interview the developer for the spec \.pi\/pi-pair\/specs\/reconnect-after-sleep\.md: read it/);
		assert.deepEqual(h.messages[0].options, { triggerTurn: true });
		assert.equal(h.status.at(-1), "🧑‍🤝‍🧑 Both · reconnect-after-sleep");
		await h.pair("me"); // Spec picker dismissed: nothing changes.
		assert.equal(h.status.at(-1), "🧑‍🤝‍🧑 Both · reconnect-after-sleep");

		writeFileSync(file, "# R\n## Goal\nStay up.\n## Done when\n- It reconnects.\n## Tasks\n- [ ] Backoff @pi\n");
		writeFileSync(join(cwd, ".pi/pi-pair/specs/other.md"), "# Other\n");
		let offered: string[] = [];
		h.ui.select = async (_title: string, options: string[]) => (offered = options)[0];
		await h.pair("me"); // The active spec is offered first.
		assert.deepEqual(offered, ["reconnect-after-sleep", "New spec…", "No spec", "other"]);
		assert.equal(h.status.at(-1), "🧑‍🤝‍🧑 Me · reconnect-after-sleep");
		assert.equal(h.messages.length, 1); // Same spec: no new kick-off.
		h.result("read", "@.pi/pi-pair/specs/reconnect-after-sleep.md");
		assert.equal(h.edit(".pi/pi-pair/specs/reconnect-after-sleep.md"), undefined);
		assert.equal(h.edit("src/index.ts").block, true);
		assert.match(await h.prompt(), /Pairing mode: Me\.[\s\S]*Goal:\nStay up\.[\s\S]*Done when:\n- It reconnects\.[\s\S]*line 7: Backoff @pi/);

		// Off keeps the spec; coming back with it, a written spec hands over its next task.
		await h.pair("off");
		await h.pair("both");
		assert.match(String(h.messages[1].content), /Next task \(spec line 7\): Backoff @pi\.  Its owner suggests Both\./);
		assert.deepEqual(h.messages[1].options, { deliverAs: "nextTurn" });
		h.ui.select = async (_title: string, options: string[]) => (offered = options) && "No spec";
		await h.pair("you");
		assert.equal(h.status.at(-1), "🧑‍🤝‍🧑 You");
		assert.doesNotMatch(await h.prompt(), /Active spec/);
		await h.pair("me"); // With no active spec, New spec… comes first.
		assert.deepEqual(offered.slice(0, 2), ["New spec…", "No spec"]);
		assert.deepEqual(offered.slice(2).sort(), ["other", "reconnect-after-sleep"]);
		await h.pair("both reconnect after sleep");

		const resumed = harness(cwd);
		resumed.entries.push(...h.entries);
		resumed.start();
		assert.equal(resumed.status.at(-1), "🧑‍🤝‍🧑 Both · reconnect-after-sleep");
		assert.match(await resumed.prompt(), /Active spec: \.pi\/pi-pair\/specs\/reconnect-after-sleep\.md/);
		assert.ok(existsSync(file));
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("a ready spec offers its next task in a fresh session, here, or more refining", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-pair-spec-"));
	try {
		const h = harness(cwd);
		const ready = (choice?: string) => {
			h.ui.select = async () => choice;
			return h.tools.get("pair_spec_ready").execute("id", {}, undefined, undefined, h.ctx);
		};
		const text = async (choice?: string) => (await ready(choice)).content[0].text as string;
		await h.pair("both Ready");
		assert.ok(h.active().includes("pair_spec_ready"));
		await assert.rejects(ready(), /isn't ready/);
		writeFileSync(join(cwd, ".pi/pi-pair/specs/ready.md"), "# Ready\n## Done when\n- It works.\n## Tasks\n- [ ] First @pi\n");
		assert.match(await text("Next task here"), /chose to start here\.  Next task \(spec line 5\): First @pi/);
		assert.match(await text("Keep refining"), /keep refining/);
		assert.match(await text(undefined), /dismissed/);
		h.settle();
		assert.deepEqual(h.sent, []);
		assert.match(await text("Next task in a fresh session"), /End your turn now/);
		h.settle();
		h.settle();
		assert.deepEqual(h.sent, [["/pair:next", { expandPromptTemplates: true }]]); // Once.

		// /pair:next opens a session that keeps the mode and spec, then kicks off the task.
		await h.commands.get("pair:next").handler("", h.ctx);
		const { parentSession, setup, withSession } = h.sessions[0];
		assert.equal(parentSession, "/sessions/parent.jsonl");
		const appended: unknown[][] = [];
		await setup({ appendCustomEntry: (...args: unknown[]) => appended.push(args) });
		assert.deepEqual(appended, [["pi-pair", { mode: "both", spec: "ready" }]]);
		const kicked: any[][] = [];
		await withSession({ sendMessage: async (...args: unknown[]) => kicked.push(args) });
		assert.match(kicked[0][0].content, /^Next task \(spec line 5\): First @pi/);
		assert.deepEqual(kicked[0][1], { triggerTurn: true });

		// The new session restores pairing, tools included, from that entry.
		const fresh = harness(cwd);
		fresh.entries.push({ mode: "both", spec: "ready" });
		fresh.start();
		assert.ok(fresh.active().includes("pair_ask") && fresh.active().includes("pair_spec_ready"));

		await h.pair("off");
		assert.ok(!h.active().includes("pair_spec_ready"));
		await h.commands.get("pair:next").handler("", h.ctx);
		assert.equal(h.sessions.length, 1);
		assert.match(String(h.notices.at(-1)![0]), /Pick a mode and spec with \/pair first/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("Pi must have read the current spec before changing it", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-pair-spec-"));
	try {
		const h = harness(cwd);
		await h.pair("both Guard");
		const path = ".pi/pi-pair/specs/guard.md";
		const file = join(cwd, path);
		const reason = () => h.edit(path)?.reason as string | undefined;

		assert.match(reason()!, /Read \.pi\/pi-pair\/specs\/guard\.md in full before changing it/);
		h.result("read", path, { offset: 1, limit: 5 }); // A partial read doesn't count.
		assert.match(reason()!, /in full/);
		h.result("read", path, {}, true); // Nor does a failed one.
		assert.match(reason()!, /in full/);
		h.result("read", path);
		assert.equal(reason(), undefined);

		writeFileSync(file, "# Guard\n## Goal\nThe developer's edit.\n"); // Saved in the editor.
		assert.match(reason()!, /changed since you last read it, probably by the developer\.  Read it again/);
		h.result("read", `@${path}`);
		assert.equal(reason(), undefined);

		// Pi's own successful write counts as seen; a failed edit doesn't.
		writeFileSync(file, "# Guard\nPi's write.\n");
		h.result("write", path);
		assert.equal(reason(), undefined);
		writeFileSync(file, "# Guard\nAfter a failed edit.\n");
		h.result("edit", path, {}, true);
		assert.match(reason()!, /changed since/);

		// Off applies no rules, other files aren't guarded, and a new session forgets.
		await h.pair("off");
		assert.equal(reason(), undefined);
		await h.pair("both Guard");
		assert.equal(h.edit("src/other.ts"), undefined);
		h.result("read", path);
		assert.equal(reason(), undefined);
		h.start();
		assert.match(reason()!, /in full/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("an editor's unsaved spec buffer blocks Pi's spec edit and warns the developer", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-pair-spec-"));
	try {
		const path = ".pi/pi-pair/specs/unsaved.md";
		let capabilities = ["buffer_state"];
		let reply: unknown = { ok: true, buffers: [{ path, open: true, modified: false }] };
		const asked: unknown[] = [];
		const editor = (method: string, args: unknown) => {
			if (method === "handshake") return { version: 1, editor: "test", capabilities };
			asked.push([method, args]);
			return reply;
		};
		const h = harness(cwd, editor);
		h.start();
		await h.pair("both Unsaved");
		await h.prompt(); // Waits for the handshake.
		h.result("read", path);

		assert.equal(await h.edit(path), undefined);
		assert.deepEqual(asked.at(-1), ["buffer_state", { paths: [path] }]);

		reply = { ok: true, buffers: [{ path, open: true, modified: true }] };
		const blocked = await h.edit(path);
		assert.equal(blocked.block, true);
		assert.match(blocked.reason, /has unsaved changes in the developer's editor\.  Don't retry/);
		assert.match(String(h.notices.at(-1)![0]), /Pi tried to change \.pi\/pi-pair\/specs\/unsaved\.md, which has unsaved changes/);
		assert.equal(h.notices.at(-1)![1], "warning");

		// A broken or failing editor warns but doesn't lock the spec.
		for (reply of [{ ok: true, buffers: [] }, { ok: true, buffers: [{ path: "other.md", open: false, modified: true }] }, { ok: false, error: "No buffers" }, undefined]) {
			assert.equal(await h.edit(path), undefined);
			assert.match(String(h.notices.at(-1)![0]), /Couldn't check .*; Pi's edit went ahead/);
		}

		// A changed file is blocked by the hash guard first, without a round trip.
		const before = asked.length;
		writeFileSync(join(cwd, path), "# Unsaved\nSaved by the developer.\n");
		assert.match(h.edit(path).reason, /changed since you last read it/);
		assert.equal(asked.length, before);

		// An editor without buffer_state is never asked, and the gate stays synchronous.
		capabilities = ["show"];
		h.start();
		await h.prompt();
		h.result("read", path);
		assert.equal(h.edit(path), undefined);
		assert.equal(asked.length, before);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
