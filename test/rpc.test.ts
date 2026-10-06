import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import pkg from "../package.json" with { type: "json" };

const cli = fileURLToPath(new URL("cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
const extension = fileURLToPath(new URL("./fixtures/offline-extension.ts", import.meta.url));

test("real Pi RPC starts and falls back without any model calls", async (t) => {
	for (const response of ["no-adapter", "valid", "invalid", "cancelled", "wrong-id"] as const) {
		await t.test(response, { timeout: 20000 }, async (t) => {
			const cwd = mkdtempSync(join(tmpdir(), "pi-pair-rpc-"));
			const child = spawn(process.execPath, [
				cli, "--mode", "rpc", "--offline", "--no-session", "--no-extensions",
				"--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
				"--no-tools", "--no-approve", "--extension", extension,
			], {
				cwd,
				// No inherited credentials, settings, extensions or provider jobs.
				env: {
					PATH: process.env.PATH, HOME: cwd, PI_CODING_AGENT_DIR: join(cwd, "agent"), PI_TELEMETRY: "0",
					...(response === "no-adapter" ? {} : { PI_PAIR_EDITOR: "test" }),
				},
				stdio: ["pipe", "pipe", "pipe"],
			});
			const exited = new Promise<number | null>((resolve) => child.once("close", resolve));
			t.after(async () => {
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
				await exited;
				rmSync(cwd, { recursive: true, force: true });
			});
			let stderr = "";
			child.stderr.setEncoding("utf8").on("data", (text) => { stderr += text; });
			const events: any[] = [];
			const send = (record: object) => child.stdin.write(`${JSON.stringify(record)}\n`);
			const expectsWarning = !["no-adapter", "valid"].includes(response);
			let modeDone = false;
			let clearDone = response !== "valid";
			let warned = false;
			let buffer = "";

			const finished = new Promise<void>((resolve, reject) => {
				child.once("error", reject);
				child.stdin.on("error", reject);
				child.once("close", (code) => {
					if (code === 0) resolve();
					else reject(new Error(`Pi exited with ${code}: ${stderr}`));
				});
				child.stdout.setEncoding("utf8").on("data", (text) => {
					buffer += text;
					try {
						let end: number;
						while ((end = buffer.indexOf("\n")) !== -1) {
							const event = JSON.parse(buffer.slice(0, end));
							buffer = buffer.slice(end + 1);
							events.push(event);
							if (event.type === "extension_ui_request" && event.title === "pi-pair:v1:handshake") {
								assert.equal(event.method, "input");
								assert.deepEqual(JSON.parse(event.placeholder), { version: 1, coreVersion: pkg.version });
								assert.equal(event.timeout, 5000);
								send({
									type: "extension_ui_response",
									id: response === "wrong-id" ? `${event.id}-wrong` : event.id,
									...(response === "cancelled" ? { cancelled: true } : {
										value: response === "invalid" ? "not JSON" : JSON.stringify({
											version: 1, editor: "any-editor", capabilities: ["annotate", "clear"],
										}),
									}),
								});
							}
							if (event.type === "extension_ui_request" && event.method === "select" && event.title === "Pair") {
								send({ type: "extension_ui_response", id: event.id, value: "Pair no spec" });
							}
							if (event.type === "extension_ui_request" && event.title === "pi-pair:v1:clear") {
								assert.equal(event.method, "input");
								assert.deepEqual(JSON.parse(event.placeholder), { all: true });
								send({ type: "extension_ui_response", id: event.id, value: '{"ok":true}' });
							}
							if (event.type === "response") {
								assert.equal(event.success, true, event.error);
								if (event.id === "commands") {
									assert.ok(event.data.commands.some((command: any) => command.name === "pair"));
									send({ id: "mode", type: "prompt", message: "/pair" });
								}
								if (event.id === "mode") {
									modeDone = true;
									if (response === "valid") send({ id: "clear", type: "prompt", message: "/pair:clear all" });
								}
								if (event.id === "clear") clearDone = true;
							}
							if (event.type === "extension_ui_request" && event.notifyType === "warning") warned = true;
							if (modeDone && clearDone && (!expectsWarning || warned)) child.stdin.end();
						}
					} catch (error) { reject(error); }
				});
			});
			send({ id: "commands", type: "get_commands" });
			await finished;
			assert.equal(modeDone, true);
			assert.equal(clearDone, true);
			assert.equal(events.filter((event) => event.title === "pi-pair:v1:clear").length, response === "valid" ? 1 : 0);
			if (response === "valid") {
				assert.ok(events.some((event) => event.type === "entry_appended" && event.entry.customType === "pi-pair-clear" && event.entry.data.all === true));
			}
			assert.equal(events.filter((event) => event.title === "pi-pair:v1:handshake").length, response === "no-adapter" ? 0 : 1);
			assert.equal(warned, expectsWarning);
			const warnings = events.filter((event) => event.notifyType === "warning");
			assert.equal(warnings.length, expectsWarning ? 1 : 0);
			if (expectsWarning) assert.match(warnings[0].message, /Pairing adapter unavailable/);
			if (response === "wrong-id") assert.match(warnings[0].message, /cancelled or timed out/);
			assert.ok(events.some((event) => event.statusKey === "pair" && event.statusText === "🧑‍🤝‍🧑 Pair"));
			assert.equal(events.some((event) => event.type === "agent_start" || event.type === "extension_error"), false);
		});
	}
});
