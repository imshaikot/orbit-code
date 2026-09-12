// Earlier Claude Code conversations of a workspace, read from the JSON-lines transcripts Claude Code keeps at
// <config>/projects/<the workspace path, every character but letters and digits a dash>/<session id>.jsonl.
//
// Entries used, as Claude Code 2.1.267 writes them:
//   ai-title   { aiTitle }                         the conversation's title, rewritten as it goes on
//   summary    { summary }                         older versions' title
//   user       { message.content, timestamp, gitBranch, isSidechain, isMeta }   a string, or blocks; tool_result blocks are not prompts
//   assistant  { message.model, message.content: [tool_use {name, input}] }

import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import type { ConversationSummary } from '@orbit-code/protocol';
import { mcpToolName } from '@orbit-code/protocol/mcp';
import { claudeConfigDir } from './skillCatalog';
import { oneLine } from './tools';

const MAX_CONVERSATIONS = 40;
const MAX_PROMPTS = 8;
const MAX_PROMPT_CHARS = 280;
const MAX_FILES = 24;
/** A line this long holding a tool result is file contents or command output: skipped without parsing. */
const SKIP_RESULT_CHARS = 64_000;
const READ_TOOLS: ReadonlySet<string> = new Set(['Read']);
const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

type Json = Record<string, unknown>;

/** Summaries are cached by size and mtime, so listing again reads only the conversations that changed. */
export class ConversationHistory {
  private readonly cache = new Map<string, { size: number; mtimeMs: number; summary: ConversationSummary | undefined }>();

  constructor(private readonly configDir: () => string = claudeConfigDir) {}

  /** The most recently active conversations first; ones without a prompt are left out. */
  async list(cwd: string): Promise<ConversationSummary[]> {
    const dir = join(this.configDir(), 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
    let names: string[];
    try {
      names = (await readdir(dir)).filter((name) => name.endsWith('.jsonl'));
    } catch {
      return [];
    }
    const files = (
      await Promise.all(
        names.map(async (name) => {
          const path = join(dir, name);
          try {
            const info = await stat(path);
            return info.isFile() ? { path, id: name.slice(0, -'.jsonl'.length), size: info.size, mtimeMs: info.mtimeMs } : undefined;
          } catch {
            return undefined;
          }
        }),
      )
    )
      .filter((file) => file !== undefined)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    const summaries: ConversationSummary[] = [];
    for (const file of files) {
      if (summaries.length >= MAX_CONVERSATIONS) break;
      let cached = this.cache.get(file.path);
      if (!cached || cached.size !== file.size || cached.mtimeMs !== file.mtimeMs) {
        cached = { size: file.size, mtimeMs: file.mtimeMs, summary: await summarize(file.path, file.id, cwd, file.mtimeMs) };
        this.cache.set(file.path, cached);
      }
      if (cached.summary) summaries.push(cached.summary);
    }
    return summaries;
  }
}

async function summarize(path: string, id: string, cwd: string, mtimeMs: number): Promise<ConversationSummary | undefined> {
  let aiTitle: string | undefined;
  let summaryTitle: string | undefined;
  let startedAt = 0;
  let updatedAt = 0;
  let model: string | undefined;
  let branch: string | undefined;
  let promptCount = 0;
  const prompts: string[] = [];
  const files = new Map<string, { reads: number; edits: number }>();
  const servers = new Set<string>();
  const skills = new Set<string>();

  try {
    const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Number.POSITIVE_INFINITY });
    for await (const line of lines) {
      if (!line || (line.length > SKIP_RESULT_CHARS && line.includes('"tool_result"'))) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isObject(entry)) continue;
      if (entry.type === 'ai-title' && typeof entry.aiTitle === 'string') aiTitle = entry.aiTitle;
      else if (entry.type === 'summary' && typeof entry.summary === 'string') summaryTitle ??= entry.summary;
      const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : Number.NaN;
      if (Number.isFinite(at)) {
        startedAt ||= at;
        updatedAt = Math.max(updatedAt, at);
      }
      if (entry.isSidechain === true || entry.isMeta === true || !isObject(entry.message)) continue;
      if (typeof entry.gitBranch === 'string' && entry.gitBranch && entry.gitBranch !== 'HEAD') branch = entry.gitBranch;
      const message = entry.message;

      if (entry.type === 'user') {
        const prompt = promptOf(message.content);
        if (!prompt) continue;
        promptCount++;
        if (prompt.skill) skills.add(prompt.skill);
        if (prompts.length < MAX_PROMPTS) prompts.push(oneLine(prompt.text, MAX_PROMPT_CHARS));
      } else if (entry.type === 'assistant') {
        if (typeof message.model === 'string' && !message.model.startsWith('<')) model = message.model;
        for (const block of Array.isArray(message.content) ? message.content : []) {
          if (!isObject(block) || block.type !== 'tool_use' || typeof block.name !== 'string') continue;
          const input = isObject(block.input) ? block.input : {};
          const mcp = mcpToolName(block.name);
          if (mcp) servers.add(mcp.server);
          if (block.name === 'Skill' && typeof input.skill === 'string') skills.add(input.skill);
          const action = READ_TOOLS.has(block.name) ? 'reads' : EDIT_TOOLS.has(block.name) ? 'edits' : undefined;
          const filePath = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : undefined;
          const file = action && filePath ? workspaceId(cwd, filePath) : undefined;
          if (!action || !file) continue;
          const counts = files.get(file) ?? { reads: 0, edits: 0 };
          counts[action]++;
          files.set(file, counts);
        }
      }
    }
  } catch {
    // Gone or unreadable meanwhile.
    return undefined;
  }
  if (promptCount === 0) return undefined;

  const weight = (counts: { reads: number; edits: number }) => counts.edits * 3 + counts.reads;
  return {
    id,
    title: oneLine(aiTitle ?? summaryTitle ?? prompts[0] ?? 'Untitled conversation', 120),
    startedAt: startedAt || mtimeMs,
    updatedAt: updatedAt || mtimeMs,
    promptCount,
    prompts,
    model,
    branch,
    files: [...files]
      .map(([file, counts]) => ({ id: file, ...counts }))
      .sort((a, b) => weight(b) - weight(a))
      .slice(0, MAX_FILES),
    mcpServers: [...servers],
    skills: [...skills],
  };
}

/** Text the user sent. Tool results, interruptions and command output are not prompts; a slash command reads as `/name args`. */
function promptOf(content: unknown): { text: string; skill?: string } | undefined {
  let text: string | undefined;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content) && !content.some((block) => isObject(block) && block.type === 'tool_result')) {
    text = content.map((block) => (isObject(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : '')).join('\n');
  }
  const trimmed = text?.trim();
  if (!trimmed || trimmed.startsWith('<local-command') || trimmed.startsWith('[Request interrupted') || trimmed.startsWith('Caveat:')) return undefined;
  const command = /<command-name>\/?([^<\s]+)<\/command-name>/.exec(trimmed);
  if (command) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(trimmed)?.[1]?.trim();
    return { text: `/${command[1]}${args ? ` ${args}` : ''}`, skill: command[1] };
  }
  return { text: trimmed };
}

function workspaceId(root: string, filePath: string): string | undefined {
  const rel = relative(root, isAbsolute(filePath) ? filePath : resolve(root, filePath));
  return rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? rel.split(sep).join('/') : undefined;
}

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
