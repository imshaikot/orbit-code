import { nodeId } from '@orbit-code/graph/columnar';
import { FILE_KINDS, FILE_KIND_LABELS, SUPPORTING_KIND, fileKindOf } from '@orbit-code/graph/languages';
import { nodeRadius } from '@orbit-code/graph/visual';
import type { ActivityEvent, GraphContent, LayoutSnapshot } from '@orbit-code/protocol';
import * as THREE from 'three';
import { Bubbles } from './bubbles';
import { ClaudeLayer } from './claude';
import { DirView } from './dirView';
import { EdgeLayer, FIRING_FADE_S } from './edges';
import { ARC_GAP, CORE_RADIUS, type FlatLayout, MORPH_STAGGER, flatLayout, halfBand, ringPoint } from './flatLayout';
import { Focus, type Sphere } from './focus';
import type { Crumb } from './hud/identity';
import type { ViewMode } from './hud/viewTabs';
import type { LabelSpec } from './labels';
import { McpLayer } from './mcp';
import { NeuronLayer } from './neurons';
import { type Adjacency, NodeState, REMOVE_S, buildAdjacency } from './nodeState';
import { NodeLayer } from './nodes';
import { OrbitLayer } from './orbits';
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
/** How long the files take to fly between the Nested and Flat views. */
const MORPH_MS = 1400;
/** The Flat view names the files largest on screen, at most this many candidates, once a sphere is this many CSS pixels in radius. */
const MAX_FLAT_LABELS = 320;
const FLAT_LABEL_PX = 9;

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

/** The key a subagent's star is drawn under: its conversation's key, then the id of the tool call running it. */
function subagentKey(key: string, agent: string): string {
  return `${key}/${agent}`;
}

/**
 * Everything drawn for one graph + frozen layout, and how session activity animates it. The view looks
 * into one directory at a time: its files and its sub-directory bubbles, with the imports between them.
 */
export class World {
  readonly uniforms: SharedUniforms;
  readonly focus: Focus;
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
  /** Conversations with a turn drawn on the graph, and their subagents at work: rest comes when the last of them ends. */
  private active = new Set<string>();
  /** Subagents with a star out, by their key (`subagentKey`), with the conversation each works for. */
  private subagents = new Map<string, string>();
  /** The conversation that last touched a file, whose star follows files a live update adds mid-turn. */
  private lastKey: string | undefined;
  private lastQueuedAt = -Infinity;
  private touched: Touch[] = [];
  private animateUntil = 0;
  private working = false;
  private hovered: Picked = { kind: 'none' };
  /** The stable id (ClaudeNode.id) of the star the camera is asked to keep up with, or undefined. Survives a live update: the same id still finds its star after adopt. */
  private followedStarId: number | undefined;
  /** Labels for one directory's contents, and which directory they are for. */
  private contentLabels: LabelSpec[] = [];
  private contentLabelsFor = -1;
  private labelsDirty = true;
  /** The root directory's bubble: what the Nested view frames at its widest. */
  private readonly nestedBounds: Sphere;
  private readonly fileColors: Float32Array;
  /** Nested or Flat; while the files fly between the two, the one they are flying to. */
  private viewMode: ViewMode = 'nested';
  /** The flight in progress: uFlatMix from `from` to `to`, started at `start` (performance.now). */
  private morph: { from: number; to: number; start: number; duration: number } | undefined;
  /** The Flat view's layout and layers, made the first time it is shown and carried across live updates while it is. */
  private flat: FlatLayout | undefined;
  private neurons: NeuronLayer | undefined;
  private orbits: OrbitLayer | undefined;

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
    this.fileColors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) this.fileColors.set(KIND_COLORS[FILE_KINDS[this.kinds[i]]], i * 3);
    const bubbleColors = new Float32Array(labels.length * 3);
    this.dominantKinds.forEach((k, c) => bubbleColors.set(KIND_COLORS[FILE_KINDS[k]], c * 3));

    this.nodes = new NodeLayer(layout.positions, graph.nodes.sizes, this.fileColors, layout.clusterOf, this.view.viewParent, this.uniforms);
    this.bubbles = new Bubbles(centers, radii, bubbleColors, this.view, this.uniforms);
    this.edges = new EdgeLayer(graph.edges, layout.positions, layout.clusterOf, centers, radii, this.view, this.uniforms);
    this.particles = new ParticleLayer(this.uniforms);

    this.members = labels.map(() => []);
    for (let i = 0; i < count; i++) this.members[layout.clusterOf[i]].push(i);

    this.spheres = labels.map((_, c) => ({ center: this.clusterCenter(c), radius: radii[c] }));
    this.nestedBounds = labels.length > 0 ? this.spheres[this.view.root] : { center: new THREE.Vector3(), radius: 10 };

    this.claude = new ClaudeLayer(this.home(), Math.max(2.5, Math.max(10, this.nestedBounds.radius) * 0.07), this.uniforms);
    this.mcp = new McpLayer(this.uniforms);

    stage.scene.add(this.nodes.mesh, this.bubbles.mesh, this.edges.lines, this.particles.points, this.claude.group, this.mcp.group);

    this.fitCamera();
    stage.controls.minDistance = 1.5;

    this.focus = new Focus(stage.camera, stage.controls, this.uniforms, (c) => this.spheres[c], this.view, this.view.root);
    if (previous) this.adopt(previous.world, previous.remap);
    else this.focus.go(this.view.start, false);
  }

  get clusterCount(): number {
    return this.layout.clusters.labels.length;
  }

  /** A sphere around everything the view shows: the root directory's bubble, or the Flat view's orbits. */
  get bounds(): Sphere {
    return this.viewMode === 'flat' && this.flat ? { center: new THREE.Vector3(), radius: this.flat.radius } : this.nestedBounds;
  }

  /** Nested or Flat: the view shown, or the one the files are flying to. */
  get mode(): ViewMode {
    return this.viewMode;
  }

  /** Whether the files are flying between the two views. */
  get morphing(): boolean {
    return this.morph !== undefined;
  }

  /**
   * Switches between the Nested and Flat views. Animated, the files fly to their places in a wave while the camera
   * frames the view; otherwise they are there at once. Back in the Nested view, the camera frames the directory it was in.
   */
  setMode(mode: ViewMode, animate: boolean): void {
    if (mode === this.viewMode) return;
    this.viewMode = mode;
    if (mode === 'flat' && !this.flat) {
      this.flat = flatLayout(this.graph);
      this.buildFlat();
    }
    const { uFlatMix, uTime } = this.uniforms;
    const to = mode === 'flat' ? 1 : 0;
    this.morph = animate ? { from: uFlatMix.value, to, start: performance.now(), duration: MORPH_MS } : undefined;
    if (!animate) uFlatMix.value = to;
    if (mode === 'flat') this.focus.freeze(this.bounds, animate, MORPH_MS * 0.8);
    else this.focus.thaw(this.focus.opened, animate, MORPH_MS * 0.8);
    this.claude.rehome(this.home());
    this.fitCamera();
    this.hover({ kind: 'none' });
    this.contentLabelsFor = -1;
    this.labelsDirty = true;
    this.animateUntil = Math.max(this.animateUntil, uTime.value + 0.2);
  }

  /** MCP servers orbiting Claude right now. */
  get mcpStations(): number {
    return this.mcp.count;
  }

  /** Claude's stars drawn right now: one, plus one per further conversation with a turn under way and one per subagent. */
  get claudeStars(): number {
    return this.claude.count;
  }

  /** The stable ids of the subagents' stars drawn right now, those on their way back included. */
  get claudeAgentStars(): number[] {
    return this.claude.agentIds;
  }

  /** The stable id of the star a click found at `index` in the last pick, for the spark popup and Follow. */
  claudeIdAt(index: number): number | undefined {
    return this.claude.idAt(index);
  }

  /** Where the star `id` is right now, or undefined once it has faded out and gone. */
  claudePosition(id: number): THREE.Vector3 | undefined {
    return this.claude.positionById(id);
  }

  /** The subagent the star `id` draws: its conversation, the id of the tool call running it, and its type. Undefined for a conversation's own star. */
  claudeAgent(id: number): { key: string; agent: string; name: string | undefined } | undefined {
    return this.claude.agentOf(id);
  }

  /** The star the camera follows, or undefined. */
  get following(): number | undefined {
    return this.followedStarId;
  }

  /** Starts or stops following a star; undefined stops. Carried over by a live update, so a turn's star keeps being followed across one. */
  follow(id: number | undefined): void {
    this.followedStarId = id;
  }

  /** A directory's workspace-relative path; the root reads as the workspace name. */
  clusterName(cluster: number): string {
    const label = this.layout.clusters.labels[cluster];
    return label === '.' ? `${this.graph.root} (root)` : label;
  }

  /** The directories from the root down to the one being looked into; the Flat view looks at the whole workspace. */
  location(): Crumb[] {
    const path = this.viewMode === 'flat' ? [this.view.root] : this.view.path(this.focus.cluster);
    return path.map((cluster) => {
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
      this.subagents.clear();
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
    const morphing = this.advanceMorph(now);
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
    // MCP stations keep to their conversation's star, at the scale of the directory in view, or of an orbit's band.
    const reach = this.viewMode === 'flat' ? 14 : Math.max(3, (this.layout.clusters.radii[this.focus.cluster] ?? 10) * 0.2);
    const stationsOut = this.mcp.update(t, (key) => this.claude.position(key), reach);
    if (focusMoving || stationsOut) this.labelsDirty = true;
    return morphing || this.pending.length > 0 || t < this.animateUntil || claudeMoving || focusMoving || stationsOut || flowTarget > 0 || Math.abs(flow.value - flowTarget) > 0.01;
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
    if (picked.kind === 'claude') {
      const id = this.claude.idAt(picked.index);
      const following = id !== undefined && id === this.followedStarId;
      const agent = id === undefined ? undefined : this.claude.agentOf(id);
      if (agent) return { title: agent.name ?? 'Subagent', detail: following ? 'A subagent, followed. Click for its output.' : 'A subagent. Click for its output, or to follow it.' };
      return { title: 'Claude', detail: following ? 'Following. Click for options.' : 'Click to follow, or see options.' };
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

  /** How large a file is drawn in the view shown. */
  radiusOf(node: number): number {
    return this.fileRadius(node);
  }

  /** A directory's bubble, which the camera frames and zooming draws to the middle of the screen. None in the Flat view. */
  bubbleOf(cluster: number): Sphere | undefined {
    return this.viewMode === 'nested' && cluster >= 0 && cluster < this.clusterCount && this.view.shown[cluster] ? this.spheres[cluster] : undefined;
  }

  /** Frames a directory's bubble. Zooming in to it opens it, and zooming out to it backs out of the one on screen. */
  goTo(cluster: number): void {
    if (this.viewMode === 'flat' || cluster < 0 || cluster >= this.clusterCount || !this.view.shown[cluster]) return;
    this.focus.go(cluster, true);
    this.labelsDirty = true;
  }

  /** Back out to the directory around the current one. False at the root, and in the Flat view. */
  up(): boolean {
    if (this.viewMode === 'flat') return false;
    const parent = this.view.viewParent[this.focus.cluster];
    if (parent < 0) return false;
    this.goTo(parent);
    return true;
  }

  /** The current directory's sub-directory names win, active files come next, then as many file names as fit (hubs first). */
  labelSpecs(): LabelSpec[] {
    const mix = this.uniforms.uFlatMix.value;
    const specs: LabelSpec[] = [];
    // While the files fly between the views, only the labels that follow a file stay up.
    if (mix <= 0.001) {
      const { uFocus, uFocusFrom, uFocusMix } = this.uniforms;
      const shown = uFocusMix.value < 0.5 ? uFocusFrom.value : uFocus.value;
      if (shown !== this.contentLabelsFor) {
        this.contentLabels = this.labelsInside(shown);
        this.contentLabelsFor = shown;
      }
      specs.push(...this.contentLabels);
    } else if (mix >= 0.999 && this.flat) {
      specs.push(...this.flatLabels(this.flat));
    }
    const below = mix >= 0.5;
    for (const { kind, node, at } of this.touched) {
      if (this.state.isRemoving(node)) continue;
      specs.push({ key: `${kind}:${node}`, kind, text: this.graph.nodes.names[node], position: this.nodePosition(node), lift: this.fileRadius(node) * (below ? -1 : 1), below, priority: 5000 + at });
    }
    specs.push(...this.mcp.labelSpecs(this.uniforms.uTime.value));
    if (this.hovered.kind === 'node') {
      const i = this.hovered.index;
      specs.push({ key: `hover:${i}`, kind: 'hover', text: this.graph.nodes.names[i], position: this.nodePosition(i), lift: this.fileRadius(i) * (below ? -1 : 1), below, priority: 1e9 });
    }
    return specs;
  }

  /** Id pass: files and bubbles switch to their id shaders; everything unpickable is hidden. */
  setPickPass(on: boolean): void {
    this.nodes.setPickPass(on);
    this.bubbles.setPickPass(on);
    this.edges.lines.visible = !on;
    this.particles.points.visible = !on;
    this.claude.setPickPass(on);
    this.mcp.group.visible = !on;
    if (this.neurons) this.neurons.lines.visible = !on;
    if (this.orbits) this.orbits.group.visible = !on;
  }

  dispose(): void {
    this.stage.scene.remove(this.nodes.mesh, this.bubbles.mesh, this.edges.lines, this.particles.points, this.claude.group, this.mcp.group);
    if (this.neurons) this.stage.scene.remove(this.neurons.lines);
    if (this.orbits) this.stage.scene.remove(this.orbits.group);
    this.neurons?.dispose();
    this.orbits?.dispose();
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
    for (const name of ['uTime', 'uRestT', 'uFlow', 'uThinkStart', 'uThinkEnd', 'uFlatMix'] as const) uniforms[name].value = previous.uniforms[name].value;
    // The view carries on, and so does a flight between views; the Flat layout keeps every surviving file's slot.
    this.viewMode = previous.viewMode;
    this.morph = previous.morph;
    if (previous.flat && (this.viewMode === 'flat' || uniforms.uFlatMix.value > 0)) {
      this.flat = flatLayout(this.graph, { layout: previous.flat, remap });
      this.buildFlat();
    }

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
    if (this.viewMode === 'flat') this.claude.rehome(this.home());
    this.fitCamera();
    this.mcp.adopt(previous.mcp);
    const open = directory(previous.focus.opened);
    this.focus.adopt(previous.focus, open, open !== cluster(previous.focus.opened), cluster);

    this.touched = previous.touched.flatMap((touch) => (node(touch.node) >= 0 ? [{ ...touch, node: node(touch.node) }] : []));
    this.landings = previous.landings.flatMap((landing) => (node(landing.node) >= 0 ? [{ ...landing, node: node(landing.node) }] : []));
    for (const { event, key, applyAt } of previous.pending) {
      if (!('node' in event)) this.pending.push({ event, key, applyAt });
      else if (node(event.node) >= 0) this.pending.push({ event: { ...event, node: node(event.node) }, key, applyAt });
    }
    this.active = new Set(previous.active);
    this.subagents = new Map(previous.subagents);
    this.followedStarId = previous.followedStarId;
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
    if (event.kind === 'agentStart') {
      this.startAgent(key, event.agent, event.name, t);
      return;
    }
    if (event.kind === 'agentEnd') {
      this.endAgent(subagentKey(key, event.agent), t);
      return;
    }
    if (event.kind === 'mcp') {
      // Hidden panels skip it, like comets: its pulses are timed on a clock that stands still while hidden.
      if (!animate) return;
      const by = event.agent === undefined ? key : this.startAgent(key, event.agent, undefined, t);
      this.active.add(by);
      this.claude.star(by);
      if (event.phase === 'call') this.mcp.call(event.server, event.tool, t, by);
      else this.mcp.answer(event.server, event.phase === 'done', t);
      if (!this.working) this.mcp.settle(t);
      this.animateUntil = Math.max(this.animateUntil, t + 1.5);
      this.labelsDirty = true;
      return;
    }
    if (event.kind === 'turnEnd') {
      for (const [sub, owner] of [...this.subagents]) if (owner === key) this.endAgent(sub, t);
      this.active.delete(key);
      // Comets still in flight, its subagents' too, light nothing: lit after the rest, their files would never fade.
      this.landings = this.landings.filter((landing) => landing.key !== key && !landing.key.startsWith(subagentKey(key, '')));
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
    // A subagent's read or edit moves its own star, which comes out of the conversation's if the subagent is new here.
    const by = event.agent === undefined ? key : this.startAgent(key, event.agent, undefined, t);
    this.active.add(by);
    this.lastKey = by;

    if (event.kind === 'read' && animate) {
      // The comet leaves from where the star is, before the star sets off after it.
      const flight = this.particles.launch(this.claude.star(by).position, this.nodePosition(node), t);
      this.landings.push({ node, at: flight.landsAt, key: by });
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
    this.moveClaude(node, event.kind, t, by);
    this.labelsDirty = true;
  }

  /** The key the subagent `agent` of the conversation `key` is drawn under; the first time it is seen, its star comes out of the conversation's. */
  private startAgent(key: string, agent: string, name: string | undefined, t: number): string {
    const sub = subagentKey(key, agent);
    if (!this.subagents.has(sub)) {
      this.subagents.set(sub, key);
      this.active.add(sub);
      this.animateUntil = Math.max(this.animateUntil, t + 1);
    }
    this.claude.spawn(sub, key, agent, name);
    return sub;
  }

  /** A subagent is done: its star goes back into its conversation's, and the MCP stations orbiting it leave. */
  private endAgent(sub: string, t: number): void {
    if (!this.subagents.delete(sub)) return;
    this.active.delete(sub);
    this.mcp.settle(t, sub);
    this.claude.recall(sub);
    this.animateUntil = Math.max(this.animateUntil, t + 1.2);
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

  /** The conversation's or subagent's star moves over the file it works on, at the scale of the directory in view, and flares cyan for a read or amber for an edit. */
  private moveClaude(node: number, kind: 'read' | 'edit', t: number, key: string): void {
    const point = this.nodePosition(node);
    point.y += this.viewMode === 'flat' ? this.fileRadius(node) + 4 : Math.max(3, this.layout.clusters.radii[this.focus.cluster] * 0.1);
    this.claude.workOn(key, point, kind, t);
  }

  /** Plays out the flight between the views, easing in and out. Returns whether it is still under way. */
  private advanceMorph(now: number): boolean {
    const morph = this.morph;
    if (!morph) return false;
    const t = Math.min(1, Math.max(0, (now - morph.start) / morph.duration));
    const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    this.uniforms.uFlatMix.value = morph.from + (morph.to - morph.from) * eased;
    this.labelsDirty = true;
    if (t >= 1) this.morph = undefined;
    return true;
  }

  /** The Flat view's spheres and icons on the file mesh, its neurons and its orbits. */
  private buildFlat(): void {
    const flat = this.flat!;
    this.nodes.setFlat(flat, this.graph.nodes.names);
    this.neurons = new NeuronLayer(this.graph.edges, flat, this.fileColors, this.uniforms);
    this.orbits = new OrbitLayer(flat, this.uniforms);
    this.stage.scene.add(this.neurons.lines, this.orbits.group);
  }

  /** Where Claude's first star rests: above the root directory's contents toward the default camera, or above the core. */
  private home(): THREE.Vector3 {
    if (this.viewMode === 'flat') return new THREE.Vector3(0, CORE_RADIUS * 3.8, CORE_RADIUS * 1.6);
    const radius = Math.max(10, this.nestedBounds.radius);
    return this.nestedBounds.center.clone().add(new THREE.Vector3(0, radius * 0.35, radius * 0.45));
  }

  /** How near and far the camera draws, and how far out it may go, for the view shown. */
  private fitCamera(): void {
    const radius = Math.max(10, this.bounds.radius);
    const camera = this.stage.camera;
    camera.near = Math.max(0.05, radius / 4000);
    camera.far = radius * 40;
    camera.updateProjectionMatrix();
    this.stage.controls.maxDistance = radius * 8;
  }

  /** The names of the groups along their arcs, and of as many files as are large enough on screen, the largest first. */
  private flatLabels(flat: FlatLayout): LabelSpec[] {
    const { camera, height } = this.stage;
    const view = camera.matrixWorldInverse.elements;
    const projection = camera.projectionMatrix.elements;
    const { positions, radii } = flat;
    const candidates: Array<{ node: number; px: number }> = [];
    for (let i = 0; i < this.graph.nodes.count; i++) {
      if (this.state.isRemoving(i)) continue;
      const [x, y, z] = [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
      const depth = -(view[2] * x + view[6] * y + view[10] * z + view[14]);
      if (depth <= camera.near) continue;
      const px = (radii[i] * projection[5] * height * 0.5) / depth;
      if (px < FLAT_LABEL_PX) continue;
      const vx = view[0] * x + view[4] * y + view[8] * z + view[12];
      const vy = view[1] * x + view[5] * y + view[9] * z + view[13];
      if (Math.abs((projection[0] * vx) / depth) > 1.05 || Math.abs((projection[5] * vy) / depth) > 1.05) continue;
      candidates.push({ node: i, px });
    }
    candidates.sort((a, b) => b.px - a.px);
    const specs: LabelSpec[] = candidates.slice(0, MAX_FLAT_LABELS).map(({ node, px }) => ({
      key: `file:${node}`,
      kind: 'file',
      text: this.graph.nodes.names[node],
      position: this.flatPosition(node),
      lift: -radii[node],
      below: true,
      priority: 100 + px,
    }));

    // Each group is named at the middle of its arc, above its band.
    const point = [0, 0, 0];
    for (const arc of flat.arcs) {
      const ring = flat.rings[arc.ring];
      ringPoint(ring, arc.start + (arc.columns - ARC_GAP - 1) / 2, (ring.lanes - 1) / 2, point);
      specs.push({
        key: `arc:${arc.label}`,
        kind: 'cluster',
        text: shortPath(arc.label),
        detail: arc.count.toLocaleString('en-US'),
        position: new THREE.Vector3(point[0], point[1], point[2]),
        lift: halfBand(ring) + 1,
        priority: 20_000 + arc.count,
      });
    }
    return specs;
  }

  private flatPosition(node: number): THREE.Vector3 {
    const positions = this.flat!.positions;
    return new THREE.Vector3(positions[node * 3], positions[node * 3 + 1], positions[node * 3 + 2]);
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

  /** Where a file is drawn right now: in its directory, on its orbit, or on its way between them, as nodes.ts has it. */
  private nodePosition(node: number): THREE.Vector3 {
    const positions = this.layout.positions;
    const nested = new THREE.Vector3(positions[node * 3], positions[node * 3 + 1], positions[node * 3 + 2]);
    const mix = this.uniforms.uFlatMix.value;
    if (mix <= 0 || !this.flat) return nested;
    const flat = this.flatPosition(node);
    let away = THREE.MathUtils.clamp((mix - this.flat.delays[node]) / (1 - MORPH_STAGGER), 0, 1);
    away = away * away * (3 - 2 * away);
    const lift = Math.sin(Math.PI * away) * 0.18 * nested.distanceTo(flat);
    nested.lerp(flat, away).y += lift;
    return nested;
  }

  /** A label lifted this far clears its file. */
  private fileRadius(node: number): number {
    return this.uniforms.uFlatMix.value >= 0.5 && this.flat ? this.flat.radii[node] : nodeRadius(this.graph.nodes.sizes[node]);
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
