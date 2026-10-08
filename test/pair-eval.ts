/** Real-classifier evaluation of Pair request routing: propose + arrange on fixed messages, under each preference.
 * Needs the local model (npm run classifier:setup); never part of npm test. Not an accuracy benchmark: a small, partly
 * seen set (two phrasings in the descriptions come from it), for comparing changes. Run: npm run eval */
import { loadClassifier, classifierPaths } from "../src/classifier.ts";
import { arrange, propose } from "../src/requests.ts";
import { PRESETS } from "../src/settings.ts";
// [message, should a model preference offer a slice?]
const cases: [string, boolean][] = [
	["ok can we finish task 4 I know I marked it as done but it also doesn't look like I can undo once it's been marked as done (will need fix that too)", true],
	["I've been renaming off to exit but I'd like you to help me do that by doing the edits your self for now. For both this and the exit rename", true],
	["let's finish off task 4", true],
	["can you make the edits for me", true],
	["do we not have a setting where LLM drives that's what I switched to", false],
	["Implement the retry in src/client.ts.", true],
	["Please change the retry loop. But don't edit anything yet.", false],
	["Show the solution, but I will type it.", false],
	["Why does this test fail?", true],
	["Explain what pi--present does.", false],
	["go ahead", true],
	["could you apply those changes", true],
	["please write it for me", true],
	["I'd rather you handle the code this time", true],
	["make that change in pi.el", true],
	["wrap up the settings key", true],
	["let me write this one, just point me at the right function", false],
	["I'll type it myself", false],
	["hold off on edits, just explain the plan", false],
	["what does arrange return when the kind is unclear?", false],
	["the escape test is failing, can you look into why", true],
	["have a look at what I wrote in pi--pair-fit", false],
	["run through the checks and tell me what's left", false],
];
const classifier = await loadClassifier(classifierPaths());
const context = "Task: 4: Complete pairing guidance, review and Emacs presentation. Now: model drives confirmed slices · solution · review after a slice.";
let right = 0, missed = 0, extra = 0, guided = 0;
for (const [text, want] of cases) {
	const p = await propose(classifier, text, context);
	const drive = arrange(PRESETS["Drive and review"], p).offerSlice;
	const guide = arrange(undefined, p).offerSlice;
	if (drive === want) right++; else if (want) missed++; else extra++;
	if (guide) guided++;
	console.log(`${drive === want ? "ok  " : want ? "MISS" : "XTRA"} ${text.slice(0, 58).padEnd(58)} ${p.kind}/${p.driver} drive:${drive} guide:${guide}`);
}
console.log(`Drive and review: ${right}/${cases.length} as wanted, ${missed} missed (no dialog), ${extra} extra dialogs. Guide me offered ${guided}.`);
await classifier.dispose();
