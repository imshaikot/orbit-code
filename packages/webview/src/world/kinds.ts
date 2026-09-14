import { FILE_KINDS, SUPPORTING_KIND, fileKindOf } from '@orbit-code/graph/languages';
import type { GraphContent, LayoutSnapshot } from '@orbit-code/protocol';
import type { DirView } from '../dirView';
import { KIND_COLORS } from '../palette';

const KIND_INDEX = new Map(FILE_KINDS.map((kind, k) => [kind, k]));
const SUPPORTING_INDEX = KIND_INDEX.get(SUPPORTING_KIND)!;

export interface FileKinds {
  /** FILE_KINDS index per file. */
  kinds: Uint8Array;
  /** FILE_KINDS index per directory: the kind most files anywhere inside are, project config only when nothing else is. */
  dominantKinds: Uint8Array;
  /** Files of each kind anywhere inside each directory: [cluster * FILE_KINDS.length + kind]. */
  counts: Uint32Array;
  fileColors: Float32Array;
  bubbleColors: Float32Array;
}

/** Colour is file type: each file its own, each directory the type most of its files are. */
export function deriveKinds(graph: GraphContent, layout: LayoutSnapshot, view: DirView): FileKinds {
  const count = graph.nodes.count;
  const { labels } = layout.clusters;
  const kindCount = FILE_KINDS.length;
  const kinds = Uint8Array.from({ length: count }, (_, i) => KIND_INDEX.get(fileKindOf(graph.nodes.names[i]))!);
  const counts = new Uint32Array(labels.length * kindCount);
  for (let i = 0; i < count; i++) counts[layout.clusterOf[i] * kindCount + kinds[i]]++;
  for (let c = labels.length - 1; c > 0; c--) {
    const parent = view.parent[c];
    for (let k = 0; k < kindCount; k++) counts[parent * kindCount + k] += counts[c * kindCount + k];
  }
  const dominantKinds = Uint8Array.from(labels, (_, c) => dominantKind(counts.subarray(c * kindCount, (c + 1) * kindCount)));
  const fileColors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) fileColors.set(KIND_COLORS[FILE_KINDS[kinds[i]]], i * 3);
  const bubbleColors = new Float32Array(labels.length * 3);
  dominantKinds.forEach((k, c) => bubbleColors.set(KIND_COLORS[FILE_KINDS[k]], c * 3));
  return { kinds, dominantKinds, counts, fileColors, bubbleColors };
}

/** The percentage of a directory's files that are of its dominant kind. */
export function dominantShare(table: FileKinds, cluster: number, files: number): number {
  return Math.round((100 * table.counts[cluster * FILE_KINDS.length + table.dominantKinds[cluster]]) / Math.max(1, files));
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
