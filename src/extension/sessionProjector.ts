import { isAbsolute, relative, resolve, sep } from 'node:path';
import { isIndexable } from '../shared/languages';
import { mcpToolName } from '../shared/mcp';
import type { ActivityDelta, ActivityEvent, TranscriptEntry } from '../shared/protocol';
import { TickBatcher } from '../shared/tickBatcher';
import type { LoadedGraph } from './graph/graphService';
import type { SessionEvent } from './session/sessionService';
import { oneLine, summarizeTool } from './session/tools';

const TICK_MS = 100;
const HISTORY_ENTRIES = 400;
const MAX_TEXT = 20_000;

export interface ProjectionSink {
  activity(delta: ActivityDelta): void;
  transcript(entries: TranscriptEntry[], reset: boolean): void;
}

type NewEntry = TranscriptEntry extends infer E ? (E extends TranscriptEntry ? Omit<E, 'id'> : never) : never;
/** `id` lets a file event survive a graph update that lands before the tick flushes. */
type Item = { event: ActivityEvent; hash: string; id?: string } | { entry: TranscriptEntry };

/**
 * Projects one conversation's events onto the loaded graph. File reads, edits and thoughts become
 * scene activity (node indices); everything but thoughts becomes transcript entries. Both leave
 * once per host tick, and a bounded transcript is kept so a reloaded webview can catch up.
 */
export class SessionProjector {
  private readonly batcher = new TickBatcher<Item>(TICK_MS, (items) => this.flush(items));
  private readonly history: TranscriptEntry[] = [];
  private nextId = 1;
  private seq = 0;

  /** `key` is the conversation's, which every activity delta carries. */
  constructor(
    private readonly key: string,
    private readonly graph: () => LoadedGraph | undefined,
    private readonly sink: ProjectionSink,
  ) {}

  get transcript(): readonly TranscriptEntry[] {
    return this.history;
  }

  project(event: SessionEvent): void {
    switch (event.type) {
      case 'prompt':
        this.append({ kind: 'prompt', text: clip(event.text), ...(event.skills?.length ? { skills: [...event.skills] } : {}), ...(event.files?.length ? { files: [...event.files] } : {}) });
        break;
      case 'text':
        this.append({ kind: 'text', text: clip(event.text) });
        break;
      case 'toolUse':
        this.toolUse(event.name, event.input);
        break;
      case 'toolError':
        this.mcpAnswered(event.tool, 'error');
        this.append({ kind: 'notice', level: 'warn', text: `${event.tool}: ${oneLine(event.message, 240)}` });
        break;
      case 'toolDone':
        this.mcpAnswered(event.tool, 'done');
        break;
      case 'thinking': {
        const loaded = this.graph();
        if (loaded) this.batcher.push({ event: { kind: 'thinking' }, hash: loaded.graph.hash });
        break;
      }
      case 'turnEnd': {
        const loaded = this.graph();
        if (loaded) this.batcher.push({ event: { kind: 'turnEnd' }, hash: loaded.graph.hash });
        this.append({ kind: 'turn', outcome: event.outcome, durationMs: event.durationMs, costUsd: event.costUsd, message: event.message });
        break;
      }
      case 'notice':
        this.append({ kind: 'notice', level: event.level, text: event.text });
        break;
    }
  }

  dispose(): void {
    this.batcher.dispose();
  }

  private toolUse(name: string, input: Record<string, unknown>): void {
    const summary = summarizeTool(name, input);
    const loaded = this.graph();
    const mcp = mcpToolName(name);
    if (mcp) {
      // An MCP server's tool: the scene draws the call to the server, whatever path its input names.
      if (loaded) this.batcher.push({ event: { kind: 'mcp', ...mcp, phase: 'call' }, hash: loaded.graph.hash });
      this.append({ kind: 'tool', tool: name, detail: summary.detail, mcp });
      return;
    }
    if (!summary.path) {
      this.append({ kind: 'tool', tool: name, detail: summary.detail });
      return;
    }
    const node = loaded?.resolve(summary.path);
    if (node === undefined || !loaded) {
      // A source file Claude writes joins the graph with the next update; link it already.
      const created = loaded && summary.action === 'edit' ? workspaceId(loaded.graph.root, summary.path) : undefined;
      const file = created !== undefined && isIndexable(created) ? created : undefined;
      this.append({ kind: 'tool', tool: name, detail: loaded ? displayPath(loaded.graph.root, summary.path) : summary.path, action: summary.action, file });
      return;
    }
    const id = loaded.graph.nodes[node].id;
    if (summary.action) this.batcher.push({ event: { kind: summary.action, node }, hash: loaded.graph.hash, id });
    this.append({ kind: 'tool', tool: name, detail: id, action: summary.action, file: id });
  }

  /** An MCP tool's answer travels back from its server. */
  private mcpAnswered(tool: string, phase: 'done' | 'error'): void {
    const mcp = mcpToolName(tool);
    const loaded = this.graph();
    if (mcp && loaded) this.batcher.push({ event: { kind: 'mcp', ...mcp, phase }, hash: loaded.graph.hash });
  }

  private append(entry: NewEntry): void {
    const full = { id: this.nextId++, ...entry } as TranscriptEntry;
    this.history.push(full);
    if (this.history.length > HISTORY_ENTRIES) this.history.splice(0, this.history.length - HISTORY_ENTRIES);
    this.batcher.push({ entry: full });
  }

  private flush(items: Item[]): void {
    const loaded = this.graph();
    const hash = loaded?.graph.hash;
    const events: ActivityEvent[] = [];
    const entries: TranscriptEntry[] = [];
    let thinking = false;
    for (const item of items) {
      if ('entry' in item) {
        entries.push(item.entry);
      } else if (item.event.kind === 'thinking') {
        // Thinking progress comes every few dozen tokens; once per tick says it all.
        if (!thinking) events.push(item.event);
        thinking = true;
      } else if (item.hash === hash || item.event.kind === 'turnEnd' || item.event.kind === 'mcp') {
        events.push(item.event);
      } else if (loaded && item.id !== undefined) {
        // The graph changed since: node indices mean nothing now, but the file keeps its id.
        const node = loaded.resolve(item.id);
        if (node !== undefined) events.push({ ...item.event, node });
      }
    }
    if (events.length > 0 && hash) this.sink.activity({ seq: ++this.seq, hash, key: this.key, events });
    if (entries.length > 0) this.sink.transcript(entries, false);
  }
}

function workspaceId(root: string, filePath: string): string | undefined {
  const rel = relative(root, isAbsolute(filePath) ? filePath : resolve(root, filePath));
  return rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? rel.split(sep).join('/') : undefined;
}

function displayPath(root: string, filePath: string): string {
  if (!isAbsolute(filePath)) return filePath;
  const rel = relative(root, filePath);
  return rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? rel.split(sep).join('/') : filePath;
}

function clip(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}
