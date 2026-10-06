import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, readFileSync } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";

// Apache-2.0 community export of fastino/GLiNER2.5-Decide, classification only.
export const MODEL = "nishparadox/gliner2.5-decide-onnx";
export const REVISION = "bbbcdb01c406b4f9a44b3a8102c96edb91c1f47d";
export const FILES = [
	{ name: "tokenizer.json", bytes: 8_333_952, sha256: "3ad87d9ffe669147063e70850927dd2da90249e2acc5c8527f1eb65df467bcc8" },
	{ name: "model.onnx", bytes: 1_745_911_616, sha256: "dce49c567af4415889b36b6adad35ecae049cca6a81f55c6cfa34825111b0dcf" },
] as const;

export function classifierPaths(agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent")) {
	const root = resolve(agentDir.replace(/^~(?=$|\/)/, homedir()), "pair");
	return { model: join(root, "models", "gliner2.5-decide", REVISION) };
}

export class MissingModelError extends Error {}

export async function requireRuntime() {
	return import("onnxruntime-node").catch((error) => {
		throw new Error(`ONNX Runtime is unavailable. Install optional dependencies with npm install --include=optional. ${error.message}`);
	});
}

type FileDigest = { bytes: number; sha256: string };
export async function verified(file: string, expected: FileDigest, signal?: AbortSignal) {
	signal?.throwIfAborted();
	try {
		if ((await stat(file)).size !== expected.bytes) return false;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(file, { signal })) hash.update(chunk);
	return hash.digest("hex") === expected.sha256;
}

/** Only called by explicit setup. Interrupted/unverified downloads never become cache entries. */
export async function downloadFile(url: string, file: string, expected: FileDigest,
	signal: AbortSignal, progress: (bytes: number) => void = () => {}) {
	if (await verified(file, expected, signal)) return progress(expected.bytes);
	const response = await fetch(url, { signal });
	if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status} (${url})`);
	await mkdir(dirname(file), { recursive: true });
	const temporary = `${file}.${randomUUID()}.part`;
	const hash = createHash("sha256");
	let received = 0;
	const output = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
	try {
		// An early source error must not unlink before the async open creates the file.
		await once(output, "open");
		await pipeline(response.body, async function* (chunks) {
			for await (const chunk of chunks) {
				received += chunk.length;
				if (received > expected.bytes) throw new Error(`Download exceeds expected size: ${file}`);
				hash.update(chunk);
				progress(received);
				yield chunk;
			}
		}, output, { signal });
		if (received !== expected.bytes || hash.digest("hex") !== expected.sha256) {
			throw new Error(`Download failed size/SHA-256 verification: ${file}`);
		}
		signal.throwIfAborted();
		await rename(temporary, file);
	} finally {
		await rm(temporary, { force: true });
	}
}

export async function downloadClassifier(directory: string, signal: AbortSignal,
	progress: (name: string, bytes: number, total: number) => void = () => {}) {
	for (const file of FILES) {
		await downloadFile(`https://huggingface.co/${MODEL}/resolve/${REVISION}/${file.name}`,
			join(directory, file.name), file, signal, (bytes) => progress(file.name, bytes, file.bytes));
	}
}

// Trial labels, not a permission policy. Model scores must never authorize edits.
export const LABELS = ["proceed", "discuss", "stop"] as const;
const DESCRIPTIONS = [
	"The developer explicitly authorizes the proposed work.",
	"The developer asks a question or wants to discuss before any work.",
	"The developer asks the assistant to stop or not change anything.",
];
export type DecisionSchema = { name: string; question: string; labels: Record<string, string> };
export const TRIAL_SCHEMA: DecisionSchema = { name: "intent", question: "What should the assistant do next, based on the developer's reply?",
	labels: Object.fromEntries(LABELS.map((label, i) => [label, DESCRIPTIONS[i]])) };
const WORDS = /https?:\/\/[^\s]+|www\.[^\s]+|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|@[a-z0-9_]+|[\p{L}\p{N}_]+(?:[-_][\p{L}\p{N}_]+)*|\S/giu;

/** Matches the export's gliner_onnx.py layout. No CLS/SEP and no silent truncation. */
export function encodeDecision(text: string, encodePiece: (piece: string) => number[], schema = TRIAL_SCHEMA) {
	if (typeof text !== "string" || text.length > 16_384) throw new Error("Expected a message of at most 16,384 characters.");
	const labels = Object.keys(schema.labels);
	if (!labels.length || labels.length > 16 || labels.some((label) => !/^[a-z][a-z0-9_ ]{0,63}$/.test(label))) throw new Error("Invalid classifier labels.");
	const prompt = `${schema.name}: ${schema.question}` + labels.map((label) => ` [DESCRIPTION] ${label}: ${schema.labels[label]}`).join("");
	const ids: number[] = [];
	const positions: number[] = [];
	const append = (piece: string) => {
		const tokens = encodePiece(piece);
		if (ids.length + tokens.length > 512) throw new Error("Classifier input exceeds 512 tokens, including labels. Shorten it; nothing was classified.");
		ids.push(...tokens);
	};
	for (const piece of ["(", "[P]", prompt, "("]) append(piece);
	for (const label of labels) {
		positions.push(ids.length); // Track markers by construction, never by scanning user tokens.
		append("[L]");
		append(label);
	}
	for (const piece of [")", ")", "[SEP_TEXT]"]) append(piece);
	if (!/[.!?]$/.test(text)) text += ".";
	for (const [word] of text.matchAll(WORDS)) append(word.toLowerCase());
	return { ids, positions };
}

export function decision(logits: number[], labels: readonly string[] = LABELS) {
	if (!labels.length || new Set(labels).size !== labels.length || logits.length !== labels.length || !logits.every(Number.isFinite)) throw new Error("Invalid classifier logits.");
	const weights = logits.map((value) => Math.exp(value - Math.max(...logits)));
	const total = weights.reduce((sum, value) => sum + value, 0);
	const probabilities = Object.fromEntries(labels.map((label, i) => [label, weights[i] / total]));
	const choice = labels[logits.indexOf(Math.max(...logits))];
	return { choice, confidence: probabilities[choice], probabilities };
}

export type Classifier = Awaited<ReturnType<typeof createClassifier>>;
export type ClassifierFactory = (options: { signal: AbortSignal; download?: boolean; progress?: (name: string, bytes: number, total: number) => void }) => Promise<Classifier>;
const classifiers = new Map<string, Promise<Classifier>>();

/** The production factory downloads only after an explicit UI/CLI setup decision. */
export const classifierFactory: ClassifierFactory = async ({ signal, download, progress }) => {
	const paths = classifierPaths();
	if (download) {
		await requireRuntime();
		await downloadClassifier(paths.model, signal, progress);
	}
	return loadClassifier(paths, signal);
};

/** Offline load, verified once per process/path; failed attempts can be retried. */
export function loadClassifier(paths = classifierPaths(), signal?: AbortSignal): Promise<Classifier> {
	let pending = classifiers.get(paths.model);
	if (!pending) {
		pending = createClassifier(paths, signal);
		classifiers.set(paths.model, pending);
		const attempt = pending;
		void pending.catch(() => { if (classifiers.get(paths.model) === attempt) classifiers.delete(paths.model); });
	}
	return pending.then((classifier) => { signal?.throwIfAborted(); return classifier; });
}

async function createClassifier(paths: ReturnType<typeof classifierPaths>, signal?: AbortSignal) {
	const ort = await requireRuntime();
	for (const file of FILES) {
		if (!await verified(join(paths.model, file.name), file, signal)) {
			throw new MissingModelError(`Missing or damaged ${file.name}. Run npm run classifier:setup to download it explicitly.`);
		}
	}
	const { Tokenizer } = await import("@huggingface/tokenizers");
	const tokenizer = new Tokenizer(JSON.parse(readFileSync(join(paths.model, "tokenizer.json"), "utf8")), {});
	// ponytail: CPU-only, four threads for the local trial; tune only after measuring target machines.
	const session = await ort.InferenceSession.create(join(paths.model, "model.onnx"), {
		executionProviders: ["cpu"], intraOpNumThreads: 4,
	});
	if (signal?.aborted) { await session.release(); signal.throwIfAborted(); }
	let disposed = false;
	return {
		async classify(text: string, schema = TRIAL_SCHEMA) {
			if (disposed) throw new Error("Classifier was disposed; load it again.");
			const start = performance.now();
			const { ids, positions } = encodeDecision(text, (piece) => tokenizer.encode(piece, { add_special_tokens: false }).ids, schema);
			const tensor = (values: number[]) => new ort.Tensor("int64", BigInt64Array.from(values, BigInt), [1, values.length]);
			const { logits } = await session.run({
				input_ids: tensor(ids), attention_mask: tensor(ids.map(() => 1)), label_positions: tensor(positions),
			});
			if (logits.type !== "float32") throw new Error(`Unexpected logits type: ${logits.type}`);
			return { ...decision(Array.from(logits.data as Float32Array), Object.keys(schema.labels)), tokens: ids.length, ms: performance.now() - start };
		},
		async dispose() {
			if (disposed) return;
			disposed = true;
			classifiers.delete(paths.model);
			await session.release();
		},
	};
}
