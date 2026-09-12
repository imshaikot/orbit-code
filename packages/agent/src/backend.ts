import type { EffortLevel, McpAction, McpServerInfo, ModelChoice, PermissionAnswer, PermissionMode, SkillInfo } from '@orbit-code/protocol';
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
  /** '' means the agent's default. */
  effort: EffortLevel | '';
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
  /**
   * Starts a turn; `skills` (catalog names) are invoked with it, however the agent invokes skills, and `files` (workspace
   * ids, or absolute paths outside the workspace) go with it as context.
   */
  prompt(text: string, skills: readonly string[], files: readonly string[]): void;
  interrupt(): void;
  /**
   * Answers a `permissionRequest`. `always` allows and hands back the request's `suggestions` as the permissions to
   * apply from now on (the agent's own "don't ask again"); `input` is the request's, echoed with an allow. `message`
   * replaces what a deny tells the agent.
   */
  answerPermission(requestId: string, answer: PermissionAnswer, input: Record<string, unknown>, suggestions: readonly PermissionUpdate[], message?: string): void;
  dispose(): void;
}

/**
 * A process kept for the MCP view. It loads the user's MCP servers as a session would, gets no prompt, saves no session,
 * and changes what `/mcp` changes in a terminal: an enabled or disabled server is saved in the agent's own settings.
 */
export interface AgentControl {
  /** False once the process has ended. */
  readonly alive: boolean;
  /** Every MCP server and how it connected. */
  mcpStatus(): Promise<McpServerInfo[]>;
  /** Resolves once the agent has done it, with the page to sign in on when `signIn` needs the user; rejects with the agent's reason. */
  mcpAction(server: string, action: McpAction): Promise<{ authUrl?: string }>;
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
  /** A process for the MCP view in `cwd`. Only after a successful probe. */
  control?(cwd: string): AgentControl;
  start(options: AgentStartOptions, sink: AgentProcessSink): AgentProcess;
}
