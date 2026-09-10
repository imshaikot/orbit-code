// Nested bubble layout, computed once and frozen.
//
// Bottom-up, each directory's contents (its own files, and its sub-directory bubbles already laid
// out) are placed by one small force simulation, and the bubble's radius is whatever encloses them.
// Top-down, those local offsets become world positions. Files spread in 3D; bubbles are held near
// their level's z = 0 plane, so a directory's sub-directories read side by side. An import pulls at
// the one level where it is drawn: between the two children of the deepest bubble holding both ends.
// Fixed tick counts, no timers, deterministic seed. Pure: runs in the layout worker.

import { type SimulationLink, type SimulationNode, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, forceZ } from 'd3-force-3d';
import { BUBBLE_GAP, BUBBLE_MARGIN, FILE_CLEARANCE, SINGLE_FILE_PADDING, bubbleLabels, bubbleOf, parentsOf } from '../../shared/dirTree';
import type { LayoutRequest, LayoutResponse, LayoutSnapshot } from '../../shared/protocol';
import { nodeRadius } from '../../shared/visual';

interface Body extends SimulationNode {
  r: number;
  /** A sub-directory bubble, or else a file. */
  bubble: boolean;
}

interface WeightedLink extends SimulationLink<Body> {
  weight: number;
}

const SLOT_KEY = 4294967296;

export function computeNestedLayout({ hash, nodes, edges }: LayoutRequest, emit: (message: LayoutResponse) => void): LayoutSnapshot {
  const random = lcg(0x0b17);
  const count = nodes.count;
  const labels = bubbleLabels(nodes.dirs);
  const bubbles = labels.length;
  const parent = parentsOf(labels);
  const indexOf = new Map(labels.map((label, b) => [label, b]));
  const bubbleOfDir = nodes.dirs.map((dir) => bubbleOf(dir, indexOf));

  const clusterOf = new Uint16Array(count);
  const files: number[][] = labels.map(() => []);
  const children: number[][] = labels.map(() => []);
  const depth = new Uint16Array(bubbles);
  for (let b = 1; b < bubbles; b++) {
    children[parent[b]].push(b);
    depth[b] = depth[parent[b]] + 1;
  }
  for (let i = 0; i < count; i++) {
    const b = bubbleOfDir[nodes.dirIndex[i]];
    clusterOf[i] = b;
    files[b].push(i);
  }

  // A bubble's bodies: its sub-directories, then its files. slot = position in that list.
  const slotOfBubble = new Uint32Array(bubbles);
  for (const list of children) list.forEach((child, k) => (slotOfBubble[child] = k));
  const slotOfFile = new Uint32Array(count);
  files.forEach((list, b) => list.forEach((node, k) => (slotOfFile[node] = children[b].length + k)));

  // Import weight between two bodies of the same bubble: bubble → (low slot, high slot) → weight.
  const weights = new Map<number, Map<number, number>>();
  for (let e = 0; e < edges.length; e += 2) {
    let a = clusterOf[edges[e]];
    let b = clusterOf[edges[e + 1]];
    let sa = slotOfFile[edges[e]];
    let sb = slotOfFile[edges[e + 1]];
    while (depth[a] > depth[b]) [sa, a] = [slotOfBubble[a], parent[a]];
    while (depth[b] > depth[a]) [sb, b] = [slotOfBubble[b], parent[b]];
    while (a !== b) {
      [sa, a] = [slotOfBubble[a], parent[a]];
      [sb, b] = [slotOfBubble[b], parent[b]];
    }
    if (sa === sb) continue;
    let level = weights.get(a);
    if (!level) weights.set(a, (level = new Map()));
    const key = Math.min(sa, sb) * SLOT_KEY + Math.max(sa, sb);
    level.set(key, (level.get(key) ?? 0) + 1);
  }

  const radii = new Float32Array(bubbles);
  /** Bubble centre relative to its parent's centre. */
  const local = new Float32Array(bubbles * 3);
  /** Relative to the file's bubble centre until the end. */
  const positions = new Float32Array(count * 3);
  const every = Math.max(1, Math.ceil(bubbles / 60));
  // Canonical order puts children after their parent, so walking backwards lays children out first.
  for (let b = bubbles - 1; b >= 0; b--) {
    radii[b] = layoutBubble(children[b], files[b], weights.get(b), radii, local, positions, nodes.sizes, random);
    const done = bubbles - b;
    if (done % every === 0 || done === bubbles) emit({ type: 'progress', stage: 'files', done, total: bubbles });
  }

  const centers = new Float32Array(bubbles * 3);
  for (let b = 1; b < bubbles; b++) {
    for (let k = 0; k < 3; k++) centers[b * 3 + k] = centers[parent[b] * 3 + k] + local[b * 3 + k];
  }
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < 3; k++) positions[i * 3 + k] += centers[clusterOf[i] * 3 + k];
  }
  emit({ type: 'progress', stage: 'clusters', done: bubbles, total: bubbles });

  return { hash, positions, clusterOf, clusters: { labels, centers, radii } };
}

/** Lays out one bubble's contents around its centre and returns the bubble's radius. */
function layoutBubble(
  children: readonly number[],
  files: readonly number[],
  weights: Map<number, number> | undefined,
  radii: Float32Array,
  local: Float32Array,
  positions: Float32Array,
  sizes: Float32Array,
  random: () => number,
): number {
  if (children.length === 0 && files.length === 0) return SINGLE_FILE_PADDING;
  // A directory holding only one sub-directory shares its bubble: the view skips straight through it.
  if (files.length === 0 && children.length === 1) return radii[children[0]];
  if (children.length === 0 && files.length === 1) return nodeRadius(sizes[files[0]]) + SINGLE_FILE_PADDING;

  const bodies: Body[] = [
    ...children.map((child) => ({ r: radii[child], bubble: true })),
    ...files.map((node) => ({ r: nodeRadius(sizes[node]), bubble: false })),
  ];
  const links: WeightedLink[] = [...(weights ?? [])].map(([key, weight]) => ({ source: Math.floor(key / SLOT_KEY), target: key % SLOT_KEY, weight }));
  const radius = settle(bodies, links, random);
  children.forEach((child, k) => local.set([bodies[k].x!, bodies[k].y!, bodies[k].z!], child * 3));
  files.forEach((node, k) => {
    const body = bodies[children.length + k];
    positions.set([body.x!, body.y!, body.z!], node * 3);
  });
  return radius + BUBBLE_MARGIN;
}

/** Runs the simulation for one bubble's bodies, centres them, and returns the radius that encloses them. */
function settle(bodies: Body[], links: WeightedLink[], random: () => number): number {
  const n = bodies.length;
  const spread = 1.3 * Math.cbrt(bodies.reduce((sum, body) => sum + body.r ** 3, 0)) + 2;
  const golden = Math.PI * (3 - Math.sqrt(5));
  const hasBubbles = bodies.some((body) => body.bubble);
  // Beside bubbles, files keep close to the plane too, so none seems to sit inside a bubble it only passes in front of.
  const depth = hasBubbles ? 0.3 : 1;
  bodies.forEach((body, k) => {
    const y = 1 - (2 * (k + 0.5)) / n;
    const ring = Math.sqrt(1 - y * y);
    const distance = spread * Math.cbrt((k + 0.5) / n);
    body.x = Math.cos(k * golden) * ring * distance + (random() - 0.5) * 2;
    body.y = y * distance + (random() - 0.5) * 2;
    body.z = body.bubble ? 0 : (Math.sin(k * golden) * ring * distance + (random() - 0.5) * 2) * depth;
  });

  const largest = bodies.reduce((max, body) => Math.max(max, body.r), 0);
  const heaviest = Math.log1p(links.reduce((max, link) => Math.max(max, link.weight), 1));
  // Fewer ticks for big levels, with alpha decay matched so each run still cools fully.
  const ticks = n > 600 ? 120 : n > 150 ? 160 : 220;
  forceSimulation(bodies, 3)
    .randomSource(random)
    .alphaDecay(1 - Math.pow(0.001, 1 / ticks))
    .stop()
    .force('charge', forceManyBody<Body>().strength((body) => -(4 + 3 * body.r)).theta(0.9).distanceMax(Math.max(45, largest * 4)))
    .force(
      'link',
      forceLink<Body, WeightedLink>(links)
        .distance((link) => {
          const a = link.source as Body;
          const b = link.target as Body;
          return a.r + b.r + (a.bubble || b.bubble ? BUBBLE_GAP * 1.5 : 2.4);
        })
        .strength((link) => ((link.source as Body).bubble || (link.target as Body).bubble ? 0.04 + (0.3 * Math.log1p(link.weight)) / heaviest : 0.2)),
    )
    .force('collide', forceCollide<Body>((body) => body.r + (body.bubble ? BUBBLE_GAP / 2 : 0.45)).iterations(hasBubbles ? 3 : 1))
    .force('x', forceX<Body>(0).strength((body) => (body.bubble ? 0.1 : 0.07)))
    .force('y', forceY<Body>(0).strength((body) => (body.bubble ? 0.1 : 0.07)))
    .force('z', forceZ<Body>(0).strength((body) => (body.bubble ? 1 : hasBubbles ? 0.35 : 0.07)))
    .tick(ticks);

  if (hasBubbles) {
    // Bubbles sit exactly on the plane (d3-force-3d jiggles coincident z), so from the front none hides another.
    for (const body of bodies) if (body.bubble) body.z = 0;
    separate(bodies, random);
  }
  return enclose(bodies);
}

/**
 * Forces leave overlaps. Push every bubble clear of its sibling bubbles, measured across the plane so they don't
 * overlap on screen either, and of the files beside it, in 3D. The lighter body moves more.
 */
function separate(bodies: Body[], random: () => number): void {
  const bubbles = bodies.flatMap((body, k) => (body.bubble ? [k] : []));
  for (let pass = 0; pass < 80; pass++) {
    let moved = false;
    for (const i of bubbles) {
      const a = bodies[i];
      for (let j = 0; j < bodies.length; j++) {
        const b = bodies[j];
        if (j === i || (b.bubble && j < i)) continue;
        let dx = b.x! - a.x!;
        let dy = b.y! - a.y!;
        let dz = b.bubble ? 0 : b.z! - a.z!;
        let distance = Math.hypot(dx, dy, dz);
        const minimum = a.r + b.r + (b.bubble ? BUBBLE_GAP : FILE_CLEARANCE);
        if (distance >= minimum) continue;
        if (distance < 1e-6) {
          dx = random() - 0.5;
          dy = random() - 0.5;
          dz = 0;
          distance = Math.hypot(dx, dy) || 1;
        }
        const massA = a.r ** 3;
        const massB = b.r ** 3;
        const push = (minimum - distance) / distance / (massA + massB);
        a.x! -= dx * push * massB;
        a.y! -= dy * push * massB;
        a.z! -= dz * push * massB;
        b.x! += dx * push * massA;
        b.y! += dy * push * massA;
        b.z! += dz * push * massA;
        moved = true;
      }
    }
    if (!moved) break;
  }
}

/** Moves the bodies so (roughly) their smallest enclosing sphere is centred on the origin, and returns its radius. */
function enclose(bodies: Body[]): number {
  const reach = (x: number, y: number, z: number) => {
    let max = 0;
    for (const body of bodies) max = Math.max(max, Math.hypot(body.x! - x, body.y! - y, body.z! - z) + body.r);
    return max;
  };
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  for (const body of bodies) {
    [body.x!, body.y!, body.z!].forEach((value, k) => {
      low[k] = Math.min(low[k], value - body.r);
      high[k] = Math.max(high[k], value + body.r);
    });
  }
  let cx = (low[0] + high[0]) / 2;
  let cy = (low[1] + high[1]) / 2;
  let cz = (low[2] + high[2]) / 2;
  let best = reach(cx, cy, cz);
  // Step toward whichever body reaches farthest while that shrinks the sphere; halve the step when it doesn't.
  let step = best / 4;
  for (let k = 0; k < 60 && step > 1e-3; k++) {
    let far = bodies[0];
    let farthest = -1;
    for (const body of bodies) {
      const d = Math.hypot(body.x! - cx, body.y! - cy, body.z! - cz) + body.r;
      if (d > farthest) [far, farthest] = [body, d];
    }
    const d = Math.hypot(far.x! - cx, far.y! - cy, far.z! - cz) || 1;
    const nx = cx + ((far.x! - cx) / d) * step;
    const ny = cy + ((far.y! - cy) / d) * step;
    const nz = cz + ((far.z! - cz) / d) * step;
    const candidate = reach(nx, ny, nz);
    if (candidate < best) [cx, cy, cz, best] = [nx, ny, nz, candidate];
    else step /= 2;
  }
  for (const body of bodies) {
    body.x! -= cx;
    body.y! -= cy;
    body.z! -= cz;
  }
  return best;
}

/** Same LCG d3-force uses internally; deterministic layouts for a given graph. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => (state = (1664525 * state + 1013904223) % 4294967296) / 4294967296;
}
