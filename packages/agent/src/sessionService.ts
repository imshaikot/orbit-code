import { type Disposable, Emitter } from '@orbit-code/common/event';
import type { Logger } from '@orbit-code/common/log';
import type { AgentCatalog, McpAction, McpServerInfo, McpState, PermissionAnswer, SessionOptions, SessionState, SessionsSnapshot } from '@orbit-code/protocol';
import type { AgentAvailability, AgentControl, SessionBackend } from './backend';
import { Conversation, type ConversationContext, type SessionEvent } from './conversation';
import { scrubError } from './streamJson';

export type { SessionEvent, TurnOutcome } from './conversation';

/** A conversation's event, with the conversation it belongs to. */
export interface ConversationEvent {
  key: string;
  event: SessionEvent;
}

/** Conversations kept: past this many, the oldest idle one that is not current is let go. */
const MAX_CONVERSATIONS = 8;
/** The MCP view's process is let go once it has gone unused this long, unless a sign-in is still awaited. */
const CONTROL_IDLE_MS = 5 * 60_000;
/** While MCP servers are still connecting, they are asked about again this often, this many times at most. */
const MCP_POLL_MS = 1000;
const MCP_POLLS = 20;
/** After a sign-in page opened, the server is asked about this often until it connects, or the wait is over. */
const SIGN_IN_POLL_MS = 2000;
const SIGN_IN_WAIT_MS = 5 * 60_000;
/** An MCP action the agent has not answered by then is given up on. */
const MCP_ACTION_TIMEOUT_MS = 60_000;

const MCP_VERBS: Record<McpAction, string> = { reconnect: 'reconnect', enable: 'enable', disable: 'disable', signIn: 'sign in to', signOut: 'sign out of' };
const MCP_DONE: Record<McpAction, string> = {
  reconnect: 'Reconnected.',
  enable: 'Enabled in your Claude Code settings. Each conversation loads it from its next prompt.',
  disable: 'Disabled in your Claude Code settings. Each conversation goes without it from its next prompt.',
  signIn: 'Signed in.',
  signOut: 'Signed out.',
};

export interface WorkspaceInfo {
  cwd: string | undefined;
  trusted: boolean;
}

/**
 * The agent's conversations in this workspace, each with its own process: a prompt sent while the current one is busy
 * starts another beside it. Owns what they share (the probe, availability, the catalog, the drawer's options, the MCP
 * view's process) and which one is current: the one the drawer and Orbit Code: Ask Claude… continue, the newest
 * prompted, resumed or started. Only the current conversation keeps its process warm between turns; the others restart
 * theirs with `--resume` when prompted. Knows nothing about graphs or panels.
 */
export class SessionService implements Disposable {
  private readonly stateEmitter = new Emitter<SessionState>();
  private readonly sessionsEmitter = new Emitter<SessionsSnapshot>();
  private readonly eventEmitter = new Emitter<ConversationEvent>();
  private readonly catalogEmitter = new Emitter<AgentCatalog>();
  /** One conversation's state changed. */
  readonly onState = this.stateEmitter.event;
  /** A conversation was added, let go, or made current. */
  readonly onSessions = this.sessionsEmitter.event;
  readonly onEvent = this.eventEmitter.event;
  readonly onCatalog = this.catalogEmitter.event;
  private catalogState: AgentCatalog = { known: false, loading: false, models: [], skills: [], mcpServers: [], mcp: { loading: false } };
  /** Drops catalog answers a newer request superseded. */
  private catalogGeneration = 0;

  /** The MCP view's process, started by its first Reload or action and let go once unused. */
  private control: AgentControl | undefined;
  private controlIdle: ReturnType<typeof setTimeout> | undefined;
  /** Drops MCP answers a Reload superseded. */
  private mcpGeneration = 0;
  /** Per server, the MCP view's action under way or how the last one went, laid over whatever reported the servers. */
  private readonly mcpMarks = new Map<string, { pending?: McpAction; note?: string }>();
  /** Sign-ins whose page opened and whose callback the MCP view's process still waits for. */
  private signingIn = 0;

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
    private readonly log: Logger,
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
      this.setCatalog({
        known: found.models.length > 0,
        loading: false,
        error: found.error,
        models: found.models,
        skills: found.skills,
        mcpServers: this.marked(found.mcpServers),
        mcp: { ...this.mcpState, checkedAt: Date.now() },
      });
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
   * The MCP view's Reload: a new process loads every MCP server afresh, so servers added to the configuration since show
   * up, and is asked about them until none is still connecting. Each answer goes out as a catalog.
   */
  async reloadMcp(): Promise<void> {
    const control = this.openControl(true);
    if (!control) {
      this.setMcp({ loading: false, error: this.unavailableReason() ?? 'Claude Code cannot be asked about MCP servers here.' });
      return;
    }
    const generation = ++this.mcpGeneration;
    for (const [name, mark] of this.mcpMarks) if (!mark.pending) this.mcpMarks.delete(name);
    this.setMcp({ loading: true, error: undefined });
    try {
      await this.pollMcp(control, generation);
      if (generation !== this.mcpGeneration || this.disposed) return;
      this.setMcp({ loading: false });
      this.log.info(`mcp: ${describeServers(this.catalogState.mcpServers)}`);
    } catch (error) {
      if (generation !== this.mcpGeneration || this.disposed) return;
      const message = errorText(error);
      this.log.warn(`mcp: could not ask about the servers: ${message}`);
      this.setMcp({ loading: false, error: message });
    }
  }

  /**
   * Reconnects, enables, disables, signs in to or signs out of the MCP server `name`, through the MCP view's process
   * (started for it if need be). Resolves with the page to sign in on, when the agent needs the user to open one.
   * Enabling, disabling and signing in or out apply to each conversation from its next prompt.
   */
  async mcpAction(name: string, action: McpAction): Promise<string | undefined> {
    if (this.mcpMarks.get(name)?.pending) return undefined;
    const control = this.openControl(false);
    if (!control) return undefined;
    const generation = this.mcpGeneration;
    const transport = this.catalogState.mcpServers.find((server) => server.name === name)?.transport;
    this.mark(name, { pending: action });
    try {
      const { authUrl } = await withTimeout(control.mcpAction(name, action), MCP_ACTION_TIMEOUT_MS, 'Claude Code did not answer in time.');
      this.log.info(`mcp: ${action} ${name}${authUrl ? ', sign-in page opened' : ''}`);
      // A session loads MCP servers and their sign-ins when its process starts.
      if (action !== 'reconnect') for (const conversation of this.conversations) conversation.reloadAgent();
      if (!authUrl) {
        this.mark(name, { note: MCP_DONE[action] });
        await this.pollMcp(control, generation).catch(() => undefined);
      } else if (transport === 'claudeai-proxy') {
        // A claude.ai connector is authorised on claude.ai, which never calls back here.
        this.mark(name, { note: 'Connect it on the claude.ai page that opened, then Reconnect.' });
      } else {
        this.mark(name, { note: 'Finish signing in on the page that opened. It connects once you have.' });
        void this.awaitSignIn(control, name, generation);
      }
      return authUrl;
    } catch (error) {
      if (this.disposed) return undefined;
      const message = errorText(error);
      this.log.warn(`mcp: could not ${MCP_VERBS[action]} ${name}: ${message}`);
      this.mark(name, { note: `Could not ${MCP_VERBS[action]} it: ${message}` });
      return undefined;
    }
  }

  /**
   * Sends a prompt and returns the key of the conversation that took it, or undefined (empty, unavailable, or `key`
   * names a conversation that is busy or gone). `skills` are invoked with it and `files` go with it as context. With `key`
   * the prompt continues that conversation; without one, the current conversation takes it if idle, else a new
   * conversation starts beside it. Either way that one becomes current.
   */
  prompt(text: string, skills: readonly string[] = [], files: readonly string[] = [], key?: string): string | undefined {
    if (!text.trim() && skills.length === 0 && files.length === 0) return undefined;
    const opened = key === undefined && this.current.busy ? this.open() : undefined;
    const conversation = opened ?? (key !== undefined ? this.find(key) : this.current);
    if (!conversation || conversation.state.phase !== 'idle') {
      // Busy, unavailable or gone: nothing changes, and a conversation opened for it goes again.
      if (opened) this.close(opened);
      return undefined;
    }
    this.makeCurrent(conversation);
    conversation.prompt(text, skills, files);
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

  /** `answers`: for a request asking questions, unchecked; the conversation checks them against the request. */
  answerPermission(key: string, id: string, answer: PermissionAnswer, answers?: unknown): void {
    this.find(key)?.answerPermission(id, answer, answers);
  }

  /** Options apply from the next prompt of any conversation; a running process is then restarted and resumes its conversation. */
  setOptions(options: Partial<SessionOptions>): void {
    const next = { ...this.options, ...options };
    if (next.model === this.options.model && next.effort === this.options.effort && next.permissionMode === this.options.permissionMode) return;
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
    clearTimeout(this.controlIdle);
    this.control?.dispose();
    this.control = undefined;
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
    const next = this.marked(
      servers.map((server) => {
        const { error, ...before } = known.get(server.name) ?? { name: server.name, status: server.status, tools: 0 };
        return { ...before, name: server.name, status: server.status, ...(error && server.status === 'failed' ? { error } : {}) };
      }),
    );
    if (JSON.stringify(next) !== JSON.stringify(this.catalogState.mcpServers)) this.setCatalog({ ...this.catalogState, mcpServers: next, mcp: { ...this.mcpState, checkedAt: Date.now() } });
  }

  private get mcpState(): McpState {
    return this.catalogState.mcp ?? { loading: false };
  }

  private setMcp(state: Partial<McpState>): void {
    this.setCatalog({ ...this.catalogState, mcp: { ...this.mcpState, ...state } });
  }

  private setMcpServers(servers: readonly McpServerInfo[]): void {
    this.setCatalog({ ...this.catalogState, mcpServers: this.marked(servers), mcp: { ...this.mcpState, checkedAt: Date.now() } });
  }

  /** Servers with the MCP view's action under way, or the last one's outcome, on each. */
  private marked(servers: readonly McpServerInfo[]): McpServerInfo[] {
    return servers.map(({ pending: _pending, note: _note, ...server }) => {
      const mark = this.mcpMarks.get(server.name);
      return { ...server, ...(mark?.pending ? { pending: mark.pending } : {}), ...(mark?.note ? { note: mark.note } : {}) };
    });
  }

  /** An action under way (`pending`) or how one went (`note`) for the server `name`, published at once. */
  private mark(name: string, mark: { pending?: McpAction; note?: string }): void {
    this.mcpMarks.set(name, mark);
    if (!this.disposed) this.setCatalog({ ...this.catalogState, mcpServers: this.marked(this.catalogState.mcpServers) });
  }

  /** The MCP view's process: the one running, or a new one (`fresh` replaces it). Only where a session could run. */
  private openControl(fresh: boolean): AgentControl | undefined {
    const { cwd, trusted } = this.workspace();
    if (!this.backend.control || !this.availability?.available || !cwd || !trusted || this.disposed) return undefined;
    if (fresh || !this.control?.alive) {
      this.control?.dispose();
      this.control = this.backend.control(cwd);
    }
    this.touchControl();
    return this.control;
  }

  /** Lets the MCP view's process go once it has gone unused for a while, but not while a sign-in page may still call back. */
  private touchControl(): void {
    clearTimeout(this.controlIdle);
    this.controlIdle = setTimeout(() => {
      if (this.signingIn > 0) {
        this.touchControl();
        return;
      }
      this.control?.dispose();
      this.control = undefined;
    }, CONTROL_IDLE_MS);
  }

  /** Asks about every server, again while any is still connecting; each answer is published. */
  private async pollMcp(control: AgentControl, generation: number): Promise<void> {
    for (let polls = 1; ; polls++) {
      const servers = await control.mcpStatus();
      if (generation !== this.mcpGeneration || this.disposed) return;
      this.setMcpServers(servers);
      if (polls >= MCP_POLLS || !servers.some((server) => server.status === 'pending')) return;
      await delay(MCP_POLL_MS);
    }
  }

  /** After a sign-in page opened: asks about the server until it connects, keeping the process that waits for the page's callback. */
  private async awaitSignIn(control: AgentControl, name: string, generation: number): Promise<void> {
    this.signingIn++;
    const giveUpAt = Date.now() + SIGN_IN_WAIT_MS;
    try {
      while (control.alive && Date.now() < giveUpAt) {
        await delay(SIGN_IN_POLL_MS);
        if (generation !== this.mcpGeneration || this.disposed) return;
        const servers = await control.mcpStatus();
        if (generation !== this.mcpGeneration || this.disposed) return;
        const status = servers.find((server) => server.name === name)?.status;
        if (status !== 'needs-auth' && status !== 'pending') {
          this.mcpMarks.set(name, { note: status === 'connected' ? MCP_DONE.signIn : `Signed in, and it is ${status ?? 'no longer listed'}.` });
          this.setMcpServers(servers);
          for (const conversation of this.conversations) conversation.reloadAgent();
          this.log.info(`mcp: signed in to ${name}, ${status ?? 'no longer listed'}`);
          return;
        }
        this.setMcpServers(servers);
      }
      if (generation === this.mcpGeneration && !this.disposed) this.mark(name, { note: 'Not signed in yet. Sign in again for a new page.' });
    } catch {
      // The process ended; Reload asks again.
    } finally {
      this.signingIn--;
      if (!this.disposed && this.control) this.touchControl();
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

function errorText(error: unknown): string {
  return scrubError(error instanceof Error ? error.message : String(error));
}

/** `5 servers: 2 connected, 2 needs-auth, 1 failed`, for Orbit.log. */
function describeServers(servers: readonly McpServerInfo[]): string {
  const counts = new Map<string, number>();
  for (const server of servers) counts.set(server.status, (counts.get(server.status) ?? 0) + 1);
  return `${servers.length} servers${counts.size > 0 ? `: ${[...counts].map(([status, count]) => `${count} ${status}`).join(', ')}` : ''}`;
}
