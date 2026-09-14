import { PROTOCOL_VERSION } from '@orbit-code/protocol';
import { type RefusedReason, SERVER_HOST, SERVER_PACKAGE, SERVER_PORTS } from '@orbit-code/protocol/wire';

/** Links the hosting page offers, from its script tag's data attributes; each is left out when absent. */
export interface PromptLinks {
  home?: string;
  install?: string;
  docs?: string;
}

type Tone = 'idle' | 'wait' | 'error' | 'ok';

const COMMAND = `npx ${SERVER_PACKAGE}`;
const FIRST_PORT = SERVER_PORTS[0];
const LAST_PORT = SERVER_PORTS[SERVER_PORTS.length - 1];

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * The page before the workspace: how to start the server, where its link goes, and what the connection is doing.
 * Every string is set as text, never as HTML.
 */
export class Prompt {
  private readonly root: HTMLElement;
  private readonly status: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly steps: [HTMLElement, HTMLElement];

  constructor(parent: HTMLElement, links: PromptLinks, connect: (text: string) => void) {
    this.root = element('div', 'wc');
    const card = element('main', 'wc-card');
    this.root.append(card);

    if (links.home) {
      const brand = element('a', 'wc-brand');
      brand.href = links.home;
      brand.append(element('span', 'wc-star'), element('span', undefined, 'Orbit Code'));
      card.append(brand);
    } else {
      const brand = element('div', 'wc-brand');
      brand.append(element('span', 'wc-star'), element('span', undefined, 'Orbit Code'));
      card.append(brand);
    }

    card.append(
      element('h1', undefined, 'Connect to your project'),
      element(
        'p',
        'wc-lede',
        `Orbit Code runs on your own machine. Start its server in your project folder and this page connects to it on ${SERVER_HOST}. Your code and your Claude Code session never pass through this website.`,
      ),
    );

    const list = element('ol', 'wc-steps');
    const start = element('li', 'wc-step');
    const command = element('div', 'wc-command');
    const copy = element('button', 'wc-button wc-quiet', 'Copy');
    copy.type = 'button';
    copy.addEventListener('click', () => {
      void navigator.clipboard?.writeText(COMMAND).then(
        () => {
          copy.textContent = 'Copied';
          setTimeout(() => (copy.textContent = 'Copy'), 1500);
        },
        () => undefined,
      );
    });
    command.append(element('code', undefined, COMMAND), copy);
    start.append(
      element('h2', undefined, 'Start the server'),
      element('p', undefined, 'In a terminal, in your project folder. It needs Node.js 20 or later, and Claude Code signed in for sessions.'),
      command,
    );

    const open = element('li', 'wc-step');
    const form = element('form', 'wc-link');
    this.input = element('input', 'wc-input');
    this.input.type = 'text';
    this.input.autocomplete = 'off';
    this.input.spellcheck = false;
    this.input.placeholder = 'Paste the link from the terminal';
    this.input.setAttribute('aria-label', 'Server link');
    const submit = element('button', 'wc-button', 'Connect');
    submit.type = 'submit';
    form.append(this.input, submit);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      connect(this.input.value);
    });
    open.append(element('h2', undefined, 'Open the link it prints'), element('p', undefined, 'The server opens it in your browser. If it opened somewhere else, paste it here.'), form);

    list.append(start, open);
    this.steps = [start, open];
    card.append(list);

    this.status = element('p', 'wc-status');
    this.status.setAttribute('role', 'status');
    card.append(this.status);

    const notes = element('div', 'wc-notes');
    notes.append(
      element('p', undefined, 'Your browser may ask to let this site reach apps on this device. Allow it: that is how the page reaches the server.'),
      element('p', undefined, `The page connects only to ${SERVER_HOST}, on ports ${FIRST_PORT} to ${LAST_PORT}, and the server answers only a page with the token from its link.`),
    );
    card.append(notes);

    const nav = element('nav', 'wc-links');
    nav.setAttribute('aria-label', 'Help');
    for (const [href, label] of [
      [links.install, 'Install guide'],
      [links.docs, 'How the web client works'],
    ] as const) {
      if (!href) continue;
      const link = element('a', undefined, label);
      link.href = href;
      nav.append(link);
    }
    if (nav.childElementCount > 0) card.append(nav);

    parent.append(this.root);
    this.idle();
  }

  idle(): void {
    this.show('idle', 'Start the server, then open the link it prints.', 0);
  }

  waiting(port: number): void {
    this.show('wait', `Looking for the server on ${SERVER_HOST}:${port}.`, 1);
  }

  unreachable(port: number): void {
    this.show('wait', `No server answered on port ${port} yet. Start it, and this page connects on its own.`, 0);
  }

  invalid(): void {
    this.show('error', 'That is not a server link. Copy the whole line that starts with https from the terminal.', 1);
    this.input.focus();
  }

  portNotAllowed(port: number): void {
    this.show('error', `This page can't reach port ${port}. Start the server without --port, or with a port from ${FIRST_PORT} to ${LAST_PORT}.`, 1);
  }

  refused(reason: RefusedReason, version: string, protocol: number): void {
    const text =
      reason === 'token'
        ? 'A server answered, but not to this link. The link changes each time the server starts, so copy it again from the terminal.'
        : reason === 'protocol'
          ? protocol < PROTOCOL_VERSION
            ? `Your server is version ${version}, older than this page. Stop it and run ${COMMAND}@latest.`
            : `Your server is version ${version}, newer than this page. Reload the page to get the current web client.`
          : reason === 'replaced'
            ? 'Orbit Code opened in another tab.'
            : 'The server closed the connection. Try the link again.';
    this.show('error', text, 1);
  }

  connected(folder: string): void {
    this.show('ok', `Connected to ${folder}. Loading the workspace.`, 2);
  }

  dispose(): void {
    this.root.remove();
  }

  /** `step` is how many steps are done: 0 marks the first as current, 2 marks both done. */
  private show(tone: Tone, text: string, step: number): void {
    this.status.dataset.tone = tone;
    this.status.textContent = text;
    this.steps.forEach((node, i) => (node.dataset.state = i < step ? 'done' : i === step ? 'current' : 'next'));
  }
}

/** A card over the workspace once its connection is gone, with the one thing to do about it. */
export function showNotice(title: string, body: string, action: string, onAction: () => void): void {
  document.querySelector('.wc-notice')?.remove();
  const notice = element('div', 'wc-notice');
  notice.setAttribute('role', 'alertdialog');
  notice.setAttribute('aria-label', title);
  const button = element('button', 'wc-button', action);
  button.type = 'button';
  button.addEventListener('click', onAction);
  notice.append(element('h2', undefined, title), element('p', undefined, body), button);
  document.body.append(notice);
  button.focus();
}
