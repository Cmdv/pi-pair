import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MODES, blockReason, parseArgument, pickerOptions, statusText, switchMessage, type State } from "./modes.ts";
import { drafting, handoff, interview, parseSpec, slug, summary, template } from "./spec.ts";
import { bufferState, handshake, rpcTransport } from "./adapter.ts";
import { NEEDS, SHOW_CODE, registerShow, type Connected } from "./show.ts";
import { answerText, ask, askParameters, type Answer } from "./ask.ts";
import pkg from "../package.json" with { type: "json" };

const ENTRY = "pi-pair";
const ASK = "pair_ask";
const READY = "pair_spec_ready";
const FRESH = "Next task in a fresh session";
const HERE = "Next task here";
const REFINE = "Keep refining";
const SPECS = join(".pi", "pi-pair", "specs");
const NEW_SPEC = "New spec…";
const NO_SPEC = "No spec";

/** Modes stay idle until /pair; PI_PAIR_EDITOR, set by an RPC frontend, separately opts into adapter discovery.
 * An environment variable, not a flag, because Pi rejects unknown flags when pi-pair isn't installed. */
export default function (pi: ExtensionAPI) {
	let state: State = "off";
	/** The active spec's slug, kept across modes and while off. */
	let spec: string | undefined;
	let adapter: Promise<Connected | undefined> = Promise.resolve(undefined);
	let adapterAbort: AbortController | undefined;
	let capabilities = new Set<string>();
	/** Whether pair_show_code stays available while pairing is off: the editor's setting, from the handshake. */
	let whenOff = false;

	function syncTools() {
		const tools = pi.getActiveTools().filter((name) => name !== SHOW_CODE && name !== ASK && name !== READY);
		if (showable()) tools.push(SHOW_CODE);
		if (state !== "off") tools.push(ASK);
		if (state !== "off" && spec) tools.push(READY);
		pi.setActiveTools(tools);
	}

	function resetAdapter() {
		adapterAbort?.abort();
		adapterAbort = undefined;
		adapter = Promise.resolve(undefined);
		capabilities = new Set();
		whenOff = false;
		syncTools();
	}

	const showing = () => state !== "off" || whenOff;
	const showable = () => showing() && Object.values(NEEDS).some((capability) => capabilities.has(capability));

	async function requireAdapter(capability: "show" | "present" | "clear" | "buffer_state") {
		const pending = adapter;
		const connected = await pending;
		if (pending !== adapter || !connected || connected.signal.aborted || !connected.capabilities.has(capability)) {
			throw new Error(`Pairing adapter does not support ${capability}.`);
		}
		return connected;
	}

	const show = (ctx: ExtensionContext) => ctx.ui.setStatus("pair", statusText(state, spec));
	const specFile = (cwd: string) => spec && join(cwd, SPECS, `${spec}.md`);
	const readSpec = (cwd: string) => {
		const file = specFile(cwd);
		return file && existsSync(file) ? parseSpec(readFileSync(file, "utf8")) : undefined;
	};
	/** The active spec's path when a tool's input names it.  Pi's tools strip a leading @. */
	const specTarget = (cwd: string, input: Record<string, unknown>) => {
		const file = specFile(cwd);
		return file && typeof input.path === "string" && resolve(cwd, input.path.replace(/^@/, "")) === file ? file : undefined;
	};
	/** Per spec file, the hash of the content Pi last read or wrote, so it can't overwrite edits it hasn't seen. */
	const seen = new Map<string, string>();
	const digest = (file: string) => existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : undefined;

	function setState(next: State, ctx: ExtensionContext, name: string | undefined) {
		if (next === state && name === spec) return;
		const from = state;
		const picked = name && (name !== spec || from === "off");
		state = next;
		spec = name;
		pi.appendEntry(ENTRY, { mode: state, spec });
		show(ctx);
		syncTools();
		// A newly picked spec: interview while it's being written, else hand over its next task.
		const parsed = picked && next !== "off" ? readSpec(ctx.cwd) : undefined;
		const ask = parsed && drafting(parsed) ? interview(join(SPECS, `${spec}.md`)) : undefined;
		const nextTask = parsed && !ask ? handoff(parsed) : undefined;
		// Idle: the next turn's system prompt carries the mode, so just tell the
		// developer and queue the next task for Pi; an interview starts now.
		// Mid-turn: steer Pi.
		if (ctx.isIdle()) {
			ctx.ui.notify([statusText(next, spec) ?? "Pairing off", nextTask].filter(Boolean).join("\n"), "info");
			if (nextTask) pi.sendMessage({ customType: ENTRY, content: nextTask, display: true }, { deliverAs: "nextTurn" });
			if (ask) pi.sendMessage({ customType: ENTRY, content: ask, display: true }, { triggerTurn: true });
		} else {
			const content = [from !== next && switchMessage(from, next), nextTask ?? ask].filter(Boolean).join("  ");
			pi.sendMessage({ customType: ENTRY, content, display: true }, { deliverAs: "steer" });
		}
	}

	registerShow(pi, showing, requireAdapter, () => adapter);

	pi.registerTool({
		name: ASK,
		label: "Ask",
		description: "Ask the developer 1–3 short questions, each with 2–5 likely answers; they pick one or type their own.  " +
			"Use it for intent, preferences and tradeoffs instead of asking in prose, never for what reading the code would answer.  " +
			"When a spec is active, write their answers into it.",
		parameters: askParameters,
		executionMode: "sequential",
		async execute(_id, params, signal, _update, ctx): Promise<{ content: { type: "text"; text: string }[]; details: { answers: Answer[] } }> {
			if (!ctx.hasUI) throw new Error("No dialogs available; ask in chat instead.");
			const answers = await ask(ctx.ui, params.questions, signal);
			return { content: [{ type: "text", text: answerText(answers, params.questions.length) }], details: { answers } };
		},
	});

	/** Set when the developer picks a fresh session; /pair:next runs once Pi settles. */
	let freshPending = false;

	pi.registerTool({
		name: READY,
		label: "Spec ready",
		description: "Call when the active spec is ready: it has tasks, a Done when check, and every QUESTION and EDGE ticked.  " +
			"The developer picks how to continue: the next task in a fresh session, here, or more refining.",
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute(_id, _params, signal, _update, ctx) {
			const parsed = readSpec(ctx.cwd);
			if (!parsed) throw new Error("No active spec.");
			if (drafting(parsed)) throw new Error("The spec isn't ready: it needs tasks, a Done when check, and every QUESTION and EDGE ticked.");
			const next = handoff(parsed);
			if (!next) throw new Error("The spec has no todo task left; check its Done when items with the developer.");
			if (!ctx.hasUI) throw new Error("No dialogs available; ask the developer in chat how to continue.");
			const choice = await ctx.ui.select(`Spec ready: ${spec}`, [FRESH, HERE, REFINE], { signal });
			freshPending = choice === FRESH;
			const text = choice === FRESH ? "The developer chose a fresh session for the next task; it starts when you finish.  End your turn now with a one-line summary, without further tool calls."
				: choice === HERE ? `The developer chose to start here.  ${next}`
				: choice === REFINE ? "The developer wants to keep refining the spec; ask what to change."
				: "The developer dismissed the choice; carry on in chat.";
			return { content: [{ type: "text", text }], details: { choice } };
		},
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!freshPending || !ctx.isIdle() || ctx.hasPendingMessages()) return;
		freshPending = false;
		// Pi defers this until settling ends, then runs it as a command, which may replace the session.
		pi.sendUserMessage("/pair:next", { expandPromptTemplates: true });
	});

	pi.registerCommand("pair:next", {
		description: "Start the active spec's next task in a fresh session, keeping the mode and spec",
		handler: async (_args, ctx) => {
			const parsed = state !== "off" ? readSpec(ctx.cwd) : undefined;
			const task = parsed && handoff(parsed);
			if (!task) {
				ctx.ui.notify(parsed ? "The active spec has no todo task." : "Pick a mode and spec with /pair first.", "warning");
				return;
			}
			const kept = { mode: state, spec };
			const parentSession = ctx.sessionManager.getSessionFile();
			await ctx.newSession({
				...(parentSession ? { parentSession } : {}),
				setup: async (sessionManager) => { sessionManager.appendCustomEntry(ENTRY, kept); },
				withSession: async (fresh) => { await fresh.sendMessage({ customType: ENTRY, content: task, display: true }, { triggerTurn: true }); },
			});
		},
	});

	/** The spec picker: the active spec, New spec…, No spec, then the other specs.
	 * Returns a name, null for No spec, or undefined when dismissed. */
	async function pickSpec(ctx: ExtensionCommandContext) {
		const dir = join(ctx.cwd, SPECS);
		const names = existsSync(dir) ? readdirSync(dir).filter((file) => file.endsWith(".md")).map((file) => file.slice(0, -3)) : [];
		const active = spec && names.includes(spec) ? [spec] : [];
		const choice = await ctx.ui.select("Spec", [...active, NEW_SPEC, NO_SPEC, ...names.filter((name) => name !== spec)]);
		if (choice === NO_SPEC) return null;
		return choice === NEW_SPEC ? (await ctx.ui.input("Spec name"))?.trim() || undefined : choice;
	}

	/** The slug for spec NAME, creating its file from the template if it doesn't exist yet. */
	function ensureSpec(cwd: string, name: string) {
		const id = slug(name);
		if (!id) return undefined;
		const file = join(cwd, SPECS, `${id}.md`);
		if (!existsSync(file)) {
			mkdirSync(join(cwd, SPECS), { recursive: true });
			writeFileSync(file, template(name), { flag: "wx" });
		}
		return id;
	}

	pi.registerCommand("pair", {
		description: "Pairing mode: pick who drives (me, both, you [spec], off), then the spec",
		getArgumentCompletions: (prefix) =>
			[
				{ value: "me", label: "me", description: MODES.me.label },
				{ value: "both", label: "both", description: MODES.both.label },
				{ value: "you", label: "you", description: MODES.you.label },
				{ value: "off", label: "off", description: "Turn pairing off" },
			].filter((item) => item.value.startsWith(prefix.trim())),
		handler: async (args, ctx) => {
			const parsed = parseArgument(args);
			if (parsed === null) {
				ctx.ui.notify(`Unknown pairing mode "${args.trim()}"; use me, both or you [spec], or off.`, "warning");
				return;
			}
			let next = parsed?.state;
			if (next === undefined) {
				const options = pickerOptions(state);
				const choice = await ctx.ui.select("Pairing mode", options.map(([label]) => label));
				next = options.find(([label]) => label === choice)?.[1];
				if (next === undefined) return;
			}
			if (next === "off") return setState(next, ctx, spec);
			// Then the spec: the one named, else the picker.
			const name = parsed?.name ?? (await pickSpec(ctx));
			if (name === undefined) return;
			const id = name === null ? undefined : ensureSpec(ctx.cwd, name);
			if (name !== null && !id) ctx.ui.notify(`"${name}" has no letters or digits to name a spec file.`, "warning");
			else setState(next, ctx, id);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		resetAdapter();
		seen.clear();
		freshPending = false;
		const entry = ctx.sessionManager
			.getBranch()
			.findLast((entry) => entry.type === "custom" && entry.customType === ENTRY) as
			| { data?: { mode?: State; spec?: string } }
			| undefined;
		const mode = entry?.data?.mode;
		spec = entry?.data?.spec;
		state = mode && mode in MODES ? mode : "off";
		show(ctx);
		syncTools();

		if (ctx.mode !== "rpc") return;
		if (!process.env.PI_PAIR_EDITOR?.trim()) return;
		const send = rpcTransport(ctx);
		const controller = new AbortController();
		adapterAbort = controller;
		// Pi 0.87 starts reading RPC replies only after session_start returns.
		// Keep startup non-blocking; consumers await the connection instead.
		adapter = handshake(send, pkg.version, controller.signal)
			.then((reported) => {
				if (controller.signal.aborted) return undefined;
				capabilities = reported.capabilities;
				whenOff = reported.showWhenOff;
				syncTools();
				return { send, capabilities, signal: controller.signal };
			})
			.catch((error) => {
				if (!controller.signal.aborted) {
					ctx.ui.notify(`Pairing adapter unavailable; continuing without editor integration. ${error instanceof Error ? error.message : String(error)}`, "warning");
				}
				return undefined;
			});
	});

	pi.on("session_shutdown", resetAdapter);

	pi.on("tool_call", (event, ctx) => {
		if (event.toolName === SHOW_CODE && !showable()) {
			return { block: true, reason: "Showing code in the editor is unavailable; cite path:line in text instead." };
		}
		const input = event.input as Record<string, unknown>;
		const file = specTarget(ctx.cwd, input);
		const reason = blockReason(state, event.toolName, input, !!file);
		if (reason) return { block: true, reason };
		if (!file || state === "off" || (event.toolName !== "edit" && event.toolName !== "write")) return;
		const current = digest(file);
		const path = join(SPECS, `${spec}.md`);
		if (current !== undefined && seen.get(file) !== current) {
			return {
				block: true,
				reason: seen.has(file)
					? `${path} changed since you last read it, probably by the developer.  Read it again and keep their changes.`
					: `Read ${path} in full before changing it, so you don't overwrite the developer's edits.`,
			};
		}
		// Only an editor that reports buffer state costs a round trip.
		return capabilities.has("buffer_state") ? unsaved(ctx, path) : undefined;
	});

	/** Block Pi's spec edit while the editor holds unsaved changes to it, warning both sides. */
	async function unsaved(ctx: ExtensionContext, path: string) {
		let modified: boolean;
		try {
			const connected = await requireAdapter("buffer_state");
			[{ modified }] = await bufferState(connected.send, [path], connected.signal);
		} catch (error) {
			// A broken editor must not lock the spec; the hash guard still protects saved edits.
			ctx.ui.notify(`Couldn't check ${path} for unsaved changes (${(error as Error).message}); Pi's edit went ahead.`, "warning");
			return;
		}
		if (!modified) return;
		ctx.ui.notify(`Pi tried to change ${path}, which has unsaved changes in your editor.  Check them and save to keep them; Pi has been told to wait.`, "warning");
		return {
			block: true,
			reason: `${path} has unsaved changes in the developer's editor.  Don't retry or work around this; tell the developer and wait until they save.`,
		};
	}

	pi.on("tool_result", (event, ctx) => {
		const file = specTarget(ctx.cwd, event.input);
		if (!file || event.isError) return;
		// A partial read hasn't seen the whole spec, so it doesn't count.
		const full = event.toolName !== "read" || (event.input.offset === undefined && event.input.limit === undefined);
		if ((event.toolName === "read" || event.toolName === "edit" || event.toolName === "write") && full) {
			const hash = digest(file);
			if (hash) seen.set(file, hash);
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		// Wait for the handshake, so pair_show_code is active from the first turn.
		const connected = await adapter;
		if (state !== "off") {
			const fallback = connected && showable() && pi.getActiveTools().includes(SHOW_CODE)
				? ""
				: "\n\nShowing code in the editor is unavailable; cite path:line in text instead.";
			const parsed = readSpec(ctx.cwd);
			const active = parsed ? `\n\n${summary(join(SPECS, `${spec}.md`), parsed)}` : "";
			return { systemPrompt: `${event.systemPrompt}\n\n${MODES[state].guidance}${fallback}${active}` };
		}
	});
}
