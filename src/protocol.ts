import { Type } from "typebox";
import wire from "../protocol/v1.schema.json" with { type: "json" };
import type { Answers, Question } from "./ask.ts";

export type Annotation = {
	id: string;
	path: string;
	start_line: number;
	end_line: number;
	note: string;
	kind: "note";
};
export type Range = { path: string; start_line: number; end_line: number };
export type RangeInput = {
	path: string;
	start_line: number;
	end_line?: number;
	note?: string;
};
export type Clear = { ids: string[] } | { all: true };
export type BufferState = { path: string; open: boolean; modified: boolean };

// JSON is the shared contract; these wrappers supply TypeScript types without
// copying validation rules into a second implementation.
export const handshakeRequestSchema = Type.Unsafe<{ version: 1; coreVersion: string }>(wire.$defs.handshakeRequest);
export const handshakeReplySchema = Type.Unsafe<{ version: 1; editor: string; capabilities: string[]; showWhenOff?: boolean }>(wire.$defs.handshakeReply);
export const annotationSchema = Type.Unsafe<Annotation>(wire.$defs.annotateRequest);
export const presentSchema = Type.Object({ annotations: Type.Array(annotationSchema, { minItems: 1 }) }, { additionalProperties: false });
export const clearSchema = Type.Unsafe<Clear>(wire.$defs.clearRequest);
export const replySchema = Type.Unsafe<{ ok: true } | { ok: false; error: string }>(wire.$defs.reply);
export const askRequestSchema = Type.Unsafe<{ questions: Question[] }>(wire.$defs.askRequest);
export const askReplySchema = Type.Unsafe<{ ok: true; answers: Answers }>(wire.$defs.askReply);

const fields = wire.$defs.annotateRequest.properties;
// The JSON's $refs don't resolve once a $defs entry is lifted out, so restate them.
export const showSchema = Type.Object({
	ranges: Type.Array(Type.Object({
		path: Type.Unsafe<string>(fields.path),
		start_line: Type.Unsafe<number>(fields.start_line),
		end_line: Type.Unsafe<number>(fields.end_line),
	}, { additionalProperties: false }), { minItems: 1 }),
}, { additionalProperties: false });

export const openSchema = Type.Object({ path: Type.Unsafe<string>(fields.path) }, { additionalProperties: false });
// buffer_state only reports open/modified, so a path is project-relative (inside the project) or absolute
// (a developer-approved external target, which has no project-relative form). A relative escape is still refused.
export const bufferStateSchema = Type.Object({
	paths: Type.Array(Type.Union([Type.Unsafe<string>(fields.path), Type.String({ pattern: "^/" })]),
		{ minItems: 1, uniqueItems: true }),
}, { additionalProperties: false });
export const bufferStateReplySchema = Type.Unsafe<{ ok: true; buffers: BufferState[] }>(wire.$defs.bufferStateReply);

export const showCodeParameters = Type.Object({
	mode: Type.Union([Type.Literal("show"), Type.Literal("annotate")], {
		description: "show: highlight ranges only, no notes; they clear on Escape or the next show.  " +
			"annotate: every range has a note, kept until the developer dismisses it.",
	}),
	ranges: Type.Array(Type.Object({
		path: Type.Unsafe<string>({ ...fields.path, description: "Project-relative path with / separators; no . or .. components." }),
		start_line: Type.Unsafe<number>(fields.start_line),
		end_line: Type.Optional(Type.Unsafe<number>({ ...fields.end_line, description: "Inclusive; defaults to start_line." })),
		note: Type.Optional(Type.Unsafe<string>({ ...fields.note, description: "Plain-text note.  Required in annotate mode; not allowed in show mode." })),
	}, { additionalProperties: false }), { minItems: 1, description: "The editor opens the first range; annotate's n/p navigation cycles through all." }),
}, { additionalProperties: false });
