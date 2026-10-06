/** Spec files: a title, a goal, the order to do the tasks in, and numbered tasks.  Pure, so it is tested without Pi.
 * Task content lives here, in Markdown; agreement and completion live in state.ts. */
import { createHash } from "node:crypto";

export const SECTIONS = ["Task", "Research", "Proposed solution", "Questions", "Edge cases", "Done when"] as const;
export type Section = (typeof SECTIONS)[number];
/** Sections a task must fill before it can be ready; Research may say none was needed. */
export const REQUIRED: readonly Section[] = ["Task", "Proposed solution", "Done when"];
export type Field = "Answer" | "Expected" | "Check" | "Out of scope";

export type Problem = { message: string; line?: number };
/** A question (Q1) or edge case (E1).  Checked means settled, not implemented or tested. */
export type Item = { id: string; checked: boolean; text: string; line: number; fields: Partial<Record<Field, string>> };
/** START and END index lines, 0-based and end-exclusive; LINE is 1-based, for messages. */
export type Range = { start: number; end: number };
export type Task = Range & {
	id: string;
	name: string;
	line: number;
	sections: Partial<Record<Section, Range & { text: string }>>;
	questions: Item[];
	edges: Item[];
	/** Fingerprint of the task and shared Goal; agreement and completion are recorded against it. */
	hash: string;
};
/** ORDER is the model's advice on the sequence and why; the numbers are the sequence itself. */
export type Spec = { title: string; titleLine?: number; goal: string; goalRange?: Range; order: string; orderRange?: Range; tasks: Task[]; problems: Problem[] };

/** File name for a spec called NAME, under .pi/pi-pair/specs/. */
export function slug(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** A new spec: the title and an empty goal.  Tasks are appended once the developer confirms them. */
export function template(title: string): string {
	return `# ${title}\n\n## Goal\n`;
}

const TITLE = /^# (.*?)\s*$/;
const HEADING = /^## (.*?)\s*$/;
const TASK = /^(\d+):\s*(.*)$/;
const TASK_LIKE = /^\d+\b/;
const SUBHEADING = /^### (.*?)\s*$/;
const MARKER = /^- \[([ x])\] ([QE])(\d+):\s*(.*?)\s*$/;
const MARKER_LIKE = /^\s*-\s+(\[|[QE]\d+:)/;
const FIELD = /^\s+- (Answer|Expected|Check|Out of scope):\s*(.*?)\s*$/;
const CONTINUATION = /^\s{4,}(\S.*?)\s*$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

const isSection = (name: string): name is Section => (SECTIONS as readonly string[]).includes(name);
const number = (id: string) => Number(id);

/** The content fingerprint: line endings and trailing whitespace don't count. */
export function fingerprint(lines: string[]): string {
	const trimmed = lines.map((line) => line.trimEnd());
	while (trimmed.length && !trimmed.at(-1)) trimmed.pop();
	return createHash("sha256").update(trimmed.join("\n")).digest("hex");
}

export function parseSpec(text: string): Spec {
	const lines = text.split("\n");
	const spec: Spec = { title: "", goal: "", order: "", tasks: [], problems: [] };
	const problem = (index: number, message: string) => spec.problems.push({ line: index + 1, message });
	let open: "task" | "goal" | "order" | "other" | undefined;
	let task: Task | undefined;
	let section: { name: string; start: number } | undefined;
	let item: Item | undefined;
	let field: Field | undefined;
	let fence: string | undefined;

	const endSection = (end: number) => {
		if (task && section && isSection(section.name)) {
			task.sections[section.name] = { start: section.start, end, text: lines.slice(section.start + 1, end).join("\n").trim() };
		}
		section = item = field = undefined;
	};
	const endTop = (end: number) => {
		endSection(end);
		if (open === "goal" && spec.goalRange) {
			spec.goalRange.end = end;
			spec.goal = lines.slice(spec.goalRange.start + 1, end).join("\n").trim();
		}
		if (open === "order" && spec.orderRange) {
			spec.orderRange.end = end;
			spec.order = lines.slice(spec.orderRange.start + 1, end).join("\n").trim();
		}
		if (open === "task" && task) {
			task.end = end;
			checkItems(task, problem);
			spec.tasks.push(task);
		}
		open = task = undefined;
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const fenced = FENCE.exec(line);
		if (fenced) {
			if (!fence) fence = fenced[1];
			else if (fenced[1][0] === fence[0] && fenced[1].length >= fence.length && !line.slice(fenced[0].length).trim()) fence = undefined;
			continue;
		}
		if (fence) continue;
		const heading = HEADING.exec(line);
		if (heading) {
			endTop(i);
			const match = TASK.exec(heading[1]);
			if (match) {
				const [, id, name] = match;
				if (spec.tasks.some((other) => other.id === id)) problem(i, `${id} is defined twice.`);
				if (!name) problem(i, `${id} has no name.`);
				task = { id, name, line: i + 1, start: i, end: i, sections: {}, questions: [], edges: [], hash: "" };
				open = "task";
			} else if (TASK_LIKE.test(heading[1])) {
				problem(i, `"${heading[1]}" looks like a task heading; write it as "## 1: Name".`);
				open = "other";
			} else if (heading[1] === "Goal") {
				if (spec.goalRange) problem(i, "Goal is defined twice.");
				spec.goalRange = { start: i, end: i };
				open = "goal";
			} else if (heading[1] === "Order") {
				if (spec.orderRange) problem(i, "Order is defined twice.");
				spec.orderRange = { start: i, end: i };
				open = "order";
			} else {
				open = "other";
			}
			continue;
		}
		if (spec.titleLine === undefined) {
			const title = TITLE.exec(line);
			if (title) {
				spec.title = title[1];
				spec.titleLine = i;
				continue;
			}
		}
		if (!task) continue;
		const sub = SUBHEADING.exec(line);
		if (sub) {
			endSection(i);
			if (isSection(sub[1]) && task.sections[sub[1]]) problem(i, `${task.id}'s ${sub[1]} section is defined twice.`);
			section = { name: sub[1], start: i };
			continue;
		}
		if (section?.name !== "Questions" && section?.name !== "Edge cases") continue;
		const kind = section.name === "Questions" ? "Q" : "E";
		const marker = MARKER.exec(line);
		if (marker) {
			const [, mark, letter, digits, body] = marker;
			item = field = undefined;
			if (letter !== kind) {
				problem(i, `${task.id}.${letter}${digits} belongs under ${letter === "Q" ? "Questions" : "Edge cases"}.`);
				continue;
			}
			item = { id: letter + digits, checked: mark === "x", text: body, line: i + 1, fields: {} };
			(kind === "Q" ? task.questions : task.edges).push(item);
			continue;
		}
		if (MARKER_LIKE.test(line)) {
			problem(i, `Malformed marker "${line.trim()}"; write "- [ ] ${kind}1: text" or "- [x] ${kind}1: text" at the start of the line.`);
			item = field = undefined;
			continue;
		}
		const named = FIELD.exec(line);
		if (named && item) {
			field = named[1] as Field;
			item.fields[field] = named[2];
			continue;
		}
		const more = CONTINUATION.exec(line);
		if (more && item && field) {
			item.fields[field] = `${item.fields[field]} ${more[1]}`.trim();
			continue;
		}
		if (line.trim() && !/^\s/.test(line)) item = field = undefined;
	}
	endTop(lines.length);
	// A shared goal edit conservatively reopens every task; task moves do not.
	const goal = spec.goalRange ? lines.slice(spec.goalRange.start, spec.goalRange.end) : [];
	for (const task of spec.tasks) task.hash = fingerprint([...goal, ...lines.slice(task.start, task.end)]);
	return spec;
}

/** Duplicate IDs and ticked items without what settles them are errors, never silently satisfied. */
function checkItems(task: Task, problem: (index: number, message: string) => void) {
	for (const [kind, items] of [["Q", task.questions], ["E", task.edges]] as const) {
		const seen = new Set<string>();
		for (const item of items) {
			const name = `${task.id}.${item.id}`;
			if (seen.has(item.id)) problem(item.line - 1, `${name} is defined twice.`);
			seen.add(item.id);
			if (!item.text) problem(item.line - 1, `${name} has no text.`);
			if (!item.checked) continue;
			const { Answer, Expected, Check, "Out of scope": excluded } = item.fields;
			if (excluded || (kind === "Q" ? Answer : Expected && Check)) continue;
			problem(item.line - 1, kind === "Q"
				? `${name} is ticked without an Answer or an Out of scope reason.`
				: `${name} is ticked without Expected and Check, or an Out of scope reason.`);
		}
	}
}

export const findTask = (spec: Spec, id: string) => spec.tasks.find((task) => task.id === id);

/** The number after the highest in the spec or in USED, which the state may still know; numbers are not reused,
 * and a task's number is its place in the order of work. */
export function nextTaskId(spec: Spec, used: Iterable<string> = []): string {
	const known = [...spec.tasks.map((task) => task.id), ...used].filter((id) => /^\d+$/.test(id)).map(number);
	return `${Math.max(0, ...known) + 1}`;
}

type Edit = Range & { lines: string[] };

/** Apply line edits without changing any untouched bytes, including the file's ending. */
function splice(lines: string[], edits: Edit[]): string {
	const out = [...lines];
	const crlf = lines.some((line) => line.endsWith("\r"));
	for (const edit of [...edits].reverse().sort((a, b) => b.start - a.start)) {
		// The empty final split element becomes a new blank line when appending.
		if (crlf && edit.start === out.length && out.at(-1) === "") out[out.length - 1] = "\r";
		const replacement = edit.lines.map((line, i) => line.replace(/\r$/, "") +
			(crlf && !(edit.end === lines.length && i === edit.lines.length - 1) ? "\r" : ""));
		out.splice(edit.start, edit.end - edit.start, ...replacement);
	}
	return out.join("\n");
}

/** CONTENT inserted at AT, kept apart from the content before it by one blank line. */
const block = (lines: string[], at: number, content: string[]): Edit =>
	({ start: at, end: at, lines: at > 0 && lines[at - 1].trim() ? ["", ...content] : content });

/** A section body: the content and the blank line that separates it from what follows. */
const body = (value: string) => (value.trim() ? [...value.trim().split("\n"), ""] : [""]);

export type TaskChanges = { name?: string; sections?: Partial<Record<Section, string>> };

/** TEXT with task ID's given sections replaced, missing ones inserted in canonical order, and its name changed.
 * Everything outside those sections is kept byte for byte. */
export function updateTask(text: string, id: string, changes: TaskChanges): string {
	const lines = text.split("\n");
	const task = findTask(parseSpec(text), id);
	if (!task) throw new Error(`The spec has no task ${id}.`);
	const edits: Edit[] = [];
	const inserts = new Map<number, string[]>();
	for (const [i, name] of SECTIONS.entries()) {
		const value = changes.sections?.[name];
		if (value === undefined) continue;
		const existing = task.sections[name];
		if (existing) {
			edits.push({ start: existing.start + 1, end: existing.end, lines: body(value) });
		} else {
			const at = SECTIONS.slice(i + 1).map((later) => task.sections[later]?.start).find((start) => start !== undefined) ?? task.end;
			inserts.set(at, [...(inserts.get(at) ?? []), `### ${name}`, ...body(value)]);
		}
	}
	for (const [at, content] of inserts) edits.push(block(lines, at, content));
	if (changes.name !== undefined) {
		if (!changes.name.trim()) throw new Error("A task needs a name.");
		edits.push({ start: task.start, end: task.start + 1, lines: [`## ${id}: ${changes.name.trim()}`] });
	}
	return splice(lines, edits);
}

const NOTHING = /^(none|n\/a|no (open )?questions?)\.?$/i;
const LEAD = /^\s*(?:[-*+]\s+|\d+[.)]\s+)?(?:Q\d+\s*[:.]\s*)?/;

/** TEXT as checkable questions, however the model wrote them: prose and numbered lists
 * become `- [ ] Qn:`, because code asks the developer whatever is still unchecked. */
export function questionItems(text: string): string {
	if (NOTHING.test(text.trim())) return "";
	const lines = text.split("\n");
	let next = 1 + Math.max(0, ...lines.map((line) => { const item = MARKER.exec(line); return item?.[2] === "Q" ? Number(item[3]) : 0; }));
	const items: string[] = [];
	for (const line of lines) {
		if (!line.trim()) continue;
		if (MARKER.test(line) || FIELD.test(line)) items.push(line.trimEnd());
		// A wrapped line continues the item above it.
		else if (/^\s/.test(line) && items.length) items[items.length - 1] += ` ${line.trim()}`;
		else items.push(`- [ ] Q${next++}: ${line.replace(LEAD, "").trim()}`);
	}
	return items.join("\n");
}

/** TEXT with a task per name appended, every section empty, and the IDs they were given. */
export function appendTasks(text: string, names: string[], used: Iterable<string> = []): { text: string; ids: string[] } {
	if (names.some((name) => !name.trim())) throw new Error("A task needs a name.");
	if (!names.length) return { text, ids: [] };
	const lines = text.split("\n");
	let next = number(nextTaskId(parseSpec(text), used));
	const ids = names.map(() => `${next++}`);
	const content = ids.flatMap((id, i) => [`## ${id}: ${names[i].trim()}`, "", ...SECTIONS.flatMap((name) => [`### ${name}`, ""])]);
	return { text: splice(lines, [block(lines, lines.length, content)]), ids };
}

/** TEXT with its Order section's content replaced, or added after the Goal, before the first task. */
export function setOrder(text: string, order: string): string {
	const lines = text.split("\n");
	const spec = parseSpec(text);
	if (spec.orderRange) return splice(lines, [{ start: spec.orderRange.start + 1, end: spec.orderRange.end, lines: body(order) }]);
	const at = spec.goalRange?.end ?? spec.tasks[0]?.start ?? lines.length;
	return splice(lines, [block(lines, at, ["## Order", ...body(order)])]);
}

/** TEXT with its Goal section's content replaced, or added after the title. */
export function setGoal(text: string, goal: string): string {
	const lines = text.split("\n");
	const spec = parseSpec(text);
	if (spec.goalRange) return splice(lines, [{ start: spec.goalRange.start + 1, end: spec.goalRange.end, lines: body(goal) }]);
	let at = spec.titleLine === undefined ? 0 : spec.titleLine + 1;
	if (at < lines.length && !lines[at].trim()) at++;
	return splice(lines, [block(lines, at, ["## Goal", ...body(goal)])]);
}
