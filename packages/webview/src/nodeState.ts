import * as THREE from 'three';

/**
 * Per-node animation state lives in one float texture (RGBA per node):
 *   r = readAt   clock time a Read lands (-1 = never)
 *   g = editAt   clock time an Edit pulse starts (-1 = never)
 *   b = weight   1 for the edited file, 0.5 for a neighbour
 *   a = addedAt  clock time a live update added the file outside a turn (-1 = never),
 *                or -(removedAt + 2) from the moment the file menu deletes it
 * Node and edge shaders sample it and derive glow from uTime, so the CPU only
 * writes a few texels per event and nothing per frame.
 */

/** Seconds a deleted file takes to collapse; it stays hidden after that until the update that removes it. */
export const REMOVE_S = 0.5;

export const STATE_GLSL = /* glsl */ `
uniform sampler2D uState;
uniform float uStateWidth;
uniform float uTime;
uniform float uRestT;

vec4 nodeState(float index) {
  int i = int(index + 0.5);
  int width = int(uStateWidth);
  return texelFetch(uState, ivec2(i % width, i / width), 0);
}

float restFade(float startedAt) {
  return startedAt < uRestT ? 1.0 - smoothstep(0.0, 0.9, uTime - uRestT) : 1.0;
}

// Rises as the particle lands, then settles to a "read this turn" glow until the result.
float readGlow(vec4 state) {
  float dt = uTime - state.r;
  if (state.r < 0.0 || dt < 0.0) return 0.0;
  return smoothstep(0.0, 0.12, dt) * (0.42 + 0.58 * exp(-dt * 1.8)) * restFade(state.r);
}

// Strong on the edited file, half strength on its direct neighbours.
float editPulse(vec4 state) {
  float dt = uTime - state.g;
  if (state.g < 0.0 || dt < 0.0) return 0.0;
  float beat = 0.82 + 0.18 * cos(dt * 10.0);
  return state.b * (0.38 + 0.62 * exp(-dt * 1.3)) * beat * restFade(state.g);
}

// A file that joined the graph while no turn runs: one pulse that fades by itself, unlike an edit.
float addedPulse(vec4 state) {
  float dt = uTime - state.a;
  if (state.a < 0.0 || dt < 0.0) return 0.0;
  return (1.0 - smoothstep(0.0, 2.6, dt)) * (0.82 + 0.18 * cos(dt * 10.0));
}

// Seconds since the file menu started deleting the file, -1 otherwise.
float removedFor(vec4 state) {
  return state.a < -1.5 ? max(0.0, uTime + state.a + 2.0) : -1.0;
}

// 0 → 1 while the ring expands around an edited or newly added file, -1 otherwise.
float editRing(vec4 state) {
  float dt = uTime - state.g;
  if (state.g >= 0.0 && dt >= 0.0 && dt <= 1.4 && state.b >= 0.75) return dt / 1.4;
  dt = uTime - state.a;
  if (state.a >= 0.0 && dt >= 0.0 && dt <= 1.4) return dt / 1.4;
  return -1.0;
}
`;

/** Undirected adjacency in CSR form. */
export interface Adjacency {
  offsets: Uint32Array;
  neighbours: Uint32Array;
  importsOf: Uint32Array;
  importedBy: Uint32Array;
}

export function buildAdjacency(count: number, edges: Uint32Array): Adjacency {
  const importsOf = new Uint32Array(count);
  const importedBy = new Uint32Array(count);
  for (let e = 0; e < edges.length; e += 2) {
    importsOf[edges[e]]++;
    importedBy[edges[e + 1]]++;
  }
  const offsets = new Uint32Array(count + 1);
  for (let i = 0; i < count; i++) offsets[i + 1] = offsets[i] + importsOf[i] + importedBy[i];
  const neighbours = new Uint32Array(offsets[count]);
  const cursor = offsets.slice(0, count);
  for (let e = 0; e < edges.length; e += 2) {
    neighbours[cursor[edges[e]]++] = edges[e + 1];
    neighbours[cursor[edges[e + 1]]++] = edges[e];
  }
  return { offsets, neighbours, importsOf, importedBy };
}

const MAX_NEIGHBOURS = 128;
const PARTIAL_UPLOAD_LIMIT = 32;

export class NodeState {
  readonly width: number;
  readonly texture: THREE.DataTexture;
  private readonly data: Float32Array;
  private readonly pending: number[] = [];
  private flushed = false;

  constructor(count: number, private readonly adjacency: Adjacency) {
    this.width = Math.max(1, Math.ceil(Math.sqrt(count)));
    this.data = new Float32Array(this.width * this.width * 4);
    for (let i = 0; i < this.data.length; i += 4) {
      this.data[i] = -1;
      this.data[i + 1] = -1;
      this.data[i + 3] = -1;
    }
    this.texture = new THREE.DataTexture(this.data, this.width, this.width, THREE.RGBAFormat, THREE.FloatType);
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;
  }

  read(node: number, at: number): void {
    this.data[node * 4] = at;
    this.pending.push(node);
  }

  /** Pulses the file and up to MAX_NEIGHBOURS direct neighbours. A neighbour edited itself since the rest at `restT` keeps its own pulse. */
  edit(node: number, at: number, restT: number): void {
    this.data[node * 4 + 1] = at;
    this.data[node * 4 + 2] = 1;
    this.pending.push(node);
    const { offsets, neighbours } = this.adjacency;
    const end = Math.min(offsets[node + 1], offsets[node] + MAX_NEIGHBOURS);
    for (let k = offsets[node]; k < end; k++) {
      const base = neighbours[k] * 4;
      if (this.data[base + 2] === 1 && this.data[base + 1] >= restT) continue; // edited itself this turn
      this.data[base + 1] = at + 0.08;
      this.data[base + 2] = 0.5;
      this.pending.push(neighbours[k]);
    }
  }

  /** A file a live update added outside a turn: one self-fading pulse. */
  added(node: number, at: number): void {
    this.data[node * 4 + 3] = at;
    this.pending.push(node);
  }

  /** A file being deleted: it collapses from `at` and stays hidden. Replaces any added pulse. */
  removing(node: number, at: number): void {
    this.data[node * 4 + 3] = -(at + 2);
    this.pending.push(node);
  }

  isRemoving(node: number): boolean {
    return this.data[node * 4 + 3] < -1.5;
  }

  /** Takes over every surviving node's texel from the state of the graph this one replaces. */
  adopt(previous: NodeState, remap: Int32Array): void {
    for (let from = 0; from < remap.length; from++) {
      const to = remap[from];
      if (to >= 0) this.data.set(previous.data.subarray(from * 4, from * 4 + 4), to * 4);
    }
    this.texture.needsUpdate = true;
  }

  /** At most one upload per frame: a few texels, or the whole (small) texture for big ripples. */
  flush(): void {
    const first = !this.flushed;
    this.flushed = true;
    if (this.pending.length === 0) return;
    this.texture.clearUpdateRanges();
    // The first upload must be whole: three.js allocates the storage, then writes only the update ranges.
    if (!first && this.pending.length <= PARTIAL_UPLOAD_LIMIT) {
      for (const node of this.pending) this.texture.addUpdateRange(node * 4, 4);
    }
    this.texture.needsUpdate = true;
    this.pending.length = 0;
  }

  dispose(): void {
    this.texture.dispose();
  }
}
