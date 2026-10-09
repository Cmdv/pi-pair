/** Ordinary Pair: each request the model serves gets one contract, written from the developer's profile at that moment, so a
 * profile change applies within the turn. Only tools and files are enforced; the rest is how the model is asked to behave. */
import type { Slice } from "./effects.ts";
import { describe, type Profile } from "./settings.ts";

export type Request = {
	id: number;
	generation: number; // Pair's revision when this arrived; a later Stop, task or session change makes it stale.
	text: string; // The developer's own words, matched to the message Pi delivers.
	task?: string;
	files?: string[]; // Files the developer confirmed through pair_files for this request, and only this one.
	slice?: Slice; // Their baseline, taken when they were confirmed.
	paused?: string;
};

// The two goals: the model does only what was asked, and the developer stays connected to their code.
const ALWAYS = "Do only what the developer asked: no other changes or actions, even small or helpful-looking ones; mention anything "
	+ "else worth doing in one line and ask. Their words for this turn win over the profile, within what the tools allow: if they say "
	+ "not to edit yet, don't. Propose a profile change with pair_profile when one would help; never assume it. Shell is for "
	+ "non-destructive inspection and checks only; obey the permission policy. Never use it to edit files or bypass a refusal. "
	+ "Report checks actually run and what remains unverified; don't claim success without evidence. The developer marks tasks done.";
// Q1: assistance applies while the developer drives; it covers code, investigation and debugging alike.
const ASSISTANCE = {
	hints: "Hints: point to where to look and ask for their hypothesis, without code that completes the step.",
	examples: "Examples: show one small next step, or how to find the problem (what to inspect or run); ask before an example that "
		+ "would be the whole solution.",
	solution: "Solution: show the code for them to type, or give the diagnosis, and explain it.",
};
const CHECKPOINT = {
	human: {
		each_step: "Each step: help with one step, then wait.",
		after_slice: "After a slice: lay out the whole approach within the assistance level, then wait, and review when they say they are done.",
	},
	model: {
		each_step: "Each step: make one change the developer can review at a glance (a function, a test or a fix), then stop for review.",
		after_slice: "After a slice: carry on until what they asked for is done, then stop for review.",
	},
};

/** The one contract for a model call. Stale or paused requests read only; files the developer confirmed are the only way to edit. */
export function pairContract(request: Request, profile: Profile, stale: boolean, show: boolean): string {
	const point = show ? "pair_show_code, or as path:line" : "path:line";
	const files = request.files?.length ? request.files : undefined;
	const body = stale
		? "This request was made before Pair changed (stopped, task or session). Nothing it implied is granted. Do not edit files or run "
			+ "commands or use web tools; say so, and ask the developer to send it again."
		: request.paused ? `Changes are paused: ${request.paused} Do not edit files or run commands or use web tools; answer from reading, or ask the developer what they want. ${ALWAYS}`
		: profile.driver === "human"
			? `The developer drives: don't edit files. Point to the next place with ${point}. Assistance covers code, investigation and `
				+ `debugging. ${ASSISTANCE[profile.assistance]} Then stop and let them try. Read their saved changes before commenting; if `
				+ `they may have unsaved changes, ask them to save or share the part that matters. Never escalate on your own. `
				+ `${CHECKPOINT.human[profile.checkpoint]} ${ALWAYS}`
		: "The model drives: before your first edit, propose the files with pair_files, a line on each, and change only the files the "
			+ "developer confirms; if a write is refused, stop and say why rather than work around it. When you stop, "
			+ (show ? "annotate each consequential change with pair_show_code in annotate mode, only on lines you changed: "
				: "cite each consequential change as path:line: ")
			+ "what changed, why, and how it connects. Report what you checked and what is unverified, then stop. "
			+ (request.task ? "Once the task's slice is implemented and checked, call pair_report (status implemented) so the developer can review it, or status blocked if you cannot finish; never claim the task is done. " : "")
			+ `${CHECKPOINT.model[profile.checkpoint]} ${ALWAYS}`;
	return [`Request ${request.id}; this contract is for this request only.`, `Profile: ${describe(profile)}.`,
		...(request.task ? [`Task: ${request.task}.`] : []),
		...(files ? [`Confirmed files: ${files.join(", ")}.`] : profile.driver === "model" && !stale ? ["No files confirmed yet."] : []),
		body].join("\n");
}

export const pairGuidance = (contract: string) => `Pair request contract\n${contract}`;
