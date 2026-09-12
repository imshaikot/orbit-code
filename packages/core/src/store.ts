import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GraphFile, LayoutSnapshot } from '@orbit-code/protocol';

const LAYOUT_MAGIC = 0x4c42524f; // "ORBL"
/** 2: nested directory bubbles (every directory is a cluster), replacing at most 48 flat clusters. */
const LAYOUT_VERSION = 2;
const KEEP_LAYOUTS = 4;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** orbit-v1/ in the editor's storage for the workspace: graph.json plus one frozen layout per graph hash. */
export class Store {
  private readonly dir: string;

  constructor(storageDir: string) {
    this.dir = join(storageDir, 'orbit-v1');
  }

  async readGraph(): Promise<GraphFile | undefined> {
    try {
      const graph = JSON.parse(await readFile(this.file('graph.json'), 'utf8'));
      return graph?.version === 1 && Array.isArray(graph.nodes) ? (graph as GraphFile) : undefined;
    } catch {
      return undefined;
    }
  }

  async writeGraph(graph: GraphFile): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.file('graph.json'), JSON.stringify(graph));
  }

  async readLayout(hash: string): Promise<LayoutSnapshot | undefined> {
    try {
      return decodeLayout(await readFile(this.file(layoutName(hash))), hash);
    } catch {
      return undefined;
    }
  }

  async writeLayout(layout: LayoutSnapshot): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.file(layoutName(layout.hash)), encodeLayout(layout));
    await this.pruneLayouts(layoutName(layout.hash));
  }

  private async pruneLayouts(keep: string): Promise<void> {
    const entries = (await readdir(this.dir)).filter((name) => name.startsWith('layout-') && name !== keep);
    if (entries.length < KEEP_LAYOUTS) return;
    const stats = await Promise.all(entries.map(async (name) => ({ name, mtime: (await stat(this.file(name))).mtimeMs })));
    stats.sort((a, b) => b.mtime - a.mtime);
    for (const { name } of stats.slice(KEEP_LAYOUTS - 1)) await rm(this.file(name), { force: true });
  }

  private file(name: string): string {
    return join(this.dir, name);
  }
}

function layoutName(hash: string): string {
  return `layout-${hash.replace(/[^\w-]/g, '_').slice(0, 40)}.bin`;
}

// Layout file: u32 magic | u32 version | u32 headerBytes | header JSON | pad4
//              | f32 positions[3n] | u16 clusterOf[n] | pad4 | f32 centers[3c] | f32 radii[c]
function encodeLayout(layout: LayoutSnapshot): Uint8Array {
  const count = layout.clusterOf.length;
  const clusters = layout.clusters.radii.length;
  const header = encoder.encode(JSON.stringify({ hash: layout.hash, count, clusters, labels: layout.clusters.labels }));
  const headerEnd = align4(12 + header.length);
  const positionsEnd = headerEnd + count * 12;
  const clusterOfEnd = align4(positionsEnd + count * 2);
  const total = clusterOfEnd + clusters * 16;

  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, LAYOUT_MAGIC, true);
  view.setUint32(4, LAYOUT_VERSION, true);
  view.setUint32(8, header.length, true);
  bytes.set(header, 12);
  new Float32Array(bytes.buffer, headerEnd, count * 3).set(layout.positions);
  new Uint16Array(bytes.buffer, positionsEnd, count).set(layout.clusterOf);
  new Float32Array(bytes.buffer, clusterOfEnd, clusters * 3).set(layout.clusters.centers);
  new Float32Array(bytes.buffer, clusterOfEnd + clusters * 12, clusters).set(layout.clusters.radii);
  return bytes;
}

function decodeLayout(file: Uint8Array, expectedHash: string): LayoutSnapshot | undefined {
  const bytes = new Uint8Array(file.byteLength);
  bytes.set(file); // own, aligned buffer
  const view = new DataView(bytes.buffer);
  if (bytes.length < 12 || view.getUint32(0, true) !== LAYOUT_MAGIC || view.getUint32(4, true) !== LAYOUT_VERSION) return undefined;
  const headerLength = view.getUint32(8, true);
  const header = JSON.parse(decoder.decode(bytes.subarray(12, 12 + headerLength))) as { hash: string; count: number; clusters: number; labels: string[] };
  if (header.hash !== expectedHash) return undefined;

  const headerEnd = align4(12 + headerLength);
  const positionsEnd = headerEnd + header.count * 12;
  const clusterOfEnd = align4(positionsEnd + header.count * 2);
  if (bytes.length !== clusterOfEnd + header.clusters * 16) return undefined;
  return {
    hash: header.hash,
    positions: new Float32Array(bytes.buffer.slice(headerEnd, positionsEnd)),
    clusterOf: new Uint16Array(bytes.buffer.slice(positionsEnd, positionsEnd + header.count * 2)),
    clusters: {
      labels: header.labels,
      centers: new Float32Array(bytes.buffer.slice(clusterOfEnd, clusterOfEnd + header.clusters * 12)),
      radii: new Float32Array(bytes.buffer.slice(clusterOfEnd + header.clusters * 12)),
    },
  };
}

/** postMessage from the webview preserves typed arrays in current VS Code, but accept plain arrays too. */
export function normalizeLayout(raw: unknown): LayoutSnapshot | undefined {
  const layout = raw as LayoutSnapshot | undefined;
  if (!layout || typeof layout.hash !== 'string' || !layout.clusters) return undefined;
  return {
    hash: layout.hash,
    positions: toTyped(layout.positions, Float32Array),
    clusterOf: toTyped(layout.clusterOf, Uint16Array),
    clusters: {
      labels: [...layout.clusters.labels],
      centers: toTyped(layout.clusters.centers, Float32Array),
      radii: toTyped(layout.clusters.radii, Float32Array),
    },
  };
}

function toTyped<T extends Float32Array | Uint16Array>(value: unknown, Type: { new (values: ArrayLike<number>): T; from(values: Iterable<number>): T }): T {
  if (value instanceof Type) return value;
  if (ArrayBuffer.isView(value) || Array.isArray(value)) return new Type(value as unknown as ArrayLike<number>);
  return Type.from(Object.values(value as Record<string, number>));
}

function align4(n: number): number {
  return (n + 3) & ~3;
}
