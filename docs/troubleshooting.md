# Troubleshooting

## Where to look

**The log.** Both hosts write the same lines.

| Host | Where |
| --- | --- |
| VS Code | View › Output › **Orbit**. On disk: macOS `~/Library/Application Support/Code/logs/<session>/window<N>/exthost/imshaikot.orbit-code/Orbit.log`; Linux `~/.config/Code/logs/…`; Windows `%APPDATA%\Code\logs\…` |
| Desktop app | File › Show Log, or `<userData>/logs/orbit.log` (rotated to `.1` past 5 MB); also stderr when started from a terminal |
| The smoke test | `.harness/vscode-user/logs/` |

Lines to know: `agent: <version>` or `agent unavailable: <reason>` (the Claude Code probe), `scene ready for graph <hash>`, `[webview] layout of …` (a layout worker run), `graph updated <hash>: +A −R ~C files, E edges in N ms` (a live update), `[webview] graph update applied`, `turn done in …`. Webview errors arrive prefixed `[webview]`.

**The storage.** `orbit-v1/` holds `graph.json` and up to four `layout-<hash>.bin` files.

| Host | Where |
| --- | --- |
| VS Code (macOS) | `~/Library/Application Support/Code/User/workspaceStorage/<id>/imshaikot.orbit-code/orbit-v1/` |
| Desktop app | `~/Library/Application Support/Orbit Code/workspaces/<hash of the path>/orbit-v1/` on macOS; `%APPDATA%\Orbit Code\…` on Windows; `~/.config/Orbit Code/…` on Linux. A run from source uses `Orbit Code Dev` |

**Reindex** (in the legend, or **Orbit Code: Reindex Workspace**) rebuilds both; deleting the folder is the manual reset.

**The page.** **Developer: Open Webview Developer Tools** in VS Code, View › Toggle Developer Tools in the desktop app. `window.__orbit` has `debug`, `world()`, `camera()` and the rest ([The webview](webview.md)).

## Claude

- **"agent unavailable"** in the log, or the drawer says Claude isn't available. `claude --version` must work; Orbit looks on the configured path, then `PATH` plus `~/.local/bin`, `~/.claude/local`, `/opt/homebrew/bin` and `/usr/local/bin`. An editor started from the GUI often lacks the shell's `PATH`: set `orbit.claude.path` (or `claude.path` in the desktop settings), or start the editor from a terminal. The desktop app also asks the login shell for its `PATH` at start.
- **Sessions stay unavailable in a folder.** The workspace isn't trusted: VS Code's trust prompt, or File › Trust Folder in the desktop app. The graph works either way.
- **A gated tool is denied without asking.** Something removed `--permission-prompt-tool stdio`; check `claude.extraArgs` for arguments that change the output or input format.
- **The process dies mid-turn.** It is logged as a warning with the last stderr line, the turn fails, and the next prompt resumes the conversation. A Claude Code upgrade can change the stream-json shapes; the parser was last checked against 2.1.267.
- **An MCP change doesn't show in a running conversation.** Enabling, disabling or signing in reaches each conversation at its next prompt, not during a turn. A claude.ai connector authorised on claude.ai needs Reconnect.
- **History is empty.** History reads Claude Code's transcripts under `<config>/projects/<the workspace path with non-alphanumerics as dashes>`; a workspace whose transcripts Claude Code keeps under another name (very long paths) shows none.
- **`ELECTRON_RUN_AS_NODE=1`** is inherited by shells that VS Code starts, including Claude Code running inside VS Code. Orbit strips it for Claude and the desktop scripts delete it, but starting VS Code or Electron any other way with it set gives plain Node. Delete it first.

## The graph

- **An import is missing or stale.** Live updates are incremental and some importers aren't re-read; [The graph pipeline](graph-pipeline.md) lists the cases. Reindex.
- **A file isn't in the graph.** It is ignored by git, beyond `maxFiles`, in an always-excluded directory (`node_modules`, `vendor`, …), a lock file, or of an extension the language table doesn't know. A file that newly enters the listing without being created (a `.gitignore` change) needs some file event to be noticed.
- **The desktop app indexes a folder as empty** (`listed 0 files via git`). The folder is inside a repository whose `.gitignore` covers it, so `git ls-files` lists nothing. Make it a repository of its own, or move it.
- **The layout looks old after a layout change.** A load with an unchanged hash reuses the cached layout. Reindex, or bump `LAYOUT_VERSION` in `packages/core/src/store.ts` to redo it everywhere.
- **An extractor change doesn't show.** Live updates reuse the edges of unchanged files. Reindex.
- **Live updates stop in the desktop app on Linux.** The recursive `fs.watch` sets a watch per directory and a very large folder can exhaust inotify's limit; the log warns. Raise `fs.inotify.max_user_watches`, or use Reindex.
- **A directory that gained many files looks crowded.** New files are placed, not laid out, and sibling bubbles are packed close. Reindex gives a fresh layout.

## The page

- **The scene is frozen.** Something moves without waking the frame loop; check the console for `[webview]` errors. While hidden, the page renders nothing on purpose.
- **Low frame rate.** The stage steps the pixel ratio down (2, 1.5, 1) when frames keep missing 30 fps; the readout at the bottom right shows it. A graph with many thousands of imports draws each Flat arc with fewer segments.
- **The webview build fails on a URL in a comment.** The constraint check is a plain regex over `packages/webview/src/`; no `http://` or `https://` anywhere, comments included.
- **Styles don't apply from code.** The CSP blocks `style` attribute strings; set styles through `element.style`.

## Builds and checks

- **A stale `dist/` after switching branches.** Nx restores a cached build whose inputs haven't changed; the environment isn't an input. `yarn nx reset` after upgrading Node or changing a build script's environment.
- **`@orbit-code/<name>` doesn't resolve** right after adding a package: `yarn install` links it. A target that "doesn't exist": `yarn nx reset`.
- **A dependency-cruiser or TypeScript upgrade.** Three of dependency-cruiser's modules are swapped for shims by path regex in `packages/indexer/build.mjs`; if a regex stops matching, files fall back to the regex scanner. Compare `yarn index . --out before.json` and `after.json`: more `depcruiseFallbacks` or far fewer edges means a shim stopped matching.
- **The harness can't find Chrome.** It expects `/Applications/Google Chrome.app/…`; pass `--chrome <path>`. On Ubuntu a snap Chromium can't see the paths written for it; prefer a deb Chrome.
- **A red harness check.** The harness never fails on a bad result. Rerun, and compare with a run on `main`: a few checks depend on the graph under test.
- **The smoke test was killed mid-run.** Delete `packages/graph/src/__orbitSmoke.ts`, `__orbitSmokeMenu.ts` and `__orbitSmokeMoved.ts` yourself.
- **`yarn install` downloads a 100 MB Electron.** `ELECTRON_SKIP_BINARY_DOWNLOAD=1` skips it where the desktop app won't run; both workflows set it except in the desktop jobs.
- **A copy of the workspace builds the wrong sources.** Its `node_modules/@orbit-code/*` symlinks point into the original; run `yarn install` in the copy.

## Installing

- **Gatekeeper or SmartScreen warns about the desktop app.** The builds are unsigned (macOS ad hoc); allow it once. Signing is a follow-up in `apps/desktop/README.md`.
- **Notifications don't show from the desktop app on macOS.** An unsigned build's notifications may be suppressed; buttons on notifications are macOS only in any case.
- **The installed extension doesn't update after `yarn install-local`.** Reload the open VS Code windows. The dev host (`yarn self`) never loads the installed copy.
