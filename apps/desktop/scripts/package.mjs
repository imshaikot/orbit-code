#!/usr/bin/env node
// Packages apps/desktop with electron-builder into dist/apps/desktop under the workspace root: a dmg and zip on macOS,
// an NSIS installer on Windows, an AppImage on Linux (electron-builder-yml). `yarn desktop:package` runs it through Nx
// (desktop:package), which makes the production build first. Arguments go to electron-builder, e.g. --linux AppImage.
//
//   node apps/desktop/scripts/package.mjs [electron-builder options]

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ELECTRON_BUILDER, app, output } from './builder.mjs';

// A dev build leaves source maps in dist/; the production build removes them.
if (existsSync(join(app, 'dist', 'main.js.map'))) {
  console.error('[desktop] apps/desktop/dist holds a dev build (it has source maps): package a production build, as `yarn desktop:package` does');
  process.exit(1);
}
for (const file of ['main.js', 'preload.js', 'indexer.mjs', 'webview.js']) {
  if (!existsSync(join(app, 'dist', file))) {
    console.error(`[desktop] apps/desktop/dist/${file} is missing: run \`yarn desktop:package\`, which builds first`);
    process.exit(1);
  }
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
// Unsigned until signing is set up (README.md): don't go looking for an identity in the keychain.
env.CSC_IDENTITY_AUTO_DISCOVERY ??= 'false';

const result = spawnSync('yarn', ['dlx', '--quiet', ELECTRON_BUILDER, '--config', 'electron-builder.yml', '--publish', 'never', ...process.argv.slice(2)], {
  cwd: app,
  stdio: 'inherit',
  env,
  shell: process.platform === 'win32',
});
if (result.error) console.error(`[desktop] yarn: ${result.error.message}`);
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`[desktop] packaged into ${output}`);
