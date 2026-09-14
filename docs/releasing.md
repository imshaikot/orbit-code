# Releasing

Releases are cut with Nx Release using **version plans**, because commit subjects here aren't conventional commits. A plan is a small Markdown file that says what gets which bump and why; `nx release` applies the plans, writes the changelogs, commits and tags; pushing the tag makes `.github/workflows/release.yml` build and publish.

The VS Code extension and the desktop app are released together: one version, one `v<version>` tag, one GitHub release holding the `.vsix` and the macOS dmgs, with that version's changelog as its notes.

## Release groups

`nx.json` defines two groups, by tag:

| Group | Projects | Tag | Publishes to |
| --- | --- | --- | --- |
| `apps` | `apps/vscode` (`publish:vscode`) and `apps/desktop` (`publish:desktop`), fixed: one version for both | `v<version>` | A GitHub release with the `.vsix` and a dmg each for Apple silicon and Intel; the Visual Studio Marketplace and Open VSX |
| `npm` | `packages/indexer`, `apps/server` and any other `publish:npm` project, versioned independently | `<project>-v<version>` | npm, with provenance |

A dependent is never bumped for a dependency's release (`updateDependents: never`), and a minor bump below 1.0 is applied as a minor, not a patch (`adjustSemverBumpsForZeroMajorVersion: false`). Each project gets its own `CHANGELOG.md`, without author lines; there is no workspace changelog.

## Cutting a release

1. **With the change worth releasing**, write a plan and commit it in the same commit:

   ```sh
   yarn nx release plan patch --groups=apps -m "Fix the file card's position after a live update"
   yarn nx release plan minor --projects=indexer -m "…"
   ```

   This writes `.nx/version-plans/version-plan-<time>.md`. The message becomes the changelog entry and the GitHub release notes, so write it for users. Name the `apps` group rather than one app: a plan naming only `vscode` still bumps both, but leaves the desktop app's changelog a bare "version bump only" line. Add `--only-touched=false` when the change touched none of the apps' files.

2. **Check, then release:**

   ```sh
   node .claude/skills/release/scripts/check-release.mjs   # the group, the plans, the files the packages take from git, the workflow
   yarn nx release --dry-run --skip-publish                # what would happen
   yarn nx release --skip-publish
   node .claude/skills/release/scripts/check-release.mjs   # again: the tag, its files and its notes
   ```

   `nx release` bumps both apps to the same version, updates `yarn.lock`, writes each project's `CHANGELOG.md`, deletes the applied plans, commits (the subject `Release`, with a line per release group in the body) and tags `v<version>`. The commit must carry no attribution trailer. A bump without a plan is `yarn nx release patch --groups=apps`. `release.git` is set at the top level, so the `version` and `changelog` subcommands refuse to run on their own.

3. **To publish**, push the commit and the tag:

   ```sh
   git push origin main
   git push origin v<version>
   ```

## What the release workflow does

`release.yml` runs on tags `v*` and `*-v*`.

- **`v<version>`**, in four jobs; nothing is released unless every one succeeds:
  1. **check**: the tag must match both `apps/vscode/package.json` and `apps/desktop/package.json`; `tools/scripts/release-notes.mjs` must find the version in the changelogs (a tag not cut by `nx release` stops here) and writes the notes to the job summary; `yarn typecheck`.
  2. **vscode** (Ubuntu): `yarn package`, uploading the `.vsix` as an artifact.
  3. **desktop** (macOS, beside vscode): `yarn desktop:package --mac dmg --arm64 --x64`, uploading `orbit-code-<version>-mac-arm64.dmg` and `orbit-code-<version>-mac-x64.dmg`.
  4. **release**: `tools/scripts/github-release.mjs` creates the GitHub release `v<version>` with the three files. Its notes are that version's entries from both changelogs, each once, then the downloads with a link to the website's install guide, then GitHub's compare link. After that, `apps/vscode/scripts/publish.mjs` publishes the `.vsix` to the Marketplace with `VSCE_PAT` and to Open VSX with `OVSX_PAT`, skipping a registry without its secret. Re-running a failed release job uploads to the release a previous run created.

  The dmgs are unsigned: macOS gets an ad hoc signature so it runs on Apple silicon, and asks before the first launch. Windows and Linux installers aren't released; `yarn desktop:package` makes them on those platforms, and CI builds the AppImage as a check.
- **`<project>-v<version>`**: `yarn typecheck`, that project's production build, then `nx release publish --projects=<project>` to npm with provenance (`NPM_TOKEN`). `nx release publish` doesn't run a target's dependencies, hence the explicit build; `--projects` and `--groups` can't be combined.

## The server's first release

`@imshaikot/orbit-code-server` (`apps/server`) is released on its own, starting at 0.1.3, under the maintainer's npm account rather than an organization. Its manifest holds 0.1.2, a version never published, and Nx reads the current version from the manifest, so the first plan is a patch:

```sh
yarn nx release plan patch --projects=server -m "…"
yarn nx run server:build -c production && yarn nx release publish --projects=server --dry-run   # the tarball
yarn nx release --dry-run --skip-publish --projects=server   # 0.1.2 → 0.1.3, apps/server/CHANGELOG.md, tag server-v0.1.3
yarn nx release --skip-publish --projects=server
git push origin main server-v0.1.3
```

Don't commit a server plan before the server does what its README promises: `nx release` without `--projects` applies every pending plan, so the next apps release would version and tag the server too.

The published package is `apps/server/dist`, written by its build: `server.mjs` (the `orbit-server` bin), `indexer.mjs` and `webview.js`, with the manifest, README and LICENSE, and no dependencies.

## Packaging locally

```sh
yarn package                                   # a production build, then vsce → dist/apps/vscode/orbit-code-<version>.vsix
yarn install-local                             # package, install into VS Code with --force, then the dev build again; reload open windows
yarn desktop:package --mac dmg --arm64 --x64   # what the release builds: both dmgs in dist/apps/desktop
yarn desktop:package                           # the platform's default targets (dmg and zip, NSIS, AppImage)
node tools/scripts/release-notes.mjs v<version>                               # the release notes
node tools/scripts/github-release.mjs v<version> <files>… --dry-run            # what the release job would upload
node apps/vscode/scripts/publish.mjs --dry-run
```

- **The `.vsix`** holds only what `apps/vscode/.vscodeignore` whitelists: the manifest, README, LICENSE, CHANGELOG, `media/`, and the three bundles. Everything the extension runs is bundled, so vsce runs with `--no-dependencies`. `package.mjs` refuses a `dist/` that still holds source maps, the sign of a dev build. vsce and ovsx aren't dependencies: `yarn dlx` fetches the versions pinned in `apps/vscode/scripts/vsce.mjs`.
- **The desktop bundle** holds `app.asar` (the manifest, `main.js`, `preload.js`, `webview.js`, the icons) and `dist/indexer.mjs` unpacked beside it, since a worker can't start from inside an asar. electron-builder is pinned in `apps/desktop/scripts/builder.mjs`. Signing and notarization are follow-ups described in `apps/desktop/README.md`.
- **A file the packages take from the repository** (an icon, the README) must be committed before tagging: CI builds the tag, not your working tree. `check-release.mjs` checks this.
- **A publishable npm package** publishes a `dist/` whose manifest its build writes (name, version, description, license, repository, `bin` or `exports`); the source manifest stays `private: true` with source exports. `packages/indexer/build.mjs` is the model. Provenance needs the repository to be public and `repository` in the published manifest.

## Before the first publish from a fork

- Set the extension's `publisher` in `apps/vscode/package.json` to your Marketplace publisher, and create an Open VSX namespace of the same name.
- Add the secrets the jobs read: `VSCE_PAT`, `OVSX_PAT`, `NPM_TOKEN`. The GitHub releases use the workflow's own token. Without `VSCE_PAT` and `OVSX_PAT`, upload the `.vsix` from the GitHub release by hand.
- `NPM_TOKEN` must belong to the npm account that owns the packages: `@imshaikot/orbit-code-server` is under the maintainer's account, while `@orbit-code/indexer`, not yet published, would need an `orbit-code` organization.
- Dry-run everything: `yarn nx release --dry-run --skip-publish`, `yarn package && node apps/vscode/scripts/publish.mjs --dry-run`, and `yarn nx run indexer:build -c production && yarn nx release publish --projects=indexer --dry-run` (the same for `server`).
