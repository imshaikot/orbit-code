import { isAbsolute, relative, resolve, sep } from 'node:path';
import * as vscode from 'vscode';
import { toColumnar } from '../shared/columnar';
import { type ConversationSummary, type FileReply, type HostToWebview, PERMISSION_ANSWERS, PROTOCOL_VERSION, type SessionOptions, type SessionState, type SessionsSnapshot, type WebviewToHost } from '../shared/protocol';
import { isWorkspaceId } from '../shared/workspacePath';
import { isEffort, isModelName, isPermissionMode } from './config';
import { FileActions } from './fileActions';
import type { GraphService, GraphStatus, LoadedGraph } from './graph/graphService';
import { OrbitPanel } from './panel/orbitPanel';
import type { ConversationHistory } from './session/history';
import type { SessionService } from './session/sessionService';
import { SessionProjector } from './sessionProjector';

/** Skills one prompt can carry. */
const MAX_PROMPT_SKILLS = 8;
/** Files one prompt can carry. */
const MAX_PROMPT_FILES = 20;

/**
 * Connects the services to the Orbit panel: forwards graph, session state and projected
 * activity to the webview, and routes webview requests to the service that owns them.
 * The only module that knows about all of the others.
 */
export class OrbitController implements vscode.Disposable {
  private panel: OrbitPanel | undefined;
  /** The graph last posted to the current panel; an update can only build on that one. */
  private sentHash: string | undefined;
  private lastStatus: GraphStatus | undefined;
  /** Permission requests already shown as a notification, as `key/id`. */
  private readonly notifiedPermissions = new Set<string>();
  /** The conversations last sent to the webview; a resume is accepted only for one of them. */
  private conversations: ConversationSummary[] = [];
  private historyGeneration = 0;
  /** Paths the file picker returned: besides graph files, the only ones a prompt may attach. */
  private readonly picked = new Set<string>();
  /** One projector per conversation, keyed like the sessions: each keeps its own transcript. */
  private readonly projectors = new Map<string, SessionProjector>();
  private readonly files: FileActions;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly log: vscode.LogOutputChannel,
    private readonly graphs: GraphService,
    private readonly session: SessionService,
    private readonly history: ConversationHistory,
  ) {
    this.files = new FileActions(log, (id, path, reply) => this.post({ type: 'file', id, path, reply }));
    this.disposables.push(
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
    );
  }

  /**
   * Opens the panel or brings it forward. Turning Orbit on collapses the side bar to give the graph the
   * width; `collapseSidebar` does that for an open panel too (Orbit Code: Open, the activity bar icon).
   */
  show(collapseSidebar = false): void {
    if (collapseSidebar || !this.panel) void vscode.commands.executeCommand('workbench.action.closeSidebar');
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const panel = OrbitPanel.create(this.extensionUri);
    this.panel = panel;
    this.sentHash = undefined;
    panel.onReady(() => {
      // A reloaded webview has no editor sheet open.
      this.files.unfollow();
      this.sendSnapshot();
    });
    panel.onMessage((message) => this.onMessage(message));
    panel.onDidDispose(() => {
      if (this.panel !== panel) return;
      this.panel = undefined;
      this.files.unfollow();
    });
    this.graphs.ensureLoaded();
    void this.session.ensureProbed();
  }

  /** `orbit.prompt`: takes the text as an argument (automation) or asks for it. It continues the current conversation, or starts one beside a busy one. */
  async promptCommand(text: string | undefined): Promise<boolean> {
    this.show();
    await this.session.ensureProbed();
    const state = this.session.state;
    if (state.phase === 'unavailable') {
      void vscode.window.showWarningMessage(`Orbit Code: ${state.error ?? 'Claude Code is not available.'}`);
      return false;
    }
    const prompt =
      text ??
      (await vscode.window.showInputBox({
        title: 'Ask Claude',
        prompt: `${state.agent ?? 'Claude Code'} in ${vscode.workspace.workspaceFolders?.[0]?.name ?? 'this workspace'}`,
        placeHolder: 'What should Claude do?',
        ignoreFocusOut: true,
      }));
    return prompt ? this.session.prompt(prompt) !== undefined : false;
  }

  /**
   * A file menu or editor sheet request, also used by the smoke test. Only graph files are touched (closing the sheet
   * excepted), and a delete or rename updates the graph at once instead of after the watcher's debounce.
   */
  async fileRequest(id: unknown, path: unknown, request: unknown): Promise<FileReply | undefined> {
    if (!Number.isInteger(id) || !isWorkspaceId(path)) return undefined;
    const closing = (request as { kind?: unknown } | undefined)?.kind === 'close';
    const reply: FileReply =
      closing || this.graphs.current?.resolve(path) !== undefined
        ? await this.files.handle(id as number, path, request)
        : { kind: 'failed', error: `${path} is not in the graph.` };
    this.post({ type: 'file', id: id as number, path, reply });
    if (reply.kind === 'deleted') this.graphs.refresh({ touched: [], deleted: [path] });
    else if (reply.kind === 'renamed') this.graphs.refresh({ touched: [reply.to], deleted: [path] }, [{ from: path, to: reply.to }]);
    return reply;
  }

  dispose(): void {
    for (const projector of this.projectors.values()) projector.dispose();
    this.files.dispose();
    this.panel?.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }

  private post(message: HostToWebview): void {
    this.panel?.post(message);
  }

  /** Everything a freshly loaded (or reloaded) webview needs. */
  private sendSnapshot(): void {
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

  /** A live update when the webview holds its base graph; otherwise a reset (with the layout, if known). */
  private sendGraph(loaded: LoadedGraph, allowUpdate: boolean): void {
    if (!this.panel) return;
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
    if (request && !this.notifiedPermissions.has(`${state.key}/${request.id}`) && !this.panel?.visible) {
      this.notifiedPermissions.add(`${state.key}/${request.id}`);
      if (request.questions) {
        // Questions are answered on the card, which a notification can't hold: open Orbit, or let Claude go on without them.
        const asked = request.questions.length === 1 ? request.questions[0].question : `${request.questions.length} questions`;
        void vscode.window.showWarningMessage(`Claude asks: ${asked}`, 'Open Orbit', 'Skip').then((choice) => {
          if (choice === 'Open Orbit') this.show();
          else if (choice === 'Skip') this.session.answerPermission(state.key, request.id, 'deny');
        });
        return;
      }
      const choices = request.always ? ['Allow', request.always, 'Deny'] : ['Allow', 'Deny'];
      void vscode.window.showWarningMessage(`Claude wants to use ${request.tool}: ${request.detail}`, ...choices).then((choice) => {
        if (choice) this.session.answerPermission(state.key, request.id, choice === 'Allow' ? 'allow' : choice === 'Deny' ? 'deny' : 'always');
      });
    }
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

  /** Only skills the catalog lists go with a prompt; anything else from the webview is dropped. */
  private offeredSkills(names: unknown): string[] {
    if (!Array.isArray(names)) return [];
    const offered = new Set(this.session.catalog.skills.map((skill) => skill.name));
    return [...new Set(names.filter((name): name is string => typeof name === 'string' && offered.has(name)))].slice(0, MAX_PROMPT_SKILLS);
  }

  /** Only graph files, and files the picker returned, go with a prompt; anything else from the webview is dropped. */
  private attachableFiles(paths: unknown): string[] {
    if (!Array.isArray(paths)) return [];
    const loaded = this.graphs.current;
    const attachable = (path: unknown): path is string => typeof path === 'string' && (this.picked.has(path) || (isWorkspaceId(path) && loaded?.resolve(path) !== undefined));
    return [...new Set(paths.filter(attachable))].slice(0, MAX_PROMPT_FILES);
  }

  /** VS Code's open dialog, in the first folder: a file inside the workspace is attached by its workspace-relative path, any other by its absolute one. */
  private async pickFiles(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const uris = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: true, defaultUri: folder?.uri, openLabel: 'Attach', title: 'Attach files to the prompt' });
    const files = (uris ?? [])
      .filter((uri) => uri.scheme === 'file')
      .map((uri) => {
        const rel = folder ? relative(folder.uri.fsPath, uri.fsPath) : '';
        return rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? rel.split(sep).join('/') : uri.fsPath;
      });
    if (files.length === 0) return;
    for (const file of files) this.picked.add(file);
    this.post({ type: 'attachFiles', files });
  }

  /** Earlier conversations of the first folder; the webview shows the last list while a new one is read. */
  private async loadHistory(): Promise<void> {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
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
    // bypassPermissions is honoured only from VS Code settings, never from the webview.
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
      await vscode.window.showTextDocument(vscode.Uri.file(absolute), { preview: true, viewColumn: vscode.ViewColumn.Beside });
    } catch (error) {
      this.log.warn(`could not open ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
