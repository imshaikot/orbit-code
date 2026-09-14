// Webview entry and composition root. Wires the host bridge, scene, frame loop, pointer
// input and HUD together; none of those modules knows about the others.

import { nodeId } from '@orbit-code/graph/columnar';
import { FILE_KINDS, FILE_KIND_LABELS } from '@orbit-code/graph/languages';
import { type HostCapabilities, PROTOCOL_VERSION } from '@orbit-code/protocol';
import * as THREE from 'three';
import { FileRequests } from './fileRequests';
import { type FrameSample, FrameLoop, type Pace } from './frameLoop';
import { HostBridge } from './host';
import { AgentLogs, isAgentEntry } from './hud/agentLogs';
import { el } from './hud/dom';
import { EditorSheet } from './hud/editorSheet';
import { FileMenu } from './hud/fileMenu';
import { Identity } from './hud/identity';
import { PerfReadout } from './hud/perf';
import { SessionPanel } from './hud/sessionPanel';
import { SparkPopup } from './hud/sparkPopup';
import { StatusOverlay } from './hud/status';
import { Tooltip } from './hud/tooltip';
import { TourButton } from './hud/tourButton';
import { TourCard } from './hud/tourCard';
import { type ViewMode, ViewTabs } from './hud/viewTabs';
import { Interaction } from './interaction';
import { Labels } from './labels';
import { KIND_COLORS, cssColor } from './palette';
import { Picker } from './picking';
import { SceneController } from './scene';
import { Stage } from './stage';
import css from './styles.css';
import { Tour, type TourOptions } from './tour';
import type { World } from './world';
import { SmoothZoom } from './zoom';

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
const HINTS: Record<ViewMode, string> = {
  nested: 'Click a bubble to look inside a directory, or a file for what to do with it. Esc goes back up.',
  flat: 'Every file on its orbit. Click one for what to do with it, drag to orbit, scroll to zoom.',
};
const TOUR_HINT = 'On tour: the camera flies from place to place on its own. Navigation is off until Stop Tour.';
const hint = el('p', 'hint', HINTS.nested);
hud.append(hint);
const viewTabs = new ViewTabs(hud, { select: (mode) => showView(mode, true) });
const tourButton = new TourButton(hud, () => (tour.active ? endTour() : beginTour()));
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const files = new FileRequests(host);
/** Until the host says otherwise (`host`), it is one with editor tabs, as VS Code is. */
let capabilities: HostCapabilities = { tabs: true };
// Before the session panel: the card is on top, so its Esc listener has to come first.
const fileMenu = new FileMenu(hud, {
  viewDiff: (path) => editor.open(path, 'changes'),
  open: (path) => editor.open(path, 'code'),
  openInTab: (path) => void files.send(path, { kind: 'show', diff: false }),
  attach: (path) => session.attachFiles([path]),
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
    prompt: (text, skills, attached, key) =>
      host.post({ type: 'prompt', text, ...(skills.length > 0 ? { skills: [...skills] } : {}), ...(attached.length > 0 ? { files: [...attached] } : {}), ...(key !== undefined ? { key } : {}) }),
    pickFiles: () => host.post({ type: 'pickFiles' }),
    interrupt: (key) => host.post({ type: 'interrupt', key }),
    newSession: () => host.post({ type: 'newSession' }),
    setOptions: (options) => host.post({ type: 'sessionOptions', options }),
    answerPermission: (key, id, answer, answers) => host.post({ type: 'permission', key, id, answer, ...(answers ? { answers } : {}) }),
    // A host without editor tabs shows the file in the editor sheet instead.
    openFile: (path) => (capabilities.tabs ? host.post({ type: 'openFile', path }) : editor.open(path, 'code')),
    refreshCatalog: () => host.post({ type: 'refreshCatalog' }),
    reloadMcp: () => host.post({ type: 'reloadMcp' }),
    mcpAction: (server, action) => host.post({ type: 'mcpAction', server, action }),
    loadHistory: () => host.post({ type: 'loadHistory' }),
    resumeConversation: (id) => host.post({ type: 'resumeConversation', id }),
  },
  () => loop.wake(),
);
/** What each subagent was asked and has done, which a click on its star shows. */
const agentLogs = new AgentLogs();
const sparkPopup = new SparkPopup(hud, {
  toggleFollow: () => {
    const world = scene.world;
    if (!world || sparkAnchorId === undefined) return false;
    if (world.following === sparkAnchorId) disengageFollow(world);
    else engageFollow(world, sparkAnchorId);
    return world.following === sparkAnchorId;
  },
  closed: () => {
    sparkAnchorId = undefined;
    sparkAgent = undefined;
  },
});
const perf = new PerfReadout(hud);
const status = new StatusOverlay(hud);
const tooltip = new Tooltip(hud);
status.show('indexing', 'Waiting for the workspace index');

let labelsDirty = true;
let lastRendered = 0;
const perfWindow = { start: 0, frames: 0, cpu: 0 };
/** Read by tools/harness/harness.mjs to verify the frame loop, picking and live updates; harmless in any host. */
const debug = { frames: 0, rendering: false, cpuMs: 0, calls: 0, triangles: 0, fps: 0, updates: 0, updateMs: 0 };

/* ── Spark: Claude's star, the popup a click on it opens, and Follow ──────────────────────────────── */

/** How long engaging Follow takes to ease the camera to a fair distance from the star. */
const FOLLOW_TWEEN_MS = 600;
/** Once framed, how fast the camera keeps pace with the star, per second: most of the way there in a third of a second. */
const FOLLOW_PAN_RATE = 3;
/** The star the popup is open for (or was last open for, while closing), so its toggle knows what to act on. */
let sparkAnchorId: number | undefined;
/** The subagent whose output the popup shows, when its star is a subagent's. */
let sparkAgent: { key: string; agent: string } | undefined;
const sparkAnchor = new THREE.Vector3();
/** The one-shot move to a fair distance from the star when Follow is switched on; continuous tracking takes over once it ends. */
let followTween: { start: number; fromPosition: THREE.Vector3; toPosition: THREE.Vector3; fromTarget: THREE.Vector3; toTarget: THREE.Vector3 } | undefined;

const loop = new FrameLoop(frame, (visible) => {
  if (visible) labelsDirty = true;
  else debug.rendering = false;
});

const scene = new SceneController(stage, host, {
  showStatus: (phase, message, progress) => status.show(phase, message, progress),
  hideStatus: () => status.hide(),
  graphChanged: (summary) => identity.setGraph(summary),
  worldCleared: () => {
    endTour();
    labels.clear();
    tooltip.hide();
    fileMenu.close();
    sparkPopup.close();
    followTween = undefined;
    zoom.cancel();
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
    tour.rebase(world);
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
  sparkClicked: openSparkPopup,
  wake: loop.wake,
  relabel,
});

// The wheel: eased over frames, toward the pointer, and drawing the bubble under it to the middle of the screen.
const zoom = new SmoothZoom(stage.renderer.domElement, stage.camera, stage.controls, {
  anchor: () => {
    const world = scene.world;
    const cluster = interaction.hoveredCluster();
    return world && cluster !== undefined ? world.bubbleOf(cluster) : undefined;
  },
  under: () => {
    const world = scene.world;
    const node = interaction.hoveredNode();
    if (!world || world.mode !== 'flat' || node === undefined) return undefined;
    return { distance: stage.camera.position.distanceTo(world.positionOf(node)), closest: world.radiusOf(node) * 5 };
  },
  allowed: () => scene.world !== undefined && !scene.world.focus.animating && !tour.active,
  wake: loop.wake,
});

// The tour: the camera flies from stop to stop on its own, some stops with a card beside them, until Stop Tour.
const tourCard = new TourCard(hud);
const tour = new Tour(stage.camera, stage.controls, {
  showCard: (card, stop) => {
    tourCard.show(card, stop.kind);
    if (scene.world) placeTourCard(scene.world);
  },
  hideCard: () => tourCard.hide(),
  wake: () => loop.wake(),
});

stage.controls.addEventListener('change', relabel);

// The view chosen before the page was reloaded, when the host kept it.
if (host.kept('view') === 'flat') showView('flat', false);

(window as unknown as { __orbit: unknown }).__orbit = {
  debug,
  world: () => scene.world,
  view: () => viewTabs.mode,
  tour: () => tour.state(),
  startTour: (options?: TourOptions) => beginTour(options),
  endTour: () => endTour(),
  constellation: () => session.constellationState,
  editor: () => editor.debugState(),
  fileMenu: () => ({ open: fileMenu.isOpen, path: fileMenu.path, busy: fileMenu.busy }),
  camera: () => ({ position: stage.camera.position.toArray(), target: stage.controls.target.toArray(), distance: stage.camera.position.distanceTo(stage.controls.target) }),
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
  agentLogs.retain(new Set(sessions.states.map((state) => state.key)));
  scene.setWorking(session.anyWorking);
  loop.wake();
});
host.on('session', ({ state }) => {
  session.setState(state);
  scene.setWorking(session.anyWorking);
  loop.wake();
});
host.on('transcript', ({ key, reset, entries }) => {
  // A subagent's entries are its output, which a click on its star shows; the session view keeps to the conversation's own.
  if (agentLogs.append(key, reset, entries) && sparkAgent?.key === key) {
    const log = agentLogs.get(key, sparkAgent.agent);
    if (log) sparkPopup.showLog(log);
  }
  const own = entries.filter((entry) => !isAgentEntry(entry));
  if (reset || own.length > 0) session.appendTranscript(key, reset, own);
});
host.on('catalog', ({ catalog }) => session.setCatalog(catalog));
host.on('history', ({ history }) => session.setHistory(history));
host.on('attachFiles', ({ files: picked }) => session.attachFiles(picked));
host.on('visibility', ({ visible }) => loop.setPanelVisible(visible));
host.on('host', ({ capabilities: next }) => {
  capabilities = next;
  fileMenu.setTabs(next.tabs);
  editor.setTabs(next.tabs);
});

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
  // The eye follows the camera: a move in progress, a drag or a wheel, and what the pointer is over; and files flying between views.
  let smooth = world.focus.animating || world.morphing;
  let keepGoing = world.update(dt, now) || constellationOpen;
  // A tour sets off, arrives and moves on between frames; its rests keep the loop at the ambient pace.
  if (tour.update(now)) keepGoing = true;
  // Zooming opens and leaves directories by itself; the path follows, and what is under the pointer changes.
  if (world.focus.consumeChanged()) {
    identity.setLocation(world.location());
    labelsDirty = true;
    interaction.cameraMoved();
    if (!fileMenu.busy) fileMenu.close();
  }
  if (followSpark(world, now, dt)) {
    labelsDirty = true;
    keepGoing = true;
    smooth = true;
  }
  // A click's camera move takes over from the wheel.
  if (world.focus.animating) zoom.cancel();
  else if (zoom.update(dt)) {
    labelsDirty = true;
    keepGoing = true;
    smooth = true;
    interaction.cameraMoved();
  }
  if (!world.focus.animating && stage.controls.update()) {
    labelsDirty = true;
    keepGoing = true;
    smooth = true;
    interaction.cameraMoved();
  }
  if (zoom.active) keepGoing = smooth = true;
  stage.renderer.render(stage.scene, stage.camera);
  const { calls, triangles } = stage.renderer.info.render; // read before the pick pass resets it
  if (fileMenu.isOpen) placeFileMenu(world);
  if (sparkPopup.isOpen) placeSparkPopup(world);
  if (tourCard.isOpen) placeTourCard(world);
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

/** Nested or Flat: the tabs, the hint and the scene follow, and the host keeps the choice for a reload. */
function showView(mode: ViewMode, animate: boolean): void {
  viewTabs.set(mode);
  hint.textContent = HINTS[mode];
  hud.dataset.view = mode;
  host.keep('view', mode);
  zoom.cancel();
  tooltip.hide();
  scene.setMode(mode, animate && !reducedMotion.matches);
  const world = scene.world;
  if (world) identity.setLocation(world.location());
  relabel();
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

/* ── Tour: the camera on its own from stop to stop, with the graph's input off until Stop Tour ──────── */

/** Starts the tour from wherever the camera is, and takes the drag, wheel, clicks, Esc, breadcrumb and tabs away until it ends. */
function beginTour(options?: TourOptions): boolean {
  const world = scene.world;
  if (!world || tour.active) return false;
  if (!fileMenu.busy) fileMenu.close();
  sparkPopup.close();
  tooltip.hide();
  disengageFollow(world);
  zoom.cancel();
  interaction.setLocked(true);
  viewTabs.setEnabled(false);
  world.focus.hold(true);
  tourButton.set(true);
  hud.dataset.tour = 'true';
  hint.textContent = TOUR_HINT;
  tour.start(world, options);
  loop.wake();
  return true;
}

/** Ends the tour where the camera is and gives the view back. */
function endTour(): void {
  if (!tour.active) return;
  tour.end();
  scene.world?.focus.hold(false);
  interaction.setLocked(false);
  viewTabs.setEnabled(true);
  tourButton.set(false);
  delete hud.dataset.tour;
  hint.textContent = HINTS[viewTabs.mode];
  relabel();
}

const tourAnchor = new THREE.Vector3();
const tourRim = new THREE.Vector3();
/** A file's selection ring settles at 1.5 times its radius (nodes.ts), its glow a little beyond. */
const RING_RADII = 1.9;

/** Keeps the card beside the stop: clear of a file's ring, or at the upper right of a directory's bubble as the camera sees it. */
function placeTourCard(world: World): void {
  const stop = tour.current;
  if (!stop) return;
  let clear = 0;
  if (stop.kind === 'file') {
    tourAnchor.copy(world.positionOf(stop.index));
    const m = stage.camera.matrixWorld.elements;
    tourRim.set(m[0], m[1], m[2]).multiplyScalar(world.radiusOf(stop.index) * RING_RADII).add(tourAnchor).project(stage.camera);
    clear = Math.abs((tourRim.x * 0.5 + 0.5) * stage.width - (tourAnchor.clone().project(stage.camera).x * 0.5 + 0.5) * stage.width) + 10;
  } else {
    const bubble = world.bubbleOf(stop.index);
    if (!bubble) {
      tourCard.place(0, 0, false);
      return;
    }
    const m = stage.camera.matrixWorld.elements;
    tourAnchor.set(m[0] + m[4], m[1] + m[5], m[2] + m[6]).multiplyScalar(bubble.radius * 0.5).add(bubble.center);
  }
  tourAnchor.project(stage.camera);
  const x = (tourAnchor.x * 0.5 + 0.5) * stage.width;
  const y = (-tourAnchor.y * 0.5 + 0.5) * stage.height;
  tourCard.place(x, y, tourAnchor.z > -1 && tourAnchor.z < 1 && x >= 0 && y >= 0 && x <= stage.width && y <= stage.height, clear);
}

/** A click on one of Claude's stars: the popup opens beside it, offering to follow it or (already following) to stop, and for a subagent's star showing its output. */
function openSparkPopup(index: number): void {
  const world = scene.world;
  if (!world) return;
  const id = world.claudeIdAt(index);
  if (id === undefined) return;
  const agent = world.claudeAgent(id);
  sparkAnchorId = id;
  sparkAgent = agent && { key: agent.key, agent: agent.agent };
  sparkPopup.open(world.following === id, agent && (agentLogs.get(agent.key, agent.agent) ?? { name: agent.name ?? 'Subagent', detail: '', lines: [] }));
  placeSparkPopup(world);
  loop.wake();
}

function placeSparkPopup(world: World): void {
  if (sparkAnchorId === undefined) return;
  const point = world.claudePosition(sparkAnchorId);
  if (!point) {
    // A subagent's star goes once the subagent is done; its output stays up until closed.
    if (sparkAgent) sparkPopup.starGone();
    else sparkPopup.close();
    return;
  }
  sparkAnchor.copy(point).project(stage.camera);
  const x = (sparkAnchor.x * 0.5 + 0.5) * stage.width;
  const y = (-sparkAnchor.y * 0.5 + 0.5) * stage.height;
  sparkPopup.place(x, y, sparkAnchor.z > -1 && sparkAnchor.z < 1 && x >= 0 && y >= 0 && x <= stage.width && y <= stage.height);
}

/** Switches Follow on: the camera eases to a fair distance from the star, then `followSpark` keeps pace with it every frame. */
function engageFollow(world: World, id: number): void {
  const point = world.claudePosition(id);
  if (!point) return;
  world.follow(id);
  const direction = new THREE.Vector3().subVectors(stage.camera.position, stage.controls.target);
  if (direction.lengthSq() < 1e-6) direction.set(0.3, 0.42, 1);
  direction.normalize();
  const distance = Math.max(20, world.bounds.radius * 0.12);
  followTween = {
    start: performance.now(),
    fromPosition: stage.camera.position.clone(),
    toPosition: point.clone().addScaledVector(direction, distance),
    fromTarget: stage.controls.target.clone(),
    toTarget: point.clone(),
  };
  loop.wake();
}

function disengageFollow(world: World): void {
  world.follow(undefined);
  followTween = undefined;
}

/**
 * While Follow is on, keeps the orbit target on the star: first the one-shot move to a fair distance, then every
 * frame easing the gap between the target and wherever the star has since moved to (a read, an edit, or home).
 * The user's own drag or zoom is left alone either way, so what they do to the camera in the meantime sticks:
 * only the target moves to keep up, by the same amount as the camera, so the offset the user set stays put.
 * Paused while a directory move (Focus) is animating, so the two moves never fight; the gap this leaves eases
 * out over the following frames rather than jumping. Returns whether it moved the camera this frame.
 */
function followSpark(world: World, now: number, dt: number): boolean {
  if (followTween) {
    const t = Math.min(1, (now - followTween.start) / FOLLOW_TWEEN_MS);
    const eased = 1 - Math.pow(1 - t, 3);
    stage.camera.position.lerpVectors(followTween.fromPosition, followTween.toPosition, eased);
    stage.controls.target.lerpVectors(followTween.fromTarget, followTween.toTarget, eased);
    stage.camera.lookAt(stage.controls.target);
    if (t >= 1) followTween = undefined;
    return true;
  }
  const id = world.following;
  if (id === undefined || world.focus.animating) return false;
  const point = world.claudePosition(id);
  if (!point) {
    world.follow(undefined);
    if (sparkPopup.isOpen) sparkPopup.setFollowing(false);
    return false;
  }
  const gap = new THREE.Vector3().subVectors(point, stage.controls.target);
  if (gap.lengthSq() < 1e-6) return false;
  gap.multiplyScalar(Math.min(1, dt * FOLLOW_PAN_RATE));
  stage.controls.target.add(gap);
  stage.camera.position.add(gap);
  return true;
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
