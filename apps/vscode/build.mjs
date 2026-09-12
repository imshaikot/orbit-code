// Builds the VS Code extension into dist/, which is everything the .vsix holds besides the manifest, README, LICENSE
// and icon:
//   dist/extension.js   cjs, the extension host: src/ with @orbit-code/core, agent, graph, protocol and common inlined
//   dist/indexer.mjs    copied from @orbit-code/indexer, run on a worker thread
//   dist/webview.js     copied from @orbit-code/webview (with its source map in a dev build)
// Nx builds those two packages first, with the same configuration (dependsOn ^build).
//
//   node build.mjs [--watch] [--production]

import * as esbuild from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, watchFile, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const production = argv.includes('--production');

const options = {
  absWorkingDir: root,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  legalComments: 'none',
  logLevel: 'warning',
  minify: production,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  sourcemap: production ? false : 'linked',
};

const packageDir = (name) => dirname(require.resolve(`${name}/package.json`));
const artifacts = [join(packageDir('@orbit-code/indexer'), 'dist', 'indexer.mjs'), join(packageDir('@orbit-code/webview'), 'dist', 'webview.js')];

/** Copies the other packages' builds into dist/. A dev build brings webview.js.map too, its sources rebased onto dist/. */
function copyArtifacts({ required }) {
  mkdirSync(dist, { recursive: true });
  for (const file of artifacts) {
    if (!existsSync(file)) {
      if (required) throw new Error(`${relative(join(root, '..', '..'), file)} is missing: build it first, or run \`yarn nx run vscode:build\`, which does`);
      continue;
    }
    copyFileSync(file, join(dist, basename(file)));
    const map = `${file}.map`;
    if (production || !existsSync(map)) continue;
    const sourceMap = JSON.parse(readFileSync(map, 'utf8'));
    sourceMap.sources = sourceMap.sources.map((source) => relative(dist, resolve(dirname(map), source)));
    writeFileSync(join(dist, basename(map)), JSON.stringify(sourceMap));
  }
  if (production) for (const map of ['extension.js.map', 'webview.js.map']) rmSync(join(dist, map), { force: true });
}

if (argv.includes('--watch')) {
  const context = await esbuild.context(options);
  await context.watch();
  copyArtifacts({ required: false });
  for (const file of artifacts) watchFile(file, { interval: 500 }, () => copyArtifacts({ required: false }));
  console.log('[vscode] watching src/, and copying the indexer and webview builds into dist/ as they change');
} else {
  const started = performance.now();
  await esbuild.build(options);
  copyArtifacts({ required: true });
  console.log(`[vscode] built dist/ in ${Math.round(performance.now() - started)} ms`);
}
