import { setOrder } from "../src/tasks.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { appendTasks, fingerprint, nextTaskId, parseSpec, questionItems, setGoal, slug, template, updateTask } from "../src/tasks.ts";

/** The task example from spec-workflow.md, so the design document is also a fixture. */
const EXAMPLE = (() => {
	const doc = readFileSync(new URL("../spec-workflow.md", import.meta.url), "utf8");
	const match = /```markdown\n(## 2: Discuss and agree a task\n[\s\S]*?)```/.exec(doc);
	assert.ok(match, "spec-workflow.md should contain the task example");
	return match[1];
})();

test("parses the design document's task example", () => {
	const spec = parseSpec(`# Example\n\n## Goal\nShow the format.\n\n${EXAMPLE}`);
	assert.deepEqual(spec.problems, []);
	assert.equal(spec.title, "Example");
	assert.equal(spec.goal, "Show the format.");
	assert.equal(spec.tasks.length, 1);
	const [task] = spec.tasks;
	assert.equal(task.id, "2");
	assert.equal(task.name, "Discuss and agree a task");
	assert.equal(task.line, 6);
	assert.deepEqual(Object.keys(task.sections), ["Summary", "Task", "Research", "Proposed solution", "Questions", "Edge cases", "Done when"]);
	assert.equal(task.sections.Task?.text, "Problem, intended outcome, scope and constraints.");
	assert.equal(task.sections["Done when"]?.text, "Observable outcomes and checks that demonstrate the task is finished.");
	assert.deepEqual(task.questions.map(({ id, checked, text, fields }) => [id, checked, text, fields]),
		[["Q1", true, "Does approving this task start implementation?", { Options: "No, record agreement only | Yes, implement immediately", Answer: "No. Spec only records agreement." }]]);
	assert.deepEqual(task.edges.map(({ id, checked, fields }) => [id, checked, fields]), [
		["E1", true, { Expected: "Refuse the stale approval and ask for a fresh proposal.", Check: "Edit the task after publishing; approving must not overwrite it." }],
		["E2", false, {}],
		["E3", true, { "Out of scope": "Spec is planning-only; implementation needs a separate developer decision." }],
	]);
	assert.match(task.hash, /^[0-9a-f]{64}$/);
});

test("reports malformed structure instead of guessing", () => {
	const text = [
		"# Bad", "", "## 1: One", "### Questions",
		"- [x] Q1: Ticked without an answer", "- [ ] Q1: Duplicate", "- [X] Q2: Capital X", "- [ ] no id", "  - [ ] Q3: indented", "- [ ] E1: wrong section",
		"### Edge cases", "- [x] E1: Only expected", "  - Expected: Something", "- [x] E2:", "  - Out of scope: Reason",
		"### Research", "- [ ] Q9: ignored here", "### Done when", "- [x] not a marker either",
		"## 1: Again", "## 3 Missing colon", "## 4:", "",
	].join("\n");
	const spec = parseSpec(text);
	assert.deepEqual(spec.tasks.map((task) => task.id), ["1", "1", "4"]);
	const problems = spec.problems.toSorted((a, b) => a.line! - b.line!).map(({ line, message }) => [line, message]);
	assert.deepEqual(problems.map(([line]) => line), [5, 6, 7, 8, 9, 10, 12, 14, 20, 21, 22]);
	const messages = problems.map(([, message]) => message as string);
	assert.match(messages[0], /1\.Q1 is ticked without an Answer or an Out of scope reason/);
	assert.match(messages[1], /1\.Q1 is defined twice/);
	assert.match(messages[2], /Malformed marker "- \[X\] Q2: Capital X"/);
	assert.match(messages[3], /Malformed marker "- \[ \] no id"/);
	assert.match(messages[4], /Malformed marker "- \[ \] Q3: indented".*start of the line/);
	assert.match(messages[5], /1\.E1 belongs under Edge cases/);
	assert.match(messages[6], /1\.E1 is ticked without Expected and Check, or an Out of scope reason/);
	assert.match(messages[7], /1\.E2 has no text/);
	assert.match(messages[8], /1 is defined twice/);
	assert.match(messages[9], /"3 Missing colon" looks like a task heading/);
	assert.match(messages[10], /4 has no name/);
	// Fields attach to the item above them and may continue on indented lines.
	const [edge] = parseSpec("## 1: A\n### Edge cases\n- [x] E1: Long\n  - Expected: One\n    and two.\n  - Check: Run\n    it.\n").tasks[0].edges;
	assert.deepEqual(edge.fields, { Expected: "One and two.", Check: "Run it." });
});

test("ignores fenced examples and markers outside Questions and Edge cases", () => {
	const text = [
		"# F", "", "## 1: One", "### Task", "```markdown", "## 9: Not a task", "### Questions", "- [ ] Q1: Not a question", "```", "Real task text.",
		"### Questions", "- [ ] Q1: Real", "~~~", "- [x] Q2: fenced", "~~~", "### Done when", "- [ ] A checklist, not a marker", "",
	].join("\n");
	const spec = parseSpec(text);
	assert.deepEqual(spec.problems, []);
	assert.deepEqual(spec.tasks.map((task) => task.id), ["1"]);
	assert.deepEqual(spec.tasks[0].questions.map((question) => question.id), ["Q1"]);
	assert.match(spec.tasks[0].sections.Task!.text, /Real task text/);
	assert.equal(spec.tasks[0].sections["Done when"]!.text, "- [ ] A checklist, not a marker");
	const fenced = parseSpec("## 1: A\n### Questions\n````markdown\n````js\n- [ ] Q1: example only\n````\n");
	assert.deepEqual(fenced.tasks[0].questions, []);
	assert.deepEqual(fenced.problems, []);
});

test("hashes a task's content, not its whitespace or its neighbours", () => {
	const one = "# H\n\n## 1: A\n### Task\nDo A.\n\n## 2: B\n### Task\nDo B.\n";
	const [a, b] = parseSpec(one).tasks;
	assert.notEqual(a.hash, b.hash);
	const spaced = parseSpec(one.replace("Do A.", "Do A.   ").replaceAll("\n", "\r\n"));
	assert.equal(spaced.tasks[0].hash, a.hash);
	const changedB = parseSpec(one.replace("Do B.", "Do B differently."));
	assert.equal(changedB.tasks[0].hash, a.hash);
	assert.notEqual(changedB.tasks[1].hash, b.hash);
	assert.notEqual(parseSpec(one.replace("1: A", "1: A renamed")).tasks[0].hash, a.hash); // A name is content.
	assert.equal(fingerprint(["x", "", ""]), fingerprint(["x "]));
	const goal = `## Goal\nOld shared goal.\n\n${one}`;
	const editedGoal = parseSpec(goal.replace("Old shared goal.", "New shared goal."));
	assert.ok(parseSpec(goal).tasks.every((task, i) => task.hash !== editedGoal.tasks[i].hash));
	assert.match(parseSpec("## Goal\nOne\n## Goal\nTwo\n").problems[0].message, /Goal is defined twice/);
	assert.match(parseSpec("## 1: One\n### Task\nA\n### Task\nB\n").problems[0].message, /Task section is defined twice/);
});

test("updates one task's sections and name, keeping the rest of the file", () => {
	const text = "# U\n\n## Goal\nG.\n\n## 1: One\n\n### Task\nOld task.\n\n### Questions\n- [ ] Q1: Open?\n\n## 2: Two\n\n### Task\nKeep me.\n";
	const updated = updateTask(text, "1", { name: "One renamed", sections: { Task: "New task.\nTwo lines.", Research: "None needed.", "Done when": "It works." } });
	assert.equal(updated, [
		"# U", "", "## Goal", "G.", "",
		"## 1: One renamed", "", "### Task", "New task.", "Two lines.", "", "### Research", "None needed.", "",
		"### Questions", "- [ ] Q1: Open?", "", "### Done when", "It works.", "",
		"## 2: Two", "", "### Task", "Keep me.", "",
	].join("\n"));
	const spec = parseSpec(updated);
	assert.deepEqual(spec.problems, []);
	assert.equal(spec.tasks[1].hash, parseSpec(text).tasks[1].hash);
	assert.throws(() => updateTask(text, "9", { name: "x" }), /no task 9/);
	assert.throws(() => updateTask(text, "1", { name: " " }), /needs a name/);
	// An emptied section keeps its heading; two missing sections land in canonical order.
	assert.ok(updateTask(text, "2", { sections: { Task: "" } }).endsWith("## 2: Two\n\n### Task\n"));
	assert.match(updateTask(text, "1", { sections: { Research: "R.", "Proposed solution": "P." } }),
		/### Task\nOld task\.\n\n### Research\nR\.\n\n### Proposed solution\nP\.\n\n### Questions/);
});

test("questions become checkable items however the model writes them", () => {
	const prose = "1. Should it retry?\n2) Fixed or exponential,\n   with a cap?\n- Log every attempt?";
	assert.equal(questionItems(prose), [
		"- [ ] Q1: Should it retry?",
		"- [ ] Q2: Fixed or exponential, with a cap?",
		"- [ ] Q3: Log every attempt?",
	].join("\n"));
	// Items already written as markers keep their ids, answers and ticks; the rest are numbered above them.
	const mixed = "- [x] Q2: Settled?\n  - Answer: Yes.\n\nQ9: Cap it?\nAnything else?";
	assert.equal(questionItems(mixed), [
		"- [x] Q2: Settled?", "  - Answer: Yes.", "- [ ] Q3: Cap it?", "- [ ] Q4: Anything else?",
	].join("\n"));
	assert.deepEqual(parseSpec(`## 1: One\n\n### Questions\n${questionItems(prose)}\n`).tasks[0].questions
		.map((item) => [item.id, item.checked, item.text]),
		[["Q1", false, "Should it retry?"], ["Q2", false, "Fixed or exponential, with a cap?"], ["Q3", false, "Log every attempt?"]]);
	// A section saying there is nothing to ask leaves no question behind.
	for (const nothing of ["", "None.", "n/a", "No open questions"]) assert.equal(questionItems(nothing), "");
});

test("edits preserve untouched suffix bytes and EOF, including CRLF and no final newline", () => {
	for (const eol of ["\n", "\r\n"]) {
		for (const ending of ["", eol, eol.repeat(3)]) {
			const text = ["## 1: One", "### Task", "Old", "", "## 2: Two", "### Task", "Keep"].join(eol) + ending;
			assert.equal(updateTask(text, "1", {}), text);
			assert.equal(updateTask(text, "1", { sections: { Task: "New" } }), text.replace("Old", "New"));
			assert.equal(setGoal(text, "Goal"), `## Goal${eol}Goal${eol}${eol}${text}`);
		}
	}
});

test("creates specs, sets the goal and appends tasks with fresh IDs", () => {
	assert.equal(slug("  Reconnect after Sleep! "), "reconnect-after-sleep");
	assert.equal(slug("!!"), "");
	const fresh = template("Reconnect");
	assert.equal(fresh, "# Reconnect\n\n## Goal\n");
	assert.deepEqual(parseSpec(fresh).tasks, []);
	assert.equal(nextTaskId(parseSpec(fresh)), "1");
	const withGoal = setGoal(fresh, "Stay connected.\nAcross sleep.");
	assert.equal(withGoal, "# Reconnect\n\n## Goal\nStay connected.\nAcross sleep.\n");
	assert.equal(parseSpec(withGoal).goal, "Stay connected.\nAcross sleep.");
	const { text, ids } = appendTasks(withGoal, ["Detect sleep", "Back off"]);
	assert.deepEqual(ids, ["1", "2"]);
	const sections = "### Summary\n\n### Task\n\n### Research\n\n### Proposed solution\n\n### Questions\n\n### Edge cases\n\n### Done when\n";
	assert.equal(text, `${withGoal}\n## 1: Detect sleep\n\n${sections}\n## 2: Back off\n\n${sections}`);
	const spec = parseSpec(text);
	assert.deepEqual(spec.problems, []);
	assert.deepEqual(spec.tasks.map((task) => [task.id, task.name, Object.keys(task.sections).length]), [["1", "Detect sleep", 7], ["2", "Back off", 7]]);
	assert.equal(nextTaskId(spec), "3");
	assert.equal(nextTaskId(spec, ["7", "other"]), "8"); // IDs the state still knows are not reused.
	assert.deepEqual(appendTasks(text, ["Third"], ["5"]).ids, ["6"]);
	assert.deepEqual(appendTasks(text, []), { text, ids: [] });
	assert.throws(() => appendTasks(text, [" "]), /needs a name/);
	// A spec without a Goal section gets one after the title; filling an appended task replaces only its blank body.
	assert.equal(setGoal("# Bare\n\n## 1: One\n", "G."), "# Bare\n\n## Goal\nG.\n\n## 1: One\n");
	assert.equal(setGoal("## 1: One\n", "G."), "## Goal\nG.\n\n## 1: One\n");
	assert.match(updateTask(text, "2", { sections: { Task: "Wait longer." } }), /## 2: Back off\n\n### Summary\n\n### Task\nWait longer\.\n\n### Research\n/);
});

test("the order is a top-level section after the goal: advice on the sequence, which reopens no task", () => {
	const text = "# S\n\n## Goal\nG.\n\n## 1: One\n### Task\nA.\n";
	const withOrder = setOrder(text, "1 first.");
	assert.equal(withOrder, "# S\n\n## Goal\nG.\n\n## Order\n1 first.\n\n## 1: One\n### Task\nA.\n");
	assert.equal(parseSpec(withOrder).order, "1 first.");
	assert.equal(setOrder(withOrder, "Still 1 first."), withOrder.replace("1 first.", "Still 1 first."));
	assert.equal(parseSpec(withOrder).tasks[0].hash, parseSpec(text).tasks[0].hash);
	assert.match(parseSpec("## Order\nA\n## Order\nB\n").problems[0].message, /Order is defined twice/);
});
