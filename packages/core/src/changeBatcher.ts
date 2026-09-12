import { isAbsolute, relative, sep } from 'node:path';
import type { Disposable } from '@orbit-code/common/event';
import { ALWAYS_EXCLUDED_DIRS } from '@orbit-code/graph/languages';

const DEBOUNCE_MS = 1500;
const MAX_WAIT_MS = 5000;

/** What changed since the last batch, as workspace-relative POSIX paths. */
export interface WatchedChanges {
  /** Source files created or changed. */
  touched: string[];
  /** Files or folders deleted. */
  deleted: string[];
}

/**
 * Collects the file events an editor reports under the workspace root and hands them over in batches: 1.5 s after
 * the last event, at most 5 s after the first, or at once on `flush()`. Each editor feeds it from its own watchers
 * (apps/vscode/src/graph/watcher.ts). Knows nothing about graphs or editors.
 */
export class ChangeBatcher implements Disposable {
  private readonly touched = new Set<string>();
  private readonly deleted = new Set<string>();
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private deadline: ReturnType<typeof setTimeout> | undefined;

  constructor(
    /** The workspace root the paths are taken relative to, read at each event. */
    private readonly root: () => string | undefined,
    private readonly onChanges: (changes: WatchedChanges) => void,
  ) {}

  /** A file created or changed, or a file or folder deleted, by absolute path. Paths outside the root or in an always-excluded directory are dropped. */
  note(path: string, change: 'touched' | 'deleted'): void {
    const root = this.root();
    if (!root) return;
    const rel = relative(root, path);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return;
    const id = sep === '/' ? rel : rel.split(sep).join('/');
    if (id.split('/').some((segment) => ALWAYS_EXCLUDED_DIRS.has(segment))) return;
    (change === 'touched' ? this.touched : this.deleted).add(id);
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.flush(), DEBOUNCE_MS);
    this.deadline ??= setTimeout(() => this.flush(), MAX_WAIT_MS);
  }

  /** Hands over whatever is pending now. */
  flush(): void {
    clearTimeout(this.debounce);
    clearTimeout(this.deadline);
    this.debounce = this.deadline = undefined;
    if (this.touched.size === 0 && this.deleted.size === 0) return;
    const changes = { touched: [...this.touched], deleted: [...this.deleted] };
    this.touched.clear();
    this.deleted.clear();
    this.onChanges(changes);
  }

  dispose(): void {
    clearTimeout(this.debounce);
    clearTimeout(this.deadline);
  }
}
