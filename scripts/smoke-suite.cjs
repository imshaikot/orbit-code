// Runs inside the VS Code extension host started by scripts/smoke.mjs.
//
// Passing means every boundary was crossed for real:
//   graph.json in storageUri   command → extension host → worker-thread indexer (dependency-cruiser + TS)
//   layout-*.bin               graph posted to the webview → three.js + Blob layout worker under the
//                              real CSP → layoutComputed posted back → persisted by the host
//   Orbit.log                  the scene reported ready, the Claude Code probe ran, no errors logged
//   reopen                     the activity bar icon reopens the panel on the loaded graph and layout: no second index,
//                              no second layout
//   live update                a file written into the workspace joins graph.json with its import and reaches the
//                              webview as an update, then leaves again when deleted; no second layout
//   file menu                  the host side of the file menu, through the API activate() returns: read and save through
//                              VS Code's document (a stale save refused), rename and delete through workspace edits, the
//                              graph and the webview following each at once; no second layout
//   ORBIT_SMOKE_PROMPT         optional: one real Claude turn through orbit.prompt finishes successfully

const vscode = require('vscode');
const { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } = require('node:fs');
const { basename, dirname, join } = require('node:path');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const count = (text, pattern) => (text.match(pattern) ?? []).length;

exports.run = async function run() {
  const userData = process.env.ORBIT_SMOKE_USER_DATA;
  const prompt = process.env.ORBIT_SMOKE_PROMPT;
  const started = Date.now();
  const log = (message) => console.log(`[smoke] ${((Date.now() - started) / 1000).toFixed(1)}s ${message}`);

  await vscode.commands.executeCommand('orbit.open');
  log('orbit.open executed');

  const graphFile = await waitForFile(userData, (name, dir) => name === 'graph.json' && basename(dir) === 'orbit-v1', 120_000, 'graph.json');
  const graph = JSON.parse(readFileSync(graphFile, 'utf8'));
  const { stats } = graph;
  log(`graph.json: ${stats.files} files, ${stats.edges} edges (dependency-cruiser ${stats.depcruiseFiles}, regex ${stats.regexFiles}) in ${stats.ms} ms`);
  check(stats.files >= 40 && stats.edges >= 40, `graph is too small: ${stats.files} files, ${stats.edges} edges`);
  check(graph.nodes.some((node) => node.id === 'src/webview/main.ts'), 'src/webview/main.ts is missing from the graph');

  // Non-empty: in development mode the panel opens on activation, so the file can appear mid-write.
  const layoutFile = await waitForFile(dirname(graphFile), (name, dir) => name.startsWith('layout-') && name.endsWith('.bin') && statSync(join(dir, name)).size > 0, 90_000, 'layout file');
  log(`layout persisted after the webview round trip: ${basename(layoutFile)}, ${statSync(layoutFile).size} bytes`);

  const orbitLog = await waitForFile(join(userData, 'logs'), (name, dir) => name === 'Orbit.log' && basename(dir) === 'local.orbit', 30_000, 'Orbit.log');
  const read = () => readFileSync(orbitLog, 'utf8');
  await waitFor(() => read().includes('scene ready for graph'), 30_000, 'scene ready in Orbit.log');
  await waitFor(() => /agent: |agent unavailable: /.test(read()), 30_000, 'the Claude Code probe in Orbit.log');
  let text = read();
  check(text.includes('[webview] layout of'), 'the webview never reported its layout');
  check(!/\[error\]/.test(text), `errors were logged:\n${text}`);
  log(`Orbit.log: layout reported, scene ready, ${/agent: (.*)/.exec(text)?.[1] ?? 'Claude Code not found (session unavailable)'}, no errors`);

  if (prompt) {
    check(text.includes('agent: '), 'ORBIT_SMOKE_PROMPT is set but Claude Code was not found');
    const model = process.env.ORBIT_SMOKE_MODEL;
    if (model) {
      // Goes through onDidChangeConfiguration, like a user changing the setting.
      await vscode.workspace.getConfiguration('orbit').update('claude.model', model, vscode.ConfigurationTarget.Global);
      await sleep(500);
      log(`orbit.claude.model set to ${model}`);
    }
    const accepted = await vscode.commands.executeCommand('orbit.prompt', prompt);
    check(accepted === true, 'orbit.prompt did not accept the prompt');
    log(`prompt sent: ${JSON.stringify(prompt)}`);
    await waitFor(() => /turn (done|failed|interrupted) in/.test(read()), 240_000, 'the Claude turn to finish');
    text = read();
    check(/turn done in/.test(text), `the Claude turn did not finish cleanly:\n${text}`);
    check(!/\[error\]/.test(text), `errors were logged during the turn:\n${text}`);
    log(`Claude turn finished: ${/conversation (\S+)/.exec(text)?.[1] ?? 'unknown conversation'}`);
  }

  const indexedAt = statSync(graphFile).mtimeMs;
  const layouts = count(read(), /\[webview\] layout of/g);
  const scenes = count(read(), /scene ready for graph/g);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await sleep(1000);
  // What clicking Orbit's activity bar icon does: the view container is shown, and its view opens the panel.
  await vscode.commands.executeCommand('workbench.view.extension.orbit');
  await waitFor(() => count(read(), /scene ready for graph/g) > scenes, 30_000, 'the scene reopened from the activity bar icon');
  check(statSync(graphFile).mtimeMs === indexedAt, 'reopening re-indexed instead of reusing the graph');
  check(count(read(), /\[webview\] layout of/g) === layouts, 'reopening computed the layout again instead of reusing it');
  log('reopen from the activity bar icon reused the graph and the frozen layout');

  // Live update: nothing but the file watcher tells Orbit about this file.
  const smokeId = 'src/shared/__orbitSmoke.ts';
  const smokePath = join(vscode.workspace.workspaceFolders[0].uri.fsPath, smokeId);
  const readGraph = () => JSON.parse(readFileSync(graphFile, 'utf8'));
  const applied = () => count(read(), /\[webview\] graph update applied/g);
  try {
    const appliedBefore = applied();
    writeFileSync(smokePath, "import { toColumnar } from './columnar';\n\nexport const smoke = toColumnar;\n");
    await waitFor(
      () => readGraph().edges.some((edge) => edge.source === smokeId && edge.target === 'src/shared/columnar.ts'),
      60_000,
      `${smokeId} and its import in graph.json`,
    );
    await waitFor(() => applied() > appliedBefore, 30_000, 'the webview to apply the update');
    log(`file added: ${read().match(/graph updated [^\n]*/g).at(-1)}`);

    const appliedAfterAdd = applied();
    rmSync(smokePath);
    await waitFor(() => !readGraph().nodes.some((node) => node.id === smokeId), 60_000, `${smokeId} to leave graph.json`);
    await waitFor(() => applied() > appliedAfterAdd, 30_000, 'the webview to apply the removal');
    log(`file removed: ${read().match(/graph updated [^\n]*/g).at(-1)}`);
  } finally {
    rmSync(smokePath, { force: true });
  }
  text = read();
  check(count(text, /\[webview\] layout of/g) === layouts, 'a live update laid the graph out again');
  check(!/\[error\]/.test(text), `errors were logged during the live update:\n${text}`);
  log('live update: the file joined and left the graph, the layout was extended, not recomputed');

  // The file menu's host side, through the API activate() returns (the webview sends the same requests): read and save
  // through VS Code's document, rename and delete through workspace edits, and the graph following each at once.
  const api = vscode.extensions.getExtension('local.orbit')?.exports;
  check(typeof api?.fileRequest === 'function', 'activate() no longer returns fileRequest');
  // The deleted file must not land in the real Trash; this user-data dir is thrown away after the run.
  await vscode.workspace.getConfiguration('files').update('enableTrash', false, vscode.ConfigurationTarget.Global);
  const menuId = 'src/shared/__orbitSmokeMenu.ts';
  const movedId = 'src/shared/__orbitSmokeMoved.ts';
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const [menuPath, movedPath] = [join(root, menuId), join(root, movedId)];
  const inGraph = (id) => readGraph().nodes.some((node) => node.id === id);
  try {
    const appliedBefore = applied();
    writeFileSync(menuPath, "import { toColumnar } from './columnar';\n\nexport const menu = toColumnar;\n");
    await waitFor(() => inGraph(menuId), 60_000, `${menuId} in graph.json`);
    await waitFor(() => applied() > appliedBefore, 30_000, 'the webview to apply the new file');

    const info = await api.fileRequest(menuId, { kind: 'info' });
    check(info?.kind === 'info' && ['untracked', 'clean', 'changed', 'none'].includes(info.git), `info: ${JSON.stringify(info)}`);
    const opened = await api.fileRequest(menuId, { kind: 'read' });
    check(opened?.kind === 'content' && opened.text.includes('toColumnar') && opened.language === 'typescript', `read: ${JSON.stringify(opened)}`);
    const saved = await api.fileRequest(menuId, { kind: 'write', text: `${opened.text}// saved from the editor sheet\n`, revision: opened.revision, force: false });
    check(saved?.kind === 'saved' && readFileSync(menuPath, 'utf8').includes('saved from the editor sheet'), `write: ${JSON.stringify(saved)}`);
    const stale = await api.fileRequest(menuId, { kind: 'write', text: 'lost\n', revision: opened.revision, force: false });
    check(stale?.kind === 'failed' && stale.conflict === true, `a write from an old revision was not refused: ${JSON.stringify(stale)}`);
    await api.fileRequest(menuId, { kind: 'close' });
    // The save changed the file's size: let that update land before counting the rename's.
    await waitFor(() => readGraph().nodes.find((node) => node.id === menuId)?.size === statSync(menuPath).size, 30_000, 'the saved size in graph.json');
    await sleep(2500);
    log(`file menu: git ${info.git}, read and saved through the document, a stale save refused`);

    const appliedBeforeRename = applied();
    const renamed = await api.fileRequest(menuId, { kind: 'rename', to: movedId });
    check(renamed?.kind === 'renamed' && existsSync(movedPath) && !existsSync(menuPath), `rename: ${JSON.stringify(renamed)}`);
    await waitFor(() => inGraph(movedId) && !inGraph(menuId), 30_000, `${movedId} to replace ${menuId} in graph.json`);
    await waitFor(() => applied() > appliedBeforeRename, 30_000, 'the webview to apply the rename');
    log(`file menu rename: ${read().match(/graph updated [^\n]*/g).at(-1)}`);

    const appliedBeforeDelete = applied();
    const deleted = await api.fileRequest(movedId, { kind: 'delete' });
    check(deleted?.kind === 'deleted' && !existsSync(movedPath), `delete: ${JSON.stringify(deleted)}`);
    await waitFor(() => !inGraph(movedId), 30_000, `${movedId} to leave graph.json`);
    await waitFor(() => applied() > appliedBeforeDelete, 30_000, 'the webview to apply the delete');
    log(`file menu delete: ${read().match(/graph updated [^\n]*/g).at(-1)}`);

    const outside = await api.fileRequest('../package.json', { kind: 'delete' });
    check(outside === undefined && existsSync(join(root, 'package.json')), 'a path outside the workspace was accepted');
  } finally {
    rmSync(menuPath, { force: true });
    rmSync(movedPath, { force: true });
  }
  text = read();
  check(count(text, /\[webview\] layout of/g) === layouts, 'a rename or delete laid the graph out again');
  check(!/\[error\]/.test(text), `errors were logged during the file menu steps:\n${text}`);
  log('file menu: renamed and deleted files left the graph at once, the layout was extended, not recomputed');
};

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (predicate()) return;
    } catch {
      // not there yet
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function waitForFile(root, matches, timeoutMs, what) {
  let found;
  await waitFor(() => (found = findFile(root, matches)) !== undefined, timeoutMs, what);
  return found;
}

function findFile(dir, matches) {
  if (!existsSync(dir)) return undefined;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = findFile(path, matches);
      if (nested) return nested;
    } else if (matches(entry.name, dir)) {
      return path;
    }
  }
  return undefined;
}
