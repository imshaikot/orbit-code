# Contributing

## Setting up

```sh
yarn install          # Yarn 4 (the version is pinned in package.json); also downloads Electron for the desktop app
yarn build            # every project through Nx, dependencies first
yarn typecheck
yarn boundaries
```

Node 22 is what CI runs. `ELECTRON_SKIP_BINARY_DOWNLOAD=1 yarn install` skips the Electron binary on a machine that won't run the desktop app.

## The dev loop

| | |
| --- | --- |
| `yarn self` (or F5, "Orbit Code: this repository") | Builds, then opens this repository in an Extension Development Host with `apps/vscode` as the extension and other extensions disabled. The panel opens by itself |
| `yarn self --reindex` | The same, ignoring the cached graph. If VS Code is already running, the new window may not see the variable; use **Orbit Code: Reindex Workspace** |
| `yarn watch` | Rebuilds the extension, the indexer and the webview on change and copies the builds into `apps/vscode/dist/` |
| `yarn desktop --folder .` | Builds and opens this repository in the desktop app (`--reindex`, `--disable-workspace-trust`) |
| `yarn nx run desktop:watch` | The desktop equivalent of `yarn watch` |
| `yarn harness` | The webview in headless Chrome against a simulated host; a report and screenshots in `.harness/out/` |
| `yarn index . --out graph.json` | The indexer alone |

After a rebuild with a watch running: **Developer: Restart Extension Host** (or a window reload) for the extension bundle; close and reopen the panel, or **Developer: Reload Webviews**, for the webview bundle (the host resends its snapshot); nothing for the indexer, since each index run starts a new worker, though an extractor change still needs Reindex to show. In the desktop app: restart it for the main process, View › Reload for the page. `yarn watch` doesn't reload a `build.mjs` or the indexer's shims; restart it after editing them.

`ORBIT_CODE` points `yarn self` at another `code` CLI, for Cursor or VSCodium.

## Where a change goes

| To change | Edit | Then also |
| --- | --- | --- |
| A command | `contributes.commands` in `apps/vscode/package.json`; `registerCommand` in `extension.ts`, delegating to the controller or a service | The command list in `apps/vscode/README.md` |
| A setting | `contributes.configuration`; `readSettings()` in `apps/vscode/src/config.ts`; `normalizeSettings` and `applySettings` in `packages/core/src/settings.ts` (both hosts) | Machine scope and `restrictedConfigurations` if it changes what runs; both READMEs' settings tables |
| A host → page message | `HostToWebview` in `packages/protocol/src/protocol.ts`; post it from `packages/core/src/controller.ts`, and in `sendSnapshot()` if it is state; handle it in `main.ts` and wake the loop if it changes what is drawn | `tools/harness/src/hostSim.ts`; `PROTOCOL_VERSION` |
| A page → host message | `WebviewToHost`; a callback in `main.ts`; a validated case in `OrbitController.onMessage()`. What only an editor can do goes through `HostUi`, which both apps implement | `receive()` in `hostSim.ts`; `PROTOCOL_VERSION` |
| The page's CSP | `apps/vscode/src/panel/orbitPanel.ts` | Identically in `page()` of `tools/harness/harness.mjs` and `contentSecurityPolicy` in `apps/desktop/src/main/page.ts` |
| A HUD control | `packages/webview/src/hud/`, `styles.css`, wiring in `main.ts` | The harness's selectors, if a class is renamed |
| Claude CLI arguments or process handling | `packages/agent/src/claudeCli.ts`; `AgentStartOptions` in `backend.ts` | `sameOptions()` in `conversation.ts`, if a change must restart the process; a real smoke turn |
| Stream-json parsing | `packages/agent/src/streamJson.ts` (pure; unknown shapes return nothing); `onAgentEvent()` in `conversation.ts` | A real smoke turn |
| What a tool call animates or shows | `packages/agent/src/tools.ts`, `packages/core/src/sessionProjector.ts` | The host simulator's scripted turn, if the page must react to something new |
| A file operation | `apps/vscode/src/fileActions.ts` and `packages/core/src/diskFileHost.ts` together; shapes in `packages/core/src/fileHelpers.ts` | |
| Status bar, notifications, tray | `apps/vscode/src/statusBar.ts`, `apps/desktop/src/main/tray.ts` and `notifications.ts`; the wording in `packages/agent/src/sessionSummary.ts` is shared | |
| An extractor, live updates, the layout | [The graph pipeline](graph-pipeline.md) | Reindex to see an extractor change; a full index compared with an incremental run |
| Anything keyed by node or cluster index in the page | `World` and its layers | An adopt for any new animation state |
| A build, loaders, shims | The project's `build.mjs`; `packages/indexer/shims/` | Restart the watch |

Some rules that follow from the constraints in [Architecture](architecture.md): page messages are checked in the controller before a service sees them; text goes into the DOM as `textContent`; anything that ends up on a command line is validated; a new service is wired in `extension.ts` and `workspace.ts` rather than made a dependency of another service; and a service that needs no editor API belongs in `packages/core` or `packages/agent`.

## The checks

There is no unit-test runner and no linter. The checks are:

| Change | Run |
| --- | --- |
| Anything | `yarn typecheck`, `yarn build`, `yarn boundaries` |
| The manifest, commands, settings, views, activation | also `yarn smoke` |
| The panel, CSP, HUD, frame loop, protocol, the shared controller | also `yarn harness` (then read the report), `yarn smoke` and `yarn desktop:smoke` |
| The session, CLI arguments, stream-json, tools | also `ORBIT_SMOKE_PROMPT="Read package.json and reply with its name" ORBIT_SMOKE_MODEL=haiku yarn smoke`, a real and paid turn |
| A `build.mjs`, the shims, a dependency upgrade | also `yarn index . --out .harness/check.json`, the harness, the smoke, and `yarn package` |
| The indexer, live updates, the layout | an incremental run's hash against a full index's; the harness's `liveUpdate` check; the smoke's live-update step |
| `apps/desktop` | also `yarn nx run desktop:build` and `yarn desktop:smoke`; `yarn desktop:package` after touching packaging |

### The harness

`yarn harness` builds the webview, the indexer and the host simulator, indexes this repository (or takes `--graph`), serves the page under the real CSP, and drives headless Chrome over the DevTools protocol with real mouse and keyboard events. It covers where the view opens, camera motion, zooming into a bubble, drilling in and out, a thought, a live update, the Claude bubble and transcript, the spark, a subagent, two conversations at once, the drawer and the conversation view, the composer's toggles, the file card and the editor sheet, the Flat view, the tour, the frame rate cap, and the loop parking when hidden and idle.

**It does not fail on a bad result**: it only throws if the scene never loads. Read `.harness/out/report.json` and the screenshots next to it. A quick summary:

```sh
node -e 'const c = require("./.harness/out/report.json").checks, l = c.liveUpdate ?? {}, p = c.promptRoundTrip;
console.log({ fps: c.frameLoop.measuredFps, drill: c.drill?.matchesHover, fileHover: !!c.hoverFile?.tooltip, esc: c.escapeToOverview,
  live: l.appliedInPlace && l.stillDrilledIn && l.newLayoutComputed === 0, thinkingPixels: c.thinking?.litPixels,
  prompt: p.hostReceived && p.inputCleared && p.actionWhileWorking === "Stop",
  hiddenFrames: c.hiddenStopsLoop.framesWhileHidden, idleFrames: c.idleParks.framesWhileIdle, consoleClean: c.consoleClean })'
```

Expect a frame rate of about 30, every boolean true, zero frames while hidden and while idle, and lit pixels above zero. Chrome is expected at `/Applications/Google Chrome.app/…`; pass `--chrome <path>` otherwise. Other options: `--graph`, `--out`, `--size 1440x900`, `--scale`, `--skip-build`. Compare a red check with a run on `main` before calling it a regression: a few checks depend on the graph under test.

### The smoke tests

`yarn smoke` builds the extension, downloads VS Code into `.vscode-test/` (`ORBIT_VSCODE_VERSION` pins a version), opens a real window on this workspace for about a minute with a fresh user-data directory, and exits non-zero on failure. It waits for the graph, the saved layout, the scene and the Claude Code probe; with `ORBIT_SMOKE_PROMPT` it runs one real turn (keep the prompt read-only, since nobody answers permission requests); it reopens the panel from the activity bar, writes and deletes a file to see the live update, and drives the file requests (read, write, rename, delete) through the API the extension exports. It fails on any error line in `Orbit.log`, so failures that aren't Orbit bugs are logged as warnings. If it is killed mid-run, delete `packages/graph/src/__orbitSmoke*.ts` yourself.

`yarn desktop:smoke` starts the desktop app on a small folder it writes under `.harness/desktop-smoke` (a git repository of its own, since this one ignores `.harness`), with its own user data, waits for the scene and the probe, checks the saved layout, writes a file and waits for the watcher's update, then starts the app again and checks the layout is reused. About 5 s.

Both smokes grep specific log lines (`scene ready for graph`, `agent:` / `agent unavailable:`, `[webview] layout of`, `turn done in`, `graph updated`, `[webview] graph update applied`); don't reword them.

## CI

`.github/workflows/ci.yml` runs on every push to `main` and pull request, on Ubuntu with Node 22:

1. **check**: `yarn typecheck`, `yarn build`, `yarn boundaries`, and an index of this repository that must hold at least 40 files and edges, dependency-cruiser results, and `packages/webview/src/main.ts`. Its Nx cache is saved for the jobs after it.
2. In parallel: **package** (`yarn package`, the `.vsix` uploaded as an artifact), **smoke** under `xvfb-run` (no `claude` on the runner, so the probe logs `agent unavailable`), **harness** with the runner's Chrome (the report and screenshots uploaded), and **desktop** (`yarn desktop:smoke`, then `yarn desktop:package --linux AppImage`, uploaded).

Only the desktop job downloads Electron. [Releasing](releasing.md) covers `release.yml`.

## Commits

Commits read as a sequence of small, self-contained steps:

- **One commit per module or subtask.** A change touching several areas is split, in the order a reader would want (a shared type before the code that uses it, the host before the page that talks to it). A one-line fix or a rename touching everything is one commit; the rule is about not bundling distinct work.
- **The subject line is the message**, under 100 characters, in the repository's own shape: `<Area>: <description>` when the change sits inside one module (`Webview:`, `HUD:`, `Indexer:`, `Session service:`, `Graph service:`, `Extension host:`, `Desktop:`, `Harness:`, `README:`), or a plain sentence when it doesn't. Lowercase description, no trailing period. Add a body only when the change genuinely needs explaining.
- **No attribution trailers.** No `Co-Authored-By`, no "Generated with" footer.
- Stage files by name, so an unrelated in-progress file never rides along.

`git log --oneline` is the reference for the convention.
