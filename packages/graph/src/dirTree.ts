// Directory bubbles. Every directory with files under it is a bubble, nested inside its parent's
// bubble; the root "." holds everything. The layout worker lays the bubbles out, layoutExtend
// extends them, and the webview shows one directory's contents at a time.
//
// Bubble labels are kept in canonical order (see comparePaths): parents before children, and
// every subtree contiguous. The hierarchy is derived from the labels alone.

import { dirnameOf } from './languages';

/** Space between sibling bubbles, and between a bubble and the files beside it. */
export const BUBBLE_GAP = 3;
/** Space between a bubble's outermost child and its rim. */
export const BUBBLE_MARGIN = 1.5;
/** Room a file keeps from a bubble beside it. */
export const FILE_CLEARANCE = 1;
/** Radius of a bubble holding a single file: that file's radius plus this. */
export const SINGLE_FILE_PADDING = 2;
/** `LayoutSnapshot.clusterOf` is a Uint16Array. */
export const MAX_BUBBLES = 65535;

/** "." first, then segment by segment, so a directory sorts right before its own sub-directories. */
export function comparePaths(a: string, b: string): number {
  if (a === b) return 0;
  if (a === '.') return -1;
  if (b === '.') return 1;
  const left = a.split('/');
  const right = b.split('/');
  for (let k = 0; k < Math.min(left.length, right.length); k++) {
    if (left[k] !== right[k]) return left[k] < right[k] ? -1 : 1;
  }
  return left.length - right.length;
}

/** `path` is `ancestor` or lies below it. */
export function isWithin(path: string, ancestor: string): boolean {
  return ancestor === '.' || path === ancestor || path.startsWith(`${ancestor}/`);
}

export function depthOf(path: string): number {
  return path === '.' ? 0 : path.split('/').length;
}

/**
 * The bubbles for a set of file directories: each directory and all its ancestors, in canonical order.
 * Past MAX_BUBBLES, the deepest levels are left out and their files sit in the nearest kept ancestor.
 */
export function bubbleLabels(dirs: Iterable<string>): string[] {
  const all = new Set<string>(['.']);
  for (let dir of dirs) {
    while (!all.has(dir)) {
      all.add(dir);
      dir = dirnameOf(dir);
    }
  }
  let labels = [...all];
  if (labels.length > MAX_BUBBLES) {
    const perDepth: number[] = [];
    for (const label of labels) perDepth[depthOf(label)] = (perDepth[depthOf(label)] ?? 0) + 1;
    let kept = 0;
    let maxDepth = -1;
    while (maxDepth + 1 < perDepth.length && kept + (perDepth[maxDepth + 1] ?? 0) <= MAX_BUBBLES) kept += perDepth[++maxDepth] ?? 0;
    labels = labels.filter((label) => depthOf(label) <= maxDepth);
  }
  return labels.sort(comparePaths);
}

/** The bubble a file of directory `dir` sits in: the directory itself, or its deepest ancestor with a bubble. */
export function bubbleOf(dir: string, indexOf: ReadonlyMap<string, number>): number {
  for (;;) {
    const index = indexOf.get(dir);
    if (index !== undefined) return index;
    if (dir === '.') return -1;
    dir = dirnameOf(dir);
  }
}

/** Parent bubble per label, -1 for the root. `labels` must be in canonical order. */
export function parentsOf(labels: readonly string[]): Int32Array {
  const parent = new Int32Array(labels.length).fill(-1);
  const stack: number[] = [];
  labels.forEach((label, i) => {
    while (stack.length > 0 && !isWithin(label, labels[stack[stack.length - 1]])) stack.pop();
    parent[i] = stack.length > 0 ? stack[stack.length - 1] : -1;
    stack.push(i);
  });
  return parent;
}
