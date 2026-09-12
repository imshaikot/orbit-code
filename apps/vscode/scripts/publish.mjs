#!/usr/bin/env node
// Publishes the .vsix package.mjs made to the Visual Studio Marketplace, and to Open VSX, which VSCodium, Cursor,
// Windsurf, Gitpod and the other editors built on VS Code install from. A registry is skipped unless its token is set:
// VSCE_PAT for the Marketplace, OVSX_PAT for Open VSX. `nx release publish` runs it as vscode:nx-release-publish,
// after vscode:package.
//
//   node apps/vscode/scripts/publish.mjs [--dry-run]

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { OVSX, VSCE, app, vsixPath, workspace } from './vsce.mjs';

const dryRun = process.argv.slice(2).some((arg) => /^--dry-?run(=true)?$/i.test(arg));
const { publisher, name, version } = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
const vsix = vsixPath();
const shown = relative(workspace, vsix);

const fail = (message) => {
  console.error(`[vscode] ${message}`);
  process.exit(1);
};

if (!existsSync(vsix)) {
  if (!dryRun) fail(`${shown} is missing; run \`yarn package\` first`);
  console.warn(`[vscode] ${shown} is not packaged yet; \`yarn package\` makes it before a real publish`);
}
if (publisher === 'local') {
  const message = `the publisher in apps/vscode/package.json is "local", a placeholder: set your Marketplace publisher id before publishing ${name}@${version}`;
  if (!dryRun) fail(message);
  console.warn(`[vscode] ${message}`);
}

const registries = [
  { label: 'Visual Studio Marketplace', token: 'VSCE_PAT', args: ['dlx', '--quiet', VSCE, 'publish', '--packagePath', vsix] },
  { label: 'Open VSX', token: 'OVSX_PAT', args: ['dlx', '--quiet', OVSX, 'publish', vsix] },
];

let published = 0;
for (const { label, token, args } of registries) {
  if (!process.env[token]) {
    console.log(`[vscode] ${label}: skipped, ${token} is not set`);
    continue;
  }
  if (dryRun) {
    console.log(`[vscode] ${label}: would publish ${shown} as ${publisher}.${name}@${version}`);
    continue;
  }
  const result = spawnSync('yarn', args, { cwd: app, stdio: 'inherit' });
  if (result.status !== 0) fail(`${label}: publishing ${shown} failed`);
  published++;
  console.log(`[vscode] ${label}: published ${publisher}.${name}@${version}`);
}
if (!dryRun && published === 0) fail('nothing was published: set VSCE_PAT, OVSX_PAT or both');
