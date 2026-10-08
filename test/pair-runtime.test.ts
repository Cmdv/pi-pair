import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import pair from "../src/index.ts";
import { loadSpec } from "../src/proposals.ts";
import { stateFile, writeState } from "../src/state.ts";
import { classifierStub, readyClassifier } from "./classifier-stub.ts";
import { contractModel } from "./fixtures/contract-model.ts";

const text = (message: any) => typeof message.content === "string" ? message.content : (message.content ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
/** The Pair request contracts one model call carried, parsed. */
const contracts = (messages: any[]) => messages.map(text).filter((content) => content.startsWith("Pair request contract\n"))
	.map((content) => JSON.parse(content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1)));
const SPEC = "# Flow\n\n## Goal\nStay up.\n\n## 1: Backoff\n### Task\nRetry.\n### Proposed solution\nDelay.\n### Done when\nChecked.\n";

test("real Pi serves each Pair request one fresh contract: custom starts, tool continuations, queued delivery and Stop", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "pair-request-runtime-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const editor = process.env.PI_PAIR_EDITOR;
	delete process.env.PI_PAIR_EDITOR; // No editor here; an inherited one would refuse writes for want of buffer checks.
	t.after(() => { if (editor !== undefined) process.env.PI_PAIR_EDITOR = editor; });
	// An approved one-task spec, so the task list can start work.
	const spec = join(cwd, ".pi/pi-pair/specs/flow.md");
	mkdirSync(join(cwd, ".pi/pi-pair/specs"), { recursive: true });
	writeFileSync(spec, SPEC);
	writeState(stateFile(spec), { tasks: { "1": { agreedHash: loadSpec(spec).parsed.tasks[0].hash, completedHash: null } }, specAgreed: true });
	writeFileSync(join(cwd, "notes.txt"), "Retry with backoff.\n");

	const requests: any[][] = [];
	const errors: unknown[] = [];
	let respond: (messages: any[]) => Promise<any[]> = async () => [{ type: "text", text: "Fixture response." }];
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const agentDir = join(cwd, "agent");
	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true,
		noPromptTemplates: true, noThemes: true, agentsFilesOverride: () => ({ agentsFiles: [] }), extensionFactories: [(pi) => {
			pair(pi, readyClassifier);
			contractModel(pi, async (messages) => { requests.push(structuredClone(messages)); return respond(messages); });
		}] });
	await resourceLoader.reload();
	const { session } = await createAgentSession({ cwd, agentDir, resourceLoader, settingsManager,
		sessionManager: SessionManager.inMemory(cwd), thinkingLevel: "off", tools: ["read", "write", "edit", "bash", "grep", "find", "ls", "pair_ask"] });
	t.after(() => session.dispose());
	await session.setModel(session.modelRuntime.getModels("pair-fixture").find((m) => m.id === "fixture")!);
	let picks: Record<string, string> = { "Pair": "Pair with spec", "Pair with spec": "flow", "Pair tasks · flow": "Backoff · next", "Task 1: Backoff": "Implement task" };
	await session.bindExtensions({ mode: "rpc", onError: (error) => errors.push(error), uiContext: {
		setStatus() {}, notify() {}, input: async () => undefined,
		select: async (title: string, options: string[]) => title.startsWith("Pair settings") ? options[0] : picks[title],
	} as unknown as ExtensionUIContext });
	// The provider sees custom messages as user messages; the contract is one of them, so skip it.
	const last = (messages: any[]) => text(messages.filter((m) => m.role === "user" && !text(m).startsWith("Pair request contract\n")).at(-1) ?? {});

	// A task started from the list is a custom message Pi delivers itself; it is still one resolved request.
	await session.prompt("/pair");
	await session.agent.waitForIdle();
	assert.equal(requests.length, 1);
	const [start] = contracts(requests[0]);
	assert.match(start.developerSaid, /^Pair on task 1: Backoff from /);
	assert.deepEqual([start.driver, start.task, contracts(requests[0]).length], ["human", "1: Backoff", 1]);

	// A tool continuation is another model call for the same request, with exactly one contract.
	let reads = 0;
	respond = async () => reads++ ? [{ type: "text", text: "Read it." }] : [{ type: "toolCall", id: "read-notes", name: "read", arguments: { path: "notes.txt" } }];
	await session.prompt("Explain notes.txt.");
	const [asked, continued] = requests.slice(-2).map(contracts);
	assert.deepEqual([asked.length, continued.length], [1, 1]);
	assert.deepEqual([asked[0].developerSaid, continued[0].request], ["Explain notes.txt.", asked[0].request]);

	// Queued words are resolved when typed and served when Pi delivers them, each with its own contract.
	let release!: () => void;
	let entered!: () => void;
	const started = new Promise<void>((resolve) => { entered = resolve; });
	let blocked = true;
	respond = async () => {
		if (blocked) { blocked = false; entered(); await new Promise<void>((resolve) => { release = resolve; }); }
		return [{ type: "text", text: "Queued fixture response." }];
	};
	const running = session.prompt("Start a discussion.");
	await started;
	await session.followUp("Follow-up original.");
	await session.steer("Steering original.");
	release();
	await running;
	const served = new Map(requests.map((messages) => [last(messages), contracts(messages)]));
	for (const original of ["Follow-up original.", "Steering original."]) {
		assert.deepEqual(served.get(original)?.map((contract) => contract.developerSaid), [original], original);
	}
	assert.notEqual(served.get("Follow-up original.")![0].request, served.get("Steering original.")![0].request);

	// Stop while a follow-up waits in Pi's queue: abort leaves it queued, so it is delivered later, stale, and cannot write.
	blocked = true;
	const stopped = new Promise<void>((resolve) => { entered = resolve; });
	respond = async (messages) => {
		if (blocked) { blocked = false; entered(); await new Promise<void>((resolve) => { release = resolve; }); }
		return last(messages) === "Queued before Stop." && !messages.some((m) => m.role === "toolResult" && m.toolCallId === "stale-write")
			? [{ type: "toolCall", id: "stale-write", name: "write", arguments: { path: "stale.txt", content: "Never written" } }]
			: [{ type: "text", text: "Stopped fixture response." }];
	};
	const interrupted = session.prompt("Keep going.");
	await stopped;
	await session.followUp("Queued before Stop.");
	const off = session.prompt("/pair:exit");
	release();
	await Promise.all([interrupted, off]);
	await session.prompt("Ordinary after Stop.");
	await session.agent.waitForIdle();
	const stale = requests.find((messages) => last(messages) === "Queued before Stop.");
	assert.ok(stale, "Pi delivered the follow-up queued before Stop");
	assert.deepEqual(contracts(stale).map((contract) => contract.stale), [true]);
	assert.ok(session.messages.some((m: any) => m.role === "toolResult" && m.toolCallId === "stale-write" && m.isError));
	assert.equal(existsSync(join(cwd, "stale.txt")), false);
	const ordinary = requests.find((messages) => last(messages) === "Ordinary after Stop.");
	assert.ok(ordinary);
	assert.equal(contracts(ordinary).length, 0); // A genuinely new request after Stop is ordinary Pi.
	assert.deepEqual(errors, []);
});

test("real Pi: while the developer drives every effect fails; a confirmed slice edits only its file, and other refusals still hold", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "pair-effects-runtime-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const editor = process.env.PI_PAIR_EDITOR;
	delete process.env.PI_PAIR_EDITOR; // No editor: saved-disk checks only.
	t.after(() => { if (editor !== undefined) process.env.PI_PAIR_EDITOR = editor; });
	writeFileSync(join(cwd, "notes.txt"), "Retry with backoff.\n");
	writeFileSync(join(cwd, "other.txt"), "Untouched.\n");
	let respond: (messages: any[]) => any[] = () => [{ type: "text", text: "Done." }];
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const agentDir = join(cwd, "agent");
	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true,
		noPromptTemplates: true, noThemes: true, agentsFilesOverride: () => ({ agentsFiles: [] }), extensionFactories: [(pi) => {
			// Every typed request reads as implementation work; whether it may edit is up to the developer's confirmation.
			pair(pi, classifierStub({ pair_request: "implement" }));
			let calls = 0;
			contractModel(pi, async (messages) => messages.at(-1)?.role === "toolResult" || calls++ % 2 ? [{ type: "text", text: "Done." }] : respond(messages));
		}, (pi) => {
			// An ordinary permission policy from another extension, which Pair must never override.
			pi.on("tool_call", (event) => JSON.stringify(event.input).includes("DENIED") ? { block: true, reason: "Denied by policy." } : undefined);
		}] });
	await resourceLoader.reload();
	const { session } = await createAgentSession({ cwd, agentDir, resourceLoader, settingsManager,
		sessionManager: SessionManager.inMemory(cwd), thinkingLevel: "off", tools: ["read", "write", "edit", "bash", "grep", "find", "ls", "pair_ask"] });
	t.after(() => session.dispose());
	await session.setModel(session.modelRuntime.getModels("pair-fixture").find((m) => m.id === "fixture")!);
	let preset = "Guide me";
	const handoff = ["Choose files…", "Confirm"];
	let typedFile = false;
	await session.bindExtensions({ mode: "rpc", onError: () => {}, uiContext: {
		setStatus() {}, notify() {}, input: async () => "notes.txt",
		select: async (title: string, options: string[]) => title === "Pair" ? "Pair no spec"
			: title.startsWith("Pair settings") ? options.find((option) => option.startsWith(preset))
			: title.startsWith("Choose files") ? (typedFile ? "\x06" : ((typedFile = true), options.find((o) => o.startsWith("Type"))))
			: title.startsWith("Hand this request to the model?") ? handoff.shift() : undefined,
	} as unknown as ExtensionUIContext });
	const result = (id: string) => session.messages.find((m: any) => m.role === "toolResult" && m.toolCallId === id) as any;
	const call = (id: string, name: string, args: object) => ({ type: "toolCall", id, name, arguments: args });

	// Guide me: one response reaching for every way to change something, including tools Pair does not offer.
	await session.prompt("/pair");
	respond = () => [
		call("h-write", "write", { path: "notes.txt", content: "Overwritten.\n" }),
		call("h-edit", "edit", { path: "notes.txt", edits: [{ oldText: "Retry", newText: "Changed" }] }),
		call("h-bash", "bash", { command: "echo changed > notes.txt" }),
		call("h-deploy", "deploy", { target: "production" }),
		call("h-spec", "pair_write", { kind: "tasks", goal: "x", names: ["y"] }),
		call("h-ls", "ls", { path: "." }),
	];
	await session.prompt("Add retry.");
	for (const id of ["h-write", "h-edit", "h-bash", "h-deploy", "h-spec"]) assert.equal(result(id)?.isError, true, id);
	assert.equal(result("h-ls")?.isError, false);
	assert.equal(readFileSync(join(cwd, "notes.txt"), "utf8"), "Retry with backoff.\n");

	// Drive and review: the developer confirms notes.txt for this request; nothing else, and no other refusal, gives way.
	preset = "Drive and review";
	await session.prompt("/pair:settings");
	respond = () => [
		call("m-edit", "edit", { path: "notes.txt", edits: [{ oldText: "Retry", newText: "Retry three times" }] }),
		call("m-other", "edit", { path: "other.txt", edits: [{ oldText: "Untouched", newText: "Changed" }] }),
		call("m-denied", "edit", { path: "notes.txt", edits: [{ oldText: "backoff", newText: "DENIED" }] }),
		call("m-bash", "bash", { command: "echo changed > other.txt" }),
	];
	await session.prompt("Add retry.");
	await session.agent.waitForIdle();
	assert.equal(handoff.length, 0); // Confirmed through the dialog.
	assert.equal(result("m-edit")?.isError, false);
	for (const id of ["m-other", "m-denied", "m-bash"]) assert.equal(result(id)?.isError, true, id);
	assert.match(text(result("m-denied")), /Denied by policy/);
	assert.equal(readFileSync(join(cwd, "notes.txt"), "utf8"), "Retry three times with backoff.\n");
	assert.equal(readFileSync(join(cwd, "other.txt"), "utf8"), "Untouched.\n");
	const review = session.messages.findLast((m: any) => m.role === "custom" && m.details?.review) as any;
	assert.deepEqual(review?.details.review.files, [{ path: "notes.txt", before: "Retry with backoff.\n", after: "Retry three times with backoff.\n",
		span: { start_line: 1, end_line: 1 }, changedSince: false }]);
	assert.match(text(review), /Changed: notes\.txt lines 1-1;.*Pair ran no checks\./);
	assert.equal(existsSync(join(cwd, "changed")), false);
});
