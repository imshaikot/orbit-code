import type { HostToWebview, WebviewToHost } from '@orbit-code/protocol';

declare function acquireVsCodeApi(): { postMessage(message: WebviewToHost): void };

type Handler<K extends HostToWebview['type']> = (message: Extract<HostToWebview, { type: K }>) => void;

/** The webview's one channel to the extension host: typed posts out, typed subscriptions in. */
export class HostBridge {
  private readonly api = acquireVsCodeApi();
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
    this.api.postMessage(message);
  }

  log(level: 'info' | 'warn' | 'error', message: string): void {
    this.post({ type: 'log', level, message });
  }
}
