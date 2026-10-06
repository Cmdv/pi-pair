/** pair_ask: Pi asks the developer a few questions, each with likely answers and a typed Other. */
import { Type, type Static } from "typebox";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export const OTHER = "Other…";
const RECOMMENDED = " (recommended)";

/** Options as the developer sees them: the first is the model's recommendation, so it says so. */
export const labelled = (options: string[]) =>
	options.map((text, i) => i === 0 && !/recommend/i.test(text) ? text + RECOMMENDED : text);
/** The option behind a label, so an answer reads back as the model wrote it. */
export const chosen = (text: string) => text.endsWith(RECOMMENDED) ? text.slice(0, -RECOMMENDED.length) : text;

export const askParameters = Type.Object({
	questions: Type.Array(
		Type.Object({
			label: Type.String({ minLength: 1, maxLength: 16, description: "A word or two naming the question, shown on its tab" }),
			question: Type.String({ minLength: 1, description: "One short question" }),
			// Short enough to read on one line in a dialog, where each option is one row.
			options: Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { minItems: 2, maxItems: 5, description: "Real, distinct answers (no filler) of a few words each, your recommendation first; the developer can also type their own" }),
		}, { additionalProperties: false }),
		{ minItems: 1, maxItems: 5 },
	),
}, { additionalProperties: false });

export type Question = Static<typeof askParameters>["questions"][number];
export type Answer = { answer: string; typed: boolean };
/** One entry per question, in order: null when the developer skipped it. */
export type Answers = (Answer | null)[];

/** Ask each question in turn, stopping at the first one the developer dismisses: for frontends without tabs. */
export async function askEach(ui: Pick<ExtensionUIContext, "select" | "input">, questions: Question[], signal?: AbortSignal): Promise<Answers> {
	const answers: Answers = questions.map(() => null);
	for (const [i, { question, options }] of questions.entries()) {
		// A question written without options is simply typed into.
		const choice = options.length ? await ui.select(question, [...labelled(options), OTHER], { signal }) : OTHER;
		const typed = choice === OTHER;
		const answer = typed ? (await ui.input(question, "Your answer", { signal }))?.trim() : choice && chosen(choice);
		if (!answer) break;
		answers[i] = { answer, typed };
	}
	return answers;
}

const SUBMIT = ["Submit answers", "Cancel"];

/** Ask in Pi's terminal UI: a tab per question, then a Submit tab; Esc or SIGNAL skips them all. */
export function askTabs(ui: Pick<ExtensionUIContext, "custom">, questions: Question[], signal?: AbortSignal): Promise<Answers> {
	return ui.custom<Answers>((tui, theme, _keybindings, done) => {
		const answers: Answers = questions.map(() => null);
		const tabbed = questions.length > 1;
		let tab = 0, row = 0;
		let typing: Input | undefined;
		const finish = (result: Answers) => { signal?.removeEventListener("abort", cancel); done(result); };
		const cancel = () => finish(questions.map(() => null));
		signal?.addEventListener("abort", cancel, { once: true });
		const rows = () => tab < questions.length ? [...labelled(questions[tab].options), OTHER] : SUBMIT;
		const go = (next: number) => {
			tab = (next + questions.length + 1) % (questions.length + 1);
			const answer = answers[tab];
			row = !answer ? 0 : answer.typed ? questions[tab].options.length : questions[tab].options.indexOf(answer.answer);
		};
		const answer = (text: string, typed: boolean) => {
			answers[tab] = { answer: text, typed };
			if (tabbed) go(tab + 1);
			else finish(answers);
		};
		return {
			invalidate() {},
			handleInput(data: string) {
				if (typing) typing.handleInput(data);
				else if (matchesKey(data, Key.escape)) return cancel();
				else if (tabbed && (matchesKey(data, Key.tab) || matchesKey(data, Key.right))) go(tab + 1);
				else if (tabbed && (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left))) go(tab - 1);
				else if (matchesKey(data, Key.up)) row = (row + rows().length - 1) % rows().length;
				else if (matchesKey(data, Key.down)) row = (row + 1) % rows().length;
				else if (matchesKey(data, Key.enter)) {
					if (tab === questions.length) return row === 0 ? finish(answers) : cancel();
					if (row < questions[tab].options.length) answer(questions[tab].options[row], false);
					else {
						typing = new Input({ prompt: "Your answer: " });
						typing.focused = true;
						const previous = answers[tab];
						// Typed in, not setValue, so the cursor ends up after it.
						if (previous?.typed) typing.handleInput(previous.answer);
						typing.onEscape = () => { typing = undefined; };
						typing.onSubmit = (text) => { typing = undefined; if (text.trim()) answer(text.trim(), true); };
					}
				}
				tui.requestRender();
			},
			render(width: number) {
				const question = questions[tab];
				const tabs = [...questions.map(({ label }, i) => `${answers[i] ? "☒" : "☐"} ${label}`), "✔ Submit"].map((text, i) => i === tab
					? theme.bg("selectedBg", theme.fg("text", ` ${text} `))
					: theme.fg(answers[i] || i === questions.length ? "text" : "muted", ` ${text} `));
				const review = question ? [] : [...questions.map(({ label }, i) =>
					`${theme.fg("muted", `${label}:`)} ${answers[i]?.answer ?? theme.fg("warning", "skipped")}`), ""];
				const current = answers[tab];
				const options = rows().map((text, i) => {
					const typed = current?.typed && i === question.options.length ? ` ${current.answer}` : "";
					return i === row ? theme.fg("accent", `❯ ${i + 1}. ${text}${typed}`) : `  ${i + 1}. ${text}${typed}`;
				});
				const hint = typing ? "Enter to answer · Esc to go back" : `Enter to select · ${tabbed ? "Tab/←→ to navigate · " : ""}Esc to cancel`;
				const lines = [...(tabbed ? [`← ${tabs.join(" ")} →`, ""] : []),
					theme.bold(question?.question ?? "Review your answers"), "", ...review, ...options, ""];
				return [...lines.flatMap((line) => wrapTextWithAnsi(line, width)), ...(typing?.render(width) ?? []),
					...wrapTextWithAnsi(theme.fg("dim", hint), width)];
			},
		};
	});
}

/** What Pi reads back: each answer under its question, then the questions the developer skipped. */
export function answerText(questions: Question[], answers: Answers): string {
	const lines = questions.flatMap(({ question }, i) => {
		const answer = answers[i];
		return answer ? [`${question}\n→ ${answer.answer}${answer.typed ? " (typed by the developer)" : ""}`] : [];
	});
	const skipped = questions.filter((_, i) => !answers[i]).map(({ question }) => `- ${question}`);
	if (skipped.length) lines.push(`The developer skipped ${skipped.length > 1 ? "these questions" : "this question"}; don't ask again with pair_ask.  ` +
		"If a missing answer matters, ask one short question in chat; otherwise carry on and say which low-risk assumption you made.\n" +
		skipped.join("\n"));
	return lines.join("\n\n");
}
