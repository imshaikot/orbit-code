// Webview entry and composition root. Wires the host bridge, scene, frame loop, pointer
// input and HUD together; none of those modules knows about the others.

import * as THREE from 'three';
import { nodeId } from '../shared/columnar';
import { FILE_KINDS, FILE_KIND_LABELS } from '../shared/languages';
import { PROTOCOL_VERSION } from '../shared/protocol';
import { FileRequests } from './fileRequests';
import { type FrameSample, FrameLoop, type Pace } from './frameLoop';
import { HostBridge } from './host';
import { el } from './hud/dom';
import { EditorSheet } from './hud/editorSheet';
import { FileMenu } from './hud/fileMenu';
import { Identity } from './hud/identity';
import { PerfReadout } from './hud/perf';
import { SessionPanel } from './hud/sessionPanel';
import { StatusOverlay } from './hud/status';
import { Tooltip } from './hud/tooltip';
import { Interaction } from './interaction';
import { Labels } from './labels';
import { KIND_COLORS, cssColor } from './palette';
import { Picker } from './picking';
import { SceneController } from './scene';
import { Stage } from './stage';
import css from './styles.css';
import type { World } from './world';

const host = new HostBridge();
const nonce = injectStyles();

const app = el('div');
app.id = 'app';
document.body.append(app);
const stage = new Stage(app, onResize, () => status.show('error', 'The graphics context was lost. Close and reopen Orbit Code to continue.'));
const labelLayer = el('div', 'labels');
app.append(labelLayer);
const labels = new Labels(labelLayer);
const picker = new Picker(stage.renderer);

const hud = el('div', 'hud');
app.append(hud);
const identity = new Identity(hud, {
  goTo: (cluster) => interaction.goTo(cluster),
  reindex: () => host.post({ type: 'reindex' }),
});
hud.append(el('p', 'hint', 'Click a bubble to look inside a directory, or a file for what to do with it. Esc goes back up.'));
const files = new FileRequests(host);
// Before the session panel: the card is on top, so its Esc listener has to come first.
const fileMenu = new FileMenu(hud, {
  viewDiff: (path) => editor.open(path, 'changes'),
  open: (path) => editor.open(path, 'code'),
  openInTab: (path) => void files.send(path, { kind: 'show', diff: false }),
  rename: async (path, to) => {
    const reply = await files.send(path, { kind: 'rename', to });
    if (reply.kind === 'renamed') editor.renamed(path, reply.to);
    return reply;
  },
  remove: async (path) => {
    // The file collapses at once; the live update that follows the delete takes it out of the graph.
    withNode(path, (world, node) => world.remove(node));
    const reply = await files.send(path, { kind: 'delete' });
    if (reply.kind === 'deleted') editor.deleted(path);
    else withNode(path, (world, node) => world.restore(node));
    return reply;
  },
  confirming: (on) => {
    const world = scene.world;
    if (world && world.selected >= 0) world.select(world.selected, on);
    loop.wake();
  },
  closed: () => {
    scene.world?.select(-1);
    loop.wake();
  },
});
const editor = new EditorSheet(hud, files, nonce, {
  resized: (inset) => {
    // The HUD along the bottom edge (Claude bubbles, the drawer tab, the perf readout) makes room or hides.
    hud.style.setProperty('--editor-inset', `${inset}px`);
    hud.dataset.editorOpen = String(inset > 0);
  },
  openInTab: (path, diff) => void files.send(path, { kind: 'show', diff }),
});
const session = new SessionPanel(
  hud,
  {
    prompt: (text, skills, key) => host.post({ type: 'prompt', text, ...(skills.length > 0 ? { skills: [...skills] } : {}), ...(key !== undefined ? { key } : {}) }),
    interrupt: (key) => host.post({ type: 'interrupt', key }),
    newSession: () => host.post({ type: 'newSession' }),
    setOptions: (options) => host.post({ type: 'sessionOptions', options }),
    answerPermission: (key, id, answer) => host.post({ type: 'permission', key, id, answer }),
    openFile: (path) => host.post({ type: 'openFile', path }),
    refreshCatalog: () => host.post({ type: 'refreshCatalog' }),
    loadHistory: () => host.post({ type: 'loadHistory' }),
    resumeConversation: (id) => host.post({ type: 'resumeConversation', id }),
  },
  () => loop.wake(),
);
const perf = new PerfReadout(hud);
const status = new StatusOverlay(hud);
const tooltip = new Tooltip(hud);
status.show('indexing', 'Waiting for the workspace index');

/* ── Frame loop, scene and input ───────────────────────────────────────── */

let labelsDirty = true;
let lastRendered = 0;
const perfWindow = { start: 0, frames: 0, cpu: 0 };
/** Read by scripts/harness.mjs to verify the frame loop, picking and live updates; harmless in VS Code. */
const debug = { frames: 0, rendering: false, cpuMs: 0, calls: 0, triangles: 0, fps: 0, updates: 0, updateMs: 0 };

const loop = new FrameLoop(frame, (visible) => {
  if (visible) labelsDirty = true;
  else debug.rendering = false;
});

const scene = new SceneController(stage, host, {
  showStatus: (phase, message, progress) => status.show(phase, message, progress),
  hideStatus: () => status.hide(),
  graphChanged: (summary) => identity.setGraph(summary),
  worldCleared: () => {
    labels.clear();
    tooltip.hide();
    fileMenu.close();
    identity.setLocation(undefined);
  },
  worldReady: (world) => {
    identity.setLocation(world.location());
    relabel();
  },
  worldUpdated: (world, ms) => {
    labels.clear();
    tooltip.hide();
    identity.setLocation(world.location());
    interaction.worldReplaced();
    // World.adopt carried the menu's file over to its new index; a file that is gone takes the menu with it.
    if (fileMenu.isOpen && !fileMenu.busy && world.selected < 0) fileMenu.close();
    debug.updates++;
    debug.updateMs = ms;
    relabel();
  },
});

const interaction = new Interaction(stage, picker, () => scene.world, {
  showTooltip: (x, y, title, detail) => tooltip.show(x, y, title, detail),
  hideTooltip: () => tooltip.hide(),
  locationChanged: () => {
    identity.setLocation(scene.world?.location());
    if (!fileMenu.busy) fileMenu.close();
  },
  fileClicked: openFileMenu,
  wake: loop.wake,
  relabel,
});

stage.controls.addEventListener('change', relabel);

(window as unknown as { __orbit: unknown }).__orbit = {
  debug,
  world: () => scene.world,
  constellation: () => session.constellationState,
  editor: () => editor.debugState(),
  fileMenu: () => ({ open: fileMenu.isOpen, path: fileMenu.path, busy: fileMenu.busy }),
  project: (x: number, y: number, z: number) => {
    const v = new THREE.Vector3(x, y, z).project(stage.camera);
    return { x: (v.x * 0.5 + 0.5) * stage.width, y: (-v.y * 0.5 + 0.5) * stage.height, depth: v.z };
  },
};

host.on('status', ({ phase, message, progress }) => status.show(phase, message, progress));
host.on('graph', ({ delta }) => void scene.load(delta));
host.on('activity', ({ delta }) => {
  if (scene.activity(delta, loop.visible)) loop.wake();
});
host.on('sessions', ({ sessions }) => {
  session.setSessions(sessions);
  scene.setWorking(session.anyWorking);
  loop.wake();
});
host.on('session', ({ state }) => {
  session.setState(state);
  scene.setWorking(session.anyWorking);
  loop.wake();
});
host.on('transcript', ({ key, reset, entries }) => session.appendTranscript(key, reset, entries));
host.on('catalog', ({ catalog }) => session.setCatalog(catalog));
host.on('history', ({ history }) => session.setHistory(history));
host.on('visibility', ({ visible }) => loop.setPanelVisible(visible));

window.addEventListener('error', (event) => host.log('error', event.message));
window.addEventListener('unhandledrejection', (event) => host.log('error', String(event.reason)));

/* ── Frame: paced by FrameLoop (30 fps ambient, up to 60 while the camera or pointer moves), parked when this returns 'parked' ─ */

function frame({ now, dt, resumed }: FrameSample): Pace {
  // The skill and history constellations draw on their own canvas, with or without a graph.
  const constellationOpen = session.frame(dt);
  const world = scene.world;
  if (!world) {
    stage.renderer.render(stage.scene, stage.camera);
    return constellationOpen ? 'ambient' : 'parked';
  }

  const started = performance.now();
  // The eye follows the camera: a move in progress, a drag or a wheel, and what the pointer is over.
  let smooth = world.focus.animating;
  let keepGoing = world.update(dt, now) || constellationOpen;
  // Zooming opens and leaves directories by itself; the path follows.
  if (world.focus.consumeChanged()) {
    identity.setLocation(world.location());
    labelsDirty = true;
    if (!fileMenu.busy) fileMenu.close();
  }
  if (!world.focus.animating && stage.controls.update()) {
    labelsDirty = true;
    keepGoing = true;
    smooth = true;
  }
  stage.renderer.render(stage.scene, stage.camera);
  const { calls, triangles } = stage.renderer.info.render; // read before the pick pass resets it
  if (fileMenu.isOpen) placeFileMenu(world);
  if (world.consumeLabelsDirty() || labelsDirty) {
    labels.render(world.labelSpecs(), stage.camera, stage.width, stage.height);
    labelsDirty = false;
  }
  const cpu = performance.now() - started;

  if (interaction.afterFrame()) keepGoing = smooth = true;

  samplePerf(now, cpu, calls, triangles, resumed);
  if (!resumed && lastRendered > 0 && stage.observeFrameInterval(now - lastRendered)) world.resize();
  lastRendered = now;
  debug.frames++;
  debug.rendering = keepGoing;
  if (!keepGoing) perf.set(undefined);
  return !keepGoing ? 'parked' : smooth ? 'smooth' : 'ambient';
}

function samplePerf(now: number, cpu: number, calls: number, triangles: number, resumed: boolean): void {
  debug.cpuMs = cpu;
  debug.calls = calls;
  debug.triangles = triangles;
  if (resumed || perfWindow.start === 0) {
    perfWindow.start = now;
    perfWindow.frames = 0;
    perfWindow.cpu = 0;
    return;
  }
  perfWindow.frames++;
  perfWindow.cpu += cpu;
  const span = now - perfWindow.start;
  if (span < 1000) return;
  debug.fps = (perfWindow.frames * 1000) / span;
  perf.set({ fps: debug.fps, cpuMs: perfWindow.cpu / perfWindow.frames, calls, triangles, pixelRatio: stage.pixelRatio });
  perfWindow.start = now;
  perfWindow.frames = 0;
  perfWindow.cpu = 0;
}

function relabel(): void {
  labelsDirty = true;
  loop.wake();
}

/** A click on a file: its card opens beside it, and git is asked whether it has changes to show. */
function openFileMenu(node: number): void {
  const world = scene.world;
  if (!world || fileMenu.busy || node < 0 || node >= world.graph.nodes.count) return;
  const path = nodeId(world.graph.nodes, node);
  const kind = FILE_KINDS[world.kinds[node]];
  fileMenu.open({ path, color: cssColor(KIND_COLORS[kind]), kind: FILE_KIND_LABELS[kind] });
  world.select(node);
  placeFileMenu(world);
  loop.wake();
  void files.send(path, { kind: 'info' }).then((reply) => {
    if (reply.kind === 'info') fileMenu.setGit(path, reply.git);
  });
}

const menuAnchor = new THREE.Vector3();

function placeFileMenu(world: World): void {
  const node = world.selected;
  if (node < 0) return;
  menuAnchor.copy(world.positionOf(node)).project(stage.camera);
  const x = (menuAnchor.x * 0.5 + 0.5) * stage.width;
  const y = (-menuAnchor.y * 0.5 + 0.5) * stage.height;
  fileMenu.place(x, y, menuAnchor.z > -1 && menuAnchor.z < 1 && x >= 0 && y >= 0 && x <= stage.width && y <= stage.height);
}

/** Runs `act` on the file's node in the current World, if the file is still in it. */
function withNode(path: string, act: (world: World, node: number) => void): void {
  const world = scene.world;
  if (!world) return;
  const nodes = world.graph.nodes;
  for (let i = 0; i < nodes.count; i++) {
    if (nodeId(nodes, i) !== path) continue;
    act(world, i);
    loop.wake();
    return;
  }
}

function onResize(): void {
  scene.world?.resize();
  relabel();
}

/** Returns the page nonce, which CodeMirror's own injected styles need too. */
function injectStyles(): string | undefined {
  // Inline <style> is blocked by the CSP unless it carries the page nonce, which the loading script has.
  const style = document.createElement('style');
  const nonce = (document.currentScript as HTMLScriptElement | null)?.nonce;
  if (nonce) style.nonce = nonce;
  style.textContent = css;
  document.head.appendChild(style);
  return nonce || undefined;
}

host.post({ type: 'ready', protocol: PROTOCOL_VERSION });
