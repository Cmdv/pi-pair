import { appendFileSync, constants, existsSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { access, mkdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { Type } from "typebox";
import { createEditToolDefinition, createWriteToolDefinition, withFileMutationQueue, type ExtensionAPI, type ExtensionCommandContext,
	type ExtensionContext, type MessageStartEvent, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Box, Spacer, Text } from "@earendil-works/pi-tui";
import { answeredQuestions, findTask, optionsOf, slug, summaryOf, template } from "./tasks.ts";
import { emptyState, stateFile, writeState, type Status, type TaskStatus } from "./state.ts";
import { apply, loadSpec as loadFile, save, writeParameters } from "./proposals.ts";
import { allowsWrite, CONTRACT, contractFor, guidance, READ_TOOLS, WEB_TOOLS, WRITE, type Contract, type Intent } from "./contracts.ts";
import { ask as askEditor, bufferState, handshake, open as openEditor, rpcTransport } from "./adapter.ts";
import { NEEDS, SHOW_CODE, registerShow, type Connected } from "./show.ts";
import { answerText, askEach, askParameters, askTabs, type Answers, type Question } from "./ask.ts";
import { CHECKPOINTS, describe, profileFrom, profileParameters, profileQuestions, STARTING, type Profile } from "./settings.ts";
import { pairContract, pairGuidance, type Request } from "./requests.ts";
import { changedSpans, changes, checkWrite, confirmedParent, landing, openSlice, recordWrite, within } from "./effects.ts";
import pkg from "../package.json" with { type: "json" };

const ENTRY = "pi-pair";
const ASK = "pair_ask";
const PROFILE = "pair_profile";
const FILES = "pair_files";
const REPORT = "pair_report";
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
const SHOW_SPEC = "Show spec file";
const CONFIRM = "Confirm";
const ALLOW_WRITE = "Allow this write";
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
type Next = "tasks" | "task" | "progress";
/** The model's hand-back: it reports a slice implemented or blocked, and code returns to the task. It never completes the task. */
type Report = { task: string; status: "implemented" | "blocked"; summary: string };

/** Pair is on or off, with an optional spec. PI_PAIR_EDITOR separately opts into adapter discovery. */
export default function (pi: ExtensionAPI) {
	let pair = false;
	let spec: string | undefined;
	let selection: string | undefined; // The task being filled in or reviewed; none means the task list.
	let intent: Intent | undefined; // Where the developer typed a change, which scopes what the model may write.
	let next: Next | undefined;
	let report: Report | undefined; // The last pair_report, read once by agent_settled so the return is one dialog.
	let requested: string | undefined; // A change request from our dialog, already scoped by where it was typed.
	let revision = 0; // Any scope change invalidates a picker or dialog that is already open.
	let ready = false; // The spec is approved: Pair works on it, and the spec machinery stands down.
	let profile: Profile | undefined; // The spec's saved profile, or the session's without one; none until the developer chooses.
	let loose: Profile | undefined; // Without a spec the profile lives in memory, for this session only.
	// Ordinary Pair's requests: recorded when they arrive, served once Pi delivers them, and never saved.
	let pending: Request[] = [];
	let serving: Request | undefined; // The request the model is working on now; its confirmed files, if any, are the only edit grant.
	let requests = 0;
	let waiting: "confirm" | "review" | undefined; // Shown in the status, nothing more.
	let traced: string | undefined; // The session the trace log is on, so separate runs read apart.
	let adapter: Promise<Connected | undefined> = Promise.resolve(undefined);
	let adapterAbort: AbortController | undefined;
	let capabilities = new Set<string>();
	let whenOff = false;
	let loadout: string[] | undefined; // The developer's own active tools, kept while Pair narrows them and given back after.

	const preferred = () => profile ?? STARTING;
	/** Anything resolved before Pair last changed (Stop, task, session) grants nothing. */
	const stale = (request: Request) => request.generation !== revision;
	const grant = () => serving && !stale(serving) && !serving.paused && serving.files?.length && serving.slice ? serving : undefined;
	// The profile lives with the spec, not the session, so a task picked up in a new session needs no choosing again.
	const snapshot = () => ({ pair, spec, selection });
	const savedProfile = (ctx: ExtensionContext) => { try { return spec ? loadSpec(ctx.cwd).state.profile : undefined; } catch { return undefined; } };
	/** Who drives, and the part of the profile that applies to them; then whether the model has files or Pair waits on the developer.
	 * Q1: assistance is what the developer gets while they drive, so the model driving shows its checkpoint instead. */
	const arrangement = () => {
		const { driver, assistance, checkpoint } = preferred();
		const live = grant()?.files?.length;
		return [...(driver === "human" ? ["you drive", assistance] : ["model driving", CHECKPOINTS[checkpoint].toLowerCase()]),
			...(live ? [`${live} file${live === 1 ? "" : "s"} confirmed`] : []),
			...(waiting === "confirm" ? ["confirm files"] : waiting === "review" ? ["review"] : [])].join(" · ");
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
			? [[...(approve ? [approve] : []), ...(tasks ? ["/pair:tasks Tasks"] : []), ...(pairing ? ["/pair:profile Profile"] : []), "/pair:exit Exit Pair"].join(" · ")]
			: undefined);
	}

	function setPair(on: boolean, name: string | undefined, ctx: ExtensionContext) {
		revision++;
		if (spec !== name || !on) selection = undefined;
		intent = undefined;
		next = undefined;
		report = undefined;
		requested = undefined;
		waiting = undefined;
		pair = on;
		spec = name;
		profile = spec ? savedProfile(ctx) : loose;
		pi.appendEntry(ENTRY, snapshot());
		show(ctx);
		syncTools();
	}

	/** Which extension, or Pi itself, provides a tool now: a name proves nothing, since any extension can take one over. */
	const origin = (name: string) => pi.getAllTools().find((tool) => tool.name === name)?.sourceInfo;
	/** Both drivers can inspect with Pi's read tools, bash and the named web tools; approvals belong to the permission policy.
	 * Pair guards edit/write itself, and stale or paused requests cannot run commands or web tools. */
	const permitted = (name: string) => name === ASK || name === PROFILE || (name === FILES && preferred().driver === "model")
		|| (READ_TOOLS.includes(name) && origin(name)?.source === "builtin")
		|| ((WEB_TOOLS.includes(name) || (name === "bash" && origin(name)?.source === "builtin"))
			&& (!serving || (!stale(serving) && !serving.paused)))
		|| (SOURCE_TOOLS.includes(name) && !!grant() && origin(name)?.path === origin(ASK)?.path);

	function syncTools() {
		const active = pi.getActiveTools();
		// Keep research tools activated by web_enable mid-session, without activating any disabled web capability ourselves.
		const own = [...new Set([...(loadout ?? active.filter((name) => ![SHOW_CODE, ASK, PROFILE, FILES, WRITE].includes(name))),
			...active.filter((name) => WEB_TOOLS.includes(name))])];
		// Pair narrows while it is on, and after Stop while a request it resolved is still being served.
		const narrowed = pair || !!serving;
		loadout = narrowed ? own : undefined;
		// Pi enables only read/bash/edit/write by default; add discovery tools without changing the loadout restored on exit.
		const tools = !narrowed ? [...own] : specMode() ? [...new Set([...own.filter((name) => READ_TOOLS.includes(name) || WEB_TOOLS.includes(name)), ...READ_TOOLS])]
			: [...new Set([...own, ...READ_TOOLS])].filter(permitted);
		if (showable()) tools.push(SHOW_CODE);
		if (pair) tools.push(ASK);
		if (pair && !specMode()) tools.push(...[PROFILE, FILES].filter(permitted));
		// With an approved spec, either driver can hand a slice back so the task list returns; it never completes the task.
		if (pair && !!spec && !specMode()) tools.push(REPORT);
		if (specMode()) tools.push(WRITE);
		pi.setActiveTools(tools);
	}

	async function openSpec(ctx: ExtensionContext) {
		if (!spec) return;
		const name = spec;
		const connected = await adapter;
		if (!pair || spec !== name) return;
		if (!connected?.capabilities.has("open")) return ctx.ui.notify(`Spec file: ${specPath()}`, "info");
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

	const currentContract = (ctx: ExtensionContext): Contract | undefined => {
		if (!specMode()) return undefined;
		try {
			const contract = contractFor(loadSpec(ctx.cwd), selection, intent);
			contract.tools.push(...pi.getActiveTools().filter((name) => WEB_TOOLS.includes(name)));
			return contract;
		} catch { return undefined; }
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
		: (SOURCE_TOOLS.includes(name) || name === FILES) && preferred().driver === "human"
			? "The developer drives: suggest the change for them to make, or propose the model driving with pair_profile."
		: SOURCE_TOOLS.includes(name) ? "Propose the files with pair_files first: the model changes only files the developer confirms."
		: READ_TOOLS.includes(name) || name === "bash" ? `${name} is provided by an extension here, not by Pi, so Pair does not let the model use it while pairing.`
		: `${name} is not available while pairing. Use the available tools or ask the developer instead.`;

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

	const said = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

	pi.registerTool({
		name: PROFILE,
		label: "Propose profile",
		description: "Propose a change to the developer's Pair profile (who drives, assistance, checkpoint), with one line on why. "
			+ "The developer's profile dialog opens with your proposal selected; only their Submit changes it, and it applies at once.",
		parameters: profileParameters,
		executionMode: "sequential",
		async execute(_id, params, signal, _update, ctx) {
			if (!pair || specMode()) throw new Error("There is no Pair profile to change here.");
			if (!ctx.hasUI) throw new Error("No dialogs available; ask in chat instead.");
			const { reason, ...fields } = params;
			const current = preferred();
			const proposed = Object.fromEntries(Object.entries(fields).filter(([key, value]) => value !== undefined && value !== current[key as keyof Profile]));
			if (!Object.keys(proposed).length) return said(`The profile is already ${describe(current)}.`);
			trace(ctx, "profile_proposed", { ...proposed, reason });
			const chosen = await chooseProfile(ctx, { proposed, reason, signal });
			return said(chosen ? `The developer set the profile: ${describe(chosen)}. It applies now.`
				: `The developer kept the profile: ${describe(preferred())}. Carry on within it.`);
		},
	});

	pi.registerTool({
		name: FILES,
		label: "Propose files",
		description: "When the model drives: before your first edit, propose the exact files you will change, each with one line on why. "
			+ "The developer confirms or cancels; you may change only confirmed files, until this request ends. Call it again to add files.",
		parameters: Type.Object({
			files: Type.Array(Type.Object({
				path: Type.String({ minLength: 1, description: "Project-relative file path" }),
				why: Type.String({ minLength: 1, maxLength: 200, description: "One line on what changes there" }),
			}, { additionalProperties: false }), { minItems: 1, maxItems: 20 }),
		}, { additionalProperties: false }),
		executionMode: "sequential",
		async execute(_id, params, signal, _update, ctx) {
			if (!pair || specMode()) throw new Error("There are no files to propose here.");
			const request = serving;
			if (preferred().driver !== "model" || !request || stale(request) || request.paused) throw new Error(refusal(FILES, request));
			if (!ctx.hasUI) throw new Error("No dialogs available; ask in chat which files you may change.");
			return said(await proposeFiles(ctx, request, params.files, signal));
		},
	});

	pi.registerTool({
		name: REPORT,
		label: "Report slice",
		description: "Say the current task's slice is implemented and checked, or that you are blocked, with a short summary. "
			+ "Code brings the developer back to the task so they can review it; it never marks the task done. Call it once, then stop.",
		parameters: Type.Object({
			task: Type.String({ minLength: 1, description: "The id of the task you are implementing." }),
			status: Type.Union([Type.Literal("implemented"), Type.Literal("blocked")], { description: "implemented when the slice is done and checked; blocked when you cannot finish it." }),
			summary: Type.String({ minLength: 1, maxLength: 1000, description: "A short note on what changed and how you checked it, or what blocked you." }),
		}, { additionalProperties: false }),
		executionMode: "sequential",
		async execute(_id, params, _signal, _update, ctx) {
			if (!pair || !spec || specMode()) throw new Error("There is no task to report on here.");
			if (!selection) throw new Error("No task is being implemented, so there is nothing to report; ask the developer which task.");
			if (params.task !== selection) throw new Error(`This session is implementing task ${selection}, not ${params.task}.`);
			const current = loadSpec(ctx.cwd).view.tasks.find((item) => item.id === selection);
			if (!current) throw new Error(`The spec has no task ${selection}.`);
			if (current.completed) throw new Error(`Task ${selection} is already done; nothing to report.`);
			report = { task: selection, status: params.status, summary: params.summary };
			next = "progress";
			trace(ctx, "reported", { task: selection, status: params.status, summary: params.summary });
			return said(params.status === "implemented"
				? "Noted. Stop here: don't keep editing. The developer reviews the slice and marks the task done."
				: "Noted as blocked. Stop here and hand back to the developer.");
		},
	});

	/** The only way the model gets files: it proposes them, code checks them as it checks every write, and the developer confirms
	 * with one key. Each file's baseline is taken at that moment. A cancelled or late answer grants nothing. A1: until task 7, an
	 * outside file is accepted only under a root already approved for this spec. */
	async function proposeFiles(ctx: ExtensionContext, request: Request, files: { path: string; why: string }[], signal?: AbortSignal) {
		const before = revision;
		const roots = approvedRoots(ctx);
		const project = realpathSync.native(ctx.cwd);
		const fresh = new Map<string, { path: string; why: string }>(); // By where each really lands, so an alias is one file.
		for (const file of files) {
			const target = landing(ctx.cwd, file.path, roots);
			if (!target) throw new Error(`${file.path} is outside the project, or among Pair's own files, so it cannot be proposed.`);
			if (statSync(target, { throwIfNoEntry: false })?.isFile() === false) throw new Error(`${file.path} is not a file; propose files, not directories.`);
			if (!request.slice?.targets.has(target) && !fresh.has(target)) fresh.set(target, file);
		}
		if (!fresh.size) return `Already confirmed: ${request.files!.join(", ")}.`;
		const list = [...fresh].map(([target, { path, why }]) => `  ${path} \u2014 ${why}${within(project, target) ? "" : " (outside this project)"}`).join("\n");
		waiting = "confirm";
		show(ctx);
		let choice: string | undefined;
		try {
			choice = await ctx.ui.select(`The model proposes to change${request.files?.length ? ", besides the files already confirmed" : ""}:\n${list}\n`
				+ "Confirm lets it edit exactly these until it stops; Cancel lets it edit none of them.", [CONFIRM, CANCEL], { signal });
		} finally {
			waiting = undefined;
			show(ctx);
		}
		const paths = [...fresh.values()].map(({ path }) => path);
		if (revision !== before || serving !== request || request.paused || preferred().driver !== "model") {
			throw new Error("Pair changed while the developer was asked, so nothing was confirmed.");
		}
		if (choice !== CONFIRM) {
			trace(ctx, "files_cancelled", { request: request.id, files: paths });
			return `The developer cancelled: change none of ${paths.join(", ")}. Ask in chat what they want instead.`;
		}
		request.slice = openSlice(ctx.cwd, paths, roots, request.slice);
		request.files = [...(request.files ?? []), ...paths];
		trace(ctx, "files_confirmed", { request: request.id, files: paths });
		show(ctx);
		syncTools();
		return `Confirmed: ${paths.join(", ")}. Change only ${request.files.join(", ")}, with edit for files that exist and write only for new ones.`;
	}

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
			if (!contract) throw new Error(`Outside this turn's scope: it may write ${scopeText(contract)}.`);
			if (!allowsWrite(contract, params as Record<string, unknown>)) await allowWider(ctx, contract, params, signal);
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

	/** Q2: a write outside the turn's scope asks the developer first, one key, one write. Declined, cancelled or late, it is refused. */
	async function allowWider(ctx: ExtensionContext, contract: Contract, params: { kind: string; id?: string; names?: string[] }, signal?: AbortSignal) {
		const before = revision;
		const name = params.id ? findTask(loadSpec(ctx.cwd).parsed, params.id)?.name : undefined;
		const what = params.kind === "task" ? `task ${params.id}${name ? `: ${name}` : ""}`
			: `the goal, order or task list${params.names?.length ? `, adding ${params.names.join(", ")}` : ""}`;
		const choice = ctx.hasUI ? await ctx.ui.select(`The model wants to write ${what}. This turn may write ${scopeText(contract)}.`, [ALLOW_WRITE, CANCEL], { signal }) : undefined;
		if (choice === ALLOW_WRITE && revision === before) return trace(ctx, "write_allowed", { scope: contract.write, params });
		trace(ctx, "write_declined", { scope: contract.write, params });
		throw new Error(`The developer did not allow writing ${what}; this turn may write ${scopeText(contract)}. Ask in chat instead.`);
	}

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
		intent = { scope: id ? "task" : "any" };
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
		const options = view.tasks.map((task) => `${task.id}. ${task.name} · ${label(task)}`);
		const choice = await ctx.ui.select(`Spec tasks · ${spec}`, [...options, NEW_TASK, DESCRIBE, ...(view.approvable ? [APPROVE_SPEC] : []), CANCEL, SHOW_SPEC]);
		if (revision !== before || choice === undefined || choice === CANCEL) return;
		if (choice === SHOW_SPEC) return openSpec(ctx);
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

	/** The one profile dialog, for the first choice, /pair:profile and the model's pair_profile proposals. Only Submit changes it:
	 * the latest choice is saved with the spec, or kept in memory without one. Cancelling, or a reply after Pair changed, keeps what
	 * was there. Submitted mid-turn, it applies to the rest of the turn: the tools now, and the contract on the next model call. */
	async function chooseProfile(ctx: ExtensionContext, proposal: { proposed?: Partial<Profile>; reason?: string; signal?: AbortSignal } = {}) {
		const before = revision;
		const current = preferred();
		const chosen = profileFrom(current, await askDeveloper(ctx, profileQuestions(current, proposal.proposed, proposal.reason), proposal.signal));
		if (!chosen || revision !== before) return undefined;
		const file = specFile(ctx.cwd);
		if (file) await withFileMutationQueue(file, async () => {
			await requireSaved(ctx, [stateFile(specPath())], "The spec's state");
			if (revision === before) writeState(stateFile(file), { ...loadFile(file).state, profile: chosen });
		});
		if (revision !== before) return undefined;
		if (!file) loose = chosen;
		profile = chosen;
		// Taking the keyboard back is immediate: no grant outlives it. Other changes leave the request it is working on alone.
		if (chosen.driver === "human") for (const request of [serving, ...pending]) {
			if (request?.files?.length && !request.paused) request.paused = "The developer is driving now.";
		}
		trace(ctx, "profile", { ...chosen });
		announce(`Pair profile: ${describe(chosen)}.` + (chosen.driver === "model" ? " The model edits only files you confirm." : ""));
		show(ctx);
		syncTools();
		return chosen;
	}

	/** The external project roots the developer approved for the current spec; empty without a spec. */
	function approvedRoots(ctx: ExtensionContext): string[] {
		const file = specFile(ctx.cwd);
		try { return file ? (loadFile(file).state.externalRoots ?? []) : []; } catch { return []; }
	}
	/** The pairing-mode list: the plan as progress. A task is implemented, marked done or reset from here. */
	async function showProgress(ctx: ExtensionContext, before: number): Promise<void> {
		pi.appendEntry(ENTRY, snapshot());
		show(ctx);
		const { view } = loadSpec(ctx.cwd);
		const current = nextTask(view);
		const rows = view.tasks.map((task) => `${task.id}. ${task.name}${task.completed ? " · done" : task.id === current?.id ? " · next" : ""}`);
		const choice = await ctx.ui.select(`Pair tasks · ${spec}`, [...rows, CANCEL, SHOW_SPEC]);
		if (revision !== before || choice === undefined || choice === CANCEL) return;
		if (choice === SHOW_SPEC) return openSpec(ctx);
		const task = view.tasks[rows.indexOf(choice)];
		if (!task) return;
		if (task.completed) {
			// Marked by mistake: a reset keeps the agreement and drops the completion.
			const action = await ctx.ui.select(`Task ${task.id}: ${task.name} · done`, [RESET_TASK, GO_BACK]);
			if (revision !== before || action === undefined) return;
			if (action === RESET_TASK) await resetTask(ctx, task.id);
			return showTasks(ctx);
		}
		return taskAction(ctx, task, before);
	}

	/** A not-done task's actions. The order puts the likely next step first: the developer reviewing a model's report sees Mark done
	 * or, for a blocked slice, Implement + prompt first. Choosing the task picks the work; the profile says who drives. */
	async function taskAction(ctx: ExtensionContext, task: TaskStatus, before: number, order = [IMPLEMENT, IMPLEMENT_PROMPT, MARK_DONE, CANCEL]) {
		const action = await ctx.ui.select(`Task ${task.id}: ${task.name}`, order);
		if (revision !== before || action === undefined || action === CANCEL) return;
		if (action === MARK_DONE) { await markDone(ctx, task.id); return showTasks(ctx); }
		const extra = action === IMPLEMENT_PROMPT ? (await ctx.ui.input(`Task ${task.id}: ${task.name}`, "Anything to add before the model starts"))?.trim() : "";
		if (revision !== before || extra === undefined) return;
		implement(ctx, task, extra);
	}

	/** The model reported a slice: announce its summary and open the task's actions, with the likely next step first
	 * (Mark done for an implemented slice, Implement + prompt for a blocked one). The developer still owns completion. */
	async function returnToTask(ctx: ExtensionContext, done: Report): Promise<void> {
		const before = revision;
		pi.appendEntry(ENTRY, snapshot());
		const task = loadSpec(ctx.cwd).view.tasks.find((item) => item.id === done.task);
		if (!task || task.completed) return;
		announce(`The model reports task ${task.id}: ${task.name} ${done.status}: ${done.summary}`);
		show(ctx);
		const order = done.status === "blocked"
			? [IMPLEMENT_PROMPT, IMPLEMENT, MARK_DONE, CANCEL]
			: [MARK_DONE, IMPLEMENT, IMPLEMENT_PROMPT, CANCEL];
		return taskAction(ctx, task, before, order);
	}

	/** A request as it arrives: the developer's words and the task in hand, stamped with the revision so a later Stop, task or
	 * session change leaves it stale. It grants nothing; files come only from pair_files. */
	const newRequest = (text: string, task?: string): Request => ({ id: ++requests, generation: revision, text, task });

	/** The approved spec's task being worked on, as compact context; none without an approved spec. */
	function taskInHand(ctx: ExtensionContext) {
		if (!pair || !spec || !ready) return undefined;
		try { const task = nextTask(loadSpec(ctx.cwd).view); return task && `${task.id}: ${task.name}`; } catch { return undefined; }
	}

	/** The task handed over, here or in a fresh session. Who changes the code is the request's contract, not this line. */
	const implementation = (task: { id: string; name: string }, how = "Pair on") =>
		`${how} task ${task.id}: ${task.name} from ${specPath()}. Read the task first: the spec is the plan, and its discussion is already settled there.`;

	function implement(ctx: ExtensionContext, task: { id: string; name: string }, extra: string) {
		selection = task.id;
		revision++; // A new task start: whatever arrived before it is stale.
		pi.appendEntry(ENTRY, snapshot());
		const request = newRequest(`${implementation(task)}${extra ? `\n\n${extra}` : ""}`, `${task.id}: ${task.name}`);
		trace(ctx, "implementing", { task: task.id, request: request.id, ...(extra ? { prompt: extra } : {}) });
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
		if (!profile) await chooseProfile(ctx);
	}

	pi.registerCommand("pair:approve", {
		description: "Approve the task being reviewed, or the spec from the task list",
		handler: async (_args, ctx) => {
			try { await ctx.waitForIdle(); await approve(ctx); }
			catch (error) { trace(ctx, "approval_blocked", { error: (error as Error).message }); ctx.ui.notify((error as Error).message, "error"); }
		},
	});

	pi.registerCommand("pair:profile", {
		description: "Choose who drives, how much assistance and when to check in",
		handler: async (_args, ctx) => {
			if (!pair) return ctx.ui.notify("Pair is off; /pair turns it on.", "warning");
			await ctx.waitForIdle();
			try { await chooseProfile(ctx); } catch (error) { ctx.ui.notify((error as Error).message, "error"); }
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
		const created = !existsSync(file);
		if (created) {
			mkdirSync(join(cwd, SPECS), { recursive: true });
			writeFileSync(file, template(name.replace(/\s+/g, " ")), { flag: "wx" });
			if (!existsSync(stateFile(file))) writeState(stateFile(file), emptyState());
		}
		return { id, created };
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
					if (!profile) await chooseProfile(ctx);
					return;
				}
				const { id, created } = ensureSpec(ctx.cwd, picked.name);
				loadSpec(ctx.cwd, id); // Validate before activating.
				setPair(true, id, ctx);
				if (created) {
					const activated = revision;
					await openSpec(ctx);
					if (activated !== revision) return;
				}
				const { parsed, view } = loadSpec(ctx.cwd);
				if (!parsed.tasks.length) return announce(OPENING);
				if (picked.edit && view.ready) {
					await reopenSpec(ctx);
					show(ctx);
					syncTools();
					announce(`${id} is open for editing; approve it again once it is right.`);
					return showTasks(ctx, false);
				}
				if (view.ready && !profile) await chooseProfile(ctx);
				await showTasks(ctx);
			} catch (error) { ctx.ui.notify((error as Error).message, "error"); }
		},
	});

	function restore(ctx: ExtensionContext) {
		revision++;
		next = undefined;
		report = undefined;
		requested = undefined;
		intent = undefined;
		waiting = undefined;
		// Only the active branch counts, and a slice's grant never outlives its turn. Old session settings are ignored: the spec holds the profile.
		const entry = ctx.sessionManager.getBranch().findLast((entry) => entry.type === "custom" && entry.customType === ENTRY) as
			{ data?: { pair?: boolean; spec?: string; selection?: string } } | undefined;
		const name = entry?.data?.spec;
		spec = typeof name === "string" && name && slug(name) === name ? name : undefined;
		pair = entry?.data?.pair === true && (name === undefined || spec !== undefined);
		selection = entry?.data?.selection;
		try {
			if (pair && spec && !loadSpec(ctx.cwd).parsed.tasks.some((task) => task.id === selection)) selection = undefined;
		} catch (error) { pair = false; ctx.ui.notify(`Pair not resumed: ${(error as Error).message}`, "error"); }
		profile = spec ? savedProfile(ctx) : loose;
		show(ctx);
		syncTools();
	}

	pi.on("session_start", (_event, ctx) => {
		resetAdapter();
		loose = undefined;
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
		// The review boundary: confirmed files end with the turn, and the developer reviews what changed.
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
				say(`The model's slice${ended.task ? ` of task ${ended.task}` : ""} is finished, and its files are closed. `
					+ (files.length ? `Changed: ${where.join(", ")}; each span encloses every change in its file and may include unchanged lines.` : "No files changed.")
					+ (since.length ? ` ${since.join(", ")} changed again after the model's last write; that later change is not the model's.` : "")
					+ (partial ? " The slice was interrupted, so its changes may be partial." : "")
					+ " Review the changes and any check results above; further changes need files confirmed again.",
					false, { review: { request: ended.id, task: ended.task ?? null, partial, files } });
				show(ctx);
			}
		}
		const todo = next;
		const reported = report;
		next = undefined;
		report = undefined;
		// The model reported a slice: with an approved spec still live and that task still selected, return to it for review.
		if (todo === "progress") {
			if (!pair || !spec || specMode() || !reported || selection !== reported.task) return;
			trace(ctx, "settled", { todo });
			try { await returnToTask(ctx, reported); }
			catch (error) { ctx.ui.notify((error as Error).message, "error"); }
			return;
		}
		if (!specMode()) return;
		trace(ctx, "settled", { todo: todo ?? "nothing" });
		if (!todo) return;
		try { await (todo === "tasks" ? showTasks(ctx) : taskMenu(ctx)); }
		catch (error) { ctx.ui.notify((error as Error).message, "error"); }
	});

	pi.on("input", (event, ctx) => {
		if (pair && !specMode()) {
			// D1: new words may withdraw what is running, so a live slice ends here; the model proposes its files again if it still needs them.
			const live = grant();
			if (live) {
				live.paused = "The developer sent another message; wait for it.";
				trace(ctx, "slice_suspended", { request: live.id });
				show(ctx);
				syncTools();
			}
			pending.push(newRequest(event.text, taskInHand(ctx)));
			return;
		}
		if (!specMode()) return;
		trace(ctx, "input", { text: event.text, source: event.source });
		// Typed from Describe changes, the scope is where it was typed; anything else gets the step's own scope.
		if (event.text === requested) requested = undefined;
		else intent = undefined;
		// An unreadable spec stops the conversation rather than guessing at it.
		try { loadSpec(ctx.cwd); } catch (error) {
			trace(ctx, "input_blocked", { text: event.text, error: (error as Error).message });
			ctx.ui.notify(`${(error as Error).message} Nothing was sent to the model.`, "error");
			return { action: "handled" as const };
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
		show(ctx);
		syncTools();
	});

	/** A model call Pair never recorded: it reads only. */
	const unresolved = (text: string): Request => ({ ...newRequest(text), paused: "This reached the model without Pair recording it." });

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
		if (event.toolName === ASK || WEB_TOOLS.includes(event.toolName)) return;
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
			return { block: true, reason: "Spec plans, it never implements: reading, web research, questions, showing code and pair_write are available here. No shell, edits, delegation or other tools." };
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
			+ "\nWhen the current task or agreed slice is implemented and checked, call pair_report; never claim a task is done, as the developer marks it done.";
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
			content: pairGuidance(pairContract(serving, preferred(), stale(serving), showable())) });
		return { messages };
	});
}
