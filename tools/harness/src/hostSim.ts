// Stand-in for an Orbit host inside a plain browser page (tools/harness/harness.mjs).
// Speaks the same protocol as apps/vscode/src/controller.ts over window.postMessage. Instead of
// a live agent it plays a scripted turn over real files of the graph under test, so the
// harness can exercise activity, the transcript and the composer deterministically.

import { TickBatcher } from '@orbit-code/common/tickBatcher';
import { toColumnar } from '@orbit-code/graph/columnar';
import { dirnameOf } from '@orbit-code/graph/languages';
import { extendLayout } from '@orbit-code/graph/layoutExtend';
import type {
  ActivityEvent,
  AgentCatalog,
  ConversationSummary,
  FileReply,
  FileRequest,
  GitFileState,
  GraphFile,
  HostToWebview,
  LayoutSnapshot,
  Question,
  SessionState,
  SessionsSnapshot,
  TranscriptEntry,
  WebviewToHost,
} from '@orbit-code/protocol';

interface HarnessConfig {
  graph: GraphFile;
}

type NewEntry = TranscriptEntry extends infer E ? (E extends TranscriptEntry ? Omit<E, 'id'> : never) : never;

const TICK_MS = 100;
const STEP_MS = 650;
const GOLDEN = 0.618033988749895;

const config = JSON.parse(document.getElementById('harness-config')!.textContent!) as HarnessConfig;
let graph = config.graph;
const received: string[] = [];
const prompts: string[] = [];
/** Every prompt with the skills and files attached to it. */
const skillPrompts: Array<{ text: string; skills: string[]; files: string[]; key?: string }> = [];
/** Conversations the webview asked to continue. */
const resumed: string[] = [];
const logs: string[] = [];

/** What the harness pretends Claude Code offers: the models 2.1.267 reports, skills of every scope that name each other, MCP servers in every state. */
const catalog: AgentCatalog = {
  known: true,
  loading: false,
  models: [
    { value: '', label: 'Default (recommended)', description: 'Sonnet 5 · Efficient for routine tasks', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'sonnet', label: 'Sonnet', description: 'Sonnet 5 · Efficient for routine tasks', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'claude-fable-5-1[1m]', label: 'Fable', description: 'Fable 5.1 · Most capable for your hardest and longest-running tasks', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'opus', label: 'Opus', description: 'Opus 5 · Best for everyday, complex tasks', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'haiku', label: 'Haiku', description: 'Haiku 4.5 · Fastest for quick answers', efforts: [] },
    { value: 'opus[1m]', label: 'Opus (1M context)', description: 'Opus 5 with 1M context · Best for everyday, complex tasks', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  ],
  skills: [
    { name: 'claude-in-orbit', description: 'How Claude Code runs inside Orbit, and how to change it safely.', argumentHint: 'Describe the change', scope: 'project', file: '.claude/skills/claude-in-orbit/SKILL.md', references: ['graph-pipeline', 'orbit-extension'] },
    { name: 'graph-pipeline', description: 'Change the graph pipeline without breaking live updates.', scope: 'project', file: '.claude/skills/graph-pipeline/SKILL.md', references: ['orbit-extension'] },
    { name: 'orbit-extension', description: 'Build, wire, run and ship the extension.', scope: 'project', file: '.claude/skills/orbit-extension/SKILL.md', references: ['claude-in-orbit'] },
    { name: 'render-visual', description: 'Diagrams, slides and social cards as crisp PNGs.', scope: 'user', references: [] },
    { name: 'release-notes', description: 'Release notes from the changes since a tag.', scope: 'user', references: ['render-visual'] },
    { name: 'frontend-design:frontend-design', description: 'Distinctive, intentional visual design.', scope: 'plugin', plugin: 'frontend-design', references: [] },
  ],
  mcpServers: [
    { name: 'docs', status: 'connected', scope: 'user', tools: 4, transport: 'stdio', version: '1.4.0', toolNames: ['search', 'fetch', 'outline', 'cite'] },
    { name: 'github', status: 'needs-auth', scope: 'user', tools: 0, transport: 'http' },
    {
      name: 'claude.ai Linear',
      status: 'connected',
      scope: 'claudeai',
      tools: 9,
      transport: 'claudeai-proxy',
      version: '2.0.1',
      toolNames: ['list_issues', 'get_issue', 'create_issue', 'update_issue', 'list_projects', 'list_teams', 'list_comments', 'create_comment', 'search_documentation'],
    },
    { name: 'sentry', status: 'failed', scope: 'project', tools: 0, transport: 'stdio', error: 'MCP error -32000: Connection closed' },
    { name: 'local-db', status: 'disabled', scope: 'local', tools: 0, transport: 'stdio' },
  ],
  mcp: { loading: false, checkedAt: Date.now() - 4 * 60_000 },
};
/** How each MCP server really is, as a Reload finds it; the MCP view's actions change it. */
const mcpStatuses = new Map(catalog.mcpServers.map((server) => [server.name, server.status]));
/** What the MCP view asked of the host, in order. */
const mcpActions: Array<{ server: string; action: string }> = [];
let mcpReloads = 0;
const MCP_NOTES: Record<string, string> = {
  reconnect: 'Reconnected.',
  enable: 'Enabled in your Claude Code settings. Each conversation loads it from its next prompt.',
  disable: 'Disabled in your Claude Code settings. Each conversation goes without it from its next prompt.',
  signIn: 'Signed in.',
  signOut: 'Signed out.',
};
let layoutClusters: number | undefined;
/** The layout the webview holds for `graph`, which a live update extends. */
let layout: LayoutSnapshot | undefined;
let firstTurnPlayed = false;
let seq = 0;

/** One conversation, the way the host keeps them: its state, its turn's timers, and its transcript ids. */
interface Conversation {
  readonly key: string;
  readonly state: SessionState;
  timers: ReturnType<typeof setTimeout>[];
  nextEntry: number;
}

const chats: Conversation[] = [];
let keys = 0;
/** The conversation the drawer continues, as the host names it. */
let current = open().key;

const send = (message: HostToWebview) => window.postMessage(message, '*');
const sendState = (conversation: Conversation) => send({ type: 'session', state: { ...conversation.state } });
const sessions = (): SessionsSnapshot => ({ states: chats.map((conversation) => ({ ...conversation.state })), current });
const sendSessions = () => send({ type: 'sessions', sessions: sessions() });

function open(): Conversation {
  const key = `sim-${++keys}`;
  const conversation: Conversation = {
    key,
    state: { key, phase: 'idle', agent: 'Harness agent', model: 'scripted', options: { model: '', effort: '', permissionMode: 'default' }, turns: 0, costUsd: 0 },
    timers: [],
    nextEntry: 1,
  };
  chats.push(conversation);
  return conversation;
}

const find = (key: string) => chats.find((conversation) => conversation.key === key);
const currentConversation = () => find(current) ?? chats[0];
const busy = (conversation: Conversation) => conversation.state.phase === 'working' || conversation.state.phase === 'stopping';
const fresh = (conversation: Conversation) => conversation.state.turns === 0 && conversation.state.sessionId === undefined && !busy(conversation);
/** The conversation a stray step (a thought, an MCP call, a permission request) belongs to: the latest one working, else the current. */
const running = () => chats.findLast(busy) ?? currentConversation();

function makeCurrent(conversation: Conversation): void {
  if (conversation.key === current) return;
  current = conversation.key;
  sendSessions();
}

const batch = new TickBatcher<{ key: string; event: ActivityEvent } | { key: string; entry: TranscriptEntry }>(TICK_MS, (items) => {
  for (const key of new Set(items.map((item) => item.key))) {
    const events = items.flatMap((item) => ('event' in item && item.key === key ? [item.event] : []));
    const entries = items.flatMap((item) => ('entry' in item && item.key === key ? [item.entry] : []));
    if (events.length) send({ type: 'activity', delta: { seq: ++seq, hash: graph.hash, key, events } });
    if (entries.length) send({ type: 'transcript', key, reset: false, entries });
  }
});

function entry(conversation: Conversation, value: NewEntry): void {
  batch.push({ key: conversation.key, entry: { id: conversation.nextEntry++, ...value } as TranscriptEntry });
}

function touch(conversation: Conversation, kind: 'read' | 'edit', k: number): void {
  const node = Math.floor(((k * GOLDEN) % 1) * graph.nodes.length);
  const id = graph.nodes[node].id;
  batch.push({ key: conversation.key, event: { kind, node } });
  entry(conversation, { kind: 'tool', tool: kind === 'read' ? 'Read' : 'Edit', detail: id, action: kind, file: id });
}

function think(conversation = running()): void {
  batch.push({ key: conversation.key, event: { kind: 'thinking' } });
}

/** Claude calls a tool of the `docs` MCP server; the answer (a failure with `fail`) follows `answerMs` later. */
function mcp(answerMs = 900, fail = false): void {
  const conversation = running();
  batch.push({ key: conversation.key, event: { kind: 'mcp', server: 'docs', tool: 'search', phase: 'call' } });
  entry(conversation, { kind: 'tool', tool: 'mcp__docs__search', detail: 'layout cache', mcp: { server: 'docs', tool: 'search' } });
  setTimeout(() => batch.push({ key: conversation.key, event: { kind: 'mcp', server: 'docs', tool: 'search', phase: fail ? 'error' : 'done' } }), answerMs);
}

/**
 * Eighteen earlier conversations over files of the graph under test, some sharing files, the newest first: several
 * today, fewer further back, as a workspace's history tends to be. Enough of them for the timeline to be wider than the panel.
 */
function conversations(): ConversationSummary[] {
  const now = Date.now();
  const file = (k: number) => graph.nodes[Math.floor(((k * GOLDEN) % 1) * graph.nodes.length)]?.id ?? 'README.md';
  const titles = [
    'Cache the layout per graph hash',
    'Why the camera drifts after a live update',
    'A legend for file kinds',
    'Speed up the regex scan',
    'Explain the bubble layout',
    'Fix the Esc order in the drawer',
    'Batch the watcher paths',
    'Colours for Go and Dart',
    'Why is this import unresolved',
    'Tidy the permission card',
    'Pack sibling bubbles tighter',
    'Check the stream-json parser',
    'Keep the transcript to 400 entries',
    'Profile the edge shader',
    'Move the tooltip off the pointer',
    'Explain the dependency-cruiser batches',
    'Resume a conversation after a crash',
    'First look at the extension host',
  ];
  const hoursAgo = [1, 3, 6, 9, 26, 29, 50, 54, 78, 101, 124, 150, 175, 220, 270, 330, 420, 520];
  return titles.map((title, k) => ({
    id: `harness-conversation-${k + 1}`,
    title,
    startedAt: now - hoursAgo[k] * 3_600_000 - 40 * 60_000,
    updatedAt: now - hoursAgo[k] * 3_600_000,
    promptCount: 3 + ((k * 5) % 9),
    prompts: [title, `Now look at ${file(k + 1)}`, 'Run the checks again'],
    model: k % 2 === 0 ? 'claude-opus-5' : 'claude-sonnet-5',
    branch: 'main',
    files: [
      { id: file(k + 11), reads: 2, edits: k % 2 },
      { id: file(k % 3), reads: 3, edits: 1 },
    ],
    mcpServers: k === 1 ? ['docs'] : [],
    skills: k === 0 ? ['graph-pipeline'] : [],
  }));
}

/**
 * A permission request inside the running turn, reported the way the host does: as part of the session state,
 * with the "don't ask again" choice the agent offers (`always`, its label; '' for none).
 */
function ask(tool = 'Bash', detail = 'npm run build', always = 'Always allow in this project'): void {
  const conversation = running();
  if (conversation.state.phase !== 'working') return;
  conversation.state.permission = { id: `harness-permission-${conversation.key}-${conversation.nextEntry}`, tool, detail, ...(always ? { always } : {}) };
  sendState(conversation);
}

/** Claude's questions (AskUserQuestion) inside the running turn, reported like a permission request; `answers` keeps what came back. */
function askQuestions(questions: Question[] = HARNESS_QUESTIONS): void {
  const conversation = running();
  if (conversation.state.phase !== 'working') return;
  conversation.state.permission = { id: `harness-question-${conversation.key}-${conversation.nextEntry}`, tool: 'AskUserQuestion', detail: '', questions };
  sendState(conversation);
}

const HARNESS_QUESTIONS: Question[] = [
  {
    question: 'Which checks should run?',
    header: 'Checks',
    options: [{ label: 'Typecheck', description: 'Both tsconfigs' }, { label: 'Harness' }, { label: 'Smoke' }],
    multiSelect: true,
  },
  { question: 'Where should the change go?', header: 'Scope', options: [{ label: 'The webview' }, { label: 'The extension host' }], multiSelect: false },
];

/** Answers the session view sent for questions, oldest first (`undefined` for a skip). */
const answered: (Record<string, string> | undefined)[] = [];

/** A reply in the Markdown Claude writes, so the session view renders a heading, nested lists, a table, code and a quote. */
function reply(prompt: string): string {
  const [first, second] = [graph.nodes[0]?.id ?? 'README.md', graph.nodes[1]?.id ?? 'package.json'];
  return [
    '### Scripted reply',
    `For **${prompt}**, the host sends one \`graph\` message and the webview lays it out:`,
    '',
    `1. [${first}](${first}) is read first`,
    `2. then \`${second}\`, with *two* imports`,
    '   - a nested item',
    '   - [x] a finished task',
    '',
    '| Step | Where |',
    '| --- | --- |',
    `| Index | \`${first}\` |`,
    '| Layout | the layout worker |',
    '',
    '```ts',
    "host.post({ type: 'ready', protocol: PROTOCOL_VERSION });",
    '```',
    '',
    '> Reads light up cyan, edits pulse amber.',
  ].join('\n');
}

/**
 * A turn, the way the host takes a prompt: in the conversation `key`, else in the current one when idle, else in a new
 * conversation beside it. Returns the key of the conversation that took it, or undefined when `key` names a busy one.
 */
function playTurn(prompt: string, skills: string[] = [], files: string[] = [], key?: string): string | undefined {
  const conversation = key !== undefined ? find(key) : busy(currentConversation()) ? open() : currentConversation();
  if (!conversation || busy(conversation)) return undefined;
  makeCurrent(conversation);
  const { state } = conversation;
  state.phase = 'working';
  sendState(conversation);
  entry(conversation, { kind: 'prompt', text: prompt, ...(skills.length > 0 ? { skills } : {}), ...(files.length > 0 ? { files } : {}) });
  // The reads and edits spread over the graph differently per conversation, so two turns at once touch different files.
  const spread = chats.indexOf(conversation) * 7;
  const steps: Array<() => void> = [
    () => think(conversation),
    () => entry(conversation, { kind: 'text', text: reply(prompt) }),
    () => (touch(conversation, 'read', spread + 1), touch(conversation, 'read', spread + 2)),
    () => touch(conversation, 'read', spread + 3),
    () => think(conversation),
    () => touch(conversation, 'edit', spread + 3),
    () => (touch(conversation, 'read', spread + 4), touch(conversation, 'read', spread + 5)),
    () => touch(conversation, 'edit', spread + 5),
    () => entry(conversation, { kind: 'text', text: 'Scripted turn finished.' }),
    () => endTurn(conversation, 'done'),
  ];
  conversation.timers = steps.map((step, i) => setTimeout(step, (i + 1) * STEP_MS));
  return conversation.key;
}

function stopTurn(conversation: Conversation): void {
  for (const timer of conversation.timers) clearTimeout(timer);
  conversation.timers = [];
}

/** Subagents `subagent()` started and not ended yet, by id: the conversation each works for, what it is, and whether it opened its own turn. */
const subagents = new Map<string, { conversation: Conversation; name: string; detail: string; ownTurn: boolean; reads: number }>();
let subagentsMade = 0;

function endTurn(conversation: Conversation, outcome: 'done' | 'interrupted'): void {
  const steps = conversation.timers.length;
  stopTurn(conversation);
  const { state } = conversation;
  if (state.phase === 'idle') return;
  // Subagents still out end with the turn, ahead of its end, as the host ends them.
  for (const [agent, open] of [...subagents]) if (open.conversation === conversation) closeSubagent(agent, outcome);
  batch.push({ key: conversation.key, event: { kind: 'turnEnd' } });
  entry(conversation, { kind: 'turn', outcome, durationMs: STEP_MS * steps, costUsd: 0 });
  state.phase = 'idle';
  state.permission = undefined;
  state.turns++;
  sendState(conversation);
}

/** Every running turn ends now. */
function pause(): void {
  for (const conversation of chats.filter(busy)) endTurn(conversation, 'interrupted');
}

/**
 * A subagent of the running conversation, reported the way the host reports one: its star comes out of Claude's, and its
 * log gets a Grep and a line of text. It stays out until `subagentEnd()` or its turn's end. With no turn running, it
 * opens one in the current conversation for itself, which its end closes. Returns its id, the tool call running it.
 */
function subagent(name = 'Explore', detail = 'Find where the graph message reaches the webview'): string {
  const conversation = running();
  const ownTurn = !busy(conversation);
  if (ownTurn) {
    conversation.state.phase = 'working';
    sendState(conversation);
    entry(conversation, { kind: 'prompt', text: 'A harness subagent' });
  }
  const agent = `toolu_harness_${++subagentsMade}`;
  subagents.set(agent, { conversation, name, detail, ownTurn, reads: 0 });
  entry(conversation, { kind: 'tool', tool: 'Task', detail });
  batch.push({ key: conversation.key, event: { kind: 'agentStart', agent, name } });
  entry(conversation, { kind: 'agent', agent, name, detail });
  entry(conversation, { kind: 'tool', tool: 'Grep', detail: 'postMessage', agent });
  entry(conversation, { kind: 'text', text: 'Subagent report: HostBridge posts the graph once, as a reset.', agent });
  return agent;
}

/** The subagent `agent` reads a file of the graph: its star leaves Claude's side for the file. */
function subagentRead(agent: string): void {
  const open = subagents.get(agent);
  if (!open) return;
  const node = Math.floor((((++open.reads + subagentsMade) * 5 * GOLDEN) % 1) * graph.nodes.length);
  const id = graph.nodes[node].id;
  batch.push({ key: open.conversation.key, event: { kind: 'read', node, agent } });
  entry(open.conversation, { kind: 'tool', tool: 'Read', detail: id, action: 'read', file: id, agent });
}

/** The subagent `agent`'s call returns: its star goes back into Claude's, and the turn it opened, if it did, ends. */
function subagentEnd(agent: string, outcome: 'done' | 'interrupted' | 'failed' = 'done'): void {
  const open = subagents.get(agent);
  if (!open) return;
  closeSubagent(agent, outcome);
  if (open.ownTurn) endTurn(open.conversation, outcome === 'interrupted' ? 'interrupted' : 'done');
}

function closeSubagent(agent: string, outcome: 'done' | 'interrupted' | 'failed'): void {
  const open = subagents.get(agent);
  if (!open) return;
  subagents.delete(agent);
  batch.push({ key: open.conversation.key, event: { kind: 'agentEnd', agent } });
  entry(open.conversation, { kind: 'agent', agent, name: open.name, detail: open.detail, outcome });
}

/* ── Files: what the file menu and the editor sheet ask of the host ── */

/** What was done to files, for the harness to check. */
const fileLog = {
  writes: [] as Array<{ path: string; text: string }>,
  shown: [] as Array<{ path: string; diff: boolean }>,
  deleted: [] as string[],
  renamed: [] as Array<{ from: string; to: string }>,
};
/** Git state by file; any other file counts as changed, so View diff shows. */
const gitStates = new Map<string, GitFileState>();
/** Text saved from the editor sheet, by file. */
const savedTexts = new Map<string, string>();
let revisions = 0;
/** The file the editor sheet follows, and the request id its outside changes go out under. */
let followed: { id: number; path: string; revision: number } | undefined;
/** How long the host takes from a delete or rename to the graph update that shows it. */
const FILE_UPDATE_MS = 600;

/** Invented contents: the imports the graph knows of, then a small function. */
function originalText(path: string): string {
  const imports = graph.edges.filter((edge) => edge.source === path).map((edge) => `import './${edge.target}';`);
  return [`// ${path}`, ...imports, '', 'export function scripted(input: number): number {', '  const doubled = input * 2;', '  return doubled + 1;', '}', ''].join('\n');
}

function fileText(path: string): string {
  return savedTexts.get(path) ?? originalText(path);
}

/** HEAD's version: one line different and one line fewer, so the diff has a change and an insertion to show. */
function headText(path: string): string {
  return originalText(path).replace('input * 2', 'input + input').replace('  return doubled + 1;\n', '');
}

function content(path: string, revision: number, outside: boolean): FileReply {
  const changed = (gitStates.get(path) ?? 'changed') === 'changed';
  return { kind: 'content', text: fileText(path), revision, language: path.endsWith('.ts') ? 'typescript' : 'plaintext', base: changed ? headText(path) : undefined, outside };
}

function fileRequest(id: number, path: string, request: FileRequest): void {
  const reply = (value: FileReply) => send({ type: 'file', id, path, reply: value });
  if (request.kind !== 'close' && !graph.nodes.some((node) => node.id === path)) {
    reply({ kind: 'failed', error: `${path} is not in the graph.` });
    return;
  }
  switch (request.kind) {
    case 'info':
      reply({ kind: 'info', git: gitStates.get(path) ?? 'changed' });
      break;
    case 'read':
      followed = { id, path, revision: ++revisions };
      reply(content(path, followed.revision, false));
      break;
    case 'write':
      if (followed?.path !== path) reply({ kind: 'failed', error: `${path} is not open in the editor.` });
      else if (!request.force && request.revision !== followed.revision) reply({ kind: 'failed', error: `${path} changed after you opened it.`, conflict: true });
      else {
        savedTexts.set(path, request.text);
        fileLog.writes.push({ path, text: request.text });
        followed.revision = ++revisions;
        reply({ kind: 'saved', revision: followed.revision });
      }
      break;
    case 'close':
      if (followed?.path === path) followed = undefined;
      reply({ kind: 'closed' });
      break;
    case 'show':
      fileLog.shown.push({ path, diff: request.diff });
      reply({ kind: 'shown' });
      break;
    case 'delete':
      fileLog.deleted.push(path);
      reply({ kind: 'deleted' });
      // As the host does: the graph follows the delete at once, not after the watcher's debounce.
      setTimeout(() => update({ remove: [path] }), FILE_UPDATE_MS);
      break;
    case 'rename':
      if (graph.nodes.some((node) => node.id === request.to)) {
        reply({ kind: 'failed', error: `${request.to} already exists.` });
        break;
      }
      fileLog.renamed.push({ from: path, to: request.to });
      if (followed?.path === path) followed.path = request.to;
      reply({ kind: 'renamed', to: request.to });
      setTimeout(() => update({ rename: [{ from: path, to: request.to }] }), FILE_UPDATE_MS);
      break;
  }
}

/** Someone else edits the file the editor sheet follows; false when none is followed. */
function outside(text?: string): boolean {
  if (!followed) return false;
  savedTexts.set(followed.path, text ?? `${fileText(followed.path)}// changed elsewhere\n`);
  followed.revision = ++revisions;
  send({ type: 'file', id: followed.id, path: followed.path, reply: content(followed.path, followed.revision, true) });
  return true;
}

interface FileChange {
  add?: Array<{ id: string; imports?: string[] }>;
  remove?: string[];
  /** Files the file menu renamed: within their directory they keep their place. */
  rename?: Array<{ from: string; to: string }>;
}

/**
 * A live update the way the extension host produces one: the graph with files added (and the imports each
 * brings) and removed, the current layout extended by the shared code, posted as one `update`.
 * Without arguments, one file joins the directory of the first importer and one file elsewhere goes.
 */
function update(change: FileChange = defaultChange()): { hash: string; files: number; added: string[]; removed: string[] } | { error: string } {
  if (!layout || layout.hash !== graph.hash) return { error: 'the webview has not reported a layout for the current graph' };
  const remove = new Set(change.remove ?? []);
  const renames = new Map((change.rename ?? []).map(({ from, to }) => [from, to]));
  const renamed = (id: string) => renames.get(id) ?? id;
  const previousIds = graph.nodes.map((node) => node.id);
  const known = new Set(previousIds);
  const nodes = graph.nodes
    .filter((node) => !remove.has(node.id))
    .map((node) => (renames.has(node.id) ? { ...node, id: renamed(node.id), path: renamed(node.id), dir: dirnameOf(renamed(node.id)) } : node));
  for (const file of change.add ?? []) {
    if (!known.has(file.id)) nodes.push({ id: file.id, path: file.id, dir: dirnameOf(file.id), size: 1800 });
  }
  nodes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const ids = new Set(nodes.map((node) => node.id));
  const edges = graph.edges.map((edge) => ({ source: renamed(edge.source), target: renamed(edge.target) })).filter((edge) => ids.has(edge.source) && ids.has(edge.target));
  for (const file of change.add ?? []) {
    for (const target of file.imports ?? []) if (ids.has(target) && target !== file.id) edges.push({ source: file.id, target });
  }

  const hash = fnv1a(`${graph.hash}\n${nodes.map((node) => node.id).join('\n')}\n${edges.length}`);
  const columns = toColumnar({ ...graph, nodes, edges });
  const extension = extendLayout(previousIds, layout, { hash, nodes: columns.nodes, edges: columns.edges }, new Map((change.rename ?? []).map(({ from, to }) => [to, from])));
  if (!extension) return { error: 'the layout does not describe the current graph' };
  const stats = { ...graph.stats, files: nodes.length, edges: columns.edges.length / 2, changes: { added: extension.added.length, removed: extension.removed.length, changed: 0, extracted: extension.added.length } };
  const next: GraphFile = { ...graph, hash, indexedAt: Date.now(), stats, nodes, edges };
  send({
    type: 'graph',
    delta: {
      op: 'update',
      hash,
      root: rootName(),
      indexedAt: next.indexedAt,
      cached: false,
      stats,
      nodes: columns.nodes,
      edges: columns.edges,
      baseHash: graph.hash,
      remap: extension.remap,
      added: extension.added,
      removed: extension.removed,
      layout: extension.layout,
    },
  });
  graph = next;
  layout = extension.layout;
  return { hash, files: nodes.length, added: [...extension.added].map((i) => nodes[i].id), removed: [...extension.removed].map((i) => previousIds[i]) };
}

function defaultChange(): FileChange {
  const importer = graph.edges[0]?.source ?? graph.nodes[0].id;
  const dir = dirnameOf(importer);
  return {
    add: [{ id: `${dir === '.' ? '' : `${dir}/`}__harness_added.ts`, imports: [importer] }],
    remove: [graph.nodes.findLast((node) => node.dir !== dir)?.id ?? ''],
  };
}

function rootName(): string {
  return graph.root.split(/[\\/]/).pop() ?? graph.root;
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let k = 0; k < text.length; k++) hash = Math.imul(hash ^ text.charCodeAt(k), 0x01000193);
  return `harness-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

/** The catalog with these MCP servers, sent the way the host sends every change to them. */
function publishMcp(servers: AgentCatalog['mcpServers']): void {
  catalog.mcpServers = servers;
  send({ type: 'catalog', catalog: { ...catalog, mcpServers: servers.map((server) => ({ ...server })) } });
}

function receive(message: WebviewToHost): void {
  received.push(message.type);
  switch (message.type) {
    case 'ready': {
      const { nodes, edges } = toColumnar(graph);
      send({ type: 'host', capabilities: { tabs: true } });
      send({ type: 'visibility', visible: true });
      send({
        type: 'graph',
        delta: {
          op: 'reset',
          hash: graph.hash,
          root: rootName(),
          indexedAt: graph.indexedAt,
          cached: false,
          stats: graph.stats,
          nodes,
          edges,
        },
      });
      sendSessions();
      send({ type: 'catalog', catalog });
      for (const conversation of chats) send({ type: 'transcript', key: conversation.key, reset: true, entries: [] });
      break;
    }
    case 'layoutComputed':
      layout = message.layout;
      layoutClusters = message.layout.clusters.labels.length;
      break;
    case 'sceneReady':
      if (!firstTurnPlayed) {
        firstTurnPlayed = true;
        playTurn('Show how the graph reaches the webview');
      }
      break;
    case 'prompt':
      prompts.push(message.text);
      skillPrompts.push({ text: message.text, skills: message.skills ?? [], files: message.files ?? [], key: message.key });
      playTurn(message.text, message.skills, message.files, message.key);
      break;
    case 'refreshCatalog':
      send({ type: 'catalog', catalog });
      break;
    case 'reloadMcp':
      // As the host: a new process finds every server connecting (the disabled ones aside), then how each really is.
      mcpReloads++;
      catalog.mcp = { ...catalog.mcp, loading: true, error: undefined };
      publishMcp(catalog.mcpServers.map(({ note: _note, ...server }) => ({ ...server, status: mcpStatuses.get(server.name) === 'disabled' ? 'disabled' : 'pending' })));
      setTimeout(() => {
        catalog.mcp = { loading: false, checkedAt: Date.now() };
        publishMcp(catalog.mcpServers.map((server) => ({ ...server, status: mcpStatuses.get(server.name) ?? server.status })));
      }, 600);
      break;
    case 'mcpAction': {
      const { server: name, action } = message;
      const target = catalog.mcpServers.find((server) => server.name === name);
      if (!target || target.pending) break;
      mcpActions.push({ server: name, action });
      publishMcp(catalog.mcpServers.map((server) => (server.name === name ? { ...server, pending: action, note: undefined } : server)));
      setTimeout(() => {
        // `sentry` never connects; anything else does what was asked.
        const failed = action === 'reconnect' && name === 'sentry';
        const status = failed ? 'failed' : action === 'disable' ? 'disabled' : action === 'signOut' ? 'needs-auth' : 'connected';
        mcpStatuses.set(name, status);
        publishMcp(
          catalog.mcpServers.map(({ pending: _pending, ...server }) =>
            server.name !== name
              ? server
              : {
                  ...server,
                  status,
                  note: failed ? 'Could not reconnect it: MCP error -32000: Connection closed' : MCP_NOTES[action],
                  ...(status === 'connected' && server.tools === 0 ? { tools: 3, toolNames: ['list_items', 'get_item', 'search'] } : {}),
                },
          ),
        );
      }, 500);
      break;
    }
    case 'loadHistory':
      send({ type: 'history', history: { loading: true, conversations: [] } });
      setTimeout(() => send({ type: 'history', history: { loading: false, conversations: conversations() } }), 150);
      break;
    case 'pickFiles':
      // As if two files were picked in the open dialog: one of the graph, and one outside the workspace with a space in its name.
      setTimeout(() => send({ type: 'attachFiles', files: [graph.nodes[Math.min(2, graph.nodes.length - 1)].id, '/tmp/harness notes.md'] }), 150);
      break;
    case 'resumeConversation': {
      // As the host: a conversation already holding it becomes current; else a fresh one takes it, opened if need be.
      resumed.push(message.id);
      const held = chats.find((conversation) => conversation.state.sessionId === message.id);
      const conversation = held ?? (fresh(currentConversation()) ? currentConversation() : open());
      if (!held) {
        conversation.state.sessionId = message.id;
        sendState(conversation);
        entry(conversation, { kind: 'notice', level: 'info', text: `Continuing ${message.id}. The next prompt picks it up where it left off.` });
      }
      makeCurrent(conversation);
      break;
    }
    case 'interrupt': {
      const conversation = find(message.key);
      if (conversation) endTurn(conversation, 'interrupted');
      break;
    }
    case 'newSession':
      if (!fresh(currentConversation())) makeCurrent(open());
      break;
    case 'permission': {
      const conversation = find(message.key);
      if (conversation?.state.permission?.id === message.id) {
        if (conversation.state.permission.questions) answered.push(message.answer === 'deny' ? undefined : message.answers);
        conversation.state.permission = undefined;
        sendState(conversation);
      }
      break;
    }
    case 'sessionOptions':
      for (const conversation of chats) {
        conversation.state.options = { ...conversation.state.options, ...message.options };
        sendState(conversation);
      }
      break;
    case 'file':
      fileRequest(message.id, message.path, message.request);
      break;
    case 'log':
      logs.push(`${message.level}: ${message.message}`);
      break;
  }
}

Object.assign(window, {
  // Through window.orbitHost, as any host but VS Code reaches the page (smoke covers acquireVsCodeApi).
  orbitHost: { postMessage: (message: WebviewToHost) => queueMicrotask(() => receive(message)) },
  __host: {
    received,
    prompts,
    skillPrompts,
    resumed,
    logs,
    /** Claude calls a tool of the `docs` MCP server; see `mcp`. */
    mcp,
    /** What the MCP view asked of the host (`mcpAction`), in order. */
    mcpActions,
    /** How many times the MCP view's Reload reached the host. */
    mcpReloads: () => mcpReloads,
    /** The MCP servers as the host last sent them. */
    mcpServers: () => catalog.mcpServers.map(({ name, status, pending, note }) => ({ name, status, pending, note })),
    layoutClusters: () => layoutClusters,
    /** The current conversation's state: what the drawer continues. */
    state: () => ({ ...currentConversation().state }),
    /** Every conversation and the current one, as the host reports them. */
    sessions,
    /** Ends every scripted turn now, so nothing is left animating once it settles. */
    pause,
    /** A turn in the conversation `key`, else in the current one, else in a new one beside a busy current; returns the key. */
    play: (prompt = 'Harness turn', key?: string) => playTurn(prompt, [], [], key),
    /** Claude thinks, in or out of a turn: every import line on screen fires. */
    think,
    /** A subagent of the running conversation (opening a turn if none runs); returns its id. See `subagent`. */
    subagent,
    /** The subagent reads a file of the graph: its star moves over it. */
    subagentRead,
    /** The subagent's call returns: its star goes back into Claude's, and a turn it opened ends. */
    subagentEnd,
    /** Claude asks to use a tool; the session view's card answers it. */
    ask,
    /** Claude asks questions (AskUserQuestion); the session view's question card answers them into `answered`. */
    askQuestions,
    answered,
    setVisible: (visible: boolean) => send({ type: 'visibility', visible }),
    /** Adds, removes and renames files and sends a live update; see `update`. */
    update,
    graph: () => ({ hash: graph.hash, files: graph.nodes.length }),
    /** What the file menu and the editor sheet did: saves, tabs, deletes and renames. */
    files: fileLog,
    /** Sets the git state `info` reports for a file (by default every file has changes). */
    git: (path: string, git: GitFileState) => gitStates.set(path, git),
    /** An edit made elsewhere to the file the editor sheet has open; see `outside`. */
    outside,
  },
});
