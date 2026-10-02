import assert from "node:assert/strict";
import { test } from "node:test";
import { drafting, handoff, interview, parseSpec, slug, summary, template } from "../src/spec.ts";

const EXAMPLE = `# Reconnect after sleep
## Goal
Reconnect without losing the session.
## Decisions
- Backoff caps at 30s.
## Questions
- [ ] QUESTION: What happens to queued follow-ups on restart?
- [x] EDGE: Process exits during compaction
## Done when
- Sleeping the laptop mid-turn resumes the session.
## Tasks
- [x] Detect exit event @me
- [~] Backoff policy @pi
- [ ] Surface reconnect in footer`;

test("parses the spec's markers, owners and sections", () => {
	const spec = parseSpec(EXAMPLE);
	assert.equal(spec.title, "Reconnect after sleep");
	assert.deepEqual(spec.sections.Goal, ["Reconnect without losing the session."]);
	assert.deepEqual(
		spec.items.map(({ kind, status, owner, line }) => [kind, status, owner, line]),
		[["question", "todo", undefined, 7], ["edge", "done", undefined, 8], ["task", "done", "me", 12], ["task", "doing", "pi", 13], ["task", "todo", undefined, 14]],
	);
});

test("slugs and templates new specs", () => {
	assert.equal(slug("  Reconnect after Sleep! "), "reconnect-after-sleep");
	assert.equal(slug("!!"), "");
	const spec = parseSpec(template("Reconnect"));
	assert.equal(spec.title, "Reconnect");
	assert.deepEqual(Object.keys(spec.sections), ["Goal", "Constraints", "Decisions", "Questions", "Done when", "Tasks"]);
});

test("hands off the first todo task and summarises open work", () => {
	const spec = parseSpec(EXAMPLE);
	assert.equal(handoff(spec), "Next task (spec line 14): Surface reconnect in footer.  Mark it `[~]` in the spec when work starts.");
	assert.match(handoff(parseSpec("- [ ] Backoff @pi"))!, /suggests Both/);
	assert.equal(handoff(parseSpec("- [x] Done")), undefined);
	const text = summary("specs/r.md", spec);
	assert.match(text, /^Active spec: specs\/r\.md\./);
	assert.match(text, /When the developer answers a QUESTION or EDGE, write the answer beneath it and tick it `\[x\]`/);
	assert.match(text, /Decisions:\n- Backoff caps at 30s\./);
	assert.match(text, /Done when:\n- Sleeping the laptop mid-turn resumes the session\./);
	assert.match(text, /line 7: QUESTION/);
	assert.match(text, /line 13: Backoff policy @pi/);
	assert.doesNotMatch(text, /Detect exit event/);
});

test("a spec is being written until it has tasks, Done-when checks and nothing left open", () => {
	assert.equal(drafting(parseSpec(template("New"))), true);
	assert.equal(drafting(parseSpec(EXAMPLE)), true); // An open QUESTION.
	assert.equal(drafting(parseSpec("## Questions\n- [x] EDGE: done\n## Tasks\n- [ ] Task")), true); // No Done when.
	assert.equal(drafting(parseSpec("## Questions\n- [x] EDGE: done\n## Done when\n- It works\n## Tasks\n- [ ] Task")), false);
	assert.match(interview("specs/r.md"), /^Interview the developer for the spec specs\/r\.md: read it/);
	assert.match(interview("specs/r.md"), /Explore first, ask second[\s\S]*call pair_spec_ready\.$/);
});

test("ignores text that only looks like a marker or owner", () => {
	assert.deepEqual(parseSpec("- [?] maybe\n-[ ] tight").items, []);
	assert.equal(parseSpec("- [ ] mail me@pi.dev").items[0].owner, undefined);
});
