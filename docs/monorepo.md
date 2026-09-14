# The monorepo

An Nx workspace (package-based, a `project.json` per project) over Yarn 4 workspaces, cut along one line: **what a module needs from where it runs**. Code that needs nothing but JavaScript is neutral and goes everywhere; code that needs Node runs in a host or the indexer worker; code that needs the DOM is the UI; only an editor app touches an editor's API.

## Projects

| Project | Package | Tags | Holds |
| --- | --- | --- | --- |
| `packages/protocol` | `@orbit-code/protocol` | lib, neutral | Every message that crosses a boundary; workspace ids; MCP tool names |
| `packages/graph` | `@orbit-code/graph` | lib, neutral | File kinds, the columnar graph, the directory tree, layout extension, node radius |
| `packages/common` | `@orbit-code/common` | lib, neutral | `Emitter`, `Event`, `Disposable`, `Logger`, `TickBatcher` |
| `packages/indexer` | `@orbit-code/indexer` | lib, node, publish:npm | The indexer worker and the `orbit-index` CLI; `listFiles` for hosts |
| `packages/agent` | `@orbit-code/agent` | lib, node | Claude Code conversations, the CLI backend, stream-json, permissions, the catalog, history |
| `packages/core` | `@orbit-code/core` | lib, node | The editor-agnostic host: `GraphService`, `Store`, the indexer client, `ChangeBatcher`, `SessionProjector`, the controller, settings |
| `packages/webview` | `@orbit-code/webview` | lib, browser | The UI, built to `dist/webview.js` |
| `apps/vscode` | `orbit-code` | app, vscode, publish:vscode | The VS Code extension |
| `apps/desktop` | `@orbit-code/desktop` | app, electron, publish:desktop | The Electron desktop app |
| `tools/harness` | `@orbit-code/harness` | tool, browser | The simulated host and the headless Chrome harness |

```
neutral   protocol ◄──── graph            common
             ▲             ▲                 ▲
node      indexer ─────────┘ (+ protocol)    │
          agent ── protocol ─────────────────┤
          core ─── agent, graph, protocol, common, indexer/listFiles
browser   webview ─ graph, protocol                  harness ─ graph, protocol, common
vscode    apps/vscode ─ core, agent, graph, protocol, common, indexer/listFiles; ships the indexer and webview builds
electron  apps/desktop ─ the same
```

## Where code goes

Ask, in order:

1. **Does it call an editor's API?** That editor's app.
2. **Does it need Node?** If it extracts imports or needs dependency-cruiser or TypeScript: `packages/indexer`, from which only `listFiles` is imported outside. If it is about Claude sessions and knows nothing of graphs: `packages/agent`. If it joins graphs, sessions and files on behalf of a host: `packages/core`.
3. **Does it need the DOM?** `packages/webview`, or `tools/harness` for test pages.
4. **Otherwise it is neutral.** Part of a message's shape: `packages/protocol`. Computing on graphs, paths or layouts: `packages/graph`. Plumbing any service needs: `packages/common`.

A service in core or agent takes editor facts as options and never asks an editor. A neutral package doesn't gain a Node or DOM import to save a copy: if two runtimes need the same logic, the logic is neutral and each runtime wraps it. A new package is worth its manifest only when it holds a different runtime or a different reason to change.

## The boundary check

`yarn boundaries` (`tools/scripts/check-boundaries.mjs`, also in CI) reads each project's `src/` imports and `package.json` and fails on:

- **Tags.** Anything but exactly one `type:` (lib, app, tool) and one `runtime:` (neutral, browser, node, vscode, electron) per project.
- **Type.** A lib depending on anything but libs; an app or tool depending on an app or tool.
- **Runtime.** Neutral imports neutral; browser imports neutral and browser; node imports neutral and node; vscode and electron import neutral and node too. Only `runtime:vscode` imports `vscode`. Node builtins are refused in neutral and browser code.
- **Declared.** An import of a package the project's `package.json` doesn't list, or a relative import leaving the project's `src/`.
- **Indexer.** Any `@orbit-code/indexer` import but `listFiles` outside the indexer, so dependency-cruiser and TypeScript stay in the worker.

It can't see what a bundle pulls in transitively (the extension's wiring check follows the extension's imports into every package for that) or globals: a DOM or Node global in the wrong package fails that package's own typecheck instead, because its tsconfig doesn't declare it.

## Packages

- A workspace package exports its sources module by module: `"./*": "./src/*.ts"`. Consumers import `@orbit-code/graph/languages`, and typecheck and bundle each other's sources directly; there is no build step between libraries and no barrel.
- `dependencies` are what the code imports (workspace packages as `workspace:*`, npm packages pinned exactly, the same version everywhere). `devDependencies` are types and the builds a project only ships (`@orbit-code/webview` for the extension and the harness). The desktop app lists every workspace package as a devDependency, because electron-builder copies an app's `dependencies` into the package and everything is bundled already.
- Workspace-wide tools (`nx`, `@nx/js`, `typescript`, `esbuild`, `@types/node`) are root devDependencies.
- `.yarnrc.yml` keeps a `node_modules` tree, because the build scripts and tools run under plain Node, which can't resolve Plug'n'Play packages. Workspace packages are symlinked into `node_modules/@orbit-code/`.
- Names are `@orbit-code/<dir>`; the extension keeps `orbit-code`, its Marketplace identity. Manifests are `private: true` with a one-sentence description and `license: MIT`.

## TypeScript per runtime

`tsconfig.base.json` holds the compiler options (`noEmit`, `moduleResolution: bundler`, strict). Each project's `tsconfig.json` extends it and adds only its runtime:

| Runtime | Adds |
| --- | --- |
| neutral | ES2023 and `tools/typescript/neutral-globals.d.ts` (timers and `console`, nothing else) |
| node | `"types": ["node"]` |
| browser | the DOM libs |
| vscode | `"types": ["node", "vscode"]` |
| electron | `"types": ["node"]` and the DOM (the preload sees the page's window); Electron's types come with its package |

A project's typecheck also checks the workspace sources it imports, under its own settings. esbuild doesn't typecheck, so `yarn typecheck` is a separate step. The `build.mjs` files, `scripts/`, `test/` and `tools/**/*.mjs` are plain JavaScript and aren't typechecked; `node --check` catches syntax errors in them.

## Targets

| Target | Projects | Does |
| --- | --- | --- |
| `build` | indexer, webview, vscode, desktop, harness | `node build.mjs [--production]` in the project, writing its `dist/`. Depends on `^build`, so `-c production` reaches the dependencies. The webview's runs its constraint check first |
| `typecheck` | every project | `tsc -p tsconfig.json`, from the target defaults |
| `watch` | the same as build | `build.mjs --watch`, continuous; `vscode:watch` starts the indexer and webview watches and copies their builds in as they change |
| `package` | vscode, desktop | A production build, then vsce or electron-builder. Uncached for the desktop, whose output is per platform |
| `smoke`, `e2e`, `start` | vscode, desktop, harness | Uncached, after a build |
| `nx-release-publish` | indexer, vscode, desktop | npm, the Marketplace and Open VSX, or GitHub release assets |

Each build writes nothing outside its own `dist/`; an app copies what it ships from its dependencies' `dist/`. Nx caches `build` and `typecheck` in `.nx/cache` from each project's files, `tsconfig.base.json`, `tools/typescript` and the sources of what it depends on, but not the environment: after upgrading Node or changing a build script's environment, `yarn nx reset`.

Nx passes a configuration along `^build` but not along a `dependsOn` on the same project, which is why `vscode:package` runs `nx run vscode:build:production` itself, and why `package.mjs` refuses a `dist/` still holding source maps.

```sh
yarn nx show projects                          # every project
yarn nx show project vscode --json             # its targets
yarn nx graph                                  # the project graph in a browser
yarn nx run-many -t typecheck build -p webview indexer
yarn nx affected -t typecheck build --base=main
yarn nx reset                                  # clear the cache and stop the daemon
```

Arguments after a root script reach the script Nx runs: `yarn harness --graph g.json` runs the harness on that graph after Nx built what it needs.

## Adding a library

1. Create `packages/<name>` with a `package.json` (source exports, `private: true`), a `project.json` (name, `projectType`, `sourceRoot`, tags, `"typecheck": {}`), a `tsconfig.json` for its runtime and `src/<name>.ts`.
2. `yarn install`, which links it into `node_modules/@orbit-code/`.
3. Add `"@orbit-code/<name>": "workspace:*"` to the `dependencies` of each project that imports it, then `yarn install` again: the lockfile records workspace dependencies, and CI installs with `--immutable`.
4. `yarn nx show project <name>`, `yarn typecheck`, `yarn boundaries`.
5. Add its row to the table above and to the root README's layout table.

## Moving code between packages

1. `git mv` the file, so history follows it.
2. Imports inside the new package become relative; imports of it from elsewhere become `@orbit-code/<pkg>/<module>`.
3. Update the `dependencies` of the package that lost it, the one that gained it, and every importer; `yarn install`.
4. `yarn typecheck && yarn boundaries && yarn build`.
5. Grep the old path: the smoke suite names graph files, the harness names sources, and `ci.yml` checks that `packages/webview/src/main.ts` is in the indexed graph.

## Gotchas

- `node_modules/@orbit-code/*` are relative symlinks. A copy of the workspace whose `node_modules` is a symlink to this one builds *this* workspace's sources; run `yarn install` in the copy.
- A new project shows up in Nx from its `project.json`, but nothing resolves `@orbit-code/<name>` until `yarn install` has linked it. A target that "doesn't exist" right after adding it: `yarn nx reset`.
- Neutral means neutral: `TextEncoder`, `URL`, `structuredClone` and `performance` aren't ECMAScript, so neutral packages don't have them unless `neutral-globals.d.ts` declares them.
- The test runners write into the workspace: the smoke creates `packages/graph/src/__orbitSmoke*.ts` for a few seconds, and the harness writes `.harness/` at the root.
