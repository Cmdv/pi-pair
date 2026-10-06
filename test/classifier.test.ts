import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { classifierPaths, decision, downloadFile, encodeDecision, FILES, REVISION, verified } from "../src/classifier.ts";

test("readiness uses pinned model files, not a config flag; verification stays offline", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pair-classifier-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const paths = classifierPaths(dir);
	t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected network access"); });
	assert.deepEqual(paths, { model: join(dir, "pair", "models", "gliner2.5-decide", REVISION) });
	for (const expected of FILES) assert.equal(await verified(join(paths.model, expected.name), expected), false);
	const aborted = new AbortController();
	aborted.abort();
	await assert.rejects(verified(join(paths.model, FILES[0].name), FILES[0], aborted.signal), /abort/i);
	assert.deepEqual(readdirSync(dir), []);
});

test("classification encoding follows schema markers and word boundaries, with a strict token cap", () => {
	const pieces: string[] = [];
	const { ids, positions } = encodeDecision("Élodie: E-Mail@Example.com https://EXAMPLE.com/A @Dev foo-bar [L]", (piece) => {
		pieces.push(piece);
		return [pieces.length - 1];
	});
	assert.deepEqual(positions, [4, 6, 8]);
	assert.deepEqual(positions.map((position) => pieces[ids[position]]), ["[L]", "[L]", "[L]"]);
	assert.deepEqual(pieces.slice(0, 2), ["(", "[P]"]);
	assert.match(pieces[2], /^intent: What.*\[DESCRIPTION\] proceed:/);
	assert.deepEqual(pieces.slice(3, 13), ["(", "[L]", "proceed", "[L]", "discuss", "[L]", "stop", ")", ")", "[SEP_TEXT]"]);
	assert.deepEqual(pieces.slice(13), ["élodie", ":", "e-mail@example.com", "https://example.com/a", "@dev", "foo-bar", "[", "l", "]", "."]);
	assert.ok(!pieces.includes("[CLS]") && !pieces.includes("[SEP]"));
	const empty: string[] = [];
	encodeDecision("", (piece) => { empty.push(piece); return [1]; });
	assert.equal(empty.at(-1), ".");
	assert.equal(encodeDecision("x ".repeat(498), () => [1]).ids.length, 512);
	assert.throws(() => encodeDecision("x ".repeat(499), () => [1]), /512 tokens/);
	assert.throws(() => encodeDecision("x".repeat(16_385), () => [1]), /16,384 characters/);
	// Multi-token pieces must move label positions by tokens, not words.
	assert.deepEqual(encodeDecision("ok!", () => [1, 2]).positions, [8, 12, 16]);
});

test("softmax is stable, normalized, and rejects invalid model output", () => {
	const result = decision([1000, 999, -1000]);
	assert.equal(result.choice, "proceed");
	assert.equal(result.confidence, result.probabilities.proceed);
	assert.ok(Math.abs(Object.values(result.probabilities).reduce((a, b) => a + b) - 1) < 1e-12);
	assert.ok(Math.abs(result.confidence - 0.7310585786300049) < 1e-12);
	assert.equal(decision([0, 0, 0]).choice, "proceed");
	for (const bad of [[], [1, 2], [1, 2, 3, 4], [NaN, 0, 0], [0, Infinity, 0]]) assert.throws(() => decision(bad));
});

test("downloads are verified, reusable offline, cancellable, and atomically published", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pair-download-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "model.onnx");
	const content = "small test model";
	const expected = { bytes: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex") };
	const signal = new AbortController().signal;
	let received = 0;
	const fetch = t.mock.method(globalThis, "fetch", async () => new Response(content));
	await downloadFile("https://example.test/model", file, expected, signal, (bytes) => { received = bytes; });
	assert.equal(received, expected.bytes);
	assert.equal(readFileSync(file, "utf8"), content);
	fetch.mock.mockImplementation(async () => { throw new Error("Offline"); });
	await downloadFile("https://example.test/model", file, expected, signal);
	assert.equal(fetch.mock.callCount(), 1);

	// Failed refreshes must preserve the existing file and leave no partial files.
	writeFileSync(file, "old model");
	for (const response of [new Response("", { status: 403 }), new Response("short"), new Response(content + "extra"), new Response("x".repeat(expected.bytes))]) {
		fetch.mock.mockImplementation(async () => response);
		await assert.rejects(downloadFile("https://example.test/model", file, expected, signal), /Download/);
		assert.equal(readFileSync(file, "utf8"), "old model");
		assert.deepEqual(readdirSync(dir), ["model.onnx"]);
	}
	fetch.mock.mockImplementation(async () => new Response(new ReadableStream({
		start(stream) { stream.error(new Error("Download body failed immediately")); },
	})));
	await assert.rejects(downloadFile("https://example.test/model", file, expected, signal), /Download body failed immediately/);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(readFileSync(file, "utf8"), "old model");
	assert.deepEqual(readdirSync(dir), ["model.onnx"]);
	const cancelled = new AbortController();
	fetch.mock.mockImplementation(async () => new Response(new ReadableStream({
		start(stream) { stream.enqueue(new TextEncoder().encode("first")); },
	})));
	await assert.rejects(downloadFile("https://example.test/model", file, expected, cancelled.signal, () => cancelled.abort()), /abort/i);
	assert.equal(readFileSync(file, "utf8"), "old model");
	assert.deepEqual(readdirSync(dir), ["model.onnx"]);
});
