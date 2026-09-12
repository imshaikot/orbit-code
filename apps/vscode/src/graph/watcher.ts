import { ChangeBatcher, type WatchedChanges } from '@orbit-code/core/changeBatcher';
import { indexableGlob } from '@orbit-code/graph/languages';
import * as vscode from 'vscode';

/**
 * Feeds VS Code's file system watchers on the first workspace folder into a ChangeBatcher, which hands the changed
 * paths over in batches: 1.5 s after the last event, at most 5 s after the first, or at once on `flush()`.
 * Knows nothing about graphs.
 */
export class WorkspaceWatcher implements vscode.Disposable {
  private readonly batcher: ChangeBatcher;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(onChanges: (changes: WatchedChanges) => void) {
    this.batcher = new ChangeBatcher(() => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, onChanges);
    const files = vscode.workspace.createFileSystemWatcher(indexableGlob(), false, false, true);
    // Deleting a folder reports only the folder, never the files that were in it.
    const deletions = vscode.workspace.createFileSystemWatcher('**/*', true, true, false);
    const note = (change: 'touched' | 'deleted') => (uri: vscode.Uri) => {
      if (uri.scheme === 'file') this.batcher.note(uri.fsPath, change);
    };
    this.disposables.push(
      files,
      deletions,
      files.onDidCreate(note('touched')),
      files.onDidChange(note('touched')),
      deletions.onDidDelete(note('deleted')),
      this.batcher,
    );
  }

  /** Hands over whatever is pending now. */
  flush(): void {
    this.batcher.flush();
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
  }
}
