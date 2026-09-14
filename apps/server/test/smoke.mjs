#!/usr/bin/env node
// End-to-end smoke test of the server and the web client, in headless Chrome. It writes a small folder under
// .harness/server-smoke, serves the web client's dist/ the way the website hosts it (packages/web-client/scripts/serve.mjs,
// the same CSP), starts dist/server.mjs on the folder accepting that page's origin, and checks, in order:
//   sockets       an upgrade from another origin, or for another Host, is refused with a 403; from the page's origin, a
//                 hello with the wrong token or protocol is refused with a frame saying which
//   page          the link opens the page, which connects, loads webview.js with no CSP report, and gets the scene
//                 ready with Claude Code probed; graph.json and a layout-*.bin (typed arrays through the socket) are saved
//   live update   a file written into the folder reaches the page through the watcher, without a second layout
//   reload        a reload reconnects with the link the tab kept and uses the saved layout
//   takeover      a second tab opened with the link takes over, and the first shows its notice
// It fails on any [error] line in the log. The log and the server's data stay in .harness/server-smoke.
//
//   yarn server:smoke [--chrome <path>]    Nx builds the server and the web client first

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveWebClient } from '../../../packages/web-client/scripts/serve.mjs';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(app, '..', '..', '.harness', 'server-smoke');
const folder = join(out, 'workspace');
const dataDir = join(out, 'data');
const logFile = join(out, 'orbit.log');
const TIMEOUT_MS = 90_000;
const at = process.argv.indexOf('--chrome');
const chromePath = at === -1 ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : process.argv[at + 1];

const WebSocket = createRequire(import.meta.url)('ws');
const started = Date.now();
const log = (message) => console.log(`[server-smoke] ${((Date.now() - started) / 1000).toFixed(1)}s ${message}`);
const read = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8') : '');
const count = (text, pattern) => text.match(pattern)?.length ?? 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

let server;
let chrome;
let site;
const problems = [];
try {
  site = await serveWebClient();
  server = startServer(site.origin);
  const link = await server.link;
  const port = Number(/#port=(\d+)/.exec(link)[1]);
  const token = /token=([\w-]+)/.exec(link)[1];
  check(link.startsWith(`${site.origin}/web-client/#`), `the link points at ${link}`);
  log(`server on 127.0.0.1:${port}, page at ${site.origin}`);

  check((await upgrade(port, { origin: 'https://example.com' })).status === 403, 'an upgrade from another origin was not refused');
  check((await upgrade(port, { origin: site.origin, headers: { host: `rebound.example:${port}` } })).status === 403, 'an upgrade for another Host was not refused');
  check((await hello(port, site.origin, { token: 'x'.repeat(32), protocol: 13 })).reason === 'token', 'a wrong token was not refused as such');
  check((await hello(port, site.origin, { token, protocol: -1 })).reason === 'protocol', 'a wrong protocol was not refused as such');
  log('sockets: other origins and hosts get a 403, a wrong token or protocol a refusal');

  chrome = await launchChrome();
  const first = await openTab(chrome.port, link);
  await waitFor(() => /scene ready for graph/.test(read()) && /agent( unavailable)?: /.test(read()), 'the scene and the Claude Code probe');
  check(await first.evaluate('location.hash === "" && Boolean(window.__orbit)'), 'the page kept the token in its address, or has no workspace');
  const graph = readGraph();
  check(graph.nodes.some((node) => node.id === 'src/main.ts') && graph.edges.length >= 2, `graph.json: ${graph.nodes.length} files, ${graph.edges.length} edges`);
  check(count(read(), /\[webview\] layout of/g) === 1, 'the page did not report exactly one layout');
  await waitFor(() => layouts().length > 0, 'a layout-*.bin saved from the page (typed arrays through the socket)');
  log(`page: ${graph.nodes.length} files, ${graph.edges.length} edges, layout ${layouts()[0]}, ${/agent: [^\n]*/.exec(read())?.[0] ?? 'agent unavailable'}`);

  const applied = count(read(), /\[webview\] graph update applied/g);
  writeFileSync(join(folder, 'src', 'added.ts'), "import { main } from './main';\n\nexport const added = main;\n");
  await waitFor(() => readGraph().nodes.some((node) => node.id === 'src/added.ts'), 'src/added.ts in graph.json (the watcher)');
  await waitFor(() => count(read(), /\[webview\] graph update applied/g) > applied, 'the page to apply the update');
  check(count(read(), /\[webview\] layout of/g) === 1, 'a live update laid the graph out again');
  log(`live update: ${read().match(/graph updated [^\n]*/g)?.at(-1)}`);

  const scenes = count(read(), /scene ready for graph/g);
  await first.send('Page.reload');
  await waitFor(() => count(read(), /scene ready for graph/g) > scenes, 'the scene after a reload');
  check(count(read(), /\[webview\] layout of/g) === 1, 'the reload laid the graph out again instead of using the saved layout');
  log('reload: reconnected with the kept link and used the saved layout');

  const second = await openTab(chrome.port, link);
  await waitFor(() => count(read(), /scene ready for graph/g) > scenes + 1, 'the scene in a second tab');
  await waitForPage(first, 'document.querySelector(".wc-notice") !== null', 'the first tab to show it was replaced');
  log('takeover: the second tab took over and the first says so');
  second.close();
  first.close();

  check(problems.length === 0, `the page reported:\n${problems.join('\n')}`);
  check(!/\[error\]/.test(read()), `errors were logged:\n${read()}`);
  log('passed');
} catch (error) {
  console.error(`[server-smoke] failed: ${error instanceof Error ? error.message : error}\n--- ${logFile}\n${read().split('\n').slice(-40).join('\n')}`);
  if (server) console.error(`--- server output\n${server.output()}`);
  process.exitCode = 1;
} finally {
  chrome?.process.kill();
  if (server) await server.stop();
  await site?.close();
}

function startServer(origin) {
  const env = { ...process.env, ORBIT_SERVER_DATA: dataDir, ORBIT_SERVER_LOG: logFile };
  delete env.ORBIT_SERVER_TOKEN;
  const child = spawn(process.execPath, [join(app, 'dist', 'server.mjs'), folder, '--origin', origin, '--no-open'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const link = new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const found = /https?:\/\/\S+\/web-client\/#\S+/.exec(output);
      if (found) resolve(found[0]);
    });
    child.stderr.on('data', (chunk) => (output += chunk));
    exited.then((code) => reject(new Error(`the server exited (${code}) before printing its link:\n${output}`)));
  });
  return {
    link,
    output: () => output,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      await exited;
      clearTimeout(timer);
    },
  };
}

/** Opens a socket to the server; resolves with the socket, or the HTTP status an upgrade was refused with. */
function upgrade(port, { origin, headers = {} }) {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/`, { origin, headers });
    socket.on('open', () => resolve({ socket }));
    socket.on('unexpected-response', (_request, response) => resolve({ status: response.statusCode }));
    socket.on('error', (error) => resolve({ error }));
  });
}

/** Says hello as a page would (a frame without typed arrays: lengths, then JSON) and resolves with the server's answer. */
async function hello(port, origin, { token, protocol }) {
  const { socket, status } = await upgrade(port, { origin });
  if (!socket) throw new Error(`the page's origin got ${status} instead of a socket`);
  const json = Buffer.from(JSON.stringify({ t: 'hello', token, protocol }));
  const frame = Buffer.alloc(8 + json.length);
  frame.writeUInt32LE(json.length, 0);
  json.copy(frame, 8);
  return new Promise((resolve, reject) => {
    socket.once('message', (data) => {
      const bytes = Buffer.from(data);
      resolve(JSON.parse(bytes.subarray(8 + 4 * bytes.readUInt32LE(4), 8 + 4 * bytes.readUInt32LE(4) + bytes.readUInt32LE(0)).toString()));
      socket.close();
    });
    socket.once('close', () => reject(new Error('the server closed the socket without an answer')));
    socket.send(frame);
  });
}

function workspaceStore() {
  const root = join(dataDir, 'workspaces');
  const [dir] = existsSync(root) ? readdirSync(root) : [];
  return dir ? join(root, dir, 'orbit-v1') : join(root, 'missing');
}

function readGraph() {
  return JSON.parse(readFileSync(join(workspaceStore(), 'graph.json'), 'utf8'));
}

function layouts() {
  return existsSync(workspaceStore()) ? readdirSync(workspaceStore()).filter((name) => /^layout-.*\.bin$/.test(name)) : [];
}

async function launchChrome() {
  const profile = join(out, 'chrome-profile');
  const child = spawn(
    chromePath,
    ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--window-size=1280,800', '--enable-unsafe-swiftshader', 'about:blank'],
    { stdio: 'ignore' },
  );
  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(100);
  if (!existsSync(portFile)) throw new Error(`Chrome did not start from ${chromePath}; pass --chrome <path>`);
  return { process: child, port: Number(readFileSync(portFile, 'utf8').split('\n')[0]) };
}

/** A new tab on `url`, driven over the DevTools protocol; CSP reports and uncaught errors go to `problems`. */
async function openTab(debugPort, url) {
  const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })).json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  let id = 0;
  const pending = new Map();
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    if (message.id) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    } else if (message.method === 'Log.entryAdded' && /Content Security Policy|Refused to/i.test(message.params.entry.text)) {
      problems.push(message.params.entry.text);
    } else if (message.method === 'Runtime.exceptionThrown') {
      problems.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      pending.set(++id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Page.navigate', { url });
  return {
    send,
    evaluate: async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value,
    close: () => socket.close(),
  };
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
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function waitForPage(tab, expression, what) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await tab.evaluate(expression).catch(() => false)) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}
