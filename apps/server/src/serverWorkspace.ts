import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { ClaudeCliBackend } from '@orbit-code/agent/claudeCli';
import { ConversationHistory } from '@orbit-code/agent/history';
import { SessionService } from '@orbit-code/agent/sessionService';
import type { Disposable } from '@orbit-code/common/event';
import type { Logger } from '@orbit-code/common/log';
import { type HostUi, OrbitController, type PermissionPrompt, type WebviewTransport } from '@orbit-code/core/controller';
import { DiskFileHost } from '@orbit-code/core/diskFileHost';
import { FolderWatcher } from '@orbit-code/core/folderWatcher';
import { GraphService, type WorkspaceFolderInfo } from '@orbit-code/core/graphService';
import type { OrbitSettings } from '@orbit-code/core/settings';
import { listFilesOnDisk } from '@orbit-code/indexer/listFiles';
import type { HostCapabilities } from '@orbit-code/protocol';
import { chooseFiles, openUrl, trash } from './system';

export interface ServerWorkspaceOptions {
  /** Absolute path of the folder. */
  path: string;
  log: Logger;
  settings: OrbitSettings;
  /** The folder's graph and layouts go in a directory of their own under `<dataDir>/workspaces`. */
  dataDir: string;
  /** dist/indexer.mjs, beside server.mjs. */
  indexerPath: string;
  /** Claude waits on the page while its tab is out of sight. */
  onPermission(prompt: PermissionPrompt): void;
}

/**
 * The folder the server was started in, composed as the desktop app's Workspace composes it: the graph, Claude's
 * conversations, the disk file host and a recursive watcher, and the shared controller, attached to whichever page the
 * socket server welcomed last. Starting the server in a folder trusts it, as starting `claude` there does. No editor
 * tabs: the page edits files in its own editor sheet.
 */
export class ServerWorkspace implements HostUi, Disposable {
  readonly capabilities: HostCapabilities = { tabs: false };
  readonly info: WorkspaceFolderInfo;
  readonly graphs: GraphService;
  readonly session: SessionService;
  private readonly controller: OrbitController;
  private readonly watcher: FolderWatcher;
  private readonly disposables: Disposable[];

  constructor(private readonly options: ServerWorkspaceOptions) {
    const { path, log, settings } = options;
    this.info = { name: basename(path) || path, path };
    this.graphs = new GraphService({
      storageDir: join(options.dataDir, 'workspaces', createHash('sha1').update(path).digest('hex').slice(0, 16)),
      indexerPath: options.indexerPath,
      log,
      maxFiles: () => settings.maxFiles,
      folder: () => this.info,
      listFiles: (folder, maxFiles) => listFilesOnDisk(folder.path, maxFiles),
    });
    const { claude } = settings;
    this.session = new SessionService(
      new ClaudeCliBackend(() => settings.claude),
      log,
      { model: claude.model, effort: claude.effort, permissionMode: claude.permissionMode },
      () => ({ cwd: path, trusted: true }),
    );
    const files = new DiskFileHost(path, log, trash, (id, file, reply) => this.controller.sendFile(id, file, reply));
    this.controller = new OrbitController(log, this.graphs, this.session, new ConversationHistory(), files, this);
    // Keeps the graph current; a finished turn flushes at once.
    this.watcher = new FolderWatcher(path, log, (changes) => this.graphs.refresh(changes));
    this.disposables = [
      this.session.onEvent(({ event }) => {
        if (event.type === 'turnEnd') this.watcher.flush();
      }),
    ];
  }

  /** The page shown from now on; loads the graph and probes Claude Code if not done yet. */
  attach(page: WebviewTransport): void {
    this.controller.attach(page);
  }

  folder(): WorkspaceFolderInfo {
    return this.info;
  }

  pickFiles(folder: string | undefined): Promise<string[]> {
    return chooseFiles(folder);
  }

  openExternal(url: string): void {
    // Only a web page: the string came from Claude Code's answer for an MCP server's sign-in.
    openUrl(url);
  }

  async openFile(): Promise<void> {
    // No editor tabs (capabilities.tabs): the page opens transcript links in its editor sheet instead of asking.
  }

  notifyPermission(prompt: PermissionPrompt): void {
    this.options.onPermission(prompt);
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
    this.controller.dispose();
    this.watcher.dispose();
    this.session.dispose();
    this.graphs.dispose();
  }
}
