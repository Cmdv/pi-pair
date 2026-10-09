# pi-pair

Pair with Pi without losing touch with your code: agree a spec, choose who
drives, and confirm the model's file edits.

The workflow below describes the checkout redesign, not the older v0.1.0 release.

## Install

1. Pi, which needs Node.js 22.19 or newer.  Then run `pi` and `/login` once:

   ```sh
   npm install -g --ignore-scripts @earendil-works/pi-coding-agent
   # or, on macOS and Linux: curl -fsSL https://pi.dev/install.sh | sh
   ```

2. [pi-permission-system](https://www.npmjs.com/package/@gotgenes/pi-permission-system).
   Use it for tool and shell approvals; Pair does not replace your permission policy:

   ```sh
   pi install npm:@gotgenes/pi-permission-system
   ```

3. pi-pair, pinned to a release:

   ```sh
   pi install git:github.com/Cmdv/pi-pair@v0.1.0
   ```

4. Optionally, an editor; see [Editors](#editors).

For web research, install `pi-web-access` with `pi install npm:pi-web-access`.
Pair supports its default tool names; your web-provider configuration and
permission policy still apply.

Restart Pi after installing; `pi list` shows what is installed.  To skip the
permission prompts in front of pi-pair's own tools, add these to `permission`
in `~/.pi/agent/extensions/pi-permission-system/config.json`.  `pair_ask`,
`pair_profile` and `pair_files` each open their own dialog, so a permission
prompt in front of them only asks you twice:

```json
"pair_ask": "allow",
"pair_write": "allow",
"pair_show_code": "allow",
"pair_profile": "allow",
"pair_files": "allow"
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
- `/pair:profile` changes who drives, how much assistance and when Pair checks
  in; see [Pairing](#pairing).
- `/pair:exit` leaves Pair and returns to ordinary Pi.

The badge identifies the spec, the open task and how many tasks are agreed, and
while pairing says who drives. Pair and the selected spec are saved with the
session; the profile is saved with the spec. **Pair with spec** and **Pair no
spec** both pair under the same rules: either driver can inspect, search and
run non-destructive checks; the model's `edit`/`write` calls require files you
confirm. Shell approvals follow your permission policy.

Works in Pi's terminal UI and RPC frontends. Editor plugins add highlights
and notes; see [Editors](#editors).

## Specs

A new spec starts as `.pi/pi-pair/specs/<name>.md` with a title and empty Goal,
plus `<name>.state.json`. A connected editor opens the new spec once, when it is
created. Code asks **What are you trying to solve?** without calling a model.

From there the spec is written as you talk:

1. Your answer goes to the model, which writes the Goal, the task titles in
   the order the work should be done, and every task's sections in one turn,
   reading the code once rather than once per task. The chat shows progress
   as it goes: **Found 3 tasks. Filling them in…**, then **Finished 1: …**
   for each.
2. The saved Markdown contains the plan. It is not automatically reopened after
   model turns or task navigation. **Show spec file**, the last item in both
   task lists, opens it without taking chat focus or discarding unsaved changes;
   without a connected editor it shows the file's path.
3. The task list opens: each task starts with its number from the spec (also in
   **Pair tasks**), not a row index. Pick a task, add one, **Describe changes…**
   across several tasks, or approve the spec. A change request returns to the list
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

**Talk naturally; there are no intent menus.** Once the breakdown exists, a
turn may write the task you are reviewing; from the task list, any part of the
spec. While you review one task, writing anything else—another task, the goal,
the order, a new task—has to be asked for: Pair shows **Allow this write** or
**Cancel**, naming what it would change, one write at a time.
Cancelled, or answered after you stopped Pair, nothing is written. The model
resolves "task 2" or "the retry one" from the contract; `/pair:tasks` goes back
to the list.

Code binds a hidden contract to each request, leaving your chat text unchanged.
Read/search, installed web-research tools and the bounded Pair tools are allowed; shell, delegation, source
implementation and direct file edits are blocked, and so is reading anything
under `.pi/pi-pair`: the contract carries the spec's content, and the files
there are yours. The contract never outlives its request. Once the spec is
approved, [Pairing](#pairing)'s rules apply instead: shell inspection is available,
and `edit`/`write` are limited to files you confirm.

In pi.el the composer has a distinct Pair tint, persistent spec/task label and
one line of shortcuts. Keys leave any chat draft untouched:

| Command | Emacs key | Meaning |
|---|---|---|
| `/pair:approve` | `C-c C-a` | Agree the task being reviewed, or the spec from the task list |
| `/pair:tasks` | `C-c C-l` | Open the task list from anywhere |
| `/pair:profile` | `C-c C-s` | Change the profile: who drives, assistance, checkpoint (while pairing, not in Spec) |
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
**Pair with spec**. The Spec machinery stands down: its contract and
`pair_write` go, and [Pairing](#pairing)'s rules apply instead. Approving the
spec agrees the plan; it is not permission to edit your source. The system
prompt carries the plan: the spec's path, goal, order and numbered tasks, with
the next one marked. The status line reads `Pair: <spec> · 2/3 · you drive · hints`. The
task list is now **Pair tasks**, the plan as progress, apart from the **Spec
tasks** list used while writing. Picking a task offers **Implement task**, which
starts work on it in this session, **Implement task + prompt**, which first
asks for a note to send with it, and **Mark task as done**, which records it
against the version you see and also agrees it. Starting a task chooses the
work, not the driver: the profile decides who writes the code. Done tasks show in green, and
picking one offers **Reset task** for a mistaken mark. Marking and resetting
return to the list. `/pair:next` carries the spec and its next unfinished task
into a fresh session without starting a model turn. **Edit spec** on an approved
spec withdraws the approval and reopens it in Spec mode; editing an agreed task
by hand reopens that task's agreement, and once no task is left agreed the spec
is back in Spec mode too.

With a connected editor, writing requires its `buffer_state` capability. Unsaved
spec/state buffers or a failed check block the write. Without an editor, the
saved files are still rechecked immediately before writing.

## Pairing

Pair keeps you connected to your own code: the model does only what you ask,
and you decide who writes it.

### The profile

One dialog, a tab for each choice:

- **Who's driving**: you, or the model.
- **Assistance**, while you drive. It covers investigating and debugging as well
  as code. **Hints**: where to look, and a question about your hypothesis, with
  no code that completes the step. **Examples**: one small next step, or how to
  find the problem; it asks before showing an example that would be the whole
  solution. **Solution**: the code for you to type, or the diagnosis, explained.
  When the model drives, assistance has no effect.
- **Checkpoint**: **Each step** or **After a slice**. While you drive: help with
  one step, then wait; or the whole approach at your assistance level, then a
  review when you say you are done. While the model drives: one change you can
  review at a glance (a function, a test or a fix); or until what you asked for
  is done. Either way it then stops for review.

With a spec, the profile is saved in `<spec>.state.json` and the latest choice
wins; `/pair` asks only when the spec has none, so a task picked up later, or
with `/pair:next` in a fresh session, needs no choosing. Without a spec, `/pair`
asks and the answer lasts for the session. Cancelling that first dialog uses
*you drive · hints · each step* and saves nothing. The dialog opens on the
current values, marked `(current)`; a typed `Other…` answer is ignored.

`/pair:profile` (`C-c C-s` in pi.el) changes it. The model can only propose a
change, with `pair_profile` and a one-line reason: the same dialog opens on its
proposal, marked `(proposed)`, with the reason above the first tab. Only Submit
changes anything, and the change applies at once, within the same turn, to the
model's tools and its next call. Cancel keeps the profile, and the model carries
on within it. Choosing to drive yourself while the model has files closes them
at once.

### What the model can do

Pair controls tool availability and guards `edit`/`write` at the write itself:

- Both drivers get Pi's built-in `read`, `grep`, `find` and `ls`, including
  discovery tools Pi leaves inactive by default. `bash` stays available if it
  was enabled in your ordinary Pi loadout: the model can inspect the project
  and run non-destructive commands while advising you or driving itself.
- Both drivers, and Spec mode, can use installed `pi-web-access` tools:
  `web_enable`, `web_search`, `source_check`, `fetch_content` and
  `get_search_content`. Lazy activation is preserved across turns and profile
  changes; Pair does not activate disabled web capabilities. Queries and URLs
  go to the configured web providers, so keep secrets and private code out of
  searches. Web calls remain subject to your permission policy.
- It asks with `pair_ask`, shows code with `pair_show_code` and proposes profile
  changes with `pair_profile`. Delegation, replacements for Pi's built-in tools
  and unrelated extension tools are refused.
- While you drive, `edit` and `write` are unavailable.
- While the model drives, it proposes files with `pair_files` before its first
  edit, each with a line on why. Pair checks them as it checks a write, then
  lists them and asks **Confirm** or **Cancel**. Only confirmed files can be
  changed through Pi's own `edit`, and `write` for files that did not exist
  yet. Proposing more files asks again, for the new ones only. A wrong list is
  cancelled and corrected in chat.
- Every `edit`/`write` is checked again just before it lands. The real path, symlinks
  resolved, must be a confirmed file inside the project, or under a root already
  approved for the spec, and never under `.pi/pi-pair` in any project. The file
  must not have changed since it was confirmed or last written by the model, so
  your saved edits win. With a connected editor it must have no unsaved changes;
  a check that fails or cannot be made blocks the write. `write` never replaces
  an existing file. Your ordinary permission prompts and other extensions'
  refusals still apply.
- Notes on the model's changes go only on lines it changed.
- Confirmed files close when the turn ends, when you send another message, when
  you choose to drive and on `/pair:exit`. A message queued before `/pair:exit`
  reaches the model stale and cannot edit; a new one afterwards is ordinary Pi.

**Shell safety belongs to your permission policy.** Configure
`pi-permission-system` to allow inspection and ask or deny destructive commands.
Pair does not classify shell commands or enforce a read-only shell. Its file
confirmations and unsaved-buffer checks guard `edit`/`write`, not shell effects;
without a restrictive permission policy, bash can change unconfirmed files.
Stale or paused Pair requests cannot run shell commands or web tools.

Reads and searches can name any path the Pi process can read, outside the
project included, subject to your permission policy.

`read` sees the saved file. When your editor holds unsaved changes to it, or
cannot say, Pair tells the model, which asks you to save or to share the part
that matters (in pi.el, select it and use `pi-add-context`). There is no
automatic syncing of unsaved buffers.

### What the model is asked to do

Each model call carries a short contract built from the profile: do only what
you asked, with no other changes or actions however helpful; mention anything
else worth doing in one line and ask; your words for this turn win over the
profile, so "don't edit yet" means no edit; assistance and checkpoints as above;
use shell only for non-destructive inspection and checks, never to edit files
or bypass a refusal; report actual checks and what remains unverified, without
claiming success without evidence. These are instructions, not gates. How
well a model follows them is checked in live conversations, not by the tests.

### Hand-back and checks

When a turn with confirmed files ends, Pair says what changed: each file with
the lines that enclose its changes, new and emptied files, anything that changed
after the model's last write (not attributed to it), and whether the turn was cut
short. The status shows `review`. The model annotates what it changed (what,
why, how it connects) when your editor can show code, and cites `path:line`
otherwise. The model can run non-destructive checks through bash, subject to
your permission policy, and should report their output and anything it could
not verify. Pair does not automatically run or certify checks. Only you mark
a task done.

Pair does not measure what you learn; passing tests and accepted changes are not
treated as understanding.

The status says who drives and what applies to them, `you drive · hints` or
`model driving · after a slice`, then `2 files confirmed`, `confirm files` or
`review` while they apply.

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

`npm test` needs no model, network or editor: a deterministic local fixture
provider exercises actual Pi delivery and gates. `test/emacs.test.ts` also
replays the editor protocol through the sibling pi.el checkout (or
`PI_PAIR_EMACS_DIR`) when Emacs is installed, and skips otherwise. pi.el's own
suite is described in its `AGENT.md`.

### Changes from earlier checkouts

- The presets (Guide me, Build together, Drive and review) and per-session
  settings are now one profile, saved with the spec. `/pair:settings` is now
  `/pair:profile`.
- The handoff dialog before each model slice, with its file browser and typed
  paths, is gone: the model proposes its files with `pair_files`. Files a spec's
  state remembers from it (`targets`) are ignored and never a grant.
- The local classifier is gone, with its scripts and dependencies. Pair no
  longer tries to read your intent from a message: the model reads it under the
  contract, and code enforces the tools and files. If you downloaded the
  classifier's model, delete it by hand: about 1.75 GB under
  `~/.pi/agent/pair/models/gliner2.5-decide/` (or under
  `$PI_CODING_AGENT_DIR/pair/models/`).

## Licence

GPL-3.0-or-later; see [LICENSE](LICENSE).
