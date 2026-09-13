import type { TranscriptEntry } from '@orbit-code/protocol';

// What each subagent of each conversation was asked and has done, gathered from the transcript the host sends: the
// output a click on a subagent's star shows. The session view keeps to the conversation's own entries.

/** Lines kept per subagent, the newest. */
const MAX_LINES = 300;
/** Subagents kept per conversation, the newest. */
const MAX_AGENTS = 24;

/** A line of a subagent's output: a tool it called, text it wrote, or a tool of its that failed. */
export type AgentLine = Extract<TranscriptEntry, { kind: 'text' | 'tool' | 'notice' }>;

/** An entry a subagent made: a line of its output, or its start or end. */
export type SubagentEntry = (AgentLine | Extract<TranscriptEntry, { kind: 'agent' }>) & { agent: string };

export interface AgentLog {
  /** Its type (`Explore`, `general-purpose`), else the tool running it. */
  name: string;
  /** What it was asked to do. */
  detail: string;
  /** How its call returned; unset while it runs. */
  outcome?: 'done' | 'interrupted' | 'failed';
  lines: AgentLine[];
}

export function isAgentEntry(entry: TranscriptEntry): entry is SubagentEntry {
  return 'agent' in entry && entry.agent !== undefined;
}

export class AgentLogs {
  private readonly conversations = new Map<string, Map<string, AgentLog>>();

  /** Takes in a transcript message of the conversation `key`; returns whether a subagent's log changed. */
  append(key: string, reset: boolean, entries: readonly TranscriptEntry[]): boolean {
    if (reset) this.conversations.delete(key);
    let changed = reset;
    for (const entry of entries) {
      if (!isAgentEntry(entry)) continue;
      const log = this.log(key, entry.agent);
      if (entry.kind === 'agent') {
        log.name = entry.name;
        log.detail = entry.detail;
        log.outcome = entry.outcome;
      } else {
        log.lines.push(entry);
        if (log.lines.length > MAX_LINES) log.lines.splice(0, log.lines.length - MAX_LINES);
      }
      changed = true;
    }
    return changed;
  }

  get(key: string, agent: string): AgentLog | undefined {
    return this.conversations.get(key)?.get(agent);
  }

  /** Only the conversations `keys` keep their subagents' logs: the host let the others go. */
  retain(keys: ReadonlySet<string>): void {
    for (const key of this.conversations.keys()) if (!keys.has(key)) this.conversations.delete(key);
  }

  /** The subagent's log, made with its first entry; named plainly until its start entry comes, which the host's bounded history may have dropped. */
  private log(key: string, agent: string): AgentLog {
    let logs = this.conversations.get(key);
    if (!logs) {
      logs = new Map();
      this.conversations.set(key, logs);
    }
    let log = logs.get(agent);
    if (!log) {
      log = { name: 'Subagent', detail: '', lines: [] };
      logs.set(agent, log);
      // A Map keeps insertion order: the oldest subagents give way.
      for (const oldest of logs.keys()) {
        if (logs.size <= MAX_AGENTS) break;
        logs.delete(oldest);
      }
    }
    return log;
  }
}
