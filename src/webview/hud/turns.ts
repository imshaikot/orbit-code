import { mcpToolName } from '../../shared/mcp';
import type { SessionState, TranscriptEntry } from '../../shared/protocol';

export type TurnEnd = Extract<TranscriptEntry, { kind: 'turn' }>;
export type ToolEntry = Extract<TranscriptEntry, { kind: 'tool' }>;

/** A session as the HUD shows it: one prompt and everything Claude did for it, up to its turn line. */
export interface Turn {
  /** The conversation it belongs to. */
  readonly key: string;
  /** Id of the prompt entry. */
  readonly id: number;
  readonly prompt: string;
  /** Skills invoked with the prompt. */
  readonly skills?: readonly string[];
  /** Files attached to the prompt as context. */
  readonly files?: readonly string[];
  /** When the webview first saw it; for replayed history that is the replay. */
  readonly startedAt: number;
  end: TurnEnd | undefined;
  /** The latest tool call, for "Reading src/…". */
  lastTool: ToolEntry | undefined;
  /** Claude has written text since the latest tool call. */
  replying: boolean;
}

export interface Activity {
  verb: string;
  /** A path or command, shown in the code face. */
  detail?: string;
}

/** What a running session is doing right now, in words. */
export function activityOf(turn: Turn | undefined, state: SessionState): Activity {
  if (state.permission) return { verb: `Needs your decision on ${toolLabel(state.permission.tool)}`, detail: state.permission.detail };
  if (state.phase === 'stopping') return { verb: 'Stopping' };
  if (!turn) return { verb: 'Starting' };
  const tool = turn.lastTool;
  if (turn.replying) return { verb: 'Writing a reply' };
  if (!tool) return { verb: 'Thinking' };
  if (tool.action === 'read') return { verb: 'Reading', detail: tool.detail };
  if (tool.action === 'edit') return { verb: 'Editing', detail: tool.detail };
  if (tool.mcp) return { verb: `Asking ${tool.mcp.server}`, detail: tool.mcp.tool };
  return { verb: tool.tool, detail: tool.detail };
}

/** A tool's name for people: an MCP tool reads as `server › tool`. */
export function toolLabel(name: string): string {
  const mcp = mcpToolName(name);
  return mcp ? `${mcp.server} › ${mcp.tool}` : name;
}

/** What a prompt says in a bubble or a title: its text, else the skills it invokes, else the files attached to it. */
export function promptLine(text: string, skills: readonly string[] | undefined, files?: readonly string[]): string {
  return text || (skills ?? []).map((skill) => `/${skill}`).join(' ') || (files ?? []).map(fileName).join(' ') || 'Claude session';
}

/** A path's last segment, for a chip or a title. */
export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

export function outcomeLine(end: TurnEnd): string {
  switch (end.outcome) {
    case 'done':
      return end.durationMs > 0 ? `Done in ${seconds(end.durationMs)}` : 'Done';
    case 'interrupted':
      return 'Stopped';
    case 'failed':
      return end.message ? `Failed: ${end.message}` : 'Failed';
  }
}

export function seconds(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : ms < 90_000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

/** Elapsed time as m:ss. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function plural(count: number, noun: string): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? noun : `${noun}s`}`;
}

/** "just now", "5 min ago", "yesterday", "12 days ago", then the date. */
export function relativeTime(epochMs: number, now = Date.now()): string {
  const s = Math.max(0, (now - epochMs) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  const days = Math.floor(s / 86_400);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return new Date(epochMs).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function dollars(usd: number): string {
  return `$${usd.toFixed(usd > 0 && usd < 0.1 ? 3 : 2)}`;
}
