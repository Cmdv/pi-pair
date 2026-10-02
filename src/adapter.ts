import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import {
	annotationSchema, bufferStateReplySchema, bufferStateSchema, clearSchema, handshakeReplySchema, handshakeRequestSchema,
	presentSchema, replySchema, showSchema, type Annotation, type BufferState, type Clear, type Range,
} from "./protocol.ts";

export type Send = (method: string, args: unknown, signal?: AbortSignal) => Promise<unknown>;

export function rpcTransport(ctx: ExtensionContext): Send {
	return async (method, args, signal) => {
		if (ctx.mode !== "rpc") throw new Error("Adapter transport requires RPC mode.");
		const reply = await ctx.ui.input(
			`pi-pair:v1:${method}`,
			JSON.stringify(args),
			{ signal, timeout: 5000 },
		);
		if (reply === undefined) throw new Error("Adapter request cancelled or timed out.");
		return JSON.parse(reply);
	};
}

function checked<S extends TSchema>(schema: S, value: unknown, message: string): Static<S> {
	if (!Value.Check(schema, value)) throw new Error(message);
	return value;
}

async function call(send: Send, method: string, args: unknown, signal?: AbortSignal) {
	signal?.throwIfAborted();
	const reply = await send(method, args, signal);
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

/** Whether each path is open and modified in the editor, in request order. */
export async function bufferState(send: Send, paths: string[], signal?: AbortSignal): Promise<BufferState[]> {
	checked(bufferStateSchema, { paths }, "Invalid buffer_state paths: use unique project-relative paths.");
	const { buffers } = checked(bufferStateReplySchema, await call(send, "buffer_state", { paths }, signal),
		"Invalid adapter buffer_state reply.");
	if (buffers.length !== paths.length || buffers.some((buffer, i) => buffer.path !== paths[i])) {
		throw new Error("Adapter buffer_state reply does not match the requested paths.");
	}
	return buffers;
}

export async function clear(send: Send, selection: Clear, signal?: AbortSignal): Promise<void> {
	checked(clearSchema, selection, "Clear requires either a non-empty list of unique ids or all: true.");
	checked(replySchema, await call(send, "clear", selection, signal), "Invalid adapter clear reply.");
}
