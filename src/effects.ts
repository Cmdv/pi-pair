/** What a model slice may actually change: the confirmed files, as they really resolve on disk, and only while nobody else
 * has changed them since the slice began. Pure checks; the caller decides when to run them. */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

const HOME = join(".pi", "pi-pair");
export const within = (root: string, path: string) => path === root || path.startsWith(root + sep);
const real = (path: string) => { try { return realpathSync.native(path); } catch { return path; } };

/** Where a write to PATH really lands: symlinks in the file and every existing parent resolved against the real project root.
 * Undefined when that is outside every approved root, a root itself, a dangling link, or among Pair's own files, in any project.
 * EXTRAROOTS are the external project roots the developer approved for this spec; a target may resolve under any of them. */
export function landing(root: string, path: string, extraRoots: string[] = []): string | undefined {
	const project = realpathSync.native(root);
	const home = real(join(project, HOME));
	const roots = [project, ...extraRoots.map(real)];
	const rest: string[] = [];
	for (let at = resolve(root, path); ;) {
		try {
			const found = join(realpathSync.native(at), ...rest);
			return !roots.includes(found) && roots.some((r) => within(r, found)) && !within(home, found) && !pairFiles(found) ? found : undefined;
		} catch (error) {
			if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
			// Present but unresolvable is a dangling link: writing through it could land anywhere.
			try { lstatSync(at); return undefined; } catch { /* Not there yet: resolve its parent. */ }
			const parent = dirname(at);
			if (parent === at) return undefined;
			rest.unshift(basename(at));
			at = parent;
		}
	}
}

/** Another project's .pi/pi-pair is its developer's spec and state: never a target either. */
const pairFiles = (path: string) => path.split(sep).some((part, i, parts) => part === ".pi" && parts[i + 1] === "pi-pair");

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
/** A file's text and version, or nulls when there is no file. */
function snapshot(file: string): { text: string | null; version: string | null } {
	try {
		const bytes = readFileSync(file);
		return { text: bytes.toString("utf8"), version: digest(bytes) };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { text: null, version: null };
		throw error;
	}
}

export type Slice = {
	root: string;
	extraRoots: string[]; // External project roots approved for this spec; targets may resolve under them.
	targets: Map<string, string>; // Real path → the name the developer confirmed.
	versions: Map<string, string | null>; // What each target must still be for a write to go ahead.
	before: Map<string, string | null>; // The baseline, kept as evidence for review.
	after: Map<string, string>; // The model's own last version of each file it wrote: what review attributes to it.
};

/** The baseline, taken when files are confirmed and before the model's first change to them; more files join SLICE.
 * Throws if a target does not resolve or is not a file. */
export function openSlice(root: string, files: string[], extraRoots: string[] = [],
	slice: Slice = { root, extraRoots, targets: new Map(), versions: new Map(), before: new Map(), after: new Map() }): Slice {
	for (const file of files) {
		const target = landing(root, file, extraRoots);
		if (!target) throw new Error(`${file} is outside the project or among Pair's own files.`);
		if (slice.targets.has(target)) continue; // Already confirmed: its baseline stays.
		if (statSync(target, { throwIfNoEntry: false })?.isFile() === false) throw new Error(`${file} is not a file.`);
		const { text, version } = snapshot(target);
		slice.targets.set(target, file);
		slice.before.set(target, text);
		slice.versions.set(target, version);
	}
	return slice;
}

/** The final check for one write, run with nothing awaited between it and the write. Returns the real path to write. */
export function checkWrite(slice: Slice, path: string, tool: "edit" | "write"): string {
	const target = landing(slice.root, path, slice.extraRoots);
	const name = target && slice.targets.get(target);
	if (!target || !name) {
		throw new Error(`${relative(slice.root, resolve(slice.root, path))} is not a file confirmed for this slice (${[...slice.targets.values()].join(", ")}). `
			+ "Nothing was written; propose it with pair_files first.");
	}
	const now = snapshot(target).version;
	if (now !== slice.versions.get(target)) {
		throw new Error(`${name} changed since this slice began or since the model last wrote it, so nothing was written. `
			+ "Stop and tell the developer; the next slice starts from their version.");
	}
	// write is for files new in this slice: one that existed at the baseline is never replaced, even after the model edited it.
	if (tool === "write" && slice.before.get(target) !== null) {
		throw new Error(`${name} already exists and write only creates new files, so nothing was written. Use edit for exact changes.`);
	}
	return target;
}

export function recordWrite(slice: Slice, target: string, content: string) {
	slice.versions.set(target, digest(Buffer.from(content, "utf8")));
	slice.after.set(target, content);
}

/** May the write tool create DIR for a new file? Only as the parent of a confirmed target. */
export const confirmedParent = (slice: Slice, dir: string) => {
	const target = landing(slice.root, join(dir, "x"), slice.extraRoots);
	return !!target && [...slice.targets.keys()].some((file) => dirname(file) === dirname(target));
};

export type Span = { start_line: number; end_line: number };
/** One span enclosing every changed line of AFTER, in its own line numbers; it may include unchanged lines between changes.
 * A pure removal points at the line where it happened. Undefined when nothing changed or nothing is left to point at. */
export function changedSpan(before: string | null, after: string): Span | undefined {
	if (before === after) return undefined;
	const old = (before ?? "").split("\n");
	const now = after.split("\n");
	const lines = after === "" ? 0 : after.endsWith("\n") ? now.length - 1 : now.length;
	if (!lines) return undefined;
	let top = 0;
	while (top < old.length && top < now.length && old[top] === now[top]) top++;
	let tail = 0;
	while (tail < old.length - top && tail < now.length - top && old[old.length - 1 - tail] === now[now.length - 1 - tail]) tail++;
	const start = Math.min(top + 1, lines);
	return { start_line: start, end_line: Math.min(Math.max(now.length - tail, start), lines) };
}

/** What the model changed in the slice, file by file: the baseline against the model's own last version, so nothing the developer
 * did before or after is attributed to it. CHANGED_SINCE: the file has moved on from the model's version since. */
export const changes = (slice: Slice) => [...slice.after].map(([target, after]) => {
	const before = slice.before.get(target) ?? null;
	return { path: slice.targets.get(target)!, before, after, span: changedSpan(before, after) ?? null, changedSince: snapshot(target).text !== after };
}).filter((file) => file.before !== file.after);

/** Where notes on this slice's work may go: the changed span of each file the model changed, by real path. */
export const changedSpans = (slice: Slice) => new Map([...slice.after].flatMap(([target, after]) => {
	const span = changedSpan(slice.before.get(target) ?? null, after);
	return span ? [[target, { path: slice.targets.get(target)!, ...span }] as const] : [];
}));
