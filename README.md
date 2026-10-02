# pi-pair

Pairing modes for Pi: choose, per task, who writes the code.

## Install

1. Pi, which needs Node.js 22.19 or newer.  Then run `pi` and `/login` once:

   ```sh
   npm install -g --ignore-scripts @earendil-works/pi-coding-agent
   # or, on macOS and Linux: curl -fsSL https://pi.dev/install.sh | sh
   ```

2. [pi-permission-system](https://www.npmjs.com/package/@gotgenes/pi-permission-system).
   pi-pair leaves approvals to it, so each edit in Both and You is asked about:

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
"pair_spec_ready": "allow",
"pair_show_code": "allow"
```

From a checkout, use `pi install ./pi-pair` or, for one session,
`pi --extension ./pi-pair/src/index.ts`, instead of step 3, not as well as it.

## Modes

| Command      | Mode      | Pi                                                     |
|--------------|-----------|--------------------------------------------------------|
| `/pair me`   | Me   | answers, reads, runs commands; can't edit files        |
| `/pair both` | Both   | one small edit at a time, each explained and approved  |
| `/pair you`  | You | works through the task; edits still need approval      |
| `/pair off`  | —         | back to normal                                          |

After the mode you pick a spec: the active one, a new one, another, or none.
`/pair` on its own picks the mode first; `/pair both <spec>` skips both
pickers.  The status line shows `🧑‍🤝‍🧑 Both · <spec>`.
Until `/pair` is used nothing changes.  The mode is saved with the session and restored on resume.

Works in Pi's terminal UI and any frontend.  Editor plugins add highlights,
notes and diffs; see [Editors](#editors).

## Specs

A new spec is `.pi/pi-pair/specs/<name>.md` (goal, constraints, decisions,
questions and edge cases, "done when" checks, tasks with owners).  Picking
one that is still being written (no tasks or checks yet, or open questions)
starts Pi interviewing you, after it has read the code the spec touches;
picking a written one hands Pi its first open task.  The active spec stays
with you across modes, is editable in every mode, and is summarised into
Pi's context each turn, so a new session resumes from it.

While pairing, Pi asks questions with `pair_ask`: one to three at a time,
each with a few likely answers and `Other…` to type your own.  Dismissing a
question tells Pi to carry on in chat.  Allow it in pi-permission-system
(`"pair_ask": "allow"`), or each question is preceded by a permission prompt.

When the interview is done, Pi calls `pair_spec_ready` and you choose: the
next task in a fresh session (a clean context that keeps the mode and spec),
the next task here, or keep refining.  `/pair:next` starts the next task in a
fresh session at any time.

You and Pi can both edit the spec.  Pi must have read the current saved file
before changing it, so it can't overwrite your saved edits.  With an editor
adapter, Pi also can't change it while your buffer has unsaved changes, and
pi.el asks you to save it before a prompt is sent.

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

## Licence

GPL-3.0-or-later; see [LICENSE](LICENSE).
