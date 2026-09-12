import { randomBytes } from 'node:crypto';
import { Emitter } from '@orbit-code/common/event';
import type { WebviewTransport } from '@orbit-code/core/controller';
import type { HostToWebview, WebviewToHost } from '@orbit-code/protocol';
import * as vscode from 'vscode';

/**
 * The Orbit editor panel as a transport: HTML and CSP, visibility, and typed
 * messages in both directions. Knows nothing about graphs or sessions.
 *
 * Nothing is buffered before the webview posts `ready`: `onReady` fires on the
 * first load and on every reload, and the owner answers with a full snapshot.
 */
export class OrbitPanel implements WebviewTransport, vscode.Disposable {
  private readonly readyEmitter = new Emitter<void>();
  private readonly messageEmitter = new Emitter<WebviewToHost>();
  private readonly disposeEmitter = new Emitter<void>();
  readonly onReady = this.readyEmitter.event;
  readonly onMessage = this.messageEmitter.event;
  readonly onDidDispose = this.disposeEmitter.event;

  private readonly disposables: vscode.Disposable[] = [];
  private ready = false;
  private disposed = false;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
  ) {
    panel.webview.html = html(panel.webview, extensionUri);
    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      panel.onDidChangeViewState(({ webviewPanel }) => this.post({ type: 'visibility', visible: webviewPanel.visible })),
      panel.webview.onDidReceiveMessage((message: WebviewToHost) => {
        if (message?.type === 'ready') {
          this.ready = true;
          this.readyEmitter.fire();
          this.post({ type: 'visibility', visible: this.panel.visible });
        }
        this.messageEmitter.fire(message);
      }),
    );
  }

  static create(extensionUri: vscode.Uri): OrbitPanel {
    const panel = vscode.window.createWebviewPanel('orbit', 'Orbit Code', vscode.ViewColumn.Active, {
      enableScripts: true,
      // Keeps the WebGL context and frozen layout across tab switches; the webview parks its rAF loop instead.
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')],
    });
    return new OrbitPanel(panel, extensionUri);
  }

  /** The panel is showing; a hidden panel's permission requests become notifications. */
  get inSight(): boolean {
    return this.panel.visible;
  }

  reveal(): void {
    this.panel.reveal();
  }

  /** Dropped until the webview is ready; the `onReady` snapshot covers anything missed. */
  post(message: HostToWebview): void {
    if (this.disposed || !this.ready) return;
    void this.panel.webview.postMessage(message);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.panel.dispose();
    this.disposeEmitter.fire();
    for (const disposable of this.disposables) disposable.dispose();
    this.readyEmitter.dispose();
    this.messageEmitter.dispose();
    this.disposeEmitter.dispose();
  }
}

function html(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js'));
  const nonce = randomBytes(18).toString('base64');
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    'worker-src blob:',
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Orbit Code</title>
</head>
<body>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}
