// Claude Code's `--output-format stream-json` envelopes → backend-neutral AgentEvents.
// Pure: no vscode and no Node APIs, so it can be exercised anywhere.
//
// Shapes checked against Claude Code 2.1.267:
//   system/init           once per turn, carries session_id, model, claude_code_version
//   system/thinking_tokens  every ~50 tokens while Claude thinks (estimated_tokens), before the thinking block
//   assistant             one content block per envelope (thinking | text | tool_use); thinking text is often empty
//   user                  tool_result blocks, `is_error` on failures
//   system/permission_denied  a tool call the permission mode refused outright
//   control_request       can_use_tool, when --permission-prompt-tool stdio routes prompts to us
//   control_response      answers to our own control requests (interrupt; initialize and mcp_status for the catalog)
//   result                end of a turn; total_cost_usd is cumulative for the process
//
// Answers to control requests, checked against the same version:
//   initialize   { commands: [{name, description, argumentHint}], models: [{value, displayName, description, …}], agents, account, … }
//                "default" is the model the CLI picks by itself; skills are among the commands, plugin ones as plugin:name
//   mcp_status   { mcpServers: [{name, status, scope, config, serverInfo, tools: [{name}]}] }; config can hold credentials

import type { McpServerInfo, ModelChoice } from '../../shared/protocol';
import { type PermissionUpdate, parsePermissionUpdates } from './permissions';

/** How a permission decision is classed for the CLI's telemetry: a plain allow, an allow with "don't ask again", a deny. */
export type DecisionClassification = 'user_temporary' | 'user_permanent' | 'user_reject';

export type AgentEvent =
  /** `mcpServers` when the envelope lists them: the servers of this session and how they connected. */
  | { type: 'init'; sessionId: string; model?: string; version?: string; permissionMode?: string; mcpServers?: Array<{ name: string; status: string }> }
  /** A thinking block, which arrives whole once the thought is done. */
  | { type: 'thinking' }
  | { type: 'text'; text: string }
  | { type: 'toolUse'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'toolError'; toolUseId: string; message: string }
  /** A tool call that returned without an error. */
  | { type: 'toolDone'; toolUseId: string }
  /** `suggestions`: what the CLI would apply for "don't ask again" (`permission_suggestions`), to send back as `updatedPermissions`. */
  | { type: 'permissionRequest'; requestId: string; tool: string; input: Record<string, unknown>; description?: string; suggestions: PermissionUpdate[] }
  | { type: 'controlResponse'; requestId: string; ok: boolean; error?: string }
  | {
      type: 'turnEnd';
      outcome: 'done' | 'interrupted' | 'failed';
      durationMs: number;
      /** Cumulative for the process that produced it. */
      processCostUsd: number;
      message?: string;
    };

/** Messages Orbit writes to the CLI's stdin (`--input-format stream-json`). */
export type AgentInput =
  | { type: 'user'; message: { role: 'user'; content: string } }
  | { type: 'control_request'; request_id: string; request: { subtype: 'interrupt' | 'initialize' | 'mcp_status' } }
  | {
      type: 'control_response';
      response: {
        subtype: 'success';
        request_id: string;
        response:
          | { behavior: 'allow'; updatedInput: Record<string, unknown>; updatedPermissions?: PermissionUpdate[]; decisionClassification: DecisionClassification }
          | { behavior: 'deny'; message: string; decisionClassification: DecisionClassification };
      };
    };

type Json = Record<string, unknown>;

export function parseLine(line: string): AgentEvent[] {
  let message: Json;
  try {
    message = JSON.parse(line) as Json;
  } catch {
    return [];
  }
  if (!isObject(message)) return [];

  switch (message.type) {
    case 'system':
      return parseSystem(message);
    case 'assistant':
      return parseAssistant(message);
    case 'user':
      return parseToolResults(message);
    case 'control_request':
      return parseControlRequest(message);
    case 'control_response':
      return parseControlResponse(message);
    case 'result':
      return [parseResult(message)];
    default:
      return [];
  }
}

function parseSystem(message: Json): AgentEvent[] {
  // Progress every few dozen tokens while Claude thinks, well before the thinking block itself.
  if (message.subtype === 'thinking_tokens') return message.parent_tool_use_id ? [] : [{ type: 'thinking' }];
  if (message.subtype === 'init' && typeof message.session_id === 'string') {
    return [
      {
        type: 'init',
        sessionId: message.session_id,
        model: string(message.model),
        version: string(message.claude_code_version),
        permissionMode: string(message.permissionMode),
        mcpServers: Array.isArray(message.mcp_servers)
          ? message.mcp_servers.flatMap((server) => (isObject(server) && typeof server.name === 'string' ? [{ name: server.name, status: string(server.status) ?? 'unknown' }] : []))
          : undefined,
      },
    ];
  }
  return [];
}

function parseAssistant(message: Json): AgentEvent[] {
  // Subagent traffic (parent_tool_use_id set) is not the main conversation.
  if (message.parent_tool_use_id) return [];
  const content = isObject(message.message) ? message.message.content : undefined;
  if (!Array.isArray(content)) return [];
  const events: AgentEvent[] = [];
  for (const block of content) {
    if (!isObject(block)) continue;
    if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      // The block itself is the signal: Claude Code can leave its text empty.
      events.push({ type: 'thinking' });
    } else if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      events.push({ type: 'text', text: block.text });
    } else if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
      events.push({ type: 'toolUse', id: block.id, name: block.name, input: isObject(block.input) ? block.input : {} });
    }
  }
  return events;
}

function parseToolResults(message: Json): AgentEvent[] {
  if (message.parent_tool_use_id) return [];
  const content = isObject(message.message) ? message.message.content : undefined;
  if (!Array.isArray(content)) return [];
  const events: AgentEvent[] = [];
  for (const block of content) {
    if (!isObject(block) || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
    events.push(block.is_error === true ? { type: 'toolError', toolUseId: block.tool_use_id, message: resultText(block.content) } : { type: 'toolDone', toolUseId: block.tool_use_id });
  }
  return events;
}

function parseControlRequest(message: Json): AgentEvent[] {
  const request = message.request;
  if (typeof message.request_id !== 'string' || !isObject(request) || request.subtype !== 'can_use_tool') return [];
  return [
    {
      type: 'permissionRequest',
      requestId: message.request_id,
      tool: string(request.tool_name) ?? string(request.display_name) ?? 'tool',
      input: isObject(request.input) ? request.input : {},
      description: string(request.description),
      suggestions: parsePermissionUpdates(request.permission_suggestions),
    },
  ];
}

function parseControlResponse(message: Json): AgentEvent[] {
  const response = message.response;
  if (!isObject(response) || typeof response.request_id !== 'string') return [];
  return [{ type: 'controlResponse', requestId: response.request_id, ok: response.subtype === 'success', error: string(response.error) }];
}

function parseResult(message: Json): AgentEvent {
  const interrupted = message.terminal_reason === 'aborted_streaming' || message.terminal_reason === 'aborted_tools';
  const failed = message.is_error === true || (typeof message.subtype === 'string' && message.subtype !== 'success');
  return {
    type: 'turnEnd',
    outcome: interrupted ? 'interrupted' : failed ? 'failed' : 'done',
    durationMs: number(message.duration_ms),
    processCostUsd: number(message.total_cost_usd),
    message: failed && !interrupted ? (string(message.result) ?? string(message.subtype)) : undefined,
  };
}

/* ── Answers to Orbit's own control requests ───────────────────────────── */

export interface CliCommand {
  name: string;
  description: string;
  argumentHint?: string;
}

/** A control_response line: which request it answers, and the answer's body. Undefined for any other line. */
export function parseControlAnswer(line: string): { requestId: string; ok: boolean; body: Json | undefined; error?: string } | undefined {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isObject(message) || message.type !== 'control_response' || !isObject(message.response)) return undefined;
  const { response } = message;
  if (typeof response.request_id !== 'string') return undefined;
  return { requestId: response.request_id, ok: response.subtype === 'success', body: isObject(response.response) ? response.response : undefined, error: string(response.error) };
}

/** `initialize` → the models the CLI offers. Its "default" becomes '', which passes no --model. */
export function parseModels(body: Json | undefined): ModelChoice[] {
  const seen = new Set<string>();
  return (Array.isArray(body?.models) ? body.models : []).flatMap((model) => {
    if (!isObject(model) || typeof model.value !== 'string') return [];
    const value = model.value === 'default' ? '' : model.value;
    if (seen.has(value)) return [];
    seen.add(value);
    return [{ value, label: string(model.displayName) ?? model.value, description: string(model.description) }];
  });
}

/** `initialize` → every slash command the CLI offers, skills among them. */
export function parseCommands(body: Json | undefined): CliCommand[] {
  return (Array.isArray(body?.commands) ? body.commands : []).flatMap((command) =>
    isObject(command) && typeof command.name === 'string' && command.name ? [{ name: command.name, description: string(command.description) ?? '', argumentHint: string(command.argumentHint) }] : [],
  );
}

/** `mcp_status` → name, status, scope and tool count. The rest, configurations with their credentials included, is dropped here. */
export function parseMcpServers(body: Json | undefined): McpServerInfo[] {
  return (Array.isArray(body?.mcpServers) ? body.mcpServers : []).flatMap((server) =>
    isObject(server) && typeof server.name === 'string'
      ? [{ name: server.name, status: string(server.status) ?? 'unknown', scope: string(server.scope), tools: Array.isArray(server.tools) ? server.tools.length : 0 }]
      : [],
  );
}

function resultText(content: unknown): string {
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((part) => (isObject(part) && typeof part.text === 'string' ? part.text : '')).join(' ') : '';
  return text.replace(/<\/?tool_use_error>/g, '').trim();
}

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
