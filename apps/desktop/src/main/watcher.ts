import { type FSWatcher, existsSync, watch } from 'node:fs';
import { join, sep } from 'node:path';
import type { Disposable } from '@orbit-code/common/event';
import type { Logger } from '@orbit-code/common/log';
import { ChangeBatcher, type WatchedChanges } from '@orbit-code/core/changeBatcher';
import { ALWAYS_EXCLUDED_DIRS, isIndexable } from '@orbit-code/graph/languages';

/**
 * The folder's file events, fed into ChangeBatcher the way the extension's VS Code watchers feed it: a file created or
 * changed that could be a node is touched, and anything gone is deleted (a deleted folder reports only the folder).
 * One recursive fs.watch. Where it can't be had, live updates follow only Orbit's own renames and deletes.
 */
export class FolderWatcher implements Disposable {
  private readonly batcher: ChangeBatcher;
  private readonly watcher: FSWatcher | undefined;

  constructor(root: string, log: Logger, onChanges: (changes: WatchedChanges) => void) {
    this.batcher = new ChangeBatcher(() => root, onChanges);
    try {
      this.watcher = watch(root, { recursive: true, persistent: false }, (_event, filename) => {
        if (!filename) return;
        const id = sep === '/' ? filename : filename.split(sep).join('/');
        if (id.split('/').some((segment) => ALWAYS_EXCLUDED_DIRS.has(segment))) return;
        const absolute = join(root, filename);
        if (!existsSync(absolute)) this.batcher.note(absolute, 'deleted');
        else if (isIndexable(id)) this.batcher.note(absolute, 'touched');
      });
      this.watcher.on('error', (error) => log.warn(`watcher: stopped watching ${root}: ${error.message}`));
    } catch (error) {
      log.warn(`watcher: cannot watch ${root} (${error instanceof Error ? error.message : String(error)}); changes made outside Orbit show after Reindex`);
    }
  }

  /** Hands over what is pending now, as a finished turn does. */
  flush(): void {
    this.batcher.flush();
  }

  dispose(): void {
    this.watcher?.close();
    this.batcher.dispose();
  }
}
