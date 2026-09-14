#!/usr/bin/env node
// Attaches what `yarn desktop:package` made on this machine to the GitHub release of v<version>, the tag the desktop
// app shares with the extension (nx.json's `apps` release group), creating the release if it isn't there yet with
// tools/scripts/github-release.mjs, which writes the notes from the changelogs. release.yml builds the dmgs and creates
// the release itself; this attaches a build made by hand (desktop:nx-release-publish). Needs the gh CLI and GH_TOKEN.
//
//   node apps/desktop/scripts/publish.mjs [--dry-run]

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { app, output, workspace } from './builder.mjs';

const dryRun = process.argv.includes('--dry-run');
const { version } = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
const tag = `v${version}`;
const artifacts = existsSync(output)
  ? readdirSync(output)
      .filter((name) => name.startsWith(`orbit-code-${version}-`) && /\.(dmg|zip|exe|AppImage)$/.test(name))
      .map((name) => join(output, name))
  : [];

if (artifacts.length === 0) {
  console.error(`[desktop] nothing to publish for ${version} in ${output}: run \`yarn desktop:package\` first`);
  process.exit(1);
}
if (process.env.GITHUB_REF_NAME && process.env.GITHUB_REF_NAME !== tag) {
  console.error(`[desktop] tag ${process.env.GITHUB_REF_NAME} does not match apps/desktop/package.json version ${version}`);
  process.exit(1);
}

const script = join(workspace, 'tools', 'scripts', 'github-release.mjs');
const result = spawnSync(process.execPath, [script, tag, ...artifacts, '--partial', ...(dryRun ? ['--dry-run'] : [])], { stdio: 'inherit' });
process.exit(result.status ?? 1);
