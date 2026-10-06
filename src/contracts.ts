/** Spec conversation is bounded by the current step and the selected task, not by inferred permission. */
import { findTask } from "./tasks.ts";
import type { Snapshot } from "./proposals.ts";

export const CONTRACT = "pi-pair-contract";
export const READ_TOOLS = ["read", "grep", "find", "ls"];
export const WRITE = "pair_write";

/** What the model may write this turn: only new tasks and the goal, only the selected task, or any task. */
export type Scope = "tasks" | "task" | "any";
export type Phase = "describe" | "populate" | "review" | "spec";
/** Triage of the developer's last message: where they are pointing, and what they want done. */
export type Intent = { scope?: Scope; operation?: string };

const INSTRUCTION: Record<Phase, string> = {
	describe: "Write the whole spec in this one turn. First, if they are not there yet, one pair_write (kind tasks) with the goal, the task names in the order the work should be done (their numbers are that order), and order: a few lines on why that sequence. Then every task that is still empty, one pair_write (kind task) each, with all six sections: Task, Research, Proposed solution, Questions, Edge cases, Done when. Read the code once, up front, and reuse what you have read across the tasks rather than reading it again for each. A task you are filling in for the first time is empty, so it needs no baseHash; rewriting one you have written already this turn needs the baseHash listed for it below. Only write a question when the developer must decide something reading the code cannot settle, one per line as `- [ ] Q1: ...`, and leave Questions empty otherwise; code puts the open ones to the developer task by task. When every task is written, end with a short summary for the developer: the tasks in the order to do them, and why that order.",
	populate: "Fill every section of this task with pair_write (kind task): Task, Research, Proposed solution, Questions, Edge cases, Done when. Read the code you need first. Only write a question when the developer must decide something reading the code cannot settle, one per line as `- [ ] Q1: ...`, and leave Questions empty otherwise; code puts the open ones to the developer as soon as you save.",
	review: "This task is written and the developer is reviewing it. Discuss it, answer questions and save requested changes with pair_write. Only the developer's explicit approval agrees it.",
	spec: "The task list is under review. Discuss it, and add or change tasks, the goal or the order with pair_write when the developer asks.",
};

export function contractFor(snapshot: Snapshot, selection?: string, intent?: Intent) {
	const task = selection ? findTask(snapshot.parsed, selection) : undefined;
	// Drafting lasts until every task is written, so one turn's contract survives its own writes.
	const phase: Phase = task ? snapshot.view.tasks.find((item) => item.id === task.id)?.populated ? "review" : "populate"
		: !snapshot.view.tasks.length || snapshot.view.tasks.some((item) => !item.populated) ? "describe" : "spec";
	// The linear steps fix their own scope; only a reviewing developer can widen it by asking for something else.
	const write: Scope = phase === "describe" ? "any" : phase === "populate" ? "task" : intent?.scope ?? (task ? "task" : "any");
	return {
		phase, task: task?.id ?? null, write,
		...(intent?.operation && intent.operation !== "unclear" ? { developerWants: intent.operation } : {}),
		tools: [...READ_TOOLS, "pair_ask", "pair_show_code", WRITE],
		instruction: INSTRUCTION[phase],
		// The spec's content is here, not in a file the model reads: the file is the developer's view.
		context: `Goal: ${snapshot.parsed.goal || "(none yet)"}\nOrder: ${snapshot.parsed.order || "(none yet)"}\n` + (task
			? `Current baseHash: ${task.hash}\n${snapshot.text.split("\n").slice(task.start, task.end).join("\n")}`
			// Every task's hash is listed, so rewriting one never needs a guess or another read.
			: "Tasks:\n" + (snapshot.parsed.tasks.map((item) => {
				const view = snapshot.view.tasks.find((task) => task.id === item.id);
				return `${item.id}: ${item.name} · ${view?.agreed ? "agreed" : view?.populated ? "written" : "empty"} · baseHash ${item.hash}`;
			}).join("\n") || "(none yet)")),
	};
}
export type Contract = ReturnType<typeof contractFor>;

/** Whether a pair_write payload is inside the contract's scope. */
export function allowsWrite(contract: Contract, input?: Record<string, unknown>) {
	if (contract.write === "tasks") return input?.kind === "tasks";
	if (contract.write === "task") return input?.kind === "task" && input.id === contract.task;
	return input?.kind === "tasks" || input?.kind === "task";
}

export function guidance(contract: Contract) {
	return `Pair Spec turn contract\n${JSON.stringify(contract, null, 2)}\n` +
		"Write only what this contract's scope allows, through pair_write. The spec's content is in this contract: never read the files under .pi/pi-pair. " +
		"Never implement, run shell commands, delegate or edit files. " +
		"Writing content is not agreement: only the developer's explicit approval agrees a task or the spec.";
}
