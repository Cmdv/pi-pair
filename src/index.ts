import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { withFileMutationQueue, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type MessageStartEvent } from "@earendil-works/pi-coding-agent";
import { Box, Spacer, Text } from "@earendil-works/pi-tui";
import { findTask, slug, template } from "./tasks.ts";
import { emptyState, stateFile, writeState, type Status } from "./state.ts";
import { apply, loadSpec as loadFile, save, writeParameters } from "./proposals.ts";
import { classifierFactory, type Classifier, type ClassifierFactory } from "./classifier.ts";
import { allowsWrite, CONTRACT, contractFor, guidance, READ_TOOLS, WRITE, type Contract, type Intent } from "./contracts.ts";
import { triage, writeScope } from "./triage.ts";
import { ask as askEditor, bufferState, handshake, open as openEditor, rpcTransport } from "./adapter.ts";
import { NEEDS, SHOW_CODE, registerShow, type Connected } from "./show.ts";
import { answerText, askEach, askParameters, askTabs, type Answers } from "./ask.ts";
import pkg from "../package.json" with { type: "json" };

const ENTRY = "pi-pair";
const ASK = "pair_ask";
const HOME = join(".pi", "pi-pair");
const SPECS = join(HOME, "specs");
const TRACE = join(HOME, "trace.log"); // Readable alongside the specs: what code decided, and what it refused.
const PAIR_WITH_SPEC = "Pair with spec";
const PAIR_NO_SPEC = "Pair no spec";
const NEW_SPEC = "New spec";
const EDIT_SPEC = "Edit spec";
const NEW_TASK = "+ New task";
const APPROVE_SPEC = "Approve spec";
const KEEP_WORKING = "Keep working on the tasks";
const AGREE = "Agree";
const ADJUST = "Discuss or adjust";
const IMPLEMENT = "Implement task";
const IMPLEMENT_PROMPT = "Implement task + prompt";
const MARK_DONE = "Mark task as done";
const RESET_TASK = "Reset task";
const GO_BACK = "Go back";
const CANCEL = "Cancel";
const OPENING = "What are you trying to solve?";
const STOP = "Pair has no readable spec. Report the problem and wait; do not call tools.";
type Message = MessageStartEvent["message"];
const messageText = (message: Message) => "content" in message ? typeof message.content === "string" ? message.content
	: message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") : "";
/** Every string in a tool's input, wherever it sits, so a path is found whichever field carries it. */
const strings = (value: unknown): string[] =>
	typeof value === "string" ? [value] : value && typeof value === "object" ? Object.values(value).flatMap(strings) : [];
/** What code does once the model's turn has settled; derived from what was written, so repeated writes agree. */
type Next = "tasks" | "questions" | "review" | "agree";

/** Pair is on or off, with an optional spec. PI_PAIR_EDITOR separately opts into adapter discovery. */
export default function (pi: ExtensionAPI, factory: ClassifierFactory = classifierFactory) {
	let pair = false;
	let spec: string | undefined;
	let selection: string | undefined; // The task being filled in or reviewed; none means the task list.
	let intent: Intent | undefined; // The last triage result, which scopes what the model may write.
	let next: Next | undefined;
	let revision = 0; // Any scope change invalidates a picker or dialog that is already open.
	let classifier: Classifier | undefined;
	let classifierFailed = false;
	const asked = new Set<string>(); // Tasks whose questions have already been put to the developer.
	let answering: string | undefined; // The task whose answers code is waiting for; answering it agrees it.
	let ready = false; // The spec is approved: Pair works on it, and the spec machinery stands down.
	let traced: string | undefined; // The session the trace log is on, so separate runs read apart.
	let adapter: Promise<Connected | undefined> = Promise.resolve(undefined);
	let adapterAbort: AbortController | undefined;
	let capabilities = new Set<string>();
	let whenOff = false;
	const addedReadTools = new Set<string>();

	// An editor that reports showWhenOff keeps showing code after Pair stops.
	const showing = () => pair || whenOff;
	const showable = () => showing() && Object.values(NEEDS).some((capability) => capabilities.has(capability));
	const specPath = () => join(SPECS, `${spec}.md`);
	const specFile = (cwd: string) => spec ? join(cwd, specPath()) : undefined;
	// Messages are badged Spec while a spec is being written, so the transcript says which mode spoke.
	const specMode = () => pair && !!spec && !ready;
	const say = (content: string, triggerTurn = false, details: Record<string, unknown> = {}) =>
		pi.sendMessage({ customType: ENTRY, content, display: true, details: { badge: specMode() ? "Spec" : "Pair", ...details } }, { triggerTurn });
	const announce = (content: string) => say(content);
	function trace(ctx: ExtensionContext, event: string, data: Record<string, unknown> = {}) {
		const session = ctx.sessionManager.getSessionId();
		const entry = { event, session, spec, selection, ...data };
		pi.appendEntry("pi-pair-trace", entry);
		// A line per step, so a flow that went wrong can be read back without the session file.
		try {
			mkdirSync(join(ctx.cwd, HOME), { recursive: true });
			const { event: _event, session: _session, ...rest } = entry;
			const header = session === traced ? "" : `\n── session ${session} ──\n`;
			traced = session;
			appendFileSync(join(ctx.cwd, TRACE), `${header}${new Date().toISOString()} ${event.padEnd(14)} ${JSON.stringify(rest)}\n`);
		} catch { /* Tracing never blocks the workflow. */ }
	}
	function loadSpec(cwd: string, name = spec) {
		if (!name) throw new Error("No active spec.");
		const file = join(cwd, SPECS, `${name}.md`);
		return { file, ...loadFile(file) };
	}

	function show(ctx: ExtensionContext) {
		let where = spec ? `Spec: ${spec}` : "Pair";
		let approve: string | undefined;
		let tasks = false;
		ready = false;
		if (pair && spec) {
			try {
				const { view } = loadSpec(ctx.cwd);
				ready = view.ready;
				tasks = view.total > 0;
				const task = view.tasks.find((item) => item.id === selection);
				// Only the control whose requirement is met is offered.
				approve = ready ? undefined : task ? task.populated && !task.agreed ? "/pair:approve Approve task" : undefined
					: view.approvable ? "/pair:approve Approve spec" : undefined;
				// Where the developer is, and nothing else: the task under review, or the next one to do.
				const current = ready ? nextTask(view)?.id : selection;
				where = ready ? `Pair: ${spec} · ${current ? `${current}/${view.total}` : "done"}` : `Spec: ${current ? `${current}/${view.total}` : spec}`;
			} catch { where += " · needs attention"; }
		}
		ctx.ui.setStatus("pair", pair ? `🧑‍🤝‍🧑 ${where}` : undefined);
		// One line, and only the shortcuts that apply here.
		ctx.ui.setWidget?.("pi-pair", pair
			? [[...(approve ? [approve] : []), ...(tasks ? ["/pair:tasks Tasks"] : []), "/pair off Stop"].join(" · ")]
			: undefined);
	}

	function setPair(on: boolean, name: string | undefined, ctx: ExtensionContext) {
		revision++;
		if (spec !== name || !on) { selection = undefined; asked.clear(); }
		intent = undefined;
		next = undefined;
		answering = undefined;
		pair = on;
		spec = name;
		pi.appendEntry(ENTRY, { pair, spec, selection });
		show(ctx);
		syncTools();
	}

	function syncTools() {
		const tools = pi.getActiveTools().filter((name) => name !== SHOW_CODE && name !== ASK && name !== WRITE);
		if (specMode()) {
			for (const name of READ_TOOLS) if (!tools.includes(name)) { tools.push(name); addedReadTools.add(name); }
		} else {
			for (const name of addedReadTools) { const i = tools.indexOf(name); if (i !== -1) tools.splice(i, 1); }
			addedReadTools.clear();
		}
		if (showable()) tools.push(SHOW_CODE);
		if (pair) tools.push(ASK);
		if (specMode()) tools.push(WRITE);
		pi.setActiveTools(tools);
	}

	async function openSpec(ctx: ExtensionContext) {
		if (!spec) return;
		const name = spec;
		const connected = await adapter;
		if (!pair || spec !== name || !connected?.capabilities.has("open")) return;
		try { await openEditor(connected.send, specPath(), connected.signal); }
		catch (error) { ctx.ui.notify(`Could not open spec: ${(error as Error).message}`, "warning"); }
	}

	function resetAdapter() {
		adapterAbort?.abort();
		adapterAbort = undefined;
		adapter = Promise.resolve(undefined);
		capabilities = new Set();
		whenOff = false;
		syncTools();
	}

	async function requireAdapter(capability: "show" | "present" | "clear" | "buffer_state") {
		const pending = adapter;
		const connected = await pending;
		if (pending !== adapter || !connected || connected.signal.aborted || !connected.capabilities.has(capability)) {
			throw new Error(`Pairing adapter does not support ${capability}.`);
		}
		return connected;
	}

	/** The developer's own edits win: nothing is written while the spec is modified in the editor. */
	async function requireSaved(ctx: ExtensionContext) {
		const connected = await adapter;
		if (!connected) {
			if (ctx.mode === "rpc" && process.env.PI_PAIR_EDITOR?.trim()) throw new Error("Editor connection unavailable; cannot check unsaved buffers. Nothing was written.");
			return;
		}
		if (!connected.capabilities.has("buffer_state")) throw new Error("The connected editor cannot check unsaved buffers. Nothing was written.");
		const buffers = await bufferState(connected.send, [specPath(), stateFile(specPath())], connected.signal);
		if (buffers.some((buffer) => buffer.modified)) throw new Error("The spec has unsaved changes in the editor. Save them first; nothing was written.");
	}

	/** Loaded once, on the first message that needs triage; without it, messages reach the model unchanged. */
	async function getClassifier(ctx: ExtensionContext) {
		if (classifier || classifierFailed) return classifier;
		try {
			classifier = await factory({ signal: AbortSignal.timeout(5 * 60_000) });
		} catch (error) {
			classifierFailed = true;
			ctx.ui.notify(`Local triage model unavailable, so Pair sends messages to the model unchanged: ${(error as Error).message}`, "warning");
		}
		return classifier;
	}

	const currentContract = (ctx: ExtensionContext): Contract | undefined => {
		if (!specMode()) return undefined;
		try { return contractFor(loadSpec(ctx.cwd), selection, intent); } catch { return undefined; }
	};
	const hidden = (ctx: ExtensionContext) => {
		const contract = currentContract(ctx);
		return { customType: CONTRACT, content: contract ? guidance(contract) : STOP, display: false as const };
	};

	// Pair's own prompts and instructions: a solid accent badge, so they read as Pair speaking, not the model.
	pi.registerMessageRenderer(ENTRY, (message, _options, theme) => {
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		const badge = (message as { details?: { badge?: string } }).details?.badge ?? "Pair";
		box.addChild(new Text(theme.fg("accent", `\x1b[7m 🧑‍🤝‍🧑 ${badge} \x1b[27m`), 0, 0));
		box.addChild(new Spacer(1));
		box.addChild(new Text(theme.fg("customMessageText", messageText(message)), 0, 0));
		return box;
	});

	registerShow(pi, () => showing(), requireAdapter, () => adapter);

	pi.registerTool({
		name: ASK,
		label: "Ask",
		description: "Ask the developer 1–5 short questions, each with a tab label and 2–5 likely answers; they pick one, type their own or skip it. " +
			"Use it for real choices, never for what reading code would answer. A task's own written questions are put to the developer by code, not here.",
		parameters: askParameters,
		executionMode: "sequential",
		async execute(_id, params, signal, _update, ctx): Promise<{ content: { type: "text"; text: string }[]; details: { answers: Answers } }> {
			if (!pair) throw new Error("Pairing is off.");
			if (!ctx.hasUI) throw new Error("No dialogs available; ask in chat instead.");
			const { questions } = params;
			const editor = ctx.mode === "rpc" ? await adapter : undefined;
			const answers = ctx.mode === "tui" ? await askTabs(ctx.ui, questions, signal)
				: editor?.capabilities.has("ask")
					? await askEditor(editor.send, questions, signal ? AbortSignal.any([signal, editor.signal]) : editor.signal)
					: await askEach(ctx.ui, questions, signal);
			return { content: [{ type: "text", text: answerText(questions, answers) }], details: { answers } };
		},
	});

	pi.registerTool({
		name: WRITE,
		label: "Write spec",
		description: "Save spec content. kind tasks: the goal, the order of work and new task titles. kind task: one task's number and its sections, plus the baseHash the contract lists for it once that task has content. " +
			"Code validates and writes immediately, so write only what the current contract's scope allows. Saving content is not agreement: only the developer approves.",
		parameters: writeParameters,
		executionMode: "sequential",
		async execute(_id, params, signal, _update, ctx) {
			if (!pair || !spec) throw new Error("An active spec is required.");
			const contract = currentContract(ctx);
			if (!contract || !allowsWrite(contract, params as Record<string, unknown>)) throw new Error(`Outside this turn's scope: it may write ${scopeText(contract)}.`);
			signal?.throwIfAborted();
			const file = specFile(ctx.cwd)!;
			let summary = "";
			try {
				await withFileMutationQueue(file, async () => {
					await requireSaved(ctx);
					const before = loadFile(file);
					const prepared = apply(before, params);
					save(file, before, prepared);
					summary = prepared.summary;
				});
			} catch (error) {
				// A refused write is the model about to loop: the reason belongs in the log, not only in its context.
				trace(ctx, "write_refused", { phase: contract.phase, params, error: (error as Error).message });
				throw error;
			}
			trace(ctx, "wrote", { params, summary });
			const written = loadSpec(ctx.cwd);
			// Drafting reads as progress; a change the developer asked for reads as saved.
			const drafting = contract.phase === "describe" || contract.phase === "populate";
			if (params.kind === "tasks") {
				const found = params.names?.length ?? 0;
				announce(drafting && found ? `Found ${found} task${found === 1 ? "" : "s"}. Filling them in…` : `Saved ${summary}.`);
			} else {
				announce(`${drafting ? "Finished" : "Saved"} task ${params.id}: ${findTask(written.parsed, params.id!)?.name}.`);
			}
			show(ctx);
			const task = selection ? written.view.tasks.find((item) => item.id === selection) : undefined;
			const unanswered = selection ? openQuestions(ctx, selection).length : 0;
			// Answering a task's questions is the developer's decision on it, so the answers landing agree it.
			next = !selection ? "tasks" : !task?.populated ? undefined
				: selection === answering ? unanswered ? "review" : "agree"
					: unanswered && !asked.has(selection) ? "questions" : "review";
			return { content: [{ type: "text" as const, text: `Saved ${summary}.` }], details: { summary } };
		},
	});

	const scopeText = (contract?: Contract) =>
		!contract ? "nothing" : contract.write === "task" ? `task ${contract.task} only` : contract.write === "tasks" ? "the goal, the order and new tasks" : "any task";

	const openQuestions = (ctx: ExtensionContext, id: string) =>
		findTask(loadSpec(ctx.cwd).parsed, id)?.questions.filter((item) => !item.checked) ?? [];

	/** Step 11: a task's own questions reach the developer when they open it, through
	 * pair_ask's dialog, so each one comes with likely answers and a recommendation. */
	function askQuestions(ctx: ExtensionContext): Promise<void> | void {
		const id = selection;
		if (!id) return;
		const open = ctx.hasUI ? openQuestions(ctx, id) : [];
		if (!open.length) return reviewPrompt(ctx);
		asked.add(id);
		answering = id;
		trace(ctx, "asking", { task: id, questions: open.map((item) => item.id) });
		const one = open.length === 1;
		// Step 12: the model asks, then folds the answers back into the task.
		say(`Task ${id} has ${one ? "an open question" : `${open.length} open questions`}. Put ${one ? "it" : "them"} to the developer now with pair_ask, `
			+ `each with likely answers and your recommendation first. Then record what they say in task ${id} with pair_write, ticking the questions you answered, and stop; answering them agrees the task.\n\n`
			+ open.map((item) => `${item.id}: ${item.text}`).join("\n"), true, { task: id });
	}

	/** Step 13: the task is written and had nothing to ask; the developer agrees it, or talks about it first. */
	async function reviewPrompt(ctx: ExtensionContext): Promise<void> {
		const task = selection ? loadSpec(ctx.cwd).view.tasks.find((item) => item.id === selection) : undefined;
		if (!task) return;
		show(ctx);
		const before = revision;
		const choice = await ctx.ui.select(`Task ${task.id}: ${task.name}`, [AGREE, ADJUST]);
		if (revision !== before || selection !== task.id) return;
		if (choice === AGREE) return approve(ctx);
		if (choice === ADJUST) announce(`Task ${task.id}: ${task.name} is written.\nAnything to discuss or adjust?`);
	}

	/** Steps 8 and 17: the task list, which is also where the spec itself is approved. */
	async function showTasks(ctx: ExtensionContext, offer = true): Promise<void> {
		if (!pair || !spec) throw new Error("Pick a spec with /pair first.");
		const before = revision;
		intent = undefined;
		answering = undefined;
		// The list is the hub, so the spec itself is in view whenever it is open.
		await openSpec(ctx);
		if (revision !== before) return;
		const { parsed, view } = loadSpec(ctx.cwd);
		// Once the spec is approved the list is the plan as progress, and reads apart from this one.
		if (view.ready) return showProgress(ctx, before);
		selection = undefined;
		pi.appendEntry(ENTRY, { pair, spec, selection });
		show(ctx);
		// Step 18: with every task agreed, approving the spec is the obvious next thing, so it is offered first.
		if (offer && view.approvable && view.tasks.every((task) => task.agreed)) {
			const choice = await ctx.ui.select("Every task is agreed", [APPROVE_SPEC, KEEP_WORKING]);
			if (revision !== before || choice === undefined) return;
			if (choice === APPROVE_SPEC) return approve(ctx);
		}
		const options = view.tasks.map((task) =>
			`${task.name} · ${task.agreed ? "agreed" : task.populated ? "written" : "empty"}${task.open ? ` · ${task.open} open` : ""}`);
		const choice = await ctx.ui.select(`Spec tasks · ${spec}`, [...options, NEW_TASK, ...(view.approvable ? [APPROVE_SPEC] : []), CANCEL]);
		if (revision !== before || choice === undefined || choice === CANCEL) return;
		if (choice === APPROVE_SPEC) return approve(ctx);
		if (choice === NEW_TASK) {
			const name = (await ctx.ui.input("New task", "e.g. Reconnect after sleep"))?.trim();
			if (revision !== before || !name) return;
			return openTask(ctx, await addTask(ctx, name));
		}
		const id = parsed.tasks[options.indexOf(choice)]?.id;
		if (id) await openTask(ctx, id);
	}

	/** The task to do next: the one being implemented, or else the first not yet done. */
	const nextTask = (view: Status) => view.tasks.find((item) => item.id === selection && !item.completed) ?? view.tasks.find((item) => !item.completed);

	/** The pairing-mode list: the plan as progress. A task is implemented, marked done or reset from here. */
	async function showProgress(ctx: ExtensionContext, before: number): Promise<void> {
		pi.appendEntry(ENTRY, { pair, spec, selection });
		show(ctx);
		const { view } = loadSpec(ctx.cwd);
		const current = nextTask(view);
		const rows = view.tasks.map((task) => `${task.name}${task.completed ? " · done" : task.id === current?.id ? " · next" : ""}`);
		const choice = await ctx.ui.select(`Pair tasks · ${spec}`, [...rows, CANCEL]);
		if (revision !== before || choice === undefined || choice === CANCEL) return;
		const task = view.tasks[rows.indexOf(choice)];
		if (!task) return;
		if (task.completed) {
			// Marked by mistake: a reset keeps the agreement and drops the completion.
			const action = await ctx.ui.select(`Task ${task.id}: ${task.name} · done`, [RESET_TASK, GO_BACK]);
			if (revision !== before || action === undefined) return;
			if (action === RESET_TASK) await resetTask(ctx, task.id);
			return showTasks(ctx);
		}
		const action = await ctx.ui.select(`Task ${task.id}: ${task.name}`, [IMPLEMENT, IMPLEMENT_PROMPT, MARK_DONE, CANCEL]);
		if (revision !== before || action === undefined || action === CANCEL) return;
		if (action === MARK_DONE) { await markDone(ctx, task.id); return showTasks(ctx); }
		const extra = action === IMPLEMENT_PROMPT ? (await ctx.ui.input(`Task ${task.id}: ${task.name}`, "Anything to add before the model starts"))?.trim() : "";
		if (revision !== before || extra === undefined) return;
		implement(ctx, task, extra);
	}

	/** The handoff to the model, here or in a fresh session: the task is in the spec, which is the plan. */
	const implementation = (task: { id: string; name: string }) =>
		`Implement task ${task.id}: ${task.name} from ${specPath()}. Read the task first: the spec is the plan, and its discussion is already settled there.`;

	function implement(ctx: ExtensionContext, task: { id: string; name: string }, extra: string) {
		selection = task.id;
		pi.appendEntry(ENTRY, { pair, spec, selection });
		trace(ctx, "implementing", { task: task.id, ...(extra ? { prompt: extra } : {}) });
		show(ctx);
		say(`${implementation(task)}${extra ? `\n\n${extra}` : ""}`, true, { task: task.id });
	}

	/** Completion is the developer's call on the version they can see; calling a task done also agrees it. */
	async function markDone(ctx: ExtensionContext, id: string) {
		const file = specFile(ctx.cwd)!;
		let message = "";
		await withFileMutationQueue(file, async () => {
			await requireSaved(ctx);
			const snapshot = loadFile(file);
			const task = findTask(snapshot.parsed, id);
			if (!task) throw new Error(`The spec has no task ${id}.`);
			const state = structuredClone(snapshot.state);
			state.tasks[id] = { agreedHash: task.hash, completedHash: task.hash };
			const following = snapshot.view.tasks.find((item) => item.id !== id && !item.completed);
			message = `Task ${id}: ${task.name} done.${following ? ` Next: task ${following.id}: ${following.name}.` : " Every task is done."}`;
			writeState(stateFile(file), state);
		});
		if (selection === id) selection = undefined;
		trace(ctx, "done", { task: id });
		announce(message);
		show(ctx);
	}

	async function resetTask(ctx: ExtensionContext, id: string) {
		const file = specFile(ctx.cwd)!;
		let name = "";
		await withFileMutationQueue(file, async () => {
			await requireSaved(ctx);
			const snapshot = loadFile(file);
			const task = findTask(snapshot.parsed, id);
			if (!task) throw new Error(`The spec has no task ${id}.`);
			name = task.name;
			const state = structuredClone(snapshot.state);
			state.tasks[id] = { agreedHash: state.tasks[id]?.agreedHash ?? task.hash, completedHash: null };
			writeState(stateFile(file), state);
		});
		trace(ctx, "reset", { task: id });
		announce(`Task ${id}: ${name} is no longer done.`);
		show(ctx);
	}

	/** Edit spec on an approved spec withdraws the approval, so the Spec machinery comes back. */
	async function reopenSpec(ctx: ExtensionContext) {
		const file = specFile(ctx.cwd)!;
		await withFileMutationQueue(file, async () => {
			await requireSaved(ctx);
			writeState(stateFile(file), { ...loadFile(file).state, specAgreed: false });
		});
		trace(ctx, "reopened");
	}

	async function addTask(ctx: ExtensionContext, name: string) {
		const file = specFile(ctx.cwd)!;
		let id = "";
		await withFileMutationQueue(file, async () => {
			await requireSaved(ctx);
			const before = loadFile(file);
			const prepared = apply(before, { kind: "tasks", names: [name] });
			save(file, before, prepared);
			id = prepared.ids[0];
		});
		trace(ctx, "task_added", { task: id });
		return id;
	}

	/** Steps 9–11: a written task opens on its open questions; a task added later is filled in first. */
	async function openTask(ctx: ExtensionContext, id: string): Promise<void> {
		selection = id;
		intent = undefined;
		next = undefined;
		answering = undefined;
		pi.appendEntry(ENTRY, { pair, spec, selection });
		trace(ctx, "task_selected");
		show(ctx);
		await openSpec(ctx);
		if (selection !== id) return;
		const task = loadSpec(ctx.cwd).view.tasks.find((item) => item.id === id);
		if (!task) return;
		// A written task opens on its own questions, if it still has any, and otherwise on review.
		if (task.populated) return asked.has(id) ? reviewPrompt(ctx) : askQuestions(ctx);
		say(`Fill in task ${id}: ${task.name}.`, true, { task: id });
	}

	/** The only two gates: a written task, or the spec once one task is agreed. */
	async function approve(ctx: ExtensionContext): Promise<void> {
		if (!pair || !spec) throw new Error("Pick a spec with /pair first.");
		if (ready) throw new Error("The spec is approved, and Pair is working on it.");
		const target = selection;
		const file = specFile(ctx.cwd)!;
		let message = "";
		await withFileMutationQueue(file, async () => {
			await requireSaved(ctx);
			const snapshot = loadFile(file);
			const state = structuredClone(snapshot.state);
			if (target) {
				const task = findTask(snapshot.parsed, target);
				if (!task || !snapshot.view.tasks.find((item) => item.id === target)?.populated) throw new Error(`Task ${target} has nothing written to approve yet.`);
				state.tasks[target] = { agreedHash: task.hash, completedHash: state.tasks[target]?.completedHash ?? null };
				message = `Task ${target}: ${task.name} approved.`;
			} else {
				if (!snapshot.view.approvable) throw new Error("Approve a task before approving the spec.");
				state.specAgreed = true;
				// Step 19: the spec's Order says how to proceed and why; without one, the numbered titles do.
				const order = snapshot.parsed.order || snapshot.parsed.tasks.map((task) => `${task.id}. ${task.name}`).join("\n");
				message = `I've now put us into pairing mode with spec ${spec}. This is the order I advise we do it in:\n${order}\n`
					+ "Mark each done from /pair:tasks as it lands; /pair:next starts the next one in a fresh session.";
			}
			writeState(stateFile(file), state);
		});
		trace(ctx, "approved", { task: target });
		announce(message); // Still badged Spec: this is the last thing Spec says.
		// Step 17: back to the list, which is also step 18 once everything is agreed.
		if (target) return showTasks(ctx);
		// The spec is approved, so the spec machinery stands down and Pair works on it.
		show(ctx);
		syncTools();
	}

	pi.registerCommand("pair:approve", {
		description: "Approve the task being reviewed, or the spec from the task list",
		handler: async (_args, ctx) => {
			try { await ctx.waitForIdle(); await approve(ctx); }
			catch (error) { trace(ctx, "approval_blocked", { error: (error as Error).message }); ctx.ui.notify((error as Error).message, "error"); }
		},
	});

	pi.registerCommand("pair:tasks", {
		description: "Show the task list: choose a task, add one, or approve the spec",
		handler: async (_args, ctx) => {
			try { await ctx.waitForIdle(); await showTasks(ctx); }
			catch (error) { ctx.ui.notify((error as Error).message, "error"); }
		},
	});

	pi.registerCommand("pair:next", {
		description: "Continue the approved spec's next task in a fresh session",
		handler: async (_args, ctx) => {
			try {
				if (!pair || !spec) throw new Error("Pick a spec with /pair first.");
				const { view } = loadSpec(ctx.cwd);
				if (!view.ready) throw new Error("Approve the spec before handing off with /pair:next.");
				const task = nextTask(view);
				if (!task) throw new Error("Every task in the active spec is done.");
				const content = implementation(task);
				const kept = { pair, spec, selection: task.id };
				const parentSession = ctx.sessionManager.getSessionFile();
				await ctx.newSession({
					...(parentSession ? { parentSession } : {}),
					setup: async (manager) => { manager.appendCustomEntry(ENTRY, kept); },
					withSession: async (fresh) => { await fresh.sendMessage({ customType: ENTRY, content, display: true }, { triggerTurn: false }); },
				});
			} catch (error) { ctx.ui.notify((error as Error).message, "warning"); }
		},
	});

	/** Step 2: what to pair on. Pairing is for approved specs; editing is for any of them. */
	async function pickSpec(ctx: ExtensionCommandContext): Promise<{ name: string | null; edit?: boolean } | undefined> {
		const dir = join(ctx.cwd, SPECS);
		// A spec is Markdown with companion state. Old-format Markdown has no state and is not listed.
		const names = existsSync(dir) ? readdirSync(dir).filter((file) => file.endsWith(".state.json")).map((file) => file.slice(0, -".state.json".length))
			.filter((name) => existsSync(join(dir, `${name}.md`))).sort() : [];
		const choice = await ctx.ui.select("Pair", [PAIR_WITH_SPEC, PAIR_NO_SPEC, NEW_SPEC, EDIT_SPEC]);
		if (choice === PAIR_NO_SPEC) return { name: null };
		if (choice === NEW_SPEC) {
			const name = (await ctx.ui.input("Pair · New spec\nEnter a name · saved as .pi/pi-pair/specs/<name>.md", "e.g. reconnect-after-sleep"))?.trim();
			return name ? { name } : undefined;
		}
		if (choice !== PAIR_WITH_SPEC && choice !== EDIT_SPEC) return undefined;
		const edit = choice === EDIT_SPEC;
		const approved = (name: string) => { try { return loadFile(join(dir, `${name}.md`)).view.ready; } catch { return false; } };
		const listed = edit ? names : names.filter(approved);
		if (!listed.length) { ctx.ui.notify(edit ? "No spec yet; New spec creates one." : "No approved spec yet; New spec or Edit spec first.", "warning"); return undefined; }
		const name = await ctx.ui.select(choice, listed);
		return name === undefined ? undefined : { name, edit };
	}

	function ensureSpec(cwd: string, name: string) {
		const id = slug(name);
		if (!id) throw new Error(`"${name}" has no letters or digits to name a spec file.`);
		const file = join(cwd, SPECS, `${id}.md`);
		if (!existsSync(file)) {
			mkdirSync(join(cwd, SPECS), { recursive: true });
			writeFileSync(file, template(name.replace(/\s+/g, " ")), { flag: "wx" });
			if (!existsSync(stateFile(file))) writeState(stateFile(file), emptyState());
		}
		return id;
	}

	pi.registerCommand("pair", {
		description: "Pair with an approved spec, without one, or create or edit a spec; /pair <name> opens a spec, /pair off stops Pair",
		getArgumentCompletions: (prefix) => "off".startsWith(prefix.trim()) ? [{ value: "off", label: "off", description: "Turn Pair off" }] : [],
		handler: async (args, ctx) => {
			if (args.trim().toLowerCase() === "off") {
				revision++;
				if (!ctx.isIdle()) { ctx.abort(); await ctx.waitForIdle(); }
				trace(ctx, "stopped");
				setPair(false, spec, ctx);
				announce("Pair stopped. Your spec is saved; /pair reopens it.");
				return;
			}
			if (!ctx.hasUI) return ctx.ui.notify("Pair needs a UI for explicit choices.", "warning");
			try {
				revision++;
				const before = revision;
				if (!ctx.isIdle()) await ctx.waitForIdle();
				const picked = args.trim() ? { name: args.trim() } : await pickSpec(ctx);
				if (picked === undefined || before !== revision) return;
				if (picked.name === null) return setPair(true, undefined, ctx);
				const id = ensureSpec(ctx.cwd, picked.name);
				loadSpec(ctx.cwd, id); // Validate before activating.
				setPair(true, id, ctx);
				const { parsed, view } = loadSpec(ctx.cwd);
				// A spec with nothing in it yet opens once the model has written it, not empty.
				if (!parsed.tasks.length) return announce(OPENING);
				if (picked.edit && view.ready) {
					await reopenSpec(ctx);
					show(ctx);
					syncTools();
					announce(`${id} is open for editing; approve it again once it is right.`);
					return showTasks(ctx, false);
				}
				await showTasks(ctx);
			} catch (error) { ctx.ui.notify((error as Error).message, "error"); }
		},
	});

	function restore(ctx: ExtensionContext) {
		revision++;
		next = undefined;
		intent = undefined;
		answering = undefined;
		const entry = ctx.sessionManager.getBranch().findLast((entry) => entry.type === "custom" && entry.customType === ENTRY) as
			{ data?: { pair?: boolean; spec?: string; selection?: string } } | undefined;
		const name = entry?.data?.spec;
		spec = typeof name === "string" && name && slug(name) === name ? name : undefined;
		pair = entry?.data?.pair === true && (name === undefined || spec !== undefined);
		selection = entry?.data?.selection;
		try {
			if (pair && spec && !loadSpec(ctx.cwd).parsed.tasks.some((task) => task.id === selection)) selection = undefined;
		} catch (error) { pair = false; ctx.ui.notify(`Pair not resumed: ${(error as Error).message}`, "error"); }
		show(ctx);
		syncTools();
	}

	pi.on("session_start", (_event, ctx) => {
		resetAdapter();
		restore(ctx);
		if (ctx.mode !== "rpc" || !process.env.PI_PAIR_EDITOR?.trim()) return;
		const send = rpcTransport(ctx);
		const controller = new AbortController();
		adapterAbort = controller;
		// RPC replies are read only after session_start returns. Keep startup non-blocking.
		adapter = handshake(send, pkg.version, controller.signal).then((reported) => {
			if (controller.signal.aborted) return undefined;
			capabilities = reported.capabilities;
			whenOff = reported.showWhenOff;
			syncTools();
			return { send, capabilities, signal: controller.signal };
		}).catch((error) => {
			if (!controller.signal.aborted) ctx.ui.notify(`Pairing adapter unavailable; continuing without editor integration. ${(error as Error).message}`, "warning");
			return undefined;
		});
	});
	pi.on("session_shutdown", () => { revision++; resetAdapter(); });
	pi.on("session_tree", (_event, ctx) => restore(ctx));

	pi.on("agent_settled", async (_event, ctx) => {
		// A turn that was meant to bring back answers but wrote nothing still owes the developer a prompt.
		const todo = next ?? (answering ? "review" : undefined);
		next = undefined;
		if (todo !== "questions") answering = undefined;
		if (!specMode()) return;
		trace(ctx, "settled", { todo: todo ?? "nothing" });
		if (!todo) return;
		try {
			if (todo === "tasks") await showTasks(ctx);
			else if (todo === "questions") await askQuestions(ctx);
			else if (todo === "agree") await approve(ctx); // Step 13, answered rather than pressed.
			else await reviewPrompt(ctx);
		} catch (error) { ctx.ui.notify((error as Error).message, "error"); }
	});

	pi.on("input", async (event, ctx) => {
		if (!specMode()) return;
		const before = revision;
		try {
			trace(ctx, "input", { text: event.text, source: event.source });
			intent = undefined;
			// Everything up to the first task list is linear: the contract follows the step, not the words.
			if (!loadSpec(ctx.cwd).parsed.tasks.length) return;
			const model = await getClassifier(ctx);
			if (revision !== before) return { action: "handled" };
			if (!model) return;
			const result = await triage(model, event.text, { task: selection });
			if (revision !== before) return { action: "handled" };
			trace(ctx, "triage", { ...result });
			if (result.scope === "task_list") {
				await showTasks(ctx);
				return { action: "handled" };
			}
			intent = { scope: writeScope(result.scope), operation: result.operation };
		} catch (error) {
			trace(ctx, "input_blocked", { text: event.text, error: (error as Error).message });
			ctx.ui.notify(`${(error as Error).message} Nothing was sent to the model.`, "error");
			return { action: "handled" };
		}
	});

	pi.on("tool_call", (event, ctx) => {
		if (event.toolName === SHOW_CODE) return showable() ? undefined : { block: true, reason: "Showing code in the editor is unavailable; cite path:line in text instead." };
		if (!specMode() || event.toolName === ASK) return;
		if (READ_TOOLS.includes(event.toolName)) {
			// The files under .pi/pi-pair are the developer's view of the spec; the contract is the model's.
			const home = join(ctx.cwd, HOME);
			const inside = strings(event.input).find((value) => { const path = resolve(ctx.cwd, value); return path === home || path.startsWith(home + sep); });
			if (inside === undefined) return;
			trace(ctx, "read_blocked", { tool: event.toolName, path: inside });
			return { block: true, reason: `Nothing under ${HOME} is read in Spec: the contract carries the spec's content, and pair_write changes it.` };
		}
		if (event.toolName !== WRITE) {
			trace(ctx, "tool_blocked", { tool: event.toolName });
			return { block: true, reason: "Spec plans, it never implements: reading, questions, showing code and pair_write are available here. No shell, edits, delegation or other tools." };
		}
		const contract = currentContract(ctx);
		if (!allowsWrite(contract!, event.input)) {
			trace(ctx, "write_blocked", { phase: contract?.phase, scope: contract?.write, input: event.input });
			return { block: true, reason: `Outside this turn's scope: it may write ${scopeText(contract)}.` };
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		await adapter;
		if (!pair) return;
		show(ctx); // Reads the files, so a hand edit that reopened the spec is seen here, before the tools are set.
		syncTools();
		const fallback = showable() && pi.getActiveTools().includes(SHOW_CODE) ? "" : "\nShowing code in the editor is unavailable; cite path:line in text instead.";
		if (!spec) return { systemPrompt: `${event.systemPrompt}\n\nPair is on without a spec. Pair tools are available; no spec is being written.${fallback}` };
		if (ready) return { systemPrompt: `${event.systemPrompt}\n\n${working(ctx)}${fallback}` };
		return { systemPrompt: `${event.systemPrompt}\n\nPair Spec: plan and agree, never implement. Follow the hidden turn contract.${fallback}`, message: hidden(ctx) };
	});

	/** Pairing with an approved spec: the plan is in the prompt, and the ordinary tools are back. */
	function working(ctx: ExtensionContext) {
		const { parsed, view } = loadSpec(ctx.cwd);
		const current = nextTask(view);
		return `Pair is on with the approved spec ${specPath()}; it is the plan, so read a task there before working on it.\n`
			+ `Goal: ${parsed.goal}\n${parsed.order ? `Order: ${parsed.order}\n` : ""}Tasks:\n`
			+ view.tasks.map((task) => `${task.id}: ${task.name}${task.completed ? " · done" : task.id === current?.id ? " · next" : ""}`).join("\n")
			+ "\nThe developer marks a task done from /pair:tasks; say when one looks finished.";
	}

	pi.on("context", (event, ctx) => {
		// A contract from an earlier step never survives into a later request, including after Pair off.
		const messages = event.messages.filter((message) => message.role !== "custom" || message.customType !== CONTRACT);
		if (!specMode()) return { messages };
		messages.push({ role: "custom", ...hidden(ctx), timestamp: Date.now() });
		return { messages };
	});
}
