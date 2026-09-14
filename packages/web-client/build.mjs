// Builds the web client into dist/, which the server package ships and the website hosts at /web-client/:
//   dist/web-client.js    iife: the connect prompt and the socket transport, which then load webview.js
//   dist/webview.js       copied from @orbit-code/webview (with its source map in a dev build)
//   dist/web-client.json  what a hosting page must use: the protocol version, the server's package, host and ports, the CSP
// Nx builds the webview first, with the same configuration (dependsOn ^build).
//
//   node build.mjs [--watch] [--production]

import * as esbuild from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, watchFile, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const production = argv.includes('--production');

const options = {
  absWorkingDir: root,
  entryPoints: ['src/client.ts'],
  outfile: 'dist/web-client.js',
  bundle: true,
  legalComments: 'none',
  logLevel: 'warning',
  minify: production,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  sourcemap: production ? false : 'linked',
  loader: { '.css': 'text' },
};

const webview = join(dirname(require.resolve('@orbit-code/webview/package.json')), 'dist', 'webview.js');

/** dist/web-client.json, from src/manifest.ts, so the ports and CSP have one source: the protocol package. */
async function writeManifest() {
  const result = await esbuild.build({ absWorkingDir: root, entryPoints: ['src/manifest.ts'], bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022', logLevel: 'warning' });
  const module = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'web-client.json'), `${JSON.stringify(module.webClientManifest(), null, 2)}\n`);
}

/** Copies webview.js in. A dev build brings its map too, its sources rebased onto dist/. */
function copyWebview({ required }) {
  if (!existsSync(webview)) {
    if (required) throw new Error(`${relative(join(root, '..', '..'), webview)} is missing: build it first, or run \`yarn nx run web-client:build\`, which does`);
    return;
  }
  mkdirSync(dist, { recursive: true });
  copyFileSync(webview, join(dist, 'webview.js'));
  const map = `${webview}.map`;
  if (production || !existsSync(map)) {
    rmSync(join(dist, 'webview.js.map'), { force: true });
    return;
  }
  const sourceMap = JSON.parse(readFileSync(map, 'utf8'));
  sourceMap.sources = sourceMap.sources.map((path) => relative(dist, resolve(dirname(map), path)));
  writeFileSync(join(dist, 'webview.js.map'), JSON.stringify(sourceMap));
}

if (argv.includes('--watch')) {
  await writeManifest();
  const context = await esbuild.context(options);
  await context.watch();
  copyWebview({ required: false });
  watchFile(webview, { interval: 500 }, () => copyWebview({ required: false }));
  console.log('[web-client] watching src/, and copying the webview build into dist/ as it changes');
} else {
  const started = performance.now();
  if (production) rmSync(join(dist, 'web-client.js.map'), { force: true });
  await esbuild.build(options);
  copyWebview({ required: true });
  await writeManifest();
  console.log(`[web-client] built dist/ in ${Math.round(performance.now() - started)} ms`);
}
