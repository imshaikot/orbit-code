// Builds dist/host-sim.js from src/hostSim.ts: the browser stand-in for an Orbit host that harness.mjs loads before
// the webview. The webview and indexer builds the harness runs come from their own packages; Nx builds them first.
//
//   node build.mjs

import * as esbuild from 'esbuild';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const started = performance.now();
await esbuild.build({
  absWorkingDir: dirname(fileURLToPath(import.meta.url)),
  entryPoints: ['src/hostSim.ts'],
  outfile: 'dist/host-sim.js',
  bundle: true,
  legalComments: 'none',
  logLevel: 'warning',
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
});
console.log(`[harness] built dist/host-sim.js in ${Math.round(performance.now() - started)} ms`);
