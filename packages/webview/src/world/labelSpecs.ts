import type { GraphContent, LayoutSnapshot } from '@orbit-code/protocol';
import * as THREE from 'three';
import type { DirView } from '../dirView';
import { ARC_GAP, type FlatLayout, halfBand, ringPoint } from '../flatLayout';
import type { LabelSpec } from '../labels';
import type { Adjacency } from '../nodeState';
import type { Stage } from '../stage';
import { clusterCenter, flatPosition } from './positions';

/** Candidates only; the label layer drops whatever would overlap. */
const MAX_FILE_LABELS = 120;
/** The Flat view names the files largest on screen, at most this many candidates, once a sphere is this many CSS pixels in radius. */
const MAX_FLAT_LABELS = 320;
const FLAT_LABEL_PX = 9;

/** What labels are made from: one World's graph and layout, and where its files are drawn right now. */
export interface LabelSource {
  graph: GraphContent;
  layout: LayoutSnapshot;
  view: DirView;
  adjacency: Adjacency;
  /** Files directly inside each directory. */
  members: number[][];
  /** A file the file menu is deleting, which keeps no label. */
  removing(node: number): boolean;
  position(node: number): THREE.Vector3;
  radius(node: number): number;
}

/** A directory's sub-directory names, then as many of its own file names as fit, hubs first. */
export function directoryLabels(source: LabelSource, cluster: number): LabelSpec[] {
  const { graph, layout, view, adjacency } = source;
  const { radii } = layout.clusters;
  const specs: LabelSpec[] = view.children[cluster].map((c) => ({
    key: `cluster:${c}`,
    kind: 'cluster' as const,
    text: shortPath(view.name(c)),
    detail: view.files[c].toLocaleString('en-US'),
    position: clusterCenter(layout, c),
    lift: radii[c],
    priority: 20_000 + view.files[c],
  }));
  const { importsOf, importedBy } = adjacency;
  const hubs = source.members[cluster].filter((node) => !source.removing(node)).sort((a, b) => importsOf[b] + importedBy[b] - (importsOf[a] + importedBy[a])).slice(0, MAX_FILE_LABELS);
  for (const node of hubs) {
    specs.push({ key: `file:${node}`, kind: 'file', text: graph.nodes.names[node], position: source.position(node), lift: source.radius(node), priority: 100 + importsOf[node] + importedBy[node] });
  }
  return specs;
}

/** The names of the groups along their arcs, and of as many files as are large enough on screen, the largest first. */
export function flatLabels(source: LabelSource, flat: FlatLayout, stage: Stage): LabelSpec[] {
  const { camera, height } = stage;
  const view = camera.matrixWorldInverse.elements;
  const projection = camera.projectionMatrix.elements;
  const { positions, radii } = flat;
  const candidates: Array<{ node: number; px: number }> = [];
  for (let i = 0; i < source.graph.nodes.count; i++) {
    if (source.removing(i)) continue;
    const [x, y, z] = [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
    const depth = -(view[2] * x + view[6] * y + view[10] * z + view[14]);
    if (depth <= camera.near) continue;
    const px = (radii[i] * projection[5] * height * 0.5) / depth;
    if (px < FLAT_LABEL_PX) continue;
    const vx = view[0] * x + view[4] * y + view[8] * z + view[12];
    const vy = view[1] * x + view[5] * y + view[9] * z + view[13];
    if (Math.abs((projection[0] * vx) / depth) > 1.05 || Math.abs((projection[5] * vy) / depth) > 1.05) continue;
    candidates.push({ node: i, px });
  }
  candidates.sort((a, b) => b.px - a.px);
  const specs: LabelSpec[] = candidates.slice(0, MAX_FLAT_LABELS).map(({ node, px }) => ({
    key: `file:${node}`,
    kind: 'file',
    text: source.graph.nodes.names[node],
    position: flatPosition(flat, node),
    lift: -radii[node],
    below: true,
    priority: 100 + px,
  }));

  // Each group is named at the middle of its arc, above its band.
  const point = [0, 0, 0];
  for (const arc of flat.arcs) {
    const ring = flat.rings[arc.ring];
    ringPoint(ring, arc.start + (arc.columns - ARC_GAP - 1) / 2, (ring.lanes - 1) / 2, point);
    specs.push({
      key: `arc:${arc.label}`,
      kind: 'cluster',
      text: shortPath(arc.label),
      detail: arc.count.toLocaleString('en-US'),
      position: new THREE.Vector3(point[0], point[1], point[2]),
      lift: halfBand(ring) + 1,
      priority: 20_000 + arc.count,
    });
  }
  return specs;
}

function shortPath(path: string): string {
  if (path.length <= 30) return path;
  const parts = path.split('/');
  return `…/${parts.slice(-2).join('/')}`;
}
