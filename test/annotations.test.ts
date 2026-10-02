import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import pair from "../src/index.ts";
import type { Annotation } from "../src/protocol.ts";

test("annotations are capability-gated, acknowledged before persistence and safe across session changes", async () => {
	const handlers = new Map<string, (...args: any[]) => any>();
	const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
	const tools = new Map<string, Pick<Parameters<ExtensionAPI["registerTool"]>[0], "execute">>();
	let activeTools = ["read", "another_tool", "pair_show_code"];
	let asking = false;
	const entries: { type: string; data: unknown }[] = [];
	const api: Partial<ExtensionAPI> = {
		on(name, handler) { handlers.set(name, handler); return () => {}; },
		registerCommand(name, command) { commands.set(name, command); },
		registerTool(value) { tools.set(value.name, value); },
		getActiveTools: () => activeTools,
		// pair_ask follows the mode alone; these lists track pair_show_code.
		setActiveTools(tools) { asking = tools.includes("pair_ask"); activeTools = tools.filter((name) => name !== "pair_ask"); },
		appendEntry(type, data) { entries.push({ type, data }); },
	};
	pair(api as ExtensionAPI);

	let capabilities = ["present", "annotate", "clear"]; 
	let showWhenOff: boolean | undefined;
	let restored = "me";
	process.env.PI_PAIR_EDITOR = "test";
	let response: () => Promise<string | undefined> = async () => '{"ok":true}';
	const calls: { method: string; args: any }[] = [];
	const notices: unknown[][] = [];
	const ctx = {
		cwd: "/no-project",
		mode: "rpc",
		isIdle: () => true,
		sessionManager: { getBranch: () => [{ type: "custom", customType: "pi-pair", data: { mode: restored } }] },
		ui: {
			setStatus() {},
			notify(...args: unknown[]) { notices.push(args); },
			select: async () => "No spec", // The spec picker.
			async input(title: string, body: string) {
				const method = title.split(":").at(-1)!;
				calls.push({ method, args: JSON.parse(body) });
				return method === "handshake" ? JSON.stringify({ version: 1, editor: "test", capabilities, showWhenOff }) : response();
			},
		},
	} as unknown as ExtensionCommandContext;
	const start = async () => {
		handlers.get("session_start")!({}, ctx);
		await handlers.get("before_agent_start")!({ systemPrompt: "base" }, ctx);
	};
	const call = (params: unknown, signal?: AbortSignal) => tools.get("pair_show_code")!.execute("call-1", params as never, signal, undefined, ctx);
	const run = (signal?: AbortSignal) => call({ mode: "annotate", ranges: [{ path: "src/one.ts", start_line: 4, note: "A useful note" }] }, signal);
	const clear = (args: string) => commands.get("pair:clear")!.handler(args, ctx);
	const annotations = () => entries.filter((entry) => entry.type === "pi-pair-annotation");

	await start();
	assert.deepEqual(activeTools, ["read", "another_tool", "pair_show_code"]);
	assert.equal(asking, true);
	assert.equal(handlers.get("tool_call")!({ toolName: "pair_show_code", input: {} }, ctx), undefined);
	const result = await run();
	const notes = (result.details as { annotations: Annotation[] }).annotations;
	const note = notes[0];
	assert.equal(notes.length, 1);
	assert.match(note.id, /^[0-9a-f-]{36}$/);
	assert.equal(note.end_line, 4);
	assert.equal(note.kind, "note");
	assert.deepEqual(calls.at(-1), { method: "present", args: { annotations: notes } });
	assert.deepEqual(annotations(), [{ type: "pi-pair-annotation", data: note }]);

	// Each mode needs its own capability; show is never recorded; mixed calls fail before sending.
	const shown = { mode: "show", ranges: [{ path: "src/two.ts", start_line: 7 }] };
	await assert.rejects(call(shown), /does not support show/);
	const beforeInvalid = calls.length;
	await assert.rejects(call({ mode: "annotate", ranges: [{ path: "a.ts", start_line: 1 }] }), /annotate needs a note/);
	await assert.rejects(call({ mode: "annotate", ranges: [{ path: "a.ts", start_line: 1, note: " " }] }), /annotate needs a note/);
	await assert.rejects(call({ mode: "show", ranges: [{ path: "a.ts", start_line: 1, note: "x" }] }), /show takes no notes/);
	assert.equal(calls.length, beforeInvalid);
	capabilities = ["show"];
	await start();
	assert.deepEqual(activeTools, ["read", "another_tool", "pair_show_code"]);
	const before = entries.length;
	assert.deepEqual((await call(shown)).details, { ranges: [{ path: "src/two.ts", start_line: 7, end_line: 7 }] });
	assert.deepEqual(calls.at(-1), { method: "show", args: { ranges: [{ path: "src/two.ts", start_line: 7, end_line: 7 }] } });
	assert.equal(entries.length, before);
	await assert.rejects(run(), /does not support present/);
	capabilities = ["present", "annotate", "clear"];
	await start();

	await clear(note.id);
	assert.deepEqual(calls.at(-1), { method: "clear", args: { ids: [note.id] } });
	assert.deepEqual(entries.at(-1), { type: "pi-pair-clear", data: { ids: [note.id] } });
	const count = calls.length;
	await commands.get("pair")!.handler("off", ctx);
	assert.equal(asking, false);
	assert.equal(calls.length, count); // Off hides the tool, but does not clear existing notes.
	assert.deepEqual(activeTools, ["read", "another_tool"]);
	assert.equal(handlers.get("tool_call")!({ toolName: "pair_show_code", input: {} }, ctx).block, true);
	await assert.rejects(run(), /Pairing is off/);
	// An editor reporting showWhenOff keeps showing code while off.
	showWhenOff = true;
	restored = "off";
	await start();
	assert.deepEqual(activeTools, ["read", "another_tool", "pair_show_code"]);
	assert.equal(asking, false);
	assert.equal(handlers.get("tool_call")!({ toolName: "pair_show_code", input: {} }, ctx), undefined);
	await run();
	assert.deepEqual(calls.at(-1)!.method, "present");
	showWhenOff = undefined;
	restored = "me";
	await clear("all"); // An explicit developer action remains available while off.
	assert.deepEqual(calls.at(-1), { method: "clear", args: { all: true } });
	assert.deepEqual(entries.at(-1), { type: "pi-pair-clear", data: { all: true } });
	const beforeUsage = calls.length;
	await clear("");
	await clear("all another-id");
	assert.equal(calls.length, beforeUsage);

	await commands.get("pair")!.handler("you", ctx);
	for (const reply of [undefined, '{"ok":"yes"}', '{"ok":false,"error":"File unavailable"}']) {
		response = async () => reply;
		const before = entries.length;
		await assert.rejects(run());
		await clear("all");
		assert.equal(entries.length, before);
		assert.equal(notices.at(-1)![1], "error");
	}

	response = async () => '{"ok":true}';
	capabilities = ["annotate"];
	await start();
	assert.deepEqual(activeTools, ["read", "another_tool"]);
	await assert.rejects(run(), /does not support present/);
	const beforeMissingClear = calls.length;
	await clear("all");
	assert.equal(calls.length, beforeMissingClear);
	assert.match(String(notices.at(-1)![0]), /does not support clear/);
	capabilities = ["clear"]; 
	await start();
	assert.deepEqual(activeTools, ["read", "another_tool"]);
	await assert.rejects(run(), /does not support present/);

	capabilities = ["present", "clear"];
	await start();
	let acknowledge!: (value: string) => void;
	let requested!: () => void;
	const sent = new Promise<void>((resolve) => { requested = resolve; });
	response = () => new Promise((resolve) => { acknowledge = resolve; requested(); });
	const beforeLateReply = annotations().length;
	const pending = run();
	await sent;
	handlers.get("session_shutdown")!({}, ctx);
	acknowledge('{"ok":true}');
	await assert.rejects(pending, /abort/i);
	assert.equal(annotations().length, beforeLateReply);
	assert.deepEqual(activeTools, ["read", "another_tool"]);
	delete process.env.PI_PAIR_EDITOR;
});
