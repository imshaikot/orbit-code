// Builds dist/indexer.mjs: the worker thread an Orbit host spawns to index a workspace, and the orbit-index CLI.
// One ESM bundle with dependency-cruiser and TypeScript inside, so it runs with nothing else installed. Also writes
// dist/package.json, the manifest @orbit-code/indexer is published to npm with (nx.json release, group npm).
//
//   node build.mjs [--watch] [--production]

import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const production = argv.includes('--production');

/** dependency-cruiser resolves transpilers and reporters at runtime; swap those modules for bundle-safe ones. */
const depcruiseShims = {
  name: 'depcruise-shims',
  setup(build) {
    const shimDir = join(root, 'shims');
    const replace = (filter, shim) =>
      build.onLoad({ filter }, () => ({ contents: readFileSync(join(shimDir, shim), 'utf8'), resolveDir: shimDir, loader: 'js' }));
    replace(/dependency-cruiser[\\/]src[\\/]utl[\\/]try-import\.mjs$/, 'depcruise-try-import.mjs');
    replace(/dependency-cruiser[\\/]src[\\/]extract[\\/]transpile[\\/]try-import-available\.mjs$/, 'depcruise-try-import-available.mjs');
    replace(/dependency-cruiser[\\/]src[\\/]report[\\/]index\.mjs$/, 'depcruise-report.mjs');
  },
};

const options = {
  absWorkingDir: root,
  entryPoints: ['src/main.ts'],
  outfile: 'dist/indexer.mjs',
  bundle: true,
  legalComments: 'none',
  logLevel: 'warning',
  minify: production,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // The hashbang makes it an npm bin. TypeScript and other CommonJS dependencies call require() on node builtins and read __filename.
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __orbitCreateRequire } from 'node:module';",
      "import { fileURLToPath as __orbitFileURLToPath } from 'node:url';",
      'const require = __orbitCreateRequire(import.meta.url);',
      'const __filename = __orbitFileURLToPath(import.meta.url);',
      "const __dirname = __filename.slice(0, __filename.lastIndexOf('/'));",
    ].join('\n'),
  },
  // Only reached on the webpack 4 / enhanced-resolve 4 code path, which dependency-cruiser never takes.
  external: ['enhanced-resolve/lib/createInnerCallback'],
  plugins: [depcruiseShims],
};

/** The manifest npm sees: the CLI alone, since the bundle carries every dependency. Version and name come from package.json. */
function writePublishManifest() {
  const source = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const manifest = {
    name: source.name,
    version: source.version,
    description: source.description,
    license: source.license,
    homepage: source.homepage,
    repository: source.repository,
    keywords: source.keywords,
    bin: { 'orbit-index': 'indexer.mjs' },
    files: ['indexer.mjs'],
    engines: { node: '>=20' },
    publishConfig: { access: 'public' },
  };
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'dist', 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  copyFileSync(join(root, 'README.md'), join(root, 'dist', 'README.md'));
  copyFileSync(join(root, '..', '..', 'LICENSE'), join(root, 'dist', 'LICENSE'));
}

if (argv.includes('--watch')) {
  writePublishManifest();
  const context = await esbuild.context(options);
  await context.watch();
  console.log('[indexer] watching');
} else {
  const started = performance.now();
  await esbuild.build(options);
  writePublishManifest();
  console.log(`[indexer] built dist/indexer.mjs in ${Math.round(performance.now() - started)} ms`);
}
