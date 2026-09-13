import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { protocol } from 'electron';

/** The page's own scheme: a standard, secure origin (blob workers, a real CSP), never file://, and nothing else served. */
export const SCHEME = 'orbit';
export const PAGE_URL = `${SCHEME}://app/`;

/** Before the app is ready. */
export function registerScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true } }]);
}

/**
 * Serves the page and `webview.js` (with its map in a dev build) from `dist`, and nothing else. Each load of the page
 * gets a new nonce: the CSP is the VS Code panel's, sent as a header and repeated in the page, and the one script tag
 * carries the nonce the webview stamps on the styles it injects.
 */
export function servePage(dist: string): void {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'app') return notFound();
    switch (url.pathname) {
      case '/':
      case '/index.html': {
        const nonce = randomBytes(18).toString('base64');
        const csp = contentSecurityPolicy(nonce);
        return new Response(html(nonce, csp), { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': csp } });
      }
      case '/webview.js':
        return text(join(dist, 'webview.js'), 'text/javascript; charset=utf-8');
      case '/webview.js.map':
        return text(join(dist, 'webview.js.map'), 'application/json; charset=utf-8');
      default:
        return notFound();
    }
  });
}

export function contentSecurityPolicy(nonce: string): string {
  return ["default-src 'none'", 'img-src data:', `style-src 'nonce-${nonce}'`, `script-src 'nonce-${nonce}'`, 'worker-src blob:'].join('; ');
}

function html(nonce: string, csp: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Orbit Code</title>
</head>
<body>
<script nonce="${nonce}" src="webview.js"></script>
</body>
</html>`;
}

async function text(path: string, type: string): Promise<Response> {
  try {
    return new Response(await readFile(path, 'utf8'), { headers: { 'content-type': type } });
  } catch {
    return notFound();
  }
}

function notFound(): Response {
  return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
}
