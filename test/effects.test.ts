import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { changedSpan, changedSpans, changes, checkWrite, confirmedParent, landing, openSlice, recordWrite } from "../src/effects.ts";

function project(t: { after: (fn: () => void) => void }) {
	const root = mkdtempSync(join(tmpdir(), "pair-effects-"));
	const outside = mkdtempSync(join(tmpdir(), "pair-outside-"));
	t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
	mkdirSync(join(root, "src"));
	mkdirSync(join(root, ".pi/pi-pair/specs"), { recursive: true });
	writeFileSync(join(root, "src/client.ts"), "let retries = 0;\n");
	writeFileSync(join(root, "src/other.ts"), "other\n");
	writeFileSync(join(outside, "secret.txt"), "secret\n");
	symlinkSync(join(root, "src/other.ts"), join(root, "src/alias.ts"));
	symlinkSync(outside, join(root, "src/escape"));
	symlinkSync(join(outside, "secret.txt"), join(root, "src/leak.ts"));
	symlinkSync(join(outside, "missing.txt"), join(root, "src/dangling.ts"));
	symlinkSync(join(root, ".pi/pi-pair"), join(root, "docs"));
	return { root, real: realpathSync.native(root), outside };
}

test("a write lands where its real path is: inside the project, never outside it or in Pair's own files", (t) => {
	const { root, real, outside } = project(t);
	assert.equal(landing(root, "src/client.ts"), join(real, "src/client.ts"));
	assert.equal(landing(root, join(root, "src/client.ts")), join(real, "src/client.ts")); // An absolute path inside is the same file.
	assert.equal(landing(root, "src/../src/new/deep.ts"), join(real, "src/new/deep.ts")); // New files and parents resolve too.
	assert.equal(landing(root, "src/alias.ts"), join(real, "src/other.ts")); // An alias is the file it points at.
	for (const path of ["../x.ts", join(outside, "secret.txt"), "src/escape/secret.txt", "src/escape/new.ts", "src/leak.ts", "src/dangling.ts",
		".pi/pi-pair/specs/flow.md", ".pi/pi-pair", "docs/specs/flow.md", ".", ""]) {
		assert.equal(landing(root, path), undefined, path);
	}
});

test("a slice writes only its confirmed files, only as they were, and write never replaces an existing file", (t) => {
	const { root, real } = project(t);
	assert.throws(() => openSlice(root, ["src"]), /src is not a file/);
	assert.throws(() => openSlice(root, ["src/escape/x.ts"]), /outside the project/);
	const slice = openSlice(root, ["src/client.ts", "src/new.ts"]);
	const client = join(real, "src/client.ts");
	const fresh = join(real, "src/new.ts");
	assert.equal(checkWrite(slice, join(root, "src/client.ts"), "edit"), client);
	// Unconfirmed, by name or through an alias.
	for (const path of ["src/other.ts", "src/alias.ts", "../x.ts"]) assert.throws(() => checkWrite(slice, join(root, path), "edit"), /is not a file confirmed for this slice/);
	// write only creates; once the model has created a file, rewriting its own file is fine.
	assert.throws(() => checkWrite(slice, join(root, "src/client.ts"), "write"), /already exists and write only creates new files/);
	assert.equal(checkWrite(slice, join(root, "src/new.ts"), "write"), fresh);
	writeFileSync(fresh, "export {};\n");
	recordWrite(slice, fresh, "export {};\n");
	assert.equal(checkWrite(slice, join(root, "src/new.ts"), "write"), fresh);
	assert.ok(confirmedParent(slice, join(root, "src")));
	assert.equal(confirmedParent(slice, join(root, "lib")), false);
	// The model's own edit moves the expected version on; the developer's does not.
	writeFileSync(client, "let retries = 3;\n");
	assert.throws(() => checkWrite(slice, client, "edit"), /client\.ts changed since this slice began/);
	recordWrite(slice, client, "let retries = 3;\n");
	assert.equal(checkWrite(slice, client, "edit"), client);
	assert.throws(() => checkWrite(slice, client, "write"), /already exists/); // Edited by the model, but never replaced.
	// A file that appears where a new one was confirmed is someone else's.
	const late = openSlice(root, ["src/late.ts"]);
	writeFileSync(join(real, "src/late.ts"), "the developer's\n");
	assert.throws(() => checkWrite(late, join(root, "src/late.ts"), "write"), /late\.ts changed since this slice began/);
	// Evidence: what the model wrote, against the baseline; a later change by the developer is flagged, never attributed.
	writeFileSync(client, "let retries = 4; // mine\n");
	assert.deepEqual(changes(slice), [
		{ path: "src/new.ts", before: null, after: "export {};\n", span: { start_line: 1, end_line: 1 }, changedSince: false },
		{ path: "src/client.ts", before: "let retries = 0;\n", after: "let retries = 3;\n", span: { start_line: 1, end_line: 1 }, changedSince: true }]);
	assert.deepEqual([...changedSpans(slice).values()].map((span) => span.path), ["src/new.ts", "src/client.ts"]);
	// The developer's own change to a confirmed file the model never wrote is not the model's.
	const theirs = openSlice(root, ["src/other.ts"]);
	writeFileSync(join(real, "src/other.ts"), "theirs\n");
	assert.deepEqual(changes(theirs), []);
});

test("an approved external root widens the gate to that project only, keeping symlink-escape and root protection", (t) => {
	const { root, outside } = project(t);
	const realOutside = realpathSync.native(outside);
	mkdirSync(join(outside, "lib"));
	writeFileSync(join(outside, "lib/mod.ts"), "export {};\n");
	const roots = [outside];
	// Without approval the external file is refused; with it, it resolves under the approved root.
	assert.equal(landing(root, join(outside, "lib/mod.ts")), undefined);
	assert.equal(landing(root, join(outside, "lib/mod.ts"), roots), join(realOutside, "lib/mod.ts"));
	assert.equal(landing(root, "src/escape/secret.txt", roots), join(realOutside, "secret.txt")); // A symlink that lands inside the approved root is fine.
	assert.equal(landing(root, outside, roots), undefined); // The approved root itself is never a target.
	assert.equal(landing(root, join(outside, "../elsewhere.ts"), roots), undefined); // Escaping above the approved root is still refused.
	assert.equal(landing(root, ".pi/pi-pair/specs/x.md", roots), undefined); // Pair's own files stay off limits.
	// A slice built with the approved root lets the model edit the external file, and only that one.
	const slice = openSlice(root, [join(outside, "lib/mod.ts")], roots);
	assert.equal(checkWrite(slice, join(outside, "lib/mod.ts"), "edit"), join(realOutside, "lib/mod.ts"));
	assert.throws(() => checkWrite(slice, join(outside, "secret.txt"), "edit"), /is not a file confirmed for this slice/);
	assert.throws(() => openSlice(root, [join(outside, "lib/mod.ts")]), /outside the project/); // No approval, no slice.
});

test("a changed span encloses every changed line of the model's version, and is honest about removals and emptied files", () => {
	const lines = (...items: string[]) => items.map((item) => `${item}\n`).join("");
	assert.equal(changedSpan(lines("a", "b"), lines("a", "b")), undefined);
	assert.deepEqual(changedSpan(lines("a", "b", "c", "d"), lines("a", "B", "c", "D")), { start_line: 2, end_line: 4 }); // One span, unchanged c inside.
	assert.deepEqual(changedSpan(lines("a", "c"), lines("a", "b", "c")), { start_line: 2, end_line: 2 }); // Inserted.
	assert.deepEqual(changedSpan(lines("a", "b", "c"), lines("a", "c")), { start_line: 2, end_line: 2 }); // Removed: points where it was.
	assert.deepEqual(changedSpan(lines("a", "b"), lines("a")), { start_line: 1, end_line: 1 }); // Removed at the end.
	assert.deepEqual(changedSpan(null, lines("x", "y")), { start_line: 1, end_line: 2 }); // New.
	assert.equal(changedSpan(lines("a"), ""), undefined); // Emptied: nothing left to point at.
});
