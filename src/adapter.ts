import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import {
	annotationSchema, askReplySchema, bufferStateReplySchema, bufferStateSchema, clearSchema, handshakeReplySchema, handshakeRequestSchema,
	openSchema, presentSchema, replySchema, showSchema, type Annotation, type BufferState, type Clear, type Range,
} from "./protocol.ts";
import { chosen, labelled, type Answers, type Question } from "./ask.ts";

/** TIMEOUT, in milliseconds, defaults to five seconds; 0 waits for as long as the editor takes. */
export type Send = (method: string, args: unknown, signal?: AbortSignal, timeout?: number) => Promise<unknown>;

export function rpcTransport(ctx: ExtensionContext): Send {
	return async (method, args, signal, timeout = 5000) => {
		if (ctx.mode !== "rpc") throw new Error("Adapter transport requires RPC mode.");
		const reply = await ctx.ui.input(
			`pi-pair:v1:${method}`,
			JSON.stringify(args),
			{ signal, timeout },
		);
		if (reply === undefined) throw new Error("Adapter request cancelled or timed out.");
		return JSON.parse(reply);
	};
}

function checked<S extends TSchema>(schema: S, value: unknown, message: string): Static<S> {
	if (!Value.Check(schema, value)) throw new Error(message);
	return value;
}

async function call(send: Send, method: string, args: unknown, signal?: AbortSignal, timeout?: number) {
	signal?.throwIfAborted();
	const reply = await send(method, args, signal, timeout);
	signal?.throwIfAborted(); // Do not record a late acknowledgement in a replacement session.
	if (Value.Check(replySchema, reply) && !reply.ok) throw new Error(`Adapter ${method}: ${reply.error}`);
	return reply;
}

export async function handshake(send: Send, coreVersion: string, signal?: AbortSignal): Promise<{ capabilities: Set<string>; showWhenOff: boolean }> {
	const args = checked(handshakeRequestSchema, { version: 1, coreVersion }, "Invalid adapter handshake request.");
	const reply = checked(handshakeReplySchema, await call(send, "handshake", args, signal),
		"Invalid or incompatible adapter handshake reply.");
	return { capabilities: new Set(reply.capabilities), showWhenOff: reply.showWhenOff === true };
}

export async function annotate(send: Send, annotation: Annotation, signal?: AbortSignal): Promise<void> {
	checked(annotationSchema, annotation, "Invalid annotation: use a project-relative path, positive line numbers and a non-empty note.");
	if (annotation.end_line < annotation.start_line) throw new Error("Annotation end_line must be >= start_line.");
	checked(replySchema, await call(send, "annotate", annotation, signal), "Invalid adapter annotate reply.");
}

export async function present(send: Send, annotations: Annotation[], signal?: AbortSignal): Promise<void> {
	checked(presentSchema, { annotations }, "Invalid presentations: use at least one project-relative path, positive line numbers and non-empty notes.");
	for (const annotation of annotations) {
		if (annotation.end_line < annotation.start_line) throw new Error("Presentation end_line must be >= start_line.");
	}
	checked(replySchema, await call(send, "present", { annotations }, signal), "Invalid adapter present reply.");
}

export async function show(send: Send, ranges: Range[], signal?: AbortSignal): Promise<void> {
	checked(showSchema, { ranges }, "Invalid ranges: use at least one project-relative path and positive line numbers.");
	for (const range of ranges) {
		if (range.end_line < range.start_line) throw new Error("Range end_line must be >= start_line.");
	}
	checked(replySchema, await call(send, "show", { ranges }, signal), "Invalid adapter show reply.");
}

/** Open the actual file without taking chat focus or discarding editor changes. */
export async function open(send: Send, path: string, signal?: AbortSignal): Promise<void> {
	checked(openSchema, { path }, "Invalid open path: use a project-relative file.");
	checked(replySchema, await call(send, "open", { path }, signal), "Invalid adapter open reply.");
}

/** Whether each path is open and modified in the editor, in request order. */
export async function bufferState(send: Send, paths: string[], signal?: AbortSignal): Promise<BufferState[]> {
	checked(bufferStateSchema, { paths }, "Invalid buffer_state paths: use unique non-empty paths.");
	const { buffers } = checked(bufferStateReplySchema, await call(send, "buffer_state", { paths }, signal),
		"Invalid adapter buffer_state reply.");
	if (buffers.length !== paths.length || buffers.some((buffer, i) => buffer.path !== paths[i])) {
		throw new Error("Adapter buffer_state reply does not match the requested paths.");
	}
	return buffers;
}

/** Ask QUESTIONS in the editor's tabbed dialog, waiting for the developer's answers. */
export async function ask(send: Send, questions: Question[], signal?: AbortSignal): Promise<Answers> {
	const shown = questions.map((question) => ({ ...question, options: labelled(question.options) }));
	const { answers } = checked(askReplySchema, await call(send, "ask", { questions: shown }, signal, 0), "Invalid adapter ask reply.");
	if (answers.length !== questions.length) throw new Error("Adapter ask reply does not match the questions.");
	return answers.map((answer) => answer && { ...answer, answer: chosen(answer.answer) });
}

export async function clear(send: Send, selection: Clear, signal?: AbortSignal): Promise<void> {
	checked(clearSchema, selection, "Clear requires either a non-empty list of unique ids or all: true.");
	checked(replySchema, await call(send, "clear", selection, signal), "Invalid adapter clear reply.");
}
