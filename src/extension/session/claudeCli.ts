import { type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { McpServerInfo, ModelChoice, PermissionAnswer } from '../../shared/protocol';
import type { AgentAvailability, AgentCatalogResult, AgentExit, AgentProcess, AgentProcessSink, AgentStartOptions, SessionBackend } from './backend';
import type { PermissionUpdate } from './permissions';
import { catalogSkills, findSkills } from './skillCatalog';
import { type AgentInput, type CliCommand, parseCommands, parseControlAnswer, parseLine, parseMcpServers, parseModels } from './streamJson';

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

  /**
   * A short-lived process that gets no prompt, only the `initialize` and `mcp_status` control requests, and saves no
   * session. It loads what a session would (settings, plugins, MCP servers), so the answers are the ones a session gets.
   */
  private askCli(cwd: string): Promise<{ models: ModelChoice[]; commands: CliCommand[] | undefined; mcpServers: McpServerInfo[]; error?: string }> {
    const executable = this.executable ?? (expandHome(this.settings().path) || 'claude');
    const args = [...BASE_ARGS, '--no-session-persistence', ...this.settings().extraArgs];
    return new Promise((resolve) => {
      const child = spawn(executable, args, { cwd, env: agentEnv(), stdio: 'pipe', shell: needsShell(executable), windowsHide: true });
      const result: { models: ModelChoice[]; commands: CliCommand[] | undefined; mcpServers: McpServerInfo[]; error?: string } = { models: [], commands: undefined, mcpServers: [] };
      let buffer = '';
      let stderr = '';
      let polls = 0;
      let mcpSettled = false;
      let settled = false;
      let pollTimer: ReturnType<typeof setTimeout> | undefined;
      const send = (input: AgentInput) => {
        if (child.stdin.writable) child.stdin.write(`${JSON.stringify(input)}\n`);
      };
      const finish = (error?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        clearTimeout(pollTimer);
        if (error) result.error = error;
        child.stdin.end();
        const kill = setTimeout(() => child.kill('SIGTERM'), KILL_GRACE_MS);
        child.once('close', () => clearTimeout(kill));
        resolve(result);
      };
      const deadline = setTimeout(() => finish('Claude Code did not say which models and skills it offers in time.'), CATALOG_TIMEOUT_MS);
      const answer = (line: string) => {
        const reply = parseControlAnswer(line);
        if (!reply) return;
        if (reply.requestId === 'orbit-catalog-initialize') {
          if (reply.ok) {
            result.models = parseModels(reply.body);
            result.commands = parseCommands(reply.body);
          } else {
            result.error = reply.error ?? 'Claude Code refused the initialize request.';
          }
        } else if (reply.requestId.startsWith('orbit-catalog-mcp-')) {
          result.mcpServers = reply.ok ? parseMcpServers(reply.body) : [];
          if (result.mcpServers.some((server) => server.status === 'pending') && polls < MCP_POLLS) {
            pollTimer = setTimeout(() => send({ type: 'control_request', request_id: `orbit-catalog-mcp-${++polls}`, request: { subtype: 'mcp_status' } }), MCP_POLL_MS);
          } else {
            mcpSettled = true;
          }
        }
        if ((result.commands || result.error) && mcpSettled) finish();
      };
      child.stdin.on('error', () => {});
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) answer(line);
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => (stderr = (stderr + chunk).slice(-STDERR_TAIL_BYTES)));
      child.on('error', (error) => finish(error.message));
      child.on('close', (code) => finish(result.commands ? undefined : lastLine(stderr) || `Claude Code exited with code ${code} before answering.`));
      send({ type: 'control_request', request_id: 'orbit-catalog-initialize', request: { subtype: 'initialize' } });
      send({ type: 'control_request', request_id: 'orbit-catalog-mcp-0', request: { subtype: 'mcp_status' } });
    });
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
