import { parentsOf } from '@orbit-code/graph/dirTree';

/** Where projects usually keep their code, looked for in this order among the root's sub-directories. */
const SOURCE_DIRECTORIES = ['src', 'source', 'sources', 'lib', 'app', 'packages'];

/**
 * The directories the view navigates, derived from the layout's bubbles (cluster indices). A directory
 * holding nothing but one sub-directory is skipped: that sub-directory shows up one level higher,
 * named with both ("main/java"). Skipped directories are never focused, drawn or picked.
 */
export class DirView {
  /** Bubble parent, -1 for ".". */
  readonly parent: Int32Array;
  /** Nearest shown ancestor; -1 for the root and for skipped directories. */
  readonly viewParent: Int32Array;
  readonly shown: Uint8Array;
  /** The top of the tree: "." unless it is skipped. */
  readonly root: number;
  /** Where the view opens: the root's source directory when it has one (`src`, `lib`, …), else the root. */
  readonly start: number;
  /** Shown sub-directories of each shown directory, in canonical order. */
  readonly children: number[][];
  /** Files directly inside. */
  readonly own: Uint32Array;
  /** Files anywhere inside. */
  readonly files: Uint32Array;

  constructor(
    private readonly labels: readonly string[],
    clusterOf: Uint16Array,
  ) {
    const count = labels.length;
    this.parent = parentsOf(labels);
    this.own = new Uint32Array(count);
    this.files = new Uint32Array(count);
    for (const c of clusterOf) this.own[c]++;
    const kids: number[][] = labels.map(() => []);
    for (let c = 1; c < count; c++) kids[this.parent[c]].push(c);
    for (let c = count - 1; c >= 0; c--) {
      this.files[c] += this.own[c];
      if (c > 0) this.files[this.parent[c]] += this.files[c];
    }

    const skipped = (c: number) => this.own[c] === 0 && kids[c].length === 1;
    let root = 0;
    while (count > 0 && skipped(root)) root = kids[root][0];
    this.root = root;
    this.shown = Uint8Array.from(labels, (_, c) => (skipped(c) ? 0 : 1));
    this.viewParent = new Int32Array(count).fill(-1);
    this.children = labels.map(() => []);
    for (let c = 0; c < count; c++) {
      if (!this.shown[c] || c === root) continue;
      let p = this.parent[c];
      while (p >= 0 && !this.shown[p]) p = this.parent[p];
      this.viewParent[c] = p;
      if (p >= 0) this.children[p].push(c);
    }
    const sources = SOURCE_DIRECTORIES.flatMap((dir) => this.children[root].filter((c) => this.name(c) === dir || this.name(c).startsWith(`${dir}/`)));
    this.start = sources[0] ?? root;
  }

  /** The directory's name as shown inside its view parent: "hud", or "main/java" for a skipped chain. */
  name(c: number): string {
    const label = this.labels[c];
    const p = this.viewParent[c];
    if (p < 0 || this.labels[p] === '.') return label;
    return label.slice(this.labels[p].length + 1);
  }

  /** Shown directories from the root down to `c`, both included. */
  path(c: number): number[] {
    const path: number[] = [];
    for (let at = this.shownAncestor(c); at >= 0; at = this.viewParent[at]) path.unshift(at);
    return path;
  }

  /** `c` when it is shown, else its nearest shown ancestor (the root at worst). */
  shownAncestor(c: number): number {
    while (c >= 0 && !this.shown[c]) c = this.parent[c];
    return c >= 0 ? c : this.root;
  }
}
