import { type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { McpAction, McpServerInfo, ModelChoice, PermissionAnswer } from '@orbit-code/protocol';
import type { AgentAvailability, AgentCatalogResult, AgentControl, AgentExit, AgentProcess, AgentProcessSink, AgentStartOptions, SessionBackend } from './backend';
import type { PermissionUpdate } from './permissions';
import { catalogSkills, findSkills } from './skillCatalog';
import { type AgentInput, type CliCommand, type ControlRequest, parseAuthUrl, parseCommands, parseControlAnswer, parseLine, parseMcpServers, parseModels } from './streamJson';

const STDERR_TAIL_BYTES = 4096;
const PROBE_TIMEOUT_MS = 15_000;
const KILL_GRACE_MS = 3000;
const CATALOG_TIMEOUT_MS = 20_000;
/** MCP servers still connecting are asked about again this often, this many times. */
const MCP_POLL_MS = 1000;
const MCP_POLLS = 3;

const BASE_ARGS = [
  '--print',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--verbose',
  // Permission prompts arrive as control requests Orbit answers, instead of being denied outright.
  '--permission-prompt-tool', 'stdio',
];

export interface ClaudeCliSettings {
  /** Executable; empty means PATH plus the usual install locations. */
  path: string;
  extraArgs: readonly string[];
}

/**
 * Runs the user's own Claude Code CLI (and so its login, settings, CLAUDE.md and MCP
 * servers) as a long-lived `--print` process speaking stream-json on stdin and stdout.
 */
export class ClaudeCliBackend implements SessionBackend {
  private executable: string | undefined;

  constructor(private readonly settings: () => ClaudeCliSettings) {}

  async probe(): Promise<AgentAvailability> {
    const configured = this.settings().path;
    const candidates = configured ? [expandHome(configured)] : defaultCandidates();
    for (const candidate of candidates) {
      const version = await versionOf(candidate);
      if (version === undefined) continue;
      this.executable = candidate;
      return { available: true, name: 'Claude Code', version: version || undefined, detail: candidate };
    }
    this.executable = undefined;
    return {
      available: false,
      reason: configured ? `Claude Code was not found at ${configured} (orbit.claude.path).` : 'Claude Code was not found. Install it, or set orbit.claude.path.',
    };
  }

  start(options: AgentStartOptions, sink: AgentProcessSink): AgentProcess {
    const executable = this.executable ?? (expandHome(this.settings().path) || 'claude');
    const args = [...BASE_ARGS];
    if (options.model) args.push('--model', options.model);
    // A model that takes no effort level (Haiku) runs as it would without it; the CLI says nothing.
    if (options.effort) args.push('--effort', options.effort);
    if (options.permissionMode !== 'default') args.push('--permission-mode', options.permissionMode);
    if (options.resume) args.push('--resume', options.resume);
    args.push(...this.settings().extraArgs);
    const child = spawn(executable, args, { cwd: options.cwd, env: agentEnv(), stdio: 'pipe', shell: needsShell(executable), windowsHide: true });
    return new ClaudeCliProcess(child, sink);
  }

  /** The skills found on disk, narrowed to what the CLI offers, plus its models and MCP servers. */
  async catalog(cwd: string): Promise<AgentCatalogResult> {
    const [answers, disk] = await Promise.all([this.askCli(cwd), findSkills(cwd)]);
    return { models: answers.models, skills: catalogSkills(disk, answers.commands, cwd), mcpServers: answers.mcpServers, error: answers.error };
  }

  /** A process for the MCP view: its MCP servers load as a session's would, and it takes their control requests until disposed. */
  control(cwd: string): AgentControl {
    return new ClaudeCliControl(this.spawnControl(cwd));
  }

  /**
   * A process that gets no prompt, only control requests, and saves no session. It loads what a session would (settings,
   * plugins, MCP servers), so the answers are the ones a session gets.
   */
  private spawnControl(cwd: string): ChildProcessWithoutNullStreams {
    const executable = this.executable ?? (expandHome(this.settings().path) || 'claude');
    const args = [...BASE_ARGS, '--no-session-persistence', ...this.settings().extraArgs];
    return spawn(executable, args, { cwd, env: agentEnv(), stdio: 'pipe', shell: needsShell(executable), windowsHide: true });
  }

  /** A short-lived control process gets `initialize` and `mcp_status`, and `mcp_status` again while a server is still connecting; then it ends. */
  private async askCli(cwd: string): Promise<{ models: ModelChoice[]; commands: CliCommand[] | undefined; mcpServers: McpServerInfo[]; error?: string }> {
    const control = new ClaudeCliControl(this.spawnControl(cwd));
    const result: { models: ModelChoice[]; commands: CliCommand[] | undefined; mcpServers: McpServerInfo[]; error?: string } = { models: [], commands: undefined, mcpServers: [] };
    const initialize = control.request({ subtype: 'initialize' }).then(
      (body) => {
        result.models = parseModels(body);
        result.commands = parseCommands(body);
      },
      (error: Error) => {
        result.error = error.message;
      },
    );
    const statuses = (async () => {
      for (let polls = 0; ; polls++) {
        const body = await control.request({ subtype: 'mcp_status' }).catch(() => null);
        if (body === null) return;
        result.mcpServers = parseMcpServers(body);
        if (polls >= MCP_POLLS || !result.mcpServers.some((server) => server.status === 'pending')) return;
        await new Promise((resolve) => setTimeout(resolve, MCP_POLL_MS));
      }
    })();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<void>((resolve) => {
      deadline = setTimeout(() => {
        result.error = 'Claude Code did not say which models and skills it offers in time.';
        resolve();
      }, CATALOG_TIMEOUT_MS);
    });
    await Promise.race([Promise.all([initialize, statuses]), late]);
    clearTimeout(deadline);
    control.dispose();
    // Requests refused by the disposal must not change what was already returned.
    return { ...result };
  }
}

/**
 * A CLI process that only answers control requests: the catalog's, asked once, and the MCP view's, kept while that is
 * used. Each request resolves with the body of its answer, or rejects with the CLI's reason or the process's end.
 */
class ClaudeCliControl implements AgentControl {
  private buffer = '';
  private stderr = '';
  private requests = 0;
  /** Why no more requests are taken: the process ended, or was let go. */
  private ended: string | undefined;
  private readonly waiting = new Map<string, { subtype: string; resolve(body: Record<string, unknown> | undefined): void; reject(error: Error): void }>();

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdin.on('error', () => {}); // EPIPE once the process is gone; `close` says why.
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.read(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => (this.stderr = (this.stderr + chunk).slice(-STDERR_TAIL_BYTES)));
    child.on('error', (error) => this.end(error.message));
    child.on('close', (code) => this.end(lastLine(this.stderr) || `Claude Code exited with code ${code} before answering.`));
  }

  get alive(): boolean {
    return this.ended === undefined;
  }

  request(request: ControlRequest): Promise<Record<string, unknown> | undefined> {
    if (this.ended !== undefined || !this.child.stdin.writable) return Promise.reject(new Error(this.ended ?? 'Claude Code takes no more requests.'));
    const id = `orbit-control-${++this.requests}`;
    const input: AgentInput = { type: 'control_request', request_id: id, request };
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { subtype: request.subtype, resolve, reject });
      this.child.stdin.write(`${JSON.stringify(input)}\n`);
    });
  }

  async mcpStatus(): Promise<McpServerInfo[]> {
    return parseMcpServers(await this.request({ subtype: 'mcp_status' }));
  }

  async mcpAction(server: string, action: McpAction): Promise<{ authUrl?: string }> {
    const request: ControlRequest =
      action === 'enable' || action === 'disable'
        ? { subtype: 'mcp_toggle', serverName: server, enabled: action === 'enable' }
        : { subtype: action === 'reconnect' ? 'mcp_reconnect' : action === 'signIn' ? 'mcp_authenticate' : 'mcp_clear_auth', serverName: server };
    const body = await this.request(request);
    const authUrl = action === 'signIn' ? parseAuthUrl(body) : undefined;
    return authUrl ? { authUrl } : {};
  }

  /** Closes stdin, and sends SIGTERM if the process has not gone by then. Requests still waiting are refused. */
  dispose(): void {
    if (this.ended !== undefined) return;
    this.end('Claude Code was let go before answering.');
    this.child.stdin.end();
    const kill = setTimeout(() => this.child.kill('SIGTERM'), KILL_GRACE_MS);
    this.child.once('close', () => clearTimeout(kill));
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      const reply = line ? parseControlAnswer(line) : undefined;
      const waiter = reply && this.waiting.get(reply.requestId);
      if (!reply || !waiter) continue;
      this.waiting.delete(reply.requestId);
      if (reply.ok) waiter.resolve(reply.body);
      else waiter.reject(new Error(reply.error ?? `Claude Code refused the ${waiter.subtype} request.`));
    }
  }

  private end(reason: string): void {
    if (this.ended !== undefined) return;
    this.ended = reason;
    for (const waiter of this.waiting.values()) waiter.reject(new Error(reason));
    this.waiting.clear();
  }
}

/**
 * Claude Code runs a skill named at the start of a prompt as a slash command, with the rest of the prompt as its
 * arguments. Only one can lead, so further skills are named in the prompt for Claude to load.
 */
export function withSkills(text: string, skills: readonly string[]): string {
  if (skills.length === 0) return text;
  const [first, ...rest] = skills;
  const also = rest.length > 0 ? `\n\nAlso use ${rest.length === 1 ? 'the skill' : 'the skills'} ${rest.map((name) => `/${name}`).join(', ')}.` : '';
  return `/${first}${text ? ` ${text}` : ''}${also}`;
}

/**
 * Files go as @-mentions, Claude Code's own way of attaching a file to a prompt; a path with whitespace is quoted
 * (`@"a b.md"`). They follow the text, so a skill's slash command still leads.
 */
export function withFiles(text: string, files: readonly string[]): string {
  if (files.length === 0) return text;
  const mentions = files.map((file) => (/\s/.test(file) ? `@"${file}"` : `@${file}`)).join(' ');
  return text ? `${text}\n\n${mentions}` : mentions;
}

/**
 * The extension host runs with ELECTRON_RUN_AS_NODE=1; left in place it would turn any Electron app Claude launches
 * from a Bash tool call into plain Node.
 */
function agentEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE'));
}

function lastLine(text: string): string {
  return text.split('\n').filter((line) => line.trim()).at(-1)?.trim() ?? '';
}

class ClaudeCliProcess implements AgentProcess {
  private buffer = '';
  private stderr = '';
  private exited = false;
  private requests = 0;
  private killTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly sink: AgentProcessSink,
  ) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.read(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => (this.stderr = (this.stderr + chunk).slice(-STDERR_TAIL_BYTES)));
    child.stdin.on('error', () => {}); // EPIPE once the process is gone; `close` reports the exit.
    child.on('error', (error) => this.finish({ code: null, signal: null, stderr: this.stderr, error }));
    child.on('close', (code, signal) => this.finish({ code, signal, stderr: this.stderr }));
  }

  prompt(text: string, skills: readonly string[], files: readonly string[] = []): void {
    this.write({ type: 'user', message: { role: 'user', content: withSkills(withFiles(text, files), skills) } });
  }

  interrupt(): void {
    this.write({ type: 'control_request', request_id: `orbit-interrupt-${++this.requests}`, request: { subtype: 'interrupt' } });
  }

  answerPermission(requestId: string, answer: PermissionAnswer, input: Record<string, unknown>, suggestions: readonly PermissionUpdate[], message?: string): void {
    // `always` sends the CLI's own suggestions back as updatedPermissions: it then applies them as a terminal's
    // "don't ask again" would (a rule written to settings, edits accepted for the session, a directory added).
    const response: AgentInput & { type: 'control_response' } = {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response:
          answer === 'deny'
            ? { behavior: 'deny', message: message ?? 'The user denied this tool call in Orbit.', decisionClassification: 'user_reject' }
            : answer === 'always' && suggestions.length > 0
              ? { behavior: 'allow', updatedInput: input, updatedPermissions: [...suggestions], decisionClassification: 'user_permanent' }
              : { behavior: 'allow', updatedInput: input, decisionClassification: 'user_temporary' },
      },
    };
    this.write(response);
  }

  dispose(): void {
    if (this.exited) return;
    this.child.stdin.end();
    this.child.kill('SIGTERM');
    this.killTimer = setTimeout(() => {
      if (!this.exited) this.child.kill('SIGKILL');
    }, KILL_GRACE_MS);
  }

  private write(input: AgentInput): void {
    if (this.exited || !this.child.stdin.writable) return;
    this.child.stdin.write(`${JSON.stringify(input)}\n`);
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.emit(line);
    }
  }

  private emit(line: string): void {
    for (const event of parseLine(line)) this.sink.event(event);
  }

  private finish(exit: AgentExit): void {
    if (this.exited) return;
    this.exited = true;
    clearTimeout(this.killTimer);
    if (this.buffer.trim()) this.emit(this.buffer.trim());
    this.buffer = '';
    this.sink.exit({ ...exit, stderr: exit.stderr.trim() });
  }
}

/** Resolves to the version string ('' if unparseable) when `executable --version` succeeds. */
function versionOf(executable: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(executable, ['--version'], { timeout: PROBE_TIMEOUT_MS, shell: needsShell(executable), windowsHide: true }, (error, stdout) => {
      resolve(error ? undefined : (/\d+\.\d+\.\d+\S*/.exec(stdout)?.[0] ?? ''));
    });
  });
}

function defaultCandidates(): string[] {
  const home = homedir();
  if (process.platform === 'win32') {
    const npm = join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'npm');
    return ['claude.exe', 'claude.cmd', ...[join(home, '.local', 'bin', 'claude.exe'), join(npm, 'claude.cmd')].filter((path) => existsSync(path))];
  }
  // GUI-launched editors can miss shell PATH additions, so also look where the installers put it.
  const installed = [join(home, '.local', 'bin', 'claude'), join(home, '.claude', 'local', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
  return ['claude', ...installed.filter((path) => existsSync(path))];
}

function needsShell(executable: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable);
}

function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path;
}
