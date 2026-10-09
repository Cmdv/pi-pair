import assert from "node:assert/strict";
import { test } from "node:test";
import { pairContract, type Request } from "../src/requests.ts";
import type { Profile } from "../src/settings.ts";

const profile = (driver: Profile["driver"], assistance: Profile["assistance"] = "hints", checkpoint: Profile["checkpoint"] = "each_step"): Profile =>
	({ driver, assistance, checkpoint });
const request: Request = { id: 7, generation: 3, text: "Explain first, then let me try.", task: "1: Backoff" };
const ALWAYS = [/^Request 7; this contract is for this request only\.$/m, /Do only what the developer asked: no other changes or actions, even small or helpful-looking ones/,
	/mention anything else worth doing in one line and ask/, /Their words for this turn win over the profile, within what the tools allow: if they say not to edit yet, don't/,
	/Propose a profile change with pair_profile when one would help; never assume it/,
	/Shell is for non-destructive inspection and checks only; obey the permission policy/, /Never use it to edit files or bypass a refusal/,
	/Report checks actually run and what remains unverified/, /don't claim success without evidence\. The developer marks tasks done/];

test("the contract is short plain text from the live profile: the scope rule and the words-win rule, always", () => {
	for (const driver of ["human", "model"] as const) {
		const text = pairContract(request, profile(driver), false, true);
		for (const pattern of ALWAYS) assert.match(text, pattern, driver);
		assert.doesNotMatch(text, /[{}]|developerWants|defaults/); // No label block, no dead fields.
		assert.match(text, /^Task: 1: Backoff\.$/m);
		assert.ok(text.length < 1800, `${driver}: ${text.length}`);
	}
});

test("while the developer drives, assistance covers code, investigation and debugging, and each checkpoint is defined", () => {
	const human = (assistance: Profile["assistance"], checkpoint: Profile["checkpoint"] = "each_step", show = true) =>
		pairContract(request, profile("human", assistance, checkpoint), false, show);
	assert.match(human("hints"), /^Profile: you drive · hints · each step\.$/m);
	assert.match(human("hints"), /The developer drives: don't edit files\. Point to the next place with pair_show_code, or as path:line\. Assistance covers code, investigation and debugging\./);
	assert.match(human("hints", "each_step", false), /Point to the next place with path:line\./);
	assert.match(human("hints"), /Hints: point to where to look and ask for their hypothesis, without code that completes the step\./);
	assert.match(human("examples"), /Examples: show one small next step, or how to find the problem \(what to inspect or run\); ask before an example that would be the whole solution\./);
	assert.match(human("solution"), /Solution: show the code for them to type, or give the diagnosis, and explain it\./);
	assert.match(human("hints"), /Then stop and let them try\. Read their saved changes before commenting.*Never escalate on your own\./s);
	assert.match(human("hints"), /Each step: help with one step, then wait\./);
	assert.match(human("hints", "after_slice"), /After a slice: lay out the whole approach within the assistance level, then wait, and review when they say they are done\./);
	assert.doesNotMatch(human("solution"), /pair_files/);
});

test("while the model drives, it proposes files, changes only those, annotates and reports, and stops at its checkpoint", () => {
	const model = (checkpoint: Profile["checkpoint"], files?: string[], show = true) =>
		pairContract({ ...request, files }, profile("model", "solution", checkpoint), false, show);
	assert.match(model("each_step"), /^No files confirmed yet\.$/m);
	assert.match(model("each_step", ["src/client.ts", "test/client.test.ts"]), /^Confirmed files: src\/client\.ts, test\/client\.test\.ts\.$/m);
	assert.match(model("each_step"), /before your first edit, propose the files with pair_files, a line on each, and change only the files the developer confirms/);
	assert.match(model("each_step"), /annotate each consequential change with pair_show_code in annotate mode, only on lines you changed: what changed, why, and how it connects/);
	assert.match(model("each_step", undefined, false), /cite each consequential change as path:line: what changed, why, and how it connects/);
	assert.match(model("each_step"), /Report what you checked and what is unverified, then stop\./);
	assert.match(model("each_step"), /Each step: make one change the developer can review at a glance \(a function, a test or a fix\), then stop for review\./);
	assert.match(model("after_slice"), /After a slice: carry on until what they asked for is done, then stop for review\./);
	// Q1: assistance is for the developer driving; the model driving is not told how much help to give.
	assert.doesNotMatch(model("each_step"), /Hints:|Examples:|Solution:/);
});

test("stale or paused requests read only, whatever the profile", () => {
	const stale = pairContract({ ...request, files: ["src/client.ts"] }, profile("model"), true, true);
	assert.match(stale, /made before Pair changed.*Do not edit files or run commands or use web tools/s);
	assert.doesNotMatch(stale, /pair_files|No files confirmed/);
	const paused = pairContract({ ...request, paused: "The developer is driving now." }, profile("model"), false, true);
	assert.match(paused, /Changes are paused: The developer is driving now\. Do not edit files or run commands or use web tools/);
});
