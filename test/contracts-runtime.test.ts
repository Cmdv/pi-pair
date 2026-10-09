import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import pair from "../src/index.ts";
import { contractModel } from "./fixtures/contract-model.ts";

const text = (message: any) => typeof message.content === "string" ? message.content : (message.content ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
const contracts = (messages: any[]) => messages.map(text).filter((content) => content.includes("Pair Spec turn contract\n"));

test("real Pi carries one live contract, blocks effects, writes only through pair_write and stops cleanly", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "pair-contract-runtime-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	// No editor here: an inherited PI_PAIR_EDITOR (e.g. running inside Emacs) would rightly refuse every write.
	const editor = process.env.PI_PAIR_EDITOR;
	delete process.env.PI_PAIR_EDITOR;
	t.after(() => { if (editor !== undefined) process.env.PI_PAIR_EDITOR = editor; });
	const agentDir = join(cwd, "agent");
	const spec = join(cwd, ".pi/pi-pair/specs/runtime.md");
	const requests: any[][] = [];
	const errors: unknown[] = [];
	const notices: string[] = [];
	let attempt: any[] | undefined;
	let respond: (messages: any[], signal?: AbortSignal) => Promise<any[]> = async () => [{ type: "text", text: "Fixture response." }];
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true,
		noPromptTemplates: true, noThemes: true, agentsFilesOverride: () => ({ agentsFiles: [] }), extensionFactories: [(pi) => {
			pair(pi);
			contractModel(pi, async (messages, signal) => {
				requests.push(structuredClone(messages));
				const once = attempt;
				attempt = undefined;
				return once ?? respond(messages, signal);
			});
		}] });
	await resourceLoader.reload();
	const { session } = await createAgentSession({ cwd, agentDir, resourceLoader, settingsManager,
		sessionManager: SessionManager.inMemory(cwd), thinkingLevel: "off", tools: ["read", "write", "edit", "bash", "grep", "find", "ls", "pair_write", "pair_ask"] });
	t.after(() => session.dispose());
	const model = session.modelRuntime.getModels("pair-fixture").find((m) => m.id === "fixture");
	assert.ok(model);
	await session.setModel(model);
	await session.bindExtensions({ mode: "rpc", onError: (error) => errors.push(error), uiContext: {
		setStatus() {}, notify: (message: string) => { notices.push(message); }, select: async () => undefined,
	} as unknown as ExtensionUIContext });

	await session.prompt("/pair runtime");
	assert.equal(requests.length, 0); // Choosing a spec costs nothing.
	await session.prompt("Original CAPS, untouched?!");
	assert.equal(requests.length, 1);
	assert.ok(requests[0].some((m) => m.role === "user" && text(m) === "Original CAPS, untouched?!"));
	assert.equal(contracts(requests[0]).length, 1);
	assert.match(contracts(requests[0])[0], /"phase": "describe"/);
	assert.ok(session.messages.some((m) => m.role === "custom" && m.customType === "pi-pair-contract" && m.display === false));

	attempt = [{ type: "toolCall", id: "forbidden-write", name: "write", arguments: { path: "forbidden.txt", content: "Never written" } }];
	await session.prompt("Try the forbidden tool.");
	assert.equal(existsSync(join(cwd, "forbidden.txt")), false);
	assert.ok(session.messages.some((m) => m.role === "toolResult" && m.toolCallId === "forbidden-write" && m.isError));
	assert.equal(contracts(requests.at(-1)!).length, 1); // No accumulated historical contracts.

	// The one write that is allowed goes through code, and lands without anyone approving it.
	attempt = [{ type: "toolCall", id: "write-tasks", name: "pair_write", arguments: { kind: "tasks", goal: "Stay up.", names: ["Backoff", "Report"] } }];
	await session.prompt("Break it down.");
	assert.match(readFileSync(spec, "utf8"), /## Goal\nStay up\.[\s\S]*## 1: Backoff[\s\S]*## 2: Report/);
	assert.equal(JSON.parse(readFileSync(join(cwd, ".pi/pi-pair/specs/runtime.state.json"), "utf8").trim()).specAgreed, false);
	assert.ok(session.messages.some((m) => m.role === "toolResult" && m.toolCallId === "write-tasks" && !m.isError));

	// Queued replies are ordinary messages; each request carries exactly one, current contract.
	let release!: () => void;
	let started!: () => void;
	const entered = new Promise<void>((resolve) => { started = resolve; });
	let first = true;
	respond = async () => {
		if (first) { first = false; started(); await new Promise<void>((resolve) => { release = resolve; }); }
		return [{ type: "text", text: "Queued fixture response." }];
	};
	const running = session.prompt("Start a bounded discussion.");
	await entered;
	await session.followUp("Follow-up original.");
	await session.steer("Steering original.");
	release();
	await running;
	for (const original of ["Follow-up original.", "Steering original."]) {
		const delivered = requests.find((messages) => {
			const users = messages.filter((m) => m.role === "user" && !text(m).includes("Pair Spec turn contract"));
			return text(users.at(-1) ?? {}) === original;
		});
		assert.ok(delivered, original);
		assert.equal(contracts(delivered).length, 1, original);
	}

	// An unreadable spec stops the conversation instead of guessing at it.
	const count = requests.length;
	writeFileSync(join(cwd, ".pi/pi-pair/specs/runtime.state.json"), "{");
	await session.prompt("Invalid state must fail closed.");
	assert.equal(requests.length, count);
	assert.ok(notices.some((notice) => /State is not valid JSON.*Nothing was sent to the model/s.test(notice)));
	assert.equal(session.messages.some((m) => m.role === "user" && text(m) === "Invalid state must fail closed."), false);

	await session.prompt("/pair:exit");
	respond = async () => [{ type: "text", text: "Ordinary fixture response." }];
	await session.prompt("Ordinary Pi after a clean stop.");
	assert.equal(contracts(requests.at(-1)!).length, 0);
	assert.equal(session.pendingMessageCount, 0);
	assert.equal(existsSync(join(cwd, "forbidden.txt")), false);
	assert.deepEqual(errors, []);
});
