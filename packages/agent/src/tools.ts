// What a Claude Code tool call means for Orbit: which file it touches (the scene
// animates reads and edits) and a one-line summary for the transcript.

export type FileAction = 'read' | 'edit';

export interface ToolSummary {
  /** Set when the tool reads or writes exactly one file. */
  action?: FileAction;
  /** As the tool reported it: absolute, or relative to the session's working directory. */
  path?: string;
  /** A path, command, pattern or description; single line. */
  detail: string;
}

const READ_TOOLS: ReadonlySet<string> = new Set(['Read']);
const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const DETAIL_KEYS = ['command', 'pattern', 'url', 'query', 'description', 'prompt', 'skill', 'path'] as const;
const MAX_DETAIL = 160;

export function summarizeTool(name: string, input: Record<string, unknown>): ToolSummary {
  const text = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : undefined);
  const path = text('file_path') ?? text('notebook_path');
  if (path && READ_TOOLS.has(name)) return { action: 'read', path, detail: path };
  if (path && EDIT_TOOLS.has(name)) return { action: 'edit', path, detail: path };
  if (Array.isArray(input.todos)) return { detail: `${input.todos.length} ${input.todos.length === 1 ? 'item' : 'items'}` };
  for (const key of DETAIL_KEYS) {
    const value = text(key);
    if (value) return { path, detail: oneLine(value) };
  }
  return { path, detail: path ?? '' };
}

export function oneLine(text: string, max = MAX_DETAIL): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
