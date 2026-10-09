import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import pair from "../src/index.ts";
import { CONTRACT, WEB_TOOLS } from "../src/contracts.ts";
import { emptyState, stateFile, writeState } from "../src/state.ts";
import { loadSpec } from "../src/proposals.ts";

process.env.PI_PAIR_EDITOR = "test";
const SPEC = "# Scope\n\n## Goal\nStay up.\n\n## 1: Backoff\n### Task\nRetry.\n### Proposed solution\nDelay.\n### Done when\nChecked.\n\n## 2: Report\n### Task\nReport.\n### Proposed solution\nShow error.\n### Done when\nVisible.\n";
const SECTIONS = { Task: "Retry gently.", Research: "Read the client.", "Proposed solution": "Wait and retry.", "Edge cases": "- [ ] E1: Server never answers\n  - Expected: Give up.\n  - Check: Watch the log.", "Done when": "A check observes bounded retries." };

function harness(t: { after: (fn: () => void) => void }, editor?: (method: string, args: any) => unknown) {
	const cwd = mkdtempSync(join(tmpdir(), "pi-pair-conversation-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const handlers = new Map<string, any>();
	const commands = new Map<string, any>();
	const tools = new Map<string, any>();
	const entries: any[] = [];
	const messages: any[] = [];
	const userMessages: string[] = [];
	const history: any[] = [];
	const notices: string[] = [];
	const widgets: (string[] | undefined)[] = [];
	const statuses: (string | undefined)[] = [];
	const sessions: any[] = [];
	const asked: string[] = [];
	let active = ["read", "bash", "write", "edit", "external"];
	const foreign = new Set<string>(); // Tool names another extension has taken over.
	let answer: (question: string) => string | undefined = () => undefined;
	let timestamp = 0;
	const emit = (name: string, event: any = {}) => handlers.get(name)?.(event, ctx);
	// Pi announces each delivered message, which is when Pair learns which request the model is serving.
	const deliver = (message: any) => { history.push(message); handlers.get("message_start")?.({ message }, ctx); };
	pair({
		on: (name: string, handler: any) => handlers.set(name, handler),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerTool: (tool: any) => tools.set(tool.name, tool), registerMessageRenderer() {},
		getActiveTools: () => active, setActiveTools: (names: string[]) => { active = names; },
		// As in Pi: built-ins, replaced by any extension tool of the same name, which Pair's own edit and write are.
		getAllTools: () => [...new Map([...["read", "grep", "find", "ls", "bash", "edit", "write"].map((name) => [name, { name, sourceInfo: { source: "builtin", path: `<builtin:${name}>` } }]),
			...[...tools.keys()].map((name) => [name, { name, sourceInfo: { source: "local", path: "<pi-pair>" } }]),
			...[...foreign].map((name) => [name, { name, sourceInfo: { source: "local", path: "<another-extension>" } }])] as [string, any][]).values()],
		appendEntry: (customType: string, data: any) => entries.push({ type: "custom", id: String(entries.length), customType, data }),
		sendUserMessage: (text: string) => { userMessages.push(text); },
		sendMessage: (message: any, options: any) => {
			messages.push({ message, options });
			if (options?.triggerTurn) deliver({ role: "custom", ...message, timestamp: ++timestamp });
		},
	} as unknown as ExtensionAPI);
	const ui = {
		setStatus: (_key: string, text?: string) => statuses.push(text),
		setWidget: (_key: string, lines?: string[]) => widgets.push(lines),
		notify: (text: string) => notices.push(text),
		select: async (_title: string, _options: string[]): Promise<string | undefined> => undefined,
		// One channel carries both the editor protocol and ordinary prompts, exactly as a real frontend sees them.
		input: async (title: string, body?: string) => {
			if (!title.startsWith("pi-pair:v1:")) { asked.push(title); return answer(title); }
			const reply = await editor?.(title.split(":").at(-1)!, JSON.parse(body ?? "null"));
			return reply === undefined ? undefined : JSON.stringify(reply);
		},
	};
	const ctx = {
		cwd, mode: editor ? "rpc" : "tui", hasUI: true, ui,
		isIdle: () => true, waitForIdle: async () => {}, abort() {},
		sessionManager: { getBranch: () => entries, getLeafId: () => entries.at(-1)?.id ?? null,
			getSessionId: () => "test", getSessionFile: () => "/sessions/parent.jsonl" },
		newSession: async (options: any) => { sessions.push(options); return { cancelled: false }; },
	} as unknown as ExtensionCommandContext;
	const command = (name: string, args = "") => commands.get(name).handler(args, ctx);
	const turn = async (text = "Discuss the selected task.", source = "rpc") => {
		const input = await emit("input", { text, source });
		if (input?.action === "handled") return { input };
		const prompt = await emit("before_agent_start", { prompt: text, systemPrompt: "base" });
		deliver({ role: "user", content: [{ type: "text", text }], timestamp: ++timestamp });
		return prompt;
	};
	const write = (params: any) => tools.get("pair_write").execute("write", params, undefined, undefined, ctx);
	const gate = (toolName: string, input: any = {}) => emit("tool_call", { toolName, input, toolCallId: "call" });
	const context = () => emit("context", { messages: history }).messages;
	const file = join(cwd, ".pi/pi-pair/specs/flow.md");
	const pick = (match: string) => { ui.select = async (_title, options) => options.find((option) => option.startsWith(match)); };
	const choose = async (id = "1") => { ui.select = async (title, options) => title.startsWith("Spec tasks") ? options.find((option) => option.startsWith(`${id}. `)) : undefined; await command("pair:tasks"); };
	return { cwd, file, ctx, ui, entries, messages, userMessages, notices, statuses, widgets, sessions, tools, history, asked, foreign, active: () => active,
		emit, deliver, turn, write, gate, context, command, choose, pick,
		hash: (id = "1") => loadSpec(file).parsed.tasks.find((task) => task.id === id)!.hash,
		spec: () => loadSpec(file), answers: (fn: typeof answer) => { answer = fn; },
		settle: () => emit("agent_settled"),
		start: () => emit("session_start"),
		init: async (tasks = false) => { await command("pair", "Flow"); if (tasks) { writeFileSync(file, SPEC); await choose(); } },
	};
}

const taskWrite = (h: ReturnType<typeof harness>, id = "1", sections: Record<string, string> = SECTIONS) =>
	({ kind: "task", id, baseHash: h.hash(id), sections });

test("Spec and Pair task lists show task IDs, not row positions, and leave controls unnumbered", async (t) => {
	const h = harness(t);
	await h.init();
	writeFileSync(h.file, SPEC.replace("## 1:", "## 7:").replace("## 2:", "## 11:"));
	const lists: string[][] = [];
	const titles: string[] = [];
	h.ui.select = async (title, options) => {
		titles.push(title);
		if (/^(Spec|Pair) tasks/.test(title)) { lists.push(options); return options[1]; }
		return undefined;
	};
	await h.command("pair:tasks");
	assert.deepEqual(lists[0], ["7. Backoff · written", "11. Report · written", "+ New task", "Describe changes…", "Cancel", "Show spec file"]);
	assert.match(titles.at(-1)!, /^Task 11: Report/);
	const snapshot = h.spec();
	writeState(stateFile(h.file), { ...snapshot.state, specAgreed: true,
		tasks: Object.fromEntries(snapshot.parsed.tasks.map((task) => [task.id, { agreedHash: task.hash, completedHash: null }])) });
	await h.command("pair:tasks");
	assert.deepEqual(lists[1], ["7. Backoff", "11. Report · next", "Cancel", "Show spec file"]);
	assert.equal(titles.at(-1), "Task 11: Report");
});

test("New spec asks for a name with Pair context and an example; cancelling creates nothing", async (t) => {
	for (const answer of [undefined, "   ", "Reconnect after sleep"]) {
		const h = harness(t);
		const file = join(h.cwd, ".pi/pi-pair/specs/reconnect-after-sleep.md");
		h.ui.select = async (title, options) => {
			assert.deepEqual(options, ["Pair with spec", "Pair no spec", "New spec", "Edit spec"]);
			return title === "Pair" ? "New spec" : undefined;
		};
		h.answers((title) => {
			assert.match(title, /^Pair · New spec\nEnter a name/);
			assert.ok(title.includes(".pi/pi-pair/specs/<name>.md"));
			assert.equal(existsSync(file), false);
			return answer;
		});
		await h.command("pair");
		assert.equal(existsSync(file), !!answer?.trim());
		if (answer?.trim()) {
			assert.equal(readFileSync(file, "utf8").startsWith("# Reconnect after sleep\n"), true);
			assert.deepEqual(loadSpec(file).state, emptyState());
			assert.match(h.statuses.at(-1)!, /Spec: reconnect-after-sleep/);
		} else {
			assert.equal(existsSync(join(h.cwd, ".pi/pi-pair/specs")), false);
			assert.equal(h.statuses.length, 0);
		}
	}
});

test("a spec opens automatically only on creation, then opens from Show spec file", async (t) => {
	const calls: string[] = [];
	const h = harness(t, (method, args) => {
		calls.push(method);
		return method === "handshake" ? { version: 1, editor: "test", capabilities: ["open", "buffer_state"] }
			: { ok: true, buffers: (args?.paths ?? []).map((path: string) => ({ path, open: false, modified: false })) };
	});
	await h.start();
	await h.init();
	// Creation opens the file once, before the model fills it in.
	assert.equal(calls.filter((name) => name === "open").length, 1);
	assert.match(h.messages.at(-1).message.content, /^What are you trying to solve\?$/);

	const original = "Original CAPS, punctuation?!";
	const prompt = await h.turn(original);
	assert.equal(prompt.message.display, false);
	assert.match(prompt.message.content, /"phase": "describe"/);
	assert.match(prompt.message.content, /"write": "any"/); // One turn writes the goal, the titles and every task.
	assert.equal(h.history.at(-1).content[0].text, original); // The developer's words reach the model unchanged.

	// Steps 6 and 7: the breakdown and every task's sections, in one turn, so the code is read once.
	const result = await h.write({ kind: "tasks", goal: "Stay up.", order: "Backoff first: the report needs it.", names: ["Backoff", "Report"] });
	assert.deepEqual(h.spec().parsed.tasks.map((task) => task.id), ["1", "2"]); // The numbers are the order of work.
	assert.equal(h.spec().parsed.order, "Backoff first: the report needs it."); // And the spec says why.
	// The model is told what landed and nothing more; the contract already says what writing means.
	assert.equal(result.content[0].text, "Saved tasks 1, 2, the goal and the order.");
	// The developer sees progress, badged by the mode that is speaking.
	assert.match(h.messages.at(-1).message.content, /^Found 2 tasks\. Filling them in…$/);
	assert.equal(h.messages.at(-1).message.details.badge, "Spec");
	assert.deepEqual([h.spec().parsed.goal, h.spec().view.agreed], ["Stay up.", 0]);
	// Filling in an empty task needs no baseHash: there is no earlier version of it to lose.
	assert.equal(h.gate("pair_write", { kind: "task", id: "1", sections: SECTIONS }), undefined);
	await h.write({ kind: "task", id: "1", sections: SECTIONS });
	// The contract outlives its own writes: one empty task left still means drafting.
	assert.match(h.context().at(-1).content, /"phase": "describe"/);
	assert.match(h.context().at(-1).content, /Order: Backoff first: the report needs it\./);
	await h.write({ kind: "task", id: "2", sections: SECTIONS });
	assert.match(h.messages.at(-1).message.content, /^Finished task 2: Report\.$/);
	assert.match(h.context().at(-1).content, /"phase": "spec"/);
	// Rewriting one it has already written takes the hash the contract lists, so it never guesses.
	assert.match(h.context().at(-1).content, new RegExp(`1: Backoff · written · baseHash ${h.hash("1")}`));
	await assert.rejects(h.write({ kind: "task", id: "1", sections: { Task: "Guessed." } }), /different baseHash/);
	await h.write(taskWrite(h, "1", { Task: "Retry gently, with a cap." }));
	assert.match(h.messages.at(-1).message.content, /^Saved task 1: Backoff\.$/); // Drafting is over: a change, not progress.

	// The task list follows the model's turn without reopening the file.
	let offered: string[] = [];
	h.ui.select = async (_title, options) => { offered = options; return undefined; };
	await h.settle();
	assert.equal(calls.filter((name) => name === "open").length, 1);
	assert.deepEqual(offered, ["1. Backoff · written · 1 open", "2. Report · written · 1 open", "+ New task", "Describe changes…", "Cancel", "Show spec file"]);
	assert.equal(h.widgets.at(-1)?.length, 1); // One line of shortcuts, never two.
	assert.deepEqual(h.widgets.at(-1), ["/pair:tasks Tasks · /pair:exit Exit Pair"]);
	await h.command("pair:tasks");
	await h.choose("1");
	assert.equal(calls.filter((name) => name === "open").length, 1);
	h.ui.select = async (title, options) => title.startsWith("Spec tasks") ? options.at(-1) : undefined;
	await h.command("pair:tasks");
	assert.equal(calls.filter((name) => name === "open").length, 2);
	h.ui.select = async () => undefined;
	await h.command("pair", "flow");
	assert.equal(calls.filter((name) => name === "open").length, 2);
	const snapshot = h.spec();
	writeState(stateFile(h.file), { ...snapshot.state, specAgreed: true,
		tasks: Object.fromEntries(snapshot.parsed.tasks.map((task) => [task.id, { agreedHash: task.hash, completedHash: null }])) });
	await h.command("pair:tasks");
	assert.equal(calls.filter((name) => name === "open").length, 2);
	h.ui.select = async (title, options) => title.startsWith("Pair tasks") ? options.at(-1) : undefined;
	await h.command("pair:tasks");
	assert.equal(calls.filter((name) => name === "open").length, 3);
});

test("a filled task opens on its summary and choices, not automatic questions or another model turn", async (t) => {
	const h = harness(t);
	await h.init();
	await h.write({ kind: "tasks", goal: "Stay up.", names: ["Backoff"] });
	h.ui.select = async (_title, options) => options[0];
	await h.settle();
	assert.match(h.messages.at(-1).message.content, /^Fill in task 1: Backoff\.$/);
	assert.equal(h.messages.at(-1).options.triggerTurn, true);
	assert.match((await h.turn("anything")).message.content, /"phase": "populate"/);
	h.ui.select = async () => undefined;
	await assert.rejects(h.write({ kind: "task", id: "2", sections: SECTIONS }), /did not allow writing task 2; this turn may write task 1 only/);
	await h.write(taskWrite(h, "1", { ...SECTIONS, Summary: "Retry with a growing delay.",
		Questions: "- [ ] Q1: Fixed or exponential?\n  - Options: fixed | exponential\n- [ ] Q2: Cap the total wait?" }));
	assert.deepEqual(h.spec().parsed.tasks[0].questions.map(({ id, checked, text, fields }) => [id, checked, text, fields]),
		[["Q1", false, "Fixed or exponential?", { Options: "fixed | exponential" }], ["Q2", false, "Cap the total wait?", {}]]);
	const count = h.messages.length;
	let menu: [string, string[]] | undefined;
	h.ui.select = async (title, options) => { menu = [title, options]; return "obsolete choice"; };
	await h.settle(); // Unknown choices must dismiss rather than loop into an empty question list.
	assert.deepEqual(menu, ["Task 1: Backoff · written · 3 open\n\nRetry with a growing delay.",
		["Answer 2 open questions", "Agree", "Describe changes…", "Back to the list"]]);
	assert.deepEqual(h.asked, []);
	assert.equal(h.messages.length, count);
	assert.equal(h.spec().view.agreed, 0);
});

test("code records written questions' answers; all answered agrees, partial answers return to the task", async (t) => {
	for (const partial of [false, true]) {
		const questions: any[] = [];
		const h = harness(t, (method, args) => {
			if (method === "handshake") return { version: 1, editor: "test", capabilities: ["buffer_state", "ask"] };
			if (method === "ask") {
				questions.push(...args.questions);
				return { ok: true, answers: [{ answer: "fixed", typed: false }, partial ? null : { answer: "30 seconds", typed: true }] };
			}
			return { ok: true, buffers: args.paths.map((path: string) => ({ path, open: false, modified: false })) };
		});
		h.start(); await h.init();
		writeFileSync(h.file, SPEC.replace("### Task\nRetry.", "### Summary\nRetry safely.\n### Task\nRetry.\n### Questions\n"
			+ "- [ ] Q1: Fixed or exponential?\n  - Options: fixed | exponential\n- [ ] Q2: Cap the total wait?"));
		let visits = 0;
		let menu: [string, string[]] | undefined;
		h.ui.select = async (title, options) => {
			menu = [title, options];
			if (title.startsWith("Spec tasks")) return visits++ ? undefined : options[0];
			return options.includes("Answer 2 open questions") ? "Answer 2 open questions" : undefined;
		};
		await h.command("pair:tasks");
		assert.deepEqual(questions, [{ label: "Q1", question: "Fixed or exponential?", options: ["fixed (recommended)", "exponential"] },
			{ label: "Q2", question: "Cap the total wait?", options: [] }]);
		assert.deepEqual(h.spec().parsed.tasks[0].questions.map(({ checked, fields }) => [checked, fields.Answer]),
			[[true, "fixed"], [!partial, partial ? undefined : "30 seconds"]]);
		if (partial) {
			assert.equal(h.spec().view.agreed, 0);
			assert.match(h.messages.at(-1).message.content, /1 still open/);
			assert.match(menu![0], /^Task 1: Backoff/);
			assert.equal(menu![1][0], "Answer 1 open question");
		} else {
			assert.equal(h.spec().state.tasks["1"].agreedHash, h.hash("1"));
			assert.match(h.messages.at(-1).message.content, /^Task 1: Backoff approved\.$/);
			assert.deepEqual(menu![1], ["1. Backoff · agreed", "2. Report · written", "+ New task", "Describe changes…", "Approve spec", "Cancel", "Show spec file"]);
		}
	}
});

test("typed changes are user messages, scoped by where they were typed, and return to the task or list after the turn", async (t) => {
	const h = harness(t);
	await h.init(true);
	for (const selected of [true, false]) {
		h.ui.select = async (title, options) => title.startsWith("Spec tasks") && selected ? options[0] : "Describe changes…";
		h.answers(() => "make the delay longer");
		await h.command("pair:tasks");
		assert.equal(h.userMessages.at(-1), "make the delay longer");
		const prompt = await h.turn(h.userMessages.at(-1)!, "extension");
		assert.match(prompt.message.content, selected ? /"write": "task"/ : /"write": "any"/);
		if (!selected) {
			assert.ok(prompt.message.content.includes("## 2: Report")); // Cross-task edits carry the content; reading the spec is forbidden.
			await h.write(taskWrite(h, "2", { Task: "Report retries too." }));
		}
		await h.write(taskWrite(h, "1", { Task: "Retry with a longer delay." }));
		let title = "";
		h.ui.select = async (heading) => { title = heading; return undefined; };
		await h.settle();
		assert.match(title, selected ? /^Task 1: Backoff/ : /^Spec tasks/);
	}
});

test("old specs fall back to the first Task paragraph; RPC titles also carry the full task", async (t) => {
	for (const rpc of [false, true]) {
		const h = harness(t);
		await h.init(true);
		if (rpc) h.ctx.mode = "rpc";
		writeFileSync(h.file, SPEC.replace("Retry.", "Retry.\n\nLonger details."));
		let title = "";
		h.ui.select = async (heading, options) => {
			if (heading.startsWith("Spec tasks")) return options[0];
			title = heading; return undefined;
		};
		await h.command("pair:tasks");
		assert.match(title, /^Task 1: Backoff · written\n\nRetry\./);
		assert.equal(title.includes("\n---\n## 1: Backoff"), rpc);
		assert.equal(title.includes("Longer details."), rpc);
	}
});

test("approving a task returns to the list, where one agreed task makes the spec approvable", async (t) => {
	const h = harness(t);
	await h.init(true);
	assert.equal(h.statuses.at(-1), "🧑‍🤝‍🧑 Spec: 1/2"); // Where the developer is, and nothing else.
	// Step 13: the only gate on a task, recording the version the developer actually saw.
	let offered: string[] = [];
	h.ui.select = async (_title, options) => { offered = options; return undefined; };
	await h.command("pair:approve");
	assert.deepEqual([h.spec().view.agreed, h.spec().state.tasks["1"].agreedHash], [1, h.hash("1")]);
	assert.equal(h.spec().view.ready, false); // Approving a task is not approving the spec.
	assert.match(h.messages.at(-1).message.content, /^Task 1: Backoff approved\.$/);
	// Step 17: back to the list, which now offers the spec.
	assert.deepEqual(offered, ["1. Backoff · agreed", "2. Report · written", "+ New task", "Describe changes…", "Approve spec", "Cancel", "Show spec file"]);
	assert.deepEqual(h.widgets.at(-1), ["/pair:approve Approve spec · /pair:tasks Tasks · /pair:exit Exit Pair"]);

	// Step 13 again, from the review dialog this time: 2 has no questions, so Agree is right there.
	const titles: string[] = [];
	h.ui.select = async (title, options) => {
		titles.push(title); offered = options;
		return options.find((option) => option.startsWith("2. Report")) ?? (options.includes("Agree") ? "Agree" : undefined);
	};
	await h.command("pair:tasks");
	assert.deepEqual([h.spec().view.agreed, h.messages.at(-1).message.content], [2, "Task 2: Report approved."]);
	// Step 18: with every task agreed, the list opens on the spec itself before anything else.
	assert.deepEqual([titles.at(-1), offered], ["Every task is agreed", ["Approve spec", "Keep working on the tasks"]]);

	// Step 19: approving the spec, from that offer, the list or the key command; the order is the plan from here.
	h.pick("Approve spec");
	await h.command("pair:tasks");
	assert.deepEqual([h.spec().state.specAgreed, h.spec().view.ready], [true, true]);
	assert.equal(h.messages.at(-1).message.content,
		"I've now put us into pairing mode with spec flow. This is the order I advise we do it in:\n1. Backoff\n2. Report\nMark each done from /pair:tasks as it lands; /pair:next starts the next one in a fresh session.");
	assert.equal(h.statuses.at(-1), "🧑‍🤝‍🧑 Pair: flow · 1/2 · you drive · hints"); // Approved: Pair is working on it, task 1 first.
	assert.deepEqual(h.widgets.at(-1), ["/pair:tasks Tasks · /pair:profile Profile · /pair:exit Exit Pair"]);
	assert.ok(h.entries.some((entry) => entry.customType === "pi-pair-trace" && entry.data.event === "approved"));

	// An empty task has nothing to approve, and the spec cannot be approved before any task is.
	writeState(stateFile(h.file), emptyState());
	await h.choose("2");
	writeFileSync(h.file, SPEC.replace("Show error.", ""));
	await h.command("pair:approve");
	assert.match(h.notices.at(-1)!, /Task 2 has nothing written to approve yet/);
	h.pick("Cancel");
	await h.command("pair:tasks");
	await h.command("pair:approve");
	assert.match(h.notices.at(-1)!, /Approve a task before approving the spec/);
	assert.equal(h.spec().state.specAgreed, false);
});

test("a new task can be added from the list and is filled in like any other", async (t) => {
	const h = harness(t);
	await h.init(true);
	h.pick("+ New task");
	h.answers(() => "Reconnect after sleep");
	await h.command("pair:tasks");
	assert.deepEqual(h.spec().parsed.tasks.map((task) => task.name), ["Backoff", "Report", "Reconnect after sleep"]);
	assert.match(h.messages.at(-1).message.content, /^Fill in task 3: Reconnect after sleep\.$/);
	assert.equal(h.statuses.at(-1), "🧑‍🤝‍🧑 Spec: 3/3");
});

test("Q2: a write outside the turn's scope asks the developer first, one key per write; declined or late, nothing is written", async (t) => {
	const h = harness(t);
	await h.init(true);
	assert.match((await h.turn("the reporting task needs an edge case")).message.content, /"write": "task"/);
	assert.match(h.context().at(-1).content, /a write outside it asks the developer first, so make one only when they asked for it/);
	const asked: [string, string[]][] = [];
	let answer: string | undefined = "Allow this write";
	h.ui.select = async (title, options) => { asked.push([title, options]); return answer; };
	// Inside the scope: no question.
	await h.write(taskWrite(h, "1", { Task: "Retry gently." }));
	assert.equal(asked.length, 0);
	// Another task: asked, allowed, written.
	await h.write(taskWrite(h, "2", { Task: "Report each retry." }));
	assert.deepEqual(asked, [["The model wants to write task 2: Report. This turn may write task 1 only.", ["Allow this write", "Cancel"]]]);
	assert.match(h.spec().text, /Report each retry\./);
	// The goal or a new task: asked again; Cancel refuses it and nothing changes.
	answer = "Cancel";
	const before = h.spec().text;
	await assert.rejects(h.write({ kind: "tasks", names: ["Sneaked in"] }),
		/^Error: The developer did not allow writing the goal, order or task list, adding Sneaked in; this turn may write task 1 only\. Ask in chat instead\.$/);
	assert.equal(asked.at(-1)![0], "The model wants to write the goal, order or task list, adding Sneaked in. This turn may write task 1 only.");
	assert.equal(h.spec().text, before);
	// An answer that lands after Stop allows nothing.
	let release!: (value: string) => void;
	h.ui.select = () => new Promise<string>((resolve) => { release = resolve; });
	const late = h.write(taskWrite(h, "2", { Task: "Late." }));
	await new Promise((resolve) => setImmediate(resolve));
	await h.command("pair:exit");
	release("Allow this write");
	await assert.rejects(late, /did not allow writing task 2/);
	assert.doesNotMatch(h.spec().text, /Late\./);
});

test("Spec plans and never implements, whatever the conversation says", async (t) => {
	const h = harness(t);
	await h.init(true);
	for (const text of ["Explain that", "Investigate the bug", "yes, but change it", "just write the code already"]) {
		const prompt = await h.turn(text);
		assert.equal(prompt.message.customType, CONTRACT);
		assert.match(prompt.message.content, /"task": "1"/);
		assert.equal(h.context().filter((message: any) => message.customType === CONTRACT).length, 1); // Never accumulated.
		for (const tool of ["read", "grep", "find", "ls", "pair_ask"]) assert.equal(h.gate(tool), undefined);
		for (const tool of ["write", "edit", "bash", "external", "subagent"]) assert.equal(h.gate(tool).block, true);
	}
	assert.match(h.gate("write").reason, /Spec plans, it never implements/);
	// The tool asks before an out-of-scope payload; unanswered, it is refused.
	await assert.rejects(h.write({ kind: "tasks", names: ["Sneaked in"] }), /The developer did not allow writing the goal, order or task list, adding Sneaked in; this turn may write task 1 only/);
	await h.command("pair:exit");
	assert.equal(h.gate("write"), undefined);
	assert.deepEqual([h.statuses.at(-1), h.widgets.at(-1)], [undefined, undefined]);
	assert.match(h.messages.at(-1).message.content, /^Exited Pair\./);
	assert.equal(h.messages.at(-1).message.details.badge, "Pair"); // Off is not Spec speaking.
	assert.equal(h.context().filter((message: any) => message.customType === CONTRACT).length, 0);
});

test("unsaved editor buffers block every write, not just approval", async (t) => {
	let modified = true;
	let fail = false;
	const h = harness(t, (method, args) => {
		if (method === "handshake") return { version: 1, editor: "test", capabilities: ["buffer_state"] };
		if (fail) return { ok: false, error: "Editor check failed" };
		return { ok: true, buffers: args.paths.map((path: string) => ({ path, open: true, modified })) };
	});
	h.start();
	await h.init(true);
	await assert.rejects(h.write(taskWrite(h)), /unsaved changes in the editor/);
	await h.command("pair:approve");
	assert.match(h.notices.at(-1)!, /unsaved changes in the editor/);
	assert.equal(h.spec().view.agreed, 0);
	assert.equal(h.spec().text, SPEC); // Not one byte written while the developer was editing.
	fail = true;
	await assert.rejects(h.write(taskWrite(h)), /Editor check failed/);
	fail = false; modified = false;
	await h.write(taskWrite(h));
	assert.match(h.spec().text, /Retry gently\./);

	// A configured editor that never connected cannot be silently skipped.
	const absent = harness(t, () => undefined);
	absent.start();
	await absent.init(true);
	await assert.rejects(absent.write(taskWrite(absent)), /cannot check unsaved buffers/);
	await absent.command("pair:approve");
	assert.match(absent.notices.at(-1)!, /cannot check unsaved buffers/);
});

test("a stale write is refused, and a manual edit simply becomes the version under review", async (t) => {
	const h = harness(t);
	await h.init(true);
	const stale = taskWrite(h);
	writeFileSync(h.file, SPEC.replace("Retry.", "Retry, but differently."));
	await assert.rejects(h.write(stale), /Task 1 has content written under a different baseHash/);
	// The developer's own edit needs no permission: it is simply what gets approved.
	await h.command("pair:approve");
	assert.equal(h.spec().view.agreed, 1);
	assert.match(h.spec().parsed.tasks[0].sections.Task!.text, /Retry, but differently\./);
});

test("Pair restores its spec and selection, and forgets a task that no longer exists", async (t) => {
	const h = harness(t);
	await h.init(true);
	h.emit("session_tree");
	assert.equal(h.statuses.at(-1), "🧑‍🤝‍🧑 Spec: 1/2");
	assert.match((await h.turn()).message.content, /"task": "1"/);
	writeFileSync(h.file, SPEC.replace(/## 1: Backoff[\s\S]*?(?=## 2)/, ""));
	h.emit("session_tree");
	assert.equal(h.statuses.at(-1), "🧑‍🤝‍🧑 Spec: flow"); // The task it was on is gone.
	// An unreadable spec stops Pair rather than guessing.
	writeFileSync(h.file, "## 2: Report\n## 2: Duplicate\n");
	h.emit("session_tree");
	assert.match(h.notices.at(-1)!, /Pair not resumed/);
	assert.equal(h.statuses.at(-1), undefined);
	assert.equal(h.gate("write"), undefined);
});

test("handoff needs an approved spec, and hands the next task over with the spec as the plan", async (t) => {
	const h = harness(t);
	await h.init(true);
	await h.command("pair:next");
	assert.match(h.notices.at(-1)!, /Approve the spec before handing off/);
	assert.equal(h.sessions.length, 0);
	const snapshot = h.spec();
	writeState(stateFile(h.file), { tasks: Object.fromEntries(snapshot.parsed.tasks.map((task) => [task.id, { agreedHash: task.hash, completedHash: null }])), specAgreed: true });
	await h.command("pair:next");
	assert.equal(h.sessions.length, 1);
	assert.equal(h.sessions[0].parentSession, "/sessions/parent.jsonl");
	const sent: any[] = [];
	await h.sessions[0].withSession({ sendMessage: async (...args: any[]) => sent.push(args) });
	assert.match(sent[0][0].content, /^Pair on task 1: Backoff from .*the spec is the plan/s); // Who edits is the first request's contract.
	assert.equal(sent[0][1].triggerTurn, false);
});

test("an approved spec puts Pair to work: the plan in the prompt, ordinary tools back, tasks marked done from the list", async (t) => {
	const h = harness(t);
	await h.init(true);
	writeFileSync(h.file, SPEC.replace("Stay up.\n", "Stay up.\n\n## Order\n1 before 2: the report needs the retry in place.\n"));
	await h.command("pair:approve"); // Task 1.
	h.pick("Approve spec");
	await h.command("pair:tasks");
	assert.equal(h.spec().view.ready, true);
	// Step 19: the message gives the order from the spec, and is the last thing Spec says.
	assert.equal(h.messages.at(-1).message.content, "I've now put us into pairing mode with spec flow. This is the order I advise we do it in:\n"
		+ "1 before 2: the report needs the retry in place.\nMark each done from /pair:tasks as it lands; /pair:next starts the next one in a fresh session.");
	assert.equal(h.messages.at(-1).message.details.badge, "Spec");
	assert.equal(h.statuses.at(-1), "🧑‍🤝‍🧑 Pair: flow · 1/2 · you drive · hints");
	assert.deepEqual(h.widgets.at(-1), ["/pair:tasks Tasks · /pair:profile Profile · /pair:exit Exit Pair"]);
	// Pair with a spec attached: no turn contract, nothing blocked, and the plan in the system prompt.
	const prompt = await h.turn("let's start");
	assert.equal(prompt.message, undefined);
	assert.match(prompt.systemPrompt, /^base\n\nPair is on with the approved spec .*flow\.md; it is the plan.*\nGoal: Stay up\.\nOrder: 1 before 2: the report needs the retry in place\.\nTasks:\n1: Backoff · next\n2: Report\n/s);
	// No Spec contract: one Pair request contract, with the developer driving by default.
	const contracts = h.context().filter((message: any) => message.customType === CONTRACT);
	assert.equal(contracts.length, 1);
	assert.match(contracts[0].content, /^Pair request contract\nRequest \d+; [^\n]*\nProfile: you drive · hints · each step\.\nTask: 1: Backoff\.\nThe developer drives: don't edit files\./);
	assert.equal(h.gate("bash", { command: "git status --short" }), undefined);
	assert.equal(h.gate("read", { path: ".pi/pi-pair/specs/flow.md" }), undefined); // The plan is read, now that it is the plan.
	await assert.rejects(h.write(taskWrite(h, "1")), /it may write nothing/);
	await h.command("pair:approve");
	assert.match(h.notices.at(-1)!, /The spec is approved, and Pair is working on it/);
	// The list is the plan as progress now, and reads apart from the Spec list; done takes the developer back to it.
	const titles: string[] = [];
	const offered: string[][] = [];
	h.ui.select = async (title, options) => {
		titles.push(title); offered.push(options);
		return title.startsWith("Pair tasks") ? options.find((option) => option.startsWith("1. Backoff")) : options.find((option) => option === "Mark task as done");
	};
	await h.command("pair:tasks");
	assert.deepEqual(titles, ["Pair tasks · flow", "Task 1: Backoff", "Pair tasks · flow", "Task 1: Backoff · done"]);
	assert.deepEqual(offered, [["1. Backoff · next", "2. Report", "Cancel", "Show spec file"], ["Implement task", "Implement task + prompt", "Mark task as done", "Cancel"],
		["1. Backoff · done", "2. Report · next", "Cancel", "Show spec file"], ["Reset task", "Go back"]]);
	assert.deepEqual([h.spec().view.completed, h.spec().state.tasks["1"].completedHash], [1, h.hash("1")]);
	assert.equal(h.messages.at(-1).message.content, "Task 1: Backoff done. Next: task 2: Report.");
	assert.equal(h.messages.at(-1).message.details.badge, "Pair");
	assert.equal(h.statuses.at(-1), "🧑‍🤝‍🧑 Pair: flow · 2/2 · you drive · hints");
	// Marked by mistake: a reset keeps the agreement, drops the completion, and returns to the list.
	let visits = 0;
	h.ui.select = async (title) => title.startsWith("Pair tasks") ? (visits++ ? "Cancel" : "1. Backoff · done") : "Reset task";
	await h.command("pair:tasks");
	assert.equal(visits, 2);
	assert.deepEqual([h.spec().view.completed, h.spec().state.tasks["1"]], [0, { agreedHash: h.hash("1"), completedHash: null }]);
	assert.equal(h.messages.at(-1).message.content, "Task 1: Backoff is no longer done.");
	assert.equal(h.statuses.at(-1), "🧑‍🤝‍🧑 Pair: flow · 1/2 · you drive · hints");
	// Implement hands the task to the model in this session, with the developer's note when they add one.
	h.ui.select = async (title, options) => title.startsWith("Pair tasks") ? options.find((option) => option.startsWith("2. Report")) : "Implement task + prompt";
	h.answers(() => "Start with the error path.");
	await h.command("pair:tasks");
	assert.equal(h.asked.at(-1), "Task 2: Report");
	assert.equal(h.messages.at(-1).message.content, "Pair on task 2: Report from .pi/pi-pair/specs/flow.md. Read the task first: the spec is the plan, and its discussion is already settled there.\n\nStart with the error path.");
	assert.equal(h.messages.at(-1).options.triggerTurn, true);
	assert.equal(h.statuses.at(-1), "🧑‍🤝‍🧑 Pair: flow · 2/2 · you drive · hints"); // The task being implemented is the current one.
	assert.match((await h.turn("go on")).systemPrompt, /Tasks:\n1: Backoff\n2: Report · next\n/);
	h.ui.select = async (title, options) => title.startsWith("Pair tasks") ? options.find((option) => option.startsWith("2. Report")) : "Implement task";
	await h.command("pair:tasks");
	assert.equal(h.messages.at(-1).message.content, "Pair on task 2: Report from .pi/pi-pair/specs/flow.md. Read the task first: the spec is the plan, and its discussion is already settled there.");
	// Done, task by task, until the list has nothing left to pick.
	h.ui.select = async (title, options) => title.startsWith("Pair tasks") ? options.find((option) => /^\d+\. /.test(option) && !option.endsWith("· done")) : "Mark task as done";
	await h.command("pair:tasks");
	assert.equal(h.messages.at(-1).message.content, "Task 2: Report done. Every task is done.");
	assert.equal(h.statuses.at(-1), "🧑‍🤝‍🧑 Pair: flow · done · you drive · hints");
	assert.ok(h.entries.some((entry) => entry.customType === "pi-pair-trace" && entry.data.event === "done"));
});

test("Spec never reads its own files: the contract carries the spec, and the files are the developer's", async (t) => {
	const h = harness(t);
	await h.init(true);
	const contract = h.context().at(-1).content;
	assert.doesNotMatch(contract, /Spec file/);
	assert.match(contract, /never read the files under \.pi\/pi-pair/);
	for (const path of [".pi/pi-pair/specs/flow.md", join(h.cwd, ".pi/pi-pair/specs"), ".pi/pi-pair/../pi-pair/trace.log", ".pi/pi-pair"]) {
		assert.match(h.gate("read", { path }).reason, /^Nothing under \.pi\/pi-pair is read in Spec: the contract carries the spec's content/);
	}
	assert.equal(h.gate("grep", { pattern: "retry", path: ".pi/pi-pair/specs" }).block, true);
	const blocked = h.entries.findLast((entry) => entry.customType === "pi-pair-trace")!.data;
	assert.deepEqual([blocked.event, blocked.tool, blocked.path], ["read_blocked", "grep", ".pi/pi-pair/specs"]);
	// Everything else in the project is still readable, including the directory above.
	assert.equal(h.gate("ls", { path: ".pi" }), undefined);
	assert.equal(h.gate("read", { path: "src/index.ts" }), undefined);
	assert.equal(h.gate("grep", { pattern: "retry" }), undefined);
});

/** The profile dialog, one tab at a time as askEach puts it: each value picks the option it starts. Other dialogs get nothing. */
const TABS = ["Who writes the code?", "How much help while you drive?", "When does Pair stop for you?"];
const profileOf = (...values: string[]) => (title: string, options: string[]) => {
	const i = TABS.indexOf(title);
	return i < 0 ? undefined : options.find((option) => option.startsWith(values[i]));
};
const guided = profileOf("You", "Hints", "Each step");
const driving = profileOf("The model", "Solution", "After a slice");

test("/pair offers pairing with an approved spec or editing any; editing an approved spec withdraws its approval", async (t) => {
	const h = harness(t);
	await h.init(true);
	const titles: string[] = [];
	const offered: string[][] = [];
	// Nothing is approved yet, so there is nothing to pair with.
	h.ui.select = async (title, options) => { titles.push(title); offered.push(options); return "Pair with spec"; };
	await h.command("pair");
	assert.deepEqual([titles, offered], [["Pair"], [["Pair with spec", "Pair no spec", "New spec", "Edit spec"]]]);
	assert.match(h.notices.at(-1)!, /No approved spec yet/);
	h.ui.select = async (title) => title === "Pair" ? "Edit spec" : "flow";
	await h.command("pair");
	assert.equal(h.statuses.at(-1), "🧑‍🤝‍🧑 Spec: flow");
	// Approved: Pair with spec lists it, and opens on the pairing-mode list.
	writeState(stateFile(h.file), { tasks: Object.fromEntries(h.spec().parsed.tasks.map((task) => [task.id, { agreedHash: task.hash, completedHash: null }])), specAgreed: true });
	titles.length = 0; offered.length = 0;
	h.ui.select = async (title, options) => { titles.push(title); offered.push(options); return title === "Pair" ? "Pair with spec" : title === "Pair with spec" ? "flow" : undefined; };
	await h.command("pair");
	assert.deepEqual([titles, offered[1]], [["Pair", "Pair with spec", "Who writes the code?", "Pair tasks · flow"], ["flow"]]);
	assert.equal(h.statuses.at(-1), "🧑‍🤝‍🧑 Pair: flow · 1/2 · you drive · hints");
	// Edit spec on an approved spec withdraws the approval: Spec is back, with its list and its limits.
	titles.length = 0;
	h.ui.select = async (title) => { titles.push(title); return title === "Pair" ? "Edit spec" : title === "Edit spec" ? "flow" : undefined; };
	await h.command("pair");
	assert.deepEqual(titles, ["Pair", "Edit spec", "Spec tasks · flow"]);
	assert.deepEqual([h.spec().state.specAgreed, h.spec().view.ready], [false, false]);
	assert.equal(h.messages.at(-1).message.content, "flow is open for editing; approve it again once it is right.");
	assert.equal(h.messages.at(-1).message.details.badge, "Spec");
	assert.equal(h.statuses.at(-1), "🧑‍🤝‍🧑 Spec: flow");
	assert.equal(h.gate("bash").block, true);
	// The approve offer stays out of the way just then, and is back the next time the list opens.
	titles.length = 0;
	h.ui.select = async (title) => { titles.push(title); return undefined; };
	await h.command("pair:tasks");
	assert.deepEqual(titles, ["Every task is agreed"]);
});

const approveAll = (h: ReturnType<typeof harness>) => writeState(stateFile(h.file),
	{ tasks: Object.fromEntries(h.spec().parsed.tasks.map((task) => [task.id, { agreedHash: task.hash, completedHash: null }])), specAgreed: true });
test("Pair no spec asks for a profile in code and keeps it in memory for the session; a cancelled choice saves nothing", async (t) => {
	const h = harness(t);
	const titles: string[] = [];
	h.ui.select = async (title) => { titles.push(title); return title === "Pair" ? "Pair no spec" : undefined; };
	await h.command("pair");
	assert.deepEqual(titles, ["Pair", "Who writes the code?"]);
	assert.match(h.statuses.at(-1)!, / Pair · you drive · hints$/);
	assert.deepEqual(h.widgets.at(-1), ["/pair:profile Profile · /pair:exit Exit Pair"]);
	// Still unchosen, so it is asked again; the model driving is a profile, and nothing is granted until files are confirmed.
	await pairNoSpec(h, driving);
	assert.match(h.statuses.at(-1)!, / Pair · model driving · after a slice$/);
	assert.equal(h.messages.at(-1).message.content, "Pair profile: model drives · solution · after a slice. The model edits only files you confirm.");
	titles.length = 0;
	h.ui.select = async (title) => { titles.push(title); return title === "Pair" ? "Pair no spec" : undefined; };
	await h.command("pair");
	assert.deepEqual(titles, ["Pair"]); // Chosen, so not asked again.
	// Never saved in the session: a new session starts from the starting profile and asks again.
	assert.equal(h.entries.some((entry) => entry.customType === "pi-pair" && ("profile" in entry.data || "settings" in entry.data)), false);
	h.start();
	assert.match(h.statuses.at(-1)!, / Pair · you drive · hints$/);
	titles.length = 0;
	await h.command("pair");
	assert.deepEqual(titles, ["Pair", "Who writes the code?"]);
	assert.equal(h.messages.some((message) => message.options?.triggerTurn), false);
});

test("the profile is saved with the spec, the latest choice winning; it follows tasks and /pair:next, and session settings never count", async (t) => {
	const h = harness(t);
	await h.init(true);
	approveAll(h);
	h.ui.select = async (title, options) => title === "Pair" ? "Pair with spec" : title === "Pair with spec" ? "flow"
		: profileOf("You", "Examples", "Each step")(title, options);
	await h.command("pair");
	assert.match(h.statuses.at(-1)!, /Pair: flow · 1\/2 · you drive · examples$/);
	assert.deepEqual(h.spec().state.profile, { driver: "human", assistance: "examples", checkpoint: "each_step" });
	assert.equal(h.messages.at(-1).message.content, "Pair profile: you drive · examples · each step.");

	// The dialog opens on the current values, and the latest choice wins.
	const solo = { driver: "human", assistance: "solution", checkpoint: "after_slice" };
	const offered: string[][] = [];
	h.ui.select = async (title, options) => { offered.push(options); return profileOf("You", "Solution", "After a slice")(title, options); };
	await h.command("pair:profile");
	assert.deepEqual(offered.map((options) => options[0]), ["You (current)", "Examples (current)", "Each step (current)"]);
	assert.deepEqual(h.spec().state.profile, solo);
	assert.match(h.statuses.at(-1)!, / you drive · solution$/);
	// Cancelling, or a typed answer, changes nothing.
	h.ui.select = async () => undefined;
	await h.command("pair:profile");
	h.ui.select = async (title) => title === TABS[0] ? "Other…" : undefined;
	h.answers(() => "The model");
	await h.command("pair:profile");
	h.answers(() => undefined);
	assert.deepEqual(h.spec().state.profile, solo);

	// The session carries no profile, so a task change and /pair:next keep the spec's, and the fresh session uses it without asking.
	h.ui.select = async (title, options) => title.startsWith("Pair tasks") ? options.find((option) => option.startsWith("2. Report")) : "Implement task";
	await h.command("pair:tasks");
	assert.deepEqual(h.entries.findLast((entry) => entry.customType === "pi-pair").data, { pair: true, spec: "flow", selection: "2" });
	await h.command("pair:next");
	const kept: any[] = [];
	await h.sessions[0].setup({ appendCustomEntry: (_type: string, data: any) => kept.push(data) });
	assert.deepEqual(kept, [{ pair: true, spec: "flow", selection: "2" }]);
	const sessionManager = h.ctx.sessionManager as any;
	const asked: string[] = [];
	h.ui.select = async (title) => { asked.push(title); return undefined; };
	sessionManager.getBranch = () => kept.map((data) => ({ type: "custom", customType: "pi-pair", data }));
	h.start();
	assert.match(h.statuses.at(-1)!, / you drive · solution$/);
	assert.deepEqual(asked, []);

	// E4: old session settings never count; without a saved profile the starting one applies, and grants nothing.
	sessionManager.getBranch = () => [{ type: "custom", customType: "pi-pair",
		data: { pair: true, spec: "flow", settings: { driver: "model", assistance: "solution", checkpoint: "after_slice" } } }];
	h.emit("session_tree");
	assert.match(h.statuses.at(-1)!, / you drive · solution$/);
	const { profile: _dropped, ...unchosen } = h.spec().state;
	writeState(stateFile(h.file), unchosen);
	h.emit("session_tree");
	assert.match(h.statuses.at(-1)!, / you drive · hints$/);
	assert.equal(h.gate("edit", { path: "src/retry.ts" }).block, true);

	// E5: a reply that lands after Stop saves nothing.
	let release!: (value: string) => void;
	let reached!: () => void;
	const opened = new Promise<void>((resolve) => { reached = resolve; });
	h.ui.select = (title) => title === TABS[0] ? (reached(), new Promise<string>((resolve) => { release = resolve; })) : Promise.resolve(undefined);
	const late = h.command("pair:profile");
	await opened;
	await h.command("pair:exit");
	release("The model");
	await late;
	assert.equal(h.spec().state.profile, undefined);
});

test("the model driving proposes its files once it starts; only Confirm grants them, for this request, and review hands back", async (t) => {
	const h = harness(t);
	await h.init(true);
	approveAll(h);
	mkdirSync(join(h.cwd, "src"));
	h.ui.select = async (title, options) => title === "Pair" ? "Pair with spec" : title === "Pair with spec" ? "flow" : driving(title, options);
	await h.command("pair");
	const profiled = / Pair: flow · 1\/2 · model driving · after a slice$/;
	assert.match(h.statuses.at(-1)!, profiled);
	// Implement task starts the turn at once: no handoff dialog, and nothing granted yet.
	const titles: string[] = [];
	h.ui.select = async (title, options) => { titles.push(title); return title.startsWith("Pair tasks") ? options.find((option) => option.startsWith("1. Backoff"))
		: title === "Task 1: Backoff" ? "Implement task" : undefined; };
	await h.command("pair:tasks");
	assert.deepEqual(titles, ["Pair tasks · flow", "Task 1: Backoff"]);
	assert.match(h.messages.at(-1).message.content, /^Pair on task 1: Backoff from .*settled there\.$/s);
	assert.equal(h.messages.at(-1).options.triggerTurn, true);
	assert.match(pairContracts(h)[0], /^Task: 1: Backoff\.\nNo files confirmed yet\.$/m);
	assert.deepEqual(h.active(), ["read", "bash", "grep", "find", "ls", "pair_ask", "pair_profile", "pair_files", "pair_report"]);
	assert.match(h.gate("edit", { path: "src/retry.ts" }).reason, /^Propose the files with pair_files first/);

	// Invalid proposals never reach the developer; Cancel grants nothing.
	for (const [path, reason] of [["../outside.ts", /outside the project, or among Pair's own files/], [".pi/pi-pair/specs/flow.md", /among Pair's own files/],
		["src", /src is not a file; propose files, not directories/]] as const) {
		await assert.rejects(proposeFiles(h, [path]), reason, path);
	}
	assert.equal(await said(proposeFiles(h, ["src/retry.ts"], "Cancel")), "The developer cancelled: change none of src/retry.ts. Ask in chat what they want instead.");
	assert.match(h.gate("edit", { path: "src/retry.ts" }).reason, /^Propose the files with pair_files first/);

	// Confirm: exactly these files, for this request, from now; the status says so while the developer is asked.
	let shown = "";
	let during: string | undefined;
	assert.equal(await said(proposeFiles(h, ["src/retry.ts", "test/retry.test.ts", "src/retry.ts"], async (title) => { shown = title; during = h.statuses.at(-1); return "Confirm"; })),
		"Confirmed: src/retry.ts, test/retry.test.ts. Change only src/retry.ts, test/retry.test.ts, with edit for files that exist and write only for new ones.");
	assert.equal(shown, "The model proposes to change:\n  src/retry.ts — Add retry.\n  test/retry.test.ts — Add retry.\n"
		+ "Confirm lets it edit exactly these until it stops; Cancel lets it edit none of them.");
	assert.match(during!, / model driving · after a slice · confirm files$/);
	assert.match(h.statuses.at(-1)!, / model driving · after a slice · 2 files confirmed$/);
	assert.deepEqual(h.active(), ["read", "bash", "write", "edit", "grep", "find", "ls", "pair_ask", "pair_profile", "pair_files", "pair_report"]);
	assert.match(pairContracts(h)[0], /^Confirmed files: src\/retry\.ts, test\/retry\.test\.ts\.$/m);
	// Extended: only the new file is asked about.
	await proposeFiles(h, ["src/retry.ts", "src/util.ts"], async (title) => { shown = title; return "Confirm"; });
	assert.match(shown, /^The model proposes to change, besides the files already confirmed:\n  src\/util\.ts — Add retry\.\n/);
	assert.equal(await said(proposeFiles(h, ["src/util.ts"])), "Already confirmed: src/retry.ts, test/retry.test.ts, src/util.ts.");
	assert.equal(h.entries.some((entry) => entry.customType === "pi-pair" && JSON.stringify(entry.data).includes("retry")), false);
	assert.equal(h.spec().state.targets, undefined);

	// The review boundary: the turn settles once, the files close, and the next request starts with none.
	await h.settle();
	assert.match(h.statuses.at(-1)!, / model driving · after a slice · review$/);
	assert.match(h.messages.at(-1).message.content, /^The model's slice of task 1: Backoff is finished, and its files are closed\. No files changed\./);
	assert.deepEqual(h.spec().state.tasks["1"], { agreedHash: h.hash("1"), completedHash: null }); // Reviewed, never marked done by Pair.
	await h.turn("What changed?");
	assert.match(h.statuses.at(-1)!, profiled);
	assert.match(pairContracts(h)[0], /^No files confirmed yet\.$/m);
	assert.match(h.gate("edit", { path: "src/retry.ts" }).reason, /^Propose the files with pair_files first/);
	await h.settle();
	assert.equal(h.messages.filter((message) => /files are closed/.test(message.message.content)).length, 1);

	// E5: a Confirm that lands after Stop grants nothing.
	await h.turn("Add retry.");
	let release!: (value: string) => void;
	let reached!: () => void;
	const opened = new Promise<void>((resolve) => { reached = resolve; });
	const late = proposeFiles(h, ["src/retry.ts"], () => { reached(); return new Promise<string>((resolve) => { release = resolve; }); });
	await opened;
	await h.command("pair:exit");
	release("Confirm");
	await assert.rejects(late, /Pair changed while the developer was asked, so nothing was confirmed/);
	assert.equal(h.gate("edit", { path: "src/retry.ts" }).block, true);
	assert.equal(h.statuses.at(-1), undefined);
});

test("pair_report hands a slice back: code returns to the task for review, and only the developer marks it done", async (t) => {
	const h = harness(t);
	await h.init(true);
	approveAll(h);
	h.ui.select = async (title, options) => title === "Pair" ? "Pair with spec" : title === "Pair with spec" ? "flow" : driving(title, options);
	await h.command("pair");
	// Implement task 1 with the model driving.
	h.ui.select = async (title, options) => title.startsWith("Pair tasks") ? options.find((option) => option.startsWith("1. Backoff"))
		: title === "Task 1: Backoff" ? "Implement task" : undefined;
	await h.command("pair:tasks");
	const report = (params: any) => h.tools.get("pair_report").execute("report", params, undefined, undefined, h.ctx);

	// With an approved spec the tool is available; the model's contract tells it to report when the slice is done.
	assert.ok(h.active().includes("pair_report"));
	assert.match(pairContracts(h)[0], /call pair_report \(status implemented\)/);

	// A report for another task is refused, and schedules no return.
	await assert.rejects(report({ task: "2", status: "implemented", summary: "done" }), /implementing task 1, not 2/);

	// The selected task: accepted, told to stop, and never marked done by the report.
	assert.match(await said(report({ task: "1", status: "implemented", summary: "Added backoff; ran the tests." })), /Stop here: don't keep editing/);
	assert.deepEqual(h.spec().state.tasks["1"], { agreedHash: h.hash("1"), completedHash: null });

	// When the turn settles, the summary is announced and the task's actions open with Mark done first.
	const offered: [string, string[]][] = [];
	h.ui.select = async (title, options) => { offered.push([title, options]); return undefined; };
	await h.settle();
	assert.equal(h.messages.at(-1).message.content, "The model reports task 1: Backoff implemented: Added backoff; ran the tests.");
	assert.deepEqual(offered.at(-1), ["Task 1: Backoff", ["Mark task as done", "Implement task", "Implement task + prompt", "Cancel"]]);
	assert.deepEqual(h.spec().state.tasks["1"], { agreedHash: h.hash("1"), completedHash: null });

	// A blocked report returns the same way, but offers Implement + prompt first.
	offered.length = 0;
	await said(report({ task: "1", status: "blocked", summary: "The client API is missing." }));
	await h.settle();
	assert.deepEqual(offered.at(-1), ["Task 1: Backoff", ["Implement task + prompt", "Implement task", "Mark task as done", "Cancel"]]);

	// A report for a task that is already done is refused, and leaves the completion as the developer set it.
	writeState(stateFile(h.file), { ...h.spec().state, tasks: { ...h.spec().state.tasks, "1": { agreedHash: h.hash("1"), completedHash: h.hash("1") } } });
	await assert.rejects(report({ task: "1", status: "implemented", summary: "done" }), /Task 1 is already done/);

	// With the spec reopened for editing there is no task list to return to, so the tool refuses. (A refresh updates the cached ready flag, as a real reopen does.)
	writeState(stateFile(h.file), { ...h.spec().state, tasks: { ...h.spec().state.tasks, "1": { agreedHash: h.hash("1"), completedHash: null } }, specAgreed: false });
	await h.emit("before_agent_start", { systemPrompt: "base" });
	await assert.rejects(report({ task: "1", status: "implemented", summary: "done" }), /no task to report on here/);
});

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 0 });
/** The Pair contracts on one model call, as text. */
const pairContracts = (h: ReturnType<typeof harness>): string[] => h.context().filter((message: any) => message.customType === CONTRACT)
	.map((message: any) => message.content);
const requestOf = (contract: string) => Number(contract.match(/^Request (\d+);/m)![1]);
/** The text a Pair tool answered with. */
const said = async (result: Promise<any>) => (await result).content[0].text;
/** The model proposes PATHS with pair_files; the developer answers with ANSWER, or ANSWER decides from the dialog's title. */
const proposeFiles = (h: ReturnType<typeof harness>, paths: string[], answer: string | undefined | ((title: string) => Promise<string | undefined>) = "Confirm") => {
	h.ui.select = async (title) => typeof answer === "function" ? answer(title) : title.startsWith("The model proposes to change") ? answer : undefined;
	return h.tools.get("pair_files").execute("files", { files: paths.map((path) => ({ path, why: "Add retry." })) }, undefined, undefined, h.ctx);
};
/** The model proposes a profile change with pair_profile. */
const proposeProfile = (h: ReturnType<typeof harness>, params: Record<string, string>) =>
	h.tools.get("pair_profile").execute("profile", params, undefined, undefined, h.ctx);
const pairNoSpec = async (h: ReturnType<typeof harness>, answer = guided) => {
	h.ui.select = async (title, options) => title === "Pair" ? "Pair no spec" : answer(title, options);
	await h.command("pair");
};

test("each Pair request is served one fresh contract from the live profile; new words end its files (D1), and a profile change applies within the turn", async (t) => {
	const h = harness(t);
	await pairNoSpec(h, driving);
	await h.turn("Add retry to the client.");
	await proposeFiles(h, ["src/client.ts"]);
	const [first] = pairContracts(h);
	assert.match(first, /^Pair request contract\nRequest \d+; this contract is for this request only\.\nProfile: model drives · solution · after a slice\.\nConfirmed files: src\/client\.ts\.\n/);
	// A tool continuation is another model call for the same request: still exactly one contract, the same one.
	assert.deepEqual(pairContracts(h), [first]);

	// D1: the developer's next words end the files before Pi even delivers them, and the next request starts with none.
	const steer = h.emit("input", { text: "Wait, I'll write the rest myself.", source: "rpc", streamingBehavior: "steer" });
	assert.match(h.gate("edit", { path: "src/client.ts" }).reason, /^Changes are paused: The developer sent another message/);
	for (const name of ["bash", ...WEB_TOOLS]) assert.match(h.gate(name).reason, /^Changes are paused:/);
	assert.ok(!h.active().includes("bash"));
	await steer;
	h.deliver(user("Wait, I'll write the rest myself."));
	assert.equal(h.gate("bash", { command: "ls" }), undefined);
	assert.ok(h.active().includes("bash"));
	const [steered] = pairContracts(h);
	assert.equal(requestOf(steered), requestOf(first) + 1);
	assert.match(steered, /^No files confirmed yet\.$/m);
	// E2: their words for this turn win over the profile, which stays as it was.
	assert.match(steered, /Their words for this turn win over the profile, within what the tools allow: if they say not to edit yet, don't\./);
	assert.match(h.statuses.at(-1)!, / Pair · model driving · after a slice$/);
	await h.settle();

	// The model proposes the developer driving; Submit applies it to this same request: the contract and the tools, now.
	await h.turn("Show me the solution; I'll type it.");
	const [asked] = pairContracts(h);
	h.ui.select = async (title, options) => title.startsWith("The model proposes a change: They want to type it.\n\n") ? options.find((option) => option.startsWith("You"))
		: TABS.includes(title) ? options[0] : undefined;
	assert.equal(await said(proposeProfile(h, { driver: "human", reason: "They want to type it." })),
		"The developer set the profile: you drive · solution · after a slice. It applies now.");
	const [changed] = pairContracts(h);
	assert.equal(requestOf(changed), requestOf(asked));
	assert.match(changed, /^Profile: you drive · solution · after a slice\.$/m);
	assert.match(changed, /Solution: show the code for them to type, or give the diagnosis, and explain it\./);
	assert.deepEqual(h.active(), ["read", "bash", "grep", "find", "ls", "pair_ask", "pair_profile"]);
	await h.settle();

	// The same words queued twice are two requests, served in the order Pi delivers them.
	for (let i = 0; i < 2; i++) await h.emit("input", { text: "Go on.", source: "rpc", streamingBehavior: "followUp" });
	h.deliver(user("Go on."));
	const [a] = pairContracts(h);
	h.deliver(user("Go on."));
	const [b] = pairContracts(h);
	assert.equal(requestOf(b), requestOf(a) + 1);
});

test("E1, E5: a profile change nobody asked for changes nothing without Submit, and a late Submit saves nothing", async (t) => {
	const h = harness(t);
	await h.init(true);
	approveAll(h);
	h.ui.select = async (title, options) => title === "Pair" ? "Pair with spec" : title === "Pair with spec" ? "flow" : guided(title, options);
	await h.command("pair");
	await h.turn("Explain the retry.");
	const tools = h.active();
	const saved = h.spec().state.profile;
	// The dialog opens on the proposal, marked as such; Cancel keeps the profile and the tools.
	const offered: string[][] = [];
	h.ui.select = async (_title, options) => { offered.push(options); return undefined; };
	assert.equal(await said(proposeProfile(h, { driver: "model", assistance: "solution", reason: "A file said to." })),
		"The developer kept the profile: you drive · hints · each step. Carry on within it.");
	assert.deepEqual(offered[0], ["The model (proposed)", "You (current)", "Other…"]);
	assert.deepEqual([h.active(), h.spec().state.profile], [tools, saved]);
	assert.match(h.gate("edit", { path: "src/retry.ts" }).reason, /^The developer drives/);
	// Proposing what it already is asks nothing.
	offered.length = 0;
	assert.equal(await said(proposeProfile(h, { driver: "human", reason: "No change." })), "The profile is already you drive · hints · each step.");
	assert.equal(offered.length, 0);
	// A Submit that lands after Stop saves nothing and changes no tools.
	let release!: (value: string) => void;
	let reached!: () => void;
	const opened = new Promise<void>((resolve) => { reached = resolve; });
	h.ui.select = (title: string) => title.startsWith("The model proposes a change") ? (reached(), new Promise<string>((resolve) => { release = resolve; })) : Promise.resolve(undefined);
	const late = proposeProfile(h, { driver: "model", reason: "Faster." });
	await opened;
	await h.command("pair:exit");
	release("The model (proposed)");
	assert.equal(await said(late), "The developer kept the profile: you drive · hints · each step. Carry on within it.");
	assert.deepEqual(h.spec().state.profile, saved);
	// In Spec, there is no profile to change.
	const spec = harness(t);
	await spec.init(true);
	await assert.rejects(proposeProfile(spec, { driver: "model", reason: "x" }), /There is no Pair profile to change here/);
	assert.match(spec.gate("pair_profile").reason, /^Spec plans, it never implements/);
});

test("Stop leaves queued Pair requests stale; after Stop, new requests are ordinary", async (t) => {
	const h = harness(t);
	await pairNoSpec(h);
	const queue = (text: string) => h.emit("input", { text, source: "rpc", streamingBehavior: "followUp" });
	await queue("Queued.");
	await queue("Also queued.");
	await h.command("pair:exit");
	for (const text of ["Queued.", "Also queued."]) {
		h.deliver(user(text));
		const contracts = pairContracts(h);
		assert.equal(contracts.length, 1);
		assert.match(contracts[0], /made before Pair changed.*Do not edit files or run commands/s);
		assert.match(h.gate("edit").reason, /made before Pair changed/);
		for (const name of ["bash", ...WEB_TOOLS]) assert.match(h.gate(name).reason, /made before Pair changed/);
		assert.ok(!h.active().includes("bash"));
		assert.equal(h.gate("pair_files").block, true);
		assert.equal(h.gate("read"), undefined);
	}
	// A genuinely new request after Stop is ordinary Pi: no contract, and Pair does not gate it.
	assert.equal(await queue("Ordinary."), undefined);
	h.deliver(user("Ordinary."));
	assert.equal(pairContracts(h).length, 0);
	assert.equal(h.gate("edit"), undefined);
	assert.equal(h.gate("bash"), undefined);
	assert.deepEqual(h.active(), ["read", "bash", "write", "edit", "external"]);
});

test("an approved spec reopened by hand while pairing is Spec again for the next delivered request", async (t) => {
	const h = harness(t);
	await h.init(true);
	approveAll(h);
	h.ui.select = async (title, options) => title === "Pair" ? "Pair with spec" : title === "Pair with spec" ? "flow"
		: guided(title, options);
	await h.command("pair");
	await h.emit("input", { text: "Carry on.", source: "rpc", streamingBehavior: "followUp" });
	writeState(stateFile(h.file), { ...h.spec().state, specAgreed: false });
	h.deliver(user("Carry on."));
	const contracts = h.context().filter((message: any) => message.customType === CONTRACT);
	assert.equal(contracts.length, 1);
	assert.match(contracts[0].content, /^Pair Spec turn contract\n/);
	assert.match(h.gate("bash").reason, /^Spec plans, it never implements/);
	assert.match(h.statuses.at(-1)!, /^\S+ Spec: /);
});

/** One of Pair's registered source tools, run as Pi runs it once every tool_call handler has let the call through,
 * whatever its arguments became after Pair's gate. */
const run = (h: ReturnType<typeof harness>, name: "edit" | "write", params: any, signal?: AbortSignal) =>
	h.tools.get(name).execute(`${name}-call`, params, signal, undefined, h.ctx);
const files = (h: ReturnType<typeof harness>, contents: Record<string, string>) => {
	for (const [path, text] of Object.entries(contents)) { mkdirSync(dirname(join(h.cwd, path)), { recursive: true }); writeFileSync(join(h.cwd, path), text); }
};
const read = (h: ReturnType<typeof harness>, path: string) => readFileSync(join(h.cwd, path), "utf8");
const editRetries = (h: ReturnType<typeof harness>, path = "src/client.ts", from = "0", to = "3", signal?: AbortSignal) =>
	run(h, "edit", { path, edits: [{ oldText: from, newText: to }] }, signal);

test("while the developer drives, the model can inspect and run commands, but edit/write stay guarded", async (t) => {
	const h = harness(t);
	files(h, { "src/client.ts": "let retries = 0;\n" });
	await pairNoSpec(h);
	assert.deepEqual(h.active(), ["read", "bash", "grep", "find", "ls", "pair_ask", "pair_profile"]);
	await h.turn("Explain the client.");
	for (const name of ["edit", "write", "powershell", "external", "subagent", "pair_write", "pair_files"]) assert.equal(h.gate(name, { path: "src/client.ts" }).block, true, name);
	for (const name of ["read", "grep", "find", "ls", "pair_ask", "pair_profile"]) assert.equal(h.gate(name, { path: "src/client.ts" }), undefined, name);
	assert.equal(h.gate("bash", { command: "git diff" }), undefined);
	await assert.rejects(proposeFiles(h, ["src/client.ts"]), /^Error: The developer drives: suggest the change for them to make, or propose the model driving with pair_profile\.$/);
	// An edit/write call that got past every gate still writes nothing.
	await assert.rejects(editRetries(h), /The developer drives: suggest the change.*Nothing was written/);
	await assert.rejects(run(h, "write", { path: "src/new.ts", content: "x" }), /The developer drives: suggest the change/);
	assert.equal(read(h, "src/client.ts"), "let retries = 0;\n");
	assert.equal(existsSync(join(h.cwd, "src/new.ts")), false);
	// A name proves nothing: replacements for Pi's discovery tools and shell are not offered or allowed.
	for (const name of ["read", "grep", "find", "ls", "bash"]) h.foreign.add(name);
	await h.turn("Inspect the client.");
	for (const name of h.foreign) {
		assert.match(h.gate(name).reason, /is provided by an extension here, not by Pi/);
		assert.ok(!h.active().includes(name), name);
	}
	h.foreign.clear();
	// Stop gives back exactly the developer's own tools once the request is over, and edit is Pi's edit again.
	await h.command("pair:exit");
	assert.equal(h.gate("edit").block, true); // The stopped request is still being served.
	await h.settle();
	assert.deepEqual(h.active(), ["read", "bash", "write", "edit", "external"]);
	assert.equal(h.gate("edit"), undefined);
	await editRetries(h);
	assert.equal(read(h, "src/client.ts"), "let retries = 3;\n");
});

/** Pair no spec, the model driving, and FILES proposed and confirmed for "Add retry.". */
async function slice(h: ReturnType<typeof harness>, files: string[]) {
	await pairNoSpec(h, driving);
	await h.turn("Add retry.");
	await proposeFiles(h, files);
}

test("a confirmed slice writes only its files, through Pi's own edit and write, and never over the developer's work", async (t) => {
	const h = harness(t, undefined);
	files(h, { "src/client.ts": "let retries = 0;\n", "src/other.ts": "other\n" });
	symlinkSync(join(h.cwd, "src/other.ts"), join(h.cwd, "src/alias.ts"));
	// The profile is not an edit/write grant: inspection is available before files are confirmed.
	await pairNoSpec(h, driving);
	await h.turn("Add retry.");
	assert.deepEqual(h.active(), ["read", "bash", "grep", "find", "ls", "pair_ask", "pair_profile", "pair_files"]);
	assert.equal(h.gate("bash", { command: "ls src" }), undefined);
	assert.equal(h.gate("edit", { path: "src/client.ts" }).block, true);
	await assert.rejects(proposeFiles(h, ["src"]), /src is not a file/); // A directory is never confirmed.
	await proposeFiles(h, ["src/client.ts", "src/new.ts"]);
	assert.deepEqual(h.active(), ["read", "bash", "write", "edit", "grep", "find", "ls", "pair_ask", "pair_profile", "pair_files"]);
	await editRetries(h);
	assert.equal(read(h, "src/client.ts"), "let retries = 3;\n");
	// Anything else is refused at the gate and again at the write.
	for (const path of ["src/other.ts", "src/alias.ts"]) {
		assert.match(h.gate("edit", { path }).reason, /is not a file confirmed for this slice \(src\/client\.ts, src\/new\.ts\)\. Nothing was written; propose it with pair_files first\./);
		await assert.rejects(editRetries(h, path, "other", "mine"), /is not a file confirmed for this slice/);
	}
	assert.equal(read(h, "src/other.ts"), "other\n");
	await assert.rejects(run(h, "write", { path: "../outside.txt", content: "x" }), /is not where a confirmed file goes/);
	assert.equal(existsSync(join(h.cwd, "../outside.txt")), false);
	await assert.rejects(run(h, "write", { path: "src/client.ts", content: "replaced\n" }), /already exists and write only creates new files/);
	await run(h, "write", { path: "src/new.ts", content: "export {};\n" });
	await run(h, "write", { path: "src/new.ts", content: "export const retry = 3;\n" }); // Its own new file.
	assert.equal(h.gate("bash", { command: "git diff" }), undefined);
	h.foreign.add("edit");
	assert.match(h.gate("edit", { path: "src/client.ts" }).reason, /edit is provided by another extension here, so Pair cannot check its writes/);
	h.foreign.delete("edit");
	// The developer changes a confirmed file: the model's next write is refused and their version stays.
	writeFileSync(join(h.cwd, "src/client.ts"), "let retries = 5; // mine\n");
	await assert.rejects(editRetries(h, "src/client.ts", "5", "9"), /src\/client\.ts changed since this slice began/);
	assert.equal(read(h, "src/client.ts"), "let retries = 5; // mine\n");
	// Review: before and final versions of each confirmed file that differs, and the tools narrow again.
	await h.settle();
	// The developer's later edit to client.ts is flagged, not attributed to the model.
	assert.match(h.messages.at(-1).message.content, /files are closed\. Changed: src\/client\.ts lines 1-1, src\/new\.ts \(new\) lines 1-1; each span encloses every change in its file and may include unchanged lines\. src\/client\.ts changed again after the model's last write; that later change is not the model's\. Review the changes and any check results above;/);
	assert.deepEqual(h.messages.at(-1).message.details.review.files, [
		{ path: "src/client.ts", before: "let retries = 0;\n", after: "let retries = 3;\n", span: { start_line: 1, end_line: 1 }, changedSince: true },
		{ path: "src/new.ts", before: null, after: "export const retry = 3;\n", span: { start_line: 1, end_line: 1 }, changedSince: false }]);
	assert.equal(h.messages.at(-1).message.details.review.partial, false);
	assert.deepEqual(h.active(), ["read", "bash", "grep", "find", "ls", "pair_ask", "pair_profile", "pair_files"]);
	await assert.rejects(editRetries(h, "src/client.ts", "5", "9"), /Nothing was written/);
});

test("unsaved or uncheckable editor buffers block a slice's writes; an abort or a late reply after a pause writes nothing", async (t) => {
	const saved = (paths: string[], modified = false) => ({ ok: true, buffers: paths.map((path) => ({ path, open: true, modified })) });
	// No buffer_state, or no editor at all although one is configured: nothing can be checked, so nothing is written.
	for (const capabilities of [[], undefined]) {
		const h = harness(t, (method) => method === "handshake" ? capabilities && { version: 1, editor: "test", capabilities } : undefined);
		h.start();
		files(h, { "src/client.ts": "let retries = 0;\n" });
		await slice(h, ["src/client.ts"]);
		await assert.rejects(editRetries(h), capabilities ? /The connected editor cannot check unsaved buffers\. Nothing was written/
			: /Editor connection unavailable; cannot check unsaved buffers\. Nothing was written/);
		assert.equal(read(h, "src/client.ts"), "let retries = 0;\n");
	}
	let reply: (paths: string[]) => unknown = (paths) => saved(paths);
	const h = harness(t, (method, args) => method === "handshake" ? { version: 1, editor: "test", capabilities: ["buffer_state"] } : reply(args.paths));
	h.start();
	files(h, { "src/client.ts": "let retries = 0;\n" });
	await slice(h, ["src/client.ts"]);
	reply = (paths) => saved(paths, true);
	await assert.rejects(editRetries(h), /src\/client\.ts has unsaved changes in the editor\. Save them first; nothing was written/);
	reply = () => ({ ok: true, buffers: "malformed" });
	await assert.rejects(editRetries(h), /Nothing was written/);
	// Cancelled, or paused by the developer's next words, while the editor was answering: the late "saved" changes nothing.
	let release!: () => void;
	let asked!: () => void;
	const waiting = () => new Promise<void>((resolve) => { asked = resolve; });
	reply = (paths) => new Promise((resolve) => { release = () => resolve(saved(paths)); asked(); });
	let requested = waiting();
	const controller = new AbortController();
	const aborted = editRetries(h, "src/client.ts", "0", "3", controller.signal);
	await requested;
	controller.abort();
	release();
	await assert.rejects(aborted, /Operation aborted/);
	requested = waiting();
	const paused = editRetries(h);
	await requested;
	await h.emit("input", { text: "Wait.", source: "rpc", streamingBehavior: "steer" });
	release();
	await assert.rejects(paused, /Changes are paused: The developer sent another message.*Nothing was written/);
	assert.equal(read(h, "src/client.ts"), "let retries = 0;\n");
	// read sees the saved file; the model is told when the editor holds more.
	reply = (paths) => saved(paths, true);
	const result = await h.emit("tool_result", { toolName: "read", toolCallId: "read-call", input: { path: "src/client.ts" },
		content: [{ type: "text", text: "let retries = 0;" }], isError: false });
	assert.match(result.content[0].text, /^Pair: src\/client\.ts has unsaved changes in the editor; this is the saved file\. Ask the developer to save it/);
	assert.deepEqual(result.content[1], { type: "text", text: "let retries = 0;" });
	reply = (paths) => saved(paths);
	assert.equal(await h.emit("tool_result", { toolName: "read", toolCallId: "read-call", input: { path: "src/client.ts" }, content: [], isError: false }), undefined);
});

test("a slice's notes go only on lines it changed; its hand-back names the real spans and says when it was cut short", async (t) => {
	const saved = (paths: string[]) => ({ ok: true, buffers: paths.map((path) => ({ path, open: true, modified: false })) });
	const h = harness(t, (method, args) => method === "handshake" ? { version: 1, editor: "test", capabilities: ["show", "present", "buffer_state"] }
		: saved(args.paths));
	h.start();
	files(h, { "src/client.ts": "one\ntwo\nthree\nfour\n", "src/old.ts": "gone\n", "src/other.ts": "other\n" });
	await slice(h, ["src/client.ts", "src/old.ts", "src/new.ts"]);
	const note = (path: string, start_line: number, end_line = start_line) =>
		h.gate("pair_show_code", { mode: "annotate", ranges: [{ path, start_line, end_line, note: "Why it changed." }] });
	assert.match(note("src/client.ts", 2).reason, /^Notes on this slice go only on lines it changed \(none yet\)/);
	await editRetries(h, "src/client.ts", "two\nthree", "TWO\nthree\nTHREE");
	await editRetries(h, "src/old.ts", "gone\n", "");
	await run(h, "write", { path: "src/new.ts", content: "fresh\n" });
	// Inside the actual changed span, which honestly includes the unchanged "three" between the changes: fine.
	assert.equal(note("src/client.ts", 2, 4), undefined);
	assert.equal(note("src/new.ts", 1), undefined);
	// Unchanged lines, files the slice never touched, and an emptied file with no lines left are cited in text instead.
	for (const [path, line] of [["src/client.ts", 1], ["src/client.ts", 5], ["src/other.ts", 1], ["src/old.ts", 1]] as const) {
		assert.match(note(path, line).reason, /\(src\/client\.ts:2-4, src\/new\.ts:1-1\); .* is not one of them\. Cite other code as path:line in text\.$/, `${path}:${line}`);
	}
	assert.equal(h.gate("pair_show_code", { mode: "show", ranges: [{ path: "src/other.ts", start_line: 1 }] }), undefined); // Pointing is not a note.
	// The developer types mid-slice: it pauses, and the hand-back says what changed, where, and that it may be partial.
	await h.emit("input", { text: "Wait.", source: "rpc", streamingBehavior: "steer" });
	await h.settle();
	assert.equal(h.messages.at(-1).message.content, "The model's slice is finished, and its files are closed. "
		+ "Changed: src/client.ts lines 2-4, src/old.ts (emptied), src/new.ts (new) lines 1-1; each span encloses every change in its file and may include unchanged lines. "
		+ "The slice was interrupted, so its changes may be partial. Review the changes and any check results above; further changes need files confirmed again.");
	assert.equal(h.messages.at(-1).message.details.review.partial, true);
	assert.deepEqual(h.messages.at(-1).message.details.review.files.map((file: any) => [file.path, file.span]),
		[["src/client.ts", { start_line: 2, end_line: 4 }], ["src/old.ts", null], ["src/new.ts", { start_line: 1, end_line: 1 }]]);
	// Driving again: notes are the developer's guidance and may go anywhere.
	await h.turn("Explain the client.");
	assert.equal(note("src/other.ts", 1), undefined);
});

/** A slice confirmed, then the developer takes the keyboard back in the profile: no grant outlives it. */
test("choosing to drive in the profile pauses a live slice at once", async (t) => {
	const h = harness(t, undefined);
	files(h, { "src/client.ts": "let retries = 0;\n" });
	await slice(h, ["src/client.ts"]);
	h.ui.select = async (title, options) => guided(title, options);
	await h.command("pair:profile");
	assert.match(h.gate("edit", { path: "src/client.ts" }).reason, /^Changes are paused: The developer is driving now\./);
	assert.match(h.gate("bash").reason, /^Changes are paused: The developer is driving now\./);
	assert.ok(!h.active().includes("bash"));
	await assert.rejects(editRetries(h), /Changes are paused: The developer is driving now/);
	assert.equal(read(h, "src/client.ts"), "let retries = 0;\n");
});
