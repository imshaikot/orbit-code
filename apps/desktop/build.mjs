// Builds the desktop app into dist/, which with package.json and media/ is everything electron-builder packages:
//   dist/main.js       cjs, Electron's main process: src/main with @orbit-code/core, agent, graph, protocol, common and
//                      indexer/listFiles inlined
//   dist/preload.js    cjs, the page's sandboxed preload
//   dist/indexer.mjs   copied from @orbit-code/indexer, run on a worker thread (unpacked from the asar)
//   dist/webview.js    copied from @orbit-code/webview (with its source map in a dev build)
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
  entryPoints: { main: 'src/main/main.ts', preload: 'src/preload/preload.ts' },
  outdir: 'dist',
  bundle: true,
  legalComments: 'none',
  logLevel: 'warning',
  minify: production,
  platform: 'node',
  format: 'cjs',
  // Electron 44 runs Node 24.
  target: 'node22',
  external: ['electron'],
  sourcemap: production ? false : 'linked',
};

const packageDir = (name) => dirname(require.resolve(`${name}/package.json`));
const artifacts = [join(packageDir('@orbit-code/indexer'), 'dist', 'indexer.mjs'), join(packageDir('@orbit-code/webview'), 'dist', 'webview.js')];

/** Copies the other packages' builds into dist/. A dev build brings webview.js.map too, its sources rebased onto dist/. */
function copyArtifacts({ required }) {
  mkdirSync(dist, { recursive: true });
  for (const file of artifacts) {
    if (!existsSync(file)) {
      if (required) throw new Error(`${relative(join(root, '..', '..'), file)} is missing: build it first, or run \`yarn nx run desktop:build\`, which does`);
      continue;
    }
    copyFileSync(file, join(dist, basename(file)));
    const map = `${file}.map`;
    if (production || !existsSync(map)) continue;
    const sourceMap = JSON.parse(readFileSync(map, 'utf8'));
    sourceMap.sources = sourceMap.sources.map((source) => relative(dist, resolve(dirname(map), source)));
    writeFileSync(join(dist, basename(map)), JSON.stringify(sourceMap));
  }
  if (production) for (const map of ['main.js.map', 'preload.js.map', 'webview.js.map']) rmSync(join(dist, map), { force: true });
}

if (argv.includes('--watch')) {
  const context = await esbuild.context(options);
  await context.watch();
  copyArtifacts({ required: false });
  for (const file of artifacts) watchFile(file, { interval: 500 }, () => copyArtifacts({ required: false }));
  console.log('[desktop] watching src/, and copying the indexer and webview builds into dist/ as they change');
} else {
  const started = performance.now();
  await esbuild.build(options);
  copyArtifacts({ required: true });
  console.log(`[desktop] built dist/ in ${Math.round(performance.now() - started)} ms`);
}
