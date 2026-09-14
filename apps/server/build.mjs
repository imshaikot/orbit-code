// Builds @orbit-code/server into dist/, which is also the package npm gets (nx.json release, group npm):
//   dist/server.mjs     esm, the orbit-server CLI: src/ with the workspace packages it imports inlined
//   dist/indexer.mjs    copied from @orbit-code/indexer, run on a worker thread
//   dist/webview.js     copied from @orbit-code/webview (with its source map in a dev build), the page the server serves
//   dist/package.json   the published manifest, with README.md, LICENSE and CHANGELOG.md beside it
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
const source = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const options = {
  absWorkingDir: root,
  entryPoints: ['src/server.ts'],
  outfile: 'dist/server.mjs',
  bundle: true,
  legalComments: 'none',
  logLevel: 'warning',
  minify: production,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: production ? false : 'linked',
  define: { ORBIT_SERVER_VERSION: JSON.stringify(source.version) },
  // The hashbang makes it an npm bin; CommonJS dependencies bundled into ESM call require() on node builtins.
  banner: {
    js: ['#!/usr/bin/env node', "import { createRequire as __orbitCreateRequire } from 'node:module';", 'const require = __orbitCreateRequire(import.meta.url);'].join('\n'),
  },
};

const packageDir = (name) => dirname(require.resolve(`${name}/package.json`));
const artifacts = [join(packageDir('@orbit-code/indexer'), 'dist', 'indexer.mjs'), join(packageDir('@orbit-code/webview'), 'dist', 'webview.js')];

/** Copies the other packages' builds into dist/. A dev build brings webview.js.map too, its sources rebased onto dist/. */
function copyArtifacts({ required }) {
  mkdirSync(dist, { recursive: true });
  for (const file of artifacts) {
    if (!existsSync(file)) {
      if (required) throw new Error(`${relative(join(root, '..', '..'), file)} is missing: build it first, or run \`yarn nx run server:build\`, which does`);
      continue;
    }
    copyFileSync(file, join(dist, basename(file)));
    const map = `${file}.map`;
    if (production || !existsSync(map)) continue;
    const sourceMap = JSON.parse(readFileSync(map, 'utf8'));
    sourceMap.sources = sourceMap.sources.map((path) => relative(dist, resolve(dirname(map), path)));
    writeFileSync(join(dist, basename(map)), JSON.stringify(sourceMap));
  }
  if (production) for (const map of ['server.mjs.map', 'webview.js.map']) rmSync(join(dist, map), { force: true });
}

/**
 * The manifest npm sees: the CLI and the two builds it runs, no dependencies, since the bundles carry everything.
 * Name, version, description and repository come from package.json. `files` leaves a dev build's source maps out.
 */
function writePublishManifest() {
  const manifest = {
    name: source.name,
    version: source.version,
    description: source.description,
    license: source.license,
    repository: source.repository,
    keywords: source.keywords,
    bin: { 'orbit-server': 'server.mjs' },
    files: ['server.mjs', 'indexer.mjs', 'webview.js'],
    engines: { node: '>=20' },
    publishConfig: { access: 'public' },
  };
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  copyFileSync(join(root, 'README.md'), join(dist, 'README.md'));
  copyFileSync(join(root, '..', '..', 'LICENSE'), join(dist, 'LICENSE'));
  const changelog = join(root, 'CHANGELOG.md');
  if (existsSync(changelog)) copyFileSync(changelog, join(dist, 'CHANGELOG.md'));
  else rmSync(join(dist, 'CHANGELOG.md'), { force: true });
}

if (argv.includes('--watch')) {
  writePublishManifest();
  const context = await esbuild.context(options);
  await context.watch();
  copyArtifacts({ required: false });
  for (const file of artifacts) watchFile(file, { interval: 500 }, () => copyArtifacts({ required: false }));
  console.log('[server] watching src/, and copying the indexer and webview builds into dist/ as they change');
} else {
  const started = performance.now();
  await esbuild.build(options);
  copyArtifacts({ required: true });
  writePublishManifest();
  console.log(`[server] built dist/ in ${Math.round(performance.now() - started)} ms`);
}
