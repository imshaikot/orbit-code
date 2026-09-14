<!-- Thanks! CONTRIBUTING.md has the checks and the commit conventions. For a larger change, link the issue where its shape was agreed. -->

## What and why

<!-- What changes for someone using Orbit, or working on it. "Fixes #123" closes the issue on merge. -->

## Where

- [ ] VS Code extension (`apps/vscode`)
- [ ] Desktop app (`apps/desktop`)
- [ ] Shared host (`packages/core`, `packages/agent`)
- [ ] Page (`packages/webview`)
- [ ] Indexer or graph (`packages/indexer`, `packages/graph`)
- [ ] Protocol (`packages/protocol`), with `tools/harness/src/hostSim.ts` updated to match
- [ ] Docs, CI or tooling

## Checks

<!-- Tick what you ran. If you couldn't run one (no Chrome, no Claude Code), say so; CI runs the rest. -->

- [ ] `yarn typecheck`, `yarn build`, `yarn boundaries`
- [ ] `yarn harness`, and I read `.harness/out/report.json`
- [ ] `yarn smoke`
- [ ] `yarn desktop:smoke`
- [ ] A real Claude turn: `ORBIT_SMOKE_PROMPT="…" ORBIT_SMOKE_MODEL=haiku yarn smoke`
- [ ] Tried by hand with `yarn self` or `yarn desktop --folder .`

## Screenshots

<!-- For anything visible: before and after, or a short recording. -->

## Release

- [ ] Users will notice this, and I added a version plan (`yarn nx release plan <bump> --projects=<project> -m "…"`)
- [ ] No release needed (docs, CI, internal)
