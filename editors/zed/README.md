# pi-pair for Zed (planned)

Not built yet.  Until it is, Pi in Zed's terminal uses pi-pair without a
plugin: everything works, and locations come as `path:line` in text.

## Plan

- Same contract as the other plugins: a local server, a lock file at
  `~/.pi/agent/pair/editors/<pid>.json`, and the capabilities in
  [the protocol](../../protocol/README.md) that Zed can support.
- The editor is detected by process ancestry, with `ZED_TERM` as a hint for
  `/pair:setup`.

## To check

- What Zed's extension API (Rust compiled to WebAssembly) allows: it is
  narrower than VS Code's, and may not offer decorations or opening a file
  at a range directly.
- Routes if it doesn't: a small language server started by the extension
  (`window/showDocument` for `show`, diagnostics for notes), or `zed
  path:line` from the core for `show` alone.
