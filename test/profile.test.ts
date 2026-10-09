import { test } from "node:test";
import assert from "node:assert/strict";
import { profileFrom, profileQuestions, STARTING } from "../src/settings.ts";
import { labelled } from "../src/ask.ts";

test("profile dialog: current first; typed and skipped tabs keep it; nothing picked is a cancel", () => {
	assert.deepEqual(profileQuestions(STARTING).map((q) => q.options[0]), ["You (current)", "Hints (current)", "Each step (current)"]);
	assert.deepEqual(profileQuestions(STARTING, { driver: "model" })[0].options, ["The model (proposed)", "You (current)"]);
	assert.deepEqual(labelled(profileQuestions(STARTING)[0].options), ["You (current)", "The model"]);
	assert.equal(profileFrom(STARTING, [null, null, null]), undefined);
	assert.equal(profileFrom(STARTING, [{ answer: "The model", typed: true }, null, null]), undefined);
	assert.deepEqual(profileFrom(STARTING, [{ answer: "The model (proposed)", typed: false }, { answer: "lots", typed: true }, null]),
		{ ...STARTING, driver: "model" });
});
