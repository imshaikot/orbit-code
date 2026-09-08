// Extends a frozen nested bubble layout to the next version of the graph without laying anything out again.
//
// Files still in the graph keep their position, and bubbles (matched by label) keep centre and radius.
// A new file goes into its directory's bubble, near what it imports. A directory without a bubble gets
// one inside its deepest existing ancestor: in a spot a sibling emptied by this update when that fits,
// else at the free spot nearest what its files import. When there is no room, a bubble grows, and its
// parents with it, as long as nothing beside them is overlapped. Bubbles left without files are dropped.
// Pure and deterministic: the extension host runs it for live updates, and src/dev/hostSim.ts in the harness.

import { nodeId } from './columnar';
import { BUBBLE_GAP, BUBBLE_MARGIN, FILE_CLEARANCE, MAX_BUBBLES, SINGLE_FILE_PADDING, comparePaths, parentsOf } from './dirTree';
import { dirnameOf } from './languages';
import type { LayoutSnapshot, NodeColumns } from './protocol';
import { nodeRadius } from './visual';

/** How far inside its bubble a new file stays. */
const SHELL_INSET = 1;
/** Space a new file keeps from other files. */
const MIN_CLEARANCE = 0.3;
/** Slack counts only up to this, so of several free spots the one nearest the anchor wins. */
const SLACK_CAP = 0.9;
/** Bubbles with more direct files than this answer clearance queries from a grid. */
const GRID_MIN_FILES = 64;
const GRID_CELL = 4;
const RINGS = 4;
const RING_DIRECTIONS = 14;
const INTERIOR_CANDIDATES = 40;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export interface LayoutExtension {
  layout: LayoutSnapshot;
  /** Previous node index → next node index, -1 for removed files. */
  remap: Int32Array;
  /** Next node indices of new files. */
  added: Uint32Array;
  /** Previous node indices of removed files. */
  removed: Uint32Array;
}

interface Bubble {
  label: string;
  parent: number;
  x: number;
  y: number;
  z: number;
  r: number;
  /** Files anywhere inside, in the next graph. */
  members: number;
  /** Created by this extension. */
  fresh: boolean;
  /** Has a centre; bubbles not placed yet are no obstacle. */
  placed: boolean;
}

interface Spot {
  x: number;
  y: number;
  z: number;
  value: number;
}

interface Placement {
  x: number;
  y: number;
  z: number;
  /** Clear of everything around it. Otherwise it is the roomiest spot inside, overlapping something. */
  free: boolean;
}

/**
 * Undefined when `previous` does not describe `previousIds`; the caller then lays out from scratch. `renamed` maps a
 * new id to the previous id of a file Orbit renamed: within its directory it keeps its place and its node's state.
 */
export function extendLayout(
  previousIds: readonly string[],
  previous: LayoutSnapshot,
  next: { hash: string; nodes: NodeColumns; edges: Uint32Array },
  renamed?: ReadonlyMap<string, string>,
): LayoutExtension | undefined {
  const previousCount = previousIds.length;
  const { labels: previousLabels, centers: previousCenters, radii: previousRadii } = previous.clusters;
  const baseBubbles = previousLabels.length;
  if (previous.positions.length !== previousCount * 3 || previous.clusterOf.length !== previousCount) return undefined;
  if (previousCenters.length !== baseBubbles * 3 || previousRadii.length !== baseBubbles || previousLabels[0] !== '.') return undefined;
  for (let b = 1; b < baseBubbles; b++) if (comparePaths(previousLabels[b - 1], previousLabels[b]) >= 0) return undefined;

  const { nodes, edges } = next;
  const count = nodes.count;
  const before = new Map<string, number>();
  previousIds.forEach((id, i) => before.set(id, i));

  const parents = parentsOf(previousLabels);
  const bubbles: Bubble[] = previousLabels.map((label, b) => ({
    label,
    parent: parents[b],
    x: previousCenters[b * 3],
    y: previousCenters[b * 3 + 1],
    z: previousCenters[b * 3 + 2],
    r: previousRadii[b],
    members: 0,
    fresh: false,
    placed: true,
  }));
  const indexOf = new Map(previousLabels.map((label, b) => [label, b]));

  const remap = new Int32Array(previousCount).fill(-1);
  const positions = new Float32Array(count * 3);
  const clusterOf = new Int32Array(count);
  const isNew = new Uint8Array(count);
  const added: number[] = [];
  /** Renamed files that kept their place: new by id (so they pulse), but not placed again. */
  const renamedInPlace: number[] = [];
  const nextIds = renamed?.size ? new Set(Array.from({ length: count }, (_, i) => nodeId(nodes, i))) : undefined;
  for (let i = 0; i < count; i++) {
    const id = nodeId(nodes, i);
    let from = before.get(id);
    const oldId = from === undefined ? renamed?.get(id) : undefined;
    if (oldId !== undefined && !nextIds?.has(oldId) && dirnameOf(oldId) === dirnameOf(id)) {
      const old = before.get(oldId);
      if (old !== undefined && remap[old] < 0) {
        from = old;
        renamedInPlace.push(i);
      }
    }
    if (from === undefined) {
      isNew[i] = 1;
      added.push(i);
      continue;
    }
    if (previous.clusterOf[from] >= baseBubbles) return undefined;
    remap[from] = i;
    positions.set(previous.positions.subarray(from * 3, from * 3 + 3), i * 3);
    clusterOf[i] = previous.clusterOf[from];
  }
  const removed: number[] = [];
  remap.forEach((to, from) => {
    if (to < 0) removed.push(from);
  });

  // A new file's bubble is its directory's, created along with any missing ancestors while under MAX_BUBBLES.
  for (const i of added) {
    const missing: string[] = [];
    let dir = nodes.dirs[nodes.dirIndex[i]];
    while (!indexOf.has(dir)) {
      missing.push(dir);
      dir = dirnameOf(dir);
    }
    let b = indexOf.get(dir)!;
    for (let k = missing.length - 1; k >= 0 && bubbles.length < MAX_BUBBLES; k--) {
      bubbles.push({ label: missing[k], parent: b, x: 0, y: 0, z: 0, r: 0, members: 0, fresh: true, placed: false });
      b = bubbles.length - 1;
      indexOf.set(missing[k], b);
    }
    clusterOf[i] = b;
  }

  const space = new Space(bubbles, positions, nodes.sizes);
  const newDirect = new Uint32Array(bubbles.length);
  const largestNew = new Float32Array(bubbles.length);
  for (let i = 0; i < count; i++) {
    for (let b = clusterOf[i]; b >= 0; b = bubbles[b].parent) bubbles[b].members++;
    if (!isNew[i]) {
      space.settle(i, clusterOf[i]);
      continue;
    }
    newDirect[clusterOf[i]]++;
    for (let b = clusterOf[i]; b >= 0 && bubbles[b].fresh; b = bubbles[b].parent) largestNew[b] = Math.max(largestNew[b], nodeRadius(nodes.sizes[i]));
  }

  const neighbours = new Map<number, number[]>();
  for (let e = 0; e < edges.length; e += 2) {
    if (isNew[edges[e]]) push(neighbours, edges[e], edges[e + 1]);
    if (isNew[edges[e + 1]]) push(neighbours, edges[e + 1], edges[e]);
  }
  const within = (b: number, ancestor: number) => {
    for (; b >= 0; b = bubbles[b].parent) if (b === ancestor) return true;
    return false;
  };

  // Fresh bubbles: sized for their new files, children first (they were created after their parents)...
  for (let b = bubbles.length - 1; b >= baseBubbles; b--) {
    const bubble = bubbles[b];
    const kids = space.children[b];
    if (newDirect[b] === 0 && kids.length === 1) {
      bubble.r = bubbles[kids[0]].r;
      continue;
    }
    const estimate = bubble.members === 1 ? largestNew[b] + SINGLE_FILE_PADDING : SINGLE_FILE_PADDING + largestNew[b] + 1.9 * Math.cbrt(bubble.members);
    bubble.r = kids.reduce((r, kid) => Math.max(r, bubbles[kid].r + BUBBLE_MARGIN), estimate);
  }

  // ...then placed, parents first.
  const vacated = new Map<number, number[]>();
  bubbles.forEach((bubble, b) => {
    if (!bubble.fresh && bubble.members === 0 && b > 0) push(vacated, bubble.parent, b);
  });
  for (let b = baseBubbles; b < bubbles.length; b++) {
    const bubble = bubbles[b];
    const p = bubble.parent;
    const parent = bubbles[p];
    if (parent.fresh && newDirect[p] === 0 && space.children[p].length === 1) {
      Object.assign(bubble, { x: parent.x, y: parent.y, z: parent.z, r: Math.min(bubble.r, parent.r), placed: true });
      continue;
    }
    // A renamed directory stays put: an emptied sibling lends its spot when it is big enough.
    const slots = vacated.get(p) ?? [];
    const slot = slots.findIndex((s) => bubbles[s].r >= bubble.r && space.slack(p, bubbles[s].x, bubbles[s].y, bubbles[s].z, bubble.r, true) >= 0);
    if (slot >= 0) {
      const { x, y, z } = bubbles[slots[slot]];
      Object.assign(bubble, { x, y, z, placed: true });
      slots.splice(slot, 1);
      continue;
    }
    const anchor = { x: 0, y: 0, z: 0, n: 0 };
    for (const i of added) {
      if (!within(clusterOf[i], b)) continue;
      for (const j of neighbours.get(i) ?? []) {
        if (isNew[j] || !within(clusterOf[j], p)) continue;
        anchor.x += positions[j * 3];
        anchor.y += positions[j * 3 + 1];
        anchor.z += positions[j * 3 + 2];
        anchor.n++;
      }
    }
    const [ax, ay, az] = anchor.n > 0 ? [anchor.x / anchor.n, anchor.y / anchor.n, parent.z] : [parent.x, parent.y, parent.z];
    // Short of room, a smaller bubble beats one overlapping its siblings: its new files crowd inside it instead.
    const smallest = largestNew[b] + SINGLE_FILE_PADDING;
    let spot = space.place(p, bubble.r, true, ax, ay, az, hash01(bubble.label));
    while (!spot.free && bubble.r > smallest) {
      bubble.r = Math.max(smallest, bubble.r * 0.7);
      spot = space.place(p, bubble.r, true, ax, ay, az, hash01(bubble.label));
    }
    Object.assign(bubble, { x: spot.x, y: spot.y, z: spot.z, placed: true });
  }

  // New files: near their placed import neighbours in the same bubble, else near its other files, else its centre.
  for (const i of added) {
    const b = clusterOf[i];
    let ax = 0;
    let ay = 0;
    let az = 0;
    let n = 0;
    for (const j of neighbours.get(i) ?? []) {
      if (clusterOf[j] !== b || !space.isPlaced(j)) continue;
      ax += positions[j * 3];
      ay += positions[j * 3 + 1];
      az += positions[j * 3 + 2];
      n++;
    }
    if (n === 0) [ax, ay, az, n] = space.sumOf(b);
    if (n === 0) [ax, ay, az, n] = [bubbles[b].x, bubbles[b].y, bubbles[b].z, 1];
    const spot = space.place(b, nodeRadius(nodes.sizes[i]), false, ax / n, ay / n, az / n, hash01(nodeId(nodes, i)));
    positions[i * 3] = spot.x;
    positions[i * 3 + 1] = spot.y;
    positions[i * 3 + 2] = spot.z;
    space.settle(i, b);
  }

  const kept = bubbles.flatMap((bubble, b) => (b === 0 || bubble.members > 0 ? [b] : [])).sort((a, b) => comparePaths(bubbles[a].label, bubbles[b].label));
  const compact = new Int32Array(bubbles.length).fill(-1);
  kept.forEach((b, k) => (compact[b] = k));
  const centers = new Float32Array(kept.length * 3);
  const radii = new Float32Array(kept.length);
  kept.forEach((b, k) => {
    centers.set([bubbles[b].x, bubbles[b].y, bubbles[b].z], k * 3);
    radii[k] = bubbles[b].r;
  });
  const finalClusterOf = new Uint16Array(count);
  for (let i = 0; i < count; i++) finalClusterOf[i] = compact[clusterOf[i]];

  return {
    layout: { hash: next.hash, positions, clusterOf: finalClusterOf, clusters: { labels: kept.map((b) => bubbles[b].label), centers, radii } },
    remap,
    added: Uint32Array.from([...added, ...renamedInPlace]).sort(),
    removed: Uint32Array.from(removed),
  };
}

/** What is already placed inside each bubble, and how to find room there. */
class Space {
  readonly children: number[][];
  /** Placed files directly inside each bubble. */
  private readonly direct: number[][];
  private readonly sums: Float64Array;
  private readonly placed: Set<number> = new Set();
  private readonly grids = new Map<number, Map<number, number[]>>();

  constructor(
    private readonly bubbles: Bubble[],
    private readonly positions: Float32Array,
    private readonly sizes: Float32Array,
  ) {
    this.children = bubbles.map(() => []);
    bubbles.forEach((bubble, b) => {
      if (bubble.parent >= 0) this.children[bubble.parent].push(b);
    });
    this.direct = bubbles.map(() => []);
    this.sums = new Float64Array(bubbles.length * 3);
  }

  isPlaced(i: number): boolean {
    return this.placed.has(i);
  }

  /** Sum of the placed files' positions in bubble `b`, and how many there are. */
  sumOf(b: number): [number, number, number, number] {
    return [this.sums[b * 3], this.sums[b * 3 + 1], this.sums[b * 3 + 2], this.direct[b].length];
  }

  settle(i: number, b: number): void {
    const [x, y, z] = [this.positions[i * 3], this.positions[i * 3 + 1], this.positions[i * 3 + 2]];
    this.placed.add(i);
    this.direct[b].push(i);
    this.sums[b * 3] += x;
    this.sums[b * 3 + 1] += y;
    this.sums[b * 3 + 2] += z;
    const grid = this.grids.get(b);
    if (grid) push(grid, cellKey(x, y, z), i);
  }

  /**
   * Room around a file or bubble of radius `r` at (x, y, z) among what is placed directly in bubble `b`, beyond the
   * gap each pair needs, capped at SLACK_CAP. Negative means it would overlap something.
   */
  slack(b: number, x: number, y: number, z: number, r: number, bubble: boolean): number {
    let slack = SLACK_CAP;
    const fileGap = bubble ? FILE_CLEARANCE : MIN_CLEARANCE;
    const files = bubble || this.direct[b].length <= GRID_MIN_FILES ? this.direct[b] : this.nearbyFiles(b, x, y, z);
    for (const j of files) {
      const gap = Math.hypot(this.positions[j * 3] - x, this.positions[j * 3 + 1] - y, this.positions[j * 3 + 2] - z) - r - nodeRadius(this.sizes[j]);
      slack = Math.min(slack, gap - fileGap);
    }
    for (const c of this.children[b]) {
      const other = this.bubbles[c];
      if (!other.placed || other.members === 0) continue;
      slack = Math.min(slack, Math.hypot(other.x - x, other.y - y, other.z - z) - r - other.r - (bubble ? BUBBLE_GAP : FILE_CLEARANCE));
    }
    return slack;
  }

  /** Grows bubble `b` to `required`, and its parents as far as they must, unless that runs into anything beside them. */
  grow(b: number, required: number): boolean {
    const bubble = this.bubbles[b];
    if (bubble.r >= required) return true;
    if (bubble.parent < 0) {
      bubble.r = required;
      return true;
    }
    const parent = this.bubbles[bubble.parent];
    const placed = bubble.placed;
    bubble.placed = false; // not its own obstacle
    const free = this.slack(bubble.parent, bubble.x, bubble.y, bubble.z, required, true) >= 0;
    bubble.placed = placed;
    if (!free || !this.grow(bubble.parent, Math.hypot(bubble.x - parent.x, bubble.y - parent.y, bubble.z - parent.z) + required + BUBBLE_MARGIN)) return false;
    bubble.r = required;
    return true;
  }

  /**
   * The free spot for a file or bubble of radius `r` in bubble `b` nearest the anchor. With no room inside, the
   * bubble grows to take a spot just outside; failing that, the roomiest spot inside is used anyway.
   */
  place(b: number, r: number, bubble: boolean, ax: number, ay: number, az: number, seed: number): Placement {
    const home = this.bubbles[b];
    const inset = bubble ? BUBBLE_MARGIN : SHELL_INSET;
    let inside: Spot | undefined;
    let outside: Spot | undefined;
    const consider = (x: number, y: number, z: number) => {
      const slack = this.slack(b, x, y, z, r, bubble);
      const reach = Math.hypot(x - home.x, y - home.y, z - home.z) + r;
      if (reach + inset <= home.r) {
        if (!inside || slack > inside.value) inside = { x, y, z, value: slack };
      } else if (slack >= 0) {
        const needed = reach + BUBBLE_MARGIN;
        if (!outside || needed < outside.value) outside = { x, y, z, value: needed };
      }
    };
    // As the layout worker places them: bubbles on their parent's plane, files beside bubbles close to it, other files in 3D.
    const flatten = bubble ? 0 : this.children[b].some((c) => this.bubbles[c].placed && this.bubbles[c].members > 0) ? 0.3 : 1;
    const around = (k: number, n: number, turn: number): [number, number, number] => {
      if (bubble) return planar(k, n, turn);
      const [x, y, z] = direction(k, n, turn);
      return [x, y, z * flatten];
    };

    consider(ax, ay, az);
    const spacing = bubble ? BUBBLE_GAP : 1.3;
    for (let ring = 1; ring <= RINGS; ring++) {
      const distance = ring * (r + spacing);
      for (let k = 0; k < RING_DIRECTIONS; k++) {
        const [dx, dy, dz] = around(k, RING_DIRECTIONS, seed + ring * 0.37);
        consider(ax + dx * distance, ay + dy * distance, az + dz * distance);
      }
    }
    const depth = Math.max(0, home.r - inset - r);
    for (let k = 0; k < INTERIOR_CANDIDATES; k++) {
      const [dx, dy, dz] = around(k, INTERIOR_CANDIDATES, seed * 1.7);
      const distance = depth * Math.cbrt(fract(k * 0.618033988749895 + seed));
      consider(home.x + dx * distance, home.y + dy * distance, home.z + dz * distance);
    }
    // Just past the rim, for when the bubble has to grow.
    for (let ring = 0; ring < 3; ring++) {
      const distance = depth + (ring + 0.5) * (r + spacing);
      for (let k = 0; k < RING_DIRECTIONS; k++) {
        const [dx, dy, dz] = around(k, RING_DIRECTIONS, seed * 2.3 + ring * 0.21);
        consider(home.x + dx * distance, home.y + dy * distance, home.z + dz * distance);
      }
    }

    if (inside && inside.value >= 0) return { ...inside, free: true };
    if (outside && this.grow(b, outside.value)) return { ...outside, free: true };
    return { ...(inside ?? { x: home.x, y: home.y, z: home.z }), free: false };
  }

  private nearbyFiles(b: number, x: number, y: number, z: number): number[] {
    let grid = this.grids.get(b);
    if (!grid) {
      grid = new Map();
      for (const j of this.direct[b]) push(grid, cellKey(this.positions[j * 3], this.positions[j * 3 + 1], this.positions[j * 3 + 2]), j);
      this.grids.set(b, grid);
    }
    const gx = Math.floor(x / GRID_CELL);
    const gy = Math.floor(y / GRID_CELL);
    const gz = Math.floor(z / GRID_CELL);
    const files: number[] = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) files.push(...(grid.get(cellIndex(gx + dx, gy + dy, gz + dz)) ?? []));
      }
    }
    return files;
  }
}

/** Point k of n on a Fibonacci sphere, rotated by `turn` (0..1). */
function direction(k: number, n: number, turn: number): [number, number, number] {
  const y = 1 - (2 * (k + 0.5)) / n;
  const around = Math.sqrt(1 - y * y);
  const phi = k * GOLDEN_ANGLE + turn * Math.PI * 2;
  return [Math.cos(phi) * around, y, Math.sin(phi) * around];
}

/** Point k of n on a circle in the z = 0 plane, rotated by `turn` (0..1). */
function planar(k: number, n: number, turn: number): [number, number, number] {
  const phi = ((k + turn) / n) * Math.PI * 2;
  return [Math.cos(phi), Math.sin(phi), 0];
}

function cellKey(x: number, y: number, z: number): number {
  return cellIndex(Math.floor(x / GRID_CELL), Math.floor(y / GRID_CELL), Math.floor(z / GRID_CELL));
}

function cellIndex(gx: number, gy: number, gz: number): number {
  return ((gx + 32768) * 65536 + (gy + 32768)) * 65536 + (gz + 32768);
}

function push<K>(map: Map<K, number[]>, key: K, value: number): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function fract(value: number): number {
  return value - Math.floor(value);
}

/** FNV-1a, 0..1. */
function hash01(text: string): number {
  let hash = 0x811c9dc5;
  for (let k = 0; k < text.length; k++) {
    hash ^= text.charCodeAt(k);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 4294967296;
}
