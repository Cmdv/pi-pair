import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import pair from "../src/index.ts";
import { contractModel } from "./fixtures/contract-model.ts";

const WEB = ["web_search", "source_check", "fetch_content", "get_search_content"];
const text = (message: any) => typeof message?.content === "string" ? message.content
	: (message?.content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
const call = (id: string, name: string, args: object = {}) => ({ type: "toolCall", id, name, arguments: args });

for (const mode of ["human", "model", "spec"] as const) {
	for (const activation of ["eager", "dynamic", "dynamic without fetching"] as const) {
		test(`real Pi web research: ${mode}, ${activation}; policy and lazy activation survive Pair`, async (t) => {
			const cwd = mkdtempSync(join(tmpdir(), "pair-web-runtime-"));
			t.after(() => rmSync(cwd, { recursive: true, force: true }));
			const editor = process.env.PI_PAIR_EDITOR;
			delete process.env.PI_PAIR_EDITOR;
			t.after(() => { if (editor !== undefined) process.env.PI_PAIR_EDITOR = editor; });
			const enabled = WEB.filter((name) => activation !== "dynamic without fetching" || name !== "fetch_content");
			const executed: string[] = [];
			const errors: unknown[] = [];
			const offered: string[][] = [];
			const seen: any[][] = [];
			let script: any[][] = [];
			let driver = mode === "model" ? "The model" : "You";
			const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
			const agentDir = join(cwd, "agent");
			const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true,
				noPromptTemplates: true, noThemes: true, agentsFilesOverride: () => ({ agentsFiles: [] }), extensionFactories: [(pi) => {
					pair(pi);
					contractModel(pi, async (messages) => {
						offered.push(session.getActiveToolNames());
						seen.push(messages);
						return script.shift() ?? [{ type: "text", text: "Research finished." }];
					});
				}, (pi) => {
					// Offline stand-ins for pi-web-access, including its lazy-loader behavior; no provider or network calls.
					for (const name of [...enabled, "web_delete"]) pi.registerTool({
						name, label: name, description: "Web fixture", parameters: Type.Object({ value: Type.String() }),
						async execute(id, params) {
							executed.push(id);
							return { content: [{ type: "text", text: `${name}: ${params.value}` }], details: {} };
						},
					});
					if (activation !== "eager") {
						pi.registerTool({ name: "web_enable", label: "Enable Web", description: "Activate configured web tools",
							parameters: Type.Object({}), async execute() {
								pi.setActiveTools([...new Set([...pi.getActiveTools(), ...enabled])]);
								return { content: [{ type: "text", text: "Web enabled." }], details: {} };
							},
						});
						pi.on("session_start", () => pi.setActiveTools(pi.getActiveTools().filter((name) => !enabled.includes(name))));
					}
					pi.on("tool_call", (event) => JSON.stringify(event.input).includes("DENIED")
						? { block: true, reason: "Denied by web policy." } : undefined);
				}] });
			await resourceLoader.reload();
			const { session } = await createAgentSession({ cwd, agentDir, resourceLoader, settingsManager,
				sessionManager: SessionManager.inMemory(cwd), thinkingLevel: "off" });
			t.after(() => session.dispose());
			await session.setModel(session.modelRuntime.getModels("pair-fixture").find((model) => model.id === "fixture")!);
			await session.bindExtensions({ mode: "rpc", onError: (error) => errors.push(error), uiContext: {
				setStatus() {}, notify() {}, input: async () => undefined,
				select: async (title: string, options: string[]) => title === "Pair" ? "Pair no spec"
					: title === "Who writes the code?" ? options.find((option) => option.startsWith(driver))
					: title === "How much help while you drive?" || title === "When does Pair stop for you?" ? options[0] : undefined,
			} as unknown as ExtensionUIContext });
			await session.prompt(mode === "spec" ? "/pair research" : "/pair");
			for (const name of enabled) assert.equal(session.getActiveToolNames().includes(name), activation === "eager", name);
			if (activation !== "eager") assert.ok(session.getActiveToolNames().includes("web_enable"));
			assert.ok(!session.getActiveToolNames().includes("web_delete"));

			script = [
				...(activation === "eager" ? [] : [[call("enable", "web_enable")]]),
				[...enabled.map((name) => call(name, name, { value: "Public API docs" })),
					call("denied", "web_search", { value: "DENIED" }),
					call("unrelated", "web_delete", { value: "Not research" }),
					call("unconfirmed", "write", { path: "unconfirmed.txt", content: "Never." })],
			];
			await session.prompt("Research the public API documentation.");
			const result = (id: string) => session.messages.find((message: any) => message.role === "toolResult" && message.toolCallId === id) as any;
			for (const name of enabled) {
				assert.equal(result(name)?.isError, false, name);
				assert.ok(offered.at(-1)!.includes(name), `${name} offered after activation`);
			}
			assert.deepEqual(executed.sort(), [...enabled].sort());
			assert.equal(result("denied")?.isError, true);
			assert.match(text(result("denied")), /Denied by web policy/);
			for (const id of ["unrelated", "unconfirmed"]) assert.equal(result(id)?.isError, true, id);
			assert.equal(existsSync(join(cwd, "unconfirmed.txt")), false);
			if (mode === "spec") {
				const contract = seen.at(-1)!.map(text).find((content) => content.startsWith("Pair Spec turn contract"))!;
				for (const name of enabled) assert.ok(contract.includes(`"${name}"`), name);
				if (activation === "dynamic without fetching") assert.ok(!contract.includes('"fetch_content"'));
				assert.ok(!session.getActiveToolNames().includes("bash"));
			} else {
				driver = driver === "You" ? "The model" : "You";
				await session.prompt("/pair:profile");
			}
			// Settling, switching profiles and a new request must not discard tools the loader enabled.
			script = [[call("again", "web_search", { value: "Public API examples" })]];
			await session.prompt("Find an example too.");
			assert.equal(result("again")?.isError, false);
			await session.prompt("/pair:exit");
			for (const name of enabled) assert.ok(session.getActiveToolNames().includes(name), name);
			if (activation === "dynamic without fetching") {
				assert.ok(session.getAllTools().every((tool) => tool.name !== "fetch_content"));
				assert.ok(offered.every((tools) => !tools.includes("fetch_content")));
			}
			assert.deepEqual(errors, []);
		});
	}
}
