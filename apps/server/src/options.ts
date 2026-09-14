import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { isEffort, isModelName, isPermissionMode } from '@orbit-code/agent/options';
import { DEFAULT_MAX_FILES, type OrbitSettings, normalizeSettings } from '@orbit-code/core/settings';
import { EFFORT_LEVELS, PERMISSION_MODES } from '@orbit-code/protocol';
import { SERVER_HOST, SERVER_PACKAGE, SERVER_PORTS, WEB_CLIENT_ORIGIN, WEB_CLIENT_PATH, isServerPort, isServerToken } from '@orbit-code/protocol/wire';

export interface ServerOptions {
  /** Absolute path of the folder. */
  folder: string;
  /** A port asked for; otherwise the first free one of SERVER_PORTS. */
  port: number | undefined;
  /** The token the page must send; otherwise a new one for this run. */
  token: string | undefined;
  /** Page origins accepted besides the website's; the link printed points at the first. */
  origins: string[];
  open: boolean;
  reindex: boolean;
  verbose: boolean;
  settings: OrbitSettings;
  /** Graphs, layouts and the log. */
  dataDir: string;
  logFile: string;
}

export type Invocation = { kind: 'help' } | { kind: 'version' } | { kind: 'run'; options: ServerOptions } | { kind: 'error'; message: string };

const FIRST_PORT = SERVER_PORTS[0];
const LAST_PORT = SERVER_PORTS[SERVER_PORTS.length - 1];

export function usage(version: string): string {
  return `orbit-server ${version}: Orbit Code for one folder, in your browser

Usage:
  npx ${SERVER_PACKAGE} [folder] [options]

Starts Orbit's host for the folder (the current one by default) on ${SERVER_HOST}, and prints a link to
${WEB_CLIENT_ORIGIN}${WEB_CLIENT_PATH} that connects the page to it. The link holds this run's token.

Options:
  --port <port>             a port from ${FIRST_PORT} to ${LAST_PORT} (default: the first free one)
  --token <token>           the token a page must send, 16 to 128 of A-Z a-z 0-9 - _
                            (default: a new one each run; also ORBIT_SERVER_TOKEN)
  --origin <origin>         also accept a page from this origin, and link to it (repeatable)
  --no-open                 print the link without opening the browser
  --reindex                 index the folder again, ignoring the saved graph and layout
  --max-files <n>           index at most this many files (default ${DEFAULT_MAX_FILES})
  --claude <path>           the claude executable (default: claude on PATH)
  --model <name>            Claude's model
  --effort <level>          ${EFFORT_LEVELS.join(', ')}
  --permission-mode <mode>  ${PERMISSION_MODES.join(', ')}
  --verbose                 write the log to the terminal as well
  -v, --version             the server's version, and the protocol version its page speaks
  -h, --help                this text

Environment:
  ORBIT_SERVER_DATA         where graphs, layouts and the log are kept
  ORBIT_SERVER_LOG          the log file
`;
}

const VALUED = new Set(['port', 'token', 'origin', 'max-files', 'claude', 'model', 'effort', 'permission-mode']);
const SWITCHES = new Set(['help', 'version', 'no-open', 'reindex', 'verbose']);

/** The command line, checked: every value either reaches a socket check or a claude argument, so nothing loose passes. */
export function parseInvocation(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, interactive: boolean): Invocation {
  const error = (message: string): Invocation => ({ kind: 'error', message });
  const values = new Map<string, string[]>();
  const switches = new Set<string>();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-h' || arg === '-v') {
      switches.add(arg === '-h' ? 'help' : 'version');
      continue;
    }
    if (!arg.startsWith('-')) {
      positional.push(arg);
      continue;
    }
    const match = /^--([a-z-]+)(?:=(.*))?$/s.exec(arg);
    if (!match) return error(`unknown argument ${arg}`);
    const [, name, inline] = match;
    if (SWITCHES.has(name) && inline === undefined) {
      switches.add(name);
      continue;
    }
    if (!VALUED.has(name)) return error(`unknown option --${name}`);
    const value = inline ?? args[++i];
    if (value === undefined) return error(`--${name} needs a value`);
    values.set(name, [...(values.get(name) ?? []), value]);
  }
  if (switches.has('help')) return { kind: 'help' };
  if (switches.has('version')) return { kind: 'version' };
  const last = (name: string) => values.get(name)?.at(-1);

  if (positional.length > 1) return error('one folder at a time');
  const folder = resolve(cwd, positional[0] ?? '.');
  try {
    if (!statSync(folder).isDirectory()) return error(`${folder} is not a folder`);
  } catch {
    return error(`${folder} does not exist`);
  }

  let port: number | undefined;
  if (last('port') !== undefined) {
    port = Number(last('port'));
    if (!isServerPort(port)) return error(`--port must be from ${FIRST_PORT} to ${LAST_PORT}: the web client can reach no other port`);
  }

  const token = last('token') ?? (env.ORBIT_SERVER_TOKEN || undefined);
  if (token !== undefined && !isServerToken(token)) return error('the token must be 16 to 128 of A-Z a-z 0-9 - _');

  const origins: string[] = [];
  for (const origin of values.get('origin') ?? []) {
    const normalized = origin.replace(/\/$/, '').toLowerCase();
    if (!/^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/.test(normalized)) return error(`--origin ${origin} is not an origin: a scheme, a host and maybe a port, like http://127.0.0.1:4800`);
    origins.push(normalized);
  }

  let maxFiles = DEFAULT_MAX_FILES;
  if (last('max-files') !== undefined) {
    maxFiles = Number(last('max-files'));
    if (!Number.isInteger(maxFiles) || maxFiles < 1) return error('--max-files must be a whole number');
  }
  const model = last('model') ?? '';
  if (!isModelName(model)) return error(`--model ${model} is not a model name`);
  const effort = last('effort') ?? '';
  if (!isEffort(effort)) return error(`--effort must be one of ${EFFORT_LEVELS.join(', ')}`);
  const permissionMode = last('permission-mode') ?? 'default';
  if (!isPermissionMode(permissionMode)) return error(`--permission-mode must be one of ${PERMISSION_MODES.join(', ')}`);

  const dataDir = dataDirectory(env);
  return {
    kind: 'run',
    options: {
      folder,
      port,
      token,
      origins,
      open: interactive && !switches.has('no-open'),
      reindex: switches.has('reindex'),
      verbose: switches.has('verbose'),
      settings: normalizeSettings({ maxFiles, claude: { path: last('claude') ?? '', model, effort, permissionMode } }),
      dataDir,
      logFile: env.ORBIT_SERVER_LOG ? resolve(cwd, env.ORBIT_SERVER_LOG) : join(dataDir, 'logs', 'orbit.log'),
    },
  };
}

/** The platform's cache directory: everything kept can be made again by indexing. */
function dataDirectory(env: NodeJS.ProcessEnv): string {
  if (env.ORBIT_SERVER_DATA) return resolve(env.ORBIT_SERVER_DATA);
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'orbit-code-server');
  if (process.platform === 'win32') return join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'orbit-code-server');
  return join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'orbit-code-server');
}
