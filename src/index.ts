import { appendFileSync, constants, existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { access, mkdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createEditToolDefinition, createWriteToolDefinition, withFileMutationQueue, type ExtensionAPI, type ExtensionCommandContext,
	type ExtensionContext, type MessageStartEvent, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Box, Spacer, Text } from "@earendil-works/pi-tui";
import { answeredQuestions, findTask, optionsOf, slug, summaryOf, template } from "./tasks.ts";
import { emptyState, stateFile, writeState, type Status, type TaskStatus } from "./state.ts";
import { apply, loadSpec as loadFile, save, writeParameters } from "./proposals.ts";
import { classifierFactory, type Classifier, type ClassifierFactory } from "./classifier.ts";
import { allowsWrite, CONTRACT, contractFor, guidance, READ_TOOLS, WRITE, type Contract, type Intent } from "./contracts.ts";
import { triage, writeScope } from "./triage.ts";
import { ask as askEditor, bufferState, handshake, open as openEditor, rpcTransport } from "./adapter.ts";
import { NEEDS, SHOW_CODE, registerShow, type Connected } from "./show.ts";
import { answerText, askEach, askParameters, askTabs, type Answers, type Question } from "./ask.ts";
import { CHECKPOINTS, describe, DRIVERS, GUIDE_ME, HELP, parseTargets, PRESETS, presetOf, readSettings, type Settings } from "./settings.ts";
import { arrange, pairContract, pairGuidance, propose, TASK_START, UNCLEAR, type Request } from "./requests.ts";
import { changedSpans, changes, checkWrite, confirmedParent, landing, openSlice, recordWrite, within } from "./effects.ts";
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
const DESCRIBE = "Describe changes…";
const BACK = "Back to the list";
const APPROVE_SPEC = "Approve spec";
const KEEP_WORKING = "Keep working on the tasks";
const AGREE = "Agree";
const IMPLEMENT = "Implement task";
const IMPLEMENT_PROMPT = "Implement task + prompt";
const MARK_DONE = "Mark task as done";
const RESET_TASK = "Reset task";
const GO_BACK = "Go back";
const CANCEL = "Cancel";
const ADJUST_SETTINGS = "Adjust driver, help and check-ins…";
const CONFIRM = "Confirm";
const CHOOSE_FILES = "Choose files…";
const PICK_EXTERNAL = "Select files/dirs outside the project";
const DONT_ASK = "No — and don't ask again for this spec";
const OPENING = "What are you trying to solve?";
const SOURCE_TOOLS = ["edit", "write"];
const STOP = "Pair has no readable spec. Report the problem and wait; do not call tools.";
type Message = MessageStartEvent["message"];
const messageText = (message: Message) => "content" in message ? typeof message.content === "string" ? message.content
	: message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") : "";
/** Every string in a tool's input, wherever it sits, so a path is found whichever field carries it. */
const strings = (value: unknown): string[] =>
	typeof value === "string" ? [value] : value && typeof value === "object" ? Object.values(value).flatMap(strings) : [];
/** What code does once the model's turn has settled; derived from what was written, so repeated writes agree. */
type Next = "tasks" | "task";

/** Pair is on or off, with an optional spec. PI_PAIR_EDITOR separately opts into adapter discovery. */
export default function (pi: ExtensionAPI, factory: ClassifierFactory = classifierFactory) {
	let pair = false;
	let spec: string | undefined;
	let selection: string | undefined; // The task being filled in or reviewed; none means the task list.
	let intent: Intent | undefined; // The last triage result, which scopes what the model may write.
	let next: Next | undefined;
	let requested: string | undefined; // A change request from our dialog is already scoped; do not triage it again.
	let revision = 0; // Any scope change invalidates a picker or dialog that is already open.
	let classifier: Classifier | undefined;
	let classifierFailed = false;
	let ready = false; // The spec is approved: Pair works on it, and the spec machinery stands down.
	let settings: Settings | undefined; // Confirmed preferences; none means Guide me until the developer chooses.
	// Ordinary Pair's requests: resolved when they arrive, served once Pi delivers them, and never saved.
	let pending: Request[] = [];
	let serving: Request | undefined; // The request the model is working on now; its slice, if any, is the only edit grant.
	let requests = 0;
	let waiting: "confirm" | "review" | undefined; // Shown in the status, nothing more.
	let traced: string | undefined; // The session the trace log is on, so separate runs read apart.
	let adapter: Promise<Connected | undefined> = Promise.resolve(undefined);
	let adapterAbort: AbortController | undefined;
	let capabilities = new Set<string>();
	let whenOff = false;
	let loadout: string[] | undefined; // The developer's own active tools, kept while Pair narrows them and given back after.

	const preferred = () => settings ?? GUIDE_ME;
	/** Anything resolved before Pair last changed (Stop, settings, task, session) grants nothing. */
	const stale = (request: Request) => request.generation !== revision;
	const grant = () => serving && !stale(serving) && !serving.paused && serving.files?.length && serving.slice ? serving : undefined;
	// Every entry is a full snapshot, so selecting a task never drops the settings.
	const snapshot = () => ({ pair, spec, selection, ...(settings ? { settings } : {}) });
	/** Who has the keyboard now, what they prefer, how much help, and whether Pair is waiting on them. */
	const arrangement = () => {
		const { driver } = preferred();
		// Help is this request's, which may differ from the default when the developer asked for more or less.
		const { assistance } = serving && !stale(serving) ? serving : preferred();
		return [grant() ? "model driving this slice" : driver === "model" ? "you drive · model preferred" : "you drive", assistance,
			...(waiting === "confirm" ? ["confirm slice"] : waiting === "review" ? ["review"] : [])].join(" · ");
	};
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
		// Ordinary Pair says who drives and how much help; Spec only plans.
		const pairing = pair && !specMode();
		if (pairing) where += ` · ${arrangement()}`;
		ctx.ui.setStatus("pair", pair ? `🧑‍🤝‍🧑 ${where}` : undefined);
		// One line, and only the shortcuts that apply here.
		ctx.ui.setWidget?.("pi-pair", pair
			? [[...(approve ? [approve] : []), ...(tasks ? ["/pair:tasks Tasks"] : []), ...(pairing ? ["/pair:settings Settings"] : []), "/pair:exit Exit Pair"].join(" · ")]
			: undefined);
	}

	function setPair(on: boolean, name: string | undefined, ctx: ExtensionContext) {
		revision++;
		if (spec !== name || !on) selection = undefined;
		intent = undefined;
		next = undefined;
		requested = undefined;
		waiting = undefined;
		pair = on;
		spec = name;
		pi.appendEntry(ENTRY, snapshot());
		show(ctx);
		syncTools();
	}

	/** Which extension, or Pi itself, provides a tool now: a name proves nothing, since any extension can take one over. */
	const origin = (name: string) => pi.getAllTools().find((tool) => tool.name === name)?.sourceInfo;
	/** What the model may use in ordinary Pair: Pi's own read tools, questions, and during a confirmed slice Pair's guarded edit
	 * and write. Everything else, shell and unknown tools included, is denied. */
	const permitted = (name: string) => name === ASK
		|| (READ_TOOLS.includes(name) && origin(name)?.source === "builtin")
		|| (SOURCE_TOOLS.includes(name) && !!grant() && origin(name)?.path === origin(ASK)?.path);

	function syncTools() {
		const own = loadout ?? pi.getActiveTools().filter((name) => name !== SHOW_CODE && name !== ASK && name !== WRITE);
		// Pair narrows while it is on, and after Stop while a request it resolved is still being served.
		const narrowed = pair || !!serving;
		loadout = narrowed ? own : undefined;
		// Spec keeps its allowlist; Pair offers only what the developer had and Pair permits, so nothing disabled comes back.
		const tools = !narrowed ? [...own] : specMode() ? [...new Set([...own.filter((name) => READ_TOOLS.includes(name)), ...READ_TOOLS])]
			: own.filter(permitted);
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

	/** Whether the editor holds unsaved changes to PATHS. Throws when an editor is expected but cannot say: a timeout, a malformed
	 * reply, no connection or no buffer_state. With no editor configured, the saved files are all there is. */
	async function unsaved(ctx: ExtensionContext, paths: string[]) {
		const connected = await adapter;
		if (!connected) {
			if (ctx.mode === "rpc" && process.env.PI_PAIR_EDITOR?.trim()) throw new Error("Editor connection unavailable; cannot check unsaved buffers.");
			return false;
		}
		if (!connected.capabilities.has("buffer_state")) throw new Error("The connected editor cannot check unsaved buffers.");
		return (await bufferState(connected.send, paths, connected.signal)).some((buffer) => buffer.modified);
	}

	/** The developer's own edits win: nothing is written while a file is modified in the editor, or when that cannot be checked. */
	async function requireSaved(ctx: ExtensionContext, paths = [specPath(), stateFile(specPath())], what = "The spec") {
		let modified: boolean;
		try { modified = await unsaved(ctx, paths); } catch (error) { throw new Error(`${(error as Error).message} Nothing was written.`); }
		if (modified) throw new Error(`${what} has unsaved changes in the editor. Save them first; nothing was written.`);
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

	/** Pi's own edit and write, under the same names and schemas, so no unguarded copy stays reachable. Outside Pair they are
	 * Pi's tools unchanged; in Pair they run Pi's code with file operations bound to the request the call was made in. */
	for (const [name, define] of [["edit", createEditToolDefinition], ["write", createWriteToolDefinition]] as const) {
		const build = define as (cwd: string, options?: { operations?: ReturnType<typeof guardedOps> }) => ToolDefinition<any, any, any>;
		pi.registerTool({
			...build(process.cwd()),
			async execute(id, params, signal, update, ctx) {
				const request = serving;
				const tool = !pair && !request ? build(ctx.cwd) : build(ctx.cwd, { operations: guardedOps(ctx, request, name, signal) });
				return tool.execute(id, params, signal, update, ctx);
			},
		});
	}

	/** One Pair tool call's file operations. Pi runs them inside its queue for the file, after any approval; each write checks
	 * the slice, the file and the editor, then checks the slice and the disk again with nothing awaited before writing. */
	function guardedOps(ctx: ExtensionContext, request: Request | undefined, tool: "edit" | "write", signal?: AbortSignal) {
		const live = () => {
			if (signal?.aborted) throw new Error("Operation aborted");
			if (!request || grant() !== request) throw new Error(`${refusal(tool, request)} Nothing was written.`);
			return request.slice!;
		};
		return {
			readFile: (path: string) => readFile(path),
			access: (path: string) => access(path, constants.R_OK | constants.W_OK),
			mkdir: async (dir: string) => {
				if (!confirmedParent(live(), dir)) throw new Error(`${relative(ctx.cwd, dir)} is not where a confirmed file goes; nothing was written.`);
				await mkdir(dir, { recursive: true });
			},
			writeFile: async (path: string, content: string) => {
				const first = checkWrite(live(), path, tool);
				const root = realpathSync.native(ctx.cwd);
				const name = relative(root, first);
				// The editor checks unsaved buffers by path: project-relative inside, but an approved external
				// target has no project-relative form, so hand the editor its absolute real path instead.
				const check = within(root, first) ? [...new Set([name, live().targets.get(first)!])] : [first];
				await requireSaved(ctx, check, name);
				const slice = live(); // Revoked, paused or cancelled while the editor answered.
				const target = checkWrite(slice, path, tool); // The disk again; nothing is awaited from here to the write.
				writeFileSync(target, content, "utf-8");
				recordWrite(slice, target, content);
			},
		};
	}

	/** Why Pair refuses a tool for this request. */
	const refusal = (name: string, request?: Request) =>
		request && stale(request) ? "This request was made before Pair changed; nothing it implied is granted. Ask the developer to send it again."
		: request?.paused ? `Changes are paused: ${request.paused}`
		: SOURCE_TOOLS.includes(name) && grant() ? `${name} is provided by another extension here, so Pair cannot check its writes; it is not used while pairing.`
		: SOURCE_TOOLS.includes(name) ? "The developer drives this request: suggest the change for them to make. Only a slice they confirm lets the model edit."
		: READ_TOOLS.includes(name) ? `${name} is provided by an extension here, not by Pi, so Pair does not let the model use it while pairing.`
		: `While pairing the model reads, asks and shows code; ${name} is not available. Suggest a command for the developer to run instead.`;

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
			const answers = await askDeveloper(ctx, questions, signal);
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
			// Once the turn settles, the list comes back after drafting, and a task comes back once it is written.
			next = !selection ? "tasks" : task?.populated ? "task" : undefined;
			return { content: [{ type: "text" as const, text: `Saved ${summary}.` }], details: { summary } };
		},
	});

	const scopeText = (contract?: Contract) =>
		!contract ? "nothing" : contract.write === "task" ? `task ${contract.task} only` : contract.write === "tasks" ? "the goal, the order and new tasks" : "any task";

	const openQuestions = (ctx: ExtensionContext, id: string) =>
		findTask(loadSpec(ctx.cwd).parsed, id)?.questions.filter((item) => !item.checked) ?? [];

	/** A task's standing, as the list and its own dialog both put it. */
	const label = (task: TaskStatus) => `${task.agreed ? "agreed" : task.populated ? "written" : "empty"}${task.open ? ` · ${task.open} open` : ""}`;

	/** Questions go to the editor's tabbed dialog when it has one, else Pi's own tabs, else one dialog at a time. */
	async function askDeveloper(ctx: ExtensionContext, questions: Question[], signal?: AbortSignal): Promise<Answers> {
		const editor = ctx.mode === "rpc" ? await adapter : undefined;
		if (editor?.capabilities.has("ask")) return askEditor(editor.send, questions, signal ? AbortSignal.any([signal, editor.signal]) : editor.signal);
		if (ctx.mode === "tui" && typeof ctx.ui.custom === "function") return askTabs(ctx.ui, questions, signal);
		return askEach(ctx.ui, questions, signal);
	}

	/** Step 11: the task's open questions, put by code from what the model wrote, each with its options and the
	 * recommendation first. Answering every one is the developer's decision on the task, so it agrees it. */
	async function answerTask(ctx: ExtensionContext, before: number): Promise<void> {
		const id = selection!;
		const original = findTask(loadSpec(ctx.cwd).parsed, id)!;
		const open = original.questions.filter((item) => !item.checked).slice(0, 5);
		trace(ctx, "asking", { task: id, questions: open.map((item) => item.id) });
		const answers = await askDeveloper(ctx, open.map((item) => ({ label: item.id, question: item.text, options: optionsOf(item) })));
		if (revision !== before || selection !== id) return;
		const given: Record<string, string> = {};
		open.forEach((item, i) => { const answer = answers[i]; if (answer) given[item.id] = answer.answer; });
		// Dismissing the questions decides nothing, and leaves nothing on screen.
		if (!Object.keys(given).length) return;
		const file = specFile(ctx.cwd)!;
		let agreed = false;
		await withFileMutationQueue(file, async () => {
			await requireSaved(ctx);
			const snapshot = loadFile(file);
			const task = findTask(snapshot.parsed, id);
			if (!task) throw new Error(`The spec has no task ${id}.`);
			save(file, snapshot, apply(snapshot, { kind: "task", id, baseHash: original.hash, sections: { Questions: answeredQuestions(task, given) } }));
			const written = loadFile(file);
			const updated = findTask(written.parsed, id)!;
			agreed = updated.questions.every((item) => item.checked);
			if (agreed) {
				written.state.tasks[id] = { agreedHash: updated.hash, completedHash: null };
				writeState(stateFile(file), written.state);
			}
		});
		trace(ctx, "answered", { task: id, answers: given, agreed });
		announce(agreed ? `Task ${id}: ${original.name} approved.` : `Answers recorded for task ${id}; ${openQuestions(ctx, id).length} still open.`);
		return agreed ? showTasks(ctx) : taskMenu(ctx);
	}

	/** Steps 12 and 13: a written task opens on its summary, with whatever is left to do about it. */
	async function taskMenu(ctx: ExtensionContext): Promise<void> {
		const id = selection;
		if (!id) return;
		const { text, parsed, view } = loadSpec(ctx.cwd);
		const task = view.tasks.find((item) => item.id === id);
		if (!task?.populated) return;
		show(ctx);
		const before = revision;
		const open = openQuestions(ctx, id).length;
		const answer = open ? `Answer ${open} open question${open === 1 ? "" : "s"}` : undefined;
		const detail = findTask(parsed, id)!;
		let title = `Task ${id}: ${task.name} · ${label(task)}\n\n${summaryOf(detail)}`;
		// The frontend folds the full task at the thematic break, without another RPC request.
		if (ctx.mode === "rpc") title += `\n---\n${text.split("\n").slice(detail.start, detail.end).join("\n").trim()}`;
		const choice = await ctx.ui.select(title, [...(answer ? [answer] : []), ...(task.agreed ? [] : [AGREE]), DESCRIBE, BACK]);
		if (revision !== before || selection !== id || choice === undefined) return;
		if (choice === AGREE) return approve(ctx);
		if (choice === DESCRIBE) return describeChanges(ctx);
		if (choice === BACK) return showTasks(ctx);
		if (choice === answer) return answerTask(ctx, before);
	}

	/** The developer's own words, typed where they are and sent as their message; the list, or the task, comes back
	 * once the turn settles. What the model may write follows from where they typed: the list, or the one task. */
	async function describeChanges(ctx: ExtensionContext): Promise<void> {
		const before = revision;
		const id = selection;
		const text = (await ctx.ui.input("Describe changes", "What to change; it may span several tasks"))?.trim();
		if (revision !== before || selection !== id) return;
		if (!text) return id ? taskMenu(ctx) : showTasks(ctx);
		intent = { scope: id ? "task" : "any", operation: "edit" };
		next = id ? "task" : "tasks";
		requested = text;
		trace(ctx, "requested", { text });
		pi.sendUserMessage(text);
	}

	/** Steps 8 and 17: the task list, which is also where the spec itself is approved. */
	async function showTasks(ctx: ExtensionContext, offer = true): Promise<void> {
		if (!pair || !spec) throw new Error("Pick a spec with /pair first.");
		const before = revision;
		intent = undefined;
		// The list is the hub, so the spec itself is in view whenever it is open.
		await openSpec(ctx);
		if (revision !== before) return;
		const { parsed, view } = loadSpec(ctx.cwd);
		// Once the spec is approved the list is the plan as progress, and reads apart from this one.
		if (view.ready) return showProgress(ctx, before);
		selection = undefined;
		pi.appendEntry(ENTRY, snapshot());
		show(ctx);
		// Step 18: with every task agreed, approving the spec is the obvious next thing, so it is offered first.
		if (offer && view.approvable && view.tasks.every((task) => task.agreed)) {
			const choice = await ctx.ui.select("Every task is agreed", [APPROVE_SPEC, KEEP_WORKING]);
			if (revision !== before || choice === undefined) return;
			if (choice === APPROVE_SPEC) return approve(ctx);
		}
		const options = view.tasks.map((task) => `${task.name} · ${label(task)}`);
		const choice = await ctx.ui.select(`Spec tasks · ${spec}`, [...options, NEW_TASK, DESCRIBE, ...(view.approvable ? [APPROVE_SPEC] : []), CANCEL]);
		if (revision !== before || choice === undefined || choice === CANCEL) return;
		if (choice === APPROVE_SPEC) return approve(ctx);
		if (choice === DESCRIBE) return describeChanges(ctx);
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

	/** Code asks, never the model: a preset, or each setting on its own. Cancelling or a stale reply keeps what was there. */
	async function chooseSettings(ctx: ExtensionContext): Promise<void> {
		const before = revision;
		const current = preferred();
		const presets = Object.entries(PRESETS).map(([name, value]) => `${name} · ${describe(value)}`);
		const choice = await ctx.ui.select(`Pair settings · now ${presetOf(current) ?? "custom"}${settings ? "" : " (default)"}: ${describe(current)}`,
			[...presets, ADJUST_SETTINGS, CANCEL]);
		if (revision !== before) return;
		const chosen = choice === ADJUST_SETTINGS ? await adjustSettings(ctx, before) : Object.values(PRESETS)[presets.indexOf(choice!)];
		if (!chosen || revision !== before) return;
		settings = chosen;
		revision++; // Ends any live slice: a new arrangement needs its own confirmation.
		pi.appendEntry(ENTRY, snapshot());
		trace(ctx, "settings", { ...settings });
		announce(`Pair settings: ${presetOf(settings) ?? "custom"}, ${describe(settings)}.`
			+ (settings.driver === "model" ? " The model edits only a slice you confirm, then hands back to you." : ""));
		show(ctx);
	}

	/** Each setting on its own, so help can change without the driver. */
	async function adjustSettings(ctx: ExtensionContext, before: number): Promise<Settings | undefined> {
		const pick = async <T extends string>(title: string, labels: Record<T, string>) => {
			const choice = await ctx.ui.select(title, Object.values(labels));
			return revision === before ? (Object.keys(labels) as T[]).find((key) => labels[key] === choice) : undefined;
		};
		const driver = await pick("Who drives by default?", DRIVERS);
		if (!driver) return;
		const assistance = await pick("How much help?", HELP);
		if (!assistance) return;
		const checkpoint = await pick("When does Pair check in?", CHECKPOINTS);
		return checkpoint && { driver, assistance, checkpoint };
	}

	/** The external project roots the developer approved for the current spec; empty without a spec. */
	function approvedRoots(ctx: ExtensionContext): string[] {
		const file = specFile(ctx.cwd);
		try { return file ? (loadFile(file).state.externalRoots ?? []) : []; } catch { return []; }
	}
	/** Persist one approved external root with the spec. External access needs a spec: its rules live with it, not the project. */
	function approveRoot(ctx: ExtensionContext, root: string) {
		const file = specFile(ctx.cwd); if (!file) return;
		const state = structuredClone(loadFile(file).state);
		const roots = state.externalRoots ?? (state.externalRoots = []);
		if (!roots.includes(root)) { roots.push(root); writeState(stateFile(file), state); trace(ctx, "external", { root }); }
	}
	function muteExternal(ctx: ExtensionContext) {
		const file = specFile(ctx.cwd); if (!file) return;
		const state = structuredClone(loadFile(file).state);
		state.externalMuted = true; writeState(stateFile(file), state);
	}
	function isExternalMuted(ctx: ExtensionContext): boolean {
		const file = specFile(ctx.cwd);
		try { return file ? (loadFile(file).state.externalMuted ?? false) : false; } catch { return false; }
	}
	/** The files the developer last picked for this spec, so the browser opens with them already checked. Not a grant. */
	function savedTargets(ctx: ExtensionContext): string[] {
		const file = specFile(ctx.cwd);
		try { return file ? (loadFile(file).state.targets ?? []) : []; } catch { return []; }
	}
	function saveTargets(ctx: ExtensionContext, targets: string[]) {
		const file = specFile(ctx.cwd); if (!file) return;
		const state = structuredClone(loadFile(file).state);
		state.targets = targets; writeState(stateFile(file), state);
	}
	/** The root of the project a file belongs to: its nearest ancestor with a .git, else the directory it sits in. */
	function projectRootOf(dir: string): string {
		for (let at = dir; ;) {
			if (existsSync(join(at, ".git"))) return realpathSync.native(at);
			const parent = dirname(at);
			if (parent === at) return realpathSync.native(dir);
			at = parent;
		}
	}
	/** The developer-approved override: expand Pair's core security for this spec. */
	async function expandSecurity(ctx: ExtensionContext): Promise<"yes" | "no" | "mute"> {
		const choice = await ctx.ui.select(
			"Expand Pair's core security for this spec?\n"
			+ "By default Pair may only touch files inside this project. Approving lets you add files and folders from outside it — "
			+ "a sibling repo, for example — as targets the model may edit. This approval is recorded with this spec only, and you still "
			+ "confirm every slice.",
			[PICK_EXTERNAL, CANCEL, DONT_ASK]);
		return choice === PICK_EXTERNAL ? "yes" : choice === DONT_ASK ? "mute" : "no";
	}

	/** Pick files by walking the filesystem with ordinary select dialogs, so paths are not typed by hand. Stored names are
	 * project-relative (external ones read like ../sibling/file). SPC ticks a file or a whole directory's direct files; →
	 * or Enter descends into a directory, ← goes up (freely, since browsing is read-only), and C-c C-c is the one way to save and move on.
	 * The spec remembers the last selection, so the browser opens with those files already ticked. Selecting anything outside
	 * the project needs the developer's per-spec approval, which records its project root (git root, else its folder) for the gate.
	 * Returns the saved files, undefined if Pair changed underneath. Cancelling keeps CHOSEN unchanged.
	 * ponytail: one directory at a time, and each render stats the subdirectories to show their [x]; fine for v1. */
	async function browseFiles(ctx: ExtensionContext, before: number, chosen: string[], start?: string): Promise<string[] | undefined> {
		const DESCEND = 0x1d; // The editor marks → with a leading U+001D; plain Enter on a directory (its raw label) also descends.
		const TOGGLE = 0x1e; // The editor marks SPC (tick/untick) with a leading U+001E, so it never navigates.
		const SAVE = "\x06"; // C-c C-c: the one way to save the selection and move on. Any other finish is a cancel.
		const project = realpathSync.native(ctx.cwd);
		const selected = new Set([...savedTargets(ctx), ...chosen]); // Pre-checked from what the spec remembers.
		const name = (abs: string) => relative(project, abs); // Project-relative; external paths read as ../sibling/file.
		const filesIn = (dir: string) => { try { return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(dir, e.name)); } catch { return []; } };
		// May an about-to-be-selected path become a target? Inside the project, yes; outside, only with the per-spec override.
		const allow = async (abs: string): Promise<boolean> => {
			if (within(project, abs) || approvedRoots(ctx).some((r) => within(r, abs))) return true;
			if (!spec) { ctx.ui.notify("Selecting files outside the project needs a spec; the rules live with it.", "warning"); return false; }
			if (isExternalMuted(ctx)) return false;
			const answer = await expandSecurity(ctx);
			if (answer === "mute") { muteExternal(ctx); return false; }
			if (answer !== "yes") return false;
			approveRoot(ctx, projectRootOf(dirname(abs)));
			return true;
		};
		let here = project;
		if (start) { try { here = realpathSync.native(start); } catch { /* fall back to the project root */ } }
		for (;;) {
			let entries: import("node:fs").Dirent[];
			try { entries = readdirSync(here, { withFileTypes: true }); }
			catch { ctx.ui.notify(`Cannot read ${name(here) || "."}.`, "warning"); if (here === project) return chosen; here = dirname(here); continue; }
			const atProject = here === project;
			// Pair's own files and .git are never slice targets, so there is no reason to walk into them.
			const dirs = entries.filter((e) => e.isDirectory() && e.name !== ".git" && !(atProject && e.name === ".pi")).map((e) => e.name).sort();
			const files = entries.filter((e) => e.isFile()).map((e) => e.name).sort();
			const picked = (abs: string) => selected.has(name(abs));
			const fullDir = (abs: string) => { const fs = filesIn(abs); return fs.length > 0 && fs.every(picked); };
			const box = (on: boolean) => (on ? "[x] " : "[ ] ");
			const allSelected = files.length > 0 && files.every((n) => picked(join(here, n)));
			const toggleFile = async (n: string) => { const abs = join(here, n), p = name(abs); if (selected.has(p)) selected.delete(p); else if (await allow(abs)) selected.add(p); };
			const toggleAll = async () => { if (allSelected) files.forEach((n) => selected.delete(name(join(here, n)))); else if (files.length && await allow(join(here, files[0]))) files.forEach((n) => selected.add(name(join(here, n)))); };
			// Tick a whole directory: its direct files only. ponytail: not recursive; descend to add subfolders.
			const toggleDir = async (n: string) => { const sub = filesIn(join(here, n)); if (!sub.length) { here = join(here, n); return; } if (sub.every(picked)) sub.forEach((abs) => selected.delete(name(abs))); else if (await allow(sub[0])) sub.forEach((abs) => selected.add(name(abs))); };
			const items = [
				{ label: "↑..", kind: "up" as const },
				...(files.length ? [{ label: `${box(allSelected)}all`, kind: "all" as const }] : []),
				...dirs.map((n) => ({ label: `${box(fullDir(join(here, n)))}${n}/`, kind: "dir" as const, name: n })),
				...files.map((n) => ({ label: `${box(picked(join(here, n)))}${n}`, kind: "file" as const, name: n })),
				{ label: "Type a path…", kind: "type" as const },
			];
			const where = name(here) || "project root";
			const choice = await ctx.ui.select(`Choose files · ${where}${selected.size ? ` · ${selected.size} selected` : ""}\n`
				+ "SPC ticks · →/Enter into folder · ← up · C-c C-c saves", items.map((i) => i.label));
			if (revision !== before) return undefined;
			if (choice === undefined) return chosen; // Cancel (Esc/q) discards edits and keeps what was already confirmed.
			if (choice === SAVE) { // C-c C-c: the only save. Validate, remember on the spec, and move on.
				try { openSlice(ctx.cwd, [...selected], approvedRoots(ctx)); saveTargets(ctx, [...selected]); return [...selected]; }
				catch (error) { ctx.ui.notify((error as Error).message, "warning"); continue; }
			}
			const mark = choice.charCodeAt(0);
			const descend = mark === DESCEND; // → or Enter on a directory: navigate in.
			const toggle = mark === TOGGLE; // SPC: tick/untick, never navigate.
			const item = items.find((i) => i.label === (descend || toggle ? choice.slice(1) : choice));
			if (!item) continue; // Not one of ours: show the list again.
			if (toggle) { // SPC selects without ever entering a directory.
				if (item.kind === "file") await toggleFile(item.name!);
				else if (item.kind === "dir") { if (filesIn(join(here, item.name!)).length) await toggleDir(item.name!); }
				else if (item.kind === "all") await toggleAll();
			}
			else if (descend) { if (item.kind === "dir") here = join(here, item.name!); }
			else if (item.kind === "up") { const parent = dirname(here); if (parent !== here) here = parent; } // Browsing up is free; the gate still guards selection.
			else if (item.kind === "dir") here = join(here, item.name!); // Enter navigates into the folder.
			else if (item.kind === "all") await toggleAll();
			else if (item.kind === "file") await toggleFile(item.name!);
			else if (item.kind === "type") {
				const text = await ctx.ui.input("Type a path", "Project-relative, separated by commas or spaces");
				if (revision !== before) return undefined;
				// Validate each typed path now, so a bad one is refused here instead of silently blocking Confirm later.
				if (text) try { const add = parseTargets(text); openSlice(ctx.cwd, add, approvedRoots(ctx)); add.forEach((f) => selected.add(f)); } catch (error) { ctx.ui.notify((error as Error).message, "warning"); }
			}
			if (revision !== before) return undefined; // A confirm dialog may have been awaited above.
		}
	}

	/** A model slice starts only here: the arrangement, what it is for and the exact files, confirmed by the developer.
	 * Files proposed or adjusted are never a grant on their own; only Confirm with a valid list is. */
	async function confirmHandoff(ctx: ExtensionContext, title: string, behaviour: string): Promise<string[] | undefined> {
		const before = revision;
		let targets: string[] = savedTargets(ctx); // The spec remembers the last selection; the developer still confirms it.
		waiting = "confirm";
		show(ctx);
		try {
			for (;;) {
				const { assistance, checkpoint } = preferred();
				const choice = await ctx.ui.select(`${title}\n`
					+ `Driver: the model for this slice, then you again at review · Help: ${assistance} · Check-in: ${CHECKPOINTS[checkpoint].toLowerCase()}\n`
					+ `Behaviour: ${behaviour}\nFiles: ${targets.join(", ") || "none yet; Choose files to pick them"}`, [CONFIRM, CHOOSE_FILES, CANCEL]);
				if (revision !== before || (choice !== CONFIRM && choice !== CHOOSE_FILES)) return undefined;
				if (choice === CONFIRM && targets.length) {
					trace(ctx, "handoff", { title, targets });
					return targets;
				}
				if (choice === CONFIRM) { ctx.ui.notify("Choose the files the model may change before confirming.", "warning"); continue; }
				const picked = await browseFiles(ctx, before, targets);
				if (revision !== before || picked === undefined) return undefined;
				targets = picked;
			}
		} finally {
			waiting = undefined;
			show(ctx);
		}
	}

	/** The pairing-mode list: the plan as progress. A task is implemented, marked done or reset from here. */
	async function showProgress(ctx: ExtensionContext, before: number): Promise<void> {
		pi.appendEntry(ENTRY, snapshot());
		show(ctx);
		const { parsed, view } = loadSpec(ctx.cwd);
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
		// Choosing the task picks the work, not the driver: it goes through the same resolver as a typed request.
		const request = await resolveRequest(ctx, "", extra, { ...task, summary: summaryOf(findTask(parsed, task.id)!) });
		if (request && revision === before) implement(ctx, task, extra, request);
	}

	/** The one resolver for ordinary Pair: a typed message, or a task started from the list with the developer's added words.
	 * The classifier only proposes; a model slice needs the developer's confirmation; it is stamped with the revision before any
	 * wait, so a Stop, settings, task or session change meanwhile leaves it stale. Undefined: a task start the developer declined. */
	async function resolveRequest(ctx: ExtensionContext, text: string, words: string, task?: { id: string; name: string; summary: string }): Promise<Request | undefined> {
		const generation = revision;
		const about = task ? `${task.id}: ${task.name}` : taskInHand(ctx);
		const model = words ? await getClassifier(ctx) : undefined;
		const proposal = !words ? TASK_START : model ? await propose(model, words, `Task: ${about ?? "none"}. Now: ${describe(preferred())}.`) : UNCLEAR;
		const plan = arrange(settings, proposal);
		trace(ctx, "resolved", { words, ...proposal, offered: plan.offerSlice });
		let files: string[] | undefined;
		if (plan.offerSlice && revision === generation) {
			files = await confirmHandoff(ctx, task ? `Hand task ${task.id}: ${task.name} to the model?` : "Hand this request to the model?",
				task ? [task.summary, words].filter(Boolean).join("\n\n") : text);
			// Declining a task start sends nothing; declining a typed request leaves the developer driving it.
			if (!files && task) return undefined;
		}
		return { id: ++requests, generation, text, kind: plan.kind, assistance: plan.assistance, checkpoint: plan.checkpoint,
			defaults: settings, task: about, files };
	}

	/** The approved spec's task being worked on, as compact context; none without an approved spec. */
	function taskInHand(ctx: ExtensionContext) {
		if (!pair || !spec || !ready) return undefined;
		try { const task = nextTask(loadSpec(ctx.cwd).view); return task && `${task.id}: ${task.name}`; } catch { return undefined; }
	}

	/** The task handed over, here or in a fresh session. Who changes the code is the request's contract, not this line. */
	const implementation = (task: { id: string; name: string }, how = "Pair on") =>
		`${how} task ${task.id}: ${task.name} from ${specPath()}. Read the task first: the spec is the plan, and its discussion is already settled there.`;

	function implement(ctx: ExtensionContext, task: { id: string; name: string }, extra: string, request: Request) {
		selection = task.id;
		revision++; // A new task start: whatever was resolved before it is stale.
		request.generation = revision;
		pi.appendEntry(ENTRY, snapshot());
		trace(ctx, "implementing", { task: task.id, request: request.id, ...(extra ? { prompt: extra } : {}) });
		const files = request.files ?? [];
		const slice = files.length
			? `\n\nConfirmed slice: change only ${files.join(", ")}. Stop when this slice is done; the developer reviews it and drives again.` : "";
		request.text = `${implementation(task, files.length ? "Implement" : "Pair on")}${extra ? `\n\n${extra}` : ""}${slice}`;
		pending.push(request);
		show(ctx);
		say(request.text, true, { task: task.id, request: request.id });
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

	/** Steps 9–11: a written task opens on its summary and choices; a task added later is filled in first. */
	async function openTask(ctx: ExtensionContext, id: string): Promise<void> {
		selection = id;
		intent = undefined;
		next = undefined;
		pi.appendEntry(ENTRY, snapshot());
		trace(ctx, "task_selected");
		show(ctx);
		await openSpec(ctx);
		if (selection !== id) return;
		const task = loadSpec(ctx.cwd).view.tasks.find((item) => item.id === id);
		if (!task) return;
		if (task.populated) return taskMenu(ctx);
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
		// The spec is approved, so the spec machinery stands down and Pair works on it, once it knows how to pair.
		show(ctx);
		syncTools();
		if (!settings) await chooseSettings(ctx);
	}

	pi.registerCommand("pair:approve", {
		description: "Approve the task being reviewed, or the spec from the task list",
		handler: async (_args, ctx) => {
			try { await ctx.waitForIdle(); await approve(ctx); }
			catch (error) { trace(ctx, "approval_blocked", { error: (error as Error).message }); ctx.ui.notify((error as Error).message, "error"); }
		},
	});

	pi.registerCommand("pair:settings", {
		description: "Choose who drives, how much help and when Pair checks in",
		handler: async (_args, ctx) => {
			if (!pair) return ctx.ui.notify("Pair is off; /pair turns it on.", "warning");
			await ctx.waitForIdle();
			await chooseSettings(ctx);
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
				const kept = { ...snapshot(), selection: task.id };
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

	/** The hard way out: whatever Pair is doing is cancelled, and Pi is ordinary again. */
	async function exitPair(ctx: ExtensionCommandContext) {
		revision++;
		if (!ctx.isIdle()) { ctx.abort(); await ctx.waitForIdle(); }
		trace(ctx, "exited");
		setPair(false, spec, ctx);
		announce("Exited Pair. Your spec is saved; /pair reopens it.");
	}

	pi.registerCommand("pair:exit", {
		description: "Exit Pair altogether: cancel its outstanding work and return to ordinary Pi",
		handler: async (_args, ctx) => exitPair(ctx),
	});

	pi.registerCommand("pair", {
		description: "Pair with an approved spec, without one, or create or edit a spec; /pair <name> opens a spec; /pair:exit leaves Pair",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return ctx.ui.notify("Pair needs a UI for explicit choices.", "warning");
			try {
				revision++;
				const before = revision;
				if (!ctx.isIdle()) await ctx.waitForIdle();
				const picked = args.trim() ? { name: args.trim() } : await pickSpec(ctx);
				if (picked === undefined || before !== revision) return;
				if (picked.name === null) {
					setPair(true, undefined, ctx);
					if (!settings) await chooseSettings(ctx);
					return;
				}
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
				if (view.ready && !settings) await chooseSettings(ctx);
				await showTasks(ctx);
			} catch (error) { ctx.ui.notify((error as Error).message, "error"); }
		},
	});

	function restore(ctx: ExtensionContext) {
		revision++;
		next = undefined;
		requested = undefined;
		intent = undefined;
		waiting = undefined;
		// Only the active branch counts, and only preferences come back: a slice's grant never outlives its turn.
		const entry = ctx.sessionManager.getBranch().findLast((entry) => entry.type === "custom" && entry.customType === ENTRY) as
			{ data?: { pair?: boolean; spec?: string; selection?: string; settings?: unknown } } | undefined;
		settings = readSettings(entry?.data?.settings);
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
	// The loadout is forgotten last, so the next session starts from its own tools, not this one's narrowed set.
	pi.on("session_shutdown", () => { revision++; pending = []; serving = undefined; resetAdapter(); loadout = undefined; });
	pi.on("session_tree", (_event, ctx) => restore(ctx));

	pi.on("agent_settled", async (_event, ctx) => {
		// The review boundary: a model slice ends with its turn, and the developer drives again.
		// Paused or stale, a slice that started still has an effect to review: the confirmed files that differ from their baseline.
		const ended = serving?.slice ? serving : undefined;
		serving = undefined;
		syncTools();
		if (ended) {
			const files = changes(ended.slice!);
			const partial = !!ended.paused || stale(ended);
			trace(ctx, "handed_back", { request: ended.id, task: ended.task, changed: files.map((file) => file.path), partial });
			if (pair) {
				waiting = "review";
				// Where, as text, so review never depends on the editor: path and lines in the model's version of each file.
				const where = files.map((file) => file.after === "" ? `${file.path} (emptied)`
					: `${file.path} ${file.before === null ? "(new) " : ""}lines ${file.span!.start_line}-${file.span!.end_line}`);
				const since = files.filter((file) => file.changedSince).map((file) => file.path);
				say(`The model's slice${ended.task ? ` of task ${ended.task}` : ""} is finished, and you are driving again. `
					+ (files.length ? `Changed: ${where.join(", ")}; each span encloses every change in its file and may include unchanged lines.` : "No files changed.")
					+ (since.length ? ` ${since.join(", ")} changed again after the model's last write; that later change is not the model's.` : "")
					+ (partial ? " The slice was interrupted, so its changes may be partial." : "")
					+ " Pair ran no checks. Review it; another slice needs a new confirmation.",
					false, { review: { request: ended.id, task: ended.task ?? null, partial, files } });
				show(ctx);
			}
		}
		const todo = next;
		next = undefined;
		if (!specMode()) return;
		trace(ctx, "settled", { todo: todo ?? "nothing" });
		if (!todo) return;
		try { await (todo === "tasks" ? showTasks(ctx) : taskMenu(ctx)); }
		catch (error) { ctx.ui.notify((error as Error).message, "error"); }
	});

	pi.on("input", async (event, ctx) => {
		if (pair && !specMode()) {
			// New words may withdraw what is running, so a live slice pauses before anything is awaited.
			const live = grant();
			if (live) {
				live.paused = "The developer sent another message; the slice waits for it.";
				trace(ctx, "slice_suspended", { request: live.id });
				show(ctx);
				syncTools();
			}
			const generation = revision;
			try {
				const request = await resolveRequest(ctx, event.text, event.text);
				if (request) pending.push(request);
			} catch (error) {
				// The message still goes, with the developer's words intact, but changes wait.
				ctx.ui.notify(`Pair could not resolve this request, so changes are paused: ${(error as Error).message}`, "warning");
				const plan = arrange(settings, UNCLEAR);
				pending.push({ id: ++requests, generation, text: event.text, kind: plan.kind, assistance: plan.assistance, checkpoint: plan.checkpoint,
					defaults: settings, paused: "Pair could not resolve this request." });
			}
			return;
		}
		if (!specMode()) return;
		const before = revision;
		try {
			trace(ctx, "input", { text: event.text, source: event.source });
			if (event.text === requested) { requested = undefined; return; }
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

	/** Pi delivers requests later than they arrive (queued steer and follow-ups), so the request served is the one delivered:
	 * matched by text in arrival order, as Pi's own queue matches it, or by id for Pair's own task starts. */
	pi.on("message_start", (event, ctx) => {
		const message = event.message;
		const id = message.role === "custom" && message.customType === ENTRY ? (message.details as { request?: number } | undefined)?.request : undefined;
		if (message.role !== "user" && id === undefined) return;
		const text = messageText(message);
		const i = pending.findIndex((request) => id === undefined ? request.text === text : request.id === id);
		const delivered = i === -1 ? undefined : pending.splice(i, 1)[0];
		// A new message after Stop is ordinary Pi; one queued before Stop is still Pair's, and stale.
		if (!pair && !delivered) { serving = undefined; syncTools(); return; }
		if (pair && spec) {
			// Re-read the spec: one reopened by hand is Spec again, with its own contract and gates.
			show(ctx);
			if (specMode()) { serving = undefined; syncTools(); return; }
		}
		serving = delivered ?? unresolved(text);
		// A confirmed slice takes its baseline now, before the model's first change.
		if (serving.files?.length && !serving.slice && !stale(serving) && !serving.paused) {
			try {
				serving.slice = openSlice(ctx.cwd, serving.files, approvedRoots(ctx));
				trace(ctx, "slice_started", { request: serving.id, files: serving.files });
			} catch (error) {
				serving.paused = `${(error as Error).message} Confirm the slice again.`;
				ctx.ui.notify(`Pair did not start the slice: ${serving.paused}`, "warning");
			}
		}
		show(ctx);
		syncTools();
	});

	/** A model call Pair never resolved: it reads only. */
	const unresolved = (text: string): Request => ({ id: ++requests, generation: revision, text, kind: "unclear",
		assistance: preferred().assistance, checkpoint: preferred().checkpoint, defaults: settings,
		paused: "This reached the model without Pair resolving it." });

	/** read sees the saved file. In Pair, the model is told when the editor holds unsaved changes to it, or cannot say. */
	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "read" || event.isError || !pair || specMode()) return;
		const target = landing(ctx.cwd, String(event.input.path ?? ""));
		if (!target) return;
		const path = relative(realpathSync.native(ctx.cwd), target);
		const modified = await unsaved(ctx, [path]).catch(() => undefined);
		if (modified === false) return;
		const note = modified ? `${path} has unsaved changes in the editor` : `Pair could not check the editor for unsaved changes to ${path}`;
		return { content: [{ type: "text" as const, text: `Pair: ${note}; this is the saved file. Ask the developer to save it or paste the part that matters before commenting on it precisely.` }, ...event.content] };
	});

	pi.on("tool_call", (event, ctx) => {
		if (event.toolName === SHOW_CODE) {
			if (!showable()) return { block: true, reason: "Showing code in the editor is unavailable; cite path:line in text instead." };
			// A slice's notes describe its own work: they go only on lines it actually changed, from its baseline to the model's version.
			const slice = specMode() ? undefined : serving?.slice;
			const input = event.input as { mode?: string; ranges?: { path?: string; start_line?: number; end_line?: number }[] };
			if (!slice || input.mode !== "annotate") return;
			const spans = changedSpans(slice);
			const outside = (input.ranges ?? []).find(({ path = "", start_line = 0, end_line = start_line }) => {
				const span = spans.get(landing(ctx.cwd, path) ?? "");
				return !span || start_line < span.start_line || end_line > span.end_line;
			});
			if (!outside) return;
			trace(ctx, "note_blocked", { request: serving?.id, range: outside });
			const allowed = [...spans.values()].map((span) => `${span.path}:${span.start_line}-${span.end_line}`).join(", ") || "none yet";
			return { block: true, reason: `Notes on this slice go only on lines it changed (${allowed}); ${outside.path}:${outside.start_line} is not one of them. `
				+ "Cite other code as path:line in text." };
		}
		if (!specMode()) {
			const request = serving;
			if (!pair && !request) return; // Ordinary Pi.
			// Pair, or a request it resolved still running after Stop: deny by default. Other handlers' refusals still apply.
			if (!permitted(event.toolName)) {
				trace(ctx, "tool_blocked", { tool: event.toolName, request: request?.id });
				return { block: true, reason: refusal(event.toolName, request) };
			}
			if (!SOURCE_TOOLS.includes(event.toolName)) return;
			// An early answer for a wrong file; the write itself is checked again where it happens.
			try { checkWrite(request!.slice!, String((event.input as { path?: unknown }).path ?? ""), event.toolName as "edit" | "write"); }
			catch (error) {
				trace(ctx, "write_blocked", { tool: event.toolName, request: request?.id, input: event.input });
				return { block: true, reason: (error as Error).message };
			}
			return;
		}
		if (event.toolName === ASK) return;
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
		if (waiting === "review") waiting = undefined; // A new request ends the review.
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
		// A contract from an earlier step never survives into a later request, including after exiting Pair.
		const messages = event.messages.filter((message) => message.role !== "custom" || message.customType !== CONTRACT);
		if (specMode()) {
			messages.push({ role: "custom", ...hidden(ctx), timestamp: Date.now() });
			return { messages };
		}
		// Ordinary Pair: one contract on every model call, tool continuations included, for the request being served.
		if (pair && !serving) serving = unresolved("");
		if (serving) messages.push({ role: "custom", customType: CONTRACT, display: false, timestamp: Date.now(),
			content: pairGuidance(pairContract(serving, stale(serving), showable())) });
		return { messages };
	});
}
