// The web client: the page at orbit-code.imshaikot.com/web-client/ (or scripts/serve.mjs for a local run). It guides
// starting orbit-server, connects to it with the link the server printed, then defines window.orbitHost over that
// socket and loads webview.js, the same UI the editors show. The link's token arrives in the URL fragment, which the
// browser never sends to the website, and is taken out of the address bar at once.

import type { HostToWebview } from '@orbit-code/protocol';
import { type ServerLink, isServerPort, parseServerLink } from '@orbit-code/protocol/wire';
import { Connection } from './connection';
import { Prompt, showNotice } from './prompt';
import styles from './styles.css';

/** The link, kept for this tab only, so a reload reconnects. */
const LINK_KEY = 'orbit.webClient.link';
/** What the webview asks its host to keep (the view mode), kept per browser. */
const STATE_KEY = 'orbit.webClient.state';

const script = document.currentScript as HTMLScriptElement | null;
const nonce = script?.nonce || undefined;
const webviewUrl = script?.dataset.webview ?? 'webview.js';

injectStyles();
const prompt = new Prompt(document.body, { home: script?.dataset.home, install: script?.dataset.install, docs: script?.dataset.docs }, (text) => {
  const link = parseServerLink(text);
  if (link) connect(link);
  else prompt.invalid();
});
let connection: Connection | undefined;
let workspace = false;

const hash = location.hash.slice(1);
if (hash) {
  // Out of the address bar, history and anything the page is shared from, whether or not it parses.
  history.replaceState(null, '', location.pathname + location.search);
  const link = parseServerLink(hash);
  if (link) connect(link);
  else prompt.invalid();
} else {
  const stored = parseServerLink(storage('sessionStorage')?.getItem(LINK_KEY) ?? '');
  if (stored) connect(stored);
}

function connect(link: ServerLink): void {
  connection?.stop();
  if (!isServerPort(link.port)) {
    prompt.portNotAllowed(link.port);
    return;
  }
  storage('sessionStorage')?.setItem(LINK_KEY, `port=${link.port}&token=${link.token}`);
  prompt.waiting(link.port);
  const current = new Connection(
    link,
    (event) => {
      if (connection !== current) return;
      switch (event.kind) {
        case 'unreachable':
          prompt.unreachable(link.port);
          break;
        case 'welcome':
          openWorkspace(event.folder);
          break;
        case 'refused':
          if (!workspace) prompt.refused(event.reason, event.version, event.protocol);
          else showNotice('Open in another tab', 'Orbit Code connected from another tab, and the server follows one tab at a time.', 'Use it here', () => location.reload());
          break;
        case 'lost':
          showNotice('The server stopped', 'Start it again with the same command. It prints a new link, which reconnects this page.', 'Reconnect', () => location.reload());
          break;
      }
    },
    deliver,
  );
  connection = current;
  current.start();
}

function openWorkspace(folder: string): void {
  workspace = true;
  prompt.connected(folder);
  document.title = `${folder} · Orbit Code`;
  window.orbitHost = {
    postMessage: (message) => connection?.post(message),
    getState: () => {
      try {
        return JSON.parse(storage('localStorage')?.getItem(STATE_KEY) ?? 'null');
      } catch {
        return null;
      }
    },
    setState: (state) => storage('localStorage')?.setItem(STATE_KEY, JSON.stringify(state)),
  };
  const sight = () => connection?.send({ t: 'sight', visible: document.visibilityState === 'visible', focused: document.hasFocus() });
  document.addEventListener('visibilitychange', sight);
  window.addEventListener('focus', sight);
  window.addEventListener('blur', sight);
  sight();

  const tag = document.createElement('script');
  if (nonce) tag.setAttribute('nonce', nonce);
  tag.src = webviewUrl;
  tag.addEventListener('load', () => prompt.dispose());
  tag.addEventListener('error', () => showNotice("The workspace didn't load", 'This page could not load webview.js. Reload to try again.', 'Reload', () => location.reload()));
  document.body.append(tag);
}

/** A host message, handed to the webview as the other hosts do: a `message` event on the window, delivered at once. */
function deliver(message: HostToWebview): void {
  window.dispatchEvent(new MessageEvent('message', { data: message }));
}

function injectStyles(): void {
  const style = document.createElement('style');
  if (nonce) style.setAttribute('nonce', nonce);
  style.textContent = styles;
  document.head.append(style);
}

/** Storage can be refused (a private window, blocked site data), even reading the property throws; then nothing is kept. */
function storage(area: 'localStorage' | 'sessionStorage'): Storage | undefined {
  try {
    return window[area];
  } catch {
    return undefined;
  }
}
