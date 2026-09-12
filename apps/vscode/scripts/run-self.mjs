#!/usr/bin/env node
// Builds Orbit and opens this workspace in an Extension Development Host;
// the Orbit panel opens by itself in development mode.
//
//   yarn self               index this workspace (or reuse the cached index)
//   yarn self --reindex     ignore the cached graph for this workspace

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(app, '..', '..');
const args = process.argv.slice(2);

if (!existsSync(join(root, 'node_modules'))) run('yarn', ['install']);
run('yarn', ['nx', 'run', 'vscode:build']);

const code = findCode();
if (!code) {
  console.error(
    '[orbit] The `code` command was not found. In VS Code run "Shell Command: Install \'code\' command in PATH",\n' +
      '        or open this folder in VS Code and press F5 ("Orbit Code: this repository").',
  );
  process.exit(1);
}

const env = { ...process.env };
if (args.includes('--reindex')) env.ORBIT_REINDEX = '1';

console.log(`[orbit] opening ${root} in an Extension Development Host`);
spawn(code, ['--new-window', '--disable-extensions', `--extensionDevelopmentPath=${app}`, root], {
  env,
  stdio: 'ignore',
  detached: true,
}).unref();

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
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
