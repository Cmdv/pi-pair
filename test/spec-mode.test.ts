import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import pair from "../src/index.ts";
import { classifierStub, readyClassifier } from "./classifier-stub.ts";
import type { ClassifierFactory } from "../src/classifier.ts";
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
	let answer: (question: string) => string | undefined = () => undefined;
	let factoryCalls = 0;
	let timestamp = 0;
	const emit = (name: string, event: any = {}) => handlers.get(name)?.(event, ctx);
	const deliver = (message: any) => { history.push(message); };
	pair({
		on: (name: string, handler: any) => handlers.set(name, handler),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerTool: (tool: any) => tools.set(tool.name, tool), registerMessageRenderer() {},
		getActiveTools: () => active, setActiveTools: (names: string[]) => { active = names; },
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
	return { cwd, file, ctx, ui, entries, messages, userMessages, notices, statuses, widgets, sessions, tools, history, asked,
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
	assert.deepEqual(h.widgets.at(-1), ["/pair:tasks Tasks · /pair off Stop"]);
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
	assert.deepEqual(h.widgets.at(-1), ["/pair:approve Approve spec · /pair:tasks Tasks · /pair off Stop"]);

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
	assert.equal(h.statuses.at(-1), "🧑‍🤝‍🧑 Pair: flow · 1/2"); // Approved: Pair is working on it, task 1 first.
	assert.deepEqual(h.widgets.at(-1), ["/pair:tasks Tasks · /pair off Stop"]);
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
	await h.command("pair", "off");
	assert.equal(h.gate("write"), undefined);
	assert.deepEqual([h.statuses.at(-1), h.widgets.at(-1)], [undefined, undefined]);
	assert.match(h.messages.at(-1).message.content, /^Pair stopped\./);
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
	assert.match(sent[0][0].content, /^Implement task 1: Backoff from .*the spec is the plan/s);
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
	assert.equal(h.statuses.at(-1), "🧑‍🤝‍🧑 Pair: flow · 1/2");
	assert.deepEqual(h.widgets.at(-1), ["/pair:tasks Tasks · /pair off Stop"]);
	// Pair with a spec attached: no turn contract, nothing blocked, and the plan in the system prompt.
	const prompt = await h.turn("let's start");
	assert.equal(prompt.message, undefined);
	assert.match(prompt.systemPrompt, /^base\n\nPair is on with the approved spec .*flow\.md; it is the plan.*\nGoal: Stay up\.\nOrder: 1 before 2: the report needs the retry in place\.\nTasks:\n1: Backoff · next\n2: Report\n/s);
	assert.equal(h.context().some((message: any) => message.customType === CONTRACT), false);
	assert.equal(h.gate("bash"), undefined);
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
	assert.equal(h.statuses.at(-1), "🧑‍🤝‍🧑 Pair: flow · 2/2");
	// Marked by mistake: a reset keeps the agreement, drops the completion, and returns to the list.
	let visits = 0;
	h.ui.select = async (title) => title.startsWith("Pair tasks") ? (visits++ ? "Cancel" : "Backoff · done") : "Reset task";
	await h.command("pair:tasks");
	assert.equal(visits, 2);
	assert.deepEqual([h.spec().view.completed, h.spec().state.tasks["1"]], [0, { agreedHash: h.hash("1"), completedHash: null }]);
	assert.equal(h.messages.at(-1).message.content, "Task 1: Backoff is no longer done.");
	assert.equal(h.statuses.at(-1), "🧑‍🤝‍🧑 Pair: flow · 1/2");
	// Implement hands the task to the model in this session, with the developer's note when they add one.
	h.ui.select = async (title, options) => title.startsWith("Pair tasks") ? options.find((option) => option.startsWith("Report")) : "Implement task + prompt";
	h.answers(() => "Start with the error path.");
	await h.command("pair:tasks");
	assert.equal(h.asked.at(-1), "Task 2: Report");
	assert.equal(h.messages.at(-1).message.content, "Implement task 2: Report from .pi/pi-pair/specs/flow.md. Read the task first: the spec is the plan, and its discussion is already settled there.\n\nStart with the error path.");
	assert.equal(h.messages.at(-1).options.triggerTurn, true);
	assert.equal(h.statuses.at(-1), "🧑‍🤝‍🧑 Pair: flow · 2/2"); // The task being implemented is the current one.
	assert.match((await h.turn("go on")).systemPrompt, /Tasks:\n1: Backoff\n2: Report · next\n/);
	h.ui.select = async (title, options) => title.startsWith("Pair tasks") ? options.find((option) => option.startsWith("Report")) : "Implement task";
	await h.command("pair:tasks");
	assert.equal(h.messages.at(-1).message.content, "Implement task 2: Report from .pi/pi-pair/specs/flow.md. Read the task first: the spec is the plan, and its discussion is already settled there.");
	// Done, task by task, until the list has nothing left to pick.
	h.ui.select = async (title, options) => title.startsWith("Pair tasks") ? options.find((option) => !option.endsWith("· done") && option !== "Cancel") : "Mark task as done";
	await h.command("pair:tasks");
	assert.equal(h.messages.at(-1).message.content, "Task 2: Report done. Every task is done.");
	assert.equal(h.statuses.at(-1), "🧑‍🤝‍🧑 Pair: flow · done");
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
	assert.deepEqual([titles, offered[1]], [["Pair", "Pair with spec", "Pair tasks · flow"], ["flow"]]);
	assert.equal(h.statuses.at(-1), "🧑‍🤝‍🧑 Pair: flow · 1/2");
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
