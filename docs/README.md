# Orbit Code documentation

Orbit Code is an open-source, live 3D visual alternative to Claude Code in the terminal, for programmers and vibe coders alike. It renders a workspace as a 3D force-directed dependency graph and animates a live Claude Code session moving through it, and ships as a VS Code extension and as an Electron desktop app, both built from the same engine and the same UI in this monorepo.

Start with the page that matches what you want to do.

| Page | For |
| --- | --- |
| [Using Orbit](using-orbit.md) | Reading the view, navigating, prompting Claude, answering permissions, the file card, the Flat view and the tour |
| [Architecture](architecture.md) | The three bundles, the services, and how a graph, a layout and a Claude turn flow between them |
| [The graph pipeline](graph-pipeline.md) | Indexing, language coverage, the graph hash, live updates and the layout |
| [Claude in Orbit](claude-session.md) | How the `claude` CLI is run, conversations, permissions, questions, MCP, skills, files, history and subagents |
| [The webview](webview.md) | The three.js scene, focus and levels, GPU picking, the frame loop, colours, the HUD, and the constraints it is built under |
| [Hosts](hosts.md) | What VS Code and the desktop app each provide, and what a third editor would have to |
| [The monorepo](monorepo.md) | Projects, tags, boundaries, TypeScript per runtime, Nx targets and caching |
| [Contributing](contributing.md) | The dev loop, where a change goes, the checks, CI and the commit conventions |
| [Releasing](releasing.md) | Version plans, release groups, tags, and publishing to the Marketplace, Open VSX, GitHub releases and npm |
| [Troubleshooting](troubleshooting.md) | Logs, caches, and the failures with a known cause |

The READMEs beside the code stay the short version: [apps/vscode/README.md](../apps/vscode/README.md) for the extension's install, commands and settings, [apps/desktop/README.md](../apps/desktop/README.md) for the desktop app, and [packages/indexer/README.md](../packages/indexer/README.md) for the indexer's command line.

## Conventions in these pages

- Paths are relative to the repository root. `apps/` holds the two hosts, `packages/` the libraries, `tools/` the harness and scripts.
- Commands are the root `yarn` scripts, run from the repository root. `yarn nx run <project>:<target>` reaches any target directly.
- "The host" is whichever program runs the engine: VS Code's extension host or the desktop app's main process. "The page" or "the webview" is the UI bundle either one shows.
- Versions quoted here (VS Code 1.100, Electron 44.3.0, Claude Code 2.1.267, protocol 13) are the ones the code was last checked against; the manifests and `packages/protocol/src/protocol.ts` are authoritative.
