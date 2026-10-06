import assert from "node:assert/strict";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { classifierPaths, downloadClassifier, loadClassifier, requireRuntime } from "./classifier.ts";

const paths = classifierPaths();
const controller = new AbortController();
const cancel = () => controller.abort(new Error("Cancelled"));
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);

try {
	const { values, positionals: [command, ...text] } = parseArgs({
		options: { yes: { type: "boolean", default: false } }, allowPositionals: true,
	});
	if (command !== "classify" && text.length || values.yes && command !== "setup") throw new Error("Unexpected arguments.");
	if (command === "setup") {
		console.log(`Local classifier: about 1.75 GB to download, plus runtime memory.\nCache: ${paths.model}\nNo messages are sent to a service. Ctrl-C cancels.`);
		let consent = values.yes;
		if (!consent) {
			if (!process.stdin.isTTY) throw new Error("Run interactively, or pass --yes to consent to the download.");
			const input = createInterface({ input: process.stdin, output: process.stdout });
			try {
				consent = /^y(es)?$/i.test((await input.question("Download if needed? [y/N] ", { signal: controller.signal })).trim());
			} finally { input.close(); }
		}
		if (consent) {
			await requireRuntime(); // Check native support before the large download.
			let last = "";
			await downloadClassifier(paths.model, AbortSignal.any([controller.signal, AbortSignal.timeout(30 * 60_000)]), (name, bytes, total) => {
				const progress = `${name}: ${Math.floor(bytes / total * 20) * 5}%`;
				if (progress !== last) console.error(last = progress);
			});
			controller.signal.throwIfAborted();
			console.log("Files verified. Run npm run classifier:smoke to check inference; /pair also verifies readiness before activating.");
		} else {
			console.log("Skipped. Configuration unchanged; no download started.");
		}

	} else if (command === "smoke" || command === "classify") {
		if (command === "classify" && !text.length) throw new Error("Usage: npm run classifier -- classify \"your message\"");
		const start = performance.now();
		const classifier = await loadClassifier(paths, controller.signal);
		try {
			console.error(`Verified and loaded in ${((performance.now() - start) / 1000).toFixed(2)}s; process RSS ${(process.memoryUsage().rss / 1024 ** 3).toFixed(2)} GiB.`);
			if (command === "classify") {
				console.log(JSON.stringify(await classifier.classify(text.join(" ")), null, 2));
			} else {
				// Fixed trial cases, not an accuracy benchmark or approval policy.
				const cases = [
					["go ahead", "proceed"],
					["let's discuss", "discuss"],
					["don't change anything", "stop"],
					["Don't go ahead. Stop.", "stop"],
					["Could you explain the plan before making changes?", "discuss"],
				] as const;
				await classifier.classify(cases[0][0]); // Warm up separately from timed cases.
				const rows = [];
				for (const [message, expected] of cases) {
					controller.signal.throwIfAborted();
					const result = await classifier.classify(message);
					rows.push({ message, expected, actual: result.choice, pass: result.choice === expected,
						...Object.fromEntries(Object.entries(result.probabilities).map(([key, value]) => [key, value.toFixed(3)])),
						tokens: result.tokens, ms: Math.round(result.ms) });
				}
				console.table(rows);
				console.log(`Process RSS: ${(process.memoryUsage().rss / 1024 ** 3).toFixed(2)} GiB. Scores are not calibrated approval confidence.`);
				assert.ok(rows.every((row) => row.pass), "Routing smoke check failed; do not connect these predictions to permissions.");
			}
		} finally { await classifier.dispose(); }
	} else {
		throw new Error("Usage: npm run classifier -- setup [--yes] | smoke | classify \"message\"");
	}
} catch (error) {
	console.error(controller.signal.aborted ? "Cancelled." : (error as Error).message);
	process.exitCode = controller.signal.aborted ? 130 : 1;
} finally {
	process.removeListener("SIGINT", cancel);
	process.removeListener("SIGTERM", cancel);
}
