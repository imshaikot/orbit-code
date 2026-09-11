# Orbit Code

Your workspace as a 3D force-directed dependency graph in VS Code, with a live Claude Code session moving through it. Ask Claude something from the panel and watch the files it reads light up and the files it edits pulse.

## Requirements

- VS Code 1.100 or later.
- [Claude Code](https://docs.claude.com/en/docs/claude-code) installed and logged in. Orbit runs your own `claude` executable, so your login, settings, `CLAUDE.md` and MCP servers apply. Without it, the graph still works and the drawer says Claude Code wasn't found.

## Opening Orbit Code

Click the Orbit Code icon in the activity bar, or run **Orbit Code: Open**. The graph opens in the editor area and the side bar collapses to make room; **Toggle Side Bar** (⌘B / Ctrl+B) brings it back.

## Run it on this repository

```sh
yarn install
yarn self                     # build, open this repo in an Extension Development Host; Orbit opens by itself
yarn self --reindex           # ignore the cached graph
yarn install-local            # install this working copy into your own VS Code, or update it; then reload open windows
```

Or open this folder in VS Code and press F5 ("Orbit Code: this repository").
If VS Code is already running, the `code` CLI may not pass `--reindex` through to the new window; use the command palette instead.

## Working with Claude

Claude stays off the graph until you want it:

- **Drawer.** The tab with Claude's spark at the bottom edge opens the composer: click it or drag it up. Type a prompt and press Enter (Shift+Enter for a new line). Drag the sheet down, click its grabber or press Esc to put it away; what you typed is kept.
- **Session bubbles.** Sending closes the drawer, and the prompt flies to a Claude bubble at the bottom left. The bubble pulses while Claude works, with a cyan ripple for each file it reads and an amber one for each edit. Hover it for the prompt, what Claude is doing and for how long. When the turn ends the bubble says how it went and leaves; a failed one stays until you open it. A prompt from **Orbit Code: Ask Claude…** gets a bubble too.
- **Several conversations at once.** The drawer continues your current conversation while it is idle. Send a prompt while Claude is still working and it starts a new conversation beside it, with its own bubble, its own star on the graph and its own Claude Code process; the bubbles stack at the bottom left, one per running session. Each conversation is continued from its own session view, and the drawer follows whichever you prompted last. A conversation that is no longer current lets its process go once idle and picks it up again with `--resume` when you reply to it.
- **Session view.** Click a bubble to open it: Claude's replies rendered as Markdown, every tool call, and a line per finished turn with its duration and list-price cost. While Claude works the footer has **Stop**; once it is done, reply there to continue that conversation. Click a file path, or a workspace link in a reply, to open it. **View conversation** in the drawer opens the current conversation when no bubble is left.
- **Model.** The models your Claude Code offers, as it lists them (its default, Sonnet, Opus, Opus with 1M context, Haiku, …), chosen in the drawer. Orbit asks Claude Code for the list when it opens, without starting a conversation.
- **Permissions.**
  - **Ask before edits:** your Claude Code settings decide, the same allow rules and modes as in a terminal (`~/.claude/settings.json`, the workspace's `.claude/settings.json` and `settings.local.json`). Anything that needs approval turns the bubble amber and appears as a card in the session view: **Allow** once, **Deny**, or the "don't ask again" choice Claude Code offers for that call, such as **Allow all edits this session** or **Always allow in this project** (a rule Claude Code writes to the workspace's `settings.local.json`, as its own prompt would). If Orbit is hidden, the request comes as a notification with the same choices.
  - **Accept edits:** file edits go through without asking.
  - **Plan only:** Claude reads and plans but changes nothing.
- **Changing options mid-conversation.** A new model or permission mode applies from the next prompt, and the conversation continues.
- **New conversation** in the drawer starts a fresh one; earlier ones keep running.
- **Skills.** **Skills** in the composer opens a constellation of the skills Claude Code offers here: a tesseract per skill, gathered around a star for where it comes from (this workspace's `.claude/skills`, your `~/.claude/skills`, plugins), with lines between skills whose instructions name each other. Drag one onto the prompt, or click it, to attach it. Or type `/` in the prompt: the constellation opens narrowed to what you type after it, and Enter attaches the picked skill (the arrows move the pick). Scroll over the constellation to zoom in for a closer look, drag to pan, and double-click or **Fit** to see it whole again. Attached skills show as chips above the input and go with the next prompt: the first as its slash command, the others named for Claude to load.
- **History.** **History** opens your earlier Claude Code conversations in this workspace, oldest on the left, with lines between conversations that worked on the same files. Click one to see what was asked, the files Claude read and edited, and the skills and MCP servers it used. **Continue this conversation** makes your next prompt pick it up where it left off.
- **MCP servers.** The drawer says how your MCP servers connected. When Claude calls an MCP tool, the server comes out as a lime station orbiting Claude's star: a pulse runs out along the beam, and the answer runs back, red if the tool failed. The session view names the server of each call.

Commands: **Orbit Code: Open**, **Orbit Code: Ask Claude…**, **Orbit Code: Stop Claude** (every running conversation), **Orbit Code: New Claude Conversation**, **Orbit Code: Reindex Workspace**. While turns run, the status bar shows how many, even when Orbit is closed.

The graph follows the files. Creating, editing, deleting or renaming a source file updates it within a few seconds: Claude's edits, your own, and git checkouts alike. During a turn, updates arrive at least every 5 seconds and once more as the turn ends. Updates happen while Orbit is closed too, and edits made while VS Code was closed are picked up when it opens. **Reindex Workspace** (or *Reindex* in the panel) is for starting over: every file indexed again and a fresh layout.

| Setting | Default | |
| --- | --- | --- |
| `orbit.claude.path` | `""` | The `claude` executable. Empty searches `PATH`, `~/.local/bin`, `~/.claude/local`, Homebrew and `/usr/local/bin`. |
| `orbit.claude.model` | `""` | Default model for new sessions (`opus`, `sonnet`, a full id…). |
| `orbit.claude.permissionMode` | `default` | `default`, `acceptEdits`, `plan`, or `bypassPermissions`. Bypass can only be set here. |
| `orbit.claude.extraArgs` | `[]` | Appended to every `claude` invocation, e.g. `["--add-dir", "../shared"]`. |
| `orbit.maxFiles` | `20000` | Files indexed before the graph is truncated. |

The Claude settings except the model are machine-scoped, so a repository's `.vscode/settings.json` cannot change them. In an untrusted workspace the graph works but Claude sessions don't start.

## Languages and project configuration

Orbit works the same for any kind of project, not only Node and TypeScript. Every source file and every project configuration file in the first workspace folder is a node, and imports resolve through each ecosystem's own configuration wherever it sits in the tree, so monorepos with many packages or modules work too.

- **Code.** JavaScript and TypeScript; Python, notebooks included; Go; Rust; Java, Kotlin, Scala and Groovy; C, C++ and Objective-C; C#, F# and VB; Swift; Ruby; PHP; Dart; Elixir and Erlang; HTML and templates (Vue, Svelte, Astro, Jinja, Twig, Blade, Razor, …); CSS, Sass and Less; shell and PowerShell; SQL, Protocol Buffers and GraphQL; Terraform, Nix and Dockerfiles; Haskell, OCaml, Elm, Lua, Perl, R, Julia, Zig, Nim, Crystal, Solidity and more.
- **Project configuration.** Manifests and build files such as `package.json`, `tsconfig.json`, `go.mod`, `go.work`, `Cargo.toml`, `pyproject.toml`, `requirements.txt`, `pom.xml`, Gradle files, `.csproj` and `.sln`, `Package.swift`, `composer.json`, `Gemfile`, `pubspec.yaml`, `mix.exs`, `CMakeLists.txt`, Makefiles, Bazel and compose files, and anything written in TOML, YAML, INI or `.properties`. Lock files and minified bundles are left out.

| Ecosystem | Orbit reads | So that |
| --- | --- | --- |
| JavaScript, TypeScript | every `tsconfig.json` and `jsconfig.json`, every `package.json` | each package's path aliases apply to its own files, and `@scope/pkg` or `pkg/sub` lands on that workspace package's source through `main`, `exports` and `imports`, even without `node_modules` |
| Python | `pyproject.toml`, `setup.py`, `setup.cfg` | absolute imports resolve from the source roots, `src/` layouts included |
| Go | every `go.mod` | imports resolve across all the modules of a `go.work` or a monorepo |
| Rust | every `Cargo.toml` | `use other_crate::…` reaches that crate of the workspace |
| PHP | `composer.json` | `use App\…` resolves through the PSR-4 prefixes |
| Dart, Flutter | `pubspec.yaml` | `package:name/…` imports between local packages resolve |
| C# | `.csproj` | `using` a namespace links to the folder it names in the project with that root namespace |
| Swift | `Package.swift` | `import Target` links to that target's sources |

Configuration files link to what they name: a workspace `package.json` to its packages and a package to its entry point, a `tsconfig.json` to what it extends and references, `go.work` to its modules, a Cargo workspace to its crates, a solution to its projects, a compose file to its Dockerfiles, CMake to its subdirectories, a Makefile to what it includes.

## Reading the view

- **Directories.** Every directory is a glass bubble, sized by what it holds: its files and its sub-directories. Orbit opens in your source directory (`src`, `lib`, `app`, …) when the workspace has one, else at the top. The view shows one directory at a time: its own files as solid spheres, its sub-directories as glass bubbles side by side, and the imports between them. Each bubble's own lines and files show faintly through it.
- **Colours are file types.** A file has its type's colour, and a directory's bubble the colour of the type most of its files are; project configuration, a dark grey, colours a bubble only when nothing else is in it. The legend under the counts at the top left names the colours in use and how many files each has. Types that rarely share a repository share a colour (Go and Dart; Rust and Swift; Java, Kotlin and Ruby; C#, PHP and Elixir; shell, SQL, infrastructure and other languages), and the legend lists the ones present together. Hovering a file names its type; hovering a bubble gives the share of its main type.
- **Zoom in and out.** Scroll over a bubble to zoom toward it: its contents come in gradually as you zoom, until it opens and becomes the directory in view. Zoom back out and it fades away again until you are back in the directory around it. Clicking a bubble does the same in one move, Esc goes back up one level, and the path at the top left jumps straight to any directory above. A directory holding nothing but one sub-directory is skipped, so `main/java` shows as one bubble. A bubble lights up while Claude works on files inside it, and those files glow through it.
- **Read.** Claude (the violet-white star) moves over the file and flares cyan as a comet leaves it. The file and the bubbles around it light cyan when the comet lands, and stay softly lit until the turn ends.
- **Edit.** Claude's star moves over the file and flares amber. The file pulses amber with an expanding ring, its direct neighbours pulse at half strength (a neighbour Claude also edited keeps its own pulse), and the imports between them flash.
- **Thinking.** While Claude thinks, every import line on screen charges violet and fires like a neuron: spikes run from a file to the files it imports and flash where they land, all lines out of one file firing together. The firing dies out a couple of seconds after Claude stops thinking, or when the turn ends.
- **Working.** Import edges flow faster, and Claude's star wears a ring, for as long as a turn runs. A second conversation working at the same time gets a star of its own, fading in beside the first.
- **Turn finished.** Its star returns home (a second star fades out once there). When the last running turn ends, everything fades back to rest.
- **Files change.** Files that stay keep their place, and the camera, the directory you are looking into and anything still glowing carry over. A new file appears in its directory's bubble with an amber pulse (if Claude is working, it keeps glowing until the turn ends and Claude's star moves to it), a new directory gets a bubble of its own, and a deleted file disappears.
- **Files.** Click a file and a card opens beside it, and a violet ring settles around the file. The card follows the file as you move the camera; Esc or a click elsewhere closes it.
  - **View diff** appears when git has uncommitted changes for the file, staged or not. It opens the editor on the changes against HEAD: added and changed lines in green, what HEAD had in red, unchanged stretches folded away.
  - **Open** slides an editor up from the bottom edge with the file in it, highlighted for its language. Edit and press ⌘S / Ctrl+S to save through VS Code, so format on save and open tabs stay in step. **Code** and **Changes** switch between the file and its diff, and dragging the top edge resizes the editor. If the file changes elsewhere while it is open (Claude, or a tab in VS Code), the editor takes the new text, or asks first when you have unsaved edits.
  - **Open in a tab** opens the file in a VS Code tab beside Orbit (or the diff, from the editor's **Changes**).
  - **Rename…** turns the card into a name field, with the name selected but not its extension. A path like `../lib/name.ts` moves the file. The file keeps its place in its directory, and VS Code's rename helpers (such as updating imports) take part.
  - **Delete…** asks first. The ring turns red, and the Delete button arms after a moment, so a double click can't delete. The file then collapses into a spark, its lines go with it, and the graph drops it. VS Code deletes it the way the Explorer does, so the Explorer's Undo brings it back.
- A file that isn't in the graph (not indexed, or outside the workspace) doesn't animate and its transcript entry has no link. The exception is a source file Claude is creating: it is linked right away and pulses once the graph picks it up.
- **Bottom right:** fps, CPU ms per frame, draw calls, triangles. *Idle, not rendering* means the frame loop is parked.

## How it is built

| Bundle | Runs in | Contains |
| --- | --- | --- |
| `dist/extension.js` | extension host | graph service, Claude session, panel transport, storage, file listing |
| `dist/indexer.mjs` | worker thread | dependency-cruiser 18.2.0 + TypeScript 5.9.3, regex import scan, project manifests |
| `dist/webview.js` | webview | three.js, CodeMirror 6 for the editor sheet, HUD, and the layout Web Worker inlined and started from a Blob |

The indexer is its own ESM bundle for three reasons:
- **Top-level await.** dependency-cruiser uses it, so it can't be emitted as CommonJS.
- **Responsiveness.** A large cruise would otherwise block every extension in the host.
- **Activation cost.** TypeScript is ~9 MB that shouldn't load at activation.

In the extension host, each concern is its own service:
- **Graph.** `GraphService` covers index, cache, live updates and layouts. `WorkspaceWatcher` feeds it batched file changes.
- **Session.** `SessionService` owns the conversation. It drives a `SessionBackend`; today that is the Claude Code CLI in stream-json mode, with permission prompts over its control channel.
- **Projection.** `SessionProjector` maps tool calls onto graph nodes and batches them.
- **Transport.** `OrbitPanel` is only the webview transport.
- **Wiring.** `OrbitController` connects them, and is the only module that knows all of them.

The webview is split the same way: host bridge, frame loop, scene controller, pointer interaction and HUD components, wired together in `main.ts`. Every message is typed in [`src/shared/protocol.ts`](src/shared/protocol.ts).

Three small build-time shims in [`scripts/shims`](scripts/shims) replace dependency-cruiser's runtime module lookups.

**Persistence.** `storageUri/orbit-v1/graph.json` holds `{id, path, dir, size, mtime, unresolved}` nodes, `{source, target}` edges and a fingerprint of the project configuration imports were resolved through, and there is one frozen `layout-<hash>.bin` per graph. Reopening reuses both.

**Live updates.** After a file event, the worker stats every file but reads imports only from what the change affects: new and changed files, importers of deleted files, and files with unresolved imports when something was added. Other edges are reused, so one edit in a 20,000-file workspace doesn't run dependency-cruiser over all of it. A change to project configuration that moves where imports resolve (a package name or `exports` map, a Go module path, a `tsconfig`) reads every file again. The layout is extended rather than recomputed; [`layoutExtend.ts`](src/shared/layoutExtend.ts) places new files next to what they import. The webview then rebuilds its scene objects and carries the animation state over.

## Hard constraints and where they are enforced

| Constraint | Where |
| --- | --- |
| One InstancedMesh for all file nodes | [`nodes.ts`](src/webview/nodes.ts). The id pass swaps shaders on the same mesh. The build fails otherwise. |
| Edges: one BufferGeometry, time uniform + per-edge offset | [`edges.ts`](src/webview/edges.ts), `uTime` and `aInfo.y`. Visibility and highlighting are decided in the shader. |
| GPU picking, no raycasting | [`picking.ts`](src/webview/picking.ts): camera view offset into a 1×1 target, `readRenderTargetPixelsAsync`. The build fails on `Raycaster`. |
| three bundled locally, strict CSP | `default-src 'none'`, nonce'd script and style, `worker-src blob:`; loaded with `asWebviewUri` |
| 30 fps cap for the ambient animation, 60 while the camera or pointer moves, loop stops when hidden | [`frameLoop.ts`](src/webview/frameLoop.ts). Visibility comes from `onDidChangeViewState` and `visibilitychange`; the loop also parks when nothing animates. |
| No fs in the webview, coarse deltas | `localResourceRoots` is `dist/` only; the host opens transcript files and refuses paths outside the workspace. One columnar `graph` message (a reset, or an update carrying an index remap), activity and transcript batched per 100 ms host tick. |
| Claude only where it is safe to run | Trusted workspaces only; executable, arguments and permission mode are machine-scoped settings; bypass is never accepted from the webview. |

## Checks

```sh
yarn typecheck
yarn index <dir> --out graph.json           # the indexer alone, via the same worker thread path
yarn index <dir> --out next.json --previous graph.json   # incremental, as a live update runs it
yarn harness                                # or --graph graph.json
yarn smoke                                  # real VS Code, downloaded to .vscode-test/
ORBIT_SMOKE_PROMPT="Read package.json and reply with its name" ORBIT_SMOKE_MODEL=haiku yarn smoke
```

**`harness`** runs `dist/webview.js` in headless Chrome under the webview CSP. A simulated host plays a scripted Claude turn over real files of the graph. Using real mouse and keyboard events, it checks:
- Orbit opens in the source directory; scrolling in over a bubble brings its contents in gradually and opens it without a click, and scrolling back out leaves it;
- hovering a directory bubble shows its tooltip, and clicking looks inside it, two levels deep (GPU picking); the path at the top left leads back up;
- hovering a file shows its path, and Esc backs out one level at a time to the root;
- the legend names the file types in the graph, and files and bubbles take their colours;
- a live update while looking into a directory (files added and removed, a new sub-directory) keeps the focus, shows the new bubble, runs no layout, and keeps 30 fps;
- a turn started elsewhere gets a Claude bubble that leaves when the turn ends, and the transcript renders its Markdown;
- a prompt sent while a turn runs starts a second conversation: two bubbles, two host conversations, two stars, each bubble opening its own transcript, both leaving when their turns end;
- dragging the drawer open and sending a prompt launches a bubble; its hover label, session view, Stop button and permission card work, Esc folds the view back, and the prompt reaches the host and comes back;
- clicking a file opens its card, with View diff only for a file with changes; the editor opens, saves with the shortcut, shows the diff and takes a change made elsewhere; a renamed file keeps its place; a delete asks, arms, collapses the file and removes it from the graph;
- the 30 fps cap of the ambient animation holds;
- a hidden panel renders zero frames, and an idle panel parks the loop.

It writes screenshots and `report.json` to `.harness/out`.

**`smoke`** opens Orbit on this repository in an isolated VS Code. It waits for `graph.json` from the worker-thread indexer, then for the layout file the host saves after the webview round trip, then for the scene and the Claude Code probe. With `ORBIT_SMOKE_PROMPT` it also runs one real turn through **Orbit Code: Ask Claude…**; keep that prompt read-only, since nobody is there to approve tools. It checks that reopening the panel from the activity bar icon reuses the graph and layout. Finally it writes a temporary source file into the workspace, waits for the file and its import to reach the graph and the webview through the file watcher, deletes it, and waits for it to leave, without a second layout. Then it reads, saves, renames and deletes another file through the same host code the file menu uses, and waits for the graph to follow each.

Measured with `yarn harness`, Apple M4, 1440×900, during a turn with the pointer at rest. CPU time covers update, render submission and labels. Camera moves, drags and hover render at up to 60 fps.

| Graph | Files | Imports | Directories | Draw calls | Triangles | CPU ms / frame | fps | First layout |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| this repository | 76 | 94 | 15 | 5 | 184 | 0.3 | 30 | 0.07 s |
| three.js r186 `src/` | 753 | 1,566 | 60 | 5 | 1,628 | 0.2 | 30 | 0.37 s |

Both rows were measured with the nested directory bubbles. Every file, bubble and import is still one draw call each, whichever directory is on screen.

## Known limits

- Only the first workspace folder is indexed, and it is where Claude runs.
- Live updates are incremental. An added file is not linked from files whose import of it looked external (Java and Kotlin imports, Ruby `require`, single-name Python imports, C# namespaces, Swift modules outside a SwiftPM package, Haskell, Elm, Lua and Perl modules, and paths written in configuration files) or already resolved to another file. A `.gitignore` change is noticed only with the next file event. Reindex fixes all of these.
- New files and directories are placed, not laid out, so a graph that changed a lot drifts from what a fresh layout would give, and a directory that gains many files crowds them inside its bubble; Reindex lays it out again. A bubble has the colour of the type most of its files are, so it can change colour as files come and go.
- Conversations live in the window: a window reload starts a new one, and up to 8 are kept at a time (the oldest idle one goes when another starts).
- View diff compares with HEAD, not with the branch's merge base, and the editor doesn't notice a commit made while it is open. The editor takes text files up to 4 MB; larger ones open in a tab.
- Without git, file listing uses Orbit's own exclude list rather than `files.exclude`.
- Regex import resolution is heuristic. A Go package, C# namespace or Swift module import links to at most four of its files, and F#, VB, SQL and a few other languages are nodes without edges.
- Twenty file types share eleven colours, and a few colours that can meet in one repository (Go against shell and infrastructure files for red-green colour blindness, Rust and Swift against shell) are closer than the rest; the legend and the hover text name the type too.
