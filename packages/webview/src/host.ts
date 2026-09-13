import type { HostToWebview, WebviewToHost } from '@orbit-code/protocol';

/** The page's way out to its host. */
export interface HostTransport {
  postMessage(message: WebviewToHost): void;
  /** VS Code keeps this for the page while its panel lives, hidden or not; other hosts may leave both out. */
  getState?(): unknown;
  setState?(state: unknown): void;
}

declare global {
  /** Injected into a webview by VS Code and the editors built on it. */
  function acquireVsCodeApi(): HostTransport;
  interface Window {
    /** Set before this script runs by any other host: a JetBrains JCEF browser, or a page a local Orbit server opens. */
    orbitHost?: HostTransport;
  }
}

type Handler<K extends HostToWebview['type']> = (message: Extract<HostToWebview, { type: K }>) => void;

/**
 * The webview's one channel to its host: typed posts out, typed subscriptions in. Posts go through VS Code's webview
 * API when the page has one, else through `window.orbitHost`; messages in arrive as `message` events on the window,
 * however the host delivers them.
 */
export class HostBridge {
  private readonly transport = connect();
  private readonly handlers = new Map<HostToWebview['type'], Array<(message: HostToWebview) => void>>();

  constructor() {
    window.addEventListener('message', (event: MessageEvent<HostToWebview>) => {
      const message = event.data;
      if (typeof message?.type !== 'string') return;
      for (const handler of this.handlers.get(message.type) ?? []) handler(message);
    });
  }

  on<K extends HostToWebview['type']>(type: K, handler: Handler<K>): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler as (message: HostToWebview) => void);
    this.handlers.set(type, list);
  }

  post(message: WebviewToHost): void {
    this.transport.postMessage(message);
  }

  log(level: 'info' | 'warn' | 'error', message: string): void {
    this.post({ type: 'log', level, message });
  }

  /** What `keep` stored under `key`, when the host keeps state for the page. */
  kept(key: string): unknown {
    const state = this.transport.getState?.();
    return state !== null && typeof state === 'object' ? (state as Record<string, unknown>)[key] : undefined;
  }

  /** Asks the host to keep `value` for the page under `key`; a host that keeps nothing drops it. */
  keep(key: string, value: unknown): void {
    if (!this.transport.setState) return;
    const state = this.transport.getState?.();
    this.transport.setState({ ...(state !== null && typeof state === 'object' ? state : {}), [key]: value });
  }
}

function connect(): HostTransport {
  if (typeof acquireVsCodeApi === 'function') return acquireVsCodeApi();
  if (window.orbitHost) return window.orbitHost;
  throw new Error('Orbit found no host to talk to: expected acquireVsCodeApi() or window.orbitHost.');
}
