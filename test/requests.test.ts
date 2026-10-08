import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeDecision } from "../src/classifier.ts";
import { arrange, pairContract, propose, UNCLEAR, type Proposal, type Request } from "../src/requests.ts";
import { PRESETS } from "../src/settings.ts";

const asked = (proposal: Partial<Proposal>): Proposal => ({ kind: "explain", driver: "unchanged", assistance: "unchanged", checkpoint: "unchanged", ...proposal });
const together = PRESETS["Build together"];
const driving = PRESETS["Drive and review"];

test("help can change for one request without moving the keyboard; a slice is only offered, and asking the model to edit offers one", () => {
	// E1: asking for an example or the solution never hands over the keyboard.
	assert.deepEqual(arrange(undefined, asked({ assistance: "examples" })),
		{ kind: "explain", assistance: "examples", checkpoint: "each_step", offerSlice: false });
	assert.equal(arrange(driving, asked({ kind: "implement", driver: "human", assistance: "solution" })).offerSlice, false);
	assert.equal(arrange(together, asked({ kind: "implement", assistance: "solution" })).offerSlice, false);
	// Asking the model to make the change offers a slice whatever the request label, still to be confirmed:
	// "can you make the edits for me" was labelled review, with the model asked to drive.
	for (const kind of ["implement", "review", "explain", "unclear"] as const) {
		assert.equal(arrange(together, asked({ kind, driver: "model" })).offerSlice, true, kind);
	}
	// A model preference offers one for code-changing or unclear work, and not for a confident question.
	assert.equal(arrange(driving, asked({ kind: "debug" })).offerSlice, true);
	for (const kind of ["explain", "explore", "review", "verify"] as const) assert.equal(arrange(driving, asked({ kind })).offerSlice, false, kind);
	// Doubt never broadens help, and never grants: under a model preference it asks; otherwise the developer drives.
	assert.equal(arrange(together, asked({ assistance: "unclear", checkpoint: "unclear" })).assistance, "examples");
	for (const doubt of [asked({ kind: "implement", driver: "unclear" }), UNCLEAR]) {
		assert.equal(arrange(driving, doubt).offerSlice, true);
		assert.equal(arrange(together, doubt).offerSlice, false);
		assert.equal(arrange(undefined, doubt).offerSlice, false);
	}
});

test("classification sees the whole message and reports failure, including an oversized message, as unclear", async () => {
	const seen: string[] = [];
	// The real encoder with one token per character, so its 512-token limit is what fails.
	const classifier = { classify: async (text: string, schema: any) => {
		seen.push(text);
		encodeDecision(text, (piece) => [...piece].map(() => 1), schema);
		throw new Error("unreachable for this message");
	} };
	const message = `${"Please rework the retry loop. ".repeat(40)}But don't edit anything yet.`;
	assert.deepEqual(await propose(classifier as any, message, "Task: none."), UNCLEAR);
	assert.deepEqual(seen, [message]); // Not truncated; failed on the first dimension, not retried.
});

test("a contract keeps the developer's words; stale or paused requests read only; a confirmed slice names its files", () => {
	const request: Request = { id: 7, generation: 3, text: "Explain first, then let me try. Don't edit.", kind: "explain",
		assistance: "hints", checkpoint: "each_step", files: ["src/client.ts"] };
	const human = pairContract({ ...request, files: undefined }, false, true);
	assert.equal(human.developerSaid, request.text);
	assert.deepEqual([human.driver, human.defaults, human.tools], ["human", "Guide me (default, not yet chosen)", ["read", "grep", "find", "ls", "pair_ask", "pair_show_code"]]);
	assert.match(human.instruction, /^The developer drives: do not edit files.*hints.*Stop after one step/);
	const slice = pairContract(request, false, false);
	assert.deepEqual([slice.driver, slice.files, slice.tools.slice(-2)], ["model", ["src/client.ts"], ["edit", "write"]]);
	assert.match(slice.instruction, /^You drive this slice only: change only src\/client\.ts, with edit for files that exist and write only for new ones\. .*Stop after one step.*You cannot run commands/);
	// The loop the developer drives: orient, point, help as agreed, wait, and review their saved work without taking it over.
	for (const pattern of [/Orient from their words, the code and the task/, /only when that is missing and would help, never as a test/,
		/pair_show_code when it is available, otherwise as path:line/, /After a hint or an example, stop and let them try/,
		/read the saved file before commenting, and diagnose what is wrong rather than rewriting their work/, /never escalate on your own/,
		/never require an answer/, /Never claim it works or is done, and never judge what the developer has learned/]) {
		assert.match(human.instruction, pattern);
	}
	const helped = (assistance: Request["assistance"]) => pairContract({ ...request, files: undefined, assistance }, false, true).instruction;
	assert.match(helped("examples"), /If an example would amount to the whole solution, say so and ask before showing it/); // Q1.
	assert.match(helped("solution"), /show it for them to type, and explain it; they still make the change/);
	for (const pattern of [/annotate the lines you changed with pair_show_code in annotate mode/, /Notes go only on lines this slice changed/,
		/If pair_show_code is unavailable or fails, cite path:line and say the display failed/, /what is unverified, the commands the developer should run, and anything partial/,
		/Do not start another slice/, /Never claim it works/]) {
		assert.match(slice.instruction, pattern);
	}
	for (const [blocked, flag] of [[pairContract(request, true, false), "stale"], [pairContract({ ...request, paused: "Unclear." }, false, false), "paused"]] as const) {
		assert.deepEqual([blocked.driver, "files" in blocked, blocked.tools.includes("edit"), flag in blocked], ["human", false, false, true]);
		assert.match(blocked.instruction, /Do not edit files or run commands/);
	}
});
