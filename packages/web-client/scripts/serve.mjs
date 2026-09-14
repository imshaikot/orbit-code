#!/usr/bin/env node
// Serves the web client's dist/ the way the website hosts it, for a local run and the server smoke test: the page at
// /web-client/ with a fresh nonce and the CSP from dist/web-client.json (as a header and in the page), its script,
// webview.js and their maps, and nothing else. A server accepts this page only when started with its origin:
//
//   yarn nx run web-client:serve [--port 4800]
//   yarn server --origin http://127.0.0.1:4800

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

const ASSETS = {
  '/web-client/web-client.js': 'text/javascript; charset=utf-8',
  '/web-client/web-client.js.map': 'application/json; charset=utf-8',
  '/web-client/webview.js': 'text/javascript; charset=utf-8',
  '/web-client/webview.js.map': 'application/json; charset=utf-8',
};

/** Starts the server; resolves with its origin (`http://127.0.0.1:<port>`) and a way to stop it. */
export function serveWebClient({ port = 0, host = '127.0.0.1' } = {}) {
  const manifest = JSON.parse(readFileSync(join(dist, 'web-client.json'), 'utf8'));
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (request.method !== 'GET' && request.method !== 'HEAD') return response.writeHead(405).end();
    if (path === '/' || path === '/web-client') return response.writeHead(302, { location: '/web-client/' }).end();
    if (path === '/web-client/') {
      const nonce = randomBytes(18).toString('base64');
      const page = manifest.csp.page.replaceAll('{nonce}', nonce);
      return response
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': `${page}; frame-ancestors 'none'`, 'cross-origin-opener-policy': 'same-origin', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' })
        .end(html(nonce, page));
    }
    const type = ASSETS[path];
    const file = type && join(dist, path.slice('/web-client/'.length));
    if (!file || !existsSync(file)) return response.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    response.writeHead(200, { 'content-type': type, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' }).end(readFileSync(file));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const { port: bound } = server.address();
      resolve({ origin: `http://${host}:${bound}`, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

function html(nonce, csp) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="dark">
<title>Orbit Code</title>
</head>
<body>
<script nonce="${nonce}" src="web-client.js" data-webview="webview.js"></script>
</body>
</html>`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const at = process.argv.indexOf('--port');
  const { origin } = await serveWebClient({ port: at === -1 ? 4800 : Number(process.argv[at + 1]) });
  console.log(`[web-client] ${origin}/web-client/  (start the server with --origin ${origin})`);
}
