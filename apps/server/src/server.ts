// The orbit-server command: Orbit's host for one folder in this Node process, which the web client at
// orbit-code.imshaikot.com/web-client/ reaches over a WebSocket on 127.0.0.1. It indexes the folder, runs the user's own
// claude CLI there, and takes a page only from an allowed origin that sends the token in the link it prints.

import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileLogger } from '@orbit-code/core/fileLogger';
import { PROTOCOL_VERSION } from '@orbit-code/protocol';
import { SERVER_HOST, SERVER_PORTS, WEB_CLIENT_ORIGIN, serverLink } from '@orbit-code/protocol/wire';
import { type ServerOptions, parseInvocation, usage } from './options';
import { ServerWorkspace } from './serverWorkspace';
import { type ListeningServer, type PageTransport, listen } from './socketServer';
import { openUrl } from './system';

/** package.json's version, set by build.mjs. */
declare const ORBIT_SERVER_VERSION: string;

const invocation = parseInvocation(process.argv.slice(2), process.cwd(), process.env, Boolean(process.stdout.isTTY));
switch (invocation.kind) {
  case 'version':
    process.stdout.write(`${ORBIT_SERVER_VERSION} (protocol ${PROTOCOL_VERSION})\n`);
    break;
  case 'help':
    process.stdout.write(usage(ORBIT_SERVER_VERSION));
    break;
  case 'error':
    process.stderr.write(`orbit-server: ${invocation.message}\nRun orbit-server --help for the options.\n`);
    process.exitCode = 2;
    break;
  case 'run':
    await run(invocation.options);
    break;
}

async function run(options: ServerOptions): Promise<void> {
  const say = (line = '') => process.stdout.write(`${line}\n`);
  const log = new FileLogger(options.logFile, options.verbose);
  log.info(`Orbit Code server ${ORBIT_SERVER_VERSION}: Node ${process.versions.node}, protocol ${PROTOCOL_VERSION}, folder ${options.folder}, data ${options.dataDir}`);

  const workspace = new ServerWorkspace({
    path: options.folder,
    log,
    settings: options.settings,
    dataDir: options.dataDir,
    indexerPath: join(dirname(fileURLToPath(import.meta.url)), 'indexer.mjs'),
    onPermission: ({ request }) => say(`Claude is waiting for you in the browser: ${request.questions ? 'questions' : `${request.tool} ${request.detail}`.trim()}`),
  });

  const token = options.token ?? randomBytes(24).toString('base64url');
  const origins = new Set([WEB_CLIENT_ORIGIN, ...options.origins]);
  let page: PageTransport | undefined;
  let server: ListeningServer;
  try {
    server = await listen({
      ports: options.port ? [options.port] : SERVER_PORTS,
      token,
      origins,
      version: ORBIT_SERVER_VERSION,
      folder: workspace.info.name,
      log,
      onPage: (next) => {
        say(page ? 'Browser connected from another tab; the earlier one was let go.' : 'Browser connected.');
        page = next;
        next.onDidDispose(() => {
          if (page !== next) return;
          page = undefined;
          say('Browser disconnected. Open the link again to reconnect.');
        });
        workspace.attach(next);
      },
    });
  } catch (error) {
    workspace.dispose();
    process.stderr.write(`orbit-server: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }
  log.info(`server: listening on ${SERVER_HOST}:${server.port} for pages from ${[...origins].join(', ')}`);

  if (options.reindex) void workspace.graphs.load(true);
  else workspace.graphs.ensureLoaded();
  void workspace.session.ensureProbed();

  const link = serverLink({ port: server.port, token }, options.origins[0] ?? WEB_CLIENT_ORIGIN);
  say(`Orbit Code server ${ORBIT_SERVER_VERSION}`);
  say(`  Folder  ${options.folder}`);
  say(`  Listen  ${SERVER_HOST}:${server.port}`);
  say(`  Log     ${options.logFile}`);
  say();
  say('Open this link to see the workspace. It holds this run\'s token, so keep it to yourself:');
  say(`  ${link}`);
  say();
  say(options.open && openUrl(link) ? 'Opened it in your browser. Press Ctrl+C to stop.' : 'Press Ctrl+C to stop.');

  let stopping = false;
  const stop = () => {
    if (stopping) process.exit(1);
    stopping = true;
    say('Stopping.');
    server.dispose();
    workspace.dispose();
    log.info('server: stopped');
    setTimeout(() => process.exit(0), 300).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
