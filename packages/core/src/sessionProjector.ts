import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { SessionEvent } from '@orbit-code/agent/sessionService';
import { oneLine, summarizeTool } from '@orbit-code/agent/tools';
import { TickBatcher } from '@orbit-code/common/tickBatcher';
import { isIndexable } from '@orbit-code/graph/languages';
import type { ActivityDelta, ActivityEvent, TranscriptEntry } from '@orbit-code/protocol';
import { mcpToolName } from '@orbit-code/protocol/mcp';
import type { LoadedGraph } from './graphService';

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
 * once per host tick, and a bounded transcript is kept so a reloaded webview can catch up. What a
 * subagent does carries its `agent`, and its entries are kept in a history of their own.
 */
export class SessionProjector {
  private readonly batcher = new TickBatcher<Item>(TICK_MS, (items) => this.flush(items));
  private readonly history: TranscriptEntry[] = [];
  /** Subagents' entries, apart so that a busy subagent doesn't push the conversation's own out of the history. */
  private readonly agentHistory: TranscriptEntry[] = [];
  private nextId = 1;
  private seq = 0;

  /** `key` is the conversation's, which every activity delta carries. */
  constructor(
    private readonly key: string,
    private readonly graph: () => LoadedGraph | undefined,
    private readonly sink: ProjectionSink,
  ) {}

  /** The conversation's entries and its subagents', in the order they were made. */
  get transcript(): readonly TranscriptEntry[] {
    if (this.agentHistory.length === 0) return this.history;
    const merged: TranscriptEntry[] = [];
    let a = 0;
    let b = 0;
    while (a < this.history.length || b < this.agentHistory.length) {
      const own = a < this.history.length && (b === this.agentHistory.length || this.history[a].id < this.agentHistory[b].id);
      merged.push(own ? this.history[a++] : this.agentHistory[b++]);
    }
    return merged;
  }

  project(event: SessionEvent): void {
    switch (event.type) {
      case 'prompt':
        this.append({ kind: 'prompt', text: clip(event.text), ...(event.skills?.length ? { skills: [...event.skills] } : {}), ...(event.files?.length ? { files: [...event.files] } : {}) });
        break;
      case 'text':
        this.append({ kind: 'text', text: clip(event.text), ...by(event.agent) });
        break;
      case 'toolUse':
        this.toolUse(event.name, event.input, event.agent);
        break;
      case 'toolError':
        this.mcpAnswered(event.tool, 'error', event.agent);
        this.append({ kind: 'notice', level: 'warn', text: `${event.tool}: ${oneLine(event.message, 240)}`, ...by(event.agent) });
        break;
      case 'toolDone':
        this.mcpAnswered(event.tool, 'done', event.agent);
        break;
      case 'agentStart':
      case 'agentEnd': {
        // The subagent's own star comes out of the conversation's, and goes back once it is done.
        const loaded = this.graph();
        const scene: ActivityEvent = event.type === 'agentStart' ? { kind: 'agentStart', agent: event.agent, name: event.name } : { kind: 'agentEnd', agent: event.agent };
        if (loaded) this.batcher.push({ event: scene, hash: loaded.graph.hash });
        this.append({ kind: 'agent', agent: event.agent, name: event.name, detail: event.detail, ...(event.type === 'agentEnd' ? { outcome: event.outcome } : {}) });
        break;
      }
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

  private toolUse(name: string, input: Record<string, unknown>, agent?: string): void {
    const summary = summarizeTool(name, input);
    const loaded = this.graph();
    const mcp = mcpToolName(name);
    if (mcp) {
      // An MCP server's tool: the scene draws the call to the server, whatever path its input names.
      if (loaded) this.batcher.push({ event: { kind: 'mcp', ...mcp, phase: 'call', ...by(agent) }, hash: loaded.graph.hash });
      this.append({ kind: 'tool', tool: name, detail: summary.detail, mcp, ...by(agent) });
      return;
    }
    if (!summary.path) {
      this.append({ kind: 'tool', tool: name, detail: summary.detail, ...by(agent) });
      return;
    }
    const node = loaded?.resolve(summary.path);
    if (node === undefined || !loaded) {
      // A source file Claude writes joins the graph with the next update; link it already.
      const created = loaded && summary.action === 'edit' ? workspaceId(loaded.graph.root, summary.path) : undefined;
      const file = created !== undefined && isIndexable(created) ? created : undefined;
      this.append({ kind: 'tool', tool: name, detail: loaded ? displayPath(loaded.graph.root, summary.path) : summary.path, action: summary.action, file, ...by(agent) });
      return;
    }
    const id = loaded.graph.nodes[node].id;
    if (summary.action) this.batcher.push({ event: { kind: summary.action, node, ...by(agent) }, hash: loaded.graph.hash, id });
    this.append({ kind: 'tool', tool: name, detail: id, action: summary.action, file: id, ...by(agent) });
  }

  /** An MCP tool's answer travels back from its server. */
  private mcpAnswered(tool: string, phase: 'done' | 'error', agent?: string): void {
    const mcp = mcpToolName(tool);
    const loaded = this.graph();
    if (mcp && loaded) this.batcher.push({ event: { kind: 'mcp', ...mcp, phase, ...by(agent) }, hash: loaded.graph.hash });
  }

  private append(entry: NewEntry): void {
    const full = { id: this.nextId++, ...entry } as TranscriptEntry;
    const history = 'agent' in full ? this.agentHistory : this.history;
    history.push(full);
    if (history.length > HISTORY_ENTRIES) history.splice(0, history.length - HISTORY_ENTRIES);
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
      } else if (item.hash === hash || !('node' in item.event)) {
        // Without a node (turnEnd, mcp, a subagent's start and end), an event means the same on any graph.
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

/** The `agent` of what a subagent did; nothing for the conversation's own, whose events and entries stay as they were. */
function by(agent: string | undefined): { agent?: string } {
  return agent === undefined ? {} : { agent };
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
