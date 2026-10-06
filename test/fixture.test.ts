import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fixture from "./fixtures/contract-tui.ts";

test("live fixture sees real developer text, attempts each tool once and uses unique IDs", async (t) => {
	const transcript = process.env.PI_PAIR_TEST_TRANSCRIPT;
	delete process.env.PI_PAIR_TEST_TRANSCRIPT;
	t.after(() => { if (transcript !== undefined) process.env.PI_PAIR_TEST_TRANSCRIPT = transcript; });
	let provider: any;
	fixture({ on() {}, registerCommand() {}, registerTool() {}, registerMessageRenderer() {},
		registerProvider: (_name: string, value: any) => { provider = value; },
	} as unknown as ExtensionAPI);
	const hidden = { role: "user", content: `Pair Spec turn contract\n${JSON.stringify({ phase: "review", task: "1", context: "Current baseHash: " + "a".repeat(64) })}\nWrite only what this contract allows.` };
	const reply = async (messages: any[], signal?: AbortSignal) => provider.streamSimple({ ...provider.models[0], provider: "pair-fixture" }, { messages }, { signal }).result();
	for (const [input, name] of [["write task", "pair_write"], ["try source write", "write"]]) {
		const messages = [{ role: "user", content: [{ type: "text", text: input }] }, hidden];
		const attempt = (await reply(messages)).content[0];
		assert.equal(attempt.name, name);
		assert.notEqual((await reply(messages)).content[0].id, attempt.id);
		const finished = await reply([...messages, { role: "toolResult", toolCallId: attempt.id, content: [] }, hidden]);
		assert.deepEqual(finished.content, [{ type: "text", text: "Local fixture tool attempt finished." }]);
	}
	const controller = new AbortController();
	controller.abort();
	assert.equal((await reply([{ role: "user", content: "slow request" }, hidden], controller.signal)).stopReason, "aborted");
});
