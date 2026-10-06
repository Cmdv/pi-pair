import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import { OTHER, answerText, askEach, askParameters, askTabs } from "../src/ask.ts";

/** A UI that answers selects and inputs from REPLIES in order, recording what it was offered. */
function ui(...replies: (string | undefined)[]) {
	const offered: unknown[][] = [];
	const next = async (...args: unknown[]) => (offered.push(args), replies.shift());
	return { offered, select: next, input: next } as any;
}

const questions = [
	{ label: "Visibility", question: "Public or private?", options: ["Public", "Private"] },
	{ label: "Licence", question: "Which licence?", options: ["GPL-3.0", "MIT"] },
	{ label: "npm", question: "npm too?", options: ["Yes", "No"] },
];

test("pair_ask takes 1–5 labelled questions with 2–5 options each", () => {
	assert.ok(Value.Check(askParameters, { questions }));
	assert.ok(Value.Check(askParameters, { questions: [...questions, ...questions].slice(0, 5) }));
	assert.ok(!Value.Check(askParameters, { questions: [] }));
	assert.ok(!Value.Check(askParameters, { questions: [...questions, ...questions] }));
	assert.ok(!Value.Check(askParameters, { questions: [{ label: "One", question: "Only one?", options: ["Yes"] }] }));
	assert.ok(!Value.Check(askParameters, { questions: [{ question: "No label?", options: ["Yes", "No"] }] }));
	assert.ok(!Value.Check(askParameters, { questions: [{ ...questions[0], label: "A label far too long" }] }));
});

test("each question offers its options plus Other, which asks for typed text", async () => {
	const fake = ui("Public (recommended)", OTHER, "  AGPL  ", "No");
	const answers = await askEach(fake, questions);
	// The recommendation is said, not implied by being first.
	assert.deepEqual(fake.offered[0].slice(0, 2), ["Public or private?", ["Public (recommended)", "Private", OTHER]]);
	assert.deepEqual(answers, [{ answer: "Public", typed: false }, { answer: "AGPL", typed: true }, { answer: "No", typed: false }]);
	assert.equal(answerText(questions, answers), "Public or private?\n→ Public\n\nWhich licence?\n→ AGPL (typed by the developer)\n\nnpm too?\n→ No");
});

test("dismissing a question, or an empty Other, stops asking", async () => {
	const partial = await askEach(ui("Public", undefined), questions);
	assert.deepEqual(partial, [{ answer: "Public", typed: false }, null, null]);
	assert.match(answerText(questions, partial), /^Public or private\?\n→ Public\n\nThe developer skipped these questions; don't ask again[\s\S]*low-risk assumption[^\n]*\n- Which licence\?\n- npm too\?$/);
	const none = await askEach(ui(OTHER, "  "), questions.slice(0, 1));
	assert.deepEqual(none, [null]);
	assert.match(answerText(questions.slice(0, 1), none), /^The developer skipped this question;[\s\S]*\n- Public or private\?$/);
});

const [RIGHT, LEFT, DOWN, ENTER, BACKTAB, ESC] = ["\x1b[C", "\x1b[D", "\x1b[B", "\r", "\x1b[Z", "\x1b"];

/** Run askTabs on QUESTIONS, pressing KEYS in order; returns the answers and the screen before each key. */
async function tabs(qs: typeof questions, keys: string[], signal?: AbortSignal) {
	const screens: string[] = [];
	const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => `[${text}]`, bold: (text: string) => text };
	const custom = (factory: any) => new Promise((done, fail) => {
		const component = factory({ requestRender() {} }, theme, {}, done);
		for (const key of keys) {
			screens.push(component.render(80).join("\n"));
			component.handleInput(key);
		}
		// Fail rather than hang; with a SIGNAL the test finishes the dialog by aborting.
		if (!signal) fail(new Error("The keys ran out before the dialog finished"));
	});
	return { answers: await askTabs({ custom } as any, qs, signal), screens };
}

test("tabs move back and forth, keep answers, and submit with skipped questions", async () => {
	const { answers, screens } = await tabs(questions, [
		ENTER, // Visibility: Public, on to Licence
		DOWN, DOWN, ENTER, ..."AGPL", ENTER, // Licence: typed, on to npm
		BACKTAB, ENTER, "!", ENTER, // back to Licence: retyped from what was there
		BACKTAB, LEFT, DOWN, ENTER, // back to Visibility: Private
		RIGHT, RIGHT, ENTER, // skip npm; Submit
	]);
	assert.equal(screens[0].split("\n")[0], "← [ ☐ Visibility ]  ☐ Licence   ☐ npm   ✔ Submit  →");
	assert.match(screens[0], /❯ 1\. Public \(recommended\)\n  2\. Private\n  3\. Other…/);
	assert.match(screens[8], /Your answer: AGPL/);
	assert.match(screens[10], /☒ Visibility  \[ ☒ Licence \][\s\S]*❯ 3\. Other… AGPL/);
	assert.match(screens[11], /Your answer: AGPL/);
	assert.match(screens[15], /\[ ☒ Visibility \][\s\S]*❯ 1\. Public/);
	assert.match(screens.at(-1)!, /\[ ✔ Submit \][\s\S]*Review your answers\n\nVisibility: Private\nLicence: AGPL!\nnpm: skipped\n\n❯ 1\. Submit answers/);
	assert.deepEqual(answers, [{ answer: "Private", typed: false }, { answer: "AGPL!", typed: true }, null]);
});

test("Esc, Cancel and an abort skip every question; one question needs no Submit", async () => {
	assert.deepEqual((await tabs(questions, [ENTER, ESC])).answers, [null, null, null]);
	assert.deepEqual((await tabs(questions, [LEFT, DOWN, ENTER])).answers, [null, null, null]);
	const aborted = new AbortController();
	const pending = tabs(questions, [], aborted.signal);
	aborted.abort();
	assert.deepEqual((await pending).answers, [null, null, null]);
	const single = await tabs(questions.slice(0, 1), [RIGHT, DOWN, ENTER]);
	assert.deepEqual(single.answers, [{ answer: "Private", typed: false }]);
	assert.doesNotMatch(single.screens.join("\n"), /Submit|Tab/);
});
