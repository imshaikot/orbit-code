import { type HostToWebview, PROTOCOL_VERSION, type WebviewToHost } from '@orbit-code/protocol';
import { type ClientFrame, type RefusedReason, SERVER_HOST, type ServerLink, encodeFrame, readServerFrame } from '@orbit-code/protocol/wire';

export type ConnectionEvent =
  | { kind: 'unreachable'; attempts: number }
  | { kind: 'welcome'; version: string; folder: string }
  | { kind: 'refused'; reason: RefusedReason; version: string; protocol: number }
  | { kind: 'lost' };

/** Between attempts while no server answers: soon at first, then less often. */
const RETRY_MS = 2000;
const RETRY_SLOW_MS = 5000;

/**
 * One server at `ws://127.0.0.1:<port>/`: a `hello` with the link's token, then the host's messages in and the page's
 * out. Until the server welcomes the page it tries again every few seconds, so a page opened before the server starts
 * connects once it does. After a welcome, a closed socket is `lost` and not retried: the page reloads to start over.
 */
export class Connection {
  private socket: WebSocket | undefined;
  private welcomed = false;
  private stopped = false;
  private attempts = 0;
  private retry: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly link: ServerLink,
    private readonly onEvent: (event: ConnectionEvent) => void,
    private readonly onMessage: (message: HostToWebview) => void,
  ) {}

  start(): void {
    this.open();
  }

  send(frame: ClientFrame): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(encodeFrame(frame));
  }

  post(message: WebviewToHost): void {
    this.send({ t: 'message', message });
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    this.socket?.close(1000);
  }

  private open(): void {
    if (this.stopped) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(`ws://${SERVER_HOST}:${this.link.port}/`);
    } catch {
      // A browser may throw for an address the CSP forbids rather than fail the connection.
      this.failed();
      return;
    }
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    socket.onopen = () => socket.send(encodeFrame({ t: 'hello', token: this.link.token, protocol: PROTOCOL_VERSION }));
    socket.onmessage = (event: MessageEvent<unknown>) => {
      if (this.socket !== socket || !(event.data instanceof ArrayBuffer)) return;
      const frame = readServerFrame(new Uint8Array(event.data));
      if (!frame) return;
      if (frame.t === 'message') {
        if (this.welcomed) this.onMessage(frame.message);
      } else if (frame.t === 'welcome') {
        this.welcomed = true;
        this.attempts = 0;
        this.onEvent({ kind: 'welcome', version: frame.version, folder: frame.folder });
      } else {
        this.stopped = true;
        this.onEvent({ kind: 'refused', reason: frame.reason, version: frame.version, protocol: frame.protocol });
      }
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      if (this.stopped) return;
      if (this.welcomed) {
        this.stopped = true;
        this.onEvent({ kind: 'lost' });
      } else {
        this.failed();
      }
    };
  }

  private failed(): void {
    this.attempts += 1;
    this.onEvent({ kind: 'unreachable', attempts: this.attempts });
    this.retry = setTimeout(() => this.open(), this.attempts < 10 ? RETRY_MS : RETRY_SLOW_MS);
  }
}
