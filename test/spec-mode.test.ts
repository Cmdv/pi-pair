import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import pair from "../src/index.ts";
import { classifierStub, readyClassifier } from "./classifier-stub.ts";
import { decision, type ClassifierFactory } from "../src/classifier.ts";
import { CONTRACT } from "../src/contracts.ts";
import { emptyState, stateFile, writeState } from "../src/state.ts";
import { loadSpec } from "../src/proposals.ts";

process.env.PI_PAIR_EDITOR = "test";
const SPEC = "# Scope\n\n## Goal\nStay up.\n\n## 1: Backoff\n### Task\nRetry.\n### Proposed solution\nDelay.\n### Done when\nChecked.\n\n## 2: Report\n### Task\nReport.\n### Proposed solution\nShow error.\n### Done when\nVisible.\n";
const SECTIONS = { Task: "Retry gently.", Research: "Read the client.", "Proposed solution": "Wait and retry.", "Edge cases": "- [ ] E1: Server never answers\n  - Expected: Give up.\n  - Check: Watch the log.", "Done when": "A check observes bounded retries." };

function harness(t: { after: (fn: () => void) => void }, editor?: (method: string, args: any) => unknown, factory: ClassifierFactory = readyClassifier) {
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
	let factoryCalls = 0;
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
	} as unknown as ExtensionAPI, async (options) => { factoryCalls++; return factory(options); });
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
	// Rows are unnumbered: the list is in task order, so task N is row N, and only the list answers.
	const choose = async (id = "1") => { ui.select = async (title, options) => title.startsWith("Spec tasks") ? options[Number(id) - 1] : undefined; await command("pair:tasks"); };
	return { cwd, file, ctx, ui, entries, messages, userMessages, notices, statuses, widgets, sessions, tools, history, asked, foreign, active: () => active,
		emit, deliver, turn, write, gate, context, command, choose, pick,
		hash: (id = "1") => loadSpec(file).parsed.tasks.find((task) => task.id === id)!.hash,
		spec: () => loadSpec(file), answers: (fn: typeof answer) => { answer = fn; },
		factoryCalls: () => factoryCalls, settle: () => emit("agent_settled"),
		start: () => emit("session_start"),
		init: async (tasks = false) => { await command("pair", "Flow"); if (tasks) { writeFileSync(file, SPEC); await choose(); } },
	};
}

const taskWrite = (h: ReturnType<typeof harness>, id = "1", sections: Record<string, string> = SECTIONS) =>
	({ kind: "task", id, baseHash: h.hash(id), sections });

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
		assert.equal(h.factoryCalls(), 0);
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

test("the start is linear: ask the problem, write the whole spec, open the filled file, show the list", async (t) => {
	const calls: string[] = [];
	const h = harness(t, (method, args) => {
		calls.push(method);
		return method === "handshake" ? { version: 1, editor: "test", capabilities: ["open", "buffer_state"] }
			: { ok: true, buffers: (args?.paths ?? []).map((path: string) => ({ path, open: false, modified: false })) };
	});
	h.start();
	await h.init();
	// Step 4: an empty spec is not worth looking at, so nothing is opened yet.
	assert.equal(calls.filter((name) => name === "open").length, 0);
	assert.match(h.messages.at(-1).message.content, /^What are you trying to solve\?$/);
	assert.equal(h.factoryCalls(), 0); // Nothing linear needs the classifier.

	const original = "Original CAPS, punctuation?!";
	const prompt = await h.turn(original);
	assert.equal(h.factoryCalls(), 0);
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

	// Step 8: the file opens filled, and the task list follows, once the model has finished.
	let offered: string[] = [];
	h.ui.select = async (_title, options) => { offered = options; return undefined; };
	await h.settle();
	assert.equal(calls.filter((name) => name === "open").length, 1);
	assert.deepEqual(offered, ["Backoff · written · 1 open", "Report · written · 1 open", "+ New task", "Describe changes…", "Cancel"]);
	assert.equal(h.widgets.at(-1)?.length, 1); // One line of shortcuts, never two.
	assert.deepEqual(h.widgets.at(-1), ["/pair:tasks Tasks · /pair:exit Exit Pair"]);
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
	assert.equal(h.gate("pair_write", { kind: "task", id: "2" }).block, true);
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
		assert.equal(h.factoryCalls(), 0);
		if (partial) {
			assert.equal(h.spec().view.agreed, 0);
			assert.match(h.messages.at(-1).message.content, /1 still open/);
			assert.match(menu![0], /^Task 1: Backoff/);
			assert.equal(menu![1][0], "Answer 1 open question");
		} else {
			assert.equal(h.spec().state.tasks["1"].agreedHash, h.hash("1"));
			assert.match(h.messages.at(-1).message.content, /^Task 1: Backoff approved\.$/);
			assert.deepEqual(menu![1], ["Backoff · agreed", "Report · written", "+ New task", "Describe changes…", "Approve spec", "Cancel"]);
		}
	}
});

test("typed changes are user messages, skip triage, and return to the task or list after the turn", async (t) => {
	const h = harness(t);
	await h.init(true);
	for (const selected of [true, false]) {
		h.ui.select = async (title, options) => title.startsWith("Spec tasks") && selected ? options[0] : "Describe changes…";
		h.answers(() => "make the delay longer");
		await h.command("pair:tasks");
		assert.equal(h.userMessages.at(-1), "make the delay longer");
		const prompt = await h.turn(h.userMessages.at(-1)!, "extension");
		assert.equal(h.factoryCalls(), 0);
		assert.match(prompt.message.content, /"developerWants": "edit"/);
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
	assert.deepEqual(offered, ["Backoff · agreed", "Report · written", "+ New task", "Describe changes…", "Approve spec", "Cancel"]);
	assert.deepEqual(h.widgets.at(-1), ["/pair:approve Approve spec · /pair:tasks Tasks · /pair:exit Exit Pair"]);

	// Step 13 again, from the review dialog this time: 2 has no questions, so Agree is right there.
	const titles: string[] = [];
	h.ui.select = async (title, options) => {
		titles.push(title); offered = options;
		return options.find((option) => option.startsWith("Report")) ?? (options.includes("Agree") ? "Agree" : undefined);
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
	assert.deepEqual(h.widgets.at(-1), ["/pair:tasks Tasks · /pair:settings Settings · /pair:exit Exit Pair"]);
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

test("review messages are triaged: the scope widens the turn, and the list is reachable from anywhere", async (t) => {
	const h = harness(t, undefined, classifierStub({ scope: "this_task", operation: "edit" }));
	await h.init(true);
	// A message about the selected task keeps the turn inside it.
	assert.match((await h.turn("make the delay longer")).message.content, /"write": "task"/);
	assert.equal(h.factoryCalls(), 1);
	assert.equal(h.gate("pair_write", { kind: "task", id: "2" }).block, true);
	assert.equal(h.gate("pair_write", taskWrite(h)), undefined);

	// Asking about another task widens the turn; the model resolves which one, and the selection is unchanged.
	const other = harness(t, undefined, classifierStub({ scope: "other_task", operation: "add" }));
	await other.init(true);
	const prompt = await other.turn("add an edge case to the reporting task");
	assert.match(prompt.message.content, /"write": "any"/);
	assert.match(prompt.message.content, /"developerWants": "add"/);
	assert.equal(other.gate("pair_write", taskWrite(other, "2", { Task: "Report clearly." })), undefined);
	assert.equal(other.statuses.at(-1), "🧑‍🤝‍🧑 Spec: 1/2");

	// Goal and new-task requests may write the list, never a task's content.
	const goal = harness(t, undefined, classifierStub({ scope: "goal", operation: "edit" }));
	await goal.init(true);
	assert.match((await goal.turn("the goal should mention latency")).message.content, /"write": "tasks"/);
	assert.equal(goal.gate("pair_write", { kind: "tasks", goal: "Stay up and stay fast." }), undefined);
	assert.equal(goal.gate("pair_write", taskWrite(goal)).block, true);

	// Going back to the list is navigation: code handles it, and the model is never called.
	const list = harness(t, undefined, classifierStub({ scope: "task_list" }));
	await list.init(true);
	let offered: string[] = [];
	list.ui.select = async (_title, options) => { offered = options; return undefined; };
	assert.deepEqual(await list.emit("input", { text: "take me back to the tasks", source: "rpc" }), { action: "handled" });
	assert.deepEqual(offered, ["Backoff · written", "Report · written", "+ New task", "Describe changes…", "Cancel"]);
	assert.equal(list.statuses.at(-1), "🧑‍🤝‍🧑 Spec: flow");
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
	// The tool refuses out-of-scope payloads even if the gate is never consulted.
	await assert.rejects(h.write({ kind: "tasks", names: ["Sneaked in"] }), /Outside this turn's scope: it may write task 1 only/);
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

test("without the local triage model, messages reach the model unchanged and nothing else breaks", async (t) => {
	const h = harness(t, undefined, async () => { throw new Error("ONNX Runtime is unavailable"); });
	await h.init(true);
	assert.equal(await h.emit("input", { text: "make the delay longer", source: "rpc" }), undefined);
	assert.match(h.notices.at(-1)!, /Local triage model unavailable.*ONNX Runtime is unavailable/);
	assert.match((await h.turn("make the delay longer")).message.content, /"write": "task"/);
	assert.equal(h.factoryCalls(), 1); // Tried once, then left alone.
	assert.equal(h.notices.length, 1);
	assert.equal(h.gate("read"), undefined);
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
	assert.deepEqual(h.widgets.at(-1), ["/pair:tasks Tasks · /pair:settings Settings · /pair:exit Exit Pair"]);
	// Pair with a spec attached: no turn contract, nothing blocked, and the plan in the system prompt.
	const prompt = await h.turn("let's start");
	assert.equal(prompt.message, undefined);
	assert.match(prompt.systemPrompt, /^base\n\nPair is on with the approved spec .*flow\.md; it is the plan.*\nGoal: Stay up\.\nOrder: 1 before 2: the report needs the retry in place\.\nTasks:\n1: Backoff · next\n2: Report\n/s);
	// No Spec contract: one Pair request contract, with the developer driving by default.
	const contracts = h.context().filter((message: any) => message.customType === CONTRACT);
	assert.equal(contracts.length, 1);
	assert.match(contracts[0].content, /^Pair request contract\n[\s\S]*"developerSaid": "let's start"[\s\S]*"driver": "human"/);
	assert.match(h.gate("bash").reason, /^While pairing the model reads, asks and shows code; bash is not available/);
	assert.equal(h.gate("read", { path: ".pi/pi-pair/specs/flow.md" }), undefined); // The plan is read, now that it is the plan.
	await assert.rejects(h.write(taskWrite(h, "1")), /it may write nothing/);
	await h.command("pair:approve");
	assert.match(h.notices.at(-1)!, /The spec is approved, and Pair is working on it/);
	// The list is the plan as progress now, and reads apart from the Spec list; done takes the developer back to it.
	const titles: string[] = [];
	const offered: string[][] = [];
	h.ui.select = async (title, options) => {
		titles.push(title); offered.push(options);
		return title.startsWith("Pair tasks") ? options.find((option) => option.startsWith("Backoff")) : options.find((option) => option === "Mark task as done");
	};
	await h.command("pair:tasks");
	assert.deepEqual(titles, ["Pair tasks · flow", "Task 1: Backoff", "Pair tasks · flow", "Task 1: Backoff · done"]);
	assert.deepEqual(offered, [["Backoff · next", "Report", "Cancel"], ["Implement task", "Implement task + prompt", "Mark task as done", "Cancel"],
		["Backoff · done", "Report · next", "Cancel"], ["Reset task", "Go back"]]);
	assert.deepEqual([h.spec().view.completed, h.spec().state.tasks["1"].completedHash], [1, h.hash("1")]);
	assert.equal(h.messages.at(-1).message.content, "Task 1: Backoff done. Next: task 2: Report.");
	assert.equal(h.messages.at(-1).message.details.badge, "Pair");
	assert.equal(h.statuses.at(-1), "🧑‍🤝‍🧑 Pair: flow · 2/2 · you drive · hints");
	// Marked by mistake: a reset keeps the agreement, drops the completion, and returns to the list.
	let visits = 0;
	h.ui.select = async (title) => title.startsWith("Pair tasks") ? (visits++ ? "Cancel" : "Backoff · done") : "Reset task";
	await h.command("pair:tasks");
	assert.equal(visits, 2);
	assert.deepEqual([h.spec().view.completed, h.spec().state.tasks["1"]], [0, { agreedHash: h.hash("1"), completedHash: null }]);
	assert.equal(h.messages.at(-1).message.content, "Task 1: Backoff is no longer done.");
	assert.equal(h.statuses.at(-1), "🧑‍🤝‍🧑 Pair: flow · 1/2 · you drive · hints");
	// Implement hands the task to the model in this session, with the developer's note when they add one.
	h.ui.select = async (title, options) => title.startsWith("Pair tasks") ? options.find((option) => option.startsWith("Report")) : "Implement task + prompt";
	h.answers(() => "Start with the error path.");
	await h.command("pair:tasks");
	assert.equal(h.asked.at(-1), "Task 2: Report");
	assert.equal(h.messages.at(-1).message.content, "Pair on task 2: Report from .pi/pi-pair/specs/flow.md. Read the task first: the spec is the plan, and its discussion is already settled there.\n\nStart with the error path.");
	assert.equal(h.messages.at(-1).options.triggerTurn, true);
	assert.equal(h.statuses.at(-1), "🧑‍🤝‍🧑 Pair: flow · 2/2 · you drive · hints"); // The task being implemented is the current one.
	assert.match((await h.turn("go on")).systemPrompt, /Tasks:\n1: Backoff\n2: Report · next\n/);
	h.ui.select = async (title, options) => title.startsWith("Pair tasks") ? options.find((option) => option.startsWith("Report")) : "Implement task";
	await h.command("pair:tasks");
	assert.equal(h.messages.at(-1).message.content, "Pair on task 2: Report from .pi/pi-pair/specs/flow.md. Read the task first: the spec is the plan, and its discussion is already settled there.");
	// Done, task by task, until the list has nothing left to pick.
	h.ui.select = async (title, options) => title.startsWith("Pair tasks") ? options.find((option) => !option.endsWith("· done") && option !== "Cancel") : "Mark task as done";
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
	assert.deepEqual([titles, offered[1]], [["Pair", "Pair with spec", "Pair settings · now Guide me (default): you drive · hints · check in each step", "Pair tasks · flow"], ["flow"]]);
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
const lastSettings = (h: ReturnType<typeof harness>) => h.entries.findLast((entry) => entry.customType === "pi-pair")?.data.settings;
const DEFAULT_TITLE = "Pair settings · now Guide me (default): you drive · hints · check in each step";

test("Pair no spec asks how to pair in code; a cancelled choice stays an unconfirmed Guide me", async (t) => {
	const h = harness(t);
	const titles: string[] = [];
	h.ui.select = async (title) => { titles.push(title); return title === "Pair" ? "Pair no spec" : undefined; };
	await h.command("pair");
	assert.deepEqual(titles, ["Pair", DEFAULT_TITLE]);
	assert.match(h.statuses.at(-1)!, / Pair · you drive · hints$/);
	assert.deepEqual(h.widgets.at(-1), ["/pair:settings Settings · /pair:exit Exit Pair"]);
	assert.equal(lastSettings(h), undefined);
	// Still unconfirmed, so it is asked again; Drive and review is a preference, and the developer still drives.
	h.ui.select = async (title, options) => title === "Pair" ? "Pair no spec" : options.find((option) => option.startsWith("Drive and review"));
	await h.command("pair");
	assert.match(h.statuses.at(-1)!, / Pair · you drive · model preferred · solution$/);
	assert.match(h.messages.at(-1).message.content, /^Pair settings: Drive and review, .*The model edits only a slice you confirm/);
	assert.deepEqual(lastSettings(h), { driver: "model", assistance: "solution", checkpoint: "after_slice" });
	titles.length = 0;
	h.ui.select = async (title) => { titles.push(title); return title === "Pair" ? "Pair no spec" : undefined; };
	await h.command("pair");
	assert.deepEqual(titles, ["Pair"]); // Confirmed, so not asked again.
	assert.equal(h.factoryCalls(), 0);
	assert.equal(h.messages.some((message) => message.options?.triggerTurn), false);
});

test("settings change one at a time, follow the work and /pair:next, and resume only from the active branch", async (t) => {
	const h = harness(t);
	await h.init(true);
	approveAll(h);
	h.ui.select = async (title, options) => title === "Pair" ? "Pair with spec" : title === "Pair with spec" ? "flow"
		: title.startsWith("Pair settings") ? options.find((option) => option.startsWith("Build together")) : undefined;
	await h.command("pair");
	assert.match(h.statuses.at(-1)!, /Pair: flow · 1\/2 · you drive · examples$/);
	assert.deepEqual(lastSettings(h), { driver: "human", assistance: "examples", checkpoint: "each_step" });
	assert.equal(h.messages.at(-1).message.content, "Pair settings: Build together, you drive · examples · check in each step.");

	// More help without handing over the keyboard.
	const solo = { driver: "human", assistance: "solution", checkpoint: "after_slice" };
	const answers: Record<string, string> = { "Who drives by default?": "You drive", "How much help?": "Solution", "When does Pair check in?": "After a slice" };
	h.ui.select = async (title) => title.startsWith("Pair settings") ? "Adjust driver, help and check-ins…" : answers[title];
	await h.command("pair:settings");
	assert.deepEqual(lastSettings(h), solo);
	assert.match(h.statuses.at(-1)!, / you drive · solution$/);
	// Cancelling at any step changes nothing.
	for (const stop of ["Pair settings", "Who drives", "How much help", "When does"]) {
		h.ui.select = async (title, options) => title.startsWith(stop) ? undefined
			: title.startsWith("Pair settings") ? "Adjust driver, help and check-ins…" : options.at(-1);
		await h.command("pair:settings");
		assert.deepEqual(lastSettings(h), solo, stop);
	}

	// A task change and /pair:next keep the preferences.
	h.ui.select = async (title, options) => title.startsWith("Pair tasks") ? options.find((option) => option.startsWith("Report")) : "Implement task";
	await h.command("pair:tasks");
	assert.deepEqual(h.entries.findLast((entry) => entry.customType === "pi-pair").data, { pair: true, spec: "flow", selection: "2", settings: solo });
	await h.command("pair:next");
	const kept: any[] = [];
	await h.sessions[0].setup({ appendCustomEntry: (_type: string, data: any) => kept.push(data) });
	assert.deepEqual(kept, [{ pair: true, spec: "flow", selection: "2", settings: solo }]);

	// Resume reads the active branch: a branch from before the choice has none, and malformed settings are none.
	const sessionManager = h.ctx.sessionManager as any;
	const first = h.entries.findIndex((entry) => entry.data?.settings);
	sessionManager.getBranch = () => h.entries.slice(0, first);
	h.emit("session_tree");
	assert.match(h.statuses.at(-1)!, / you drive · hints$/);
	sessionManager.getBranch = () => h.entries;
	h.emit("session_tree");
	assert.match(h.statuses.at(-1)!, / you drive · solution$/);
	h.entries.push({ type: "custom", customType: "pi-pair", data: { pair: true, spec: "flow", settings: { driver: "model", assistance: "everything", checkpoint: "after_slice" } } });
	h.emit("session_tree");
	assert.match(h.statuses.at(-1)!, / you drive · hints$/);
});

test("a model slice needs confirmed files, grants nothing when cancelled or stale, is never saved and hands back at review", async (t) => {
	const h = harness(t);
	await h.init(true);
	approveAll(h);
	h.ui.select = async (title, options) => title === "Pair" ? "Pair with spec" : title === "Pair with spec" ? "flow"
		: title.startsWith("Pair settings") ? options.find((option) => option.startsWith("Drive and review")) : undefined;
	await h.command("pair");
	const preferring = / Pair: flow · 1\/2 · you drive · model preferred · solution$/;
	assert.match(h.statuses.at(-1)!, preferring);
	const turns = () => h.messages.filter((message) => message.options?.triggerTurn).length;
	const handoffs: string[] = [];
	const start = (confirm: (string | undefined)[], files: string[] = []) => {
		const toType = [...files];
		h.ui.select = async (title, options) => title.startsWith("Pair tasks") ? options.find((option) => option.startsWith("Backoff"))
			: title === "Task 1: Backoff" ? "Implement task"
			: title.startsWith("Choose files") ? typeFiles(() => toType.length)(options)
			: (handoffs.push(title), confirm.shift());
		h.answers(() => toType.shift());
		return h.command("pair:tasks");
	};

	await start(["Cancel"]);
	assert.equal(turns(), 0);
	assert.match(h.statuses.at(-1)!, preferring);

	// Confirm needs files; invalid ones are refused; adjusting files only brings the summary back.
	handoffs.length = 0;
	await start(["Confirm", "Choose files…", "Confirm"],
		["../outside.ts", ".pi/pi-pair/specs/flow.md", "src/retry.ts, src/retry.ts test/retry.test.ts"]);
	assert.equal(handoffs.length, 3);
	assert.equal(handoffs[0], "Hand task 1: Backoff to the model?\nDriver: the model for this slice, then you again at review · Help: solution · Check-in: after a slice\n"
		+ "Behaviour: Retry.\nFiles: none yet; Choose files to pick them");
	assert.match(handoffs[2], /\nFiles: src\/retry\.ts, test\/retry\.test\.ts$/);
	assert.deepEqual(h.notices.slice(-3), ["Choose the files the model may change before confirming.",
		"../outside.ts is not a project file the model may change.", ".pi/pi-pair/specs/flow.md is not a project file the model may change."]);
	assert.equal(turns(), 1);
	assert.match(h.messages.at(-1).message.content, /^Implement task 1: Backoff .*\n\nConfirmed slice: change only src\/retry\.ts, test\/retry\.test\.ts\. Stop when this slice is done/s);
	assert.match(h.statuses.at(-1)!, / model driving this slice · solution$/);
	assert.equal(h.entries.some((entry) => entry.customType === "pi-pair" && JSON.stringify(entry.data).includes("retry")), false);

	// The review boundary: the turn settles once, and the developer drives again until the next request.
	await h.settle();
	assert.match(h.statuses.at(-1)!, / you drive · model preferred · solution · review$/);
	assert.match(h.messages.at(-1).message.content, /^The model's slice of task 1: Backoff is finished, and you are driving again\./);
	await h.turn("What changed?");
	assert.match(h.statuses.at(-1)!, preferring);
	await h.settle();
	assert.equal(h.messages.filter((message) => /driving again/.test(message.message.content)).length, 1);

	// Resuming never brings a slice back, even mid-turn.
	await start(["Choose files…", "Confirm"], ["src/retry.ts"]);
	assert.match(h.statuses.at(-1)!, / model driving this slice /);
	h.emit("session_tree");
	assert.match(h.statuses.at(-1)!, preferring);
	await h.settle();
	// The slice is not restored, but what it did before the change is still reported for review: here, nothing.
	assert.equal(h.messages.filter((message) => /driving again/.test(message.message.content)).length, 2);
	assert.match(h.messages.at(-1).message.content, /driving again\. No files changed\./);

	// A Confirm that lands after Stop grants nothing.
	const count = turns();
	let release!: (value: string) => void;
	let reached!: () => void;
	const asked = new Promise<void>((resolve) => { reached = resolve; });
	let step = 0;
	const toType = ["src/retry.ts"];
	h.ui.select = async (title, options) => title.startsWith("Pair tasks") ? options.find((option) => option.startsWith("Backoff"))
		: title === "Task 1: Backoff" ? "Implement task"
		: title.startsWith("Choose files") ? typeFiles(() => toType.length)(options)
		: step++ === 0 ? "Choose files…" : (reached(), new Promise<string>((resolve) => { release = resolve; }));
	h.answers(() => toType.shift());
	const pending = h.command("pair:tasks");
	await asked;
	await h.command("pair:exit");
	release("Confirm");
	await pending;
	assert.equal(turns(), count);
	assert.equal(h.statuses.at(-1), undefined);
});

/** Each message's labels by schema name; "?" is a low-confidence answer, and anything not listed gets the quiet first label. */
const scripted = (answers: Record<string, Record<string, string>>, hold?: (text: string) => Promise<void> | undefined): ClassifierFactory => async () => ({
	classify: async (text: string, schema: any) => {
		await hold?.(text);
		const labels = Object.keys(schema.labels);
		const choice = answers[text]?.[schema.name] ?? labels[0];
		return { ...decision(labels.map((label) => choice !== "?" && label === choice ? 10 : 0), labels), tokens: 1, ms: 0 };
	},
	dispose: async () => {},
});
const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 0 });
/** The Pair contracts on one model call, parsed. */
const pairContracts = (h: ReturnType<typeof harness>) => h.context().filter((message: any) => message.customType === CONTRACT)
	.map((message: any) => JSON.parse(message.content.slice(message.content.indexOf("{"), message.content.lastIndexOf("}") + 1)));
/** Drive the file browser: while paths remain to type, pick "Type a path\u2026"; once none remain, save with C-c C-c. */
const typeFiles = (remaining: () => number) => (options: string[]) =>
	remaining() > 0 ? options.find((o) => o.startsWith("Type")) : "\x06";
const pairNoSpec = async (h: ReturnType<typeof harness>, preset = "Guide me") => {
	h.ui.select = async (title, options) => title === "Pair" ? "Pair no spec" : options.find((option) => option.startsWith(preset));
	await h.command("pair");
};

test("each Pair request is resolved once and served with one fresh contract; a slice is its own, and new words pause it", async (t) => {
	const h = harness(t, undefined, scripted({
		"Add retry to the client.": { pair_request: "implement" },
		"Wait, I'll write the rest myself.": { pair_request: "implement", pair_driver: "human" },
		"Show the solution, but I will type it.": { pair_request: "implement", pair_driver: "human", pair_help: "solution" },
	}));
	await pairNoSpec(h, "Drive and review");
	const titles: string[] = [];
	const choices = ["Choose files…", "Confirm"];
	const toType = ["src/client.ts"];
	h.ui.select = async (title, options) => title.startsWith("Choose files") ? typeFiles(() => toType.length)(options)
		: (titles.push(title), choices.shift());
	h.answers(() => toType.shift());
	await h.turn("Add retry to the client.");
	// No spec: the developer's words are the behaviour, and the files are theirs to name.
	assert.match(titles[0], /^Hand this request to the model\?\n.*\nBehaviour: Add retry to the client\.\nFiles: none yet/s);
	const [slice] = pairContracts(h);
	assert.deepEqual([slice.driver, slice.files, slice.developerSaid, slice.developerWants], ["model", ["src/client.ts"], "Add retry to the client.", "implement"]);
	// A tool continuation is another model call for the same request: still exactly one contract, the same one.
	assert.deepEqual(pairContracts(h).map((contract: any) => contract.request), [slice.request]);
	assert.match(h.statuses.at(-1)!, / model driving this slice · solution$/);

	// New words pause the slice before they are even classified, and the next request inherits nothing.
	const steer = h.emit("input", { text: "Wait, I'll write the rest myself.", source: "rpc", streamingBehavior: "steer" });
	assert.match(h.gate("edit").reason, /^Changes are paused: The developer sent another message/);
	await steer;
	h.deliver(user("Wait, I'll write the rest myself."));
	const [steered] = pairContracts(h);
	assert.deepEqual([steered.driver, steered.files, steered.developerSaid], ["human", undefined, "Wait, I'll write the rest myself."]);
	assert.equal(titles.length, 2); // No slice offered for it.

	// E1: the solution, typed by the developer, for this request only; the default is untouched.
	await h.turn("Show the solution, but I will type it.");
	const [solution] = pairContracts(h);
	assert.deepEqual([solution.driver, solution.assistance, solution.defaults.assistance], ["human", "solution", "solution"]);
	assert.equal(titles.length, 2);
	await h.settle();

	// The same words queued twice are two requests, served in the order Pi delivers them.
	for (let i = 0; i < 2; i++) await h.emit("input", { text: "Go on.", source: "rpc", streamingBehavior: "followUp" });
	h.deliver(user("Go on."));
	const [first] = pairContracts(h);
	h.deliver(user("Go on."));
	const [second] = pairContracts(h);
	assert.equal(second.request, first.request + 1);
});

test("Stop or a settings change leaves queued Pair requests stale, even when classification lands late; after Stop, new requests are ordinary", async (t) => {
	let release!: () => void;
	const late = new Promise<void>((resolve) => { release = resolve; });
	const h = harness(t, undefined, scripted({ "Late.": { pair_request: "implement" } }, (text) => text === "Late." ? late : undefined));
	await pairNoSpec(h);
	const queue = (text: string) => h.emit("input", { text, source: "rpc", streamingBehavior: "followUp" });
	await queue("Queued.");
	const slow = queue("Late.");
	await h.command("pair:exit");
	release();
	await slow;
	for (const text of ["Queued.", "Late."]) {
		h.deliver(user(text));
		const contracts = pairContracts(h);
		assert.deepEqual(contracts.map((contract: any) => [contract.developerSaid, contract.stale, contract.driver]), [[text, true, "human"]]);
		assert.match(h.gate("edit").reason, /made before Pair changed/);
		assert.equal(h.gate("bash").block, true);
		assert.equal(h.gate("read"), undefined);
	}
	// A genuinely new request after Stop is ordinary Pi: no contract, and Pair does not gate it.
	assert.equal(await queue("Ordinary."), undefined);
	h.deliver(user("Ordinary."));
	assert.equal(pairContracts(h).length, 0);
	assert.equal(h.gate("edit"), undefined);

	// A settings change does the same to what was queued under the old settings.
	await pairNoSpec(h);
	await queue("Queued again.");
	h.ui.select = async (_title, options) => options.find((option) => option.startsWith("Build together"));
	await h.command("pair:settings");
	h.deliver(user("Queued again."));
	const [contract] = pairContracts(h);
	assert.equal(contract.stale, true);
	assert.match(h.gate("write").reason, /made before Pair changed/);
});

test("without the classifier, a model preference asks before any edit, showing the developer's own words; cancelling leaves them driving", async (t) => {
	const h = harness(t, undefined, async () => { throw new Error("ONNX Runtime is unavailable"); });
	await h.init(true);
	approveAll(h);
	h.ui.select = async (title, options) => title === "Pair" ? "Pair with spec" : title === "Pair with spec" ? "flow"
		: title.startsWith("Pair settings") ? options.find((option) => option.startsWith("Drive and review")) : undefined;
	await h.command("pair");
	const offered: string[] = [];
	h.ui.select = async (title) => { offered.push(title); return undefined; };
	const long = `${"Please change the retry loop. ".repeat(600)}But don't edit anything yet.`;
	for (const text of [long, "Implement it."]) {
		offered.length = 0;
		await h.turn(text);
		// The dialog shows the whole message, "don't edit" included; cancelling it grants nothing.
		assert.equal(offered.length, 1);
		assert.ok(offered[0].startsWith("Hand this request to the model?\n") && offered[0].includes(`\nBehaviour: ${text}\nFiles: `));
		const [contract] = pairContracts(h);
		assert.deepEqual([contract.developerSaid, contract.driver, contract.task, "files" in contract], [text, "human", "1: Backoff", false]);
		assert.match(h.gate("edit").reason, /^The developer drives this request/);
	}
	assert.equal(h.notices.filter((notice) => /Local triage model unavailable/.test(notice)).length, 1);
	assert.equal(h.factoryCalls(), 1);

	// A task start needs no classification: the slice is offered and confirmed.
	const pickTask = (action: string, choices: string[], left: () => number = () => 0) => {
		offered.length = 0;
		h.ui.select = async (title, options) => title.startsWith("Pair tasks") ? options.find((option) => option.startsWith("Backoff"))
			: title === "Task 1: Backoff" ? action
			: title.startsWith("Choose files") ? typeFiles(left)(options)
			: (offered.push(title), choices.shift());
		return h.command("pair:tasks");
	};
	const toType = ["src/retry.ts"];
	h.answers(() => toType.shift());
	await pickTask("Implement task", ["Choose files…", "Confirm"], () => toType.length);
	assert.match(offered[0], /^Hand task 1: Backoff to the model\?/);
	const [slice] = pairContracts(h);
	assert.deepEqual([slice.driver, slice.files, slice.task], ["model", ["src/retry.ts"], "1: Backoff"]);
	assert.match(slice.developerSaid, /^Implement task 1: Backoff from /);
	await h.settle();
	assert.equal(h.spec().state.tasks["1"].completedHash, null); // A finished slice is reviewed, never marked done by Pair.
	// Added words that cannot be classified are shown in the dialog; declining a task start sends nothing.
	const sent = h.messages.length;
	h.answers(() => "Don't edit yet.");
	await pickTask("Implement task + prompt", []);
	assert.equal(offered.length, 1);
	assert.match(offered[0], /\nBehaviour: Retry\.\n\nDon't edit yet\.\nFiles: /);
	assert.equal(h.messages.length, sent);
});

test("an approved spec reopened by hand while pairing is Spec again for the next delivered request", async (t) => {
	const h = harness(t);
	await h.init(true);
	approveAll(h);
	h.ui.select = async (title, options) => title === "Pair" ? "Pair with spec" : title === "Pair with spec" ? "flow"
		: title.startsWith("Pair settings") ? options[0] : undefined;
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

test("while the developer drives, the model reads, asks and shows only: by gate, by exposure and at the write itself", async (t) => {
	const h = harness(t);
	files(h, { "src/client.ts": "let retries = 0;\n" });
	await pairNoSpec(h);
	assert.deepEqual(h.active(), ["read", "pair_ask"]); // bash, write, edit and another extension's tool are not offered.
	await h.turn("Explain the client.");
	for (const name of ["edit", "write", "bash", "powershell", "external", "subagent", "pair_write"]) assert.equal(h.gate(name, { path: "src/client.ts" }).block, true, name);
	for (const name of ["read", "grep", "find", "ls", "pair_ask"]) assert.equal(h.gate(name, { path: "src/client.ts" }), undefined, name);
	assert.match(h.gate("bash").reason, /bash is not available\. Suggest a command for the developer to run instead\.$/);
	// A call that got past every gate still writes nothing.
	await assert.rejects(editRetries(h), /The developer drives this request.*Nothing was written/);
	await assert.rejects(run(h, "write", { path: "src/new.ts", content: "x" }), /The developer drives this request/);
	assert.equal(read(h, "src/client.ts"), "let retries = 0;\n");
	assert.equal(existsSync(join(h.cwd, "src/new.ts")), false);
	// A name proves nothing: a read another extension has taken over is not Pi's read.
	h.foreign.add("read");
	assert.match(h.gate("read").reason, /read is provided by an extension here, not by Pi/);
	h.foreign.delete("read");
	// Stop gives back exactly the developer's own tools once the request is over, and edit is Pi's edit again.
	await h.command("pair:exit");
	assert.equal(h.gate("edit").block, true); // The stopped request is still being served.
	await h.settle();
	assert.deepEqual(h.active(), ["read", "bash", "write", "edit", "external"]);
	assert.equal(h.gate("edit"), undefined);
	await editRetries(h);
	assert.equal(read(h, "src/client.ts"), "let retries = 3;\n");
});

/** Pair no spec, Drive and review, and a confirmed slice of FILES for "Add retry.". */
async function slice(h: ReturnType<typeof harness>, files: string[]) {
	await pairNoSpec(h, "Drive and review");
	const toType = [...files];
	h.ui.select = async (title, options) => title.startsWith("Choose files") ? typeFiles(() => toType.length)(options)
		: toType.length ? "Choose files…" : "Confirm";
	h.answers(() => toType.shift());
	await h.turn("Add retry.");
}
const implementing = scripted({ "Add retry.": { pair_request: "implement" } });

test("the file browser walks directories, toggles files and adds a whole folder without typing paths", async (t) => {
	const h = harness(t, undefined, implementing);
	files(h, { "src/client.ts": "x\n", "src/util.ts": "y\n", "docs/readme.md": "z\n" });
	await pairNoSpec(h, "Drive and review");
	// Descend into src/ (→), tick every file in it, untick one, then confirm — no path typed.
	const clicks = ["src/", "all", "client.ts", "SAVE"];
	h.ui.select = async (title, options) => {
		if (!title.startsWith("Choose files")) return clicks.length ? "Choose files\u2026" : "Confirm";
		const click = clicks.shift()!;
		if (click === "SAVE") return "\x06"; // C-c C-c: the only way to save and move on.
		const label = options.find((o) => o.includes(click))!;
		return click === "src/" ? `\x1d${label}` : `\x1e${label}`; // → descends into the folder; SPC ticks the rest.
	};
	await h.turn("Add retry.");
	const [slice] = pairContracts(h);
	assert.deepEqual(slice.files, ["src/util.ts"]);
	assert.deepEqual(h.active(), ["read", "write", "edit", "pair_ask"]);
	await h.settle();
});

test("a confirmed slice writes only its files, through Pi's own edit and write, and never over the developer's work", async (t) => {
	const h = harness(t, undefined, implementing);
	files(h, { "src/client.ts": "let retries = 0;\n", "src/other.ts": "other\n" });
	symlinkSync(join(h.cwd, "src/other.ts"), join(h.cwd, "src/alias.ts"));
	// A preference is not a grant: before a slice is confirmed nothing that edits is offered or allowed.
	await pairNoSpec(h, "Drive and review");
	assert.deepEqual(h.active(), ["read", "pair_ask"]);
	assert.equal(h.gate("edit", { path: "src/client.ts" }).block, true);
	await slice(h, ["src", "src/client.ts src/new.ts"]);
	assert.match(h.notices.at(-1)!, /src is not a file/); // A directory is never confirmed.
	assert.deepEqual(h.active(), ["read", "write", "edit", "pair_ask"]);
	await editRetries(h);
	assert.equal(read(h, "src/client.ts"), "let retries = 3;\n");
	// Anything else is refused at the gate and again at the write.
	for (const path of ["src/other.ts", "src/alias.ts"]) {
		assert.match(h.gate("edit", { path }).reason, /is not a file confirmed for this slice/);
		await assert.rejects(editRetries(h, path, "other", "mine"), /is not a file confirmed for this slice/);
	}
	assert.equal(read(h, "src/other.ts"), "other\n");
	await assert.rejects(run(h, "write", { path: "../outside.txt", content: "x" }), /is not where a confirmed file goes/);
	assert.equal(existsSync(join(h.cwd, "../outside.txt")), false);
	await assert.rejects(run(h, "write", { path: "src/client.ts", content: "replaced\n" }), /already exists and write only creates new files/);
	await run(h, "write", { path: "src/new.ts", content: "export {};\n" });
	await run(h, "write", { path: "src/new.ts", content: "export const retry = 3;\n" }); // Its own new file.
	assert.match(h.gate("bash").reason, /bash is not available/); // No shell, even while the model drives.
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
	assert.match(h.messages.at(-1).message.content, /driving again\. Changed: src\/client\.ts lines 1-1, src\/new\.ts \(new\) lines 1-1; each span encloses every change in its file and may include unchanged lines\. src\/client\.ts changed again after the model's last write; that later change is not the model's\. Pair ran no checks\./);
	assert.deepEqual(h.messages.at(-1).message.details.review.files, [
		{ path: "src/client.ts", before: "let retries = 0;\n", after: "let retries = 3;\n", span: { start_line: 1, end_line: 1 }, changedSince: true },
		{ path: "src/new.ts", before: null, after: "export const retry = 3;\n", span: { start_line: 1, end_line: 1 }, changedSince: false }]);
	assert.equal(h.messages.at(-1).message.details.review.partial, false);
	assert.deepEqual(h.active(), ["read", "pair_ask"]);
	await assert.rejects(editRetries(h, "src/client.ts", "5", "9"), /Nothing was written/);
});

test("unsaved or uncheckable editor buffers block a slice's writes; an abort or a late reply after a pause writes nothing", async (t) => {
	const saved = (paths: string[], modified = false) => ({ ok: true, buffers: paths.map((path) => ({ path, open: true, modified })) });
	// No buffer_state, or no editor at all although one is configured: nothing can be checked, so nothing is written.
	for (const capabilities of [[], undefined]) {
		const h = harness(t, (method) => method === "handshake" ? capabilities && { version: 1, editor: "test", capabilities } : undefined, implementing);
		h.start();
		files(h, { "src/client.ts": "let retries = 0;\n" });
		await slice(h, ["src/client.ts"]);
		await assert.rejects(editRetries(h), capabilities ? /The connected editor cannot check unsaved buffers\. Nothing was written/
			: /Editor connection unavailable; cannot check unsaved buffers\. Nothing was written/);
		assert.equal(read(h, "src/client.ts"), "let retries = 0;\n");
	}
	let reply: (paths: string[]) => unknown = (paths) => saved(paths);
	const h = harness(t, (method, args) => method === "handshake" ? { version: 1, editor: "test", capabilities: ["buffer_state"] } : reply(args.paths), implementing);
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
		: saved(args.paths), implementing);
	h.start();
	files(h, { "src/client.ts": "one\ntwo\nthree\nfour\n", "src/old.ts": "gone\n", "src/other.ts": "other\n" });
	await slice(h, ["src/client.ts src/old.ts src/new.ts"]);
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
	assert.equal(h.messages.at(-1).message.content, "The model's slice is finished, and you are driving again. "
		+ "Changed: src/client.ts lines 2-4, src/old.ts (emptied), src/new.ts (new) lines 1-1; each span encloses every change in its file and may include unchanged lines. "
		+ "The slice was interrupted, so its changes may be partial. Pair ran no checks. Review it; another slice needs a new confirmation.");
	assert.equal(h.messages.at(-1).message.details.review.partial, true);
	assert.deepEqual(h.messages.at(-1).message.details.review.files.map((file: any) => [file.path, file.span]),
		[["src/client.ts", { start_line: 2, end_line: 4 }], ["src/old.ts", null], ["src/new.ts", { start_line: 1, end_line: 1 }]]);
	// Driving again: notes are the developer's guidance and may go anywhere.
	await h.turn("Explain the client.");
	assert.equal(note("src/other.ts", 1), undefined);
});
