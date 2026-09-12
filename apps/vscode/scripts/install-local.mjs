#!/usr/bin/env node
// Installs this working copy into your own VS Code, replacing any installed Orbit; run it again to update.
// Packages a production build with vsce (Nx vscode:package), installs it with `code --install-extension --force`,
// then brings back the dev build in apps/vscode/dist so `yarn self` and F5 keep their source maps.
//
//   yarn install-local

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, vsixPath, workspace } from './vsce.mjs';

const { publisher, name, version } = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));

if (!existsSync(join(workspace, 'node_modules')) && !run('yarn', ['install'])) process.exit(1);

const code = findCode();
if (!code) {
  console.error(
    '[orbit] The `code` command was not found. In VS Code run "Shell Command: Install \'code\' command in PATH",\n' +
      '        or point ORBIT_CODE at it.',
  );
  process.exit(1);
}

const installed = run('yarn', ['nx', 'run', 'vscode:package']) && run(code, ['--install-extension', vsixPath(), '--force']);

console.log('[orbit] restoring the dev build in apps/vscode/dist');
const restored = run('yarn', ['nx', 'run', 'vscode:build']);

if (installed) console.log(`[orbit] installed ${publisher}.${name}@${version}; reload open VS Code windows to run it`);
process.exitCode = installed && restored ? 0 : 1;

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { cwd: workspace, stdio: 'inherit' });
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
