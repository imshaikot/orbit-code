import * as vscode from 'vscode';
import type { AgentCatalog, PermissionAnswer, SessionOptions, SessionState, SessionsSnapshot } from '../../shared/protocol';
import type { AgentAvailability, SessionBackend } from './backend';
import { Conversation, type ConversationContext, type SessionEvent } from './conversation';

export type { SessionEvent, TurnOutcome } from './conversation';

/** A conversation's event, with the conversation it belongs to. */
export interface ConversationEvent {
  key: string;
  event: SessionEvent;
}

/** Conversations kept: past this many, the oldest idle one that is not current is let go. */
const MAX_CONVERSATIONS = 8;

export interface WorkspaceInfo {
  cwd: string | undefined;
  trusted: boolean;
}

/**
 * The agent's conversations in this workspace, each with its own process: a prompt sent while the current one is busy
 * starts another beside it. Owns what they share (the probe, availability, the catalog, the drawer's options) and which
 * one is current: the one the drawer and Orbit Code: Ask Claude… continue, the newest prompted, resumed or started. Only the
 * current conversation keeps its process warm between turns; the others restart theirs with `--resume` when prompted.
 * Knows nothing about graphs or panels.
 */
export class SessionService implements vscode.Disposable {
  private readonly stateEmitter = new vscode.EventEmitter<SessionState>();
  private readonly sessionsEmitter = new vscode.EventEmitter<SessionsSnapshot>();
  private readonly eventEmitter = new vscode.EventEmitter<ConversationEvent>();
  private readonly catalogEmitter = new vscode.EventEmitter<AgentCatalog>();
  /** One conversation's state changed. */
  readonly onState = this.stateEmitter.event;
  /** A conversation was added, let go, or made current. */
  readonly onSessions = this.sessionsEmitter.event;
  readonly onEvent = this.eventEmitter.event;
  readonly onCatalog = this.catalogEmitter.event;
  private catalogState: AgentCatalog = { known: false, loading: false, models: [], skills: [], mcpServers: [] };
  /** Drops catalog answers a newer request superseded. */
  private catalogGeneration = 0;

  private availability: AgentAvailability | undefined;
  private agentName: string | undefined;
  private options: SessionOptions;
  private readonly conversations: Conversation[] = [];
  private currentKey: string;
  private keys = 0;
  private probing: Promise<void> | undefined;
  private disposed = false;
  private readonly context: ConversationContext;

  constructor(
    private readonly backend: SessionBackend,
    private readonly log: vscode.LogOutputChannel,
    defaults: SessionOptions,
    private readonly workspace: () => WorkspaceInfo,
  ) {
    this.options = { ...defaults };
    this.context = {
      backend,
      log,
      options: () => this.options,
      agentName: () => this.agentName,
      cwd: () => this.workspace().cwd,
      unavailableReason: () => this.unavailableReason(),
      mcpStatuses: (servers) => this.updateMcpStatuses(servers),
      probeAgain: () => void this.refresh(),
    };
    this.currentKey = this.open().key;
  }

  /** The current conversation's state: what the drawer continues. */
  get state(): SessionState {
    return this.current.state;
  }

  /** Every conversation, oldest first, and the current one. */
  get sessions(): SessionsSnapshot {
    return { states: this.conversations.map((conversation) => conversation.state), current: this.currentKey };
  }

  /** Whether any conversation has a turn running. */
  get anyBusy(): boolean {
    return this.conversations.some((conversation) => conversation.busy);
  }

  /** Looks for the agent again (first use, or after its settings changed). */
  refresh(): Promise<void> {
    this.probing ??= this.probe().finally(() => (this.probing = undefined));
    return this.probing;
  }

  /** Probes for the agent unless that has happened already. */
  ensureProbed(): Promise<void> {
    return this.availability ? Promise.resolve() : this.refresh();
  }

  /** Re-evaluates what blocks a session: folder, workspace trust, agent availability. */
  workspaceChanged(): void {
    this.refreshAll();
    if (!this.catalogState.known && !this.catalogState.loading) void this.refreshCatalog();
  }

  /** Models, skills and MCP servers the agent offers here; `known` once it has said so. */
  get catalog(): AgentCatalog {
    return this.catalogState;
  }

  /** Asks the agent what it offers in the workspace. Needs the agent, a folder and workspace trust, like a session. */
  async refreshCatalog(): Promise<void> {
    const { cwd, trusted } = this.workspace();
    const backend = this.backend;
    if (!backend.catalog || !this.availability?.available || !cwd || !trusted || this.disposed) return;
    const generation = ++this.catalogGeneration;
    this.setCatalog({ ...this.catalogState, loading: true });
    try {
      const found = await backend.catalog(cwd);
      if (generation !== this.catalogGeneration || this.disposed) return;
      this.setCatalog({ known: found.models.length > 0, loading: false, error: found.error, models: found.models, skills: found.skills, mcpServers: found.mcpServers });
      if (found.error) this.log.warn(`catalog incomplete: ${found.error}`);
      this.log.info(`catalog: ${found.models.length} models, ${found.skills.length} skills, ${found.mcpServers.length} MCP servers`);
    } catch (error) {
      if (generation !== this.catalogGeneration || this.disposed) return;
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn(`catalog incomplete: ${message}`);
      this.setCatalog({ ...this.catalogState, loading: false, error: message });
    }
  }

  /**
   * Sends a prompt and returns the key of the conversation that took it, or undefined (empty, unavailable, or `key`
   * names a conversation that is busy or gone). With `key` the prompt continues that conversation; without one, the
   * current conversation takes it if idle, else a new conversation starts beside it. Either way that one becomes current.
   */
  prompt(text: string, skills: readonly string[] = [], key?: string): string | undefined {
    if (!text.trim() && skills.length === 0) return undefined;
    const opened = key === undefined && this.current.busy ? this.open() : undefined;
    const conversation = opened ?? (key !== undefined ? this.find(key) : this.current);
    if (!conversation || conversation.state.phase !== 'idle') {
      // Busy, unavailable or gone: nothing changes, and a conversation opened for it goes again.
      if (opened) this.close(opened);
      return undefined;
    }
    this.makeCurrent(conversation);
    conversation.prompt(text, skills);
    return conversation.key;
  }

  /**
   * The next prompt continues an earlier conversation of the agent (`--resume`). A conversation already holding it is
   * made current; otherwise the current conversation takes it if it is fresh, else a new one. Returns the key, or
   * undefined if none could.
   */
  resume(sessionId: string, title: string): string | undefined {
    const held = this.conversations.find((conversation) => conversation.state.sessionId === sessionId);
    if (held) {
      this.makeCurrent(held);
      return held.key;
    }
    const conversation = this.current.fresh ? this.current : this.open();
    if (!conversation.continueFrom(sessionId, title)) return undefined;
    this.makeCurrent(conversation);
    return conversation.key;
  }

  /** Stops the conversation `key`, or every running one. */
  interrupt(key?: string): void {
    for (const conversation of this.conversations) {
      if (key === undefined || conversation.key === key) conversation.interrupt();
    }
  }

  answerPermission(key: string, id: string, answer: PermissionAnswer): void {
    this.find(key)?.answerPermission(id, answer);
  }

  /** Options apply from the next prompt of any conversation; a running process is then restarted and resumes its conversation. */
  setOptions(options: Partial<SessionOptions>): void {
    const next = { ...this.options, ...options };
    if (next.model === this.options.model && next.permissionMode === this.options.permissionMode) return;
    this.options = next;
    for (const conversation of this.conversations) this.stateEmitter.fire(conversation.state);
  }

  /** A fresh conversation becomes current (the current one already fresh stays). Returns its key. */
  newConversation(): string {
    if (!this.current.fresh) this.makeCurrent(this.open());
    return this.currentKey;
  }

  dispose(): void {
    this.disposed = true;
    for (const conversation of this.conversations) conversation.dispose();
    this.conversations.length = 0;
    this.stateEmitter.dispose();
    this.sessionsEmitter.dispose();
    this.eventEmitter.dispose();
    this.catalogEmitter.dispose();
  }

  private get current(): Conversation {
    return this.find(this.currentKey) ?? this.conversations[0];
  }

  private find(key: string): Conversation | undefined {
    return this.conversations.find((conversation) => conversation.key === key);
  }

  /** A new conversation, not yet current. Past MAX_CONVERSATIONS, the oldest idle one that is not current goes. */
  private open(): Conversation {
    const conversation = new Conversation(`c${++this.keys}`, this.context, {
      state: (changed) => this.onConversationState(changed),
      event: (changed, event) => {
        if (!this.disposed) this.eventEmitter.fire({ key: changed.key, event });
      },
    });
    this.conversations.push(conversation);
    while (this.conversations.length > MAX_CONVERSATIONS) {
      const spare = this.conversations.find((candidate) => candidate.key !== this.currentKey && candidate !== conversation && !candidate.busy);
      if (!spare) break;
      this.close(spare);
    }
    return conversation;
  }

  private close(conversation: Conversation): void {
    const at = this.conversations.indexOf(conversation);
    if (at < 0) return;
    this.conversations.splice(at, 1);
    conversation.dispose();
    this.log.info(`let go of ${conversation.key}${conversation.state.sessionId ? `, the agent's ${conversation.state.sessionId}` : ''}`);
    if (this.currentKey === conversation.key) this.currentKey = (this.conversations.at(-1) ?? this.open()).key;
    this.emitSessions();
  }

  /** The current conversation keeps its process; a former current lets its idle process go, or does when its turn ends. */
  private makeCurrent(conversation: Conversation): void {
    if (conversation.key === this.currentKey) return;
    const previous = this.current;
    this.currentKey = conversation.key;
    previous.release();
    this.emitSessions();
  }

  private onConversationState(conversation: Conversation): void {
    if (this.disposed) return;
    this.stateEmitter.fire(conversation.state);
    // A turn ended in a conversation that is no longer current: its process is not kept warm.
    if (!conversation.busy && conversation.key !== this.currentKey) conversation.release();
  }

  private async probe(): Promise<void> {
    const availability = await this.backend.probe();
    if (this.disposed) return;
    this.availability = availability;
    if (availability.available) {
      this.agentName = availability.version ? `${availability.name} ${availability.version}` : availability.name;
      this.log.info(`agent: ${this.agentName} at ${availability.detail}`);
    } else {
      this.agentName = undefined;
      this.log.warn(`agent unavailable: ${availability.reason}`);
    }
    this.refreshAll();
    if (availability.available) void this.refreshCatalog();
  }

  private unavailableReason(): string | undefined {
    if (!this.availability) return 'Looking for Claude Code';
    if (!this.availability.available) return this.availability.reason;
    const { cwd, trusted } = this.workspace();
    if (!cwd) return 'Open a folder to start a Claude session.';
    if (!trusted) return 'Claude sessions are off until this workspace is trusted.';
    return undefined;
  }

  private refreshAll(): void {
    for (const conversation of this.conversations) conversation.availabilityChanged();
  }

  private emitSessions(): void {
    if (!this.disposed) this.sessionsEmitter.fire(this.sessions);
  }

  private setCatalog(catalog: AgentCatalog): void {
    this.catalogState = catalog;
    if (!this.disposed) this.catalogEmitter.fire(catalog);
  }

  /** A session's system/init says which MCP servers it has and how each connected; that outranks the catalog's snapshot. */
  private updateMcpStatuses(servers: ReadonlyArray<{ name: string; status: string }>): void {
    const known = new Map(this.catalogState.mcpServers.map((server) => [server.name, server]));
    const next = servers.map((server) => ({ tools: 0, ...known.get(server.name), name: server.name, status: server.status }));
    if (JSON.stringify(next) !== JSON.stringify(this.catalogState.mcpServers)) this.setCatalog({ ...this.catalogState, mcpServers: next });
  }
}
