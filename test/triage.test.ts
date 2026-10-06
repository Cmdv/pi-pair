import assert from "node:assert/strict";
import { test } from "node:test";
import { decision, type DecisionSchema } from "../src/classifier.ts";
import { CUTOFF, OPERATIONS, SCOPES, scopesFor, triage, writeScope } from "../src/triage.ts";

/** Scores a label per dimension; equal scores give a confidence no cutoff can accept. */
function model(scores: Record<string, Record<string, number>> = {}) {
	const seen: DecisionSchema[] = [];
	return {
		seen,
		classify: async (_text: string, schema: DecisionSchema) => {
			seen.push(schema);
			const labels = Object.keys(schema.labels);
			return { ...decision(labels.map((label) => scores[schema.name]?.[label] ?? 0), labels), tokens: 1, ms: 0 };
		},
	};
}

test("triage reads scope and operation independently, within the labels the step allows", async () => {
	const classifier = model({ scope: { other_task: 10 }, operation: { add: 10 } });
	assert.deepEqual(await triage(classifier, "add an edge case to task 2", { task: "1" }), { scope: "other_task", operation: "add" });
	const [scope, operation] = classifier.seen;
	assert.deepEqual(Object.keys(scope.labels), ["this_task", "other_task", "goal", "new_task", "task_list"]);
	assert.deepEqual(Object.keys(operation.labels), Object.keys(OPERATIONS));
	assert.match(scope.question, /^Task under review: 1\./); // The selected task is context, never a label.
	assert.match(operation.question, /^Task under review: 1\./);

	// Without a task there is no "this task" to choose, and the question says so.
	await triage(classifier, "rename the second one", {});
	assert.deepEqual(Object.keys(classifier.seen[2].labels), ["other_task", "goal", "new_task", "task_list"]);
	assert.match(classifier.seen[2].question, /^Task under review: none\./);
	assert.deepEqual(scopesFor("1").length - scopesFor().length, 1);
	assert.deepEqual(Object.keys(SCOPES).sort(), [...scopesFor("1")].sort());
});

test("an unsure, impossible or failing classification sends the message to the model unchanged", async () => {
	assert.deepEqual(await triage(model(), "something in between", { task: "1" }), { scope: "unclear", operation: "unclear" });
	assert.ok(1 / Object.keys(SCOPES).length < CUTOFF);
	const broken = { classify: async () => { throw new Error("model died"); } };
	assert.deepEqual(await triage(broken, "anything", { task: "1" }), { scope: "unclear", operation: "unclear" });
	const aborted = AbortSignal.abort();
	assert.deepEqual(await triage(model({ scope: { goal: 10 } }), "anything", {}, aborted), { scope: "unclear", operation: "unclear" });

	// A single candidate is fixed by the workflow, so it costs no inference.
	const single = model({ operation: { edit: 10 } });
	assert.deepEqual(await triage(single, "whatever", { scopes: ["goal"] }), { scope: "goal", operation: "edit" });
	assert.deepEqual(single.seen.map((schema) => schema.name), ["operation"]);
});

test("intent widens what a turn may write, and never navigates on its own", () => {
	assert.deepEqual([writeScope("this_task"), writeScope("other_task"), writeScope("goal"), writeScope("new_task")], ["task", "any", "tasks", "tasks"]);
	// Going back to the list and an unreadable message are both handled by code, not by a write scope.
	assert.deepEqual([writeScope("task_list"), writeScope("unclear")], [undefined, undefined]);
	// Approving and stopping are never guessed: no label can mean them.
	assert.equal(Object.keys(SCOPES).some((label) => /approve|stop|off/.test(label)), false);
});
