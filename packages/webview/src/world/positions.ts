import { nodeRadius } from '@orbit-code/graph/visual';
import type { LayoutSnapshot } from '@orbit-code/protocol';
import * as THREE from 'three';
import { type FlatLayout, MORPH_STAGGER } from '../flatLayout';

export function clusterCenter(layout: LayoutSnapshot, cluster: number): THREE.Vector3 {
  const centers = layout.clusters.centers;
  return new THREE.Vector3(centers[cluster * 3], centers[cluster * 3 + 1], centers[cluster * 3 + 2]);
}

export function flatPosition(flat: FlatLayout, node: number): THREE.Vector3 {
  const positions = flat.positions;
  return new THREE.Vector3(positions[node * 3], positions[node * 3 + 1], positions[node * 3 + 2]);
}

/** Where a file is drawn right now: in its directory, on its orbit, or on its way between them, as nodes.ts has it. */
export function filePosition(layout: LayoutSnapshot, flat: FlatLayout | undefined, mix: number, node: number): THREE.Vector3 {
  const positions = layout.positions;
  const nested = new THREE.Vector3(positions[node * 3], positions[node * 3 + 1], positions[node * 3 + 2]);
  if (mix <= 0 || !flat) return nested;
  const orbit = flatPosition(flat, node);
  let away = THREE.MathUtils.clamp((mix - flat.delays[node]) / (1 - MORPH_STAGGER), 0, 1);
  away = away * away * (3 - 2 * away);
  const lift = Math.sin(Math.PI * away) * 0.18 * nested.distanceTo(orbit);
  nested.lerp(orbit, away).y += lift;
  return nested;
}

/** A label lifted this far clears its file. */
export function fileRadius(sizes: Float32Array, flat: FlatLayout | undefined, mix: number, node: number): number {
  return mix >= 0.5 && flat ? flat.radii[node] : nodeRadius(sizes[node]);
}
