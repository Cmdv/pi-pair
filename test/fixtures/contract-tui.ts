/** Opt-in live TUI probe: a deterministic local LLM, optionally the real cached classifier. */
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import pair from "../../src/index.ts";
import { classifierPaths, loadClassifier } from "../../src/classifier.ts";
import { classifierStub } from "../classifier-stub.ts";
import { contractModel } from "./contract-model.ts";

export default function (pi: ExtensionAPI) {
	pair(pi, process.env.PI_PAIR_TEST_MODEL_ROOT
		? ({ signal }) => loadClassifier(classifierPaths(process.env.PI_PAIR_TEST_MODEL_ROOT), signal)
		: classifierStub({ scope: "this_task", operation: "discuss" }));
	contractModel(pi, async (messages, signal) => {
		signal?.throwIfAborted();
		if (process.env.PI_PAIR_TEST_TRANSCRIPT) appendFileSync(process.env.PI_PAIR_TEST_TRANSCRIPT, JSON.stringify(messages) + "\n");
		const texts = messages.map((m) => typeof m.content === "string" ? m.content : (m.content ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n"));
		const hidden = texts.findLast((text) => text.includes("Pair Spec turn contract\n"));
		if (hidden) {
			const start = hidden.indexOf("Pair Spec turn contract\n") + "Pair Spec turn contract\n".length;
			const contract = JSON.parse(hidden.slice(start, hidden.indexOf("\nWrite only", start)));
			const user = messages.findLastIndex((m) => m.role === "user" && !(typeof m.content === "string" ? m.content : m.content.map((p: any) => p.text ?? "").join("\n")).startsWith("Pair Spec turn contract"));
			if (messages.slice(user + 1).some((m) => m.role === "toolResult")) return [{ type: "text", text: "Local fixture tool attempt finished." }];
			const text = messages[user]?.content ?? [];
			const input = typeof text === "string" ? text : text.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
			if (input.includes("slow request")) await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(resolve, 30_000);
				signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
			});
			if (input.includes("try source write")) return [{ type: "toolCall", id: `forbidden-write-${randomUUID()}`, name: "write", arguments: { path: "forbidden.txt", content: "Never written" } }];
			if (contract.phase === "describe") return [{ type: "toolCall", id: `describe-write-${randomUUID()}`, name: "pair_write",
				arguments: { kind: "tasks", goal: "Discuss agreed specs collaboratively.", names: ["Agree implementation handoff", "Review edge cases"] } }];
			if (contract.task && input.includes("write task")) return [{ type: "toolCall", id: `task-write-${randomUUID()}`, name: "pair_write", arguments: {
				kind: "task", id: input.includes("T2") ? "T2" : contract.task,
				baseHash: contract.context.match(/Current baseHash: ([a-f0-9]+)/)?.[1],
				sections: { Task: "Discuss the handoff.", Research: "No research needed.", "Proposed solution": "Require an explicit handoff.", "Done when": "A live check confirms the handoff gate." },
			} }];
		}
		return [{ type: "text", text: "Fixture response: request handled; waiting for the developer." }];
	});
}
