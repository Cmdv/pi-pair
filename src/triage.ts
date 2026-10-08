/** Review-step triage: what the developer wants changed, and where.
 * It chooses the turn contract's scope. It never approves, writes or picks the exact task. */
import { decision, type Classifier, type DecisionSchema } from "./classifier.ts";
import type { Scope as WriteScope } from "./contracts.ts";

export const SCOPES = {
	this_task: "A question, comment or change about the task being reviewed right now.",
	other_task: "A change to a different task, named or numbered by the developer.",
	goal: "A change to the spec's overall goal or problem statement.",
	new_task: "Add a task that does not exist yet.",
	task_list: "Go back to the list of tasks, or talk about the tasks as a whole.",
} as const;
export type Scope = keyof typeof SCOPES;

export const OPERATIONS = {
	discuss: "Ask a question, answer one, or discuss without asking for a change.",
	add: "Add something that is missing.",
	edit: "Change, correct or replace something already written.",
	remove: "Delete or drop something.",
} as const;
export type Operation = keyof typeof OPERATIONS;

/** Development cutoff, not a calibrated probability: below it the message goes to the model unchanged. */
export const CUTOFF = 0.6;
export type Triage = { scope: Scope | "unclear"; operation: Operation | "unclear" };

/** Without a selected task there is no "this task" to mean. */
export const scopesFor = (selection?: string): Scope[] =>
	selection ? ["this_task", "other_task", "goal", "new_task", "task_list"] : ["other_task", "goal", "new_task", "task_list"];

/** Which part of the spec the model may write for this intent; the model still resolves the exact task. */
export const writeScope = (scope: Triage["scope"]): WriteScope | undefined =>
	scope === "this_task" ? "task" : scope === "other_task" ? "any" : scope === "goal" || scope === "new_task" ? "tasks" : undefined;

const schema = (name: string, question: string, labels: Record<string, string>, picked: readonly string[], task?: string): DecisionSchema =>
	({ name, question: `Task under review: ${task || "none"}. ${question}`, labels: Object.fromEntries(picked.map((label) => [label, labels[label]])) });

/** One dimension: a label the classifier is confident of, or "unclear". Throws on failure; callers treat that as unclear. */
export async function choose(classifier: Pick<Classifier, "classify">, message: string, schema: DecisionSchema, signal?: AbortSignal) {
	const labels = Object.keys(schema.labels);
	// A single candidate is fixed by the workflow, not an interpretation of the reply.
	const raw = labels.length === 1 ? decision([0], labels) : await classifier.classify(message, schema);
	signal?.throwIfAborted();
	return labels.includes(raw.choice) && raw.confidence >= CUTOFF ? raw.choice : "unclear";
}

/** Dimensions are scored independently, so "add an edge case to task 1" keeps both halves.
 * Any failure, including an oversized message, is reported as unclear rather than thrown. */
export async function triage(classifier: Pick<Classifier, "classify">, message: string,
	options: { scopes?: Scope[]; task?: string } = {}, signal?: AbortSignal): Promise<Triage> {
	const scopes = options.scopes ?? scopesFor(options.task);
	const pick = (schema: DecisionSchema) => choose(classifier, message, schema, signal);
	try {
		signal?.throwIfAborted();
		return {
			scope: await pick(schema("scope", "What part of the spec is the developer talking about?", SCOPES, scopes, options.task)) as Scope,
			operation: await pick(schema("operation", "What does the developer want done?", OPERATIONS, Object.keys(OPERATIONS), options.task)) as Operation,
		};
	} catch {
		return { scope: "unclear", operation: "unclear" };
	}
}
