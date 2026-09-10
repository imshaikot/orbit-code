import * as THREE from 'three';
import { nodeId } from '../shared/columnar';
import { FILE_KINDS, FILE_KIND_LABELS, SUPPORTING_KIND, fileKindOf } from '../shared/languages';
import type { ActivityEvent, GraphContent, LayoutSnapshot } from '../shared/protocol';
import { nodeRadius } from '../shared/visual';
import { Bubbles } from './bubbles';
import { ClaudeLayer } from './claude';
import { DirView } from './dirView';
import { EdgeLayer, FIRING_FADE_S } from './edges';
import { Focus, type Sphere } from './focus';
import type { Crumb } from './hud/identity';
import type { LabelSpec } from './labels';
import { McpLayer } from './mcp';
import { type Adjacency, NodeState, REMOVE_S, buildAdjacency } from './nodeState';
import { NodeLayer } from './nodes';
import { KIND_COLORS } from './palette';
import { ParticleLayer } from './particles';
import type { Picked } from './picking';
import type { Stage } from './stage';
import { type SharedUniforms, createSharedUniforms } from './uniforms';

const KIND_INDEX = new Map(FILE_KINDS.map((kind, k) => [kind, k]));
const SUPPORTING_INDEX = KIND_INDEX.get(SUPPORTING_KIND)!;

/** Gap between events that arrive in the same batch (parallel tool calls), in seconds. */
const STAGGER_S = 0.14;
const MAX_QUEUE_LAG_S = 1;
/** Import lines keep firing this long after the latest sign of thinking, in seconds, before they fade. */
const FIRING_HOLD_S = 2.5;
const ACTIVE_LABELS = 6;
/** Candidates only; the label layer drops whatever would overlap. */
const MAX_FILE_LABELS = 120;

interface Touch {
  node: number;
  kind: 'read' | 'edit';
  at: number;
}

/** A read whose comet is in flight: its file and bubbles light up at `at`, when it lands. */
interface Landing {
  node: number;
  at: number;
  key: string;
}

/** An activity event waiting its turn in the queue, with the conversation it belongs to. */
interface Pending {
  event: ActivityEvent;
  key: string;
  applyAt: number;
}

/**
 * Everything drawn for one graph + frozen layout, and how session activity animates it. The view looks
 * into one directory at a time: its files and its sub-directory bubbles, with the imports between them.
 */
export class World {
  readonly uniforms: SharedUniforms;
  readonly focus: Focus;
  readonly bounds: Sphere;
  readonly adjacency: Adjacency;
  readonly view: DirView;
  /** FILE_KINDS index per file. */
  readonly kinds: Uint8Array;
  /** FILE_KINDS index per directory: the kind most files anywhere inside are, project config only when nothing else is. */
  readonly dominantKinds: Uint8Array;
  /** Files of each kind anywhere inside each directory: [cluster * FILE_KINDS.length + kind]. */
  private readonly kindCounts: Uint32Array;
  private readonly state: NodeState;
  private readonly nodes: NodeLayer;
  private readonly bubbles: Bubbles;
  private readonly edges: EdgeLayer;
  private readonly particles: ParticleLayer;
  private readonly claude: ClaudeLayer;
  private readonly mcp: McpLayer;
  /** Files directly inside each directory. */
  private readonly members: number[][];
  /** Each directory's bubble, which the camera frames. */
  private readonly spheres: Sphere[];
  private readonly pending: Pending[] = [];
  /** A read's glow is written when its comet lands, never at launch: shaders draw a time ahead of the clock as unlit, which would put out a glow already there. */
  private landings: Landing[] = [];
  /** Conversations with a turn drawn on the graph: rest comes when the last of them ends. */
  private active = new Set<string>();
  /** The conversation that last touched a file, whose star follows files a live update adds mid-turn. */
  private lastKey: string | undefined;
  private lastQueuedAt = -Infinity;
  private touched: Touch[] = [];
  private animateUntil = 0;
  private working = false;
  private hovered: Picked = { kind: 'none' };
  /** Labels for one directory's contents, and which directory they are for. */
  private contentLabels: LabelSpec[] = [];
  private contentLabelsFor = -1;
  private labelsDirty = true;

  /** With `previous`, continues that World after a live update instead of starting over; `remap` maps its node indices to these. */
  constructor(
    private readonly stage: Stage,
    readonly graph: GraphContent,
    readonly layout: LayoutSnapshot,
    previous?: { world: World; remap: Int32Array },
  ) {
    const count = graph.nodes.count;
    const { centers, radii, labels } = layout.clusters;
    this.view = new DirView(labels, layout.clusterOf);
    this.adjacency = buildAdjacency(count, graph.edges);
    this.state = new NodeState(count, this.adjacency);
    this.uniforms = createSharedUniforms(this.state.texture, this.state.width);
    this.uniforms.uPixelRatio.value = stage.pixelRatio;
    this.uniforms.uViewportHeight.value = stage.height;

    // Colour is file type: each file its own, each directory the type most of its files are.
    const kindCount = FILE_KINDS.length;
    this.kinds = Uint8Array.from({ length: count }, (_, i) => KIND_INDEX.get(fileKindOf(graph.nodes.names[i]))!);
    this.kindCounts = new Uint32Array(labels.length * kindCount);
    for (let i = 0; i < count; i++) this.kindCounts[layout.clusterOf[i] * kindCount + this.kinds[i]]++;
    for (let c = labels.length - 1; c > 0; c--) {
      const parent = this.view.parent[c];
      for (let k = 0; k < kindCount; k++) this.kindCounts[parent * kindCount + k] += this.kindCounts[c * kindCount + k];
    }
    this.dominantKinds = Uint8Array.from(labels, (_, c) => dominantKind(this.kindCounts.subarray(c * kindCount, (c + 1) * kindCount)));
    const fileColors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) fileColors.set(KIND_COLORS[FILE_KINDS[this.kinds[i]]], i * 3);
    const bubbleColors = new Float32Array(labels.length * 3);
    this.dominantKinds.forEach((k, c) => bubbleColors.set(KIND_COLORS[FILE_KINDS[k]], c * 3));

    this.nodes = new NodeLayer(layout.positions, graph.nodes.sizes, fileColors, layout.clusterOf, this.view.viewParent, this.uniforms);
    this.bubbles = new Bubbles(centers, radii, bubbleColors, this.view, this.uniforms);
    this.edges = new EdgeLayer(graph.edges, layout.positions, layout.clusterOf, centers, radii, this.view, this.uniforms);
    this.particles = new ParticleLayer(this.uniforms);

    this.members = labels.map(() => []);
    for (let i = 0; i < count; i++) this.members[layout.clusterOf[i]].push(i);

    this.spheres = labels.map((_, c) => ({ center: this.clusterCenter(c), radius: radii[c] }));
    this.bounds = labels.length > 0 ? this.spheres[this.view.root] : { center: new THREE.Vector3(), radius: 10 };
    const { center } = this.bounds;
    const radius = Math.max(10, this.bounds.radius);

    // Home: above the root directory's contents, toward the default camera.
    this.claude = new ClaudeLayer(center.clone().add(new THREE.Vector3(0, radius * 0.35, radius * 0.45)), Math.max(2.5, radius * 0.07), this.uniforms);
    this.mcp = new McpLayer(this.uniforms);

    stage.scene.add(this.nodes.mesh, this.bubbles.mesh, this.edges.lines, this.particles.points, this.claude.group, this.mcp.group);

    stage.camera.near = Math.max(0.05, radius / 4000);
    stage.camera.far = radius * 40;
    stage.camera.updateProjectionMatrix();
    stage.controls.maxDistance = radius * 8;
    stage.controls.minDistance = 1.5;

    this.focus = new Focus(stage.camera, stage.controls, this.uniforms, (c) => this.spheres[c], this.view, this.view.root);
    if (previous) this.adopt(previous.world, previous.remap);
    else this.focus.go(this.view.start, false);
  }

  get clusterCount(): number {
    return this.layout.clusters.labels.length;
  }

  /** MCP servers orbiting Claude right now. */
  get mcpStations(): number {
    return this.mcp.count;
  }

  /** Claude's stars drawn right now: one, plus one per further conversation with a turn under way. */
  get claudeStars(): number {
    return this.claude.count;
  }

  /** A directory's workspace-relative path; the root reads as the workspace name. */
  clusterName(cluster: number): string {
    const label = this.layout.clusters.labels[cluster];
    return label === '.' ? `${this.graph.root} (root)` : label;
  }

  /** The directories from the root down to the one being looked into. */
  location(): Crumb[] {
    return this.view.path(this.focus.cluster).map((cluster) => {
      const label = this.layout.clusters.labels[cluster];
      const name = cluster !== this.view.root ? this.view.name(cluster) : label === '.' ? this.graph.root : `${this.graph.root}/${label}`;
      return { cluster, name, path: this.clusterName(cluster) };
    });
  }

  /** Import edges flow faster, and a star at home wears its ring, while any conversation is working. Every turn's end takes its star home. */
  setWorking(working: boolean): void {
    this.working = working;
    if (working) this.claude.busy();
    // Turns that ended without their turnEnd reaching the scene (the panel was replaced, the host restarted) still let stars and MCP stations go.
    if (!working) {
      this.mcp.settle(this.uniforms.uTime.value);
      this.claude.rest();
      this.active.clear();
    }
  }

  resize(): void {
    this.uniforms.uPixelRatio.value = this.stage.pixelRatio;
    this.uniforms.uViewportHeight.value = this.stage.height;
    this.labelsDirty = true;
  }

  /** Queues a delta's events, from the conversation `key`. Hidden panels apply them at once, without particles or firing. */
  enqueue(events: readonly ActivityEvent[], visible: boolean, key: string): void {
    const now = this.uniforms.uTime.value;
    if (!visible) {
      for (const event of events) this.apply(event, now, false, key);
      return;
    }
    let at = Math.max(now, this.lastQueuedAt + STAGGER_S);
    if (at - now > MAX_QUEUE_LAG_S) at = now;
    for (const event of events) {
      if (event.kind === 'thinking') {
        // No file to fly to, so no place in the queue: the firing starts now.
        this.active.add(key);
        this.think(now);
        continue;
      }
      this.pending.push({ event, key, applyAt: at });
      this.lastQueuedAt = at;
      at += STAGGER_S;
    }
  }

  /** Files a live update added: during a turn they glow like edits until it ends, and Claude's star goes to the last of them; otherwise they pulse once. */
  pulseAdded(added: Uint32Array): void {
    if (added.length === 0) return;
    const t = this.uniforms.uTime.value;
    let written = -1;
    for (const node of added) {
      if (node >= this.graph.nodes.count) continue;
      if (!this.working) {
        this.state.added(node, t);
        continue;
      }
      this.state.edit(node, t, this.uniforms.uRestT.value);
      this.bubbles.touch(this.layout.clusterOf[node], t);
      this.remember(node, 'edit', t);
      written = node;
    }
    if (written >= 0 && this.lastKey !== undefined && this.active.has(this.lastKey)) this.moveClaude(written, 'edit', t, this.lastKey);
    this.animateUntil = Math.max(this.animateUntil, t + 3);
    this.labelsDirty = true;
  }

  /** Advances animation by dt seconds. Returns whether another frame is needed. */
  update(dt: number, now: number): boolean {
    const t = (this.uniforms.uTime.value += dt);
    while (this.pending.length > 0 && this.pending[0].applyAt <= t) {
      const { event, key } = this.pending.shift()!;
      this.apply(event, t, true, key);
    }
    this.land(t);
    this.state.flush();

    const flow = this.uniforms.uFlow;
    const flowTarget = this.working ? 1 : 0;
    flow.value += (flowTarget - flow.value) * Math.min(1, dt * 2);

    const claudeMoving = this.claude.update(dt);
    const focusMoving = this.focus.update(now);
    // MCP stations keep to their conversation's star, at the scale of the directory in view.
    const stationsOut = this.mcp.update(t, (key) => this.claude.position(key), Math.max(3, (this.layout.clusters.radii[this.focus.cluster] ?? 10) * 0.2));
    if (focusMoving || stationsOut) this.labelsDirty = true;
    return this.pending.length > 0 || t < this.animateUntil || claudeMoving || focusMoving || stationsOut || flowTarget > 0 || Math.abs(flow.value - flowTarget) > 0.01;
  }

  consumeLabelsDirty(): boolean {
    const dirty = this.labelsDirty;
    this.labelsDirty = false;
    return dirty;
  }

  /** Updates hover highlighting and returns tooltip text, if any. */
  hover(picked: Picked): { title: string; detail: string } | undefined {
    const changed = picked.kind !== this.hovered.kind || (picked.kind !== 'none' && this.hovered.kind !== 'none' && picked.index !== this.hovered.index);
    this.hovered = picked;
    this.uniforms.uHover.value = picked.kind === 'node' ? picked.index : -1;
    this.uniforms.uHoverCluster.value = picked.kind === 'cluster' ? picked.index : -1;
    if (changed) this.labelsDirty = true;

    if (picked.kind === 'node') {
      const i = picked.index;
      return {
        title: nodeId(this.graph.nodes, i),
        detail: `${FILE_KIND_LABELS[FILE_KINDS[this.kinds[i]]]}, ${formatBytes(this.graph.nodes.sizes[i])}, imports ${this.adjacency.importsOf[i]}, imported by ${this.adjacency.importedBy[i]}`,
      };
    }
    if (picked.kind === 'cluster') {
      const c = picked.index;
      const files = this.view.files[c];
      const subdirectories = this.view.children[c].length;
      const parts = [`${files.toLocaleString('en-US')} ${files === 1 ? 'file' : 'files'}`];
      if (subdirectories > 0) parts.push(`${subdirectories} ${subdirectories === 1 ? 'sub-directory' : 'sub-directories'}`);
      const kind = this.dominantKinds[c];
      const share = Math.round((100 * this.kindCounts[c * FILE_KINDS.length + kind]) / Math.max(1, files));
      parts.push(`${share}% ${FILE_KIND_LABELS[FILE_KINDS[kind]]}`);
      return { title: this.clusterName(c), detail: `${parts.join(', ')}. Click to look inside.` };
    }
    return undefined;
  }

  /** The file the file menu is open for, or -1. */
  get selected(): number {
    return this.uniforms.uSelected.value;
  }

  /** Rings the file the file menu is open for (-1: none); `danger` turns the ring red while a delete waits for confirmation. */
  select(node: number, danger = false): void {
    const { uSelected, uSelectedAt, uSelectTone, uTime } = this.uniforms;
    const next = node >= 0 && node < this.graph.nodes.count ? node : -1;
    if (next !== uSelected.value) uSelectedAt.value = uTime.value;
    uSelected.value = next;
    uSelectTone.value = danger ? 1 : 0;
    this.animateUntil = Math.max(this.animateUntil, uTime.value + 0.5);
  }

  /** The file menu deletes a file: it collapses at once, and stays hidden until the update that removes it. */
  remove(node: number): void {
    if (node < 0 || node >= this.graph.nodes.count) return;
    const t = this.uniforms.uTime.value;
    this.state.removing(node, t);
    if (this.selected === node) this.select(-1);
    if (this.hovered.kind === 'node' && this.hovered.index === node) this.hover({ kind: 'none' });
    this.animateUntil = Math.max(this.animateUntil, t + REMOVE_S);
    this.contentLabelsFor = -1;
    this.labelsDirty = true;
  }

  /** The delete failed: the file comes back, with the pulse of a file that joined. */
  restore(node: number): void {
    if (node < 0 || node >= this.graph.nodes.count || !this.state.isRemoving(node)) return;
    const t = this.uniforms.uTime.value;
    this.state.added(node, t);
    this.animateUntil = Math.max(this.animateUntil, t + 3);
    this.contentLabelsFor = -1;
    this.labelsDirty = true;
  }

  /** Where a file sits, for HUD anchored to it. */
  positionOf(node: number): THREE.Vector3 {
    return this.nodePosition(node);
  }

  /** Frames a directory's bubble. Zooming in to it opens it, and zooming out to it backs out of the one on screen. */
  goTo(cluster: number): void {
    if (cluster < 0 || cluster >= this.clusterCount || !this.view.shown[cluster]) return;
    this.focus.go(cluster, true);
    this.labelsDirty = true;
  }

  /** Back out to the directory around the current one. False at the root. */
  up(): boolean {
    const parent = this.view.viewParent[this.focus.cluster];
    if (parent < 0) return false;
    this.goTo(parent);
    return true;
  }

  /** The current directory's sub-directory names win, active files come next, then as many file names as fit (hubs first). */
  labelSpecs(): LabelSpec[] {
    const { uFocus, uFocusFrom, uFocusMix } = this.uniforms;
    const shown = uFocusMix.value < 0.5 ? uFocusFrom.value : uFocus.value;
    if (shown !== this.contentLabelsFor) {
      this.contentLabels = this.labelsInside(shown);
      this.contentLabelsFor = shown;
    }
    const specs = [...this.contentLabels];
    for (const { kind, node, at } of this.touched) {
      if (this.state.isRemoving(node)) continue;
      specs.push({ key: `${kind}:${node}`, kind, text: this.graph.nodes.names[node], position: this.nodePosition(node), lift: this.fileRadius(node), priority: 5000 + at });
    }
    specs.push(...this.mcp.labelSpecs(this.uniforms.uTime.value));
    if (this.hovered.kind === 'node') {
      const i = this.hovered.index;
      specs.push({ key: `hover:${i}`, kind: 'hover', text: this.graph.nodes.names[i], position: this.nodePosition(i), lift: this.fileRadius(i), priority: 1e9 });
    }
    return specs;
  }

  /** Id pass: files and bubbles switch to their id shaders; everything unpickable is hidden. */
  setPickPass(on: boolean): void {
    this.nodes.setPickPass(on);
    this.bubbles.setPickPass(on);
    this.edges.lines.visible = !on;
    this.particles.points.visible = !on;
    this.claude.group.visible = !on;
    this.mcp.group.visible = !on;
  }

  dispose(): void {
    this.stage.scene.remove(this.nodes.mesh, this.bubbles.mesh, this.edges.lines, this.particles.points, this.claude.group, this.mcp.group);
    this.nodes.dispose();
    this.bubbles.dispose();
    this.edges.dispose();
    this.particles.dispose();
    this.claude.dispose();
    this.mcp.dispose();
    this.state.dispose();
  }

  /** Takes over the replaced World's clock, glows, comets, firing, Claude, hover and focus. The camera is left where it is. */
  private adopt(previous: World, remap: Int32Array): void {
    const uniforms = this.uniforms;
    for (const name of ['uTime', 'uRestT', 'uFlow', 'uThinkStart', 'uThinkEnd'] as const) uniforms[name].value = previous.uniforms[name].value;

    const byLabel = new Map(this.layout.clusters.labels.map((label, c) => [label, c]));
    const clusterRemap = Int32Array.from(previous.layout.clusters.labels, (label) => byLabel.get(label) ?? -1);
    const node = (i: number) => (i >= 0 && i < remap.length ? remap[i] : -1);
    const cluster = (c: number) => (c >= 0 && c < clusterRemap.length ? clusterRemap[c] : -1);
    // A directory that is gone, or is now skipped, gives way to its nearest remaining directory that is shown.
    const directory = (c: number) => {
      for (let at = c; at >= 0; at = previous.view.parent[at]) if (cluster(at) >= 0) return this.view.shownAncestor(cluster(at));
      return this.view.root;
    };

    this.state.adopt(previous.state, remap);
    uniforms.uSelected.value = node(previous.selected);
    uniforms.uSelectedAt.value = previous.uniforms.uSelectedAt.value;
    uniforms.uSelectTone.value = previous.uniforms.uSelectTone.value;
    this.bubbles.adopt(previous.bubbles, clusterRemap);
    this.particles.adopt(previous.particles);
    this.claude.adopt(previous.claude);
    this.mcp.adopt(previous.mcp);
    const open = directory(previous.focus.opened);
    this.focus.adopt(previous.focus, open, open !== cluster(previous.focus.opened), cluster);

    this.touched = previous.touched.flatMap((touch) => (node(touch.node) >= 0 ? [{ ...touch, node: node(touch.node) }] : []));
    this.landings = previous.landings.flatMap((landing) => (node(landing.node) >= 0 ? [{ ...landing, node: node(landing.node) }] : []));
    for (const { event, key, applyAt } of previous.pending) {
      if (event.kind === 'turnEnd' || event.kind === 'thinking' || event.kind === 'mcp') this.pending.push({ event, key, applyAt });
      else if (node(event.node) >= 0) this.pending.push({ event: { ...event, node: node(event.node) }, key, applyAt });
    }
    this.active = new Set(previous.active);
    this.lastKey = previous.lastKey;
    this.lastQueuedAt = previous.lastQueuedAt;
    this.animateUntil = previous.animateUntil;
    this.working = previous.working;

    const hovered = previous.hovered;
    const index = hovered.kind === 'node' ? node(hovered.index) : hovered.kind === 'cluster' ? cluster(hovered.index) : -1;
    this.hovered = hovered.kind !== 'none' && index >= 0 ? { kind: hovered.kind, index } : { kind: 'none' };
    uniforms.uHover.value = this.hovered.kind === 'node' ? this.hovered.index : -1;
    uniforms.uHoverCluster.value = this.hovered.kind === 'cluster' ? this.hovered.index : -1;
    this.labelsDirty = true;
  }

  private remember(node: number, kind: 'read' | 'edit', at: number): void {
    this.touched = this.touched.filter((touch) => touch.node !== node);
    this.touched.push({ node, kind, at });
    if (this.touched.length > ACTIVE_LABELS) this.touched.shift();
  }

  /** Claude is thinking: import lines on screen fire until FIRING_HOLD_S after the latest sign of it, then fade (edges.ts). */
  private think(t: number): void {
    const { uThinkStart, uThinkEnd } = this.uniforms;
    // A new burst, unless one is still running or fading: that one carries on, in phase.
    if (t > uThinkEnd.value + FIRING_FADE_S) uThinkStart.value = t;
    uThinkEnd.value = Math.max(uThinkEnd.value, t + FIRING_HOLD_S);
    this.animateUntil = Math.max(this.animateUntil, uThinkEnd.value + FIRING_FADE_S);
  }

  /** One event of the conversation `key`'s turn. */
  private apply(event: ActivityEvent, t: number, animate: boolean, key: string): void {
    if (event.kind === 'thinking') {
      // Hidden panels skip it, like comets: the clock stands still while hidden, so the burst would play late.
      this.active.add(key);
      if (animate) this.think(t);
      return;
    }
    if (event.kind === 'mcp') {
      // Hidden panels skip it, like comets: its pulses are timed on a clock that stands still while hidden.
      if (!animate) return;
      this.active.add(key);
      this.claude.star(key);
      if (event.phase === 'call') this.mcp.call(event.server, event.tool, t, key);
      else this.mcp.answer(event.server, event.phase === 'done', t);
      if (!this.working) this.mcp.settle(t);
      this.animateUntil = Math.max(this.animateUntil, t + 1.5);
      this.labelsDirty = true;
      return;
    }
    if (event.kind === 'turnEnd') {
      this.active.delete(key);
      // Comets still in flight light nothing: lit after the rest, their files would never fade.
      this.landings = this.landings.filter((landing) => landing.key !== key);
      this.mcp.settle(t, key);
      this.claude.goHome(key);
      if (this.active.size === 0) {
        // The last turn on the graph ended: everything fades back to rest.
        this.uniforms.uRestT.value = t;
        this.uniforms.uThinkEnd.value = Math.min(this.uniforms.uThinkEnd.value, t);
        this.touched = [];
        this.landings = [];
      }
      this.animateUntil = Math.max(this.animateUntil, t + 1.2);
      this.labelsDirty = true;
      return;
    }
    const node = event.node;
    if (node < 0 || node >= this.graph.nodes.count) return;
    const cluster = this.layout.clusterOf[node];
    this.active.add(key);
    this.lastKey = key;

    if (event.kind === 'read' && animate) {
      // The comet leaves from where the conversation's star is, before the star sets off after it.
      const flight = this.particles.launch(this.claude.star(key).position, this.nodePosition(node), t);
      this.landings.push({ node, at: flight.landsAt, key });
      this.animateUntil = Math.max(this.animateUntil, flight.goneAt, flight.landsAt + 2.5);
    } else if (event.kind === 'read') {
      this.state.read(node, t);
      this.bubbles.touch(cluster, t);
      this.animateUntil = Math.max(this.animateUntil, t + 2.5);
    } else {
      this.state.edit(node, t, this.uniforms.uRestT.value);
      this.bubbles.touch(cluster, t);
      this.animateUntil = Math.max(this.animateUntil, t + 3);
    }

    this.remember(node, event.kind, t);
    this.moveClaude(node, event.kind, t, key);
    this.labelsDirty = true;
  }

  /** Comets that have arrived light up their file and every bubble around it, from the moment each one landed. */
  private land(t: number): void {
    if (this.landings.length === 0) return;
    const flying: Landing[] = [];
    for (const landing of this.landings) {
      if (landing.at > t) {
        flying.push(landing);
        continue;
      }
      this.state.read(landing.node, landing.at);
      this.bubbles.touch(this.layout.clusterOf[landing.node], landing.at);
    }
    this.landings = flying;
  }

  /** The conversation's star moves over the file it works on, at the scale of the directory in view, and flares cyan for a read or amber for an edit. */
  private moveClaude(node: number, kind: 'read' | 'edit', t: number, key: string): void {
    const point = this.nodePosition(node);
    point.y += Math.max(3, this.layout.clusters.radii[this.focus.cluster] * 0.1);
    this.claude.star(key).workOn(point, kind, t);
  }

  private labelsInside(cluster: number): LabelSpec[] {
    const { radii } = this.layout.clusters;
    const specs: LabelSpec[] = this.view.children[cluster].map((c) => ({
      key: `cluster:${c}`,
      kind: 'cluster' as const,
      text: shortPath(this.view.name(c)),
      detail: this.view.files[c].toLocaleString('en-US'),
      position: this.clusterCenter(c),
      lift: radii[c],
      priority: 20_000 + this.view.files[c],
    }));
    const { importsOf, importedBy } = this.adjacency;
    const hubs = this.members[cluster].filter((node) => !this.state.isRemoving(node)).sort((a, b) => importsOf[b] + importedBy[b] - (importsOf[a] + importedBy[a])).slice(0, MAX_FILE_LABELS);
    for (const node of hubs) {
      specs.push({ key: `file:${node}`, kind: 'file', text: this.graph.nodes.names[node], position: this.nodePosition(node), lift: this.fileRadius(node), priority: 100 + importsOf[node] + importedBy[node] });
    }
    return specs;
  }

  private clusterCenter(cluster: number): THREE.Vector3 {
    const centers = this.layout.clusters.centers;
    return new THREE.Vector3(centers[cluster * 3], centers[cluster * 3 + 1], centers[cluster * 3 + 2]);
  }

  private nodePosition(node: number): THREE.Vector3 {
    const positions = this.layout.positions;
    return new THREE.Vector3(positions[node * 3], positions[node * 3 + 1], positions[node * 3 + 2]);
  }

  /** A label lifted this far clears its file. */
  private fileRadius(node: number): number {
    return nodeRadius(this.graph.nodes.sizes[node]);
  }
}

/** The kind most files are, leaving project config out unless it is all there is. Ties go to the earlier kind. */
function dominantKind(counts: Uint32Array): number {
  let best = SUPPORTING_INDEX;
  let most = 0;
  counts.forEach((n, k) => {
    if (k !== SUPPORTING_INDEX && n > most) {
      best = k;
      most = n;
    }
  });
  return best;
}

function shortPath(path: string): string {
  if (path.length <= 30) return path;
  const parts = path.split('/');
  return `…/${parts.slice(-2).join('/')}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
