import { nodeId } from '@orbit-code/graph/columnar';
import { FILE_KINDS, FILE_KIND_LABELS } from '@orbit-code/graph/languages';
import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { type Sphere, fitDistance } from './focus';
import { type World, formatBytes } from './world';

// A tour of the workspace: the camera flies from one place to the next, a directory or a file picked at random (hubs
// and large files more often than the rest, and nowhere twice until everywhere has been), each time on a fresh
// bearing, and rests there a moment. A leg to a place outside the directory the camera is in first backs out to the
// directory holding both (in the Flat view, up over the orbits), on the bearing the camera already has, and then
// swings in to the stop on the new one, so the view zooms out and in as a hand would move it, and never snaps. Some
// stops get a card with what the graph knows about the place: the most imported file in its directory, the largest,
// a leaf, an entry point, a directory nothing outside imports from. It runs until stopped; while it does, main.ts
// keeps the drag, the wheel, clicks, Esc, the breadcrumb and the view tabs off.

/** A leg's flight lasts between these, the longer the further it goes, in milliseconds, shared between its segments. */
const LEG_MIN_MS = 1200;
const LEG_MAX_MS = 3000;
const SEGMENT_MIN_MS = 500;
/** How long the camera rests at a stop: a moment, and a card adds reading time, per fact. */
const DWELL_MS = 1000;
const CARD_MS = 1200;
const FACT_MS = 500;
/** In the Flat view, a leg rises over the orbits when the stops are further apart than this many times the frame's radius. */
const FLAT_RISE = 4;
/** The share of stops that get a card, unless told otherwise. */
const CARD_SHARE = 0.6;
/** How far the bearing swings round between stops, in radians, and how often it turns back the other way. */
const SWING_MIN = 0.5;
const SWING_MAX = 1.25;
const TURN_BACK = 0.2;
/** The camera's angle from the layout's axis in the Nested view, and its height above the orbits' plane in the Flat one, in radians. */
const NESTED_TILT: readonly [number, number] = [0.25, 0.6];
const FLAT_ELEVATION: readonly [number, number] = [0.4, 0.8];
/** A file is framed with this much of its directory's bubble around it, and at least this many times its own radius. */
const FILE_FRAME_MIN = 0.4;
const FILE_FRAME_MAX = 0.8;
const FILE_FRAME_RADII = 8;
/** In the Flat view, a file is framed at this many times its radius: its icon and name read, its neighbours show. */
const FLAT_FRAME_RADII = 9;
/** After a directory, how often the next stop is one of its own files; after a file, one of its neighbours, or its directory. */
const INTO_DIRECTORY = 0.7;
const STAY_IN_DIRECTORY = 0.35;
const UP_TO_DIRECTORY = 0.25;
/** Among stops picked from the whole workspace, the share that are directories. */
const DIRECTORY_SHARE = 0.45;
const MAX_FACTS = 3;
/** A directory's contents count as looked into while the centre ray passes within this share of its radius (focus.ts's CENTRAL_START, with room). */
const CENTRAL = 0.6;

/** What a stop's card says: where it is, what it is, and what the graph knows about it. */
export interface StopCard {
  kicker: string;
  title: string;
  facts: string[];
}

export interface Stop {
  kind: 'file' | 'directory';
  /** Node or cluster index, in the World it was picked in. */
  index: number;
  /** The file's id or the directory's label, to find it again after a live update. */
  id: string;
  card: StopCard | undefined;
}

export interface TourView {
  /** The camera has arrived at a stop that has a card. */
  showCard(card: StopCard, stop: Stop): void;
  hideCard(): void;
  /** A frame is due. */
  wake(): void;
}

export interface TourOptions {
  /** Seeds the choices, for a run that can be repeated. */
  seed?: number;
  /** The share of stops that get a card, 0 to 1. */
  cards?: number;
}

/** What the graph knows, worked out once per World. */
interface Stats {
  world: World;
  /** Imports per file, and importers per file. */
  outOffsets: Uint32Array;
  outTargets: Uint32Array;
  inOffsets: Uint32Array;
  inSources: Uint32Array;
  /** Files directly inside each directory. */
  members: number[][];
  shownDirectories: number[];
  mostImported: number;
  largest: number;
  largestDirectory: number;
}

type Phase = 'idle' | 'waiting' | 'leg' | 'dwell';

/** One straight camera move of a leg: out to the directory holding both places, or in to the stop. */
interface Segment {
  sphere: Sphere;
  to: number;
  bearing: THREE.Vector3;
  duration: number;
}

const bearing = new THREE.Vector3();

export class Tour {
  private world: World | undefined;
  private stats: Stats | undefined;
  private phase: Phase = 'idle';
  private stop: Stop | undefined;
  /** The rest of the leg under way, after the segment the camera is on. */
  private segments: Segment[] = [];
  private stopCount = 0;
  private dwellUntil = 0;
  private random: () => number = Math.random;
  private cards = CARD_SHARE;
  private instant = false;
  /** The bearing's angle round the layout's axis, and which way it is swinging. */
  private theta = 0;
  private swing = 1;
  private visitedFiles = new Set<string>();
  private visitedDirectories = new Set<string>();

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly controls: OrbitControls,
    private readonly view: TourView,
  ) {}

  get active(): boolean {
    return this.phase !== 'idle';
  }

  /** The stop the camera is at or on its way to. */
  get current(): Stop | undefined {
    return this.stop;
  }

  /** For the harness. */
  state(): { active: boolean; phase: Phase; stops: number; stop: { kind: Stop['kind']; id: string } | null; card: boolean } {
    return {
      active: this.active,
      phase: this.phase,
      stops: this.stopCount,
      stop: this.stop ? { kind: this.stop.kind, id: this.stop.id } : null,
      card: this.phase === 'dwell' && this.stop?.card !== undefined,
    };
  }

  /** Sets off from wherever the camera is. */
  start(world: World, options: TourOptions = {}): void {
    this.world = world;
    this.stats = undefined;
    this.random = options.seed === undefined ? Math.random : mulberry32(options.seed);
    this.cards = options.cards ?? CARD_SHARE;
    this.instant = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.stopCount = 0;
    this.visitedFiles.clear();
    this.visitedDirectories.clear();
    bearing.subVectors(this.camera.position, this.controls.target);
    this.theta = world.mode === 'flat' ? Math.atan2(bearing.z, bearing.x) : Math.atan2(bearing.y, bearing.x);
    this.swing = this.random() < 0.5 ? -1 : 1;
    this.phase = 'waiting';
    this.view.wake();
  }

  /** The camera stays where it is; a leg under way finishes on its own. */
  end(): void {
    if (this.phase === 'idle') return;
    this.view.hideCard();
    this.world?.select(-1);
    this.phase = 'idle';
    this.stop = undefined;
    this.segments = [];
    this.world = undefined;
    this.stats = undefined;
  }

  /** A live update replaced the World: the stop is found again by its id, or the tour moves on. */
  rebase(world: World): void {
    if (this.phase === 'idle') return;
    this.world = world;
    this.stats = undefined;
    const stop = this.stop;
    if (!stop) return;
    const index = stop.kind === 'file' ? findNode(world, stop.id) : world.layout.clusters.labels.indexOf(stop.id);
    if (index >= 0 && (stop.kind === 'file' || world.view.shown[index])) {
      stop.index = index;
      if (this.phase === 'dwell' && stop.kind === 'file') world.select(index);
      // The segments still to fly named the old World's directories: the way there is planned again from here.
      else if (this.phase === 'leg' && this.segments.length > 0) this.depart(world, stop);
      return;
    }
    this.stop = undefined;
    this.next(performance.now());
  }

  /** Drives the tour: sets off once the view is still, rests on arrival, and moves on when the rest is over. True while it runs. */
  update(now: number): boolean {
    const world = this.world;
    if (!world || this.phase === 'idle') return false;
    if (this.phase === 'waiting') {
      if (!world.morphing) this.next(now);
    } else if (this.phase === 'leg') {
      if (!world.focus.animating) {
        if (this.segments.length > 0) this.fly(world);
        else this.arrive(now);
      }
    } else if (now >= this.dwellUntil) {
      this.next(now);
    }
    return true;
  }

  private arrive(now: number): void {
    const world = this.world!;
    const stop = this.stop!;
    this.phase = 'dwell';
    this.stopCount++;
    let dwell = DWELL_MS;
    if (stop.kind === 'file') world.select(stop.index);
    if (stop.card) {
      dwell += CARD_MS + FACT_MS * stop.card.facts.length;
      this.view.showCard(stop.card, stop);
    }
    this.dwellUntil = now + dwell;
    this.view.wake();
  }

  private next(now: number): void {
    const world = this.world!;
    const stats = this.statsFor(world);
    this.view.hideCard();
    world.select(-1);
    const stop = this.pick(world, stats);
    if (!stop) {
      // Nothing to visit: an empty graph.
      this.dwellUntil = now + DWELL_MS;
      this.phase = 'dwell';
      return;
    }
    this.stop = stop;
    this.phase = 'leg';
    this.depart(world, stop);
  }

  /** Plans the way to `stop` from where the camera is, and sets off. */
  private depart(world: World, stop: Stop): void {
    // The bearing swings on round the axis, now and then turning back; a file in a directory is looked at from an
    // angle that keeps the directory in view and no sub-directory bubble in the way.
    if (this.random() < TURN_BACK) this.swing = -this.swing;
    this.theta += this.swing * (SWING_MIN + this.random() * (SWING_MAX - SWING_MIN));
    const flat = world.mode === 'flat';
    const angle = flat ? FLAT_ELEVATION : NESTED_TILT;
    const tilt = angle[0] + this.random() * (angle[1] - angle[0]);

    let sphere: Sphere;
    let to = -1;
    let direction: THREE.Vector3;
    if (stop.kind === 'directory') {
      sphere = world.bubbleOf(stop.index)!;
      to = stop.index;
      direction = bearingAt(this.theta, tilt, flat);
    } else if (flat) {
      sphere = { center: world.positionOf(stop.index), radius: world.radiusOf(stop.index) * FLAT_FRAME_RADII };
      direction = bearingAt(this.theta, tilt, true);
    } else {
      const directory = world.view.shownAncestor(world.layout.clusterOf[stop.index]);
      const bubble = world.bubbleOf(directory) ?? world.bounds;
      to = directory;
      sphere = { center: world.positionOf(stop.index), radius: Math.min(bubble.radius * FILE_FRAME_MAX, Math.max(bubble.radius * FILE_FRAME_MIN, world.radiusOf(stop.index) * FILE_FRAME_RADII)) };
      const distance = fitDistance(sphere.radius, this.camera);
      const around = world.view.children[directory].flatMap((child) => world.bubbleOf(child) ?? []);
      direction = clearBearing(sphere.center, distance, bubble, around, this.theta, tilt);
    }

    // The way there. A stop within the directory the camera is in, or above it, is one straight move. Anywhere else,
    // the camera first backs out to the directory holding both places on the bearing it already has, so the view zooms
    // out the way it opened, and then swings in to the stop; in the Flat view it rises over the orbits between stops
    // far apart. The leg's time is shared between the segments by how far each goes.
    const legs: Omit<Segment, 'duration'>[] = [];
    const current = new THREE.Vector3().subVectors(this.camera.position, this.controls.target).normalize();
    if (flat) {
      const apart = this.controls.target.distanceTo(sphere.center);
      if (apart > FLAT_RISE * sphere.radius) {
        legs.push({ sphere: { center: this.controls.target.clone().lerp(sphere.center, 0.5), radius: Math.max(sphere.radius, apart / 2) }, to: -1, bearing: current });
      }
    } else {
      const open = world.focus.opened;
      const between = commonAncestor(world.view.viewParent, open, to);
      if (between !== open && between !== to) legs.push({ sphere: world.bubbleOf(between) ?? world.bounds, to: between, bearing: current });
    }
    legs.push({ sphere, to, bearing: direction });

    const from = this.camera.position.clone();
    const travels = legs.map((leg) => {
      const end = leg.sphere.center.clone().addScaledVector(leg.bearing, fitDistance(leg.sphere.radius, this.camera));
      const travel = from.distanceTo(end);
      from.copy(end);
      return travel;
    });
    const travel = travels.reduce((sum, t) => sum + t, 0);
    const share = Math.min(1, Math.log10(1 + travel / (10 * sphere.radius)));
    const total = LEG_MIN_MS + (LEG_MAX_MS - LEG_MIN_MS) * share;
    this.segments = legs.map((leg, i) => ({ ...leg, duration: this.instant ? 0 : Math.max(SEGMENT_MIN_MS, (total * travels[i]) / Math.max(1e-6, travel)) }));
    this.fly(world);
  }

  /** Sets off on the leg's next segment. */
  private fly(world: World): void {
    const segment = this.segments.shift()!;
    world.focus.frame(segment.sphere, { to: segment.to, duration: segment.duration, bearing: segment.bearing, ease: 'inOut' });
    this.view.wake();
  }

  /** The next stop: after a directory, usually one of its files; after a file, a neighbour or its directory now and then; else anywhere. */
  private pick(world: World, stats: Stats): Stop | undefined {
    const previous = this.stop;
    const flat = world.mode === 'flat';
    if (!flat && previous?.kind === 'directory' && this.random() < INTO_DIRECTORY) {
      const file = this.pickFile(world, stats, stats.members[previous.index]);
      if (file) return file;
    }
    if (!flat && previous?.kind === 'file') {
      const directory = world.view.shownAncestor(world.layout.clusterOf[previous.index]);
      const roll = this.random();
      if (roll < STAY_IN_DIRECTORY) {
        const file = this.pickFile(world, stats, stats.members[directory]);
        if (file) return file;
      } else if (roll < STAY_IN_DIRECTORY + UP_TO_DIRECTORY) {
        const above = world.view.viewParent[directory];
        const choice = this.pickDirectory(world, stats, above >= 0 ? [above, ...world.view.children[directory]] : world.view.children[directory]);
        if (choice) return choice;
      }
    }
    if (!flat && this.random() < DIRECTORY_SHARE) {
      const directory = this.pickDirectory(world, stats, stats.shownDirectories);
      if (directory) return directory;
    }
    return this.pickFile(world, stats, undefined) ?? (flat ? undefined : this.pickDirectory(world, stats, stats.shownDirectories));
  }

  /** A file among `among` (every file when undefined) not yet visited, hubs and large files more often; once all have been, any of them again. */
  private pickFile(world: World, stats: Stats, among: readonly number[] | undefined): Stop | undefined {
    const { nodes } = world.graph;
    const { importsOf, importedBy } = world.adjacency;
    const pool: readonly number[] = among ?? Array.from({ length: nodes.count }, (_, i) => i);
    if (pool.length === 0) return undefined;
    let fresh: readonly number[] = pool.filter((i) => !this.visitedFiles.has(nodeId(nodes, i)));
    if (fresh.length === 0) {
      if (among === undefined) this.visitedFiles.clear();
      fresh = pool;
    }
    const weight = (i: number) => 1 + Math.log2(1 + importsOf[i] + importedBy[i]) + 0.5 * Math.log10(1 + nodes.sizes[i] / 1024);
    const index = this.weighted(fresh, weight);
    const id = nodeId(nodes, index);
    this.visitedFiles.add(id);
    return { kind: 'file', index, id, card: this.random() < this.cards ? fileCard(world, stats, index) : undefined };
  }

  private pickDirectory(world: World, stats: Stats, among: readonly number[]): Stop | undefined {
    const labels = world.layout.clusters.labels;
    const pool = among.filter((c) => world.view.shown[c] && world.bubbleOf(c) !== undefined);
    if (pool.length === 0) return undefined;
    let fresh = pool.filter((c) => !this.visitedDirectories.has(labels[c]));
    if (fresh.length === 0) {
      if (among === stats.shownDirectories) this.visitedDirectories.clear();
      fresh = pool;
    }
    const index = this.weighted(fresh, (c) => (c === world.view.root ? 1 : 1 + Math.log2(1 + world.view.files[c])));
    this.visitedDirectories.add(labels[index]);
    return { kind: 'directory', index, id: labels[index], card: this.random() < this.cards ? directoryCard(world, stats, index) : undefined };
  }

  private weighted(items: readonly number[], weight: (item: number) => number): number {
    let total = 0;
    for (const item of items) total += weight(item);
    let roll = this.random() * total;
    for (const item of items) {
      roll -= weight(item);
      if (roll <= 0) return item;
    }
    return items[items.length - 1];
  }

  private statsFor(world: World): Stats {
    if (this.stats?.world === world) return this.stats;
    this.stats = buildStats(world);
    return this.stats;
  }
}

/** The direction from the target to the camera: round the layout's axis by `theta`, off it by `tilt` (Nested), or above the orbits' plane by `tilt` (Flat). */
function bearingAt(theta: number, tilt: number, flat: boolean): THREE.Vector3 {
  return flat
    ? new THREE.Vector3(Math.cos(theta) * Math.cos(tilt), Math.sin(tilt), Math.sin(theta) * Math.cos(tilt))
    : new THREE.Vector3(Math.cos(theta) * Math.sin(tilt), Math.sin(theta) * Math.sin(tilt), Math.cos(tilt));
}

/**
 * A bearing on a file from which its directory stays looked into (the centre ray passes near the bubble's centre, or
 * the camera is inside it) and no sub-directory bubble lies on the ray or around the camera, since either would open
 * that sub-directory instead (focus.ts). Bearings near `theta` are tried first; failing all, the one looking in from
 * the file toward the directory's centre, which always keeps the directory.
 */
function clearBearing(target: THREE.Vector3, distance: number, directory: Sphere, around: readonly Sphere[], theta: number, tilt: number): THREE.Vector3 {
  const position = new THREE.Vector3();
  const forward = new THREE.Vector3();
  const toCenter = new THREE.Vector3();
  const trouble = (direction: THREE.Vector3): number => {
    position.copy(target).addScaledVector(direction, distance);
    forward.copy(direction).negate();
    let score = 0;
    toCenter.subVectors(directory.center, position);
    const inside = toCenter.length() < directory.radius * 0.9;
    const depth = toCenter.dot(forward);
    const miss = depth > 0 ? Math.sqrt(Math.max(0, toCenter.lengthSq() - depth * depth)) : Infinity;
    if (!inside && miss > directory.radius * CENTRAL) score += 10 + miss / directory.radius;
    for (const child of around) {
      toCenter.subVectors(child.center, position);
      if (toCenter.length() < child.radius * 1.15) score += 5;
      const d = toCenter.dot(forward);
      if (d <= 0) continue;
      const m = Math.sqrt(Math.max(0, toCenter.lengthSq() - d * d));
      if (m < child.radius * 1.1) score += 1 + (child.radius * 1.1 - m) / child.radius;
    }
    return score;
  };
  let best: THREE.Vector3 | undefined;
  let bestScore = Infinity;
  for (const step of [0, 0.35, -0.35, 0.7, -0.7, 1.05, -1.05]) {
    const candidate = bearingAt(theta + step, tilt, false);
    const score = trouble(candidate);
    if (score === 0) return candidate;
    if (score < bestScore) [best, bestScore] = [candidate, score];
  }
  const outward = new THREE.Vector3().subVectors(target, directory.center);
  if (outward.lengthSq() > 1e-6 && trouble(outward.normalize()) < bestScore) return outward;
  return best ?? bearingAt(theta, tilt, false);
}

function buildStats(world: World): Stats {
  const { nodes, edges } = world.graph;
  const count = nodes.count;
  const { importsOf, importedBy } = world.adjacency;
  const outOffsets = new Uint32Array(count + 1);
  const inOffsets = new Uint32Array(count + 1);
  for (let i = 0; i < count; i++) {
    outOffsets[i + 1] = outOffsets[i] + importsOf[i];
    inOffsets[i + 1] = inOffsets[i] + importedBy[i];
  }
  const outTargets = new Uint32Array(outOffsets[count]);
  const inSources = new Uint32Array(inOffsets[count]);
  const outCursor = outOffsets.slice(0, count);
  const inCursor = inOffsets.slice(0, count);
  for (let e = 0; e < edges.length; e += 2) {
    outTargets[outCursor[edges[e]]++] = edges[e + 1];
    inSources[inCursor[edges[e + 1]]++] = edges[e];
  }
  const members: number[][] = world.layout.clusters.labels.map(() => []);
  for (let i = 0; i < count; i++) members[world.layout.clusterOf[i]].push(i);
  let mostImported = -1;
  let largest = -1;
  for (let i = 0; i < count; i++) {
    if (mostImported < 0 || importedBy[i] > importedBy[mostImported]) mostImported = i;
    if (largest < 0 || nodes.sizes[i] > nodes.sizes[largest]) largest = i;
  }
  const shownDirectories: number[] = [];
  let largestDirectory = -1;
  for (let c = 0; c < world.clusterCount; c++) {
    if (!world.view.shown[c]) continue;
    shownDirectories.push(c);
    if (c !== world.view.root && (largestDirectory < 0 || world.view.files[c] > world.view.files[largestDirectory])) largestDirectory = c;
  }
  return { world, outOffsets, outTargets, inOffsets, inSources, members, shownDirectories, mostImported, largest, largestDirectory };
}

function fileCard(world: World, stats: Stats, i: number): StopCard {
  const { nodes } = world.graph;
  const { importsOf, importedBy } = world.adjacency;
  const kind = FILE_KIND_LABELS[FILE_KINDS[world.kinds[i]]];
  const directory = nodes.dirs[nodes.dirIndex[i]];
  const cluster = world.layout.clusterOf[i];
  const siblings = stats.members[cluster];
  const where = world.layout.clusters.labels[cluster] === '.' ? 'the root directory' : world.layout.clusters.labels[cluster];
  const imports = importsOf[i];
  const importers = importedBy[i];
  const size = nodes.sizes[i];
  const facts: string[] = [];
  const most = (of: ArrayLike<number>) => siblings.length >= 3 && siblings.every((s) => of[s] <= of[i]);

  if (i === stats.mostImported && importers >= 3) facts.push(`Imported by ${count(importers, 'file')}, more than any other file in the workspace`);
  else if (importers >= 2 && most(importedBy)) facts.push(`Imported by ${count(importers, 'file')}, the most in ${where}`);
  if (imports >= 3 && most(importsOf)) facts.push(`Imports ${count(imports, 'file')}, more than any other file in ${where}`);
  if (i === stats.largest) facts.push(`The largest file in the workspace, at ${formatBytes(size)}`);
  else if (most(nodes.sizes)) facts.push(`The largest file in ${where}, at ${formatBytes(size)}`);
  const reach = reachOf(world, stats, i);
  if (reach.files >= 10) facts.push(`Its imports reach ${count(reach.files, 'file')} across ${count(reach.directories, 'directory')}`);
  const from = new Set<number>();
  for (let k = stats.inOffsets[i]; k < stats.inOffsets[i + 1]; k++) from.add(world.layout.clusterOf[stats.inSources[k]]);
  from.delete(cluster);
  if (from.size >= 3) facts.push(`Imported from ${count(from.size, 'other directory')}`);
  if (importers === 0 && imports === 0) facts.push('On its own: nothing imports it, and it imports nothing');
  else if (importers === 0 && imports >= 3) facts.push(`An entry point: nothing imports it, and it imports ${count(imports, 'file')}`);
  if (siblings.length >= 4 && siblings.every((s) => s === i || world.kinds[s] !== world.kinds[i])) facts.push(`The only ${kind} file in ${where}`);
  if (facts.length === 0) {
    facts.push(`One of ${count(siblings.length, 'file')} in ${where}`);
    facts.push(`${formatBytes(size)}; imports ${count(imports, 'file')}, imported by ${imports === importers ? 'as many' : count(importers, 'file')}`);
  }
  return { kicker: directory === '.' ? kind : `${directory} · ${kind}`, title: nodes.names[i], facts: facts.slice(0, MAX_FACTS) };
}

function directoryCard(world: World, stats: Stats, c: number): StopCard {
  const labels = world.layout.clusters.labels;
  const label = labels[c];
  const files = world.view.files[c];
  const children = world.view.children[c].length;
  const facts: string[] = [];
  facts.push(children > 0 ? `${count(files, 'file')} in ${count(children, 'sub-directory')}` : count(files, 'file'));
  if (c === stats.largestDirectory && files >= 10) facts.push('The largest directory in the workspace');

  // The kind most of its files are, and the imports crossing its boundary either way.
  const within = (d: number) => label === '.' || labels[d] === label || labels[d].startsWith(`${label}/`);
  const kinds = new Uint32Array(FILE_KINDS.length);
  const { clusterOf } = world.layout;
  const { edges, nodes } = world.graph;
  for (let i = 0; i < nodes.count; i++) if (within(clusterOf[i])) kinds[world.kinds[i]]++;
  const kind = world.dominantKinds[c];
  const share = Math.round((100 * kinds[kind]) / Math.max(1, files));
  if (files >= 3 && share >= 60 && share < 100) facts.push(`${share}% ${FILE_KIND_LABELS[FILE_KINDS[kind]]}`);
  else if (files >= 3 && share === 100) facts.push(`All ${FILE_KIND_LABELS[FILE_KINDS[kind]]}`);
  let incoming = 0;
  let outgoing = 0;
  const from = new Set<number>();
  let mostImported = -1;
  for (let e = 0; e < edges.length; e += 2) {
    const a = within(clusterOf[edges[e]]);
    const b = within(clusterOf[edges[e + 1]]);
    if (b && !a) {
      incoming++;
      from.add(clusterOf[edges[e]]);
    } else if (a && !b) outgoing++;
    if (b && (mostImported < 0 || world.adjacency.importedBy[edges[e + 1]] > world.adjacency.importedBy[mostImported])) mostImported = edges[e + 1];
  }
  if (label !== '.' && files >= 2) {
    if (incoming === 0 && outgoing === 0) facts.push('An island: no import crosses its boundary');
    else if (incoming === 0) facts.push('Nothing outside imports from it');
    else if (outgoing === 0) facts.push(`Self-contained: nothing here imports from outside, while ${count(from.size, 'other directory')} import from it`);
    else facts.push(`Imported from outside ${count(incoming, 'time')}, by files in ${count(from.size, 'other directory')}`);
  }
  if (mostImported >= 0 && world.adjacency.importedBy[mostImported] >= 2) facts.push(`Its most imported file is ${nodes.names[mostImported]}, imported by ${count(world.adjacency.importedBy[mostImported], 'file')}`);
  const root = world.view.root;
  const title = c === root ? world.graph.root : world.view.name(c);
  const kicker = c === root ? 'The workspace' : `Directory · ${world.clusterName(world.view.viewParent[c] >= 0 ? world.view.viewParent[c] : root)}`;
  return { kicker, title, facts: facts.slice(0, MAX_FACTS) };
}

/** How many files `i`'s imports reach, following imports all the way, and in how many directories. */
function reachOf(world: World, stats: Stats, i: number): { files: number; directories: number } {
  const seen = new Uint8Array(world.graph.nodes.count);
  const directories = new Set<number>();
  const queue = [i];
  seen[i] = 1;
  let files = 0;
  while (queue.length > 0) {
    const at = queue.pop()!;
    for (let k = stats.outOffsets[at]; k < stats.outOffsets[at + 1]; k++) {
      const next = stats.outTargets[k];
      if (seen[next]) continue;
      seen[next] = 1;
      files++;
      directories.add(world.layout.clusterOf[next]);
      queue.push(next);
    }
  }
  return { files, directories: directories.size };
}

/** The lowest directory holding both `a` and `b` in the view tree (`a` itself when `b` is below it). */
function commonAncestor(viewParent: Int32Array, a: number, b: number): number {
  const above = new Set<number>();
  for (let at = a; at >= 0; at = viewParent[at]) above.add(at);
  for (let at = b; at >= 0; at = viewParent[at]) if (above.has(at)) return at;
  return a;
}

function findNode(world: World, id: string): number {
  const { nodes } = world.graph;
  for (let i = 0; i < nodes.count; i++) if (nodeId(nodes, i) === id) return i;
  return -1;
}

function count(n: number, noun: string): string {
  const plural = noun.endsWith('y') ? `${noun.slice(0, -1)}ies` : `${noun}s`;
  return `${n.toLocaleString('en-US')} ${n === 1 ? noun : plural}`;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
