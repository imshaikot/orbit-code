import { type FSWatcher, watch } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Logger } from '@orbit-code/common/log';
import { basenameOf } from '@orbit-code/graph/languages';
import type { FileReply, FileRequest } from '@orbit-code/protocol';
import { isWorkspaceId } from '@orbit-code/protocol/workspacePath';
import type { FileHost } from './controller';
import { FOLLOW_DEBOUNCE_MS, type FileReplySink, MAX_SHEET_BYTES, baseText, failedReply, gitState } from './fileHelpers';

/** How far into a file a NUL byte marks it as binary, which the editor sheet can't hold. */
const BINARY_SNIFF_BYTES = 8000;

interface Followed {
  id: number;
  path: string;
  revision: number;
  /** The text last sent or saved, with the file's own line endings. */
  text: string;
  watcher: FSWatcher | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * What the file menu and the editor sheet do to a folder's files for a host without an editor (the desktop app, the
 * server), straight on the disk: git state, the text of the one file the sheet follows and saving it, delete (to the
 * trash) and rename. There are no editor tabs (`HostCapabilities.tabs` is false), so `show` is refused. Paths are
 * graph ids the controller checked.
 */
export class DiskFileHost implements FileHost {
  private followed: Followed | undefined;
  private revisions = 0;

  /** `trash` moves a file to the system's trash; `outside` receives the followed file's changes made anywhere but the sheet. */
  constructor(
    private readonly root: string,
    private readonly log: Logger,
    private readonly trash: (absolute: string) => Promise<void>,
    private readonly outside: FileReplySink,
  ) {}

  async handle(id: number, path: string, request: FileRequest): Promise<FileReply> {
    const absolute = this.absolute(path);
    switch (request.kind) {
      case 'info':
        return { kind: 'info', git: await gitState(this.root, path) };
      case 'read':
        return this.read(id, path, absolute);
      case 'write':
        return this.write(path, absolute, request);
      case 'close':
        this.unfollow(path);
        return { kind: 'closed' };
      case 'show':
        return failedReply('Orbit Code opens files in its own editor.');
      case 'delete':
        return this.remove(path, absolute);
      case 'rename':
        return this.rename(path, absolute, request.to);
    }
  }

  unfollow(path?: string): void {
    const followed = this.followed;
    if (!followed || (path !== undefined && followed.path !== path)) return;
    clearTimeout(followed.timer);
    followed.watcher?.close();
    this.followed = undefined;
  }

  dispose(): void {
    this.unfollow();
  }

  private absolute(path: string): string {
    return join(this.root, ...path.split('/'));
  }

  private async read(id: number, path: string, absolute: string): Promise<FileReply> {
    const { size } = await stat(absolute);
    if (size > MAX_SHEET_BYTES) return failedReply(`${basenameOf(path)} is ${(size / 1024 / 1024).toFixed(1)} MB, too large for the editor.`);
    const bytes = await readFile(absolute);
    if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return failedReply(`${basenameOf(path)} is not a text file.`);
    const text = bytes.toString('utf8');
    const base = await baseText(this.root, path);
    this.unfollow();
    this.followed = { id, path, revision: ++this.revisions, text, watcher: this.watch(absolute), timer: undefined };
    // No language id to give: the sheet picks the language by the file's name.
    return { kind: 'content', text, revision: this.followed.revision, language: 'plaintext', base, outside: false };
  }

  private async write(path: string, absolute: string, { text, revision, force }: { text: string; revision: number; force: boolean }): Promise<FileReply> {
    const followed = this.followed;
    if (followed?.path !== path) return failedReply(`${basenameOf(path)} is not open in the editor.`);
    const current = await readFile(absolute, 'utf8');
    if (!force && (revision !== followed.revision || current !== followed.text)) {
      return { kind: 'failed', error: `${basenameOf(path)} changed after you opened it.`, conflict: true };
    }
    const next = text.replace(/\r\n?|\n/g, current.includes('\r\n') ? '\r\n' : '\n');
    clearTimeout(followed.timer);
    // Set first, so the change this write causes does not come back as an outside one.
    followed.text = next;
    // In place, keeping the file's permissions and identity (a rename over it would lose both).
    if (current !== next) await writeFile(absolute, next);
    followed.revision = ++this.revisions;
    return { kind: 'saved', revision: followed.revision };
  }

  private async remove(path: string, absolute: string): Promise<FileReply> {
    try {
      await this.trash(absolute);
    } catch (error) {
      // Never deleted for good instead: the card promised it could be brought back.
      return failedReply(`${basenameOf(path)} could not be moved to the trash: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (await exists(absolute)) return failedReply(`${basenameOf(path)} is still there.`);
    this.unfollow(path);
    this.log.info(`deleted ${path} from the file menu`);
    return { kind: 'deleted' };
  }

  private async rename(path: string, absolute: string, to: string): Promise<FileReply> {
    if (!isWorkspaceId(to)) return failedReply('The new name must be a path inside the workspace.');
    if (to === path) return failedReply(`It is already called ${basenameOf(path)}.`);
    const target = this.absolute(to);
    // On a case-insensitive disk, a change of case alone finds the file itself.
    if (to.toLowerCase() !== path.toLowerCase() && (await exists(target))) return failedReply(`${to} already exists.`);
    await mkdir(dirname(target), { recursive: true });
    await rename(absolute, target);
    if (!(await exists(target))) return failedReply(`${to} did not appear.`);
    const followed = this.followed;
    if (followed?.path === path) {
      followed.watcher?.close();
      Object.assign(followed, { path: to, watcher: this.watch(target) });
    }
    this.log.info(`renamed ${path} to ${to} from the file menu`);
    return { kind: 'renamed', to };
  }

  /** The followed file's directory, since an editor that saves by renaming replaces the file a watcher on it would hold. */
  private watch(absolute: string): FSWatcher | undefined {
    const name = basename(absolute);
    try {
      const watcher = watch(dirname(absolute), { persistent: false }, (_event, changed) => {
        if (changed === name) this.schedule();
      });
      watcher.on('error', () => watcher.close());
      return watcher;
    } catch {
      return undefined;
    }
  }

  private schedule(): void {
    const followed = this.followed;
    if (!followed) return;
    clearTimeout(followed.timer);
    followed.timer = setTimeout(() => void this.refresh(followed), FOLLOW_DEBOUNCE_MS);
  }

  private async refresh(followed: Followed): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.absolute(followed.path), 'utf8');
    } catch {
      return; // gone: the graph update tells the page
    }
    if (this.followed !== followed || text === followed.text) return;
    const base = await baseText(this.root, followed.path);
    if (this.followed !== followed) return;
    followed.text = text;
    followed.revision = ++this.revisions;
    this.outside(followed.id, followed.path, { kind: 'content', text, revision: followed.revision, language: 'plaintext', base, outside: true });
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
