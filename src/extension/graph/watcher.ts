import { isAbsolute, relative, sep } from 'node:path';
import * as vscode from 'vscode';
import { ALWAYS_EXCLUDED_DIRS, indexableGlob } from '../../shared/languages';

const DEBOUNCE_MS = 1500;
const MAX_WAIT_MS = 5000;

/** What the watcher saw since the last batch, as workspace-relative POSIX paths. */
export interface WatchedChanges {
  /** Source files created or changed. */
  touched: string[];
  /** Files or folders deleted. */
  deleted: string[];
}

/**
 * Watches the first workspace folder and hands changed paths over in batches: 1.5 s after the
 * last event, at most 5 s after the first, or at once on `flush()`. Knows nothing about graphs.
 */
export class WorkspaceWatcher implements vscode.Disposable {
  private readonly touched = new Set<string>();
  private readonly deleted = new Set<string>();
  private readonly disposables: vscode.Disposable[] = [];
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private deadline: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly onChanges: (changes: WatchedChanges) => void) {
    const files = vscode.workspace.createFileSystemWatcher(indexableGlob(), false, false, true);
    // Deleting a folder reports only the folder, never the files that were in it.
    const deletions = vscode.workspace.createFileSystemWatcher('**/*', true, true, false);
    this.disposables.push(
      files,
      deletions,
      files.onDidCreate((uri) => this.note(uri, this.touched)),
      files.onDidChange((uri) => this.note(uri, this.touched)),
      deletions.onDidDelete((uri) => this.note(uri, this.deleted)),
    );
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
    for (const disposable of this.disposables) disposable.dispose();
  }

  private note(uri: vscode.Uri, into: Set<string>): void {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root || uri.scheme !== 'file') return;
    const rel = relative(root, uri.fsPath);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return;
    const id = sep === '/' ? rel : rel.split(sep).join('/');
    if (id.split('/').some((segment) => ALWAYS_EXCLUDED_DIRS.has(segment))) return;
    into.add(id);
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.flush(), DEBOUNCE_MS);
    this.deadline ??= setTimeout(() => this.flush(), MAX_WAIT_MS);
  }
}
