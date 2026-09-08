import type { McpServerInfo, ModelChoice, PermissionAnswer, PermissionMode, SkillInfo } from '../../shared/protocol';
import type { PermissionUpdate } from './permissions';
import type { AgentEvent } from './streamJson';

/** What the agent offers in a workspace. */
export interface AgentCatalogResult {
  models: ModelChoice[];
  skills: SkillInfo[];
  mcpServers: McpServerInfo[];
  /** The agent could not be asked; `skills` may still hold what was found without it. */
  error?: string;
}

export type AgentAvailability = { available: true; name: string; version?: string; detail: string } | { available: false; reason: string };

export interface AgentStartOptions {
  cwd: string;
  /** '' means the agent's default. */
  model: string;
  permissionMode: PermissionMode;
  /** Continue this conversation instead of starting a new one. */
  resume?: string;
}

export interface AgentExit {
  code: number | null;
  signal: string | null;
  /** The last few KB the process wrote to stderr. */
  stderr: string;
  /** Set when the process could not be started at all. */
  error?: Error;
}

export interface AgentProcessSink {
  event(event: AgentEvent): void;
  /** Fires exactly once, including after `dispose()`. */
  exit(info: AgentExit): void;
}

/** One running agent. It stays alive between turns; each `prompt` starts a turn. */
export interface AgentProcess {
  /** Starts a turn; `skills` (catalog names) are invoked with it, however the agent invokes skills. */
  prompt(text: string, skills: readonly string[]): void;
  interrupt(): void;
  /**
   * Answers a `permissionRequest`. `always` allows and hands back the request's `suggestions` as the permissions to
   * apply from now on (the agent's own "don't ask again"); `input` is the request's, echoed with an allow.
   */
  answerPermission(requestId: string, answer: PermissionAnswer, input: Record<string, unknown>, suggestions: readonly PermissionUpdate[]): void;
  dispose(): void;
}

/**
 * A way to run an agent session. The Claude Code CLI is the implementation today;
 * an Agent SDK or remote backend only has to produce the same AgentEvents.
 */
export interface SessionBackend {
  probe(): Promise<AgentAvailability>;
  /** Models, skills and MCP servers the agent offers in `cwd`, found without starting a conversation. Only after a successful probe. */
  catalog?(cwd: string): Promise<AgentCatalogResult>;
  start(options: AgentStartOptions, sink: AgentProcessSink): AgentProcess;
}
