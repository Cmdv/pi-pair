/** pair_ask: Pi asks the developer a few questions, each with likely answers and a typed Other. */
import { Type, type Static } from "typebox";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

export const OTHER = "Other…";

export const askParameters = Type.Object({
	questions: Type.Array(
		Type.Object({
			question: Type.String({ minLength: 1, description: "One short question" }),
			options: Type.Array(Type.String({ minLength: 1 }), { minItems: 2, maxItems: 5, description: "Real, distinct answers (no filler), your recommendation first; the developer can also type their own" }),
		}, { additionalProperties: false }),
		{ minItems: 1, maxItems: 3 },
	),
}, { additionalProperties: false });

export type Question = Static<typeof askParameters>["questions"][number];
export type Answer = { question: string; answer: string; typed: boolean };

/** Ask each question in turn, stopping at the first one the developer dismisses. */
export async function ask(ui: Pick<ExtensionUIContext, "select" | "input">, questions: Question[], signal?: AbortSignal): Promise<Answer[]> {
	const answers: Answer[] = [];
	for (const { question, options } of questions) {
		const choice = await ui.select(question, [...options, OTHER], { signal });
		const typed = choice === OTHER;
		const answer = typed ? (await ui.input(question, "Your answer", { signal }))?.trim() : choice;
		if (!answer) break;
		answers.push({ question, answer, typed });
	}
	return answers;
}

/** What Pi reads back: each answer under its question, and whether the rest were dismissed. */
export function answerText(answers: Answer[], asked: number): string {
	const lines = answers.map(({ question, answer, typed }) => `${question}\n→ ${answer}${typed ? " (typed by the developer)" : ""}`);
	if (answers.length < asked) lines.push(`The developer dismissed ${answers.length ? "the remaining questions" : "the question"}; don't ask them again with pair_ask.  ` +
		"If a missing answer matters, ask one short question in chat; otherwise carry on and say which low-risk assumption you made.");
	return lines.join("\n\n");
}
