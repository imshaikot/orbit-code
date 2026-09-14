# @orbit-code/web-client

Orbit in a browser tab. This is the page at [orbit-code.imshaikot.com/web-client/](https://orbit-code.imshaikot.com/web-client/): it guides starting the local server (`npx @imshaikot/orbit-code-server`, [apps/server](../../apps/server/README.md)), connects to it on `127.0.0.1` with the link the server prints, then defines `window.orbitHost` over that WebSocket and loads `webview.js`, the same UI the editors show.

It is not published on its own. The server package ships its build, and the website takes it from the newest server on npm, so the page always speaks the protocol of the server people run.

## What it builds

`node build.mjs [--watch] [--production]`, or `yarn nx run web-client:build`, writes `dist/`:

| File | What |
| --- | --- |
| `web-client.js` | The connect prompt and the socket transport (`src/client.ts`), one IIFE with its styles inside |
| `webview.js` | Copied from `@orbit-code/webview` |
| `web-client.json` | What a hosting page must use: the protocol version, the server's package, host and ports, and the CSP (`src/manifest.ts`) |

A hosting page loads `web-client.js` with a nonce and `data-webview` naming where `webview.js` is; `data-home`, `data-install` and `data-docs` add links to the prompt.

## How it connects

1. The server prints `https://orbit-code.imshaikot.com/web-client/#port=6728&token=…`. The fragment never reaches the website; the page takes it out of the address bar at once and keeps it in `sessionStorage`, so a reload reconnects.
2. The page opens `ws://127.0.0.1:<port>/` and sends `hello` with the token and `PROTOCOL_VERSION`. Until a server answers, it tries again every few seconds.
3. The server answers `welcome` (with the folder's name) or `refused` (`token`, `protocol`, `handshake`), and the prompt says what to do about it.
4. After `welcome`, host messages arrive as `message` events on the window and the page's go back over the socket, as binary frames that keep typed arrays intact (`encodeFrame` in [packages/protocol/src/wire.ts](../protocol/src/wire.ts)). The page also reports whether its tab is visible and focused, which decides whether a permission request waits on the page or rings in the terminal.
5. If the server stops, a notice offers to reconnect; if another tab connects, this one is let go and says so.

## The CSP

`src/csp.ts` is the one source. The page's policy is the editor panel's (a nonce'd script and style, `worker-src blob:`, `img-src data:`) plus `connect-src` for exactly `ws://127.0.0.1:6728` through `6737`, the ports `SERVER_PORTS` lists, and nothing else. A static host sends a second policy as a header, which can't carry a nonce but can forbid framing; a browser enforces both. Neither has `upgrade-insecure-requests`, which would turn the loopback `ws://` into `wss://`.

## Running it locally

```sh
yarn nx run web-client:serve            # dist/ at http://127.0.0.1:4800/web-client/, under the same CSP
yarn server . --origin http://127.0.0.1:4800
yarn server:smoke                       # the two together in headless Chrome
```
