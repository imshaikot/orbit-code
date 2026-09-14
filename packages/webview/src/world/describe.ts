import { nodeId } from '@orbit-code/graph/columnar';
import { FILE_KINDS, FILE_KIND_LABELS } from '@orbit-code/graph/languages';
import type { GraphContent } from '@orbit-code/protocol';
import type { DirView } from '../dirView';
import type { Adjacency } from '../nodeState';
import { type FileKinds, dominantShare } from './kinds';

/** What the tooltip says about the thing under the pointer. */
export interface Description {
  title: string;
  detail: string;
}

export function describeFile(graph: GraphContent, table: FileKinds, adjacency: Adjacency, node: number): Description {
  return {
    title: nodeId(graph.nodes, node),
    detail: `${FILE_KIND_LABELS[FILE_KINDS[table.kinds[node]]]}, ${formatBytes(graph.nodes.sizes[node])}, imports ${adjacency.importsOf[node]}, imported by ${adjacency.importedBy[node]}`,
  };
}

export function describeDirectory(title: string, table: FileKinds, view: DirView, cluster: number): Description {
  const files = view.files[cluster];
  const subdirectories = view.children[cluster].length;
  const parts = [`${files.toLocaleString('en-US')} ${files === 1 ? 'file' : 'files'}`];
  if (subdirectories > 0) parts.push(`${subdirectories} ${subdirectories === 1 ? 'sub-directory' : 'sub-directories'}`);
  parts.push(`${dominantShare(table, cluster, files)}% ${FILE_KIND_LABELS[FILE_KINDS[table.dominantKinds[cluster]]]}`);
  return { title, detail: `${parts.join(', ')}. Click to look inside.` };
}

/** `agent` is set for a subagent's star. */
export function describeStar(agent: { name: string | undefined } | undefined, following: boolean): Description {
  if (agent) return { title: agent.name ?? 'Subagent', detail: following ? 'A subagent, followed. Click for its output.' : 'A subagent. Click for its output, or to follow it.' };
  return { title: 'Claude', detail: following ? 'Following. Click for options.' : 'Click to follow, or see options.' };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
