/** Local deterministic provider for real Pi lifecycle/TUI checks. No network or LLM. */
import { findPackageJSON } from "node:module";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Resolve the SDK's own installed Pi AI, whether npm nested or hoisted it.
const aiPackage = findPackageJSON("@earendil-works/pi-ai", import.meta.resolve("@earendil-works/pi-coding-agent"))!;
const { createAssistantMessageEventStream } = await import(new URL("./dist/index.js", pathToFileURL(aiPackage)).href);
export function contractModel(pi: ExtensionAPI, respond: (messages: any[], signal?: AbortSignal) => any[] | Promise<any[]>) {
	pi.registerProvider("pair-fixture", {
		baseUrl: "http://fixture.invalid", apiKey: "fixture-not-a-secret", api: "pair-fixture",
		models: [{ id: "fixture", name: "Pair contract fixture", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1000 }],
		streamSimple(model, context, options) {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(async () => {
				const message: any = { role: "assistant", content: [], api: "pair-fixture", provider: model.provider, model: model.id,
					timestamp: Date.now(), stopReason: "pending", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
						totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
				try {
					const payload = await options?.onPayload?.({ messages: context.messages }, model) as { messages: any[] } | undefined;
					await options?.onResponse?.({ status: 200, headers: {} }, model);
					const content = await respond(payload?.messages ?? context.messages, options?.signal);
					options?.signal?.throwIfAborted();
					stream.push({ type: "start", partial: message });
					for (const block of content) {
						const contentIndex = message.content.length;
						message.content.push(block);
						if (block.type === "text") {
							stream.push({ type: "text_start", contentIndex, partial: message });
							stream.push({ type: "text_delta", contentIndex, delta: block.text, partial: message });
							stream.push({ type: "text_end", contentIndex, content: block.text, partial: message });
						} else {
							stream.push({ type: "toolcall_start", contentIndex, partial: message });
							stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: message });
						}
					}
					message.stopReason = content.some((block) => block.type === "toolCall") ? "toolUse" : "stop";
					stream.push({ type: "done", reason: message.stopReason, message });
				} catch (error) {
					message.stopReason = options?.signal?.aborted ? "aborted" : "error";
					message.errorMessage = String(error);
					stream.push({ type: "error", reason: message.stopReason, error: message });
				} finally { stream.end(); }
			});
			return stream;
		},
	});
}
