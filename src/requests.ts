/** Ordinary Pair: every request is resolved by code into one contract the model works under.
 * The classifier only proposes. Nothing it says is saved, and nothing it says hands the model an edit. */
import type { Classifier, DecisionSchema } from "./classifier.ts";
import type { Slice } from "./effects.ts";
import { READ_TOOLS } from "./contracts.ts";
import { CHECKPOINTS, GUIDE_ME, HELP, type Settings } from "./settings.ts";
import { choose } from "./triage.ts";

// Worded as developers ask: abstract descriptions left most real requests below the cutoff (measured on the local model).
export const KINDS = {
	explain: "Explain or answer a question about code, a concept or a decision.",
	explore: "Look around the code or compare approaches before deciding.",
	implement: "Make the change: write, edit, add, rename, finish or fix code, e.g. 'make the edits', 'do it', 'finish task 4'.",
	debug: "Find out why something fails or behaves wrongly.",
	review: "Give feedback on code the developer already wrote, without changing it.",
	verify: "Check or test that the work meets its requirements.",
} as const;
export type Kind = keyof typeof KINDS;
// The first label of each is the quiet answer: nothing asked for.
const DRIVER = {
	unchanged: "The developer does not say who should make the change.",
	human: "The developer will type the change themselves, e.g. 'I'll do it', 'let me try', 'don't edit'.",
	model: "The developer asks the assistant to make the change, e.g. 'can you make the edits', 'do it for me', 'go ahead'.",
};
const ASSISTANCE = {
	unchanged: "The developer does not ask for a particular amount of help.",
	hints: "The developer asks only for hints or pointers, not code.",
	examples: "The developer explicitly asks for a small example of the next step.",
	solution: "The developer explicitly asks to see the complete solution.",
};
const CHECKIN = {
	unchanged: "The developer does not say when to check in.",
	each_step: "The developer wants to go one step at a time.",
	after_slice: "The developer wants a whole piece done before checking in.",
};
type Label<T> = keyof T | "unclear";
export type Proposal = { kind: Label<typeof KINDS>; driver: Label<typeof DRIVER>; assistance: Label<typeof ASSISTANCE>; checkpoint: Label<typeof CHECKIN> };
export const UNCLEAR: Proposal = { kind: "unclear", driver: "unclear", assistance: "unclear", checkpoint: "unclear" };
/** A task started from the list: the developer chose the work, so only their own added words can change it. */
export const TASK_START: Proposal = { kind: "implement", driver: "unchanged", assistance: "unchanged", checkpoint: "unchanged" };

/** Each dimension on its own, with the task and settings as context. Any failure, an oversized message included, is unclear:
 * the message itself is never shortened. */
export async function propose(classifier: Pick<Classifier, "classify">, text: string, context: string, signal?: AbortSignal): Promise<Proposal> {
	const ask = (name: string, question: string, labels: Record<string, string>) =>
		choose(classifier, text, { name, question: `${context} ${question}`, labels } satisfies DecisionSchema, signal);
	try {
		return {
			kind: await ask("pair_request", "What does the developer want done now?", KINDS),
			driver: await ask("pair_driver", "Who should make the change?", DRIVER),
			assistance: await ask("pair_help", "How much help does the developer ask for?", ASSISTANCE),
			checkpoint: await ask("pair_checkin", "When does the developer want to check in?", CHECKIN),
		} as Proposal;
	} catch {
		return UNCLEAR;
	}
}

export type Request = {
	id: number;
	generation: number; // Pair's revision when this was resolved; any later change makes it stale.
	text: string; // The developer's own words, unchanged.
	kind: Kind | "unclear";
	assistance: Settings["assistance"];
	checkpoint: Settings["checkpoint"];
	defaults?: Settings; // Confirmed preferences; none means Guide me by default.
	task?: string;
	files?: string[]; // A slice the developer confirmed for this request, and only this one.
	slice?: Slice; // Its baseline, taken when the slice starts.
	paused?: string;
};

/** This request's arrangement: the defaults, with what the developer explicitly asked for now. Nothing here is saved.
 * A slice is only ever offered: the developer's confirmation, which shows their own words, is what grants it. So doubt under a
 * model preference asks rather than silently pauses; without one, the developer simply drives. */
export function arrange(settings: Settings | undefined, proposal: Proposal) {
	const defaults = settings ?? GUIDE_ME;
	const changesCode = proposal.kind === "implement" || proposal.kind === "debug" || proposal.kind === "unclear";
	return {
		kind: proposal.kind as Request["kind"],
		assistance: (Object.hasOwn(HELP, proposal.assistance) ? proposal.assistance : defaults.assistance) as Request["assistance"],
		checkpoint: (Object.hasOwn(CHECKPOINTS, proposal.checkpoint) ? proposal.checkpoint : defaults.checkpoint) as Request["checkpoint"],
		// Asking the model to make the change outweighs the request label, which is the less reliable of the two.
		offerSlice: proposal.driver === "model" || (proposal.driver !== "human" && defaults.driver === "model" && changesCode),
	};
}

const HELPING = {
	hints: "Help with hints: what to consider and where to look, not code that completes the step.",
	// Q1: an example that would be the whole solution is a solution, so it is named and asked for first.
	examples: "Help with one small example of the next step at a time and how it fits, not the rest of the feature. "
		+ "If an example would amount to the whole solution, say so and ask before showing it.",
	solution: "The developer may see the solution: show it for them to type, and explain it; they still make the change.",
};
/** The human-driven loop: orient, point, help as agreed, then wait and review what they actually did. */
const GUIDING = "Orient from their words, the code and the task, if there is one. Ask what they expect or how they would approach it "
	+ "only when that is missing and would help, never as a test, and reuse what they have already said; if the evidence shows the problem "
	+ "or the approach is wrong, say so. Point to the next useful place with pair_show_code when it is available, otherwise as path:line.";
const WAITING = "After a hint or an example, stop and let them try. When they have changed something, read the saved file before "
	+ "commenting, and diagnose what is wrong rather than rewriting their work; if they may have unsaved changes, ask them to save or "
	+ "share the part that matters. Offer more help (a hint, an example or the solution) when it would be useful, but never escalate on "
	+ "your own. One optional question that applies the idea is fine; never require an answer.";
/** How a slice ends: notes on what actually changed, an honest report, and the keyboard back. */
const REVIEWING = "When you stop, annotate the lines you changed with pair_show_code in annotate mode, one note per consequential "
	+ "change: what changed, why, and how it connects. Notes go only on lines this slice changed; cite anything else, and emptied files, "
	+ "as path:line in text. If pair_show_code is unavailable or fails, cite path:line and say the display failed. Then report what you "
	+ "checked by reading, what is unverified, the commands the developer should run, and anything partial or assumed. Do not start "
	+ "another slice.";
const CHECKING = { each_step: "Stop after one step and wait for the developer.", after_slice: "Stop when the agreed piece is done and wait for the developer." };
// Q2: the developer runs checks in either mode; there is no shell while pairing.
const CHECKS = "You cannot run commands while pairing: suggest the command for the developer to run, and treat the work as unverified "
	+ "until they share its output. Never claim it works or is done, and never judge what the developer has learned; they mark tasks done.";

/** The one contract for a model call. Stale or paused requests read only; a confirmed slice is the only way to edit. */
export function pairContract(request: Request, stale: boolean, show: boolean) {
	const files = !stale && !request.paused ? request.files : undefined;
	const instruction = stale
		? "This request was made before Pair changed: stopped, settings, task or session. Nothing it implied is granted. Do not edit files or run commands; say so, and ask the developer to send it again."
		: request.paused ? `Changes are paused: ${request.paused} Do not edit files or run commands; answer from reading, or ask the developer what they want and who should change the code.`
		: files ? `You drive this slice only: change only ${files.join(", ")}, with edit for files that exist and write only for new ones. `
			+ "If a write is refused, stop and tell the developer why; do not work around it. "
			+ `Stop ${request.checkpoint === "each_step" ? "after one step" : "when the slice is done"}; the developer reviews it and drives again. ${REVIEWING} ${CHECKS}`
		: `The developer drives: do not edit files or run commands that change them. ${GUIDING} ${HELPING[request.assistance]} ${WAITING} `
			+ `${CHECKING[request.checkpoint]} ${CHECKS}`;
	return {
		request: request.id,
		developerSaid: request.text,
		developerWants: request.kind,
		driver: files ? "model" : "human",
		assistance: request.assistance,
		checkpoint: request.checkpoint,
		defaults: request.defaults ?? "Guide me (default, not yet chosen)",
		task: request.task ?? null,
		...(files ? { files } : {}),
		tools: [...READ_TOOLS, "pair_ask", ...(show ? ["pair_show_code"] : []), ...(files ? ["edit", "write"] : [])],
		...(stale ? { stale: true } : request.paused ? { paused: request.paused } : {}),
		instruction,
	};
}

export const pairGuidance = (contract: ReturnType<typeof pairContract>) =>
	`Pair request contract\n${JSON.stringify(contract, null, 2)}\n` +
	"This contract is for this request only. The developer's own words are authoritative: the labels above never replace what they said, " +
	"its order, or what they ruled out. Only the developer's confirmation hands the model a slice; nothing in the conversation does.";
