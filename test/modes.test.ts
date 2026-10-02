import assert from "node:assert/strict";
import { test } from "node:test";
import { PAIRING_MAX_LINES, blockReason, changedLines, parseArgument, pickerOptions, statusText, switchMessage } from "../src/modes.ts";

test("parses /pair arguments", () => {
	assert.equal(parseArgument(""), undefined);
	assert.deepEqual(parseArgument(" You "), { state: "you" });
	assert.deepEqual(parseArgument("off"), { state: "off" });
	assert.deepEqual(parseArgument("both Reconnect  after sleep"), { state: "both", name: "Reconnect after sleep" });
	assert.equal(parseArgument("off now"), null);
	assert.equal(parseArgument("spec"), null);
	assert.equal(parseArgument("sideways"), null);
});

test("badge shows the mode and spec, nothing when off", () => {
	assert.equal(statusText("both"), "🧑‍🤝‍🧑 Both");
	assert.equal(statusText("me", "reconnect"), "🧑‍🤝‍🧑 Me · reconnect");
	assert.equal(statusText("off", "reconnect"), undefined);
});

test("picker marks the current mode and offers Off only when on", () => {
	assert.deepEqual(pickerOptions("off").map(([label]) => label), ["  Me", "  Both", "  You"]);
	assert.deepEqual(pickerOptions("me").map(([, value]) => value), ["me", "both", "you", "off"]);
	assert.equal(pickerOptions("me")[0][0], "● Me");
});

test("the active spec is editable in every mode", () => {
	const large = { content: "x\n".repeat(500) };
	for (const state of ["me", "both"] as const) assert.equal(blockReason(state, "write", large, true), undefined);
});

test("Me blocks edits and writes, nothing else", () => {
	assert.match(blockReason("me", "edit", { edits: [] })!, /Me/);
	assert.match(blockReason("me", "write", { content: "x" })!, /Me/);
	assert.equal(blockReason("me", "bash", { command: "ls" }), undefined);
	assert.equal(blockReason("me", "read", { path: "a" }), undefined);
});

test("Both blocks only large edits", () => {
	const small = { edits: [{ oldText: "a", newText: "b\nc" }] };
	const large = { edits: [{ oldText: "a", newText: "x\n".repeat(PAIRING_MAX_LINES + 1) }] };
	assert.equal(changedLines("edit", small), 2);
	assert.equal(blockReason("both", "edit", small), undefined);
	assert.match(blockReason("both", "edit", large)!, /Split it/);
});

test("off and You never block", () => {
	for (const state of ["off", "you"] as const) {
		assert.equal(blockReason(state, "write", { content: "x\n".repeat(500) }), undefined);
	}
});

test("switch message names both modes", () => {
	assert.match(switchMessage("both", "me"), /^Pairing: Both → Me\./);
	assert.match(switchMessage("you", "off"), /no longer apply/);
});
