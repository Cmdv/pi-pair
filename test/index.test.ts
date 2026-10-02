import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import pkg from "../package.json" with { type: "json" };
import pair from "../src/index.ts";
import type { State } from "../src/modes.ts";

function assertAssistantEdits(text: unknown) {
	assert.ok(typeof text === "string");
	assert.match(text, /use edit\/write tools yourself/);
	assert.match(text, /Do not hand the developer code to type or paste/);
	assert.match(text, /another go-ahead in chat/);
	assert.match(text, /tool approval mechanism; never bypass it/);
	assert.match(text, /Follow the current mode even if earlier messages used a developer-types workflow/);
	assert.match(text, /asks only for an explanation or instructions, answer without editing/);
	assert.match(text, /before the first edit\/write after each developer prompt/);
	assert.match(text, /brief comment saying what you are about to change/);
	assert.doesNotMatch(text, /The developer writes all the code/);
}

test("restored, idle and mid-turn modes explicitly assign edits to the assistant", async () => {
	const handlers = new Map<string, (...args: any[]) => any>();
	let command!: Parameters<ExtensionAPI["registerCommand"]>[1];
	const messages: { content: unknown; options: unknown }[] = [];
	let activeTools = ["read", "pair_show_code"];
	const api: Partial<ExtensionAPI> = {
		on(name, handler) { handlers.set(name, handler); return () => {}; },
		registerCommand(name, options) { if (name === "pair") command = options; },
		registerTool() {},
		getActiveTools: () => activeTools,
		setActiveTools(tools) { activeTools = tools; },
		appendEntry() {},
		sendMessage(message, options) { messages.push({ content: message.content, options }); },
	};
	pair(api as ExtensionAPI);

	let idle = true;
	let savedMode: State = "off";
	const ctx = {
		cwd: "/no-project",
		isIdle: () => idle,
		sessionManager: { getBranch: () => [{ type: "custom", customType: "pi-pair", data: { mode: savedMode } }] },
		// The spec picker, answered with No spec.
		ui: { setStatus() {}, notify() {}, select: async () => "No spec" },
	} as unknown as ExtensionCommandContext;
	const prompt = async () => (await handlers.get("before_agent_start")!({ systemPrompt: "base" }, ctx))?.systemPrompt;
	const edit = () => handlers.get("tool_call")!({ toolName: "edit", input: { edits: [] } }, ctx);

	for (const mode of ["both", "you"] as const) {
		savedMode = mode;
		await handlers.get("session_start")!({}, ctx);
		assertAssistantEdits(await prompt());

		await command.handler("me", ctx);
		assert.equal(edit().block, true);
		messages.length = 0;
		await command.handler(mode, ctx);
		assertAssistantEdits(await prompt());
		assert.match(await prompt(), /^base\n\nPairing mode:/);
		assert.equal(edit(), undefined);
		assert.equal(messages.length, 0); // Idle switches rely on the next system prompt.

		idle = false;
		await command.handler("me", ctx);
		messages.length = 0;
		await command.handler(mode, ctx);
		assert.equal(messages.length, 1);
		assertAssistantEdits(messages[0].content);
		assert.match(String(messages[0].content), /Apply the new mode now; stop following the previous mode's workflow/);
		assert.deepEqual(messages[0].options, { deliverAs: "steer" });

		idle = true;
		await command.handler("off", ctx);
		assert.equal(await prompt(), undefined);
		assert.equal(edit(), undefined);
	}
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
		getActiveTools: () => activeTools,
		// pair_ask follows the mode alone; these lists track pair_show_code.
		setActiveTools(tools) { asking = tools.includes("pair_ask"); activeTools = tools.filter((name) => name !== "pair_ask"); },
	};
	pair(api as ExtensionAPI);

	const valid = { version: 1, editor: "any-editor", capabilities: ["present"] };
	let input: ExtensionContext["ui"]["input"] = async () => JSON.stringify(valid);
	const calls: Parameters<typeof input>[] = [];
	const warnings: unknown[][] = [];
	const ctx = {
		mode: "rpc",
		sessionManager: { getBranch: () => [{ type: "custom", customType: "pi-pair", data: { mode: "you" } }] },
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
	assert.deepEqual(activeTools, ["read", "another_extension_tool"]);
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
	assert.deepEqual(activeTools, ["read", "another_extension_tool", "pair_show_code"]);

	input = async () => JSON.stringify({ ...valid, capabilities: ["clear"] });
	start();
	assert.match(await prompt(), /cite path:line/);
	assert.equal(warnings.length, 0); // A valid adapter without annotations is not an error.
	assert.deepEqual(activeTools, ["read", "another_extension_tool"]);

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
	assert.match(await prompt(), /cite path:line/);
	assert.equal(warnings.length, 0);
});
