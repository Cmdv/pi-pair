/** The Pair profile: who drives, how much assistance, and when to check in. Saved with the spec, or kept in memory without one.
 * A profile is never edit authority: the model changes only files the developer confirmed. */
import { Type } from "typebox";
import type { Answers, Question } from "./ask.ts";
import { profileSchema, type Profile } from "./state.ts";
export type { Profile };

export const DRIVERS: Record<Profile["driver"], string> = { human: "You", model: "The model" };
export const HELP: Record<Profile["assistance"], string> = { hints: "Hints", examples: "Examples", solution: "Solution" };
export const CHECKPOINTS: Record<Profile["checkpoint"], string> = { each_step: "Each step", after_slice: "After a slice" };
/** Used until the developer chooses, and never saved. */
export const STARTING: Profile = { driver: "human", assistance: "hints", checkpoint: "each_step" };

export const describe = (profile: Profile) =>
	`${profile.driver === "human" ? "you drive" : "model drives"} · ${profile.assistance} · ${CHECKPOINTS[profile.checkpoint].toLowerCase()}`;

// Q1: assistance shapes help only while the developer drives, and the dialog says so.
const TABS: { key: keyof Profile; label: string; question: string; values: Record<string, string> }[] = [
	{ key: "driver", label: "Who's driving", question: "Who writes the code?", values: DRIVERS },
	{ key: "assistance", label: "Assistance", question: "How much help while you drive?", values: HELP },
	{ key: "checkpoint", label: "Checkpoint", question: "When does Pair stop for you?", values: CHECKPOINTS },
];
const MARK = / \((current|proposed)\)$/;

/** The three tabs, each opening on the proposed value, else the current one, labelled as such; a proposal's reason heads the first. */
export const profileQuestions = (current: Profile, proposed: Partial<Profile> = {}, reason?: string): Question[] =>
	TABS.map(({ key, label, question, values }, i) => {
		const first = proposed[key] ?? current[key];
		const order = [first, ...Object.keys(values).filter((value) => value !== first)];
		return { label, question: i === 0 && reason ? `The model proposes a change: ${reason}\n\n${question}` : question, options: order.map((value) =>
			values[value] + (value === current[key] ? " (current)" : value === proposed[key] ? " (proposed)" : "")) };
	});

/** What Submit chose: each tab's picked option, the rest unchanged. Typed answers are ignored; picking nothing is a cancel. */
export function profileFrom(current: Profile, answers: Answers): Profile | undefined {
	const picked = TABS.map(({ values }, i) => {
		const answer = answers[i];
		const text = answer && !answer.typed ? answer.answer.replace(MARK, "") : undefined;
		return Object.keys(values).find((value) => values[value] === text);
	});
	if (!picked.some(Boolean)) return undefined;
	return Object.fromEntries(TABS.map(({ key }, i) => [key, picked[i] ?? current[key]])) as Profile;
}

/** pair_profile: the model proposes changed fields with a reason; only the developer's Submit changes anything. */
export const profileParameters = Type.Object({
	...Type.Partial(profileSchema).properties,
	reason: Type.String({ minLength: 1, maxLength: 200, description: "One line on why this change would help now" }),
}, { additionalProperties: false });
