# The graph pipeline

A full index builds the workspace graph once; live updates keep it current. The promise the pipeline keeps: **after a live update, the picture looks as if nothing was laid out again, and the graph is what a full index would produce.**

The pipeline spans five projects: `packages/indexer` (the worker and CLI), `packages/graph` (file kinds, the columnar graph, the directory tree, layout extension), `packages/core` (`GraphService`, `Store`, `ChangeBatcher`), the host (its file lister and watcher) and `packages/webview` (the layout worker and the `World`).

## Listing files

The host lists the files. In a git work tree that is `git ls-files`, so `.gitignore` applies; otherwise VS Code's `findFiles` with a fallback exclude list, or, in the desktop app, a walk of the folder with the same list. `ALWAYS_EXCLUDED_DIRS` (`node_modules`, `.git`, `bower_components`, `vendor`, `.harness`) are skipped even when tracked. The `maxFiles` setting (default 20,000, at least 100) truncates larger workspaces.

Which files become nodes is decided by `classify()` in `packages/graph/src/languages.ts`, by basename, then basename pattern, then extension. Each class names the file's **kind** (its colour and legend entry) and its **extractor**: `depcruise` for JavaScript and TypeScript, a regex rule set for another language, `config` for configuration files, or `none` for a node without edges. Lock files and other generated output are left out. The same tables build the host's watcher glob, so a new extension is also watched.

## Language coverage

| Kind | Extensions and files | Imports read by |
| --- | --- | --- |
| TypeScript, JavaScript | `.ts .tsx .mts .cts .js .jsx .mjs .cjs`; `.vue .svelte .astro` | dependency-cruiser, once per `tsconfig`/`jsconfig` so each package's path aliases apply; the regex scanner as its fallback |
| Python | `.py .pyi .pyw .pyx .pxd`, `.ipynb` | Regex, resolved through `pyproject.toml` source roots |
| Go | `.go` | Regex, through `go.mod` and `go.work` |
| Rust | `.rs` | Regex, through `Cargo.toml` crates |
| Java & Kotlin | `.java .kt .kts .scala .sc .groovy .gvy`, `.clj .cljs .cljc` | Regex |
| C & C++ | `.c .h .cc .cpp .cxx .hpp .hh .m .mm .cu` and more | Regex |
| C# & .NET | `.cs .csx` (`.fs .vb`: nodes without edges) | Regex, through `.csproj` root namespaces |
| Swift | `.swift` | Regex, through SwiftPM targets |
| Ruby | `.rb .rake .ru`, `Rakefile`, `Gemfile` and friends | Regex |
| PHP | `.php .phtml`, `*.blade.php` | Regex, through `composer.json` PSR-4 prefixes |
| Dart | `.dart` | Regex, through `pubspec.yaml` names |
| Elixir & Erlang | `.ex .exs .erl .hrl` (`.gleam`: no edges) | Regex, Elixir modules under `lib/<app>` |
| HTML & templates | `.html .htm`, Nunjucks, Jinja, Twig, Liquid, EJS, Pug, Razor | Regex; some template languages are nodes without edges |
| Styles | `.css .scss .sass .less .styl .pcss` | Regex |
| Shell | `.sh .bash .zsh .fish`, PowerShell | Regex |
| SQL & schemas | `.proto .graphql .gql` (`.sql .prisma .thrift`: no edges) | Regex |
| Infrastructure | Terraform, HCL, Nix, `Dockerfile`, Compose files, `Vagrantfile` | Regex, or the config scan |
| Other code | Haskell, Elm, Lua, Perl, R, Julia, Zig, Nim, Crystal, Solidity; OCaml, ReScript, Fortran, assembly, Verilog, Lisp and shader languages as nodes without edges | Regex |
| Project config | `.toml .yaml .yml .ini .gradle .cmake .csproj .sln` and the manifests of every ecosystem (`package.json`, `tsconfig.json`, `go.mod`, `pom.xml`, `CMakeLists.txt`, `Makefile`, `Procfile`, …) | The config scan: entry points, `extends` and references, workspace members, modules, subdirectories, Dockerfiles |

Twenty kinds share eleven colours; kinds that seldom share a repository share one, and the legend lists them together.

## Indexing

The worker (`packages/indexer/dist/indexer.mjs`, started by `IndexClient` on a `worker_threads` thread, or run as the `orbit-index` CLI):

1. Stats every file and reads the project manifests wherever they sit: package names, entry points and `exports`/`imports` maps, the tsconfig governing each file, Go modules, Cargo crates, Python source roots, PSR-4 prefixes, pubspec names, `.csproj` root namespaces and SwiftPM targets.
2. Runs dependency-cruiser over JavaScript and TypeScript in batches of 400, once per tsconfig or jsconfig. Bare specifiers it can't follow into the graph (a workspace package without `node_modules`, an `exports` map, `@/`) go through Orbit's own resolver.
3. Runs the regex scanner over every other language, resolving through the same manifests, plus any batch dependency-cruiser threw on. The config scan links configuration files to what they name.
4. Resolves imports only against files in the graph, never against the disk.

The graph (`graph.json`) holds the nodes (id, size, mtime, a count of unresolved local imports), the edges, the stats, `projects` (a fingerprint of what resolution took from the manifests) and a **hash**: sha1 over file ids, sizes and edges. The hash is computed the same way by a full index and an incremental run, so an unchanged hash means nothing drawn changed, and it keys the cached layout.

**Unresolved and external are different.** An import a resolver can't match is either local but unresolved (counted on the node, and re-read when files are added) or external (never re-read). Which is which is decided by the manifests: a dotted Python import of a package under a source root is local, `numpy` is external.

## The cache

`Store` keeps `orbit-v1/` in the host's storage directory: `graph.json` and up to four `layout-<hash>.bin` files, keyed only by the graph hash. Consequences:

- After changing an extractor, run **Reindex**: live updates reuse the edges of files that didn't change, so they won't pick up an extractor change.
- After changing the layout's output, Reindex lays out again, but a plain load with an unchanged hash reuses the old layout; bumping `LAYOUT_VERSION` in `packages/core/src/store.ts` (2 at the time of writing) redoes it everywhere.
- A `layout-<hash>.bin` may be an extended layout written by a live update rather than a worker run; the format is the same.
- `GraphService` keeps the loaded graph for the life of the host and updates it in place, so reopening the panel shows the current graph without re-reading the cache.

## Layout

With no cached layout, the page runs the layout worker (`packages/webview/src/layout/nested.ts`, inlined into the bundle and started from a Blob URL):

- Every directory with files under it is a bubble inside its parent's bubble. Labels are in canonical order (`.` first, parents before children, subtrees contiguous), and the hierarchy is derived from the labels alone. Past 65,535 bubbles the deepest levels are left out and their files sit in the nearest kept ancestor.
- Bottom-up, one d3-force-3d simulation per directory places its own files and its already laid out sub-directory bubbles; the bubble's radius encloses them plus a margin. An import pulls at the one level where it is drawn. Bubbles sit on their parent's plane, a fixed gap apart; files in a directory without sub-directories spread in 3D.
- Deterministic: fixed tick counts and a seeded random generator.

The result goes back to the host as `layoutComputed` and is saved. The Flat view's layout (`flatLayout.ts`) is computed in the page when Flat is first shown and never cached.

## Live updates

```
file created / changed / deleted / renamed
  │ the host's watcher (VS Code file system watchers; a recursive fs.watch in the desktop app)
  ▼ ChangeBatcher      workspace ids, excluded directories dropped, 1.5 s debounce, 5 s at most; flushed when a turn ends
  ▼ GraphService       refresh(): one update at a time, later requests merged, superseded by load()
  │                    returns early when no path can matter; re-lists the files; stops if the ids are unchanged and no graph file was touched
  ▼ indexer worker     gets the previous graph and the touched files; stats everything; re-extracts only what the change affects
  ▼ extendLayout       kept files keep their position; bubbles keep centre and radius; new files and directories are placed
  ▼ GraphService       writes graph.json and layout-<newhash>.bin; logs `graph updated <hash>: +A −R ~C files, E edges in N ms`
  ▼ controller         an `update` delta if the page holds the base graph, else a reset carrying the layout
  ▼ the page           a new World adopts the old one's animation state through the index remap; logs `graph update applied`
```

**What is re-read.** New files; files whose size or mtime changed, or that the watcher reported; importers of removed files; files with unresolved imports when something was added; and everything when `projects` differs from the previous graph's (a package name, an `exports` map, a tsconfig or a source root changed) or when more than 30% would be read anyway. Other edges are reused. When the hash comes out unchanged, only the new mtimes and fingerprint are written and nothing is sent.

**Placing new things.** `extendLayout` in `packages/graph/src/layoutExtend.ts` is pure and shared with the harness. A new file goes into its directory's bubble, near its placed import neighbours, else near that bubble's other files, else at its centre, at the nearest free spot. A directory without a bubble gets one inside its deepest existing ancestor, in a spot a sibling emptied by this update when that fits, else at the free spot nearest what its files import; short of room, it shrinks rather than overlap its siblings. A bubble with no room inside grows to take a spot just outside, and its parents with it as far as they must, unless that runs into anything beside them. Emptied bubbles are dropped.

**Renames.** A rename or delete from the file card doesn't wait for the watcher: the controller calls `refresh()` as soon as the edit lands and passes the rename along, so a file renamed within its directory keeps its position and its animation state. A rename made in the editor or by git arrives as a delete and a create, and the file is placed like a new one.

**In the page.** `SceneController` applies an update only on top of the graph it holds; otherwise it treats it as a reset (with the layout carried, so no worker run). The new `World` adopts shared uniforms, per-file state, comets in flight, Claude's stars and MCP stations, the directory the camera is inside of and any camera move under way. If that directory is gone, the camera backs out to its nearest remaining ancestor. Added files pulse: with an edit glow and the star moving to the last of them during a turn, with one self-fading pulse otherwise.

## Known staleness

Live updates are incremental, so some imports go stale until Reindex:

- An added file isn't linked from importers that treated the import as external rather than unresolved: single-name Python imports, JVM imports, Ruby `require`, C# namespaces, Swift modules outside a SwiftPM package, Haskell, Elm, Lua, Perl and Clojure modules, and path strings in configuration files.
- It isn't linked from importers whose import already resolved elsewhere (a closer candidate, the first files of a Go package, C# namespace or Swift target).
- A file that newly enters the listing without being created (a `.gitignore` or `maxFiles` change) needs some file event to be noticed.
- dependency-cruiser returns no dependencies for some files depending on what else is in the same batch, so an incremental run can find edges a full index misses, or the reverse.
- New files and directories are placed, not laid out. Sibling bubbles are packed close, so a directory that gains many files crowds them until Reindex.

## Running the indexer alone

```sh
yarn index <dir> --out graph.json [--max N]                         # a full index; needs a prior build
yarn index <dir> --out next.json --previous graph.json               # an incremental run, as a live update does it
npx @orbit-code/indexer <dir> --out graph.json                       # the published package
```

Comparing an incremental run's hash with a full index of the same files is the check that the planner missed nothing.
