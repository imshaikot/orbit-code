# Orbit Code

An open-source, live 3D visual alternative to Claude Code in the terminal, for programmers and vibe coders alike: your codebase as a dependency graph, with Claude working through it as you watch. This repository holds the VS Code extension, the desktop app, and the editor-agnostic packages both are built from.

- **Use it in VS Code:** [apps/vscode/README.md](apps/vscode/README.md)
- **Use it as a desktop app:** [apps/desktop/README.md](apps/desktop/README.md)
- **Index a repository from the command line:** [packages/indexer/README.md](packages/indexer/README.md)

## Documentation

The [docs](docs/README.md) directory holds the longer pages:

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

Record a change worth releasing with `yarn nx release plan <bump> --projects=<project>`, and commit the plan with it. `yarn nx release --skip-publish` then applies the plans: it bumps versions, writes each project's `CHANGELOG.md`, commits and tags, `v<version>` for the extension, `desktop-v<version>` for the desktop app and `<project>-v<version>` for an npm package. Pushing a tag runs `.github/workflows/release.yml`, which publishes that release. [docs/releasing.md](docs/releasing.md) has the whole procedure.

## License

MIT
