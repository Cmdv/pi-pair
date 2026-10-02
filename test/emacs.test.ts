import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Value } from "typebox/value";
import {
	annotationSchema, bufferStateReplySchema, bufferStateSchema, clearSchema, handshakeReplySchema, handshakeRequestSchema,
	presentSchema, replySchema, showSchema,
} from "../src/protocol.ts";

// pi-rpc.el tells the frontend apart from other checkouts that have a pi.el.
const isFrontend = (dir: string) => existsSync(join(dir, "pi.el")) && existsSync(join(dir, "pi-rpc.el"));
const frontend = resolve(process.env.PI_PAIR_EMACS_DIR ?? "../pi.el");
const emacs = process.env.EMACS ?? "emacs";

test("Emacs schema conformance and real core RPC handshake/clear, without a model", (t) => {
	if (!isFrontend(frontend) || spawnSync(emacs, ["--version"]).error) {
		t.skip("requires Emacs and the sibling frontend (or PI_PAIR_EMACS_DIR)");
		return;
	}
	const cwd = mkdtempSync(join(tmpdir(), "pi-pair-emacs-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const note = { id: "one", path: "code.txt", start_line: 3, end_line: 3, note: "plain text", kind: "note" } as const;
	const cases: { method: string; args: unknown; valid: boolean; count: number; buffers?: unknown }[] = [
		{ method: "handshake", args: { version: 1, coreVersion: "test" }, valid: true, count: 0 },
		{ method: "annotate", args: note, valid: true, count: 1 }, // line exists only in the unsaved buffer
		{ method: "present", args: { annotations: [{ ...note, id: "shown" }, { ...note, id: "shown-2", start_line: 1, end_line: 1 }] }, valid: true, count: 3 },
	];
	for (const change of [
		...(["", "/etc/passwd", "../x", "src/../x", "./x", "src/.", "a//b", "a/", "C:/x", "a\\b", "x\n", "x\u0000"].map(path => ({ path }))),
		{ start_line: 0 }, { end_line: 2.5 }, { end_line: Number.MAX_SAFE_INTEGER + 1 },
		{ note: " " }, { note: "\u00a0\ufeff" }, { kind: "other" }, { extra: true },
	]) cases.push({ method: "annotate", args: { ...note, ...change }, valid: false, count: 3 });
	const range = { path: "code.txt", start_line: 1, end_line: 3 };
	cases.push({ method: "show", args: { ranges: [range] }, valid: true, count: 3 }); // shown, not recorded
	for (const ranges of [[], [{ ...range, note: "x" }], [{ path: "code.txt", start_line: 1 }], [{ ...range, path: "../x" }]]) {
		cases.push({ method: "show", args: { ranges }, valid: false, count: 3 });
	}
	// code.txt is open with unsaved text; asking about missing.txt must not open it.
	cases.push({ method: "buffer_state", args: { paths: ["code.txt", "missing.txt"] }, valid: true, count: 3, buffers: [
		{ path: "code.txt", open: true, modified: true }, { path: "missing.txt", open: false, modified: false },
	] });
	for (const paths of [[], ["code.txt", "code.txt"], ["../x"], ["/etc/passwd"]]) {
		cases.push({ method: "buffer_state", args: { paths }, valid: false, count: 3 });
	}
	for (const args of [{}, { all: false }, { all: null }, { ids: [] }, { ids: ["one", "one"] }, { ids: ["one", 42] }, { ids: ["one"], all: true }]) {
		cases.push({ method: "clear", args, valid: false, count: 3 });
	}
	cases.push({ method: "clear", args: { ids: ["unknown"] }, valid: true, count: 3 });
	cases.push({ method: "clear", args: { all: true }, valid: true, count: 0 });
	const requests = cases.map(({ method, args, valid }, i) => {
		const schema = { handshake: handshakeRequestSchema, annotate: annotationSchema, present: presentSchema, show: showSchema,
			buffer_state: bufferStateSchema }[method] ?? clearSchema;
		assert.equal(Value.Check(schema, args), valid, `fixture ${i}`);
		return { method: "input", id: `case-${i}`, title: `pi-pair:v1:${method}`, placeholder: JSON.stringify(args) };
	});
	writeFileSync(join(cwd, "code.txt"), "one\ntwo\n");
	writeFileSync(join(cwd, "requests.json"), JSON.stringify(requests));
	const run = spawnSync(emacs, ["-Q", "--batch", "-L", frontend, "-l",
		fileURLToPath(new URL("./emacs-replay.el", import.meta.url)), "requests.json", "replies.json",
		fileURLToPath(new URL("cli.js", import.meta.resolve("@earendil-works/pi-coding-agent"))),
		fileURLToPath(new URL("../src/index.ts", import.meta.url))], {
		cwd, encoding: "utf8", timeout: 20000,
		env: { PATH: process.env.PATH, HOME: cwd, PI_CODING_AGENT_DIR: join(cwd, "agent"), PI_TELEMETRY: "0" },
	});
	assert.equal(run.status, 0, `${run.error ?? ""}\n${run.stderr}`);
	const result = JSON.parse(readFileSync(join(cwd, "replies.json"), "utf8"));
	assert.equal(result.replies.length, requests.length);
	for (const [i, reply] of result.replies.entries()) {
		assert.equal(reply.id, requests[i].id);
		assert.equal(reply.count, cases[i].count, `display mutation in case ${i}`);
		const value = JSON.parse(reply.value);
		if (i === 0) assert.ok(Value.Check(handshakeReplySchema, value));
		else if (cases[i].buffers) {
			assert.ok(Value.Check(bufferStateReplySchema, value), `case ${i}: ${reply.value}`);
			assert.deepEqual(value.buffers, cases[i].buffers);
		} else {
			assert.ok(Value.Check(replySchema, value));
			assert.equal(value.ok, cases[i].valid, `case ${i}: ${reply.value}`);
		}
	}
	const events: any[] = result.events;
	assert.equal(events.filter(e => e.title === "pi-pair:v1:handshake").length, 1);
	assert.equal(events.filter(e => e.title === "pi-pair:v1:clear").length, 1);
	assert.ok(events.some(e => e.type === "entry_appended" && e.entry.customType === "pi-pair-clear" && e.entry.data.all === true));
	assert.equal(events.some(e => e.type === "agent_start" || e.type === "extension_error" || e.notifyType === "warning"), false);
	assert.equal(result.modified, true);
	assert.equal(result.text, "one\ntwo\nunsaved\n");
	assert.equal(readFileSync(join(cwd, "code.txt"), "utf8"), "one\ntwo\n");
});
