#!/usr/bin/env node
// Packages apps/vscode/dist as a .vsix with vsce, into dist/apps/vscode/<name>-<version>.vsix under the workspace
// root, or --out. `yarn package` runs it through Nx (vscode:package), which makes the production build first.
//
//   node apps/vscode/scripts/package.mjs [--out <file>]

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { VSCE, app, vsixPath } from './vsce.mjs';

const argv = process.argv.slice(2);
const at = argv.indexOf('--out');
const out = at === -1 ? vsixPath() : resolve(argv[at + 1]);

// A dev build leaves source maps in dist/; the production build removes them.
if (existsSync(join(app, 'dist', 'extension.js.map'))) {
  console.error('[vscode] apps/vscode/dist holds a dev build (it has source maps): package a production build, as `yarn package` does');
  process.exit(1);
}
mkdirSync(dirname(out), { recursive: true });

// package.json has no vscode:prepublish, so vsce packages whatever dist/ holds. With no repository URL,
// vsce can't rewrite README's relative links and refuses to package unless told to leave them.
const result = spawnSync('yarn', ['dlx', '--quiet', VSCE, 'package', '--no-dependencies', '--allow-missing-repository', '--no-rewrite-relative-links', '--out', out], {
  cwd: app,
  stdio: 'inherit',
});
if (result.error) console.error(`[vscode] yarn: ${result.error.message}`);
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`[vscode] packaged ${out}`);
