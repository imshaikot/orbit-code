#!/usr/bin/env node
// Attaches what `yarn desktop:package` made on this platform to the GitHub release of the tag, creating the release if
// it isn't there yet. release.yml runs it once per platform on a desktop-v<version> tag; the jobs race to create the
// release, so an upload is retried. Needs the gh CLI and GH_TOKEN.
//
//   node apps/desktop/scripts/publish.mjs [--dry-run]

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { app, output } from './builder.mjs';

const dryRun = process.argv.includes('--dry-run');
const { version } = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
const tag = process.env.GITHUB_REF_NAME || `desktop-v${version}`;
const artifacts = existsSync(output)
  ? readdirSync(output)
      .filter((name) => name.startsWith(`orbit-code-${version}-`) && /\.(dmg|zip|exe|AppImage)$/.test(name))
      .map((name) => join(output, name))
  : [];

if (artifacts.length === 0) {
  console.error(`[desktop] nothing to publish for ${version} in ${output}: run \`yarn desktop:package\` first`);
  process.exit(1);
}
if (tag !== `desktop-v${version}`) {
  console.error(`[desktop] tag ${tag} does not match apps/desktop/package.json version ${version}`);
  process.exit(1);
}
if (dryRun) {
  console.log(`[desktop] would attach to ${tag}:\n  ${artifacts.join('\n  ')}`);
  process.exit(0);
}

const gh = (args, stdio = 'inherit') => spawnSync('gh', args, { stdio });
if (gh(['release', 'view', tag], 'ignore').status !== 0) {
  // Another platform's job may create it first; the upload below finds it either way.
  gh(['release', 'create', tag, '--title', `Orbit Code desktop ${version}`, '--generate-notes', '--verify-tag']);
}
for (let attempt = 1; attempt <= 3; attempt++) {
  if (gh(['release', 'upload', tag, ...artifacts, '--clobber']).status === 0) {
    console.log(`[desktop] attached ${artifacts.length} file${artifacts.length === 1 ? '' : 's'} to ${tag}`);
    process.exit(0);
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
}
console.error(`[desktop] could not attach the files to ${tag}`);
process.exit(1);
