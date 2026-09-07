// Builds Orbit's three bundles:
//   dist/extension.js  cjs, extension host (tiny)
//   dist/indexer.mjs   esm, worker thread: dependency-cruiser + TypeScript 5.9
//   dist/webview.js    iife, three.js + the layout Web Worker inlined as a string
//
//   node esbuild.mjs [--watch] [--production] [--only=extension,indexer,webview] [--harness]

import * as esbuild from 'esbuild';
import { readFileSync, readdirSync, watch } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const option = (name) => argv.find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1];

const production = flag('production');
const targets = new Set((option('only') ?? 'extension,indexer,webview').split(','));
if (flag('harness')) targets.add('harness');

const common = {
  absWorkingDir: root,
  bundle: true,
  legalComments: 'none',
  logLevel: 'warning',
  minify: production,
};

/** dependency-cruiser resolves transpilers and reporters at runtime; swap those modules for bundle-safe ones. */
const depcruiseShims = {
  name: 'depcruise-shims',
  setup(build) {
    const shimDir = join(root, 'scripts', 'shims');
    const replace = (filter, shim) =>
      build.onLoad({ filter }, () => ({ contents: readFileSync(join(shimDir, shim), 'utf8'), resolveDir: shimDir, loader: 'js' }));
    replace(/dependency-cruiser[\\/]src[\\/]utl[\\/]try-import\.mjs$/, 'depcruise-try-import.mjs');
    replace(/dependency-cruiser[\\/]src[\\/]extract[\\/]transpile[\\/]try-import-available\.mjs$/, 'depcruise-try-import-available.mjs');
    replace(/dependency-cruiser[\\/]src[\\/]report[\\/]index\.mjs$/, 'depcruise-report.mjs');
  },
};

function buildIndexer() {
  return esbuild.build({
    ...common,
    entryPoints: ['src/indexer/main.ts'],
    outfile: 'dist/indexer.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
    // TypeScript and other CommonJS dependencies call require() on node builtins and read __filename.
    banner: {
      js: [
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
  });
}

function buildExtension() {
  return esbuild.build({
    ...common,
    entryPoints: ['src/extension/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
    sourcemap: production ? false : 'linked',
  });
}

async function buildWebview() {
  const worker = await esbuild.build({
    ...common,
    entryPoints: ['src/webview/layout/worker.ts'],
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    minify: true,
    write: false,
  });
  const workerSource = worker.outputFiles[0].text;
  const inlineWorker = {
    name: 'inline-layout-worker',
    setup(build) {
      build.onResolve({ filter: /^orbit:layout-worker$/ }, (args) => ({ path: args.path, namespace: 'orbit-inline' }));
      build.onLoad({ filter: /.*/, namespace: 'orbit-inline' }, () => ({
        contents: `export default ${JSON.stringify(workerSource)};`,
        loader: 'js',
      }));
    },
  };
  await esbuild.build({
    ...common,
    entryPoints: ['src/webview/main.ts'],
    outfile: 'dist/webview.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    loader: { '.css': 'text' },
    plugins: [inlineWorker],
    sourcemap: production ? false : 'linked',
  });
}

/** Browser-side stand-in for the extension host, used only by scripts/harness.mjs. */
function buildHarness() {
  return esbuild.build({
    ...common,
    entryPoints: ['src/dev/hostSim.ts'],
    outfile: '.harness/host-sim.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
  });
}

/** Mechanical guard for the hard constraints that grep can see. */
function checkConstraints() {
  const problems = [];
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(join(dir, entry.name)) : entry.name.endsWith('.ts') ? [join(dir, entry.name)] : [],
    );
  for (const file of walk(join(root, 'src', 'webview'))) {
    const text = readFileSync(file, 'utf8');
    const where = relative(root, file);
    if (/\bRaycaster\b/.test(text)) problems.push(`${where}: Raycaster is not allowed, picking is GPU only`);
    if (/\breadRenderTargetPixels\s*\(/.test(text)) problems.push(`${where}: synchronous readRenderTargetPixels stalls the GPU, use the async variant`);
    if (/\bhttps?:\/\//.test(text)) problems.push(`${where}: remote URL in webview code`);
    if (/\bfetch\s*\(|\bXMLHttpRequest\b|\bimportScripts\s*\(/.test(text)) problems.push(`${where}: the webview must not load data or code; everything arrives via postMessage`);
  }
  const occurrences = (file, pattern) => (readFileSync(join(root, file), 'utf8').match(pattern) ?? []).length;
  if (occurrences('src/webview/nodes.ts', /new THREE\.InstancedMesh\(/g) !== 1) problems.push('src/webview/nodes.ts: all file nodes must be exactly one InstancedMesh');
  if (occurrences('src/webview/edges.ts', /new THREE\.(?:LineSegments|Line|Mesh|Points)\(/g) !== 1) problems.push('src/webview/edges.ts: all edges must be exactly one draw object');
  if (problems.length) throw new Error(`constraint check failed:\n  ${problems.join('\n  ')}`);
}

async function buildAll() {
  const started = performance.now();
  if (targets.has('webview')) checkConstraints();
  const jobs = [];
  if (targets.has('extension')) jobs.push(buildExtension());
  if (targets.has('indexer')) jobs.push(buildIndexer());
  if (targets.has('webview')) jobs.push(buildWebview());
  if (targets.has('harness')) jobs.push(buildHarness());
  await Promise.all(jobs);
  console.log(`[orbit] built ${[...targets].join(', ')} in ${Math.round(performance.now() - started)} ms`);
}

if (flag('watch')) {
  const rebuild = () => buildAll().catch((error) => console.error(`[orbit] ${error.message}`));
  await rebuild();
  let timer;
  watch(join(root, 'src'), { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(rebuild, 120);
  });
  console.log('[orbit] watching src/');
} else {
  await buildAll();
}
