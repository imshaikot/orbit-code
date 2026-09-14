# Architecture

Orbit is one engine, one UI and two hosts. The engine indexes a workspace into a graph and runs Claude Code conversations; the UI draws the graph and the conversations in a page; a host is an editor (VS Code) or an app (Electron) that gives the engine what it needs from the machine and gives the UI a page to show.

## Three runtimes, three bundles

| Bundle | Runs in | Built from | May import |
| --- | --- | --- | --- |
| `apps/vscode/dist/extension.js` (CommonJS) | VS Code's extension host | `apps/vscode/src/`, with `@orbit-code/core`, `agent`, `graph`, `protocol` and `common` inlined | `vscode`, Node, those packages, and `@orbit-code/indexer/listFiles` |
| `packages/indexer/dist/indexer.mjs` (ESM) | A `worker_threads` worker the host starts; also the `orbit-index` CLI | `packages/indexer/src/` | Node, dependency-cruiser, TypeScript, `@orbit-code/graph` and `protocol` |
| `packages/webview/dist/webview.js` (IIFE) | The page, under a strict Content Security Policy | `packages/webview/src/` | three.js, CodeMirror, `@orbit-code/graph` and `protocol` |

The desktop app replaces the first with two of its own: `apps/desktop/dist/main.js` for Electron's main process (the same packages inlined) and `dist/preload.js` for the window's sandboxed preload. Both hosts copy `indexer.mjs` and `webview.js` into their `dist/` and ship them.

The indexer is its own bundle for three reasons: dependency-cruiser uses top-level `await`, so it can't be CommonJS; a large cruise would block the extension host; and TypeScript (about 9 MB) must not load at activation. Nothing the host bundles reach may import `dependency-cruiser` or `typescript`, directly or through any package, and the boundary check refuses any indexer module but `listFiles` outside the indexer.

The packages tagged neutral (`protocol`, `graph`, `common`) compile without VS Code, Node or the DOM, because the webview, the hosts and the indexer all import them. [The monorepo](monorepo.md) has the full table of projects, tags and allowed imports.

## The engine

Each service owns one concern and publishes events through `Emitter` from `@orbit-code/common`. Services don't know each other; the controller wires them to the page.

| Service | Package | Owns |
| --- | --- | --- |
| `GraphService` | core | The cached `graph.json`, index runs and live updates on the worker, frozen and extended layouts, a path resolver per graph |
| `Store` | core | `orbit-v1/` in the host's storage directory: `graph.json` and up to four `layout-<hash>.bin` files |
| `ChangeBatcher` | core | File paths from the host's watcher, batched (1.5 s debounce, 5 s at most) into one refresh |
| `SessionService` | agent | The workspace's conversations, the probe of the `claude` CLI, its availability, the catalog (models, skills, MCP servers), and which conversation is current |
| `Conversation` | agent | One conversation and its process: prompts, turns, permission requests, interrupts, cost, restarts with `--resume` |
| `ClaudeCliBackend` | agent | The one `SessionBackend`: spawns `claude` in stream-json mode and parses its output into `AgentEvent`s |
| `ConversationHistory` | agent | The workspace's earlier conversations, summarised from Claude Code's own transcripts |
| `SessionProjector` | core | One conversation's events plus the loaded graph, turned into per-file activity and transcript entries, batched per 100 ms tick |
| `OrbitController` | core | The only module that knows all of the above: it checks the page's messages, routes them, forwards events, and sends a full snapshot whenever the page says `ready` |

The services take what they need from the editor as options: a logger, a storage directory, the indexer's path, the first folder, a file lister, whether the workspace is trusted. That is what lets [a host](hosts.md) be small.

The controller takes three things from its host: a `HostUi` (capabilities, the folder, the file dialog, opening a URL or a file, permission notifications), a `FileHost` (what the file card and the editor sheet ask of a file) and, once there is one, a `WebviewTransport` (post a message, whether the page is in sight, and its `ready`, message and dispose events).

## The page

`packages/webview/src/main.ts` wires the page's modules together with callbacks; none of them imports another's instance. `HostBridge` posts through `acquireVsCodeApi()` when the page has it and through `window.orbitHost` otherwise, and takes host messages as window `message` events either way, so the same bundle runs in VS Code, in the desktop window and in the harness. [The webview](webview.md) describes the scene and the HUD.

## The protocol

`packages/protocol/src/protocol.ts` defines every message that crosses a boundary: host to page and page to host, host to indexer worker, and page to layout worker. Host messages are coarse: the graph arrives as one `reset` or one `update` carrying the whole graph (never per-edge deltas), and activity and transcript entries come batched per host tick. Page messages are untrusted input: the controller checks each one's shape and values before a service sees it.

A few rules run through the protocol:

- **Generations.** Work a reindex can supersede carries a generation counter, and stale results are dropped. Activity carries the graph's hash and is dropped for any other graph.
- **Snapshots.** Every `ready` (first load, reload, reopen) gets a full snapshot: the host's capabilities, the graph or the last indexing status, every conversation's state and the current one, the catalog, and each conversation's transcript (the last 400 entries). Host state the page displays has to be part of it, or a reload loses it.
- **Versions.** `PROTOCOL_VERSION` (13 at the time of writing) is sent with `ready`; a mismatch is logged as a hint about stale bundles, not a gate.

## Data flow

1. **Startup.** The host creates the panel or window and attaches it to the controller. The page posts `ready`; the controller sends the snapshot.
2. **Graph load.** `GraphService.load()` reads the cached `graph.json`, or lists the workspace's files (`git ls-files` in a work tree, else the editor's search or a walk of the folder) and runs the indexer worker on them. A cached graph is followed by a background refresh, so edits made while the editor was closed show up. **Reindex** starts over: a full index, the cached layout ignored, a new scene.
3. **Graph reset.** The controller sends one columnar `graph` message: node index equals array position, edges as a flat `Uint32Array`, and the cached layout when there is one for that hash.
4. **Layout.** Without a cached layout, the page runs the layout worker: one force simulation per directory, bottom-up, each directory a bubble enclosing its files and its sub-directories' bubbles. The result goes back to the host as `layoutComputed`, which saves it as `layout-<hash>.bin`; the page then posts `sceneReady`.
5. **A turn.** A prompt from the page goes to `SessionService`, which hands it to a conversation's process as one stream-json line. Claude's output becomes session state (phase, permission request, cost), transcript entries and per-file activity, which the page draws. [Claude in Orbit](claude-session.md) has the details.
6. **Live updates.** The host's watcher feeds changed paths into `ChangeBatcher`; `GraphService.refresh()` re-lists the files, runs the worker on the previous graph plus the touched files, extends the current layout in place, writes the new graph and layout, and the controller sends an `update` delta (or a reset, if the page holds an older graph). The page builds a new World that adopts the old one's animation state through an index remap. [The graph pipeline](graph-pipeline.md) has the details.

## Storage and logs

| | VS Code | Desktop app |
| --- | --- | --- |
| Graph and layouts | `<workspaceStorage>/imshaikot.orbit-code/orbit-v1/` | `<userData>/workspaces/<hash of the path>/orbit-v1/` |
| Log | The **Orbit** output channel (`Orbit.log` on disk) | `<userData>/logs/orbit.log`, also stderr |
| Settings | The `orbit.*` settings | `<userData>/settings.json` |

Both hosts write the same log lines, which the end-to-end checks read. [Troubleshooting](troubleshooting.md) lists the paths per platform.

## Security constraints

These hold in both hosts and in the harness, and the checks compare them:

- The page's CSP is `default-src 'none'` with a nonce'd script and style and `worker-src blob:` (the layout worker starts from a Blob URL). No fonts, no remote images, no network: assets are bundled as text or data URIs, and the build refuses `fetch`, `XMLHttpRequest`, `importScripts` and any `http://` or `https://` in the webview's sources.
- The page has no file access. VS Code's `localResourceRoots` is `dist/` only; the desktop scheme serves only the page, `webview.js` and its source map, and its window is sandboxed, context-isolated and without Node.
- The page never touches files. The file card and the editor sheet send requests that the controller accepts only for a normalised id of a file in the graph; VS Code applies them as workspace edits, the desktop app writes in place behind a revision check and deletes only to the trash.
- Text goes into the DOM as `textContent`, never HTML. Markdown replies are rendered as DOM nodes.
- Claude runs only in trusted workspaces. Settings that change what runs (`claude.path`, `claude.extraArgs`, `claude.permissionMode`) are machine-scoped in VS Code and read only from user data in the desktop app, so a repository can't set them. `bypassPermissions` is accepted only from settings, never from the page. Model names and effort levels are checked because they become command-line arguments, and a resumed conversation's id must be one the host listed.
- MCP status answers carry server configurations with credentials, and `initialize` the account: only the fields the catalog declares leave the parser, and neither answer is logged. A sign-in URL goes from the host to the system browser and never reaches the page or the log.
