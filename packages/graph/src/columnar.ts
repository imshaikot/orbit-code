import type { GraphFile, NodeColumns } from '@orbit-code/protocol';
import { basenameOf } from './languages';

export interface Columnar {
  nodes: NodeColumns;
  /** [src0, dst0, src1, dst1, …] */
  edges: Uint32Array;
}

/** The persisted object graph → the columnar wire form sent to the webview. */
export function toColumnar(graph: GraphFile): Columnar {
  const count = graph.nodes.length;
  const dirs: string[] = [];
  const dirLookup = new Map<string, number>();
  const dirIndex = new Uint32Array(count);
  const names = new Array<string>(count);
  const sizes = new Float32Array(count);
  const indexOf = new Map<string, number>();

  graph.nodes.forEach((node, i) => {
    let dir = dirLookup.get(node.dir);
    if (dir === undefined) {
      dir = dirs.length;
      dirs.push(node.dir);
      dirLookup.set(node.dir, dir);
    }
    dirIndex[i] = dir;
    names[i] = basenameOf(node.id);
    sizes[i] = node.size;
    indexOf.set(node.id, i);
  });

  const edges = new Uint32Array(graph.edges.length * 2);
  let n = 0;
  for (const edge of graph.edges) {
    const source = indexOf.get(edge.source);
    const target = indexOf.get(edge.target);
    if (source === undefined || target === undefined || source === target) continue;
    edges[n++] = source;
    edges[n++] = target;
  }

  return { nodes: { count, dirs, dirIndex, names, sizes }, edges: n === edges.length ? edges : edges.slice(0, n) };
}

export function nodeId(nodes: NodeColumns, i: number): string {
  const dir = nodes.dirs[nodes.dirIndex[i]];
  return dir === '.' ? nodes.names[i] : `${dir}/${nodes.names[i]}`;
}
