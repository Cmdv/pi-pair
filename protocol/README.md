# pi-pair v1 adapter contract

[`v1.schema.json`](v1.schema.json) is the canonical JSON Schema for payloads.
The TypeScript client validates it with TypeBox, the same library Pi uses for
its tools. Select a `$defs` entry; the document root is a schema collection.

## RPC envelope

Pi sends an `extension_ui_request` with `method: "input"`, a correlation `id`,
`title: "pi-pair:v1:<method>"`, and JSON arguments in `placeholder`.
Reply with `{"type":"extension_ui_response","id":"<same id>","value":"<JSON reply>"}`.
Pi owns correlation, cancellation and the five-second timeout.

| Method | Arguments schema | Successful reply schema |
|--------|------------------|-------------------------|
| `handshake` | `handshakeRequest` | `handshakeReply` |
| `show` | `showRequest` | `reply`, with `ok: true` |
| `annotate` | `annotateRequest` | `reply`, with `ok: true` |
| `present` | `presentRequest` | `reply`, with `ok: true` |
| `clear` | `clearRequest` | `reply`, with `ok: true` |
| `buffer_state` | `bufferStateRequest` | `bufferStateReply` |

Every method may instead return `{"ok":false,"error":"explanation"}` (the
failure branch of `reply`). Malformed replies are errors, not acknowledgements.
Timeout/cancellation stops waiting; the editor may already have applied a
request. There is no automatic retry or assumed rollback.

## Handshake

Request: `{"version":1,"coreVersion":"0.1.0"}` (the actual package version).
Reply: `{"version":1,"editor":"example","capabilities":["annotate","clear"]}`.

Only v1 is accepted. Capabilities are independent; unknown names are ignored.
The editor label does not select behaviour.  The optional `"showWhenOff":true`
is the developer's editor setting to keep `pair_show_code` while pairing is
off; without it, showing code is for pairing only. The frontend already knows the
Pi process's project directory and resolves message paths relative to it.

## Annotations and presentation

```json
{"id":"opaque-core-generated-id","path":"src/index.ts","start_line":4,"end_line":8,"note":"Why this matters","kind":"note"}
```

- The core generates an ID per annotation and returns it in the tool result.
  Treat IDs as opaque. Receiving the same ID again replaces that annotation.
- `kind` is only `"note"` in v1. Notes are plain text, never executable content.
- Paths use `/` separators and non-empty components; no absolute paths,
  `.`/`..`, backslashes, colons or ASCII control characters.
- Lines are positive safe integers, 1-based and inclusive. In addition to
  schema validation, require `end_line >= start_line`.
- The adapter checks the range against the current buffer, preserving unsaved
  edits. It must keep resolved paths inside the project, including symlink
  resolution; lexical schema validation alone is not a filesystem boundary.
- `annotate` records one highlight/note without visiting a window. `present`
  accepts `{annotations:[...]}`, installs every note and opens the first one.
  Use a single-item array for one note.
- Reply `{"ok":true}` only after updating the display. On an error, return
  the failure reply. Neither operation edits source text or saves a buffer.

## Show

`show` accepts `{"ranges":[{"path":"src/index.ts","start_line":4,"end_line":8}]}`:
the same path and line rules, with no IDs or notes. Highlight every range and
open the first without taking keyboard focus. These highlights are temporary:
the next `show` replaces them, and the developer can dismiss them locally.
The core does not record them and `clear` does not touch them. Reject the
whole request if any range is invalid, keeping the previous highlights.

The core's `pair_show_code` tool needs `show` for its `show` mode and
`present` for its `annotate` mode; it is offered when either is available.

## Buffer state

`buffer_state` accepts `{"paths":["docs/plan.md"]}`: unique project-relative
paths under the same rules. Reply with one entry per path, in request order:
`{"ok":true,"buffers":[{"path":"docs/plan.md","open":true,"modified":true}]}`.
`open` means the editor has a buffer for the file; `modified` means that
buffer has unsaved changes. Never open, save or change a buffer to answer.
A path with no buffer, including one for a missing file, is closed and
unmodified. Reject the whole request if any path is invalid or resolves
outside the project.

The core asks before Pi edits or writes the active spec and blocks the edit
while the spec's buffer is modified. If the request fails or the reply is
malformed, the core warns the developer and lets the edit go ahead.

## Clear

Request either `{"ids":["id-1","id-2"]}` or `{"all":true}`, never both.
The ID list must be non-empty and unique. Unknown IDs and an already-empty
set are successful no-ops. Clear only this Pi connection's annotations, not
other clients' overlays or the developer's unrelated editor state.

The core exposes `/pair:clear all` and `/pair:clear <id> [id ...]`, including
while pairing is off. Switching off alone never clears annotations. Confirmed
annotate/clear actions are recorded in the core session; display replay is
not automatic. The editor holds display state, not the authoritative history.
