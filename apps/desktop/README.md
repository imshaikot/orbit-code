# Orbit Code desktop

Orbit Code as a desktop app: an open-source, live 3D visual alternative to Claude Code in the terminal, for programmers and vibe coders alike, in a window of its own. It shows a folder as a 3D dependency graph and animates a live Claude Code session moving through it, the same way the VS Code extension does. It runs the engine the extension runs (`@orbit-code/core`, `@orbit-code/agent`) and the same UI bundle (`@orbit-code/webview`), hosted by Electron instead of VS Code.

The [install guide](https://orbit-code.imshaikot.com/install/#desktop) on [orbit-code.imshaikot.com](https://orbit-code.imshaikot.com) links the downloads a release carries, and how to run the app from source when there are none.

## Requirements

- Claude Code installed and signed in (`claude --version` works in a terminal). Orbit starts your own `claude` CLI, so your Claude Code settings, skills and MCP servers apply.
- git, for the file card's View diff and the editor sheet's Changes. Without it the graph still indexes, by walking the folder.

## Run it from source

```sh
yarn install                            # also downloads Electron
yarn desktop --folder .                 # builds, then opens this repository
yarn desktop --folder ../other --reindex
```

A relative `--folder` is taken from the workspace root. With no folder, the app reopens the folders that were open when it last quit, or shows an empty window.

## Using it

- **Opening a folder.** File › Open Folder… (Cmd/Ctrl+O) or File › Open Recent. Each folder gets its own window. Opening a folder that is already open brings its window forward.
- **Trust.** The first time a folder opens, Orbit asks whether you trust its authors, because Claude Code runs there with the settings, hooks and MCP servers the folder configures. The graph works either way. Claude sessions start once the folder is trusted (File › Trust Folder).
- **Files.** A click on a file opens its card: View diff, Open, Attach to prompt, Rename, Delete. Open and View diff use the editor sheet at the bottom of the window. There are no editor tabs, so links in the transcript open there too. Delete moves the file to the system's trash, and fails rather than deleting a file for good.
- **While the window is out of sight.** A permission request or a question from Claude becomes a system notification. On macOS its buttons answer it. Everywhere, a click brings the window forward. The tray icon's menu lists open folders and stops running turns. The dock (macOS) and launcher (Linux) show how many turns run, or how many wait for approval first.

## Settings

`settings.json` in the app's user data (File › Settings… opens it). The keys match the extension's `orbit.*` settings, and changes apply as soon as the file is saved.

| Key | Default | What it does |
| --- | --- | --- |
| `maxFiles` | `20000` | The most files indexed (at least 100) |
| `claude.path` | `""` | The `claude` executable; empty looks in PATH and the usual install locations |
| `claude.model` | `""` | Model alias or id; empty is Claude Code's default |
| `claude.effort` | `""` | `low`, `medium`, `high`, `xhigh` or `max`; empty is Claude Code's default |
| `claude.permissionMode` | `"default"` | `default`, `acceptEdits`, `plan` or `bypassPermissions` |
| `claude.extraArgs` | `[]` | Appended to every `claude` invocation |

Settings are never read from an opened folder, so a repository can't choose the executable, its arguments or the permission mode. `bypassPermissions` is accepted only from this file, never from the window.

## Where it keeps things

The user data directory is `~/Library/Application Support/Orbit Code` on macOS, `%APPDATA%\Orbit Code` on Windows and `~/.config/Orbit Code` on Linux. A run from source uses `Orbit Code Dev` instead, so it never shares state with an installed copy.

| Path | Holds |
| --- | --- |
| `settings.json` | Settings |
| `recent.json` | Recent folders, and the ones open at the last quit |
| `trust.json` | Trusted folders |
| `workspaces/<hash>/orbit-v1/` | Each folder's `graph.json` and up to 4 `layout-<hash>.bin`, as the extension keeps them |
| `logs/orbit.log` | The log, with the lines the extension writes to Orbit.log (File › Show Log) |

## Development

```sh
yarn nx run desktop:build      # dist/: main.js, preload.js, and the indexer and webview builds copied in
yarn nx run desktop:watch      # rebuilds as sources change; restart the app, or View › Reload for the page
yarn nx run desktop:typecheck
yarn desktop:smoke             # launches the app on a small folder under .harness/desktop-smoke
```

The main process is `src/main/`:

| Module | Owns |
| --- | --- |
| `main.ts` | App lifecycle, a window per folder, the menu, trust, recent folders, launch arguments |
| `workspace.ts` | One folder's engine: GraphService, SessionService and the shared OrbitController, with the desktop's dialogs and notifications as its `HostUi` |
| `window.ts` | The BrowserWindow as the controller's transport: `ready`, visibility, and messages only from its own top frame |
| `page.ts` | The `orbit://app/` scheme: the page with a fresh nonce and the panel's CSP, and `webview.js` |
| `files.ts` | The file menu and editor sheet's requests, on the disk |
| `watcher.ts` | A recursive `fs.watch` feeding ChangeBatcher, for live updates |
| `settings.ts`, `recent.ts`, `trust.ts` | The JSON files in user data |
| `notifications.ts`, `tray.ts` | Permission notifications, the tray and the dock count |
| `shellPath.ts` | The login shell's PATH, for an app started from the Finder or a launcher |

`src/preload/preload.ts` exposes `window.orbitHost.postMessage` to the page and delivers the host's messages as window `message` events, which is the contract `packages/webview/src/host.ts` has with any host but VS Code. The window is sandboxed, with context isolation and no Node integration.

Environment variables: `ORBIT_DESKTOP_FOLDER` (a folder to open), `ORBIT_REINDEX=1`, `ORBIT_DESKTOP_USER_DATA`, `ORBIT_DESKTOP_LOG`, `ORBIT_DESKTOP_SOFTWARE_GL=1` (WebGL without a GPU). `--disable-workspace-trust` trusts every folder, as it does for VS Code.

Everything the app runs is bundled into `dist/`, so `package.json` lists the workspace packages as devDependencies: electron-builder would otherwise copy them into the package.

[docs/hosts.md](../../docs/hosts.md) describes what the desktop app provides next to what the VS Code extension does, and [docs/using-orbit.md](../../docs/using-orbit.md) how to use the view.

## Packaging and releasing

```sh
yarn desktop:package                    # a production build, then electron-builder into dist/apps/desktop
yarn desktop:package --linux AppImage   # arguments go to electron-builder
```

This makes a dmg and zip on macOS, an NSIS installer on Windows and an AppImage on Linux (`electron-builder.yml`). electron-builder is pinned in `scripts/builder.mjs` and fetched with `yarn dlx`. Electron is pinned in `package.json` at 44.3.0, which runs Node 24.20.0.

The desktop app is released with the VS Code extension: one version, one `v<version>` tag. To release, add a version plan with the change (`yarn nx release plan minor --groups=apps -m "…"`), then run `yarn nx release --skip-publish` and push the tag. `.github/workflows/release.yml` builds a dmg for Apple silicon and one for Intel on macOS and puts them in the GitHub release beside the extension's `.vsix`, with that version's changelog. Windows and Linux installers aren't released yet; `yarn desktop:package` makes them on those platforms. [docs/releasing.md](../../docs/releasing.md) has the whole procedure.

The builds are not signed yet. macOS gets an ad hoc signature, so it runs on Apple silicon, but Gatekeeper asks before the first launch. Windows SmartScreen warns too. Signing needs, as follow-ups:

- **macOS:** a Developer ID Application certificate (`CSC_LINK`, `CSC_KEY_PASSWORD`), `hardenedRuntime: true` and notarization (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`) in electron-builder.yml and the release job. Notifications from an unsigned build may not show on macOS.
- **Windows:** a code signing certificate for electron-builder's `win` signing options.

## Limits

- One folder per window; a multi-root workspace isn't supported.
- Live updates watch the folder with a recursive `fs.watch`. On Linux that sets a watch on every directory, `node_modules` included, and a very large folder can run out of inotify watches. The log then warns, and changes made outside Orbit show after Reindex.
- The editor sheet picks a file's language by its name; files over 4 MB, and binary files, don't open.
- Notification buttons are macOS only. Windows shows no count on the taskbar.
- Conversations live in the app, so quitting starts new ones; History continues earlier ones.
