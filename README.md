# pi-pair

Collaborative specs for Pi: agree the tasks before implementing them.

The workflow below describes the checkout redesign, not the older v0.1.0 release.

## Install

1. Pi, which needs Node.js 22.19 or newer.  Then run `pi` and `/login` once:

   ```sh
   npm install -g --ignore-scripts @earendil-works/pi-coding-agent
   # or, on macOS and Linux: curl -fsSL https://pi.dev/install.sh | sh
   ```

2. [pi-permission-system](https://www.npmjs.com/package/@gotgenes/pi-permission-system).
   Use it for ordinary Pi tool approvals; Pair does not replace your permission policy:

   ```sh
   pi install npm:@gotgenes/pi-permission-system
   ```

3. pi-pair, pinned to a release:

   ```sh
   pi install git:github.com/Cmdv/pi-pair@v0.1.0
   ```

4. Optionally, an editor; see [Editors](#editors).

Restart Pi after installing; `pi list` shows what is installed.  To skip the
permission prompts in front of pi-pair's own tools, add these to `permission`
in `~/.pi/agent/extensions/pi-permission-system/config.json`:

```json
"pair_ask": "allow",
"pair_write": "allow",
"pair_show_code": "allow"
```

From a checkout, use `pi install ./pi-pair` or, for one session,
`pi --extension ./pi-pair/src/index.ts`, instead of step 3, not as well as it.

## Pair

- `/pair` asks what to pair on: **Pair with spec** lists the approved specs,
  **Pair no spec** pairs without one, **New spec** asks for a name in a
  **Pair · New spec** prompt, with the save location and an example (cancelling
  creates nothing), and **Edit spec** lists every spec, approved or not. In pi.el
  the naming instructions open a tinted panel below the prompt, with
  submit/cancel controls on the border between the two.
  Only specs with a `.state.json` companion are listed; old-format Markdown
  stays hidden until converted.
- `/pair <name>` opens or creates that spec directly.
- `/pair:exit` leaves Pair and returns to ordinary Pi.

The badge identifies the spec, the open task and how many tasks are agreed.
Pair and the selected spec are saved with the session. **Pair no spec** enables
the pair tools without restricting ordinary Pi.

Works in Pi's terminal UI and RPC frontends. Editor plugins add highlights
and notes; see [Editors](#editors).

## Specs

A new spec starts as `.pi/pi-pair/specs/<name>.md` with a title and empty Goal,
plus `<name>.state.json`. Code asks **What are you trying to solve?** without
calling a model.

From there the spec is written as you talk:

1. Your answer goes to the model, which writes the Goal, the task titles in
   the order the work should be done, and every task's sections in one turn,
   reading the code once rather than once per task. The chat shows progress
   as it goes: **Found 3 tasks. Filling them in…**, then **Finished 1: …**
   for each.
2. A connected editor with `open` support opens the Markdown, filled in, without
   taking chat focus or discarding unsaved changes.
3. The task list opens: pick a task, add one, **Describe changes…** across
   several tasks, or approve the spec. A change request returns to the list
   when the model finishes.
4. A task opens on its **Summary**, with **Answer open questions** first when
   needed, then **Agree**, **Describe changes…**, and **Back to the list**.
   In pi.el, `TAB` or clicking **[more]** expands the full task.
5. Questions and their options come from the spec, not another model turn.
   Code asks and records your answers; answering them all agrees the task and
   returns to the list. You can also agree directly with questions still open.
6. Agreeing a task returns to the list, where **Approve spec** appears. Once
   every task is agreed the list opens on that choice. Approving the spec puts
   you into pairing mode with it, and the message gives the order the model
   advises, from the spec's Order section (see below). A task added later is
   empty, and the model fills that one in on its own.

Messages from the core are badged **Spec** while a spec is being written, and
**Pair** otherwise.

Pair writes through its own `pair_write` tool: code validates the content and
saves it immediately, so the open file *is* the preview—there is no pending
proposal to accept or dismiss. Writing agrees nothing. The only two gates are
approving a task and approving the spec, and both are yours alone. The spec must
be saved in the editor before Pair writes again; unsaved changes block the write
rather than overwrite your edits.

A task that already has content can only be rewritten with the `baseHash` the
turn contract lists for it, so a stale rewrite cannot silently drop your edits.
Filling in an empty task needs no hash: there is no earlier version to lose.

Every step code takes is appended to `.pi/pi-pair/trace.log`, one line each,
grouped by session: which task was selected, what was written, what was refused
and why, and what code did when each turn settled. Read it when a run does
something you did not expect.

A spec is `# Title`, `## Goal`, `## Order` and the tasks. Task headings are
`## 1: Name`, numbered in the order to do them; `## Order` is the model's note
on why that sequence, written with the task list. Each task has `### Summary`,
`### Task`, `### Research`, `### Proposed solution`, `### Questions`,
`### Edge cases`, and `### Done when`. Summary is optional for existing specs;
without it, the dialog uses the first paragraph of Task.
Question/edge markers are `- [ ] Q1:` and `- [ ] E1:` in their respective
sections; whatever shape the model writes the Questions section in, it is saved
as those markers, so code can always tell what is still open. An indented
`  - Options: a | b | c` supplies up to five answers, recommendation first;
without options the answer is typed. Checked questions need an Answer; checked edges need Expected and
Check, or either can record an explicit Out of scope reason. A task counts as
written once Task, Proposed solution and Done when are filled in.

JSON stores the agreement and completion hashes per task, plus whether the spec
itself is agreed. Names and task content stay in Markdown. Manual task edits
reopen that task's agreement; editing the Goal reopens the spec's; editing the
Order reopens nothing, as it is advice rather than content. Invalid
Markdown or state blocks advancement. Missing state means nothing has been
agreed. Old-format specs must be converted manually.

**Talk naturally; there are no intent menus.** Once the breakdown exists, the
local classifier reads each message only to decide what the next turn may write:
this task, another task, the goal, a new task, or the task list. It never
approves, never stops Pair and never picks the task itself—the model resolves
"task 2" or "the retry one" from the contract. Without the model installed,
messages reach Pi unchanged after one warning.

Code binds a hidden contract to each request, leaving your chat text unchanged.
Read/search and the bounded Pair tools are allowed; shell, delegation, source
implementation and direct file edits are blocked until the spec is approved, and
so is reading anything under `.pi/pi-pair`: the contract carries the spec's
content, and the files there are yours. The contract never outlives its request.

In pi.el the composer has a distinct Pair tint, persistent spec/task label and
one line of shortcuts. Keys leave any chat draft untouched:

| Command | Emacs key | Meaning |
|---|---|---|
| `/pair:approve` | `C-c C-a` | Agree the task being reviewed, or the spec from the task list |
| `/pair:tasks` | `C-c C-l` | Open the task list from anywhere |
| `/pair:exit` | `C-c C-x` | Exit Pair: abort its active work and restore ordinary Pi |

Approve is offered only when something can be approved: a written task, or the
spec once at least one task is agreed. Ordinary RET stays chat, and a
conversational "yes" never approves. Stopping preserves the spec and the
discussion. pi.el clears queued steering/follow-up messages first and retains
cancelled text without changing the draft.

Spec's written questions use the same dialogs directly from code, without a
`pair_ask` tool call or a permission prompt. While pairing, Pi asks its own
questions with `pair_ask`: one to five at a time,
each with a few likely answers, the model's recommendation marked
`(recommended)`, and `Other…` to type your own. Each question
has a tab, then a Submit tab: ←/→ or Tab move between them, so you can go
back and change an answer, and submit with some skipped. Skipping or cancelling
approves nothing. The tabs need Pi's terminal UI or an editor with the `ask`
capability (pi.el has it); other frontends ask one question at a time. Allow it
in pi-permission-system (`"pair_ask": "allow"`), or each set of questions is
preceded by a permission prompt.

Pair session entries record what was written, answered, approved, selected,
blocked and stopped, alongside Pi's normal transcript. Inspect the JSONL path
with `/session`; records may contain private text/code.

Pairing works with or without a spec, and approving a spec attaches it, as does
**Pair with spec**. The Spec machinery stands down: the turn contract,
`pair_write` and the tool blocks go with it, and Pi's ordinary tools return. The
system prompt carries the plan instead: the spec's path, goal, order and numbered
tasks, with the next one marked. The status line reads `Pair: <spec> · 2/3`. The
task list is now **Pair tasks**, the plan as progress, apart from the **Spec
tasks** list used while writing. Picking a task offers **Implement task**, which
hands it to the model in this session, **Implement task + prompt**, which first
asks for a note to send with it, and **Mark task as done**, which records it
against the version you see and also agrees it. Done tasks show in green, and
picking one offers **Reset task** for a mistaken mark. Marking and resetting
return to the list. `/pair:next` carries the spec and its next unfinished task
into a fresh session without starting a model turn. **Edit spec** on an approved
spec withdraws the approval and reopens it in Spec mode; editing an agreed task
by hand reopens that task's agreement, and once no task is left agreed the spec
is back in Spec mode too.

With a connected editor, writing requires its `buffer_state` capability. Unsaved
spec/state buffers or a failed check block the write. Without an editor, the
saved files are still rechecked immediately before writing.

## Editors

Plugins live in `editors/<editor>/` and speak the protocol in
[`protocol/`](protocol/README.md).  Every feature also works without one:
Pi cites `path:line` in text instead of highlighting it.  A frontend running
Pi in RPC mode asks for the editor handshake by setting `PI_PAIR_EDITOR` (to
its name) in Pi's environment.

With an editor, Pi shows and annotates code through `pair_show_code` while
pairing.  Each editor has a setting to keep that with pairing off; in Emacs,
`pi-show-code-when-off`.

| Editor  | Status                                                                                       |
|---------|----------------------------------------------------------------------------------------------|
| Emacs   | Works today through [pi.el](https://github.com/Cmdv/pi.el); moving to `editors/emacs/` |
| VS Code | Planned: [`editors/vscode/`](editors/vscode/README.md)                                       |
| Zed     | Planned: [`editors/zed/`](editors/zed/README.md)                                             |

## Develop

```sh
npm install
npm test        # node --test
npm run check   # tsc
```

### Local triage model

Pair uses the local classifier to scope what the next turn may write, once a
spec has a task list. It is loaded lazily, on the first message that needs it,
and takes a few seconds once per process. If it cannot load—no runtime, missing
files, an aborted load—Pair says so once and sends your messages to the model
unchanged; nothing else is withheld. Spec selection, writing, questions and both
approval gates never depend on it.

```sh
npm install --ignore-scripts        # bundled CPU runtime; no GPU downloads
npm run classifier:setup            # explicit, optional manual download path
npm run classifier:smoke            # real inference + timings
npm run classifier -- classify "don't change anything"
```

Setup downloads approximately 1.75 GB of FP32 model/tokenizer files from
[the Apache-2.0 Decide ONNX export](https://huggingface.co/nishparadox/gliner2.5-decide-onnx),
pinned to `bbbcdb01c406b4f9a44b3a8102c96edb91c1f47d` and checked with SHA-256.
Incomplete files are removed; retries reuse completed, verified files.
For consented noninteractive setup, use `npm run classifier:setup -- --yes`.

Models live under `~/.pi/agent/pair/models/`, shared across projects (respects
`PI_CODING_AGENT_DIR`). There is no `localClassifier` flag or CLI enable/disable
command; an old config file is ignored. ONNX Runtime remains an optional npm
dependency, so ordinary Pi and Pair load without it; to add it later, run
`npm install --include=optional` in the installed package.

Inference is offline and reuses one verified, loaded instance per process/path.
On an Apple M1 Max (10 logical CPUs, 64 GiB RAM), verification plus load took
3.27 s, process RSS was 2.26 GiB, and a repeated load reused the instance in
0.27 ms. Five warmed trial classifications took 165–179 ms each (four CPU
threads). These are local measurements, not a hardware guarantee.

Inputs exceeding 512 tokens including labels/context are rejected, not silently
truncated. Scores are model probabilities, not calibrated permission confidence.
Triage asks two questions—which part of the spec, and what to do with it—and
treats anything below its 0.6 cutoff as unclear, which simply leaves the current
scope in place. That cutoff is a development default, not a benchmarked one, and
triage is deliberately never asked whether to approve or stop. Classifier
performance is checked manually with `classifier:smoke` and the readable triage
logs. `npm test` uses stubs, never loads the ONNX model; a deterministic local
fixture provider exercises actual Pi delivery and gates.

## Licence

GPL-3.0-or-later; see [LICENSE](LICENSE).
