import { timingSafeEqual } from 'node:crypto';
import { type IncomingMessage, createServer } from 'node:http';
import { type Disposable, Emitter } from '@orbit-code/common/event';
import type { Logger } from '@orbit-code/common/log';
import type { WebviewTransport } from '@orbit-code/core/controller';
import { type HostToWebview, PROTOCOL_VERSION, type WebviewToHost } from '@orbit-code/protocol';
import { type RefusedReason, SERVER_HOST, type ServerFrame, encodeFrame, readClientFrame } from '@orbit-code/protocol/wire';
import { type RawData, WebSocket, WebSocketServer } from 'ws';

/** The largest frame a page may send: an editor sheet save at the sheet's 4 MB limit, with room for layouts of big graphs. */
const MAX_PAYLOAD = 64 * 1024 * 1024;
/** A socket that hasn't said hello by then is closed. */
const HELLO_MS = 10_000;

export interface SocketServerOptions {
  /** Tried in order; the first free one is used. */
  ports: readonly number[];
  token: string;
  /** Page origins accepted, lower case. */
  origins: ReadonlySet<string>;
  version: string;
  /** The folder's name, for the page's title. */
  folder: string;
  log: Logger;
  /** A page was welcomed: it is the transport from now on, and an earlier page has been let go. */
  onPage(page: PageTransport): void;
}

export interface ListeningServer extends Disposable {
  readonly port: number;
}

const toBytes = (data: RawData): Uint8Array => (Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : new Uint8Array(data));

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Listens on 127.0.0.1 for the web client. An upgrade is accepted only at `/`, from an allowed page origin, for this
 * address as its Host (so neither another site nor a DNS rebinding can open a socket), and the socket then has to say
 * `hello` with the run's token and this protocol version before anything else crosses it. One page at a time: a
 * newer one replaces the older, which is told so. Plain HTTP gets a line of text at `/` and a 404 elsewhere.
 */
export async function listen(options: SocketServerOptions): Promise<ListeningServer> {
  const { log } = options;
  const http = createServer((request, response) => {
    const headers = { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' };
    if (request.method === 'GET' && request.url === '/') response.writeHead(200, headers).end('Orbit Code server. Open the link it printed in the terminal.\n');
    else response.writeHead(404, headers).end('Not found\n');
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false, clientTracking: false });
  let port = 0;
  let current: PageTransport | undefined;
  const reported = new Set<string>();

  const refuse = (socket: WebSocket, reason: RefusedReason) => {
    send(socket, { t: 'refused', reason, version: options.version, protocol: PROTOCOL_VERSION });
    socket.close(1008, reason);
  };

  http.on('upgrade', (request: IncomingMessage, socket, head) => {
    const problem = refusal(request, port, options.origins);
    if (problem) {
      // Once per kind of refusal, so a page that keeps trying doesn't fill the log.
      if (!reported.has(problem)) log.warn(`server: refused a WebSocket ${problem}`);
      reported.add(problem);
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => {
      ws.on('error', () => ws.terminate());
      const timer = setTimeout(() => refuse(ws, 'handshake'), HELLO_MS);
      ws.once('message', (data, isBinary) => {
        clearTimeout(timer);
        const frame = isBinary ? readClientFrame(toBytes(data)) : undefined;
        if (frame?.t !== 'hello') return refuse(ws, 'handshake');
        if (frame.protocol !== PROTOCOL_VERSION) {
          log.warn(`server: refused a page speaking protocol ${frame.protocol}, not ${PROTOCOL_VERSION}`);
          return refuse(ws, 'protocol');
        }
        if (!sameToken(frame.token, options.token)) {
          log.warn('server: refused a page with the wrong token');
          return refuse(ws, 'token');
        }
        const page = new PageTransport(ws, log, (reason) => refuse(ws, reason));
        const previous = current;
        current = page;
        page.onDidDispose(() => {
          if (current === page) current = undefined;
        });
        send(ws, { t: 'welcome', version: options.version, protocol: PROTOCOL_VERSION, folder: options.folder });
        previous?.replace();
        log.info(`server: page connected from ${request.headers.origin}`);
        options.onPage(page);
      });
    });
  });

  for (const candidate of options.ports) {
    const bound = await new Promise<boolean>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        http.off('listening', onListening);
        if (error.code === 'EADDRINUSE') resolve(false);
        else reject(error);
      };
      const onListening = () => {
        http.off('error', onError);
        resolve(true);
      };
      http.once('error', onError);
      http.once('listening', onListening);
      http.listen(candidate, SERVER_HOST);
    });
    if (bound) {
      port = candidate;
      break;
    }
  }
  if (!port) {
    const range = options.ports.length === 1 ? `port ${options.ports[0]}` : `ports ${options.ports[0]} to ${options.ports[options.ports.length - 1]}`;
    throw new Error(`${range} on ${SERVER_HOST} ${options.ports.length === 1 ? 'is' : 'are all'} in use`);
  }

  return {
    port,
    dispose: () => {
      current?.dispose();
      sockets.close();
      http.close();
      http.closeAllConnections();
    },
  };
}

/** Why an upgrade is refused, or undefined when it may go on. */
function refusal(request: IncomingMessage, port: number, origins: ReadonlySet<string>): string | undefined {
  if (request.url !== '/') return `for path ${request.url}`;
  const origin = request.headers.origin?.toLowerCase();
  if (!origin || !origins.has(origin)) return `from origin ${origin ?? '(none)'}`;
  const host = request.headers.host?.toLowerCase();
  if (host !== `${SERVER_HOST}:${port}` && host !== `localhost:${port}`) return `for host ${host ?? '(none)'}`;
  return undefined;
}

function send(socket: WebSocket, frame: ServerFrame): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(encodeFrame(frame));
}

/**
 * A welcomed page, as the controller's transport: the page's messages in, the host's out once it has posted `ready`
 * (every load posts it again), and whether its tab is seen and focused, which decides between the page's permission
 * card and the terminal's line.
 */
export class PageTransport implements WebviewTransport, Disposable {
  private ready = false;
  private open = true;
  private visible = true;
  private focused = true;
  private readonly readyEmitter = new Emitter<void>();
  private readonly messageEmitter = new Emitter<WebviewToHost>();
  private readonly disposeEmitter = new Emitter<void>();
  readonly onReady = this.readyEmitter.event;
  readonly onMessage = this.messageEmitter.event;
  readonly onDidDispose = this.disposeEmitter.event;

  constructor(
    private readonly socket: WebSocket,
    private readonly log: Logger,
    private readonly refuse: (reason: RefusedReason) => void,
  ) {
    socket.on('message', (data, isBinary) => {
      const frame = isBinary ? readClientFrame(toBytes(data)) : undefined;
      if (!frame || frame.t === 'hello') return;
      if (frame.t === 'sight') {
        const changed = frame.visible !== this.visible;
        this.visible = frame.visible;
        this.focused = frame.focused;
        if (changed) this.post({ type: 'visibility', visible: this.visible });
        return;
      }
      if (frame.message.type === 'ready') {
        this.ready = true;
        this.readyEmitter.fire();
        this.post({ type: 'visibility', visible: this.visible });
      }
      this.messageEmitter.fire(frame.message);
    });
    socket.on('close', () => this.closed());
    socket.on('error', (error) => {
      this.log.warn(`server: page socket: ${error.message}`);
      socket.terminate();
    });
  }

  get inSight(): boolean {
    return this.open && this.visible && this.focused;
  }

  post(message: HostToWebview): void {
    if (!this.ready || !this.open || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(encodeFrame({ t: 'message', message }));
  }

  /** Another page took over. */
  replace(): void {
    this.refuse('replaced');
    this.closed();
  }

  dispose(): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.close(1001, 'server stopping');
    this.closed();
  }

  private closed(): void {
    if (!this.open) return;
    this.open = false;
    this.ready = false;
    this.disposeEmitter.fire();
    this.readyEmitter.dispose();
    this.messageEmitter.dispose();
    this.disposeEmitter.dispose();
  }
}
