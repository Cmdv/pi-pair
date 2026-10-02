import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { clear, present, show, type Send } from "./adapter.ts";
import { showCodeParameters, type Annotation, type Clear, type Range, type RangeInput } from "./protocol.ts";

export const SHOW_CODE = "pair_show_code";
/** The adapter capability each pair_show_code mode needs. */
export const NEEDS = { show: "show", annotate: "present" } as const;

export type Connected = { send: Send; capabilities: Set<string>; signal: AbortSignal };

const range = ({ path, start_line, end_line }: RangeInput): Range => ({ path, start_line, end_line: end_line ?? start_line });
const plural = (count: number) => `${count} range${count === 1 ? "" : "s"}`;

/** pair_show_code and /pair:clear.  ALLOWED says whether showing code is on now; CONNECT
 * resolves the adapter or throws; CURRENT identifies it, so a stale failure stays quiet. */
export function registerShow(pi: ExtensionAPI, allowed: () => boolean, connect: (capability: "show" | "present" | "clear") => Promise<Connected>, current: () => unknown) {
	pi.registerTool({
		name: SHOW_CODE,
		label: "Show code",
		description: "Open and highlight code ranges in the developer's editor; never edits files.  " +
			"mode \"show\" just points at code: no notes, and the highlights clear on Escape or the next show.  " +
			"mode \"annotate\" attaches a note to every range; notes stay until the developer dismisses them.  " +
			"Opens the first range.  If unavailable, cite path:line in text instead.",
		parameters: showCodeParameters,
		executionMode: "sequential",
		async execute(_id, params, signal): Promise<{ content: { type: "text"; text: string }[]; details: { ranges?: Range[]; annotations?: Annotation[] } }> {
			const { mode, ranges } = params;
			if (mode === "annotate" && ranges.some((r) => !r.note?.trim())) throw new Error("annotate needs a note on every range; use show to highlight without notes.");
			if (mode === "show" && ranges.some((r) => r.note !== undefined)) throw new Error("show takes no notes; use annotate to attach notes.");
			if (!allowed()) throw new Error("Pairing is off.");
			const connected = await connect(NEEDS[mode]);
			// The developer may have switched off while we waited for the handshake.
			if (!allowed()) throw new Error("Pairing is off.");
			const requestSignal = signal ? AbortSignal.any([signal, connected.signal]) : connected.signal;
			if (mode === "show") {
				const shown = ranges.map(range);
				await show(connected.send, shown, requestSignal);
				return { content: [{ type: "text", text: `Showed ${plural(shown.length)}.` }], details: { ranges: shown } };
			}
			const annotations: Annotation[] = ranges.map((r) => ({ ...range(r), note: r.note!, id: randomUUID(), kind: "note" }));
			await present(connected.send, annotations, requestSignal);
			requestSignal.throwIfAborted();
			for (const annotation of annotations) pi.appendEntry("pi-pair-annotation", annotation);
			return { content: [{ type: "text", text: `Annotated ${plural(annotations.length)}.` }], details: { annotations } };
		},
	});

	pi.registerCommand("pair:clear", {
		description: "Clear editor annotations: all or a list of annotation IDs (also works while pairing is off)",
		handler: async (args, ctx) => {
			const ids = args.trim().split(/\s+/);
			if (!args.trim() || (ids.includes("all") && ids.length !== 1)) {
				ctx.ui.notify("Usage: /pair:clear all | <id> [id ...]", "warning");
				return;
			}
			const selection: Clear = ids[0] === "all" ? { all: true } : { ids };
			const pending = current();
			try {
				const connected = await connect("clear");
				await clear(connected.send, selection, connected.signal);
				connected.signal.throwIfAborted();
				pi.appendEntry("pi-pair-clear", selection);
				ctx.ui.notify("Cleared editor annotations.", "info");
			} catch (error) {
				if (pending === current()) ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
