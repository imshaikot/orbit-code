import type { Logger } from '@orbit-code/common/log';
import type { PermissionAnswer, PermissionRequest, SessionOptions, SessionPhase, SessionState } from '@orbit-code/protocol';
import type { AgentExit, AgentProcess, SessionBackend } from './backend';
import { type PermissionUpdate, describeAlways } from './permissions';
import { checkAnswers, describeAnswers, parseQuestions } from './questions';
import type { AgentEvent } from './streamJson';
import { summarizeTool } from './tools';

const INTERRUPT_GRACE_MS = 5000;
/** Why a skipped AskUserQuestion call returned nothing, as Claude reads it. */
const SKIPPED_MESSAGE = 'The user skipped these questions in Orbit.';

export type TurnOutcome = 'done' | 'interrupted' | 'failed';

/** Conversation-level events, independent of how the agent is run. `agent`: a subagent did it, named by the id of the tool call running it. */
export type SessionEvent =
  /** `skills`: invoked with the prompt, when any are attached; `files`: attached to it as context. */
  | { type: 'prompt'; text: string; skills?: string[]; files?: string[] }
  | { type: 'thinking'; agent?: string }
  | { type: 'text'; text: string; agent?: string }
  | { type: 'toolUse'; name: string; input: Record<string, unknown>; agent?: string }
  | { type: 'toolError'; tool: string; message: string; agent?: string }
  | { type: 'toolDone'; tool: string; agent?: string }
  /** A subagent's first sign of work: `name` is its type (the call's `subagent_type`), else the tool's; `detail` what it was asked. */
  | { type: 'agentStart'; agent: string; name: string; detail: string }
  /** Its tool call returned, or the turn ended before it did. */
  | { type: 'agentEnd'; agent: string; name: string; detail: string; outcome: TurnOutcome }
  | { type: 'turnEnd'; outcome: TurnOutcome; durationMs: number; costUsd: number; message?: string }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; text: string };

/** What every conversation shares: the agent, where it runs, and the options the drawer picked. */
export interface ConversationContext {
  readonly backend: SessionBackend;
  readonly log: Logger;
  /** The options a process is started with; a running process whose options differ restarts at the next prompt. */
  options(): SessionOptions;
  agentName(): string | undefined;
  cwd(): string | undefined;
  /** Why no conversation can run right now (no agent, no folder, no trust), or undefined. */
  unavailableReason(): string | undefined;
  /** A conversation's system/init said which MCP servers it has and how each connected. */
  mcpStatuses(servers: ReadonlyArray<{ name: string; status: string }>): void;
  /** The agent process could not be started at all: look for the agent again. */
  probeAgain(): void;
}

export interface ConversationSink {
  state(conversation: Conversation): void;
  event(conversation: Conversation, event: SessionEvent): void;
}

/** The `agent` of what a subagent did, from the id of the tool call running it; nothing for the conversation's own. */
function agentOf(parent: string | undefined): { agent?: string } {
  return parent === undefined ? {} : { agent: parent };
}

/**
 * One agent conversation: prompts, turns, permission requests, interrupts and resumption. It owns its agent process
 * (restarting it with the conversation id when options change, it died, or it was let go while idle) and knows
 * nothing about other conversations, graphs or panels. `key` is Orbit's own id; `sessionId` the agent's.
 */
export class Conversation {
  private phase: SessionPhase = 'unavailable';
  private error: string | undefined;
  private sessionId: string | undefined;
  private model: string | undefined;
  private turns = 0;
  private costUsd = 0;

  private agent: AgentProcess | undefined;
  /** What the running process was started with; a mismatch restarts it before the next prompt. */
  private agentOptions: SessionOptions | undefined;
  /** total_cost_usd is cumulative per process; this is the last value seen from the current one. */
  private agentCost = 0;
  private turnOpen = false;
  /** The one request waiting for an answer, with what the webview never sees: the tool input and the agent's suggestions. */
  private permission: (PermissionRequest & { input: Record<string, unknown>; suggestions: PermissionUpdate[] }) | undefined;
  /** This turn's tool calls by id: the tool, named again when its result comes, and what a subagent it runs is called. */
  private readonly tools = new Map<string, { name: string; agentName: string; detail: string }>();
  /** This turn's subagents, by the id of the tool call running each: true until that call returns. */
  private readonly agents = new Map<string, boolean>();
  private interruptTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(
    readonly key: string,
    private readonly context: ConversationContext,
    private readonly sink: ConversationSink,
  ) {
    this.error = context.unavailableReason();
    this.phase = this.error ? 'unavailable' : 'idle';
  }

  get state(): SessionState {
    const permission = this.permission;
    return {
      key: this.key,
      phase: this.phase,
      error: this.error,
      agent: this.context.agentName(),
      sessionId: this.sessionId,
      model: this.model,
      options: { ...this.context.options() },
      turns: this.turns,
      costUsd: this.costUsd,
      permission: permission && {
        id: permission.id,
        tool: permission.tool,
        detail: permission.detail,
        ...(permission.always ? { always: permission.always } : {}),
        ...(permission.questions ? { questions: permission.questions } : {}),
      },
    };
  }

  get busy(): boolean {
    return this.phase === 'working' || this.phase === 'stopping';
  }

  /** Nothing asked yet, nothing to continue: a prompt here starts the agent's conversation from scratch. */
  get fresh(): boolean {
    return this.turns === 0 && this.sessionId === undefined && !this.busy;
  }

  /** Returns false when the prompt was not accepted (empty, busy, or unavailable). `skills` are invoked with it, `files` go with it as context. */
  prompt(text: string, skills: readonly string[] = [], files: readonly string[] = []): boolean {
    const trimmed = text.trim();
    const cwd = this.context.cwd();
    if ((!trimmed && skills.length === 0 && files.length === 0) || this.phase !== 'idle' || !cwd) return false;
    const options = this.context.options();
    if (this.agent && !sameOptions(this.agentOptions, options)) this.stopAgent();
    const agent = this.agent ?? this.startAgent(cwd, options);
    this.phase = 'working';
    this.error = undefined;
    this.turnOpen = true;
    this.sink.event(this, { type: 'prompt', text: trimmed, skills: [...skills], ...(files.length > 0 ? { files: [...files] } : {}) });
    agent.prompt(trimmed, skills, files);
    this.emitState();
    return true;
  }

  /** The next prompt continues the agent's conversation `sessionId` (`--resume`). Only for a fresh conversation. */
  continueFrom(sessionId: string, title: string): boolean {
    if (!this.fresh) return false;
    this.sessionId = sessionId;
    this.context.log.info(`resume requested for ${sessionId}`);
    this.sink.event(this, { type: 'notice', level: 'info', text: `Continuing “${title}”. The next prompt picks it up where it left off.` });
    this.emitState();
    return true;
  }

  interrupt(): void {
    const agent = this.agent;
    if (this.phase !== 'working' || !agent) return;
    this.phase = 'stopping';
    if (this.permission) {
      agent.answerPermission(this.permission.id, 'deny', this.permission.input, this.permission.suggestions);
      this.permission = undefined;
    }
    agent.interrupt();
    this.interruptTimer = setTimeout(() => {
      this.context.log.warn('interrupt was not acknowledged; stopping the agent process');
      this.stopAgent();
      this.finishTurn('interrupted', 0, 0);
    }, INTERRUPT_GRACE_MS);
    this.emitState();
  }

  /**
   * `always` is taken as a plain allow when the request offered no such choice. A request asking questions
   * (AskUserQuestion) takes `answers`, one for every question, and is left waiting without them; `deny` skips it.
   */
  answerPermission(id: string, answer: PermissionAnswer, answers?: unknown): void {
    const request = this.permission;
    if (!request || request.id !== id || !this.agent) return;
    if (request.questions) {
      const checked = answer === 'deny' ? undefined : checkAnswers(request.questions, answers);
      if (answer !== 'deny' && !checked) return;
      this.permission = undefined;
      if (checked) {
        this.agent.answerPermission(id, 'allow', { ...request.input, answers: checked }, []);
        this.context.log.info(`answered ${request.tool}: ${request.questions.length} ${request.questions.length === 1 ? 'question' : 'questions'}`);
        this.sink.event(this, { type: 'notice', level: 'info', text: `You answered: ${describeAnswers(request.questions, checked)}` });
      } else {
        this.agent.answerPermission(id, 'deny', request.input, [], SKIPPED_MESSAGE);
        this.context.log.info(`skipped ${request.tool}`);
      }
      this.emitState();
      return;
    }
    this.permission = undefined;
    const always = answer === 'always' && request.always !== undefined;
    this.agent.answerPermission(id, always ? 'always' : answer === 'deny' ? 'deny' : 'allow', request.input, request.suggestions);
    this.context.log.info(`${answer === 'deny' ? 'denied' : 'allowed'} ${request.tool} ${request.detail}${always ? ` (${request.always})` : ''}`);
    this.emitState();
  }

  /** Lets the idle process go; the next prompt starts one that resumes the conversation. Nothing happens mid-turn. */
  release(): void {
    if (this.busy || !this.agent) return;
    this.stopAgent();
  }

  /** The agent's MCP servers were enabled, disabled or signed in to: the next prompt starts a process that loads them, resuming the conversation. */
  reloadAgent(): void {
    if (this.agent) this.agentOptions = undefined;
  }

  /** What blocks a session (folder, workspace trust, the agent) changed. */
  availabilityChanged(): void {
    this.updateAvailability();
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.interruptTimer);
    this.stopAgent();
  }

  private updateAvailability(): void {
    const reason = this.context.unavailableReason();
    if (reason && !this.busy) {
      this.phase = 'unavailable';
      this.error = reason;
    } else if (!reason && this.phase === 'unavailable') {
      this.phase = 'idle';
      this.error = undefined;
    }
    this.emitState();
  }

  private startAgent(cwd: string, options: SessionOptions): AgentProcess {
    let agent: AgentProcess | undefined = undefined;
    agent = this.context.backend.start(
      { cwd, model: options.model, effort: options.effort, permissionMode: options.permissionMode, resume: this.sessionId },
      {
        // A stopped process can still flush output; only the current one is listened to.
        event: (event) => {
          if (this.agent === agent) this.onAgentEvent(event);
        },
        exit: (exit) => {
          if (this.agent === agent) this.onAgentExit(exit);
        },
      },
    );
    this.agent = agent;
    this.agentOptions = { ...options };
    this.agentCost = 0;
    this.context.log.info(
      `agent process started: ${this.sessionId ? `resuming ${this.sessionId}` : 'new conversation'}, ` +
        `model ${options.model || 'default'}, effort ${options.effort || 'default'}, permissions ${options.permissionMode}`,
    );
    return agent;
  }

  private stopAgent(): void {
    const agent = this.agent;
    this.agent = undefined;
    this.agentOptions = undefined;
    agent?.dispose();
  }

  private onAgentEvent(event: AgentEvent): void {
    // A subagent's first sign of work announces it, ahead of what it did.
    if ('parent' in event && event.parent !== undefined) this.startSubagent(event.parent);
    switch (event.type) {
      case 'init':
        if (this.sessionId !== event.sessionId) this.context.log.info(`conversation ${event.sessionId}`);
        this.sessionId = event.sessionId;
        this.model = event.model ?? this.model;
        this.emitState();
        if (event.mcpServers) this.context.mcpStatuses(event.mcpServers);
        break;
      case 'thinking':
        this.sink.event(this, { type: 'thinking', ...agentOf(event.parent) });
        break;
      case 'text':
        this.sink.event(this, { type: 'text', text: event.text, ...agentOf(event.parent) });
        break;
      case 'toolUse': {
        const type = event.input.subagent_type;
        this.tools.set(event.id, { name: event.name, agentName: typeof type === 'string' && type ? type : event.name, detail: summarizeTool(event.name, event.input).detail });
        this.sink.event(this, { type: 'toolUse', name: event.name, input: event.input, ...agentOf(event.parent) });
        break;
      }
      case 'toolError':
        this.sink.event(this, { type: 'toolError', tool: this.tools.get(event.toolUseId)?.name ?? 'Tool', message: event.message, ...agentOf(event.parent) });
        this.endSubagent(event.toolUseId, 'failed');
        break;
      case 'toolDone':
        this.sink.event(this, { type: 'toolDone', tool: this.tools.get(event.toolUseId)?.name ?? 'Tool', ...agentOf(event.parent) });
        this.endSubagent(event.toolUseId, 'done');
        break;
      case 'permissionRequest': {
        const detail = summarizeTool(event.tool, event.input).detail || event.description || '';
        const questions = parseQuestions(event.tool, event.input);
        const always = questions ? undefined : describeAlways(event.suggestions);
        this.permission = { id: event.requestId, tool: event.tool, detail, ...(always ? { always } : {}), ...(questions ? { questions } : {}), input: event.input, suggestions: event.suggestions };
        this.emitState();
        break;
      }
      case 'controlResponse':
        if (!event.ok) this.context.log.warn(`agent rejected control request ${event.requestId}: ${event.error ?? 'no reason given'}`);
        break;
      case 'turnEnd': {
        const turnCost = Math.max(0, event.processCostUsd - this.agentCost);
        this.agentCost = Math.max(this.agentCost, event.processCostUsd);
        this.costUsd += turnCost;
        this.finishTurn(event.outcome, event.durationMs, turnCost, event.message);
        break;
      }
    }
  }

  /** A subagent shows its first sign of work: announced once, named after the tool call running it. */
  private startSubagent(id: string): void {
    if (this.agents.has(id)) return;
    this.agents.set(id, true);
    const call = this.tools.get(id);
    this.sink.event(this, { type: 'agentStart', agent: id, name: call?.agentName ?? 'Subagent', detail: call?.detail ?? '' });
  }

  /** A tool call returned, or its turn ended: a subagent it ran is done. */
  private endSubagent(id: string, outcome: TurnOutcome): void {
    if (this.agents.get(id) !== true) return;
    this.agents.set(id, false);
    const call = this.tools.get(id);
    this.sink.event(this, { type: 'agentEnd', agent: id, name: call?.agentName ?? 'Subagent', detail: call?.detail ?? '', outcome });
  }

  private onAgentExit(exit: AgentExit): void {
    this.agent = undefined;
    this.agentOptions = undefined;
    const reason = exit.error?.message ?? (lastLine(exit.stderr) || `Claude Code exited with ${exit.signal ?? `code ${exit.code}`}`);
    if (this.turnOpen) {
      const interrupted = this.phase === 'stopping';
      this.context.log.warn(`agent process ended during a turn: ${reason}`);
      if (!interrupted) this.sink.event(this, { type: 'notice', level: 'error', text: reason });
      this.finishTurn(interrupted ? 'interrupted' : 'failed', 0, 0, interrupted ? undefined : reason);
      if (exit.error) this.context.probeAgain();
    } else if (exit.code !== 0) {
      // Idle process gone; the next prompt starts a new one and resumes the conversation.
      this.context.log.warn(`agent process exited while idle: ${reason}`);
    }
  }

  private finishTurn(outcome: TurnOutcome, durationMs: number, costUsd: number, message?: string): void {
    clearTimeout(this.interruptTimer);
    this.interruptTimer = undefined;
    this.permission = undefined;
    // Subagents still out end with the turn, ahead of its turnEnd.
    for (const [id, running] of this.agents) if (running) this.endSubagent(id, outcome);
    this.agents.clear();
    this.tools.clear();
    if (this.turnOpen) {
      this.turnOpen = false;
      this.turns++;
      this.context.log.info(`turn ${outcome} in ${durationMs} ms${message ? `: ${message}` : ''}`);
      this.sink.event(this, { type: 'turnEnd', outcome, durationMs, costUsd, message });
    }
    if (outcome === 'failed' && message) this.error = message;
    this.phase = this.context.unavailableReason() ? 'unavailable' : 'idle';
    this.emitState();
  }

  private emitState(): void {
    if (!this.disposed) this.sink.state(this);
  }
}

function sameOptions(a: SessionOptions | undefined, b: SessionOptions): boolean {
  return a !== undefined && a.model === b.model && a.effort === b.effort && a.permissionMode === b.permissionMode;
}

function lastLine(text: string): string {
  return text.split('\n').filter((line) => line.trim()).at(-1)?.trim() ?? '';
}
