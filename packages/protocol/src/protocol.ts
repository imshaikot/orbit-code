// Every message that crosses a process or thread boundary in Orbit.
// Shared by the extension host, the indexer worker thread and the webview.

export const PROTOCOL_VERSION = 13;

export interface GraphNode {
  /** Workspace-relative POSIX path. Stable key; session events resolve to it. */
  id: string;
  /** Absolute path on disk. Host only, never sent to the webview. */
  path: string;
  /** POSIX dirname of `id` ("." for files at the workspace root). */
  dir: string;
  /** Bytes. */
  size: number;
  /** Modification time in ms. Missing in older graph.json files; the next update then re-reads the file. */
  mtime?: number;
  /** Local imports that matched no file in the graph. Such files are read again when files are added. */
  unresolved?: number;
}

export interface GraphEdge {
  source: string;
  target: string;
}

export interface IndexStats {
  files: number;
  depcruiseFiles: number;
  regexFiles: number;
  edges: number;
  unresolvedImports: number;
  /** JS/TS files dependency-cruiser could not process; they were regex scanned instead. */
  depcruiseFallbacks: number;
  ms: number;
  truncated: boolean;
  /** Manifests imports were resolved through, by kind: npm, tsconfig, go, cargo, python, composer, pubspec, dotnet, swift. */
  projects?: Record<string, number>;
  /** Set when the graph was updated from a previous one instead of indexed from scratch. */
  changes?: GraphChanges;
}

export interface GraphChanges {
  added: number;
  removed: number;
  /** Files already in the graph whose size or mtime changed, or that the watcher reported. */
  changed: number;
  /** Files whose imports were extracted again; the rest kept their edges. */
  extracted: number;
}

export interface GraphFile {
  version: 1;
  hash: string;
  root: string;
  /**
   * Fingerprint of the project configuration imports were resolved through (package names, module paths, tsconfigs,
   * source roots). An update under a different one reads every file again. Missing in older graph.json files.
   */
  projects?: string;
  indexedAt: number;
  stats: IndexStats;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** What the host can do besides what every host does; a webview that never hears assumes VS Code's. */
export interface HostCapabilities {
  /** The host shows a file, or its diff against HEAD, in an editor tab of its own (`file` request `show`, `openFile`). */
  tabs: boolean;
}

export type HostToWebview =
  /** Sent first in every snapshot. */
  | { type: 'host'; capabilities: HostCapabilities }
  | { type: 'status'; phase: 'indexing' | 'error'; message: string; progress?: number }
  | { type: 'graph'; delta: GraphDelta }
  | { type: 'activity'; delta: ActivityDelta }
  | { type: 'sessions'; sessions: SessionsSnapshot }
  | { type: 'session'; state: SessionState }
  | { type: 'transcript'; key: string; reset: boolean; entries: TranscriptEntry[] }
  | { type: 'catalog'; catalog: AgentCatalog }
  | { type: 'history'; history: HistorySnapshot }
  /** Files the host's picker returned (answering `pickFiles`), to attach to the prompt: workspace ids, or absolute paths outside the workspace. */
  | { type: 'attachFiles'; files: string[] }
  | { type: 'visibility'; visible: boolean }
  /** The answer to the `file` request with the same `id`; a followed file keeps sending `content` under that `id`. */
  | { type: 'file'; id: number; path: string; reply: FileReply };

/** Coarse and columnar. Node index = array position, stable for a given hash. */
export type GraphDelta = GraphReset | GraphUpdate;

/** One whole graph. Node index = array position. */
export interface GraphContent {
  hash: string;
  /** Workspace folder name, display only. */
  root: string;
  indexedAt: number;
  cached: boolean;
  stats: IndexStats;
  nodes: NodeColumns;
  /** [src0, dst0, src1, dst1, …] node indices, deduplicated, no self-loops. */
  edges: Uint32Array;
}

/** Start over: a new World, camera back to the overview. */
export interface GraphReset extends GraphContent {
  op: 'reset';
  /** Present iff a frozen layout for `hash` is known. */
  layout?: LayoutSnapshot;
}

/**
 * Files were added, removed or changed. Still the whole graph (a receiver without `baseHash`
 * treats it as a reset), plus how node indices moved so animation state carries over.
 */
export interface GraphUpdate extends GraphContent {
  op: 'update';
  baseHash: string;
  /** Base node index → node index in this graph, -1 for removed files. A file Orbit renamed within its directory maps to its new name. */
  remap: Int32Array;
  /** Node indices (in this graph) of files new since the base graph, renamed ones included. */
  added: Uint32Array;
  /** Base node indices of files that are gone. */
  removed: Uint32Array;
  /** The base layout extended: kept files keep their positions. */
  layout: LayoutSnapshot;
}

export interface NodeColumns {
  count: number;
  /** Unique directories. */
  dirs: string[];
  /** node → dirs[] */
  dirIndex: Uint32Array;
  /** Basenames. id = dirs[dirIndex[i]] === '.' ? names[i] : dirs[dirIndex[i]] + '/' + names[i] */
  names: string[];
  /** Bytes. */
  sizes: Float32Array;
}

/** Nested directory bubbles (see shared/dirTree.ts): every cluster is one directory, inside its parent directory's. */
export interface LayoutSnapshot {
  hash: string;
  /** xyz per node, frozen. */
  positions: Float32Array;
  /** node → the cluster (bubble) the file sits in directly: its directory's. */
  clusterOf: Uint16Array;
  clusters: {
    /** Directory each cluster represents, "." first, in canonical order: parents before children, subtrees contiguous. */
    labels: string[];
    /** xyz per cluster. */
    centers: Float32Array;
    radii: Float32Array;
  };
}

/** What the scene animates from one host tick (100 ms): one message, any number of events. */
export interface ActivityDelta {
  seq: number;
  /** The graph the node indices belong to; deltas for any other graph are dropped. */
  hash: string;
  /** The conversation whose turn did this; each running one has its own star in the scene. */
  key: string;
  events: ActivityEvent[];
}

/**
 * `thinking`: Claude is thinking (at most one per delta), and every import line on screen fires.
 * `mcp`: a tool of an MCP server was called (`call`) or answered (`done`, `error`); `server` is the name as it appears
 * in the tool name (`mcp__<server>__<tool>`). Not tied to a node, so it passes whatever graph is loaded.
 * `agent`: a subagent of the conversation did it, named by the id of the tool call running it. `agentStart` brings the
 * subagent's own star out of the conversation's (`name`: its type), and `agentEnd` sends it back; neither has a node.
 */
export type ActivityEvent =
  | { kind: 'read' | 'edit'; node: number; agent?: string }
  | { kind: 'thinking' }
  | { kind: 'turnEnd' }
  | { kind: 'mcp'; server: string; tool: string; phase: 'call' | 'done' | 'error'; agent?: string }
  | { kind: 'agentStart'; agent: string; name: string }
  | { kind: 'agentEnd'; agent: string };

/** Claude Code permission modes Orbit offers. `default` passes no flag, so the user's own settings apply. */
export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** Claude Code effort levels (`--effort`), least to most. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export interface SessionOptions {
  /** Model alias or id; '' means the agent's default. */
  model: string;
  /** How hard the agent thinks; '' passes no --effort, so the user's own settings apply. */
  effort: EffortLevel | '';
  permissionMode: PermissionMode;
}

export type SessionPhase =
  /** Nothing can be started (no CLI, untrusted workspace, no folder); `error` says why. */
  | 'unavailable'
  | 'idle'
  | 'working'
  /** Interrupt sent, waiting for the turn to wind down. */
  | 'stopping';

/**
 * One conversation with the agent. Orbit runs several at once, each with its own agent process: a prompt sent while
 * the conversation the drawer continues is busy starts another one beside it.
 */
export interface SessionState {
  /** Orbit's own id for the conversation, assigned by the host and stable for its life (unlike `sessionId`, which the agent assigns). */
  key: string;
  phase: SessionPhase;
  /** Why the session is unavailable, or what went wrong most recently. */
  error?: string;
  /** Agent name and version, e.g. "Claude Code 2.1.267". */
  agent?: string;
  /** Set once the agent has started a conversation; the next prompt continues it. */
  sessionId?: string;
  /** The model the agent reported, which may be more specific than `options.model`. */
  model?: string;
  options: SessionOptions;
  /** Finished turns in this conversation. */
  turns: number;
  /** List-price cost the agent reported for this conversation. */
  costUsd: number;
  permission?: PermissionRequest;
}

/** Every conversation, oldest first, and the one the drawer continues (the newest prompted, resumed or started). */
export interface SessionsSnapshot {
  states: SessionState[];
  current: string;
}

/** Allow once, allow and don't ask again (what `PermissionRequest.always` says), or deny. */
export const PERMISSION_ANSWERS = ['allow', 'always', 'deny'] as const;
export type PermissionAnswer = (typeof PERMISSION_ANSWERS)[number];

export interface PermissionRequest {
  id: string;
  tool: string;
  /** Path, command or other one-line summary of what the tool would do. */
  detail: string;
  /**
   * The "don't ask again" choice the agent offers for this request, as its label ("Allow all edits this
   * session", "Always allow in this project"); absent when it offers none.
   */
  always?: string;
  /** Claude's questions (AskUserQuestion): answered with an answer to each instead of Allow, skipped with Deny. */
  questions?: Question[];
}

/** One question of an AskUserQuestion call. */
export interface Question {
  /** The question as Claude asked it; answers are keyed by it. */
  question: string;
  /** A short label for it ("Scope"). */
  header?: string;
  options: QuestionOption[];
  /** More than one option may be picked. */
  multiSelect: boolean;
}

export interface QuestionOption {
  label: string;
  description?: string;
}

/** What the agent offers in this workspace, asked of it without starting a conversation. */
export interface AgentCatalog {
  /** False until the agent has answered; the drawer then offers the model aliases it knows anyway. */
  known: boolean;
  loading: boolean;
  error?: string;
  models: ModelChoice[];
  skills: SkillInfo[];
  mcpServers: McpServerInfo[];
  /** The MCP view's process; absent from a host that has none. */
  mcp?: McpState;
}

export interface ModelChoice {
  /** Passed as --model; '' is the agent's own default. */
  value: string;
  label: string;
  description?: string;
  /** The effort levels the model takes: empty when it takes none, absent when the agent did not say. */
  efforts?: EffortLevel[];
}

/** `project`: the workspace's .claude/skills; `user`: the user's own (~/.claude/skills); `plugin`: from an installed plugin. */
export type SkillScope = 'project' | 'user' | 'plugin';

export interface SkillInfo {
  /** As invoked: `/name`. Plugin skills are `plugin:name`. */
  name: string;
  description: string;
  argumentHint?: string;
  scope: SkillScope;
  plugin?: string;
  /** Workspace-relative SKILL.md of a project skill, which the panel can open. */
  file?: string;
  /** Other skills in the catalog this one names. */
  references: string[];
}

export interface McpServerInfo {
  name: string;
  /** connected, pending, needs-auth, failed, disabled, … as the agent reports it. */
  status: string;
  /** user, project, local, claudeai, dynamic, … */
  scope?: string;
  tools: number;
  /** stdio, http, sse, claudeai-proxy, …: the kind of connection only, never its command, URL or headers. */
  transport?: string;
  /** What the server says its version is. */
  version?: string;
  /** Tool names, the first MAX_MCP_TOOL_NAMES of them. */
  toolNames?: string[];
  /** Why it failed to connect, clipped, with anything shaped like a credential taken out. */
  error?: string;
  /** An action of the MCP view under way for it. */
  pending?: McpAction;
  /** How the last action went, in a sentence. */
  note?: string;
}

/** What the MCP view can do to a server, through the agent's own control requests (the settings `/mcp` changes). */
export const MCP_ACTIONS = ['reconnect', 'enable', 'disable', 'signIn', 'signOut'] as const;
export type McpAction = (typeof MCP_ACTIONS)[number];
export const MAX_MCP_TOOL_NAMES = 60;

/** The MCP view's own agent process: asking every server again (Reload) and when it last answered. */
export interface McpState {
  loading: boolean;
  /** Epoch ms of the last answer about the servers, from the catalog or the MCP view. */
  checkedAt?: number;
  error?: string;
}

/** Earlier conversations of this workspace, as the agent keeps them on disk. */
export interface HistorySnapshot {
  loading: boolean;
  error?: string;
  conversations: ConversationSummary[];
}

export interface ConversationSummary {
  id: string;
  title: string;
  /** Epoch ms. */
  startedAt: number;
  updatedAt: number;
  promptCount: number;
  /** The first few prompts, clipped. */
  prompts: string[];
  model?: string;
  branch?: string;
  /** Workspace-relative files Claude read or edited, most worked on first. */
  files: Array<{ id: string; reads: number; edits: number }>;
  mcpServers: string[];
  skills: string[];
}

/**
 * Append-only conversation log. The host keeps a bounded copy and resends it when the webview reloads. `agent`, on text,
 * tool and notice entries: a subagent wrote it, and a click on that subagent's star shows it; the session view shows the
 * conversation's own.
 */
export type TranscriptEntry =
  /** `skills` were attached to the prompt and are invoked with it; `files` went with it as context. */
  | { id: number; kind: 'prompt'; text: string; skills?: string[]; files?: string[] }
  | { id: number; kind: 'text'; text: string; agent?: string }
  /**
   * `file` is the workspace-relative id of the file the tool touched, which the transcript links to: a graph
   * file, or a source file Claude is writing that joins the graph with the next update. `mcp` is set for a tool of an MCP server.
   */
  | { id: number; kind: 'tool'; tool: string; detail: string; action?: 'read' | 'edit'; file?: string; mcp?: { server: string; tool: string }; agent?: string }
  | { id: number; kind: 'turn'; outcome: 'done' | 'interrupted' | 'failed'; durationMs: number; costUsd: number; message?: string }
  | { id: number; kind: 'notice'; level: 'info' | 'warn' | 'error'; text: string; agent?: string }
  /** A subagent started (no `outcome`), or its call returned: `name` is its type, `detail` what it was asked to do. */
  | { id: number; kind: 'agent'; agent: string; name: string; detail: string; outcome?: 'done' | 'interrupted' | 'failed' };

export type WebviewToHost =
  | { type: 'ready'; protocol: number }
  | { type: 'sceneReady'; hash: string }
  | { type: 'layoutComputed'; layout: LayoutSnapshot }
  | { type: 'reindex' }
  /**
   * `skills`: names from the catalog, invoked with the prompt. `files`: context for it, graph file ids or paths the host's
   * picker returned; the host drops any other. `key`: the conversation to continue (refused while it is
   * busy); without one, the current conversation takes it if idle, else a new conversation starts beside it.
   */
  | { type: 'prompt'; text: string; skills?: string[]; files?: string[]; key?: string }
  | { type: 'interrupt'; key: string }
  /** A fresh conversation becomes the one the drawer continues. */
  | { type: 'newSession' }
  | { type: 'refreshCatalog' }
  /** The MCP view's Reload: a new process loads every MCP server afresh, answered by `catalog` messages as their states come in. */
  | { type: 'reloadMcp' }
  /** A server the last `catalog` listed; answered by `catalog` messages carrying its `pending` action, then its `note`. */
  | { type: 'mcpAction'; server: string; action: McpAction }
  | { type: 'loadHistory' }
  /** VS Code's open dialog, for files to attach to the prompt; answered by `attachFiles` unless it was cancelled. */
  | { type: 'pickFiles' }
  /** An id from the last `history` message; the next prompt resumes that conversation. */
  | { type: 'resumeConversation'; id: string }
  | { type: 'sessionOptions'; options: Partial<SessionOptions> }
  /** `answers`: for a request with `questions`, the answer to each by question text; the host checks them against the request. */
  | { type: 'permission'; key: string; id: string; answer: PermissionAnswer; answers?: Record<string, string> }
  /** Workspace-relative; the host refuses anything outside the workspace. */
  | { type: 'openFile'; path: string }
  /** Something done to one graph file from the file menu or the editor sheet; `path` is its id. Answered by a `file` reply with the same `id`. */
  | { type: 'file'; id: number; path: string; request: FileRequest }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string };

/** How git sees a file. `changed`: it differs from HEAD, staged or not. `none`: not in a git work tree, or no git. */
export type GitFileState = 'none' | 'untracked' | 'clean' | 'changed';

export type FileRequest =
  /** Its git state, which decides whether the menu offers View diff. */
  | { kind: 'info' }
  /** Its text for the editor sheet. The file is then followed: outside changes arrive as more `content` replies, until `close`. */
  | { kind: 'read' }
  /** Saves the sheet's text. A conflict unless the document is still at `revision` (the last `content` the sheet took), or `force`. */
  | { kind: 'write'; text: string; revision: number; force: boolean }
  /** The editor sheet closed: stop following. */
  | { kind: 'close' }
  /** A VS Code editor tab beside Orbit; `diff` shows the changes against HEAD. */
  | { kind: 'show'; diff: boolean }
  | { kind: 'delete' }
  | { kind: 'rename'; to: string };

export type FileReply =
  | { kind: 'info'; git: GitFileState }
  /**
   * The document's text (unsaved edits in VS Code included), its VS Code language id and a revision number to save against.
   * `base` is the HEAD version when the file has changes (empty for a file HEAD lacks). `outside`: a change made elsewhere.
   */
  | { kind: 'content'; text: string; revision: number; language: string; base?: string; outside: boolean }
  | { kind: 'saved'; revision: number }
  | { kind: 'shown' }
  | { kind: 'closed' }
  | { kind: 'deleted' }
  | { kind: 'renamed'; to: string }
  /** `conflict`: a write refused because the document changed since `revision`. */
  | { kind: 'failed'; error: string; conflict?: boolean };

/* ── Internal channels (not VS Code postMessage) ────────────────────────── */

/** Host → @orbit-code/indexer's dist/indexer.mjs (worker_threads workerData). */
export interface IndexerRequest {
  root: string;
  files: { id: string; path: string }[];
  truncated: boolean;
  /** Update from this graph: only new, changed or affected files are read again. */
  previous?: GraphFile;
  /** Ids to read again even if their size and mtime look unchanged (the watcher saw them change). */
  changed?: string[];
}

export type IndexerResponse =
  | { type: 'progress'; stage: 'stat' | 'depcruise' | 'regex'; done: number; total: number }
  | { type: 'done'; graph: GraphFile }
  | { type: 'error'; message: string };

/** Webview main thread ↔ layout Web Worker. Typed arrays are transferred. */
export interface LayoutRequest {
  hash: string;
  nodes: NodeColumns;
  edges: Uint32Array;
}

export type LayoutResponse =
  | { type: 'progress'; stage: 'files' | 'clusters'; done: number; total: number }
  | { type: 'done'; layout: LayoutSnapshot };
