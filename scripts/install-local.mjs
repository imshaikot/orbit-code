#!/usr/bin/env node
// Installs this working copy into your own VS Code, replacing any installed Orbit; run it again to update.
// Makes a production build, packages it with vsce, installs it with `code --install-extension --force`,
// then rebuilds dist/ as a dev build so `yarn self` and F5 keep their source maps.
//
//   yarn install-local

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VSCE = '@vscode/vsce@3.9.2';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { publisher, name, version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

if (!existsSync(join(root, 'node_modules')) && !run('yarn', ['install'])) process.exit(1);

const code = findCode();
if (!code) {
  console.error(
    '[orbit] The `code` command was not found. In VS Code run "Shell Command: Install \'code\' command in PATH",\n' +
      '        or point ORBIT_CODE at it.',
  );
  process.exit(1);
}

const out = mkdtempSync(join(tmpdir(), 'orbit-vsix-'));
const vsix = join(out, `${name}-${version}.vsix`);
// package.json has no vscode:prepublish, so vsce packages whatever dist/ holds. With no repository URL,
// vsce can't rewrite README's relative links and refuses to package unless told to leave them.
const installed =
  run(process.execPath, [join(root, 'esbuild.mjs'), '--production']) &&
  run('yarn', [
    'dlx',
    '--quiet',
    VSCE,
    'package',
    '--no-dependencies',
    '--allow-missing-repository',
    '--skip-license',
    '--no-rewrite-relative-links',
    '--out',
    vsix,
  ]) &&
  run(code, ['--install-extension', vsix, '--force']);
rmSync(out, { recursive: true, force: true });

console.log('[orbit] restoring the dev build in dist/');
const restored = run(process.execPath, [join(root, 'esbuild.mjs')]);

if (installed) console.log(`[orbit] installed ${publisher}.${name}@${version}; reload open VS Code windows to run it`);
process.exitCode = installed && restored ? 0 : 1;

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { cwd: root, stdio: 'inherit' });
  if (result.error) console.error(`[orbit] ${command}: ${result.error.message}`);
  return result.status === 0;
}

function findCode() {
  const candidates = [
    process.env.ORBIT_CODE,
    'code',
    '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
    '/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders',
  ].filter(Boolean);
  return candidates.find((candidate) => spawnSync(candidate, ['--version'], { stdio: 'ignore' }).status === 0);
}
