import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { apply, loadSpec, save } from "../src/proposals.ts";
import { emptyState, stateFile, status, writeState } from "../src/state.ts";
import { parseSpec } from "../src/tasks.ts";

const TEXT = "# S\n\n## Goal\nG.\n\n## 1: One\n### Task\nA.\n### Proposed solution\nB.\n### Done when\nC.\n\n## 2: Two\n### Task\nD.\n### Proposed solution\nE.\n### Done when\nF.\n\n\n";

test("writes validate structure, preserve other tasks and never agree what they save", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-pair-write-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "s.md");
	writeFileSync(file, TEXT);
	const initial = loadSpec(file);
	writeState(stateFile(file), { tasks: Object.fromEntries(initial.parsed.tasks.map((task) => [task.id, { agreedHash: task.hash, completedHash: null }])), specAgreed: true });
	const before = loadSpec(file);
	assert.equal(before.view.ready, true);
	const payload = { kind: "task", id: "1", baseHash: before.parsed.tasks[0].hash, sections: { Task: "Changed." } };
	const prepared = apply(before, payload);
	assert.equal(prepared.text, TEXT.replace("A.\n", "Changed.\n\n"));
	assert.equal(prepared.summary, "task 1");
	// Saving content is not agreement: the recorded hash is left alone, so the rewritten task falls out of agreement.
	assert.equal(prepared.state.tasks["1"].agreedHash, before.parsed.tasks[0].hash);
	const rewritten = status(parseSpec(prepared.text), prepared.state);
	assert.deepEqual([rewritten.tasks[0].agreed, rewritten.tasks[0].stale, rewritten.tasks[1].agreed, rewritten.approvable], [false, true, true, true]);

	assert.throws(() => apply(before, { ...payload, baseHash: "wrong" }), /Task 1 has content written under a different baseHash/);
	// Filling in an empty task has no work to lose, so it needs no hash; a written one still does.
	assert.throws(() => apply(before, { kind: "task", id: "1", sections: { Task: "Changed." } }), /different baseHash/);
	const fresh = apply(before, { kind: "tasks", names: ["Fresh"] });
	const withFresh = { ...before, text: fresh.text, parsed: parseSpec(fresh.text), state: fresh.state };
	assert.equal(apply({ ...withFresh, view: status(withFresh.parsed, withFresh.state) },
		{ kind: "task", id: "3", sections: { Task: "Written without a hash." } }).summary, "task 3");
	assert.throws(() => apply(before, { ...payload, sections: { Wrong: "X" } }), /Invalid payload/);
	assert.throws(() => apply(before, { ...payload, ids: ["1"] }), /Invalid payload.*kind task takes/s);
	assert.throws(() => apply(before, { ...payload, sections: {} }), /Invalid payload/);
	assert.throws(() => apply(before, { ...payload, sections: { Task: "X\n\n## 9: Smuggled task" } }), /structural spec headings/);
	assert.throws(() => apply(before, { ...payload, sections: { Questions: "- [x] Q1: Unanswered" } }), /without an Answer/);
	assert.throws(() => apply(before, { kind: "tasks", names: ["Bad\n## 8: Name"] }), /Invalid payload/);
	assert.throws(() => apply(before, { kind: "tasks", names: ["Good"], goal: "G\n## 9: Smuggled" }), /structural spec headings/);
	assert.throws(() => apply(before, { kind: "tasks" }), /Send a goal, an order, names, or any of them/);
	assert.throws(() => apply(before, { kind: "order", ids: ["1", "2"] }), /Invalid payload/);
	// A new task is appended with its own empty state entry, and nothing else moves.
	const added = apply(before, { kind: "tasks", names: ["Three"] });
	assert.equal(added.summary, "task 3");
	assert.deepEqual(added.state.tasks["3"], { agreedHash: null, completedHash: null });
	assert.deepEqual(parseSpec(added.text).tasks.map((task) => task.id), ["1", "2", "3"]);
	assert.equal(apply(before, { kind: "tasks", goal: "New goal." }).summary, "the goal");
	assert.equal(apply(before, { kind: "tasks", goal: "New goal.", names: ["Three"] }).summary, "task 3 and the goal");
	assert.throws(() => apply(loadSpec(file), { kind: "tasks", goal: "   " }), /Record the goal/);

	assert.throws(() => save(file, before, prepared, () => { throw new Error("simulated state disk failure"); }), /disk failure/);
	const interrupted = loadSpec(file);
	assert.equal(interrupted.text, prepared.text); // Content was saved first.
	assert.deepEqual([interrupted.view.tasks[0].agreed, interrupted.view.tasks[1].agreed], [false, true]);
	assert.throws(() => save(file, before, prepared), /changed while writing/);

	const current = loadSpec(file);
	writeState(stateFile(file), emptyState());
	assert.throws(() => save(file, current, apply(current, { ...payload, baseHash: current.parsed.tasks[0].hash })), /changed while writing/);
	assert.equal(readFileSync(file, "utf8"), prepared.text);

	writeFileSync(file, TEXT.replaceAll("\n", "\r\n"));
	const crlf = loadSpec(file);
	const multiline = { ...payload, baseHash: crlf.parsed.tasks[0].hash, sections: { Task: "Line one.\nLine two." } };
	assert.match(apply(crlf, multiline).text, /Line one\.\r\nLine two\./);
	assert.match(apply(crlf, { kind: "tasks", names: ["Three"], goal: "Goal one.\nGoal two." }).text, /Goal one\.\r\nGoal two\./);
	assert.throws(() => apply(crlf, { ...multiline, sections: { Task: "Line one.\n## 9: Injected" } }), /structural spec headings/);
});

test("the order is written with the task list and cannot smuggle headings", () => {
	const parsed = parseSpec(TEXT);
	const state = emptyState();
	const before = { text: TEXT, parsed, state, view: status(parsed, state) };
	const prepared = apply(before, { kind: "tasks", order: "1 then 2." });
	assert.deepEqual([prepared.summary, prepared.ids, parseSpec(prepared.text).order], ["the order", [], "1 then 2."]);
	assert.throws(() => apply(before, { kind: "tasks", order: "X\n## 9: Smuggled" }), /order cannot contain structural/);
});
