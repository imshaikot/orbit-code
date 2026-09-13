// The page's way to the main process, and nothing else: `window.orbitHost.postMessage` out, window `message` events in,
// exactly as the webview's HostBridge expects of any host but VS Code. Runs sandboxed, before the page's script.
//
// Only the function crosses the context bridge; each message then goes through ipcRenderer's own structured clone,
// which keeps the typed arrays of graphs and layouts intact in both directions.

import { contextBridge, ipcRenderer } from 'electron';

/** Also in src/main/window.ts. */
const TO_HOST = 'orbit:webview';
const TO_PAGE = 'orbit:host';

contextBridge.exposeInMainWorld('orbitHost', {
  postMessage: (message: unknown) => ipcRenderer.send(TO_HOST, message),
});

ipcRenderer.on(TO_PAGE, (_event, message: unknown) => window.postMessage(message, '*'));
