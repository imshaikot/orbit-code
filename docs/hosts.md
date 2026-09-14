# Hosts

A host is the program that runs the engine and shows the page. There are three: the VS Code extension (`apps/vscode`), the Electron desktop app (`apps/desktop`), and the local server (`apps/server`), whose page is the web client (`packages/web-client`) at orbit-code.imshaikot.com/web-client/. Everything else is shared: the services in `packages/core` and `packages/agent`, the controller, the protocol, the indexer and the UI bundle. What is host code is only what the editor or the app does that the others can't.

## What every host provides

| Duty | VS Code | Desktop app | Shared piece it stands on |
| --- | --- | --- | --- |
| Storage directory, first folder, trust, a logger | `extension.ts` | `workspace.ts`, `trust.ts`, `FileLogger` from core | The options of `GraphService` and `SessionService` |
| The file list | `graph/files.ts`: `git ls-files` in a work tree, else `workspace.findFiles` | `listFilesOnDisk`: git, else a walk | `@orbit-code/indexer/listFiles` |
| File events | `graph/watcher.ts`: VS Code's file system watchers | `FolderWatcher` from core: one recursive `fs.watch` | `ChangeBatcher` in core |
| The indexer worker | `build.mjs` copies `dist/indexer.mjs` | The same, unpacked from the asar | `@orbit-code/indexer` |
| A page for the UI under the panel's CSP, with a transport | `panel/orbitPanel.ts`: a webview panel | `page.ts` (the `orbit://app/` scheme), `window.ts`, the preload | `webview.js`; `HostBridge` in the page |
| Dialogs, notifications, the browser, editor tabs | `controller.ts` (`PanelController`) | `workspace.ts` (`Workspace`), `notifications.ts` | `HostUi` in `packages/core/src/controller.ts` |
| File requests from the card and the sheet | `fileActions.ts`: workspace edits, documents, diff editors | `DiskFileHost` from core: the disk, behind the same revision check | `FileHost`, `fileHelpers.ts` in core |
| Settings under the same trust rules | `config.ts` and `package.json` | `settings.ts`: `settings.json` in user data | `normalizeSettings` and `applySettings` in core |
| Status while the page is out of sight | `statusBar.ts`, permission notifications | `tray.ts` (tray, dock badge), `notifications.ts` | `summarizeSessions` in agent |

The server supplies the same duties, mostly with the desktop app's shared pieces; its section below lists them. The controller is `OrbitController` in `packages/core/src/controller.ts`. A host gives it a `HostUi`, a `FileHost` and, once there is one, a `WebviewTransport`, and sends `{ type: 'host', capabilities }` for what it can't do: the desktop app and the server set `tabs: false`, so the file card hides "Open in a tab" and transcript links open the editor sheet.

## VS Code

`apps/vscode` is the extension `imshaikot.orbit-code`. Its `package.json` is the extension manifest.

- **Activation** on `onStartupFinished`. `activate()` builds `GraphService` (storage from `storageUri`, `dist/indexer.mjs`, the first folder, the file lister), `SessionService` over `ClaudeCliBackend`, the controller, the watcher, the status bar item and the activity bar launcher, pushes them all into the context's subscriptions, and registers the commands. In development mode it opens the panel by itself, and `ORBIT_REINDEX=1` reindexes.
- **Commands** are the `orbit.*` entries in `contributes.commands`: Open, Ask Claude…, Stop Claude, New Claude Conversation, Reindex Workspace. `orbit.prompt` takes the prompt text as an argument and returns whether it was accepted, which the smoke test relies on.
- **Settings** are `orbit.maxFiles` and `orbit.claude.*`, read once by `readSettings()`, checked by `normalizeSettings`, and applied by `applySettings` on change (a new path or extra arguments probe the CLI again; a new model, effort or mode applies from the next prompt). `claude.path`, `claude.extraArgs` and `claude.permissionMode` are machine-scoped and listed in `restrictedConfigurations`, so a repository's `.vscode/settings.json` can't set them.
- **Workspace trust** is `limited`: the graph works in an untrusted workspace, and sessions stay unavailable until it is trusted.
- **The panel** is a webview panel with scripts enabled, `retainContextWhenHidden` (so the WebGL context and layout survive tab switches; the frame loop parks instead) and `localResourceRoots` of `dist/` only. Its HTML carries the nonce'd CSP and one script. Creating the panel collapses the side bar, and so do **Orbit Code: Open** and the activity bar icon for a panel already open.
- **The activity bar** entry is a view container with one empty view whose becoming visible hands the side bar back to the Explorer and opens the panel.
- **The status bar** shows how many turns run, or wait for approval, while the panel is hidden or closed; a click opens it. A permission request while the panel is hidden becomes a warning notification with Allow, the request's "don't ask again" choice and Deny.
- **Logs** go to the **Orbit** output channel, on disk under VS Code's logs directory as `Orbit.log`. Webview errors and log calls arrive prefixed `[webview]`.
- **Storage** is `<workspaceStorage>/imshaikot.orbit-code/orbit-v1/`.

## The desktop app

`apps/desktop` composes the same services for each open folder in Electron's main process, one `Workspace` per folder in its own `BrowserWindow`.

| Module (`src/main/`) | Owns |
| --- | --- |
| `main.ts` | App lifecycle: launch arguments (`--folder`, `--reindex`, `--disable-workspace-trust`), the single-instance lock, a window per folder (an empty window takes the next folder opened), the menu, the trust dialog, recent folders reopened at launch, the indexer's path under `app.asar.unpacked`, the log (`FileLogger` from core, at `<userData>/logs/orbit.log`) |
| `workspace.ts` | `Workspace`, the desktop's `HostUi`: the services, core's `DiskFileHost` (delete through `shell.trashItem`) and `FolderWatcher` (flushed when a turn ends), the controller attached to its window; `pickFiles` is the open dialog, `openExternal` the system browser for http(s) only |
| `window.ts` | `OrbitWindow`, the `WebviewTransport`: messages accepted only from its own top frame on `orbit://app/`, `ready` re-armed on every load, visibility on show, hide, minimise and restore, no navigation or new windows |
| `page.ts` | The privileged `orbit` scheme: the page with a fresh nonce and the panel's CSP (as a header and a meta tag), `webview.js` and its map, and nothing else |
| `../preload/preload.ts` | Exposes one object with one function, `window.orbitHost.postMessage`, and delivers host messages as window `message` events |
| `settings.ts`, `trust.ts`, `recent.ts` | JSON files in user data; the settings file is watched and applied with `applySettings` |
| `notifications.ts`, `tray.ts`, `shellPath.ts` | Permission notifications (with buttons on macOS), the tray and badge count, the login shell's `PATH` for an app started from the GUI |

Invariants the desktop keeps: the window is sandboxed, context-isolated and without Node; the scheme serves the page and its script only; settings come from user data only, never from a folder; trust gates Claude per folder; delete is to the trash or not at all; typed arrays cross the IPC intact (the smoke's relaunch step proves a saved layout is reused). Electron 44.3.0 and electron-builder 26.15.3 are pinned; both CI workflows skip Electron's binary download except in the desktop jobs.

`apps/desktop/README.md` covers running it, its settings, where it keeps things and packaging.

## The server and the web client

`apps/server` is Orbit for a browser. `npx @imshaikot/orbit-code-server`, run in a folder, composes the same services for that folder in one Node process and listens on `127.0.0.1`; the web client, which the website hosts at `/web-client/`, is its page. The site takes the client from the newest server on npm, so the page people load speaks the protocol of the server they run.

| Module | Owns |
| --- | --- |
| `apps/server/src/server.ts` | The command: the log (`FileLogger` from core, echoed only with `--verbose`), the run's token (24 random bytes, or `--token`), the link it prints and opens, Ctrl+C |
| `apps/server/src/options.ts` | The command line, checked (`isServerPort`, `isServerToken`, `isModelName`, `isEffort`, `isPermissionMode`), and the data directory (`ORBIT_SERVER_DATA`, else the platform's cache) |
| `apps/server/src/serverWorkspace.ts` | `ServerWorkspace`, the server's `HostUi`: the services, core's `DiskFileHost` and `FolderWatcher`, the controller; `tabs: false`. Starting the server in a folder trusts it, as starting `claude` there does |
| `apps/server/src/socketServer.ts` | The HTTP server on the first free port from 6728 to 6737 and its WebSocket upgrade, accepted only at `/`, from an allowed origin (the website, plus `--origin`), for `127.0.0.1:<port>` or `localhost:<port>` as Host. The socket must then send `hello` with the token and `PROTOCOL_VERSION`, or is `refused`. `PageTransport` is the `WebviewTransport`: one page at a time, `inSight` from the tab's reported visibility and focus |
| `apps/server/src/system.ts` | Opening a web page, the trash and the file dialog with each platform's commands (`open`, `trash`, AppleScript; `xdg-open`, `gio`, zenity; PowerShell) |
| `packages/protocol/src/wire.ts` | The ports, the link (`#port=…&token=…`, a fragment the website never receives), the handshake frames, and the binary frame format that carries typed arrays intact |
| `packages/web-client/src/client.ts` | The prompt that guides starting the server, the connection (retried until a server answers), then `window.orbitHost` over the socket and `webview.js` loaded with the page's nonce |
| `packages/web-client/src/csp.ts` | The page's CSP, the panel's plus `connect-src` for exactly the server's ports, and the header a static host sends beside it; `dist/web-client.json` carries both to the website |

Invariants the server keeps: it listens on loopback only; nothing from a page reaches the controller before its origin, Host and token pass; the token is never logged; `connect-src` lists only `SERVER_PORTS`, in the page's meta policy and the website's header alike; settings come only from the command line; delete is to the trash or refused. `yarn server:smoke` drives the server and the web client in headless Chrome. `apps/server/README.md` covers using it, `packages/web-client/README.md` the page and the handshake.

## Adding an editor

An editor app hands the shared host its facts and the shared UI a page; nothing else is rewritten. The checklist:

1. Scaffold `apps/<editor>` (see [The monorepo](monorepo.md)) with a runtime tag of its own, and add that runtime to the boundary check's table.
2. Supply each duty in the table above. `apps/vscode` is the reference for every one, the desktop app for a host that embeds Chromium with Node beside it, and the server for a host whose page is elsewhere.
3. Serve `webview.js` in a page under the same CSP, define `window.orbitHost.postMessage` before the script runs, and deliver host messages as window `message` events.
4. Implement `HostUi`, `FileHost` and `WebviewTransport`, and send the `host` capabilities message for what the editor can't do.
5. Targets: `build` (depending on `^build`, so the webview and indexer are built), `package`, an end-to-end check, and `nx-release-publish`; a `publish:<registry>` tag and a release group; jobs in `ci.yml` and `release.yml`.

By editor: VS Code's family (Cursor, Windsurf, VSCodium, Positron) needs no new app, since the same `.vsix` is published to Open VSX. An editor that can't host a page (JetBrains through a JCEF tool window, Zed, Neovim) can start the local server, which already speaks the protocol over a WebSocket, and open its page.
