import { SERVER_HOST, SERVER_PORTS } from '@orbit-code/protocol/wire';

/** The only places the page may connect to: the server's ports on loopback. */
export const CONNECT_SOURCES = SERVER_PORTS.map((port) => `ws://${SERVER_HOST}:${port}`);

/**
 * The page's policy, for its meta tag (and, where the host can mint a nonce per response, its header): the editor
 * panel's (a nonce'd script and style, `worker-src blob:` for the layout worker, `img-src data:`), plus the server's
 * sockets, and `'self'` for the icons and manifest a site's page head links to. The client passes the nonce on to
 * webview.js and to the styles both inject.
 */
export function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "img-src 'self' data:",
    `connect-src ${CONNECT_SOURCES.join(' ')}`,
    'worker-src blob:',
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

/**
 * The header a static host sends with the page, which can't carry a per-response nonce. A browser enforces it and the
 * meta tag's policy both, so scripts must be same-origin and nonce'd, and styles nonce'd; only the header can forbid
 * framing. No `upgrade-insecure-requests`: it would turn the loopback `ws://` into `wss://`, which the server doesn't speak.
 */
export function headerPolicy(): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'unsafe-inline'",
    "img-src 'self' data:",
    `connect-src ${CONNECT_SOURCES.join(' ')}`,
    'worker-src blob:',
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}
