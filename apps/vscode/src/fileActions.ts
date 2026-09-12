import type { FileHost } from '@orbit-code/core/controller';
import { FOLLOW_DEBOUNCE_MS, type FileReplySink, MAX_SHEET_BYTES, baseText, failedReply, gitState, headText } from '@orbit-code/core/fileHelpers';
import { basenameOf } from '@orbit-code/graph/languages';
import type { FileReply, FileRequest } from '@orbit-code/protocol';
import { isWorkspaceId } from '@orbit-code/protocol/workspacePath';
import * as vscode from 'vscode';

/** Read-only documents holding a file as HEAD has it, for VS Code's diff editor. The path is the workspace-relative id. */
const HEAD_SCHEME = 'orbit-head';

interface Followed {
  id: number;
  path: string;
  uri: vscode.Uri;
  revision: number;
  /** The text last sent, with the document's own line endings. */
  text: string;
  watcher: vscode.FileSystemWatcher;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * What the file menu and the editor sheet do to workspace files in VS Code: git state, the text of the one file the
 * sheet follows and saving it, VS Code tabs and diffs, delete and rename. Edits, deletes and renames go through
 * workspace edits, so VS Code can undo them, open editors stay in step and rename participants (import updates) take
 * part. Paths are graph file ids the controller has checked. Knows nothing about graphs or the panel.
 */
export class FileActions implements FileHost {
  private followed: Followed | undefined;
  private revisions = 0;
  private readonly disposables: vscode.Disposable[];

  /** `outside` receives the followed file's changes made anywhere but the sheet. */
  constructor(
    private readonly log: vscode.LogOutputChannel,
    private readonly outside: FileReplySink,
  ) {
    this.disposables = [
      vscode.workspace.registerTextDocumentContentProvider(HEAD_SCHEME, {
        provideTextDocumentContent: (uri) => {
          const folder = vscode.workspace.workspaceFolders?.[0];
          const id = uri.path.replace(/^\//, '');
          return folder && isWorkspaceId(id) ? headText(rootOf(folder), id) : '';
        },
      }),
      vscode.workspace.onDidChangeTextDocument(({ document }) => {
        if (document.uri.toString() === this.followed?.uri.toString()) this.schedule();
      }),
    ];
  }

  async handle(id: number, path: string, request: FileRequest): Promise<FileReply> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return failedReply('No workspace folder is open.');
    const uri = vscode.Uri.joinPath(folder.uri, ...path.split('/'));
    switch (request.kind) {
      case 'info':
        return { kind: 'info', git: await gitState(rootOf(folder), path) };
      case 'read':
        return this.read(id, path, uri, folder);
      case 'write':
        return this.write(path, uri, request);
      case 'close':
        this.unfollow(path);
        return { kind: 'closed' };
      case 'show':
        return this.show(path, uri, request.diff);
      case 'delete':
        return this.remove(path, uri);
      case 'rename':
        return this.rename(path, uri, request.to, folder);
    }
  }

  /** Stops following, for one path or whichever file is followed. */
  unfollow(path?: string): void {
    const followed = this.followed;
    if (!followed || (path !== undefined && followed.path !== path)) return;
    clearTimeout(followed.timer);
    followed.watcher.dispose();
    this.followed = undefined;
  }

  dispose(): void {
    this.unfollow();
    for (const disposable of this.disposables) disposable.dispose();
  }

  private async read(id: number, path: string, uri: vscode.Uri, folder: vscode.WorkspaceFolder): Promise<FileReply> {
    const { size } = await vscode.workspace.fs.stat(uri);
    if (size > MAX_SHEET_BYTES) return failedReply(`${basenameOf(path)} is ${(size / 1024 / 1024).toFixed(1)} MB, too large for the editor here. Open it in a tab.`);
    // The document, not the disk: unsaved edits in a VS Code tab show, and saving goes through the same buffer.
    const document = await vscode.workspace.openTextDocument(uri);
    const base = await baseText(rootOf(folder), path);
    this.unfollow();
    this.followed = { id, path, uri, revision: ++this.revisions, text: document.getText(), watcher: this.watch(folder, path), timer: undefined };
    return { kind: 'content', text: this.followed.text, revision: this.followed.revision, language: document.languageId, base, outside: false };
  }

  private async write(path: string, uri: vscode.Uri, { text, revision, force }: { text: string; revision: number; force: boolean }): Promise<FileReply> {
    const followed = this.followed;
    if (followed?.path !== path) return failedReply(`${basenameOf(path)} is not open in the editor.`);
    const document = await vscode.workspace.openTextDocument(uri);
    if (!force && (revision !== followed.revision || document.getText() !== followed.text)) {
      return { kind: 'failed', error: `${basenameOf(path)} changed after you opened it.`, conflict: true };
    }
    const next = text.replace(/\r\n?|\n/g, document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n');
    clearTimeout(followed.timer);
    // Set first, so the change this edit causes does not come back as an outside one.
    followed.text = next;
    const current = document.getText();
    if (current !== next) {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(current.length)), next);
      if (!(await vscode.workspace.applyEdit(edit))) return failedReply(`VS Code did not apply the edit to ${basenameOf(path)}.`);
    }
    if (document.isDirty && !(await document.save())) return failedReply(`${basenameOf(path)} was not saved.`);
    followed.revision = ++this.revisions;
    // Format on save may have changed it again; that reaches the sheet as an outside change.
    if (document.getText() !== followed.text) this.schedule();
    return { kind: 'saved', revision: followed.revision };
  }

  private async show(path: string, uri: vscode.Uri, diff: boolean): Promise<FileReply> {
    const options: vscode.TextDocumentShowOptions = { preview: false, viewColumn: vscode.ViewColumn.Beside };
    if (diff) {
      const head = vscode.Uri.from({ scheme: HEAD_SCHEME, path: `/${path}` });
      await vscode.commands.executeCommand('vscode.diff', head, uri, `${basenameOf(path)} (HEAD ↔ Working Tree)`, options);
    } else {
      await vscode.commands.executeCommand('vscode.open', uri, options);
    }
    return { kind: 'shown' };
  }

  private async remove(path: string, uri: vscode.Uri): Promise<FileReply> {
    const edit = new vscode.WorkspaceEdit();
    edit.deleteFile(uri, { ignoreIfNotExists: true });
    if (!(await vscode.workspace.applyEdit(edit))) return failedReply(`VS Code did not delete ${basenameOf(path)}.`);
    if (await exists(uri)) return failedReply(`${basenameOf(path)} is still there.`);
    this.unfollow(path);
    this.log.info(`deleted ${path} from the file menu`);
    return { kind: 'deleted' };
  }

  private async rename(path: string, uri: vscode.Uri, to: string, folder: vscode.WorkspaceFolder): Promise<FileReply> {
    if (!isWorkspaceId(to)) return failedReply('The new name must be a path inside the workspace.');
    if (to === path) return failedReply(`It is already called ${basenameOf(path)}.`);
    const target = vscode.Uri.joinPath(folder.uri, ...to.split('/'));
    // On a case-insensitive disk, a change of case alone finds the file itself.
    if (to.toLowerCase() !== path.toLowerCase() && (await exists(target))) return failedReply(`${to} already exists.`);
    const edit = new vscode.WorkspaceEdit();
    edit.renameFile(uri, target, { overwrite: false });
    if (!(await vscode.workspace.applyEdit(edit))) return failedReply(`VS Code did not rename ${basenameOf(path)}.`);
    if (!(await exists(target))) return failedReply(`${to} did not appear.`);
    const followed = this.followed;
    if (followed?.path === path) {
      followed.watcher.dispose();
      Object.assign(followed, { path: to, uri: target, watcher: this.watch(folder, to) });
    }
    this.log.info(`renamed ${path} to ${to} from the file menu`);
    return { kind: 'renamed', to };
  }

  /** A watcher for the followed file, since a document nobody shows stops tracking the disk after a while. */
  private watch(folder: vscode.WorkspaceFolder, path: string): vscode.FileSystemWatcher {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, path.replace(/[[\]{}()*?!]/g, '[$&]')), false, false, true);
    watcher.onDidChange(() => this.schedule());
    watcher.onDidCreate(() => this.schedule());
    return watcher;
  }

  private schedule(): void {
    const followed = this.followed;
    if (!followed) return;
    clearTimeout(followed.timer);
    followed.timer = setTimeout(() => void this.refresh(followed), FOLLOW_DEBOUNCE_MS);
  }

  private async refresh(followed: Followed): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    let document: vscode.TextDocument;
    try {
      document = await vscode.workspace.openTextDocument(followed.uri);
    } catch {
      return; // gone: the graph update tells the webview
    }
    const text = document.getText();
    if (this.followed !== followed || text === followed.text || !folder) return;
    const base = await baseText(rootOf(folder), followed.path);
    if (this.followed !== followed) return;
    followed.text = text;
    followed.revision = ++this.revisions;
    this.outside(followed.id, followed.path, { kind: 'content', text, revision: followed.revision, language: document.languageId, base, outside: true });
  }
}

/** The folder on disk git runs in; none for a remote folder. */
function rootOf(folder: vscode.WorkspaceFolder): string | undefined {
  return folder.uri.scheme === 'file' ? folder.uri.fsPath : undefined;
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}
