/** Validate and write spec content. The model proposes a payload; code checks it and owns the file.
 * Dialogs and editor checks stay in index.ts. */
import { readFileSync } from "node:fs";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { appendTasks, findTask, parseSpec, questionItems, SECTIONS, setGoal, setOrder, updateTask } from "./tasks.ts";
import { readState, stateFile, status, writeAtomic, writeState } from "./state.ts";

const id = Type.String({ pattern: "^[0-9]+$" });
const name = Type.String({ pattern: "^[^\\r\\n]+$", minLength: 1 });
const sections = Type.Object(Object.fromEntries(SECTIONS.map((section) => [section, Type.Optional(Type.String())])), { additionalProperties: false, minProperties: 1,
	description: "Summary: 2–3 lines to review first. Questions: - [ ] Q1: text, then an indented - Options: a | b | c (up to five, recommendation first); code asks and records the answers." });
const normalized = (text?: string) => text?.replace(/\r\n/g, "\n").trim();
/** What a payload must be, per kind. Checked before anything is written. */
export const writeSchema = Type.Union([
	Type.Object({ kind: Type.Literal("tasks"), goal: Type.Optional(Type.String()), order: Type.Optional(Type.String()), names: Type.Optional(Type.Array(name, { minItems: 1 })) }, { additionalProperties: false }),
	Type.Object({ kind: Type.Literal("task"), id, baseHash: Type.Optional(Type.String()), name: Type.Optional(name), sections }, { additionalProperties: false }),
]);
export type SpecWrite = Static<typeof writeSchema>;
/** The tool's wire schema: one object with every field, because MCP bridges and model APIs reject a top-level union. */
export const writeParameters = Type.Object({
	kind: Type.Union([Type.Literal("tasks"), Type.Literal("task")],
		{ description: "tasks: the shared goal, the order of work and new task names. task: one task's number, baseHash and sections." }),
	goal: Type.Optional(Type.String({ description: "tasks only: the goal to record" })),
	order: Type.Optional(Type.String({ description: "tasks only: a few lines on the order to do the tasks in and why; the numbers are that order" })),
	names: Type.Optional(Type.Array(name, { minItems: 1, description: "tasks only: one name per new task, appended after the existing ones" })),
	id: Type.Optional(id),
	baseHash: Type.Optional(Type.String({ description: "task only: the task's baseHash from the turn contract, needed once the task has content; omit it when filling in an empty task" })),
	name: Type.Optional(name),
	sections: Type.Optional(sections),
}, { additionalProperties: false });
export type WriteParameters = Static<typeof writeParameters>;

export function loadSpec(file: string) {
	const text = readFileSync(file, "utf8");
	const parsed = parseSpec(text);
	const state = readState(stateFile(file));
	const view = status(parsed, state);
	if (view.problems.length) throw new Error(`${file}:\n${view.problems.map((p) => `${p.line ? `Line ${p.line}: ` : ""}${p.message}`).join("\n")}`);
	return { text, parsed, state, view };
}
export type Snapshot = ReturnType<typeof loadSpec>;

/** Produce exactly the content a save would write; never accept structural heading injection.
 * Writing content never records agreement: only the developer's explicit approval does. */
export function apply(before: Snapshot, input: unknown) {
	if (!Value.Check(writeSchema, input)) {
		throw new Error("Invalid payload. kind tasks takes any of goal, order and names; kind task takes id, sections, an optional name, and baseHash once the task has content. Send no other fields.");
	}
	// However the model phrases them, questions are stored as items: code asks whatever stays unchecked.
	const change = input.kind === "task" && input.sections.Questions !== undefined
		? { ...input, sections: { ...input.sections, Questions: questionItems(input.sections.Questions) } }
		: input;
	let text = before.text;
	const state = structuredClone(before.state);
	let summary: string;
	let ids: string[] = [];
	if (change.kind === "tasks") {
		if (change.goal === undefined && change.order === undefined && !change.names) throw new Error("Send a goal, an order, names, or any of them.");
		if (!(change.goal ?? before.parsed.goal).trim()) throw new Error("Record the goal with the task list.");
		if (change.goal !== undefined) text = setGoal(text, change.goal);
		if (change.order !== undefined) text = setOrder(text, change.order);
		const added = change.names ? appendTasks(text, change.names, Object.keys(state.tasks)) : { text, ids: [] };
		text = added.text;
		ids = added.ids;
		for (const id of ids) state.tasks[id] = { agreedHash: null, completedHash: null };
		const parts = [...(added.ids.length ? [`task${added.ids.length === 1 ? "" : "s"} ${added.ids.join(", ")}`] : []),
			...(change.goal === undefined ? [] : ["the goal"]), ...(change.order === undefined ? [] : ["the order"])];
		summary = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
	} else {
		const task = findTask(before.parsed, change.id);
		if (!task) throw new Error(`No task ${change.id} in this spec. The contract lists the tasks there are.`);
		// An empty task has no work to lose, so filling one in for the first time needs no hash.
		const empty = SECTIONS.every((section) => !task.sections[section]?.text.trim());
		if (!empty && task.hash !== change.baseHash) {
			throw new Error(`Task ${change.id} has content written under a different baseHash. Use the baseHash the contract lists for it, and preserve the developer's edits.`);
		}
		text = updateTask(text, change.id, change);
		summary = `task ${change.id}`;
	}

	const parsed = parseSpec(text);
	if (parsed.problems.length) throw new Error(parsed.problems.map((p) => p.message).join("\n"));
	if (change.kind === "task") {
		const task = findTask(parsed, change.id)!;
		if (parsed.tasks.length !== before.parsed.tasks.length || Object.entries(change.sections).some(([section, value]) => normalized(task?.sections[section as typeof SECTIONS[number]]?.text) !== normalized(value))) {
			throw new Error("A section cannot contain structural spec headings; use fenced examples instead.");
		}
	} else if (change.goal !== undefined && normalized(parsed.goal) !== normalized(change.goal)) {
		throw new Error("A goal cannot contain structural spec headings.");
	} else if (change.order !== undefined && normalized(parsed.order) !== normalized(change.order)) {
		throw new Error("An order cannot contain structural spec headings.");
	}
	const view = status(parsed, state);
	if (view.problems.length) throw new Error(view.problems.map((p) => p.message).join("\n"));
	return { text, state, summary, ids };
}

/** Recheck after any dialog/editor round trip, then publish content before its state.
 * ponytail: any intervening file/state change requires a fresh read; merge disjoint changes only if needed. */
export function save(file: string, before: Snapshot, prepared: ReturnType<typeof apply>, saveState = writeState) {
	const current = loadSpec(file);
	if (current.text !== before.text || JSON.stringify(current.state) !== JSON.stringify(before.state)) {
		throw new Error("Spec or state changed while writing. Read it again and rewrite; nothing was saved.");
	}
	if (prepared.text !== before.text) writeAtomic(file, prepared.text);
	// On failure, changed content cannot match the previous agreement hash.
	saveState(stateFile(file), prepared.state);
}
