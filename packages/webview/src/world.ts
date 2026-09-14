import type { ActivityEvent, GraphContent, LayoutSnapshot } from '@orbit-code/protocol';
import * as THREE from 'three';
import { Bubbles } from './bubbles';
import { ClaudeLayer } from './claude';
import { DirView } from './dirView';
import { EdgeLayer } from './edges';
import { CORE_RADIUS, type FlatLayout, flatLayout } from './flatLayout';
import { Focus, type Sphere } from './focus';
import type { Crumb } from './hud/identity';
import type { ViewMode } from './hud/viewTabs';
import type { LabelSpec } from './labels';
import { McpLayer } from './mcp';
import { NeuronLayer } from './neurons';
import { type Adjacency, NodeState, REMOVE_S, buildAdjacency } from './nodeState';
import { NodeLayer } from './nodes';
import { OrbitLayer } from './orbits';
import { ParticleLayer } from './particles';
import type { Picked } from './picking';
import type { Stage } from './stage';
import { type SharedUniforms, createSharedUniforms } from './uniforms';
import { Activity } from './world/activity';
import { type Description, describeDirectory, describeFile, describeStar } from './world/describe';
import { type FileKinds, deriveKinds } from './world/kinds';
import { type LabelSource, directoryLabels, flatLabels } from './world/labelSpecs';
import { MORPH_MS, Morph } from './world/morph';
import { clusterCenter, filePosition, fileRadius } from './world/positions';

/**
 * Everything drawn for one graph + frozen layout, and how session activity animates it. The view looks
 * into one directory at a time: its files and its sub-directory bubbles, with the imports between them.
 */
export class World {
  readonly uniforms: SharedUniforms;
  readonly focus: Focus;
  readonly adjacency: Adjacency;
  readonly view: DirView;
  private readonly fileKinds: FileKinds;
  private readonly state: NodeState;
  private readonly nodes: NodeLayer;
  private readonly bubbles: Bubbles;
  private readonly edges: EdgeLayer;
  private readonly particles: ParticleLayer;
  private readonly claude: ClaudeLayer;
  private readonly mcp: McpLayer;
  private readonly activity: Activity;
  /** Each directory's bubble, which the camera frames. */
  private readonly spheres: Sphere[];
  private readonly labelSource: LabelSource;
  private animateUntil = 0;
  private hovered: Picked = { kind: 'none' };
  /** The stable id (ClaudeNode.id) of the star the camera is asked to keep up with, or undefined. Survives a live update: the same id still finds its star after adopt. */
  private followedStarId: number | undefined;
  /** Labels for one directory's contents, and which directory they are for. */
  private contentLabels: LabelSpec[] = [];
  private contentLabelsFor = -1;
  private labelsDirty = true;
  /** The root directory's bubble: what the Nested view frames at its widest. */
  private readonly nestedBounds: Sphere;
  /** Nested or Flat; while the files fly between the two, the one they are flying to. */
  private viewMode: ViewMode = 'nested';
  private readonly morph: Morph;
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
    this.morph = new Morph(this.uniforms.uFlatMix);

    this.fileKinds = deriveKinds(graph, layout, this.view);
    this.nodes = new NodeLayer(layout.positions, graph.nodes.sizes, this.fileKinds.fileColors, layout.clusterOf, this.view.viewParent, this.uniforms);
    this.bubbles = new Bubbles(centers, radii, this.fileKinds.bubbleColors, this.view, this.uniforms);
    this.edges = new EdgeLayer(graph.edges, layout.positions, layout.clusterOf, centers, radii, this.view, this.uniforms);
    this.particles = new ParticleLayer(this.uniforms);

    this.spheres = labels.map((_, c) => ({ center: clusterCenter(layout, c), radius: radii[c] }));
    this.nestedBounds = labels.length > 0 ? this.spheres[this.view.root] : { center: new THREE.Vector3(), radius: 10 };

    this.claude = new ClaudeLayer(this.home(), Math.max(2.5, Math.max(10, this.nestedBounds.radius) * 0.07), this.uniforms);
    this.mcp = new McpLayer(this.uniforms);
    this.activity = new Activity({
      uniforms: this.uniforms,
      state: this.state,
      bubbles: this.bubbles,
      particles: this.particles,
      claude: this.claude,
      mcp: this.mcp,
      clusterOf: layout.clusterOf,
      count,
      position: (node) => this.positionOf(node),
      starPoint: (node) => this.starPoint(node),
      keepAnimating: (until) => this.keepAnimating(until),
      labelsChanged: () => (this.labelsDirty = true),
    });

    const members: number[][] = labels.map(() => []);
    for (let i = 0; i < count; i++) members[layout.clusterOf[i]].push(i);
    this.labelSource = {
      graph,
      layout,
      view: this.view,
      adjacency: this.adjacency,
      members,
      removing: (node) => this.state.isRemoving(node),
      position: (node) => this.positionOf(node),
      radius: (node) => this.radiusOf(node),
    };

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

  get kinds(): Uint8Array {
    return this.fileKinds.kinds;
  }

  get dominantKinds(): Uint8Array {
    return this.fileKinds.dominantKinds;
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
    return this.morph.active;
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
    this.morph.start(mode === 'flat' ? 1 : 0, animate);
    if (mode === 'flat') this.focus.freeze(this.bounds, animate, MORPH_MS * 0.8);
    else this.focus.thaw(this.focus.opened, animate, MORPH_MS * 0.8);
    this.claude.rehome(this.home());
    this.fitCamera();
    this.hover({ kind: 'none' });
    this.contentLabelsFor = -1;
    this.labelsDirty = true;
    this.keepAnimating(this.uniforms.uTime.value + 0.2);
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

  setWorking(working: boolean): void {
    this.activity.setWorking(working);
  }

  resize(): void {
    this.uniforms.uPixelRatio.value = this.stage.pixelRatio;
    this.uniforms.uViewportHeight.value = this.stage.height;
    this.labelsDirty = true;
  }

  enqueue(events: readonly ActivityEvent[], visible: boolean, key: string): void {
    this.activity.enqueue(events, visible, key);
  }

  pulseAdded(added: Uint32Array): void {
    this.activity.pulseAdded(added);
  }

  /** Advances animation by dt seconds. Returns whether another frame is needed. */
  update(dt: number, now: number): boolean {
    const t = (this.uniforms.uTime.value += dt);
    const morphing = this.morph.advance(now);
    const playing = this.activity.update(t, dt);
    this.state.flush();

    const claudeMoving = this.claude.update(dt);
    const focusMoving = this.focus.update(now);
    // MCP stations keep to their conversation's star, at the scale of the directory in view, or of an orbit's band.
    const reach = this.viewMode === 'flat' ? 14 : Math.max(3, (this.layout.clusters.radii[this.focus.cluster] ?? 10) * 0.2);
    const stationsOut = this.mcp.update(t, (key) => this.claude.position(key), reach);
    if (morphing || focusMoving || stationsOut) this.labelsDirty = true;
    return morphing || playing || t < this.animateUntil || claudeMoving || focusMoving || stationsOut;
  }

  consumeLabelsDirty(): boolean {
    const dirty = this.labelsDirty;
    this.labelsDirty = false;
    return dirty;
  }

  /** Updates hover highlighting and returns tooltip text, if any. */
  hover(picked: Picked): Description | undefined {
    const changed = picked.kind !== this.hovered.kind || (picked.kind !== 'none' && this.hovered.kind !== 'none' && picked.index !== this.hovered.index);
    this.hovered = picked;
    this.uniforms.uHover.value = picked.kind === 'node' ? picked.index : -1;
    this.uniforms.uHoverCluster.value = picked.kind === 'cluster' ? picked.index : -1;
    if (changed) this.labelsDirty = true;

    if (picked.kind === 'node') return describeFile(this.graph, this.fileKinds, this.adjacency, picked.index);
    if (picked.kind === 'cluster') return describeDirectory(this.clusterName(picked.index), this.fileKinds, this.view, picked.index);
    if (picked.kind === 'claude') {
      const id = this.claude.idAt(picked.index);
      return describeStar(id === undefined ? undefined : this.claude.agentOf(id), id !== undefined && id === this.followedStarId);
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
    this.keepAnimating(uTime.value + 0.5);
  }

  /** The file menu deletes a file: it collapses at once, and stays hidden until the update that removes it. */
  remove(node: number): void {
    if (node < 0 || node >= this.graph.nodes.count) return;
    const t = this.uniforms.uTime.value;
    this.state.removing(node, t);
    if (this.selected === node) this.select(-1);
    if (this.hovered.kind === 'node' && this.hovered.index === node) this.hover({ kind: 'none' });
    this.keepAnimating(t + REMOVE_S);
    this.contentLabelsFor = -1;
    this.labelsDirty = true;
  }

  /** The delete failed: the file comes back, with the pulse of a file that joined. */
  restore(node: number): void {
    if (node < 0 || node >= this.graph.nodes.count || !this.state.isRemoving(node)) return;
    const t = this.uniforms.uTime.value;
    this.state.added(node, t);
    this.keepAnimating(t + 3);
    this.contentLabelsFor = -1;
    this.labelsDirty = true;
  }

  /** Where a file sits, for HUD anchored to it. */
  positionOf(node: number): THREE.Vector3 {
    return filePosition(this.layout, this.flat, this.uniforms.uFlatMix.value, node);
  }

  /** How large a file is drawn in the view shown. */
  radiusOf(node: number): number {
    return fileRadius(this.graph.nodes.sizes, this.flat, this.uniforms.uFlatMix.value, node);
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
        this.contentLabels = directoryLabels(this.labelSource, shown);
        this.contentLabelsFor = shown;
      }
      specs.push(...this.contentLabels);
    } else if (mix >= 0.999 && this.flat) {
      specs.push(...flatLabels(this.labelSource, this.flat, this.stage));
    }
    const below = mix >= 0.5;
    for (const { kind, node, at } of this.activity.touched) {
      if (this.state.isRemoving(node)) continue;
      specs.push({ key: `${kind}:${node}`, kind, text: this.graph.nodes.names[node], position: this.positionOf(node), lift: this.radiusOf(node) * (below ? -1 : 1), below, priority: 5000 + at });
    }
    specs.push(...this.mcp.labelSpecs(this.uniforms.uTime.value));
    if (this.hovered.kind === 'node') {
      const i = this.hovered.index;
      specs.push({ key: `hover:${i}`, kind: 'hover', text: this.graph.nodes.names[i], position: this.positionOf(i), lift: this.radiusOf(i) * (below ? -1 : 1), below, priority: 1e9 });
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
    this.morph.adopt(previous.morph);
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

    this.activity.adopt(previous.activity, node);
    this.followedStarId = previous.followedStarId;
    this.animateUntil = previous.animateUntil;

    const hovered = previous.hovered;
    const index = hovered.kind === 'node' ? node(hovered.index) : hovered.kind === 'cluster' ? cluster(hovered.index) : -1;
    this.hovered = hovered.kind !== 'none' && index >= 0 ? { kind: hovered.kind, index } : { kind: 'none' };
    uniforms.uHover.value = this.hovered.kind === 'node' ? this.hovered.index : -1;
    uniforms.uHoverCluster.value = this.hovered.kind === 'cluster' ? this.hovered.index : -1;
    this.labelsDirty = true;
  }

  private keepAnimating(until: number): void {
    this.animateUntil = Math.max(this.animateUntil, until);
  }

  /** Where a star working on a file hovers: above it, at the scale of the directory in view, or of its sphere in the Flat view. */
  private starPoint(node: number): THREE.Vector3 {
    const point = this.positionOf(node);
    point.y += this.viewMode === 'flat' ? this.radiusOf(node) + 4 : Math.max(3, this.layout.clusters.radii[this.focus.cluster] * 0.1);
    return point;
  }

  /** The Flat view's spheres and icons on the file mesh, its neurons and its orbits. */
  private buildFlat(): void {
    const flat = this.flat!;
    this.nodes.setFlat(flat, this.graph.nodes.names);
    this.neurons = new NeuronLayer(this.graph.edges, flat, this.fileKinds.fileColors, this.uniforms);
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
}
