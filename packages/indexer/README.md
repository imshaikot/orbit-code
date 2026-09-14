# @orbit-code/indexer

Indexes a workspace into the dependency graph [Orbit Code](https://orbit-code.imshaikot.com) ([source](https://github.com/imshaikot/orbit-code)) draws: files are nodes, imports are edges, and directories group them.

- **JS and TS** through dependency-cruiser, once per `tsconfig`/`jsconfig` so each package's path aliases apply, with workspace packages, `exports` and `imports` maps resolved too.
- **Other languages** (Python, Go, Rust, Java, C#, Swift, PHP, Dart and more) through import scans that resolve with each project's own manifests: `go.mod`, `Cargo.toml`, `pyproject.toml`, `composer.json`, `pubspec.yaml`, `.csproj`, `Package.swift`.
- **Configuration files** linked to the files and projects they name.

Imports resolve only against files in the graph, never against the disk. The bundle carries dependency-cruiser and TypeScript, so nothing else needs installing.

## CLI

```sh
npx @orbit-code/indexer <dir> --out graph.json [--max N]
npx @orbit-code/indexer <dir> --out next.json --previous graph.json   # incremental, as a live update runs
```

Files come from `git ls-files` in a work tree (so `.gitignore` applies), otherwise from a walk of the directory. The graph's hash covers file ids, sizes and edges, so an incremental run and a full index of the same files agree.

## As a worker thread

Orbit's editor hosts run `dist/indexer.mjs` on a `worker_threads` worker: `workerData` is an `IndexerRequest` and the messages back are `IndexerResponse`s, both defined in `@orbit-code/protocol`.

## License

MIT
