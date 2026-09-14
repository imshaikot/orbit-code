# Contributing to Orbit Code

Thanks for taking the time. Orbit Code is an open-source, live 3D visual alternative to Claude Code in the terminal, for programmers and vibe coders alike: it draws a workspace as a 3D dependency graph and animates a Claude Code session moving through it, as a VS Code extension and as a desktop app. Bug reports, imports your language is missing, docs fixes and code are all welcome.

Taking part means following the [code of conduct](CODE_OF_CONDUCT.md).

## Before you start

- **A bug:** search [the issues](https://github.com/imshaikot/orbit-code/issues) first, then open one with the bug form and attach the Orbit log ([troubleshooting](docs/troubleshooting.md) says where it is).
- **A security problem:** don't open an issue; follow [SECURITY.md](SECURITY.md).
- **A larger change** (a feature, import resolution for another ecosystem, another editor): open an issue first, so the shape is agreed before you spend the time. Small fixes can go straight to a pull request.
- **Somewhere to start:** issues labelled [`good first issue`](https://github.com/imshaikot/orbit-code/labels/good%20first%20issue).
- **A problem with Claude Code itself** (the `claude` CLI, login, models, its answers) belongs in [Claude Code's issues](https://github.com/anthropics/claude-code/issues). Orbit runs the CLI you installed.

## Setting up

You need:

- Node 22, the version CI runs, with Corepack enabled for the pinned Yarn 4;
- VS Code with its `code` command, for the Extension Development Host;
- Google Chrome, for the harness;
- optionally [Claude Code](https://docs.claude.com/en/docs/claude-code), installed and logged in. Without it the graph still works, and the sessions report Claude as unavailable.

```sh
git clone https://github.com/imshaikot/orbit-code.git
cd orbit-code
corepack enable
yarn install              # ELECTRON_SKIP_BINARY_DOWNLOAD=1 skips Electron if you won't run the desktop app
yarn build
yarn self                 # opens this repository in an Extension Development Host (or press F5)
```

`yarn watch` rebuilds on change, and `yarn desktop --folder .` opens the desktop app instead. [docs/contributing.md](docs/contributing.md) has the whole dev loop and a table of where each kind of change goes.

## Where code goes

The repository is an Nx monorepo cut by where code runs; the [README](README.md#layout) lists the projects. In short:

- only `apps/vscode` touches the VS Code API, and only `apps/desktop` touches Electron's;
- `packages/core` and `packages/agent` are the host both apps share, and `packages/webview` the page both show;
- `packages/protocol`, `packages/graph` and `packages/common` import neither Node nor the DOM.

`yarn boundaries` fails on an import across those lines. A few more rules the builds and reviews hold to:

- A message between the host and the page changes `packages/protocol`, `packages/core/src/controller.ts`, and the harness's simulated host, `tools/harness/src/hostSim.ts`.
- The webview build refuses `http://` or `https://` anywhere under `packages/webview/src` (comments included), `fetch`, and `Raycaster`: the page has no network, and picking is on the GPU.
- Text from transcripts, tools and files goes into the DOM as `textContent`, never HTML.
- Anything that ends up on the `claude` command line is validated first.

[docs/architecture.md](docs/architecture.md) explains why.

## Checks

There is no unit-test runner or linter. Run what your change touches:

| Change | Run |
| --- | --- |
| Anything | `yarn typecheck`, `yarn build`, `yarn boundaries` |
| The page: scene, HUD, frame loop, protocol, the shared controller | `yarn harness`, then read `.harness/out/report.json`. It only fails when the scene never loads |
| The extension's manifest, commands, settings or panel | `yarn smoke` |
| The desktop app | `yarn desktop:smoke` |
| The Claude session, CLI arguments or stream-json parsing | `ORBIT_SMOKE_PROMPT="Read package.json and reply with its name" ORBIT_SMOKE_MODEL=haiku yarn smoke`, one small paid turn |
| The indexer or live updates | `yarn index . --out graph.json` before and after, and **Orbit Code: Reindex Workspace** in the dev host |

CI runs typecheck, build, boundaries, an index of this repository, packaging, both smoke tests and the harness on every pull request. If you can't run a check locally (no Chrome, no Claude Code), say so in the pull request.

## Pull requests

- One change per pull request. Several commits are welcome: one per module or step, in the order a reader would follow.
- A commit's subject line is its message, under 100 characters. Use `<Area>: <description>` when the change sits in one module (`Webview:`, `HUD:`, `Indexer:`, `Session service:`, `Desktop:`, `Harness:`, `README:`), or a plain sentence when it doesn't. The description is lowercase, with no trailing period. `git log --oneline` shows the convention.
- For anything visible, add screenshots or a short recording; the harness writes screenshots to `.harness/out/`.
- Update the README or docs page your change makes wrong.
- If users will notice the change in a release, add a version plan and commit it with the change: `yarn nx release plan patch --projects=vscode -m "…"` (or `desktop`, or `indexer`). The maintainer cuts releases; [docs/releasing.md](docs/releasing.md) has the procedure.

## License

Contributions are released under the project's [MIT license](LICENSE).
