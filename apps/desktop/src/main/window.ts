import { type Disposable, Emitter } from '@orbit-code/common/event';
import type { WebviewTransport } from '@orbit-code/core/controller';
import type { HostToWebview, WebviewToHost } from '@orbit-code/protocol';
import { BrowserWindow, type IpcMainEvent } from 'electron';
import { PAGE_URL } from './page';

/** Also in src/preload/preload.ts. */
const TO_HOST = 'orbit:webview';
const TO_PAGE = 'orbit:host';
/** The webview's dome colour, so the window never flashes white before the page paints. */
const BACKGROUND = '#0a1024';

/**
 * One window showing Orbit's page, as the controller's transport. Messages from the page are accepted only from this
 * window's own top frame on the page's origin; the page can't navigate away or open windows. Like VS Code's panel,
 * nothing is sent before the page posts `ready`, and every load (a reload included) posts it again.
 */
export class OrbitWindow implements WebviewTransport, Disposable {
  readonly window: BrowserWindow;
  private ready = false;
  private readonly readyEmitter = new Emitter<void>();
  private readonly messageEmitter = new Emitter<WebviewToHost>();
  private readonly disposeEmitter = new Emitter<void>();
  readonly onReady = this.readyEmitter.event;
  readonly onMessage = this.messageEmitter.event;
  readonly onDidDispose = this.disposeEmitter.event;

  constructor(preload: string, title: string) {
    this.window = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 640,
      minHeight: 420,
      show: false,
      title,
      backgroundColor: BACKGROUND,
      webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
    });
    const contents = this.window.webContents;

    contents.ipc.on(TO_HOST, (event: IpcMainEvent, message: WebviewToHost) => {
      const frame = event.senderFrame;
      if (!frame || frame !== contents.mainFrame || !frame.url.startsWith(PAGE_URL) || typeof message?.type !== 'string') return;
      if (message.type === 'ready') {
        this.ready = true;
        this.readyEmitter.fire();
        this.post({ type: 'visibility', visible: this.visible });
      }
      this.messageEmitter.fire(message);
    });
    contents.on('did-start-loading', () => (this.ready = false));
    contents.on('will-navigate', (event, url) => {
      if (!url.startsWith(PAGE_URL)) event.preventDefault();
    });
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));

    this.window.on('page-title-updated', (event) => event.preventDefault());
    this.window.once('ready-to-show', () => this.window.show());
    for (const change of ['show', 'hide', 'minimize', 'restore'] as const) {
      this.window.on(change as 'show', () => this.post({ type: 'visibility', visible: this.visible }));
    }
    this.window.on('closed', () => {
      this.ready = false;
      this.disposeEmitter.fire();
      this.readyEmitter.dispose();
      this.messageEmitter.dispose();
      this.disposeEmitter.dispose();
    });
    void this.window.loadURL(PAGE_URL);
  }

  get closed(): boolean {
    return this.window.isDestroyed();
  }

  /** Shown and not minimised: the page's frame loop runs. */
  get visible(): boolean {
    return !this.closed && this.window.isVisible() && !this.window.isMinimized();
  }

  /** Visible and focused: a permission request is noticed on the page rather than as a notification. */
  get inSight(): boolean {
    return this.visible && this.window.isFocused();
  }

  post(message: HostToWebview): void {
    if (!this.ready || this.closed) return;
    this.window.webContents.send(TO_PAGE, message);
  }

  setTitle(title: string): void {
    if (!this.closed) this.window.setTitle(title);
  }

  /** Loads the page again: it posts `ready` and gets a whole snapshot from whoever is attached now. */
  reload(): void {
    if (!this.closed) this.window.webContents.reload();
  }

  reveal(): void {
    if (this.closed) return;
    if (this.window.isMinimized()) this.window.restore();
    this.window.show();
    this.window.focus();
  }

  dispose(): void {
    if (!this.closed) this.window.close();
  }
}
