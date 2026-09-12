import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { ConversationHistory } from '@orbit-code/agent/history';
import { isEffort, isModelName, isPermissionMode } from '@orbit-code/agent/options';
import type { SessionService } from '@orbit-code/agent/sessionService';
import type { Disposable, Event } from '@orbit-code/common/event';
import type { Logger } from '@orbit-code/common/log';
import { toColumnar } from '@orbit-code/graph/columnar';
import {
  type ConversationSummary,
  type FileReply,
  type FileRequest,
  type HostCapabilities,
  type HostToWebview,
  MCP_ACTIONS,
  type McpAction,
  PERMISSION_ANSWERS,
  PROTOCOL_VERSION,
  type PermissionAnswer,
  type PermissionRequest,
  type SessionOptions,
  type SessionState,
  type SessionsSnapshot,
  type WebviewToHost,
} from '@orbit-code/protocol';
import { isWorkspaceId } from '@orbit-code/protocol/workspacePath';
import { failedReply, parseFileRequest } from './fileHelpers';
import type { GraphService, GraphStatus, LoadedGraph, WorkspaceFolderInfo } from './graphService';
import { SessionProjector } from './sessionProjector';

/** Skills one prompt can carry. */
const MAX_PROMPT_SKILLS = 8;
/** Files one prompt can carry. */
const MAX_PROMPT_FILES = 20;

/** One page showing Orbit's UI: a VS Code webview panel, an Electron window. */
export interface WebviewTransport {
  /** Dropped until the page has posted `ready`; `onReady` fires on every load, and the snapshot covers anything missed. */
  post(message: HostToWebview): void;
  /** The user can see the page; a permission request while they can't becomes a notification. */
  readonly inSight: boolean;
  readonly onReady: Event<void>;
  readonly onMessage: Event<WebviewToHost>;
  readonly onDidDispose: Event<void>;
}

/** A permission request or questions Claude is waiting on while the page is out of sight. */
export interface PermissionPrompt {
  key: string;
  request: PermissionRequest;
  answer(answer: PermissionAnswer): void;
}

/** What only the host can do for the controller: its dialogs, notifications, browser and editor. */
export interface HostUi {
  readonly capabilities: HostCapabilities;
  /** The folder the graph and sessions are of. */
  folder(): WorkspaceFolderInfo | undefined;
  /** The host's open dialog, starting in `folder`: absolute paths of the files chosen, none when cancelled. */
  pickFiles(folder: string | undefined): Promise<string[]>;
  /** An MCP server's sign-in page, handed over as the string itself. */
  openExternal(url: string): void;
  /** A file a transcript links to, in the host's editor; only called for a path inside the graph's root. */
  openFile(absolute: string): Promise<void>;
  /** Asks the user outside the page. Each request is offered once. */
  notifyPermission(prompt: PermissionPrompt): void;
}

/** What the file menu and the editor sheet do to a workspace file, on the host's terms. Paths are graph ids the controller checked; may throw. */
export interface FileHost extends Disposable {
  handle(id: number, path: string, request: FileRequest): Promise<FileReply>;
  /** Stops following, for one path or whichever file is followed. */
  unfollow(path?: string): void;
}

/**
 * Connects the services to the page showing Orbit: forwards graph, session state and projected activity, and routes
 * the page's requests to the service that owns them, after checking them (the page is untrusted). The only module
 * that knows about all of the others; a host gives it a `HostUi`, a `FileHost` and the page, once there is one.
 */
export class OrbitController implements Disposable {
  private view: WebviewTransport | undefined;
  private viewSubscriptions: Disposable[] = [];
  /** The graph last posted to the current page; an update can only build on that one. */
  private sentHash: string | undefined;
  private lastStatus: GraphStatus | undefined;
  /** Permission requests already offered outside the page, as `key/id`. */
  private readonly notifiedPermissions = new Set<string>();
  /** The conversations last sent to the page; a resume is accepted only for one of them. */
  private conversations: ConversationSummary[] = [];
  private historyGeneration = 0;
  /** Paths the file picker returned: besides graph files, the only ones a prompt may attach. */
  private readonly picked = new Set<string>();
  /** One projector per conversation, keyed like the sessions: each keeps its own transcript. */
  private readonly projectors = new Map<string, SessionProjector>();
  private readonly disposables: Disposable[];

  constructor(
    private readonly log: Logger,
    private readonly graphs: GraphService,
    private readonly session: SessionService,
    private readonly history: ConversationHistory,
    private readonly files: FileHost,
    private readonly ui: HostUi,
  ) {
    this.disposables = [
      graphs.onStatus((status) => {
        this.lastStatus = status;
        this.post({ type: 'status', ...status });
      }),
      graphs.onGraph((loaded) => {
        this.lastStatus = undefined;
        this.sendGraph(loaded, true);
      }),
      session.onState((state) => this.onSessionState(state)),
      session.onSessions((sessions) => this.onSessions(sessions)),
      session.onEvent(({ key, event }) => this.projector(key).project(event)),
      session.onCatalog((catalog) => this.post({ type: 'catalog', catalog })),
    ];
  }

  /** The page showing Orbit from now on, replacing any other. Loads the graph and probes Claude Code if not done yet. */
  attach(view: WebviewTransport): void {
    this.detach();
    this.view = view;
    this.sentHash = undefined;
    this.viewSubscriptions = [
      view.onReady(() => {
        // A reloaded page has no editor sheet open.
        this.files.unfollow();
        this.sendSnapshot();
      }),
      view.onMessage((message) => this.onMessage(message)),
      view.onDidDispose(() => {
        if (this.view !== view) return;
        this.detach();
        this.files.unfollow();
      }),
    ];
    this.graphs.ensureLoaded();
    void this.session.ensureProbed();
  }

  /**
   * A file menu or editor sheet request, also used by the smoke test. Only graph files are touched (closing the sheet
   * excepted), and a delete or rename updates the graph at once instead of after the watcher's debounce.
   */
  async fileRequest(id: unknown, path: unknown, raw: unknown): Promise<FileReply | undefined> {
    if (!Number.isInteger(id) || !isWorkspaceId(path)) return undefined;
    const request = parseFileRequest(raw);
    let reply: FileReply;
    if (!request) reply = failedReply('Orbit did not understand that request.');
    else if (request.kind !== 'close' && this.graphs.current?.resolve(path) === undefined) reply = failedReply(`${path} is not in the graph.`);
    else {
      try {
        reply = await this.files.handle(id as number, path, request);
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        this.log.warn(`file ${request.kind} of ${path} failed: ${text}`);
        reply = failedReply(text);
      }
    }
    this.post({ type: 'file', id: id as number, path, reply });
    if (reply.kind === 'deleted') this.graphs.refresh({ touched: [], deleted: [path] });
    else if (reply.kind === 'renamed') this.graphs.refresh({ touched: [reply.to], deleted: [path] }, [{ from: path, to: reply.to }]);
    return reply;
  }

  /** A `file` reply the host sends on its own: the followed file changed elsewhere. */
  sendFile(id: number, path: string, reply: FileReply): void {
    this.post({ type: 'file', id, path, reply });
  }

  dispose(): void {
    this.detach();
    for (const projector of this.projectors.values()) projector.dispose();
    this.files.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }

  private detach(): void {
    for (const subscription of this.viewSubscriptions) subscription.dispose();
    this.viewSubscriptions = [];
    this.view = undefined;
  }

  private post(message: HostToWebview): void {
    this.view?.post(message);
  }

  /** Everything a freshly loaded (or reloaded) page needs. */
  private sendSnapshot(): void {
    this.post({ type: 'host', capabilities: this.ui.capabilities });
    const loaded = this.graphs.current;
    if (loaded) this.sendGraph(loaded, false);
    else if (this.lastStatus) this.post({ type: 'status', ...this.lastStatus });
    const sessions = this.session.sessions;
    this.post({ type: 'sessions', sessions });
    this.post({ type: 'catalog', catalog: this.session.catalog });
    for (const { key } of sessions.states) this.post({ type: 'transcript', key, reset: true, entries: [...this.projector(key).transcript] });
  }

  /** The projector of the conversation `key`, made on first use; conversations let go take theirs with them. */
  private projector(key: string): SessionProjector {
    let projector = this.projectors.get(key);
    if (!projector) {
      projector = new SessionProjector(key, () => this.graphs.current, {
        activity: (delta) => this.post({ type: 'activity', delta }),
        transcript: (entries, reset) => this.post({ type: 'transcript', key, reset, entries }),
      });
      this.projectors.set(key, projector);
    }
    return projector;
  }

  private onSessions(sessions: SessionsSnapshot): void {
    const kept = new Set(sessions.states.map((state) => state.key));
    for (const [key, projector] of this.projectors) {
      if (kept.has(key)) continue;
      projector.dispose();
      this.projectors.delete(key);
    }
    this.post({ type: 'sessions', sessions });
  }

  /** A live update when the page holds its base graph; otherwise a reset (with the layout, if known). */
  private sendGraph(loaded: LoadedGraph, allowUpdate: boolean): void {
    if (!this.view) return;
    const { graph, update } = loaded;
    const { nodes, edges } = toColumnar(graph);
    const content = { hash: graph.hash, root: loaded.folderName, indexedAt: graph.indexedAt, cached: loaded.cached, stats: graph.stats, nodes, edges };
    const layout = loaded.layout?.hash === graph.hash ? loaded.layout : undefined;
    const delta =
      allowUpdate && update && layout && this.sentHash === update.baseHash
        ? { op: 'update' as const, ...content, ...update, layout }
        : { op: 'reset' as const, ...content, layout };
    this.post({ type: 'graph', delta });
    this.sentHash = graph.hash;
  }

  private onSessionState(state: SessionState): void {
    this.post({ type: 'session', state });
    const request = state.permission;
    // With Orbit out of sight, a permission request would stall the turn unnoticed.
    if (!request || this.notifiedPermissions.has(`${state.key}/${request.id}`) || this.view?.inSight) return;
    this.notifiedPermissions.add(`${state.key}/${request.id}`);
    this.ui.notifyPermission({ key: state.key, request, answer: (answer) => this.session.answerPermission(state.key, request.id, answer) });
  }

  private onMessage(message: WebviewToHost): void {
    switch (message.type) {
      case 'ready':
        if (message.protocol !== PROTOCOL_VERSION) this.log.warn(`webview speaks protocol ${message.protocol}, host ${PROTOCOL_VERSION}`);
        break;
      case 'sceneReady':
        if (message.hash === this.graphs.current?.graph.hash) this.log.info(`scene ready for graph ${message.hash.slice(0, 12)}`);
        break;
      case 'layoutComputed':
        this.graphs.saveLayout(message.layout);
        break;
      case 'reindex':
        void this.graphs.load(true);
        break;
      case 'prompt':
        if (typeof message.text === 'string') this.session.prompt(message.text, this.offeredSkills(message.skills), this.attachableFiles(message.files), typeof message.key === 'string' ? message.key : undefined);
        break;
      case 'interrupt':
        if (typeof message.key === 'string') this.session.interrupt(message.key);
        break;
      case 'newSession':
        this.session.newConversation();
        break;
      case 'refreshCatalog':
        void this.session.refreshCatalog();
        break;
      case 'reloadMcp':
        void this.session.reloadMcp();
        break;
      case 'mcpAction':
        void this.mcpAction(message.server, message.action);
        break;
      case 'loadHistory':
        void this.loadHistory();
        break;
      case 'pickFiles':
        void this.pickFiles();
        break;
      case 'resumeConversation':
        this.resume(message.id);
        break;
      case 'sessionOptions':
        this.setOptions(message.options);
        break;
      case 'permission':
        if (typeof message.key === 'string' && typeof message.id === 'string' && PERMISSION_ANSWERS.includes(message.answer)) this.session.answerPermission(message.key, message.id, message.answer, message.answers);
        break;
      case 'openFile':
        void this.openFile(message.path);
        break;
      case 'file':
        void this.fileRequest(message.id, message.path, message.request);
        break;
      case 'log':
        this.log[message.level](`[webview] ${message.message}`);
        break;
    }
  }

  /** Only skills the catalog lists go with a prompt; anything else from the page is dropped. */
  private offeredSkills(names: unknown): string[] {
    if (!Array.isArray(names)) return [];
    const offered = new Set(this.session.catalog.skills.map((skill) => skill.name));
    return [...new Set(names.filter((name): name is string => typeof name === 'string' && offered.has(name)))].slice(0, MAX_PROMPT_SKILLS);
  }

  /** Only graph files, and files the picker returned, go with a prompt; anything else from the page is dropped. */
  private attachableFiles(paths: unknown): string[] {
    if (!Array.isArray(paths)) return [];
    const loaded = this.graphs.current;
    const attachable = (path: unknown): path is string => typeof path === 'string' && (this.picked.has(path) || (isWorkspaceId(path) && loaded?.resolve(path) !== undefined));
    return [...new Set(paths.filter(attachable))].slice(0, MAX_PROMPT_FILES);
  }

  /** The host's open dialog, in the folder: a file inside it is attached by its workspace-relative path, any other by its absolute one. */
  private async pickFiles(): Promise<void> {
    const folder = this.ui.folder();
    const files = (await this.ui.pickFiles(folder?.path)).map((file) => {
      const rel = folder ? relative(folder.path, file) : '';
      return rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? rel.split(sep).join('/') : file;
    });
    if (files.length === 0) return;
    for (const file of files) this.picked.add(file);
    this.post({ type: 'attachFiles', files });
  }

  /** Earlier conversations of the folder; the page shows the last list while a new one is read. */
  private async loadHistory(): Promise<void> {
    const cwd = this.ui.folder()?.path;
    if (!cwd) {
      this.post({ type: 'history', history: { loading: false, conversations: [], error: 'Open a folder to see its conversations.' } });
      return;
    }
    const generation = ++this.historyGeneration;
    this.post({ type: 'history', history: { loading: true, conversations: this.conversations } });
    try {
      const conversations = await this.history.list(cwd);
      if (generation !== this.historyGeneration) return;
      this.conversations = conversations;
      this.post({ type: 'history', history: { loading: false, conversations } });
    } catch (error) {
      if (generation !== this.historyGeneration) return;
      const text = error instanceof Error ? error.message : String(error);
      this.log.warn(`history unavailable: ${text}`);
      this.post({ type: 'history', history: { loading: false, conversations: this.conversations, error: text } });
    }
  }

  /** Only an action the MCP view offers, on a server the catalog lists; a sign-in page the agent hands back opens in the browser. */
  private async mcpAction(server: unknown, action: unknown): Promise<void> {
    if (typeof server !== 'string' || !MCP_ACTIONS.includes(action as McpAction)) return;
    if (!this.session.catalog.mcpServers.some((known) => known.name === server)) return;
    const authUrl = await this.session.mcpAction(server, action as McpAction);
    if (authUrl) this.ui.openExternal(authUrl);
  }

  /** The id becomes a --resume argument, so only a conversation Orbit listed is accepted. */
  private resume(id: unknown): void {
    const conversation = typeof id === 'string' ? this.conversations.find((candidate) => candidate.id === id) : undefined;
    if (!conversation || !/^[\w-]{1,128}$/.test(conversation.id)) return;
    this.session.resume(conversation.id, conversation.title);
  }

  private setOptions(options: Partial<SessionOptions>): void {
    const next: Partial<SessionOptions> = {};
    if (isModelName(options.model)) next.model = options.model;
    if (isEffort(options.effort)) next.effort = options.effort;
    // bypassPermissions is honoured only from the host's settings, never from the page.
    if (isPermissionMode(options.permissionMode) && options.permissionMode !== 'bypassPermissions') next.permissionMode = options.permissionMode;
    this.session.setOptions(next);
  }

  /** Opens a workspace-relative path from the transcript; anything outside the workspace is ignored. */
  private async openFile(path: unknown): Promise<void> {
    const root = this.graphs.current?.graph.root;
    if (!root || typeof path !== 'string') return;
    const absolute = resolve(root, path);
    const rel = relative(root, absolute);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return;
    try {
      await this.ui.openFile(absolute);
    } catch (error) {
      this.log.warn(`could not open ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
