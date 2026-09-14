# Orbit Code

[![CI](https://github.com/imshaikot/orbit-code/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/imshaikot/orbit-code/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/imshaikot/orbit-code?logo=github)](https://github.com/imshaikot/orbit-code/releases)
[![VS Marketplace](https://vsmarketplacebadges.dev/version-short/imshaikot.orbit-code.svg)](https://marketplace.visualstudio.com/items?itemName=imshaikot.orbit-code)
[![npm](https://img.shields.io/npm/v/@imshaikot/orbit-code-server?logo=npm&label=npm%20server)](https://www.npmjs.com/package/@imshaikot/orbit-code-server)
[![Electron](https://img.shields.io/github/package-json/dependency-version/imshaikot/orbit-code/dev/electron?filename=apps%2Fdesktop%2Fpackage.json&logo=electron&label=Electron)](apps/desktop)
[![three.js](https://img.shields.io/github/package-json/dependency-version/imshaikot/orbit-code/three?filename=packages%2Fwebview%2Fpackage.json&logo=threedotjs&label=three.js)](packages/webview)
[![TypeScript](https://img.shields.io/github/package-json/dependency-version/imshaikot/orbit-code/dev/typescript?logo=typescript&label=TypeScript)](tsconfig.base.json)
[![Nx](https://img.shields.io/github/package-json/dependency-version/imshaikot/orbit-code/dev/nx?logo=nx&label=Nx)](nx.json)
[![Yarn](https://img.shields.io/badge/Yarn-4-2C8EBB?logo=yarn&logoColor=white)](package.json)
[![Node](https://img.shields.io/badge/Node-22-5FA04E?logo=nodedotjs&logoColor=white)](.github/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/imshaikot/orbit-code)](LICENSE)
[![Website](https://img.shields.io/badge/website-orbit--code.imshaikot.com-a58bff)](https://orbit-code.imshaikot.com)

[![Claude Code refactoring a file in Orbit Code: its star moves through the 3D dependency graph, the view turns Flat, and a permission card asks to allow a command](docs/media/orbit-code-demo.webp)](docs/media/orbit-code-demo.mp4)

<p align="center"><a href="docs/media/orbit-code-demo.mp4">Watch the full demo (1:44)</a></p>

An open-source, live 3D visual alternative to Claude Code in the terminal, for programmers and vibe coders alike: your codebase as a dependency graph, with Claude working through it as you watch. This repository holds the VS Code extension, the desktop app, and the editor-agnostic packages both are built from.

- **Install it, read the docs and the changelog:** [orbit-code.imshaikot.com](https://orbit-code.imshaikot.com)
- **Use it in VS Code:** [apps/vscode/README.md](apps/vscode/README.md)
- **Use it as a desktop app:** [apps/desktop/README.md](apps/desktop/README.md)
- **Index a repository from the command line:** [packages/indexer/README.md](packages/indexer/README.md)

## Install

```sh
code --install-extension imshaikot.orbit-code                 # VS Code, from the Marketplace
curl -fsSL https://orbit-code.imshaikot.com/install.sh | sh   # Cursor, Windsurf, VSCodium and other VS Code based editors
irm https://orbit-code.imshaikot.com/install.ps1 | iex        # the same, in Windows PowerShell
```

Sessions need [Claude Code](https://docs.claude.com/en/docs/claude-code) installed and signed in; the graph works without it. The desktop app runs from a clone for now (`yarn install && yarn desktop --folder <path>`, see [apps/desktop/README.md](apps/desktop/README.md)). The [install guide](https://orbit-code.imshaikot.com/install/) has every option and how each one updates.

## Documentation

The [docs](docs/README.md) directory holds the longer pages, which are also published at [orbit-code.imshaikot.com/docs](https://orbit-code.imshaikot.com/docs/):

| Page | For |
| --- | --- |
| [Using Orbit](docs/using-orbit.md) | Reading the view, navigating, prompting Claude, permissions, the file card, the Flat view and the tour |
| [Architecture](docs/architecture.md) | The three bundles, the services, the protocol, the data flow and the security constraints |
| [The graph pipeline](docs/graph-pipeline.md) | Indexing, language coverage, the cache, live updates and the layout |
| [Claude in Orbit](docs/claude-session.md) | How the `claude` CLI is run: conversations, permissions, questions, MCP, skills, files, history, subagents |
| [The webview](docs/webview.md) | The three.js scene, focus and levels, GPU picking, the frame loop, the HUD and the build's constraints |
| [Hosts](docs/hosts.md) | What VS Code and the desktop app each provide, and how a third editor would host Orbit |
| [The monorepo](docs/monorepo.md) | Projects, tags, the boundary check, TypeScript per runtime, Nx targets and caching |
| [Contributing](docs/contributing.md) | The dev loop, where a change goes, the checks, CI and the commit conventions |
| [Releasing](docs/releasing.md) | Version plans, release groups, tags and publishing |
| [Troubleshooting](docs/troubleshooting.md) | Logs, caches and the failures with a known cause |

## Layout

| Path | Package | What it is |
| --- | --- | --- |
| `apps/vscode` | `orbit-code` | The VS Code extension, packaged as a `.vsix` for the Marketplace and Open VSX |
| `apps/desktop` | `@orbit-code/desktop` | The desktop app: Electron, with installers for macOS, Windows and Linux |
| `apps/server` | `@imshaikot/orbit-code-server` | The local server, for a browser or an editor without a web view; published to npm (early: it reports its version only) |
| `packages/protocol` | `@orbit-code/protocol` | The messages between a host, the webview and the workers |
| `packages/graph` | `@orbit-code/graph` | File kinds, the columnar graph, the directory tree, layout extension |
| `packages/common` | `@orbit-code/common` | Events, disposables, logging and batching, for any host |
| `packages/indexer` | `@orbit-code/indexer` | Workspace to dependency graph, as a worker thread and a CLI; published to npm |
| `packages/agent` | `@orbit-code/agent` | Claude Code conversations over the `claude` CLI |
| `packages/core` | `@orbit-code/core` | The editor-agnostic host: the graph, live updates, Claude's activity, and the controller every host shares |
| `packages/webview` | `@orbit-code/webview` | The UI: the three.js scene and the HUD |
| `tools/harness` | `@orbit-code/harness` | Headless Chrome checks of the webview against a simulated host |

Each project is tagged with the runtime its code needs (neutral, node, browser, vscode or electron), and `yarn boundaries` keeps every import within those lines. Only `apps/vscode` touches the VS Code API and only `apps/desktop` touches Electron's, so both hosts share the engine, the controller, the protocol and the webview.

## Development

```sh
yarn install
yarn build            # every project, through Nx
yarn typecheck
yarn boundaries
yarn self             # build and open this repository in an Extension Development Host (or press F5)
yarn watch            # rebuild on change
yarn harness          # webview checks in headless Chrome
yarn smoke            # end-to-end in a real VS Code
yarn package          # dist/apps/vscode/orbit-code-<version>.vsix
yarn desktop --folder .   # build and open this repository in the desktop app
yarn desktop:smoke    # end-to-end in the desktop app
yarn desktop:package  # dist/apps/desktop: a dmg and zip, an NSIS installer or an AppImage
yarn nx graph         # the project graph
```

Nx 23 runs and caches the tasks; Yarn 4 workspaces link the packages, which import each other's sources directly. [docs/contributing.md](docs/contributing.md) has the dev loop, the checks and where a change goes; [docs/monorepo.md](docs/monorepo.md) the workspace's rules.

## Releases

Record a change worth releasing with `yarn nx release plan <bump> --groups=apps` (the extension and the desktop app, released together) or `--projects=<package>` for an npm package, and commit the plan with it. `yarn nx release --skip-publish` then applies the plans: it bumps versions, writes each project's `CHANGELOG.md`, commits and tags, `v<version>` for the apps and `<project>-v<version>` for an npm package. Pushing a `v` tag runs `.github/workflows/release.yml`, which builds the `.vsix` and the macOS dmgs and publishes them in one GitHub release with that version's changelog. [docs/releasing.md](docs/releasing.md) has the whole procedure.

## License

MIT
