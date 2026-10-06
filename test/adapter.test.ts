import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { annotate, ask, bufferState, clear, handshake, open, present, rpcTransport, show, type Send } from "../src/adapter.ts";
import { type Annotation, type Clear } from "../src/protocol.ts";

test("RPC transport sends JSON and handles failed replies", async () => {
	const calls: unknown[][] = [];
	let reply: string | undefined = '{"ok":true}';
	const ctx = {
		mode: "rpc",
		ui: {
			input: async (...args: unknown[]) => {
				calls.push(args);
				return reply;
			},
		},
	} as ExtensionContext;
	const send = rpcTransport(ctx);
	const signal = new AbortController().signal;
	assert.deepEqual(await send("clear", { all: true }, signal), { ok: true });
	assert.deepEqual(await send("ask", {}, signal, 0), { ok: true });
	assert.deepEqual(calls, [
		["pi-pair:v1:clear", '{"all":true}', { signal, timeout: 5000 }],
		["pi-pair:v1:ask", "{}", { signal, timeout: 0 }],
	]);
	reply = undefined;
	await assert.rejects(send("clear", {}), /cancelled or timed out/);
	reply = "not JSON";
	await assert.rejects(send("clear", {}), SyntaxError);
});

test("ask waits for the developer and validates one answer or null per question", async () => {
	const calls: unknown[][] = [];
	let reply: unknown = { ok: true, answers: [{ answer: "Yes (recommended)", typed: false }, null] };
	const send: Send = async (...args) => { calls.push(args); return reply; };
	const questions = ["A", "B"].map((label) => ({ label, question: `${label}?`, options: ["Yes", "No"] }));
	// The editor is told which option is recommended; answers read back as the model wrote them.
	assert.deepEqual(await ask(send, questions), [{ answer: "Yes", typed: false }, null]);
	const shown = questions.map((question) => ({ ...question, options: ["Yes (recommended)", "No"] }));
	assert.deepEqual(calls, [["ask", { questions: shown }, undefined, 0]]);
	for (reply of [{ ok: true }, { ok: true, answers: [null, { answer: "", typed: false }] }, { ok: true, answers: [null, "No"] }]) {
		await assert.rejects(ask(send, questions), /Invalid adapter ask reply/);
	}
	reply = { ok: true, answers: [null] };
	await assert.rejects(ask(send, questions), /does not match the questions/);
	reply = { ok: false, error: "no dialog" };
	await assert.rejects(ask(send, questions), /Adapter ask: no dialog/);
});

test("open validates project paths and adapter acknowledgement", async () => {
	let calls = 0;
	const send: Send = async (method, args) => { calls++; assert.equal(method, "open"); assert.deepEqual(args, { path: ".pi/pi-pair/specs/test.md" }); return { ok: true }; };
	await open(send, ".pi/pi-pair/specs/test.md");
	for (const path of ["/etc/passwd", "../x", "a/../x", "./x", "a\\\\b", "x\n"]) await assert.rejects(open(send, path), /Invalid open path/);
	assert.equal(calls, 1);
	await assert.rejects(open(async () => ({ ok: false, error: "Unavailable" }), "spec.md"), /Unavailable/);
});

test("handshake negotiates v1 and validates the reply", async () => {
	const valid = { version: 1, editor: "test", capabilities: ["annotate"] };
	const reported = await handshake(async (method, args) => {
		assert.equal(method, "handshake");
		assert.deepEqual(args, { version: 1, coreVersion: "0.1.0" });
		return valid;
	}, "0.1.0");
	assert.deepEqual(reported, { capabilities: new Set(["annotate"]), showWhenOff: false });
	assert.equal((await handshake(async () => ({ ...valid, showWhenOff: true }), "0.1.0")).showWhenOff, true);

	for (const reply of [
		null,
		{},
		{ ...valid, version: 2 },
		{ ...valid, editor: 42 },
		{ ...valid, capabilities: [42] },
		{ ...valid, showWhenOff: "yes" },
	]) {
		await assert.rejects(
			handshake(async () => reply, "0.1.0"),
			/Invalid or incompatible/,
		);
	}
});

test("annotation and clear payloads and replies are validated before recording success", async () => {
	const calls: unknown[][] = [];
	let reply: unknown = { ok: true };
	const send: Send = async (...args) => { calls.push(args); return reply; };
	const note: Annotation = { id: "note-1", path: "src/one.ts", start_line: 2, end_line: 4, note: "Why this matters", kind: "note" };
	await annotate(send, note);
	await present(send, [note]);
	await clear(send, { ids: [note.id] });
	await clear(send, { all: true });
	assert.deepEqual(calls.map(([method, args]) => [method, args]), [
		["annotate", note], ["present", { annotations: [note] }], ["clear", { ids: [note.id] }], ["clear", { all: true }],
	]);
	calls.length = 0;
	for (const path of ["", "/etc/passwd", "../x", "src/../x", "./x", "src/.", "a//b", "a/", "C:/x", "a\\b", "x\n", "x\u0000"]) {
		await assert.rejects(annotate(send, { ...note, path }), /Invalid annotation/);
		await assert.rejects(present(send, [{ ...note, path }]), /Invalid presentations/);
	}
	for (const change of [{ start_line: 0 }, { end_line: 1 }, { end_line: 2.5 }, { end_line: Number.MAX_SAFE_INTEGER + 1 }, { note: " " }]) {
		await assert.rejects(annotate(send, { ...note, ...change }));
		await assert.rejects(present(send, [{ ...note, ...change }]));
	}
	const range = { path: "src/one.ts", start_line: 2, end_line: 4 };
	for (const ranges of [[], [{ ...range, path: "../x" }], [{ ...range, end_line: 1 }], [{ ...range, note: "no" }], [{ path: "a", start_line: 1 }]]) {
		await assert.rejects(show(send, ranges as never));
	}
	for (const paths of [[], ["a.md", "a.md"], ["../a.md"], ["/a.md"]]) {
		await assert.rejects(bufferState(send, paths), /Invalid buffer_state paths/);
	}
	for (const selection of [{}, { all: false }, { ids: [] }, { ids: ["x", "x"] }, { ids: ["x"], all: true }]) {
		await assert.rejects(clear(send, selection as Clear), /Clear requires/);
	}
	assert.equal(calls.length, 0);
	await show(send, [range]);
	assert.deepEqual(calls.pop(), ["show", { ranges: [range] }, undefined, undefined]);

	for (reply of [null, {}, { ok: "yes" }, { ok: true, error: "contradictory" }, { ok: false, error: "File unavailable" }]) {
		await assert.rejects(annotate(send, note));
		await assert.rejects(present(send, [note]));
		await assert.rejects(clear(send, { all: true }));
	}
	assert.equal(calls.length, 15); // No automatic retry, including after adapter errors.
	await assert.rejects(handshake(send, "0.1.0"), /File unavailable/);
	const controller = new AbortController();
	controller.abort();
	const count = calls.length;
	await assert.rejects(annotate(send, note, controller.signal), /abort/i);
	assert.equal(calls.length, count);
});
