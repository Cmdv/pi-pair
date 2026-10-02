/** Spec files: the few markers the core reads.  Pure, so it is tested without Pi. */

export type Status = "todo" | "doing" | "done";
export type Item = { kind: "task" | "question" | "edge"; status: Status; text: string; owner?: "me" | "pi"; line: number };
export type Spec = { title: string; sections: Record<string, string[]>; items: Item[] };

const STATUS: Record<string, Status> = { " ": "todo", "~": "doing", x: "done" };

/** File name for a spec called NAME, under .pi/pi-pair/specs/. */
export function slug(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function template(title: string): string {
	return [`# ${title}`, ...["Goal", "Constraints", "Decisions", "Questions", DONE_WHEN, "Tasks"].flatMap((s) => ["", `## ${s}`])].join("\n") + "\n";
}

/** How we know the whole spec is finished: checks the developer can run. */
const DONE_WHEN = "Done when";

const text = (lines: string[] = []) => lines.filter((line) => line.trim()).join("\n");

/** System prompt text for the active spec at PATH: rules, then goal, decisions and open items. */
export function summary(path: string, spec: Spec): string {
	const open = spec.items.filter((item) => item.status !== "done");
	const parts = [
		`Active spec: ${path}.  You may edit it in any mode.  ` +
			"When the developer answers a QUESTION or EDGE, write the answer beneath it and tick it `[x]`; leave your own proposals open for them to accept.  " +
			"Mark a task `[~]` when you start it and `[x]` when it's done and checked.",
		`Goal:\n${text(spec.sections.Goal) || "(none yet)"}`,
	];
	const decisions = text(spec.sections.Decisions);
	if (decisions) parts.push(`Decisions:\n${decisions}`);
	const done = text(spec.sections[DONE_WHEN]);
	if (done) parts.push(`Done when:\n${done}`);
	parts.push(`Open items:\n${open.map((item) => `- line ${item.line}: ${item.text}`).join("\n") || "(none)"}`);
	return parts.join("\n\n");
}

/** Still being written: no tasks or Done-when checks yet, or open questions or edges. */
export function drafting(spec: Spec): boolean {
	return !spec.items.some((item) => item.kind === "task") || !text(spec.sections[DONE_WHEN]) ||
		spec.items.some((item) => item.kind !== "task" && item.status !== "done");
}

/** Pi's instructions to interview the developer for the spec at PATH. */
export function interview(path: string): string {
	return `Interview the developer for the spec ${path}: read it, then ask your first questions, a few at a time, with pair_ask when it's available.  ` +
		"Explore first, ask second: read the code and config the spec touches, and never ask what the repository already answers.  " +
		"Ask about intent and tradeoffs, recommending an option each time.  " +
		"Until it's ready, edit only the spec.  Record anything uncertain as a `- [ ] QUESTION:` or `- [ ] EDGE:` item under Questions rather than guessing.  " +
		"Agree under Done when how we'll know it's finished (tests or checks the developer can run), " +
		"and break the work into `- [ ]` tasks tagged `@me` or `@pi` for who should do them.  " +
		"Once it has all three and nothing is left open, call pair_spec_ready.";
}

/** The first todo task and the mode its owner suggests. */
export function handoff(spec: Spec): string | undefined {
	const task = spec.items.find((item) => item.kind === "task" && item.status === "todo");
	if (!task) return undefined;
	const suggests = task.owner === "me" ? "  Its owner suggests Me." : task.owner === "pi" ? "  Its owner suggests Both." : "";
	return `Next task (spec line ${task.line}): ${task.text}.${suggests}  Mark it \`[~]\` in the spec when work starts.`;
}

export function parseSpec(text: string): Spec {
	const spec: Spec = { title: "", sections: {}, items: [] };
	let section: string[] | undefined;
	text.split("\n").forEach((line, index) => {
		const heading = /^(#{1,2})\s+(.*?)\s*$/.exec(line);
		if (heading) {
			if (heading[1] === "#") spec.title ||= heading[2];
			else section = spec.sections[heading[2]] = [];
			return;
		}
		section?.push(line);
		const item = /^\s*- \[([ ~x])\]\s+(.*?)\s*$/.exec(line);
		if (!item) return;
		const text = item[2];
		const kind = text.startsWith("QUESTION:") ? "question" : text.startsWith("EDGE:") ? "edge" : "task";
		const owner = /(?:^|\s)@(me|pi)\b/.exec(text)?.[1] as Item["owner"];
		spec.items.push({ kind, status: STATUS[item[1]], text, owner, line: index + 1 });
	});
	return spec;
}
