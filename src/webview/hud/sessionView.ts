import type { PermissionAnswer, SessionState, TranscriptEntry } from '../../shared/protocol';
import { button, el } from './dom';
import { renderMarkdown } from './markdown';
import { type Turn, activityOf, clock, dollars, outcomeLine, promptLine, seconds, toolLabel } from './turns';

export interface SessionViewActions {
  /** A follow-up from the view's own composer, continuing the conversation `key`; false if it could not be sent. */
  prompt(text: string, key: string): boolean;
  interrupt(key: string): void;
  answerPermission(key: string, id: string, answer: PermissionAnswer): void;
  openFile(path: string): void;
  close(): void;
}

/** One conversation's transcript, kept rendered whether or not it is the one on show. */
interface Pane {
  readonly root: HTMLElement;
  group: HTMLElement | undefined;
  entries: number;
}

const MAX_ENTRIES = 400;
const STICK_TO_BOTTOM_PX = 32;
const MAX_INPUT_PX = 140;
const SHEET_EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';

/**
 * A session opened out of its bubble: what it asked, Claude's replies as Markdown, every tool call, the
 * permission card, and a footer to stop the session or, once it is done, to reply. The transcript is the
 * whole conversation the session belongs to (a reply continues it); the header follows the session that was
 * opened. Every conversation's transcript is kept, and the view shows one at a time.
 */
export class SessionView {
  private readonly root = el('section', 'session-view');
  private readonly panel = el('div', 'sv-panel');
  private readonly title = el('h2', 'sv-title');
  private readonly verb = el('span', 'sv-verb');
  private readonly path = el('span', 'sv-path');
  private readonly time = el('span', 'sv-time');
  private readonly meta = el('span', 'sv-meta');
  private readonly closeButton = button('', 'sv-close', 'Close (Esc)');
  private readonly transcript = el('div', 'transcript');
  private readonly permission = el('div', 'permission');
  private readonly permissionTitle = el('p', 'permission-title');
  private readonly permissionDetail = el('p', 'permission-detail');
  private readonly allow = button('Allow', 'button primary');
  /** The agent's "don't ask again" choice, labelled by the request; hidden when it offers none. */
  private readonly always = button('', 'button permission-always');
  private readonly deny = button('Deny', 'button');
  private readonly input = el('textarea', 'sv-input');
  private readonly action = el('button', 'button primary sv-action', 'Send');
  /** Shown only once a turn has failed (an API error, or the process lost to the machine sleeping): resumes the same conversation without retyping anything. */
  private readonly continueButton = button('Continue', 'button primary sv-continue', 'Continue this conversation');
  private readonly panes = new Map<string, Pane>();
  /** The latest state of each conversation, by key. */
  private readonly states = new Map<string, SessionState>();
  /** The conversation on show. */
  private shown: string | undefined;
  private turn: Turn | undefined;
  private state: SessionState | undefined;
  private answered: string | undefined;
  private motion: Animation | undefined;
  private ticker: ReturnType<typeof setInterval> | undefined;

  constructor(
    host: HTMLElement,
    private readonly actions: SessionViewActions,
  ) {
    this.root.hidden = true;
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', 'Claude session');
    this.closeButton.setAttribute('aria-label', 'Close');

    const head = el('header', 'sv-head');
    const status = el('p', 'sv-status');
    status.append(this.verb, this.path, this.meta, this.time);
    const heading = el('div', 'sv-heading');
    heading.append(this.title, status);
    head.append(heading, this.closeButton);

    this.transcript.setAttribute('aria-live', 'polite');

    this.permission.hidden = true;
    this.permission.setAttribute('role', 'alertdialog');
    const decisions = el('div', 'permission-actions');
    decisions.append(this.deny, this.always, this.allow);
    this.permission.append(this.permissionTitle, this.permissionDetail, decisions);

    const footer = el('form', 'sv-footer');
    this.input.rows = 1;
    this.input.setAttribute('aria-label', 'Reply');
    this.action.type = 'submit';
    footer.append(this.continueButton, this.input, this.action);

    this.panel.append(head, this.transcript, this.permission, footer);
    this.root.append(this.panel);
    host.append(this.root);

    this.closeButton.addEventListener('click', () => actions.close());
    this.transcript.append(el('div', 't-pane'));
    footer.addEventListener('submit', (event) => {
      event.preventDefault();
      this.submit();
    });
    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        this.submit();
      }
    });
    this.input.addEventListener('input', () => {
      this.autosize();
      this.refreshFooter();
    });
    this.continueButton.addEventListener('click', () => this.continueTurn());
    this.allow.addEventListener('click', () => this.answer('allow'));
    this.always.addEventListener('click', () => this.answer('always'));
    this.deny.addEventListener('click', () => this.answer('deny'));
    this.transcript.addEventListener('click', (event) => {
      const link = (event.target as HTMLElement).closest<HTMLElement>('[data-file]');
      if (link?.dataset.file) actions.openFile(link.dataset.file);
    });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  /** The conversation on show, if open. */
  get key(): string | undefined {
    return this.isOpen ? this.shown : undefined;
  }

  /** Opens out of `origin` (the bubble), over the session `turn` of the conversation `key`; without a turn, over the whole conversation. */
  open(turn: Turn | undefined, origin: DOMRect | undefined, key: string): void {
    this.show(key);
    this.turn = turn;
    this.root.hidden = false;
    this.renderHead();
    this.refreshFooter();
    this.syncTicker();
    this.transcript.scrollTop = this.transcript.scrollHeight;
    this.motion?.cancel();
    if (!reducedMotion()) {
      const clip = this.clipFrom(origin);
      this.motion = this.panel.animate([{ clipPath: clip.from }, { clipPath: clip.to }], { duration: 480, easing: SHEET_EASE });
      for (const [k, part] of [...this.panel.children].entries()) {
        part.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 260, delay: 110 + k * 35, easing: 'ease-out', fill: 'backwards' });
      }
    }
    (this.input.disabled ? this.closeButton : this.input).focus({ preventScroll: true });
  }

  /** Collapses back into `origin`. */
  close(origin: DOMRect | undefined): void {
    if (this.root.hidden) return;
    this.motion?.cancel();
    this.syncTicker(false);
    if (reducedMotion()) {
      this.root.hidden = true;
      return;
    }
    const clip = this.clipFrom(origin);
    const motion = this.panel.animate([{ clipPath: clip.to }, { clipPath: clip.from }], { duration: 300, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' });
    this.motion = motion;
    motion.onfinish = () => {
      this.root.hidden = true;
      motion.cancel();
    };
  }

  /** The header follows another session (a reply sent from the view starts one). */
  follow(turn: Turn | undefined): void {
    this.turn = turn;
    this.renderHead();
    this.syncTicker();
  }

  /** The followed session's activity changed. */
  refresh(): void {
    if (!this.isOpen) return;
    this.renderHead();
    // The transcript's `turn` entry (which the header and Continue read from `this.turn.end`) can arrive after the
    // state message that dropped the phase back to idle, so the footer needs its own refresh once it does.
    this.refreshFooter();
  }

  /** One conversation's state; only the one on show changes what is drawn. */
  setState(state: SessionState): void {
    this.states.set(state.key, state);
    if (state.key !== this.shown) return;
    this.state = state;
    const request = state.permission;
    this.permission.hidden = !request;
    if (request) {
      this.permissionTitle.replaceChildren('Allow Claude to use ', el('b', undefined, toolLabel(request.tool)), '?');
      this.permissionDetail.textContent = request.detail;
      this.always.hidden = !request.always;
      this.always.textContent = request.always ?? '';
      this.allow.disabled = this.always.disabled = this.deny.disabled = this.answered === request.id;
    } else {
      this.answered = undefined;
    }
    this.refreshFooter();
    this.renderHead();
    this.syncTicker();
  }

  /** The transcript of the conversation `key` grew, or starts over. */
  appendTranscript(key: string, reset: boolean, entries: readonly TranscriptEntry[]): void {
    const pane = this.pane(key);
    const list = this.transcript;
    const onShow = key === this.shown;
    const atBottom = onShow && list.scrollHeight - list.scrollTop - list.clientHeight < STICK_TO_BOTTOM_PX;
    if (reset) {
      pane.root.replaceChildren();
      pane.group = undefined;
      pane.entries = 0;
    }
    for (const entry of entries) {
      if (entry.kind === 'prompt' || !pane.group) {
        pane.group = el('article', 't-group');
        pane.root.append(pane.group);
      }
      pane.group.append(renderEntry(entry));
      pane.entries++;
    }
    while (pane.entries > MAX_ENTRIES) {
      const first = pane.root.firstElementChild;
      if (!first) break;
      const oldest = first.firstElementChild;
      if (oldest) {
        oldest.remove();
        pane.entries--;
      }
      if (!first.firstElementChild) first.remove();
    }
    if (onShow && (reset || atBottom)) list.scrollTop = list.scrollHeight;
  }

  /** The conversation the drawer continues: its transcript is the one in the box while the view is closed, ready for View conversation. */
  setCurrent(key: string): void {
    if (!this.isOpen) this.show(key);
  }

  /** The conversation `key` is gone, its transcript with it. */
  forget(key: string): void {
    this.states.delete(key);
    const pane = this.panes.get(key);
    this.panes.delete(key);
    if (this.shown === key) {
      this.shown = undefined;
      this.state = undefined;
      this.transcript.replaceChildren(el('div', 't-pane'));
    } else {
      pane?.root.remove();
    }
  }

  private pane(key: string): Pane {
    let pane = this.panes.get(key);
    if (!pane) {
      pane = { root: el('div', 't-pane'), group: undefined, entries: 0 };
      this.panes.set(key, pane);
    }
    return pane;
  }

  /** Puts the conversation `key`'s transcript in the scroll box and takes its state. */
  private show(key: string): void {
    if (key !== this.shown) {
      this.shown = key;
      this.transcript.replaceChildren(this.pane(key).root);
    }
    const state = this.states.get(key);
    this.state = state;
    this.answered = undefined;
    if (state) this.setState(state);
    else this.permission.hidden = true;
  }

  private submit(): void {
    const text = this.input.value.trim();
    const phase = this.state?.phase;
    const key = this.shown;
    if (key === undefined) return;
    if (phase === 'working') {
      this.actions.interrupt(key);
      return;
    }
    if (!text || phase !== 'idle' || !this.actions.prompt(text, key)) return;
    this.input.value = '';
    this.autosize();
    this.refreshFooter();
    this.transcript.scrollTop = this.transcript.scrollHeight;
  }

  /** Resumes the conversation after a failed turn, without needing anything typed: `prompt()` already restarts the agent process with `--resume`. */
  private continueTurn(): void {
    const key = this.shown;
    if (key === undefined || this.state?.phase !== 'idle') return;
    this.actions.prompt('Continue', key);
  }

  private answer(answer: PermissionAnswer): void {
    const request = this.state?.permission;
    if (!request || this.answered === request.id || this.shown === undefined) return;
    this.answered = request.id;
    this.allow.disabled = this.always.disabled = this.deny.disabled = true;
    this.actions.answerPermission(this.shown, request.id, answer);
  }

  private renderHead(): void {
    const state = this.state;
    const turn = this.turn;
    this.root.dataset.phase = turn?.end ? turn.end.outcome : state?.permission ? 'waiting' : (state?.phase ?? 'unavailable');
    this.title.textContent = turn ? promptLine(turn.prompt, turn.skills) : 'This conversation';
    this.meta.textContent = state?.model ?? (state?.options.model || '');
    this.path.textContent = this.time.textContent = '';
    if (!state) return;
    if (!turn) {
      this.verb.textContent = state.turns > 0 ? `${state.turns} ${state.turns === 1 ? 'prompt' : 'prompts'}, ${dollars(state.costUsd)}` : 'Nothing asked yet';
    } else if (turn.end) {
      this.verb.textContent = turn.end.costUsd > 0 && turn.end.outcome !== 'failed' ? `${outcomeLine(turn.end)}, ${dollars(turn.end.costUsd)}` : outcomeLine(turn.end);
    } else {
      const activity = activityOf(turn, state);
      this.verb.textContent = activity.verb;
      this.path.textContent = activity.detail ?? '';
      this.time.textContent = clock(Date.now() - turn.startedAt);
    }
  }

  private refreshFooter(): void {
    const phase = this.state?.phase ?? 'unavailable';
    const busy = phase === 'working' || phase === 'stopping';
    const canContinue = phase === 'idle' && this.turn?.end?.outcome === 'failed';
    this.continueButton.hidden = !canContinue;
    this.input.disabled = phase !== 'idle';
    this.input.placeholder = busy
      ? 'You can reply once Claude finishes'
      : phase === 'unavailable'
        ? (this.state?.error ?? 'Claude Code is not available')
        : canContinue
          ? 'Continue where it left off, or reply with something else…'
          : 'Reply to continue the conversation…';
    if (busy) {
      this.action.textContent = phase === 'stopping' ? 'Stopping' : 'Stop';
      this.action.className = 'button danger sv-action';
      this.action.disabled = phase === 'stopping';
    } else {
      this.action.textContent = 'Send';
      this.action.className = 'button primary sv-action';
      this.action.disabled = phase !== 'idle' || this.input.value.trim() === '';
    }
  }

  private syncTicker(running = this.isOpen && !!this.turn && !this.turn.end): void {
    if (running && !this.ticker) this.ticker = setInterval(() => this.renderHead(), 1000);
    else if (!running && this.ticker) {
      clearInterval(this.ticker);
      this.ticker = undefined;
    }
  }

  /** Circle clips centred on the bubble: its own size, and large enough to uncover the whole panel. */
  private clipFrom(origin: DOMRect | undefined): { from: string; to: string } {
    const box = this.panel.getBoundingClientRect();
    const cx = origin ? origin.left + origin.width / 2 - box.left : 22;
    const cy = origin ? origin.top + origin.height / 2 - box.top : box.height - 22;
    const radius = Math.hypot(Math.max(cx, box.width - cx), Math.max(cy, box.height - cy)) + 8;
    return { from: `circle(22px at ${cx}px ${cy}px)`, to: `circle(${radius}px at ${cx}px ${cy}px)` };
  }

  private autosize(): void {
    this.input.style.height = 'auto';
    this.input.style.height = `${Math.min(this.input.scrollHeight, MAX_INPUT_PX)}px`;
  }
}

function renderEntry(entry: TranscriptEntry): HTMLElement {
  const item = el(entry.kind === 'text' ? 'div' : 'p', `t-entry t-${entry.kind}`);
  switch (entry.kind) {
    case 'prompt':
      for (const skill of entry.skills ?? []) item.append(el('span', 't-skill', `/${skill}`));
      item.append(entry.text);
      break;
    case 'text':
      item.append(renderMarkdown(entry.text));
      break;
    case 'tool': {
      if (entry.mcp) {
        // The server names the call; the tool and what it was asked follow.
        item.classList.add('t-mcp');
        item.title = `${entry.mcp.server} (MCP) › ${entry.mcp.tool}`;
        item.append(el('span', 't-tool-name', entry.mcp.server), el('span', 't-tool-detail', entry.detail ? `${entry.mcp.tool} · ${entry.detail}` : entry.mcp.tool));
        break;
      }
      if (entry.action) item.classList.add(`t-${entry.action}`);
      item.append(el('span', 't-tool-name', entry.tool));
      if (entry.file) {
        const link = button(entry.detail, 't-tool-detail t-link', `Open ${entry.file}`);
        link.dataset.file = entry.file;
        item.append(link);
      } else {
        const detail = el('span', 't-tool-detail', entry.detail);
        if (entry.action) detail.title = 'Not in the indexed graph';
        item.append(detail);
      }
      break;
    }
    case 'turn': {
      item.dataset.outcome = entry.outcome;
      const cost = entry.costUsd > 0 ? `, ${dollars(entry.costUsd)}` : '';
      if (entry.outcome === 'done') item.textContent = `Done in ${seconds(entry.durationMs)}${cost}`;
      else if (entry.outcome === 'interrupted') item.textContent = `Stopped${cost}`;
      else item.textContent = `Failed${entry.message ? `: ${entry.message}` : ''}`;
      break;
    }
    case 'notice':
      item.dataset.level = entry.level;
      item.textContent = entry.text;
      break;
  }
  return item;
}

function reducedMotion(): boolean {
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}
