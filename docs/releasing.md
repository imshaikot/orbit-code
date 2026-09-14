# Releasing

Releases are cut with Nx Release using **version plans**, because commit subjects here aren't conventional commits. A plan is a small Markdown file that says which project gets which bump and why; `nx release` applies the plans, writes the changelogs, commits and tags; pushing the tag makes `.github/workflows/release.yml` publish.

## Release groups

`nx.json` defines three groups, by tag:

| Group | Projects | Tag | Publishes to |
| --- | --- | --- | --- |
| `vscode` | `apps/vscode` (`publish:vscode`) | `v<version>` | A GitHub release with the `.vsix`, then the Visual Studio Marketplace and Open VSX |
| `desktop` | `apps/desktop` (`publish:desktop`) | `desktop-v<version>` | A GitHub release with the installers for macOS, Windows and Linux |
| `npm` | `packages/indexer` and any other `publish:npm` project, versioned independently | `<project>-v<version>` | npm, with provenance |

A dependent is never bumped for a dependency's release (`updateDependents: never`), and a minor bump below 1.0 is applied as a minor, not a patch (`adjustSemverBumpsForZeroMajorVersion: false`). Each project gets its own `CHANGELOG.md`, without author lines; there is no workspace changelog. The first extension release, 0.2.0, was made this way.

## Cutting a release

1. **With the change worth releasing**, write a plan and commit it alongside:

   ```sh
   yarn nx release plan patch --projects=vscode -m "Fix the file card's position after a live update"
   yarn nx release plan minor --projects=desktop -m "…"
   ```

   This writes `.nx/version-plans/version-plan-<time>.md`. Add `--only-touched=false` when the change touched none of that project's files. The message becomes the changelog entry, so write it for users.

2. **To release**, apply the plans:

   ```sh
   yarn nx release --dry-run --skip-publish     # what would happen
   yarn nx release --skip-publish
   ```

   This bumps each planned project's version, updates `yarn.lock`, writes each project's `CHANGELOG.md`, deletes the applied plans, commits with the subject `Release <version>` (with a line per release in the body when several projects are released), and tags each release with its group's pattern. Check the commit against the commit conventions before pushing: it must carry no attribution trailer.

   A bump without a plan is `yarn nx release patch --projects=<project>`. `release.git` is set at the top level, so the `version` and `changelog` subcommands refuse to run on their own.

3. **To publish**, push the commit and the tag:

   ```sh
   git push --follow-tags
   ```

## What the release workflow does

`release.yml` runs on tags `v*` and `*-v*`, and each job first checks that the tag matches the project's `package.json` version.

- **`v<version>`**: `yarn typecheck`, `yarn package`, `gh release create` with the `.vsix` and generated notes, then `apps/vscode/scripts/publish.mjs`, which publishes to the Marketplace with `VSCE_PAT` and to Open VSX with `OVSX_PAT`. Each registry is skipped without its secret, and the script refuses while the publisher is the placeholder `local`.
- **`desktop-v<version>`**: on macOS, Windows and Linux, `yarn typecheck`, `yarn desktop:package`, then `apps/desktop/scripts/publish.mjs`, which creates the GitHub release once and uploads each platform's installers (dmg and zip, an NSIS installer, an AppImage). The builds are unsigned: macOS gets an ad hoc signature so it runs on Apple silicon, and Gatekeeper and SmartScreen warn before the first launch.
- **Any other `<project>-v<version>`**: `yarn typecheck`, that project's production build, then `nx release publish --projects=<project>` to npm with provenance (`NPM_TOKEN`). `nx release publish` doesn't run a target's dependencies, hence the explicit build; `--projects` and `--groups` can't be combined.

## Packaging locally

```sh
yarn package                            # a production build, then vsce → dist/apps/vscode/orbit-code-<version>.vsix
yarn install-local                      # package, install into VS Code with --force, then the dev build again; reload open windows
yarn desktop:package                    # a production build, then electron-builder → dist/apps/desktop
yarn desktop:package --linux AppImage   # arguments go to electron-builder
node apps/vscode/scripts/publish.mjs --dry-run
node apps/desktop/scripts/publish.mjs --dry-run
```

- **The `.vsix`** holds only what `apps/vscode/.vscodeignore` whitelists: the manifest, README, LICENSE, CHANGELOG, `media/`, and the three bundles. Everything the extension runs is bundled, so vsce runs with `--no-dependencies`. `package.mjs` refuses a `dist/` that still holds source maps, the sign of a dev build. vsce and ovsx aren't dependencies: `yarn dlx` fetches the versions pinned in `apps/vscode/scripts/vsce.mjs`.
- **The desktop bundle** holds `app.asar` (the manifest, `main.js`, `preload.js`, `webview.js`, the icons) and `dist/indexer.mjs` unpacked beside it, since a worker can't start from inside an asar. electron-builder is pinned in `apps/desktop/scripts/builder.mjs`. Signing and notarization are follow-ups described in `apps/desktop/README.md`: a Developer ID certificate, hardened runtime and notarization secrets on macOS, a code signing certificate on Windows.
- **A publishable npm package** publishes a `dist/` whose manifest its build writes (name, version, description, license, repository, `bin` or `exports`); the source manifest stays `private: true` with source exports. `packages/indexer/build.mjs` is the model. Provenance needs the repository to be public and `repository` in the published manifest.

## Before the first publish from a fork

- Set the extension's `publisher` in `apps/vscode/package.json` to your Marketplace publisher, and create an Open VSX namespace of the same name.
- Add the secrets the jobs read: `VSCE_PAT`, `OVSX_PAT`, `NPM_TOKEN`. The GitHub releases use the workflow's own token.
- Dry-run everything: `yarn nx release --dry-run --skip-publish`, `yarn package && node apps/vscode/scripts/publish.mjs --dry-run`, and `yarn nx run indexer:build -c production && yarn nx release publish --projects=indexer --dry-run`.
