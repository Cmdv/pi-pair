# pi-pair for VS Code (planned)

Not built yet.  Until it is, Pi in VS Code's integrated terminal uses
pi-pair without a plugin: everything works, and locations come as
`path:line` in text.

## Plan

- A VS Code extension that listens on 127.0.0.1 and writes
  `~/.pi/agent/pair/editors/<pid>.json` (`{port, token, workspaceFolders,
  editor}`, mode 0600), so Pi started in the integrated terminal finds it by
  walking its parent processes.
- The capabilities in [the protocol](../../protocol/README.md):
  - `show`: open the file at the range (`window.showTextDocument`).
  - `annotate` / `clear`: text-editor decorations, with the note on hover.
  - `buffer_state`: unsaved changes (`TextDocument.isDirty`).
  - The edit preview on permission prompts (`vscode.diff`).
- Name and version in the handshake come from `vscode.version`.

## To check

- The integrated terminal's shell descends from VS Code's main process, not
  the extension host, so the lock file must carry a pid that the walk up
  from Pi actually reaches.
