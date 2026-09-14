// What a page hosting the web client must know, written by build.mjs as dist/web-client.json. The website reads it
// from the server's npm package: its CSP for /web-client/, and the ports its checks compare with vercel.json.

import { PROTOCOL_VERSION } from '@orbit-code/protocol';
import { SERVER_HOST, SERVER_PACKAGE, SERVER_PORTS, WEB_CLIENT_ORIGIN, WEB_CLIENT_PATH } from '@orbit-code/protocol/wire';
import { CONNECT_SOURCES, contentSecurityPolicy, headerPolicy } from './csp';

export function webClientManifest() {
  return {
    protocol: PROTOCOL_VERSION,
    origin: WEB_CLIENT_ORIGIN,
    path: WEB_CLIENT_PATH,
    server: { package: SERVER_PACKAGE, command: `npx ${SERVER_PACKAGE}`, host: SERVER_HOST, ports: [...SERVER_PORTS] },
    csp: {
      /** For the page's meta tag: `{nonce}` stands for the nonce on its script tag. */
      page: contentSecurityPolicy('{nonce}'),
      /** For the response header, which a static host sends without a nonce. */
      header: headerPolicy(),
      connectSources: CONNECT_SOURCES,
    },
    /** The page loads `web-client.js` with `data-webview` naming where `webview.js` is. */
    files: ['web-client.js', 'webview.js'],
  };
}
