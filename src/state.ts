/** Companion state: version-bound agreement, completion and order, kept apart from the Markdown.
 * Names and content come from the spec; this file only ever points at task IDs and content hashes. */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { REQUIRED, type Problem, type Section, type Spec } from "./tasks.ts";

const hash = Type.Union([Type.String({ minLength: 1 }), Type.Null()]);
export const stateSchema = Type.Object({
	tasks: Type.Record(Type.String(), Type.Object({ agreedHash: hash, completedHash: hash }, { additionalProperties: false })),
	/** The developer approved the spec as a whole; it holds while at least one task is agreed. */
	specAgreed: Type.Boolean(),
}, { additionalProperties: false });
export type State = Static<typeof stateSchema>;

export const emptyState = (): State => ({ tasks: {}, specAgreed: false });
/** The state file beside a spec: my-spec.md has my-spec.state.json. */
export const stateFile = (specFile: string) => `${specFile.replace(/\.md$/, "")}.state.json`;

export function parseState(json: string): State {
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch (error) {
		throw new Error(`State is not valid JSON: ${(error as Error).message}`);
	}
	// Fields this version no longer keeps, such as the retired execution order, are dropped rather than rejected.
	if (value && typeof value === "object") value = Value.Clean(stateSchema, { specAgreed: false, ...value });
	if (!Value.Check(stateSchema, value)) {
		const [first] = Value.Errors(stateSchema, value);
		throw new Error(`State ${first?.instancePath || "/"} ${first?.message ?? "is invalid"}.`);
	}
	return value;
}

export type TaskStatus = {
	id: string;
	name: string;
	/** The recorded agreement matches the current content. */
	agreed: boolean;
	/** An agreement was recorded for an earlier version: the task needs review. */
	stale: boolean;
	/** Agreed, and completion was recorded for this same version. */
	completed: boolean;
	/** Unresolved questions and edge cases. */
	open: number;
	/** Required sections still empty. */
	missing: Section[];
	/** Every required section has content: the task is worth reviewing rather than filling. */
	populated: boolean;
};
export type Status = {
	tasks: TaskStatus[];
	total: number;
	agreed: number;
	completed: number;
	/** One agreed task is the only requirement for approving the spec. */
	approvable: boolean;
	ready: boolean;
	/** Spec and state problems; any of them blocks advancement. */
	problems: Problem[];
};

/** What is agreed, completed and ready, derived from content and state; nothing is inferred from prose. */
export function status(spec: Spec, state: State): Status {
	const problems = [...spec.problems];
	const ids = new Set(spec.tasks.map((task) => task.id));
	for (const id of Object.keys(state.tasks)) {
		if (!ids.has(id)) problems.push({ message: `The state records ${id}, which is not in the spec.` });
	}
	const tasks = spec.tasks.map((task): TaskStatus => {
		const recorded = state.tasks[task.id];
		const agreed = recorded?.agreedHash === task.hash;
		const missing = REQUIRED.filter((section) => !task.sections[section]?.text);
		return {
			id: task.id,
			name: task.name,
			agreed,
			stale: !agreed && recorded?.agreedHash != null,
			completed: agreed && recorded?.completedHash === task.hash,
			open: [...task.questions, ...task.edges].filter((item) => !item.checked).length,
			missing,
			populated: missing.length === 0,
		};
	});
	const agreed = tasks.filter((task) => task.agreed).length;
	const approvable = agreed > 0 && problems.length === 0;
	return { tasks, total: tasks.length, agreed, completed: tasks.filter((task) => task.completed).length,
		approvable, ready: approvable && state.specAgreed, problems };
}

/** A missing file means nothing agreed or completed; a malformed one is an error, not a guess. */
export function readState(file: string): State {
	let json: string;
	try {
		json = readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
		throw error;
	}
	try {
		return parseState(json);
	} catch (error) {
		throw new Error(`${file}: ${(error as Error).message}`);
	}
}

export function writeState(file: string, state: State): void {
	writeAtomic(file, `${JSON.stringify(state, null, 2)}\n`);
}

/** Written whole or not at all; shared by the Markdown and its companion state. */
export function writeAtomic(file: string, text: string): void {
	mkdirSync(dirname(file), { recursive: true });
	const temporary = `${file}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, text, { flag: "wx" });
		renameSync(temporary, file);
	} finally {
		rmSync(temporary, { force: true });
	}
}
