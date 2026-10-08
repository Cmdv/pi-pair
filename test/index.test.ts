import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import pkg from "../package.json" with { type: "json" };
import pair from "../src/index.ts";
import { readyClassifier } from "./classifier-stub.ts";
test("Pair restores on/off; while it is on, the model may not edit, and after Stop it is ordinary Pi", async () => {
	const handlers = new Map<string, (...args: any[]) => any>();
	let command!: Parameters<ExtensionAPI["registerCommand"]>[1];
	let exit!: Parameters<ExtensionAPI["registerCommand"]>[1];
	const messages: { content: unknown; options: unknown }[] = [];
	let activeTools = ["read", "pair_show_code"];
	const api: Partial<ExtensionAPI> = {
		on(name, handler) { handlers.set(name, handler); return () => {}; },
		registerCommand(name, options) { if (name === "pair") command = options; if (name === "pair:exit") exit = options; },
		registerTool() {},
		registerMessageRenderer() {},
		getActiveTools: () => activeTools,
		setActiveTools(tools) { activeTools = tools; },
		// Where each tool comes from: Pair trusts Pi's own read tools, not names.
		getAllTools: () => [{ name: "read", sourceInfo: { source: "builtin", path: "<builtin:read>" } }] as any,
		appendEntry() {},
		sendMessage(message, options) { messages.push({ content: message.content, options }); },
	};
	pair(api as ExtensionAPI, readyClassifier);

	let idle = true;
	let savedPair = false;
	const ctx = {
		cwd: "/no-project", hasUI: true,
		isIdle: () => idle, hasPendingMessages: () => false, abort: () => { idle = true; }, waitForIdle: async () => {},
		sessionManager: { getSessionId: () => "test", getBranch: () => [{ type: "custom", customType: "pi-pair", data: { pair: savedPair } }] },
		// The spec picker, answered with Pair no spec.
		ui: { setStatus() {}, notify() {}, select: async () => "Pair no spec" },
	} as unknown as ExtensionCommandContext;
	const prompt = async () => (await handlers.get("before_agent_start")!({ systemPrompt: "base" }, ctx))?.systemPrompt;
	const edit = () => handlers.get("tool_call")!({ toolName: "edit", input: { edits: [] } }, ctx);

	await handlers.get("session_start")!({}, ctx);
	assert.equal(await prompt(), undefined);
	assert.equal(edit(), undefined);
	await command.handler("", ctx);
	assert.match(await prompt(), /^base\n\nPair is on without a spec/);
	assert.match(edit().reason, /^The developer drives this request/);
	assert.ok(activeTools.includes("pair_ask"));
	assert.equal(messages.length, 0);

	idle = false;
	await exit.handler("", ctx);
	assert.equal(await prompt(), undefined);
	assert.match(String(messages[0].content), /Exited Pair/);
	assert.deepEqual(messages[0].options, { triggerTurn: false });
	assert.ok(!activeTools.includes("pair_ask"));
	assert.equal(edit(), undefined); // Stopped: ordinary Pi again.
	idle = true;
	savedPair = true;
	await handlers.get("session_start")!({}, ctx);
	assert.match(await prompt(), /Pair is on without a spec/);
	assert.equal(edit().block, true);
});

test("adapter startup is opt-in, non-blocking, capability-driven and safe to reset", async (t) => {
	const handlers = new Map<string, (...args: any[]) => any>();
	/** PI_PAIR_EDITOR, which an RPC frontend sets to ask for the handshake. */
	const setEditor = (value: string | undefined) => {
		if (value === undefined) delete process.env.PI_PAIR_EDITOR;
		else process.env.PI_PAIR_EDITOR = value;
	};
	t.after(() => setEditor(undefined));
	let activeTools = ["read", "another_extension_tool", "pair_show_code"];
	let asking = false;
	const api: Partial<ExtensionAPI> = {
		on(name, handler) { handlers.set(name, handler); return () => {}; },
		registerCommand() {},
		registerTool() {},
		registerMessageRenderer() {},
		getActiveTools: () => activeTools,
		// pair_ask follows Pair alone; these lists track pair_show_code.
		setActiveTools(tools) { asking = tools.includes("pair_ask"); activeTools = tools.filter((name) => name !== "pair_ask"); },
		// Where each tool comes from: Pair trusts Pi's own read tools, not names.
		getAllTools: () => [{ name: "read", sourceInfo: { source: "builtin", path: "<builtin:read>" } }] as any,
	};
	pair(api as ExtensionAPI, readyClassifier);

	const valid = { version: 1, editor: "any-editor", capabilities: ["present"] };
	let input: ExtensionContext["ui"]["input"] = async () => JSON.stringify(valid);
	const calls: Parameters<typeof input>[] = [];
	const warnings: unknown[][] = [];
	const ctx = {
		mode: "rpc",
		sessionManager: { getBranch: () => [{ type: "custom", customType: "pi-pair", data: { pair: true } }] },
		ui: {
			setStatus() {},
			notify(...args: unknown[]) { warnings.push(args); },
			input(...args: Parameters<typeof input>) { calls.push(args); return input(...args); },
		},
	} as unknown as ExtensionContext;
	const start = () => handlers.get("session_start")!({}, ctx);
	const prompt = async () => (await handlers.get("before_agent_start")!({ systemPrompt: "base" }, ctx)).systemPrompt;

	for (const value of [undefined, "", " "]) {
		setEditor(value);
		start();
		assert.match(await prompt(), /cite path:line/);
	}
	setEditor("requested-editor"); // Capabilities matter; the reported editor need not match this label.
	for (ctx.mode of ["tui", "json", "print"] as const) {
		start();
		assert.match(await prompt(), /cite path:line/);
	}
	assert.equal(calls.length, 0);
	assert.equal(warnings.length, 0);
	assert.deepEqual(activeTools, ["read"]); // Pair is on: other extensions' tools are hidden.
	assert.equal(asking, true); // Needs no adapter.

	ctx.mode = "rpc";
	let reply!: (value: string | undefined) => void;
	input = () => new Promise((resolve) => { reply = resolve; });
	assert.equal(start(), undefined); // Awaiting here deadlocks startup in Pi's RPC runtime.
	const [title, body, options] = calls.at(-1)!;
	assert.equal(title, "pi-pair:v1:handshake");
	assert.deepEqual(JSON.parse(body!), { version: 1, coreVersion: pkg.version });
	assert.equal(options?.timeout, 5000);
	assert.ok(options?.signal);
	reply(JSON.stringify(valid));
	assert.doesNotMatch(await prompt(), /cite path:line/);
	assert.equal(warnings.length, 0);
	assert.deepEqual(activeTools, ["read", "pair_show_code"]);

	input = async () => JSON.stringify({ ...valid, capabilities: ["clear"] });
	start();
	assert.match(await prompt(), /cite path:line/);
	assert.equal(warnings.length, 0); // A valid adapter without annotations is not an error.
	assert.deepEqual(activeTools, ["read"]);

	for (const response of [undefined, "not JSON", JSON.stringify({ ...valid, version: 2 })]) {
		input = async () => response;
		warnings.length = 0;
		start();
		assert.match(await prompt(), /cite path:line/);
		assert.equal(warnings.length, 1);
		assert.match(String(warnings[0][0]), /Pairing adapter unavailable/);
		assert.equal(warnings[0][1], "warning");
	}

	warnings.length = 0;
	input = () => new Promise((resolve) => { reply = resolve; });
	start();
	const oldSignal = calls.at(-1)![2]!.signal!;
	const oldPrompt = prompt();
	setEditor(undefined);
	start();
	assert.equal(oldSignal.aborted, true);
	reply("not JSON"); // A late failure from the old session must not warn in the new one.
	await oldPrompt;
	assert.match(await prompt(), /cite path:line/);
	assert.equal(warnings.length, 0);

	setEditor("test");
	start();
	const shutdownSignal = calls.at(-1)![2]!.signal!;
	handlers.get("session_shutdown")!({}, ctx);
	assert.equal(shutdownSignal.aborted, true);
	reply(JSON.stringify(valid));
	assert.match(await prompt(), /cite path:line/); // A handshake that lands after shutdown grants nothing.
	assert.equal(warnings.length, 0);
});
