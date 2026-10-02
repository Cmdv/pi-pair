import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import { OTHER, answerText, ask, askParameters } from "../src/ask.ts";

/** A UI that answers selects and inputs from REPLIES in order, recording what it was offered. */
function ui(...replies: (string | undefined)[]) {
	const offered: unknown[][] = [];
	const next = async (...args: unknown[]) => (offered.push(args), replies.shift());
	return { offered, select: next, input: next } as any;
}

const questions = [
	{ question: "Public or private?", options: ["Public", "Private"] },
	{ question: "Which licence?", options: ["GPL-3.0", "MIT"] },
	{ question: "npm too?", options: ["Yes", "No"] },
];

test("pair_ask takes 1–3 questions with 2–5 options each", () => {
	assert.ok(Value.Check(askParameters, { questions }));
	assert.ok(!Value.Check(askParameters, { questions: [] }));
	assert.ok(!Value.Check(askParameters, { questions: [...questions, questions[0]] }));
	assert.ok(!Value.Check(askParameters, { questions: [{ question: "Only one?", options: ["Yes"] }] }));
});

test("each question offers its options plus Other, which asks for typed text", async () => {
	const fake = ui("Public", OTHER, "  AGPL  ", "No");
	const answers = await ask(fake, questions);
	assert.deepEqual(fake.offered[0].slice(0, 2), ["Public or private?", ["Public", "Private", OTHER]]);
	assert.deepEqual(answers, [
		{ question: "Public or private?", answer: "Public", typed: false },
		{ question: "Which licence?", answer: "AGPL", typed: true },
		{ question: "npm too?", answer: "No", typed: false },
	]);
	assert.equal(answerText(answers, 3), "Public or private?\n→ Public\n\nWhich licence?\n→ AGPL (typed by the developer)\n\nnpm too?\n→ No");
});

test("dismissing a question, or an empty Other, stops asking", async () => {
	const partial = await ask(ui("Public", undefined), questions);
	assert.equal(partial.length, 1);
	assert.match(answerText(partial, 3), /dismissed the remaining questions; don't ask them again[\s\S]*low-risk assumption/);
	const none = await ask(ui(OTHER, "  "), questions);
	assert.deepEqual(none, []);
	assert.match(answerText(none, 3), /^The developer dismissed the question;/);
});
