/** Driving modes: who writes the code.  Pure, so it is tested without Pi. */

export type Mode = "me" | "both" | "you";
export type State = Mode | "off";

const ASSISTANT_EDITS =
	"You, the assistant, perform the edits: use edit/write tools yourself for agreed implementation work.  " +
	"Do not hand the developer code to type or paste, or ask for another go-ahead in chat before submitting an edit.  " +
	"The developer approves or rejects each edit through the tool approval mechanism; never bypass it.  " +
	"Follow the current mode even if earlier messages used a developer-types workflow.  " +
	"If the developer asks only for an explanation or instructions, answer without editing.  " +
	"Reading files, researching and planning may happen silently, but before the first edit/write after each developer prompt, send a brief comment saying what you are about to change.  ";

export const MODES: Record<Mode, { label: string; guidance: string }> = {
	me: {
		label: "Me",
		guidance:
			"Pairing mode: Me.  The developer writes all the code.  You must not edit or write files.  " +
			"Answer questions, read and explain code, point at code, run commands, and describe changes " +
			"precisely enough for the developer to make them.  Leave the typing, and the discoveries, to them.",
	},
	both: {
		label: "Both",
		guidance:
			"Pairing mode: Both.  " + ASSISTANT_EDITS +
			"Make one small edit at a time.  Before each edit, say what it changes and why in a sentence or two.  " +
			"Wait for the developer's approval rather than batching ahead.",
	},
	you: {
		label: "You",
		guidance:
			"Pairing mode: You.  " + ASSISTANT_EDITS +
			"Work through the agreed task and run the relevant checks.  " +
			"Keep to the task's scope and summarise what you changed and why at the end.",
	},
};

export const ICON = "🧑‍🤝‍🧑";

/** Largest edit, in changed lines, allowed in Both mode. */
export const PAIRING_MAX_LINES = 50;

const ALIASES: Record<string, State> = { me: "me", both: "both", you: "you", off: "off" };

/** Parse a /pair argument: undefined for no argument (show the picker), null when unknown.
 * Every mode but off takes a further argument, the spec's name. */
export function parseArgument(args: string): { state: State; name?: string } | undefined | null {
	const [word, ...rest] = args.trim().split(/\s+/);
	if (!word) return undefined;
	const state = ALIASES[word.toLowerCase()];
	if (!state || (rest.length && state === "off")) return null;
	return rest.length ? { state, name: rest.join(" ") } : { state };
}

export function statusText(state: State, spec?: string): string | undefined {
	if (state === "off") return undefined;
	return `${ICON} ${MODES[state].label}${spec ? ` · ${spec}` : ""}`;
}

/** Picker options in order, the current one marked, paired with the state each chooses. */
export function pickerOptions(state: State): [string, State][] {
	const options: [string, State][] = (Object.keys(MODES) as Mode[]).map((mode) => [MODES[mode].label, mode]);
	if (state !== "off") options.push(["Off", "off"]);
	return options.map(([label, value]) => [`${value === state ? "●" : " "} ${label}`, value]);
}

/** Lines an edit or write changes: for each replacement, the larger side. */
export function changedLines(toolName: string, input: Record<string, unknown>): number {
	const lines = (text: unknown) => (typeof text === "string" && text ? text.split("\n").length : 0);
	if (toolName === "write") return lines(input.content);
	const edits = Array.isArray(input.edits) ? input.edits : [];
	return edits.reduce((sum: number, edit: any) => sum + Math.max(lines(edit?.oldText), lines(edit?.newText)), 0);
}

/** Why a tool call is not allowed in STATE, or undefined when it may run.
 * ON_SPEC: the call targets the active spec, which Pi may edit in every mode. */
export function blockReason(state: State, toolName: string, input: Record<string, unknown>, onSpec = false): string | undefined {
	if ((toolName !== "edit" && toolName !== "write") || onSpec) return undefined;
	if (state === "me") {
		return "Pairing mode is Me: the developer writes the code.  Don't edit files; describe the change for them to make.";
	}
	if (state === "both") {
		const count = changedLines(toolName, input);
		if (count > PAIRING_MAX_LINES) {
			return `Both mode allows edits of up to ${PAIRING_MAX_LINES} changed lines; this one changes ${count}.  Split it into smaller steps.`;
		}
	}
	return undefined;
}

/** The message sent to Pi when the developer switches from FROM to TO. */
export function switchMessage(from: State, to: State): string {
	const name = (state: State) => (state === "off" ? "Off" : MODES[state].label);
	const head = `Pairing: ${name(from)} → ${name(to)}.  Apply the new mode now; stop following the previous mode's workflow.`;
	return to === "off" ? `${head}  Pairing rules no longer apply.` : `${head}  ${MODES[to].guidance}`;
}
