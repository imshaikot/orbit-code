#!/usr/bin/env node
// End-to-end smoke test of the desktop app, in the Electron the workspace installed (a window appears for a few
// seconds). It opens a small folder it writes under .harness/desktop-smoke and waits, in order, for what only a working
// app produces:
//   launch        the page loads, reports its layout, the scene is ready and Claude Code was probed (`agent: ` or
//                 `agent unavailable: `); graph.json and a layout-*.bin are saved
//   live update   a file written into the folder reaches the graph through the watcher and the page applies it
//   relaunch      the app starts again on the saved graph and layout: the scene is ready without a second layout
// It fails on any [error] line in the log. The log, graph and user data stay in .harness/desktop-smoke.
//
//   yarn desktop:smoke    Nx builds the app first; running this file directly uses apps/desktop/dist as it is

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(app, '..', '..', '.harness', 'desktop-smoke');
const folder = join(out, 'workspace');
const userData = join(out, 'user-data');
const logFile = join(out, 'orbit.log');
const TIMEOUT_MS = 90_000;

const electron = createRequire(import.meta.url)('electron');
const started = Date.now();
const log = (message) => console.log(`[desktop-smoke] ${((Date.now() - started) / 1000).toFixed(1)}s ${message}`);
const read = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8') : '');
const count = (text, pattern) => text.match(pattern)?.length ?? 0;

rmSync(out, { recursive: true, force: true });
const files = {
  'package.json': '{ "name": "smoke-workspace", "private": true }\n',
  'src/main.ts': "import { helper } from './helper';\n\nexport const main = helper;\n",
  'src/helper.ts': 'export const helper = 1;\n',
  'src/util/format.ts': "import { helper } from '../helper';\n\nexport const format = () => String(helper);\n",
};
for (const [path, text] of Object.entries(files)) {
  mkdirSync(dirname(join(folder, path)), { recursive: true });
  writeFileSync(join(folder, path), text);
}
// A repository of its own: this one ignores .harness, so git ls-files would list nothing in the folder.
spawnSync('git', ['init', '--quiet'], { cwd: folder });

let child;
try {
  child = launch();
  await waitFor(() => /scene ready for graph/.test(read()) && /agent( unavailable)?: /.test(read()), 'the scene and the Claude Code probe');
  const graph = readGraph();
  check(graph.nodes.some((node) => node.id === 'src/main.ts') && graph.edges.length >= 2, `graph.json: ${graph.nodes.length} files, ${graph.edges.length} edges`);
  check(count(read(), /\[webview\] layout of/g) === 1, 'the page did not report exactly one layout');
  await waitFor(() => layouts().length > 0, 'a layout-*.bin saved from the page (typed arrays through the preload)');
  log(`launch: ${graph.nodes.length} files, ${graph.edges.length} edges, layout ${layouts()[0]}, ${/agent: [^\n]*/.exec(read())?.[0] ?? 'agent unavailable'}`);

  const applied = count(read(), /\[webview\] graph update applied/g);
  writeFileSync(join(folder, 'src', 'added.ts'), "import { main } from './main';\n\nexport const added = main;\n");
  await waitFor(() => readGraph().nodes.some((node) => node.id === 'src/added.ts'), 'src/added.ts in graph.json (the watcher)');
  await waitFor(() => count(read(), /\[webview\] graph update applied/g) > applied, 'the page to apply the update');
  check(count(read(), /\[webview\] layout of/g) === 1, 'a live update laid the graph out again');
  log(`live update: ${read().match(/graph updated [^\n]*/g)?.at(-1)}`);

  await stop(child);
  const scenes = count(read(), /scene ready for graph/g);
  child = launch();
  await waitFor(() => count(read(), /scene ready for graph/g) > scenes, 'the scene after a relaunch');
  check(count(read(), /\[webview\] layout of/g) === 1, 'the relaunch laid the graph out again instead of using the saved layout');
  log('relaunch: the saved graph and layout were used');

  check(!/\[error\]/.test(read()), `errors were logged:\n${read()}`);
  log('passed');
} catch (error) {
  console.error(`[desktop-smoke] failed: ${error instanceof Error ? error.message : error}\n--- ${logFile}\n${read().split('\n').slice(-40).join('\n')}`);
  process.exitCode = 1;
} finally {
  if (child) await stop(child);
}

function launch() {
  const env = { ...process.env, ORBIT_DESKTOP_USER_DATA: userData, ORBIT_DESKTOP_LOG: logFile, ORBIT_DESKTOP_SOFTWARE_GL: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ORBIT_DESKTOP_FOLDER;
  // Trusting the folder skips the question a first open asks, as smoke's --disable-workspace-trust does for VS Code.
  const launched = spawn(electron, [app, `--folder=${folder}`, '--disable-workspace-trust'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  launched.stderr.resume();
  launched.exited = new Promise((resolve) => launched.once('exit', resolve));
  return launched;
}

async function stop(launched) {
  if (launched.exitCode !== null || launched.signalCode !== null) return;
  launched.kill('SIGTERM');
  const timer = setTimeout(() => launched.kill('SIGKILL'), 5000);
  await launched.exited;
  clearTimeout(timer);
}

function workspaceStore() {
  const root = join(userData, 'workspaces');
  const [dir] = existsSync(root) ? readdirSync(root) : [];
  return dir ? join(root, dir, 'orbit-v1') : join(root, 'missing');
}

function readGraph() {
  return JSON.parse(readFileSync(join(workspaceStore(), 'graph.json'), 'utf8'));
}

function layouts() {
  return existsSync(workspaceStore()) ? readdirSync(workspaceStore()).filter((name) => /^layout-.*\.bin$/.test(name)) : [];
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(predicate, what) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      if (predicate()) return;
    } catch {
      // not there yet
    }
    if (child && (child.exitCode !== null || child.signalCode !== null)) throw new Error(`the app exited (${child.exitCode ?? child.signalCode}) while waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${what}`);
}
