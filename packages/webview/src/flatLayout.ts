import { nodeId } from '@orbit-code/graph/columnar';
import { extensionOf } from '@orbit-code/graph/languages';
import type { GraphContent } from '@orbit-code/protocol';

// The Flat view's layout: every file on an orbit round the workspace's core. Files are grouped by project (a directory
// with a manifest) or top-level directory, and each group rides one arc of an orbit, its files in path order along it,
// so a directory's files sit together. Orbits are concentric rings, each tilted its own way, filled from the inside out
// with the smallest groups first, several groups to an orbit, so the disc stays dense. Computed in the page from the
// graph alone. Across a live update every kept file keeps its slot and a new file takes the free slot nearest its
// siblings; a group whose arc runs out of room moves to an orbit of its own outside the others.

/** Centre-to-centre spacing of neighbouring files along a lane, and between the lanes of one orbit. */
const SLOT_ARC = 6.6;
const LANE_GAP = 6;
/** Clear space between two orbits' bands, and the room kept round the core. */
const RING_GAP = 7;
const CORE_CLEAR = 26;
/** Slots per file, so files a live update adds find room beside their siblings. */
const HEADROOM = 1.25;
/** Columns left empty at the end of each arc, so neighbouring groups read apart. */
export const ARC_GAP = 2;
const MAX_LANES = 8;
/** Largest tilt of an orbit's plane, in radians. */
const MAX_TILT = 0.2;
const MAX_GROUPS = 48;
/** While there are fewer groups than this, a group holding this share of every file splits by its next directory. */
const FEW_GROUPS = 6;
const DOMINANT = 0.4;
/** How much of the switch between views a file may wait before it sets off, so the files leave in a wave. */
export const MORPH_STAGGER = 0.35;
/** The core's radius. */
export const CORE_RADIUS = CORE_CLEAR * 0.38;

/** Files that make their directory a project of its own. */
const MANIFESTS = new Set([
  'package.json', 'deno.json', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'setup.py', 'pom.xml', 'build.gradle', 'build.gradle.kts',
  'composer.json', 'pubspec.yaml', 'Gemfile', 'mix.exs', 'Package.swift', 'elm.json', 'dune-project', 'build.zig',
]);
const MANIFEST_EXTENSIONS = new Set(['.csproj', '.fsproj', '.vbproj', '.cabal', '.gemspec']);

type Vec3 = [number, number, number];

/** An orbit: a band of `lanes` rings of `columns` slot columns each, round the core. */
export interface Ring {
  radius: number;
  lanes: number;
  columns: number;
  /** The plane: `u` and `w` span it, `normal` is square to it. */
  u: Vec3;
  w: Vec3;
  normal: Vec3;
  /** Angle of column 0. */
  phase: number;
}

/** A group's stretch of an orbit: columns `start` to `start + columns`, the last ARC_GAP of them kept empty. */
export interface Arc {
  /** Directories whose files ride it: one, or several for the arc gathering the smallest groups. "." holds root files only. */
  keys: string[];
  label: string;
  ring: number;
  start: number;
  columns: number;
  /** Files on it. */
  count: number;
}

export interface FlatLayout {
  /** xyz per file. */
  positions: Float32Array;
  /** Sphere radius per file. */
  radii: Float32Array;
  /** Morph delay per file, 0 to MORPH_STAGGER, from its id. */
  delays: Float32Array;
  arcOf: Uint16Array;
  /** Per file: column × lanes + lane on its arc's ring. */
  slotOf: Uint32Array;
  rings: Ring[];
  arcs: Arc[];
  /** A sphere round the core holding every file. */
  radius: number;
}

/** A file's sphere radius in the Flat view: larger than in the Nested one, to carry its icon. */
export function flatRadius(bytes: number): number {
  return 1.35 + 0.48 * Math.log10(1 + bytes / 1024);
}

/** Half the width of an orbit's band, a file's radius included. */
export function halfBand(ring: Pick<Ring, 'lanes'>): number {
  return ((ring.lanes - 1) / 2) * LANE_GAP + 3.4;
}

/** The point at `column` (fractional) and `lane` of `ring`; odd lanes sit half a column along, packed like a honeycomb. */
export function ringPoint(ring: Ring, column: number, lane: number, out: Float32Array | number[], at = 0): void {
  const angle = ring.phase + (Math.PI * 2 * (column + (lane % 2) * 0.5)) / ring.columns;
  const r = ring.radius + (lane - (ring.lanes - 1) / 2) * LANE_GAP;
  const c = Math.cos(angle) * r;
  const s = Math.sin(angle) * r;
  out[at] = c * ring.u[0] + s * ring.w[0];
  out[at + 1] = c * ring.u[1] + s * ring.w[1];
  out[at + 2] = c * ring.u[2] + s * ring.w[2];
}

/**
 * Lays every file of `graph` on its orbit. With `previous` (the layout of the graph a live update replaced, and how its
 * node indices map to these), kept files keep their slots, and orbits and arcs their geometry.
 */
export function flatLayout(graph: GraphContent, previous?: { layout: FlatLayout; remap: Int32Array }): FlatLayout {
  const { nodes } = graph;
  const count = nodes.count;
  const ids = Array.from({ length: count }, (_, i) => nodeId(nodes, i));
  const dirs = Array.from({ length: count }, (_, i) => nodes.dirs[nodes.dirIndex[i]]);
  const arcOf = new Uint16Array(count);
  const slotOf = new Uint32Array(count);
  const { rings, arcs } = previous ? extend(graph.root, ids, dirs, previous.layout, previous.remap, arcOf, slotOf) : fresh(graph, ids, dirs, arcOf, slotOf);

  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const ring = rings[arcs[arcOf[i]].ring];
    ringPoint(ring, Math.floor(slotOf[i] / ring.lanes), slotOf[i] % ring.lanes, positions, i * 3);
  }
  return {
    positions,
    radii: Float32Array.from(nodes.sizes, flatRadius),
    delays: Float32Array.from(ids, (id) => hash01(id) * MORPH_STAGGER),
    arcOf,
    slotOf,
    rings,
    arcs,
    radius: outerEdge(rings),
  };
}

/** Groups, orbits and arcs from scratch: the smallest groups innermost, as many to an orbit as fit round it. */
function fresh(graph: GraphContent, ids: readonly string[], dirs: readonly string[], arcOf: Uint16Array, slotOf: Uint32Array): { rings: Ring[]; arcs: Arc[] } {
  const groups = groupFiles(graph, dirs);
  const rings: Ring[] = [];
  const arcs: Arc[] = [];
  for (let g = 0; g < groups.length; ) {
    const ring = newRing(outerEdge(rings), groups[g].members.length, groups[g].keys[0]);
    const riding: Group[] = [];
    let used = 0;
    while (g < groups.length) {
      const need = arcColumns(groups[g].members.length, ring.lanes);
      if (riding.length > 0 && used + need > ring.columns) break;
      riding.push(groups[g++]);
      used += need;
    }
    // Neighbours on an orbit in path order, the spare columns shared out as room between them.
    riding.sort((a, b) => compare(a.keys[0], b.keys[0]));
    const spare = ring.columns - used;
    let start = 0;
    riding.forEach((group, k) => {
      const share = Math.floor(spare / riding.length) + (k < spare % riding.length ? 1 : 0);
      const arc: Arc = { keys: group.keys, label: labelOf(group.keys, graph.root), ring: rings.length, start, columns: arcColumns(group.members.length, ring.lanes) + share, count: 0 };
      place(arc, ring, arcs.length, group.members, ids, arcOf, slotOf);
      arcs.push(arc);
      start += arc.columns;
    });
    rings.push(ring);
  }
  countFiles(arcs, arcOf);
  return { rings, arcs };
}

/** Keeps every surviving file's arc and slot, and finds free slots for new files beside their siblings. */
function extend(
  root: string,
  ids: readonly string[],
  dirs: readonly string[],
  previous: FlatLayout,
  remap: Int32Array,
  arcOf: Uint16Array,
  slotOf: Uint32Array,
): { rings: Ring[]; arcs: Arc[] } {
  const count = ids.length;
  const rings = previous.rings.map((ring) => ({ ...ring }));
  const arcs = previous.arcs.map((arc) => ({ ...arc, keys: [...arc.keys] }));
  const taken = rings.map(() => new Set<number>());
  const oldOf = new Int32Array(count).fill(-1);
  remap.forEach((to, from) => {
    if (to >= 0 && to < count) oldOf[to] = from;
  });

  const kept = arcs.map((): number[] => []);
  const newcomers: number[] = [];
  for (let i = 0; i < count; i++) {
    const old = oldOf[i];
    const arc = old >= 0 ? previous.arcOf[old] : -1;
    if (arc < 0 || taken[arcs[arc].ring].has(previous.slotOf[old])) {
      newcomers.push(i);
      continue;
    }
    arcOf[i] = arc;
    slotOf[i] = previous.slotOf[old];
    taken[arcs[arc].ring].add(slotOf[i]);
    kept[arc].push(i);
  }
  for (const list of kept) list.sort((a, b) => compare(ids[a], ids[b]));
  newcomers.sort((a, b) => compare(ids[a], ids[b]));

  const created = new Map<string, number[]>();
  const full = new Map<number, number[]>();
  for (const node of newcomers) {
    const arc = arcFor(arcs, dirs[node]);
    if (arc < 0) {
      push(created, newKey(arcs, dirs[node]), node);
      continue;
    }
    const moving = full.get(arc);
    if (moving) {
      moving.push(node);
      continue;
    }
    const ring = rings[arcs[arc].ring];
    const slot = freeSlot(ring, arcs[arc], taken[arcs[arc].ring], preferredSlot(ring, arcs[arc], kept[arc], ids, ids[node], slotOf));
    if (slot < 0) {
      // Out of room: the whole group moves out, and its slots here come free.
      for (const file of kept[arc]) taken[arcs[arc].ring].delete(slotOf[file]);
      full.set(arc, [...kept[arc], node]);
      continue;
    }
    arcOf[node] = arc;
    slotOf[node] = slot;
    taken[arcs[arc].ring].add(slot);
  }

  // A group out of room, and each new group, gets an orbit of its own outside the others.
  for (const [arc, members] of full) {
    const ring = newRing(outerEdge(rings), members.length, arcs[arc].keys[0]);
    Object.assign(arcs[arc], { ring: rings.length, start: 0, columns: ring.columns });
    rings.push(ring);
    place(arcs[arc], ring, arc, members, ids, arcOf, slotOf);
  }
  for (const [key, members] of created) {
    const ring = newRing(outerEdge(rings), members.length, key);
    const arc: Arc = { keys: [key], label: labelOf([key], root), ring: rings.length, start: 0, columns: ring.columns, count: 0 };
    rings.push(ring);
    arcs.push(arc);
    place(arc, ring, arcs.length - 1, members, ids, arcOf, slotOf);
  }
  countFiles(arcs, arcOf);

  // Arcs left empty go, and so do orbits left without an arc; indices close up.
  const ringIndex = new Int32Array(rings.length).fill(-1);
  const keptRings: Ring[] = [];
  const arcIndex = new Int32Array(arcs.length).fill(-1);
  const keptArcs: Arc[] = [];
  arcs.forEach((arc, k) => {
    if (arc.count === 0) return;
    if (ringIndex[arc.ring] < 0) {
      ringIndex[arc.ring] = keptRings.length;
      keptRings.push(rings[arc.ring]);
    }
    arcIndex[k] = keptArcs.length;
    keptArcs.push({ ...arc, ring: ringIndex[arc.ring] });
  });
  for (let i = 0; i < count; i++) arcOf[i] = arcIndex[arcOf[i]];
  return { rings: keptRings, arcs: keptArcs };
}

/** Columns a group of `files` takes on an orbit of `lanes`, its empty end included. */
function arcColumns(files: number, lanes: number): number {
  return Math.ceil((files * HEADROOM) / lanes) + ARC_GAP;
}

/** Spreads `members` along `arc` (index `index`) in path order. */
function place(arc: Arc, ring: Ring, index: number, members: number[], ids: readonly string[], arcOf: Uint16Array, slotOf: Uint32Array): void {
  const capacity = (arc.columns - ARC_GAP) * ring.lanes;
  members.sort((a, b) => compare(ids[a], ids[b]));
  members.forEach((node, k) => {
    arcOf[node] = index;
    slotOf[node] = arc.start * ring.lanes + Math.floor((k * capacity) / members.length);
  });
}

function countFiles(arcs: Arc[], arcOf: Uint16Array): void {
  for (const arc of arcs) arc.count = 0;
  for (const arc of arcOf) arcs[arc].count++;
}

/** The next orbit out from `inside`: as few lanes as let a group of `files` fit round it, tilted and turned by `seed`. */
function newRing(inside: number, files: number, seed: string): Ring {
  let lanes = 1;
  let radius = 0;
  let columns = 0;
  for (; ; lanes++) {
    radius = inside + RING_GAP + halfBand({ lanes });
    columns = Math.floor((Math.PI * 2 * (radius - ((lanes - 1) / 2) * LANE_GAP)) / SLOT_ARC);
    if (columns >= arcColumns(files, lanes) || lanes === MAX_LANES) break;
  }
  const need = arcColumns(files, lanes);
  if (columns < need) {
    columns = need;
    radius = (columns * SLOT_ARC) / (Math.PI * 2) + ((lanes - 1) / 2) * LANE_GAP;
  }
  const node = hash01(`${seed} node`) * Math.PI * 2;
  const tilt = (hash01(`${seed} tilt`) * 2 - 1) * MAX_TILT;
  const [cn, sn, ct, st] = [Math.cos(node), Math.sin(node), Math.cos(tilt), Math.sin(tilt)];
  return { radius, lanes, columns, u: [cn, 0, sn], w: [-sn * ct, -st, cn * ct], normal: [-sn * st, ct, cn * st], phase: hash01(`${seed} phase`) * Math.PI * 2 };
}

function outerEdge(rings: readonly Ring[]): number {
  return rings.reduce((max, ring) => Math.max(max, ring.radius + halfBand(ring)), CORE_CLEAR);
}

/** The arc whose key is the deepest directory holding `dir`, or -1. */
function arcFor(arcs: readonly Arc[], dir: string): number {
  let best = -1;
  let depth = -1;
  arcs.forEach((arc, k) => {
    for (const key of arc.keys) {
      const within = key === '.' ? dir === '.' : dir === key || dir.startsWith(`${key}/`);
      const d = key === '.' ? 0 : key.split('/').length;
      if (within && d > depth) [best, depth] = [k, d];
    }
  });
  return best;
}

/** The key of a new group for `dir`: its shortest directory that no arc's key lies inside of. */
function newKey(arcs: readonly Arc[], dir: string): string {
  if (dir === '.') return '.';
  const segments = dir.split('/');
  for (let n = 1; n < segments.length; n++) {
    const prefix = segments.slice(0, n).join('/');
    if (!arcs.some((arc) => arc.keys.some((key) => key.startsWith(`${prefix}/`)))) return prefix;
  }
  return dir;
}

/** The slot after the kept file just before `id` in path order, or before the first one. */
function preferredSlot(ring: Ring, arc: Arc, kept: readonly number[], ids: readonly string[], id: string, slotOf: Uint32Array): number {
  if (kept.length === 0) return arc.start * ring.lanes;
  let low = 0;
  let high = kept.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (compare(ids[kept[mid]], id) < 0) low = mid + 1;
    else high = mid;
  }
  return low > 0 ? slotOf[kept[low - 1]] + 1 : slotOf[kept[0]] - 1;
}

/** The free slot of `arc` nearest `preferred`, or -1 when the arc is full. */
function freeSlot(ring: Ring, arc: Arc, taken: ReadonlySet<number>, preferred: number): number {
  const first = arc.start * ring.lanes;
  const capacity = (arc.columns - ARC_GAP) * ring.lanes;
  const local = Math.min(capacity - 1, Math.max(0, preferred - first));
  for (let d = 0; d < capacity; d++) {
    if (local + d < capacity && !taken.has(first + local + d)) return first + local + d;
    if (local - d >= 0 && !taken.has(first + local - d)) return first + local - d;
  }
  return -1;
}

interface Group {
  keys: string[];
  members: number[];
}

/** Files by project (the deepest directory holding a manifest), else by top-level directory; smallest group first. */
function groupFiles(graph: GraphContent, dirs: readonly string[]): Group[] {
  const { nodes } = graph;
  const roots = new Set<string>();
  for (let i = 0; i < nodes.count; i++) {
    const name = nodes.names[i];
    if (MANIFESTS.has(name) || MANIFEST_EXTENSIONS.has(extensionOf(name))) roots.add(dirs[i]);
  }
  const keyOf = (dir: string): string => {
    for (let at = dir; at !== '.'; at = parentOf(at)) if (roots.has(at)) return at;
    // The workspace's own project, or none: its top-level directories each ride an arc of their own.
    return dir === '.' ? '.' : firstSegment(dir);
  };
  const byKey = new Map<string, number[]>();
  for (let i = 0; i < nodes.count; i++) push(byKey, keyOf(dirs[i]), i);

  // One group holding most of the files says little: split it by its next directory, while there are few.
  const whole = new Set<string>();
  for (let pass = 0; pass < 8 && byKey.size < FEW_GROUPS; pass++) {
    let largest: string | undefined;
    for (const [key, members] of byKey) {
      if (whole.has(key) || members.length < Math.max(24, DOMINANT * nodes.count)) continue;
      if (largest === undefined || members.length > byKey.get(largest)!.length) largest = key;
    }
    if (largest === undefined) break;
    const split = new Map<string, number[]>();
    for (const node of byKey.get(largest)!) {
      const dir = dirs[node];
      push(split, dir === largest ? largest : `${largest}/${firstSegment(dir.slice(largest.length + 1))}`, node);
    }
    whole.add(largest);
    if (split.size < 2) continue;
    byKey.delete(largest);
    for (const [key, members] of split) byKey.set(key, members);
  }

  let groups: Group[] = [...byKey].map(([key, members]) => ({ keys: [key], members }));
  if (groups.length > MAX_GROUPS) {
    groups.sort((a, b) => b.members.length - a.members.length || compare(a.keys[0], b.keys[0]));
    const rest = groups.slice(MAX_GROUPS - 1);
    groups = [...groups.slice(0, MAX_GROUPS - 1), { keys: rest.flatMap((group) => group.keys), members: rest.flatMap((group) => group.members) }];
  }
  return groups.sort((a, b) => a.members.length - b.members.length || compare(a.keys[0], b.keys[0]));
}

function labelOf(keys: readonly string[], root: string): string {
  if (keys.length > 1) return 'other directories';
  return keys[0] === '.' ? `${root} (root)` : keys[0];
}

function push<K>(map: Map<K, number[]>, key: K, value: number): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function parentOf(dir: string): string {
  const slash = dir.lastIndexOf('/');
  return slash < 0 ? '.' : dir.slice(0, slash);
}

function firstSegment(dir: string): string {
  const slash = dir.indexOf('/');
  return slash < 0 ? dir : dir.slice(0, slash);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** FNV-1a, as a number in [0, 1). */
function hash01(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 4294967296;
}
