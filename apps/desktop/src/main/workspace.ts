import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { ClaudeCliBackend } from '@orbit-code/agent/claudeCli';
import { ConversationHistory } from '@orbit-code/agent/history';
import { SessionService } from '@orbit-code/agent/sessionService';
import type { Disposable } from '@orbit-code/common/event';
import type { Logger } from '@orbit-code/common/log';
import { type HostUi, OrbitController, type PermissionPrompt } from '@orbit-code/core/controller';
import { DiskFileHost } from '@orbit-code/core/diskFileHost';
import { FolderWatcher } from '@orbit-code/core/folderWatcher';
import { GraphService, type WorkspaceFolderInfo } from '@orbit-code/core/graphService';
import { type OrbitSettings, applySettings } from '@orbit-code/core/settings';
import { listFilesOnDisk } from '@orbit-code/indexer/listFiles';
import type { HostCapabilities, SessionState } from '@orbit-code/protocol';
import { dialog, shell } from 'electron';
import { notifyPermission } from './notifications';
import type { OrbitWindow } from './window';

export interface WorkspaceOptions {
  /** Absolute path of the folder. */
  path: string;
  window: OrbitWindow;
  log: Logger;
  settings: () => OrbitSettings;
  /** Each folder's graph and layouts go in a directory of their own inside this one. */
  storageRoot: string;
  /** dist/indexer.mjs, outside the asar. */
  indexerPath: string;
  trusted: () => boolean;
  /** A conversation's state changed: the tray and dock follow. */
  sessionsChanged: () => void;
}

/**
 * One open folder in one window: the engine a VS Code window runs, composed as apps/vscode/src/extension.ts composes
 * it, with the desktop's dialogs, notifications, file host and watcher. No editor tabs: the page edits files in its
 * own editor sheet.
 */
export class Workspace implements HostUi, Disposable {
  readonly capabilities: HostCapabilities = { tabs: false };
  readonly info: WorkspaceFolderInfo;
  readonly window: OrbitWindow;
  readonly graphs: GraphService;
  readonly session: SessionService;
  private readonly controller: OrbitController;
  private readonly watcher: FolderWatcher;
  private readonly disposables: Disposable[];

  constructor(options: WorkspaceOptions) {
    const { path, window, log, settings } = options;
    this.info = { name: basename(path) || path, path };
    this.window = window;
    this.graphs = new GraphService({
      storageDir: join(options.storageRoot, createHash('sha1').update(path).digest('hex').slice(0, 16)),
      indexerPath: options.indexerPath,
      log,
      maxFiles: () => settings().maxFiles,
      folder: () => this.info,
      listFiles: (folder, maxFiles) => listFilesOnDisk(folder.path, maxFiles),
    });
    const { claude } = settings();
    this.session = new SessionService(
      new ClaudeCliBackend(() => settings().claude),
      log,
      { model: claude.model, effort: claude.effort, permissionMode: claude.permissionMode },
      () => ({ cwd: path, trusted: options.trusted() }),
    );
    const files = new DiskFileHost(path, log, (absolute) => shell.trashItem(absolute), (id, file, reply) => this.controller.sendFile(id, file, reply));
    this.controller = new OrbitController(log, this.graphs, this.session, new ConversationHistory(), files, this);
    // Keeps the graph current; a finished turn flushes at once.
    this.watcher = new FolderWatcher(path, log, (changes) => this.graphs.refresh(changes));
    this.disposables = [
      this.session.onEvent(({ event }) => {
        if (event.type === 'turnEnd') this.watcher.flush();
      }),
      this.session.onState(() => options.sessionsChanged()),
      this.session.onSessions(() => options.sessionsChanged()),
    ];
    window.setTitle(`${this.info.name} — Orbit Code`);
    this.controller.attach(window);
  }

  get states(): readonly SessionState[] {
    return this.session.sessions.states;
  }

  /** The folder was trusted: sessions may start now. */
  trustChanged(): void {
    this.session.workspaceChanged();
  }

  settingsChanged(previous: OrbitSettings, next: OrbitSettings): void {
    applySettings(previous, next, this.session);
  }

  folder(): WorkspaceFolderInfo {
    return this.info;
  }

  async pickFiles(folder: string | undefined): Promise<string[]> {
    const result = await dialog.showOpenDialog(this.window.window, { title: 'Attach files to the prompt', buttonLabel: 'Attach', defaultPath: folder, properties: ['openFile', 'multiSelections'] });
    return result.canceled ? [] : result.filePaths;
  }

  openExternal(url: string): void {
    // Only a web page: the string came from Claude Code's answer for an MCP server's sign-in.
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  }

  async openFile(): Promise<void> {
    // No editor tabs (capabilities.tabs): the page opens transcript links in its editor sheet instead of asking.
  }

  notifyPermission(prompt: PermissionPrompt): void {
    notifyPermission(prompt, this.info.name, () => this.window.reveal());
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
    this.controller.dispose();
    this.watcher.dispose();
    this.session.dispose();
    this.graphs.dispose();
  }
}
