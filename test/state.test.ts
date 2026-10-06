import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { emptyState, parseState, readState, stateFile, status, writeState, type State } from "../src/state.ts";
import { parseSpec, updateTask } from "../src/tasks.ts";

const SPEC = [
	"# S", "", "## Goal", "G.", "",
	"## 1: One", "### Task", "Do one.", "### Proposed solution", "Like this.", "### Questions", "- [x] Q1: Sure?", "  - Answer: Yes.", "### Done when", "It works.", "",
	"## 2: Two", "### Task", "Do two.", "### Proposed solution", "Like that.", "### Edge cases", "- [ ] E1: Open edge", "### Done when", "Checked.", "",
].join("\n");

test("parses and validates state, and drops fields this version no longer keeps", () => {
	const valid: State = { tasks: { 1: { agreedHash: "abc", completedHash: null } }, specAgreed: true };
	assert.deepEqual(parseState(JSON.stringify(valid)), valid);
	// A spec written before the execution order was removed still opens.
	assert.deepEqual(parseState('{"tasks":{},"executionOrder":["1"],"orderAgreed":true}'), emptyState());
	assert.throws(() => parseState("{"), /not valid JSON/);
	assert.throws(() => parseState('{"tasks":{},"specAgreed":"yes"}'), /\/specAgreed must be boolean/);
	assert.throws(() => parseState('{"tasks":{"1":{"agreedHash":null}},"specAgreed":false}'), /completedHash/);
	assert.throws(() => parseState('{"tasks":{"1":{"agreedHash":"","completedHash":null}},"specAgreed":false}'), /agreedHash/);
	assert.throws(() => parseState("[]"), /State \//);
	assert.equal(stateFile("/p/.pi/pi-pair/specs/my-spec.md"), "/p/.pi/pi-pair/specs/my-spec.state.json");
});

test("derives agreement, completion and approval from content and state", () => {
	const spec = parseSpec(SPEC);
	assert.deepEqual(spec.problems, []);
	const [t1, t2] = spec.tasks;
	const fresh = status(spec, emptyState());
	assert.deepEqual(fresh.tasks.map(({ id, name, agreed, stale, completed, open, missing, populated }) => [id, name, agreed, stale, completed, open, missing, populated]),
		[["1", "One", false, false, false, 0, [], true], ["2", "Two", false, false, false, 1, [], true]]);
	assert.deepEqual([fresh.total, fresh.agreed, fresh.completed, fresh.approvable, fresh.ready, fresh.problems], [2, 0, 0, false, false, []]);

	// One agreed task is enough to approve the spec; approving it is a separate, explicit act.
	const one: State = { tasks: { 1: { agreedHash: t1.hash, completedHash: null } }, specAgreed: false };
	assert.deepEqual([status(spec, one).agreed, status(spec, one).approvable, status(spec, one).ready], [1, true, false]);
	assert.equal(status(spec, { ...one, specAgreed: true }).ready, true);

	const state: State = {
		tasks: { 1: { agreedHash: t1.hash, completedHash: t1.hash }, 2: { agreedHash: t2.hash, completedHash: null } },
		specAgreed: true,
	};
	const agreed = status(spec, state);
	assert.deepEqual(agreed.tasks.map((task) => [task.agreed, task.completed]), [[true, true], [true, false]]);
	assert.deepEqual([agreed.agreed, agreed.completed, agreed.approvable, agreed.ready], [2, 1, true, true]);

	// Resolving E1 changes 2, so its agreement goes stale until it is approved again.
	const resolved = parseSpec(SPEC.replace("- [ ] E1: Open edge", "- [x] E1: Open edge\n  - Expected: Fine.\n  - Check: Try it."));
	assert.deepEqual(resolved.problems, []);
	const reopened = status(resolved, state);
	assert.deepEqual([reopened.tasks[1].agreed, reopened.tasks[1].stale, reopened.tasks[1].open, reopened.agreed, reopened.ready], [false, true, 0, 1, true]);
	// Approval of the spec survives one task going stale, but not every task going stale.
	const allStale = status(resolved, { tasks: { 1: { agreedHash: "old", completedHash: null }, 2: { agreedHash: "old", completedHash: null } }, specAgreed: true });
	assert.deepEqual([allStale.agreed, allStale.approvable, allStale.ready], [0, false, false]);

	const malformed = parseSpec(SPEC.replace("- [ ] E1: Open edge", "-  [ ] E1: Open edge"));
	assert.match(malformed.problems[0].message, /Malformed marker/);
	assert.equal(status(malformed, state).ready, false); // Spec problems block approval.

	// Completion needs current agreement; an edit to a completed task reopens it without erasing the record.
	const edited = parseSpec(updateTask(SPEC, "1", { sections: { Task: "Do one differently." } }));
	const after = status(edited, state).tasks[0];
	assert.deepEqual([after.agreed, after.stale, after.completed], [false, true, false]);

	// An empty required section leaves a task unpopulated: content to fill in, not content to review.
	const bare = parseSpec("# B\n\n## 1: One\n### Task\nX.\n");
	const bareStatus = status(bare, { tasks: { 1: { agreedHash: bare.tasks[0].hash, completedHash: null } }, specAgreed: true });
	assert.deepEqual([bareStatus.tasks[0].missing, bareStatus.tasks[0].populated, bareStatus.ready], [["Proposed solution", "Done when"], false, true]);

	// State that points at unknown tasks is a problem rather than a guess.
	const bad = status(spec, { tasks: { 9: { agreedHash: "x", completedHash: null } }, specAgreed: true });
	assert.deepEqual(bad.problems.map((problem) => problem.message), ["The state records 9, which is not in the spec."]);
	assert.deepEqual([bad.approvable, bad.ready], [false, false]);
	assert.ok(status(parseSpec("## 1: A\n## 1: B\n"), emptyState()).problems.length > 0); // Spec problems flow through.
	assert.equal(status(parseSpec("# Empty\n"), { tasks: {}, specAgreed: true }).ready, false); // No tasks is never ready.
});

test("reads missing state as empty and writes it atomically", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-pair-state-"));
	try {
		const file = join(dir, "nested", "s.state.json");
		assert.deepEqual(readState(file), emptyState());
		const state: State = { tasks: { 1: { agreedHash: "h", completedHash: null } }, specAgreed: false };
		writeState(file, state);
		assert.deepEqual(readState(file), state);
		assert.equal(readFileSync(file, "utf8"), `${JSON.stringify(state, null, 2)}\n`);
		assert.deepEqual(readdirSync(join(dir, "nested")), ["s.state.json"]); // No temporary file left behind.
		writeFileSync(file, "{ nope");
		assert.throws(() => readState(file), /s\.state\.json: State is not valid JSON/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
