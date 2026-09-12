// Builds dist/webview.js: the Orbit UI (the three.js scene and the HUD) as one IIFE, with the layout Web Worker
// bundled first and inlined as a string through the virtual module orbit:layout-worker. A host loads it into a page
// whose CSP is default-src 'none' with a nonce'd script and style, and worker-src blob: (apps/vscode/src/panel/orbitPanel.ts).
// Every build first checks the hard constraints grep can see.
//
//   node build.mjs [--watch] [--production]

import * as esbuild from 'esbuild';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const workspace = join(root, '..', '..');
const argv = process.argv.slice(2);
const production = argv.includes('--production');

const common = {
  absWorkingDir: root,
  bundle: true,
  legalComments: 'none',
  logLevel: 'warning',
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
};

/** Mechanical guard for the hard constraints that grep can see. */
function constraintProblems() {
  const problems = [];
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(join(dir, entry.name)) : entry.name.endsWith('.ts') ? [join(dir, entry.name)] : [],
    );
  for (const file of walk(join(root, 'src'))) {
    const text = readFileSync(file, 'utf8');
    const where = relative(workspace, file);
    if (/\bRaycaster\b/.test(text)) problems.push(`${where}: Raycaster is not allowed, picking is GPU only`);
    if (/\breadRenderTargetPixels\s*\(/.test(text)) problems.push(`${where}: synchronous readRenderTargetPixels stalls the GPU, use the async variant`);
    if (/\bhttps?:\/\//.test(text)) problems.push(`${where}: remote URL in webview code`);
    if (/\bfetch\s*\(|\bXMLHttpRequest\b|\bimportScripts\s*\(/.test(text)) problems.push(`${where}: the webview must not load data or code; everything arrives via postMessage`);
  }
  const occurrences = (file, pattern) => (readFileSync(join(root, file), 'utf8').match(pattern) ?? []).length;
  if (occurrences('src/nodes.ts', /new THREE\.InstancedMesh\(/g) !== 1) problems.push('packages/webview/src/nodes.ts: all file nodes must be exactly one InstancedMesh');
  if (occurrences('src/edges.ts', /new THREE\.(?:LineSegments|Line|Mesh|Points)\(/g) !== 1) problems.push('packages/webview/src/edges.ts: all edges must be exactly one draw object');
  return problems;
}

let workerSource = '';
const workerOptions = { ...common, entryPoints: ['src/layout/worker.ts'], minify: true, write: false };

const inlineWorker = {
  name: 'inline-layout-worker',
  setup(build) {
    build.onResolve({ filter: /^orbit:layout-worker$/ }, (args) => ({ path: args.path, namespace: 'orbit-inline' }));
    build.onLoad({ filter: /.*/, namespace: 'orbit-inline' }, () => ({ contents: `export default ${JSON.stringify(workerSource)};`, loader: 'js' }));
  },
};

const constraints = {
  name: 'orbit-constraints',
  setup(build) {
    build.onStart(() => ({ errors: constraintProblems().map((text) => ({ text: `constraint check failed: ${text}` })) }));
  },
};

const mainOptions = {
  ...common,
  entryPoints: ['src/main.ts'],
  outfile: 'dist/webview.js',
  minify: production,
  loader: { '.css': 'text' },
  plugins: [constraints, inlineWorker],
  sourcemap: production ? false : 'linked',
};

if (argv.includes('--watch')) {
  // Two contexts: a change under the worker's imports rebuilds the worker, and a new worker source rebuilds the page.
  const main = await esbuild.context(mainOptions);
  let watching = false;
  const worker = await esbuild.context({
    ...workerOptions,
    plugins: [
      {
        name: 'rebuild-page',
        setup(build) {
          build.onEnd(async (result) => {
            const next = result.outputFiles?.[0]?.text;
            if (result.errors.length > 0 || next === undefined || next === workerSource) return;
            workerSource = next;
            if (watching) await main.rebuild().catch(() => undefined);
          });
        },
      },
    ],
  });
  await worker.rebuild();
  await main.watch();
  watching = true;
  await worker.watch();
  console.log('[webview] watching');
} else {
  const started = performance.now();
  workerSource = (await esbuild.build(workerOptions)).outputFiles[0].text;
  await esbuild.build(mainOptions);
  console.log(`[webview] built dist/webview.js in ${Math.round(performance.now() - started)} ms`);
}
