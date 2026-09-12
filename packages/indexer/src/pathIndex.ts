import { basenameOf, dirnameOf, extensionOf } from '@orbit-code/graph/languages';

/**
 * Lookup tables over the indexed file set. Import specifiers are only ever
 * resolved against files that exist in the graph, never against the disk.
 */
export class PathIndex {
  private readonly byId = new Map<string, number>();
  private readonly byStem = new Map<string, number[]>();
  private readonly byBaseStem = new Map<string, number[]>();
  private readonly byBaseName = new Map<string, number[]>();
  private readonly byDir = new Map<string, number[]>();
  /** Every directory holding a file at any depth, "." included, in the order files first reach them. */
  private readonly dirs = new Set<string>();
  private readonly dirsByName = new Map<string, string[]>();
  /** File indices in path order, so the files under a directory are one contiguous run. */
  private readonly sorted: number[];

  constructor(readonly ids: readonly string[]) {
    ids.forEach((id, i) => {
      const stem = stemOf(id);
      this.byId.set(id, i);
      push(this.byStem, stem, i);
      push(this.byBaseStem, basenameOf(stem), i);
      push(this.byBaseName, basenameOf(id), i);
      push(this.byDir, dirnameOf(id), i);
      for (let dir = dirnameOf(id); !this.dirs.has(dir); dir = dirnameOf(dir)) {
        this.dirs.add(dir);
        if (dir !== '.') push(this.dirsByName, basenameOf(dir), dir);
      }
    });
    this.sorted = ids.map((_, i) => i).sort((a, b) => (ids[a] < ids[b] ? -1 : ids[a] > ids[b] ? 1 : 0));
  }

  exact(id: string | undefined): number | undefined {
    return id === undefined ? undefined : this.byId.get(id);
  }

  /** First existing `stem + ext`, trying extensions in order. */
  withExtension(stem: string | undefined, exts: readonly string[]): number | undefined {
    if (stem === undefined) return undefined;
    const candidates = this.byStem.get(stem);
    if (!candidates) return undefined;
    for (const ext of exts) {
      for (const i of candidates) if (extensionOf(this.ids[i]) === ext) return i;
    }
    return undefined;
  }

  /** Files whose extensionless path is `suffix` or ends with `/suffix`. */
  stemSuffix(suffix: string, exts: readonly string[]): number[] {
    return (this.byBaseStem.get(basenameOf(suffix)) ?? []).filter((i) => {
      const id = this.ids[i];
      if (!exts.includes(extensionOf(id))) return false;
      const stem = stemOf(id);
      return stem === suffix || stem.endsWith(`/${suffix}`);
    });
  }

  /** Files whose path is `suffix` or ends with `/suffix`. */
  pathSuffix(suffix: string): number[] {
    return (this.byBaseName.get(basenameOf(suffix)) ?? []).filter((i) => {
      const id = this.ids[i];
      return id === suffix || id.endsWith(`/${suffix}`);
    });
  }

  /** Files directly in `dir`. */
  inDir(dir: string): readonly number[] {
    return this.byDir.get(dir) ?? [];
  }

  /** Files in `dir` or anywhere below it, in path order. */
  under(dir: string): number[] {
    if (dir === '.') return [...this.sorted];
    const prefix = `${dir}/`;
    let low = 0;
    let high = this.sorted.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (this.ids[this.sorted[mid]] < prefix) low = mid + 1;
      else high = mid;
    }
    const files: number[] = [];
    for (let k = low; k < this.sorted.length && this.ids[this.sorted[k]].startsWith(prefix); k++) files.push(this.sorted[k]);
    return files;
  }

  /** Whether some file lies in `dir` or below it. */
  hasDir(dir: string | undefined): boolean {
    return dir !== undefined && this.dirs.has(dir);
  }

  /** Every directory holding a file at any depth, "." included. */
  directories(): IterableIterator<string> {
    return this.dirs.values();
  }

  /** Directories whose path is `suffix` or ends with `/suffix`. */
  dirSuffix(suffix: string): string[] {
    return (this.dirsByName.get(basenameOf(suffix)) ?? []).filter((dir) => dir === suffix || dir.endsWith(`/${suffix}`));
  }

  /** The candidate sharing the longest directory prefix with `fromId`; ties go to the shorter path. */
  closest(fromId: string, candidates: readonly number[]): number | undefined {
    let best: number | undefined;
    let bestShared = -1;
    const from = fromId.split('/');
    for (const i of candidates) {
      const shared = sharedDirs(from, this.ids[i].split('/').slice(0, -1));
      if (shared > bestShared || (shared === bestShared && best !== undefined && this.ids[i].length < this.ids[best].length)) {
        best = i;
        bestShared = shared;
      }
    }
    return best;
  }

  /** The directory sharing the longest prefix with `fromId`'s directory; ties go to the shorter path. */
  closestDir(fromId: string, dirs: readonly string[]): string | undefined {
    let best: string | undefined;
    let bestShared = -1;
    const from = fromId.split('/');
    for (const dir of dirs) {
      const shared = sharedDirs(from, dir === '.' ? [] : dir.split('/'));
      if (shared > bestShared || (shared === bestShared && best !== undefined && dir.length < best.length)) {
        best = dir;
        bestShared = shared;
      }
    }
    return best;
  }
}

/** POSIX join + normalise. Returns undefined when the result escapes the workspace root. */
export function joinPath(dir: string, relative: string): string | undefined {
  const parts = dir === '.' ? [] : dir.split('/').filter(Boolean);
  for (const segment of relative.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else {
      parts.push(segment);
    }
  }
  return parts.join('/');
}

/** Leading directory segments of the file path `from` that `dirs` shares. */
function sharedDirs(from: readonly string[], dirs: readonly string[]): number {
  let shared = 0;
  while (shared < from.length - 1 && shared < dirs.length && from[shared] === dirs[shared]) shared++;
  return shared;
}

function stemOf(id: string): string {
  const ext = extensionOf(id);
  return ext ? id.slice(0, -ext.length) : id;
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
