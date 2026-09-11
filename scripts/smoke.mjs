#!/usr/bin/env node
// End-to-end smoke test in a real, isolated VS Code downloaded by @vscode/test-electron
// (a window appears for a few seconds). Opens Orbit on this repository and waits for
// what only a working pipeline produces; see scripts/smoke-suite.cjs.
//
//   yarn smoke

import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const build = spawnSync(process.execPath, [join(root, 'esbuild.mjs')], { stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);

// Inherited when this runs under a VS Code extension host (e.g. from Claude Code in VS Code); it would
// start the downloaded VS Code as plain Node, which then tries to require dist/extension.js directly.
delete process.env.ELECTRON_RUN_AS_NODE;

const userDataDir = join(root, '.harness', 'vscode-user');
rmSync(userDataDir, { recursive: true, force: true });

try {
  await runTests({
    version: process.env.ORBIT_VSCODE_VERSION ?? 'stable',
    cachePath: join(root, '.vscode-test'),
    extensionDevelopmentPath: root,
    extensionTestsPath: join(root, 'scripts', 'smoke-suite.cjs'),
    // ORBIT_SMOKE_PROMPT="..." also runs one real Claude turn through orbit.prompt (uses your Claude Code login);
    // keep it read-only, nobody answers permission prompts. ORBIT_SMOKE_MODEL picks the model for that turn.
    extensionTestsEnv: {
      ORBIT_SMOKE_USER_DATA: userDataDir,
      ORBIT_SMOKE_PROMPT: process.env.ORBIT_SMOKE_PROMPT ?? '',
      ORBIT_SMOKE_MODEL: process.env.ORBIT_SMOKE_MODEL ?? '',
    },
    launchArgs: [root, '--disable-extensions', `--user-data-dir=${userDataDir}`, '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust'],
  });
  console.log('[smoke] passed');
} catch (error) {
  console.error(`[smoke] failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
