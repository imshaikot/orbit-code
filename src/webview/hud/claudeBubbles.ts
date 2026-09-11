import type { SessionState } from '../../shared/protocol';
import { button, el } from './dom';
import { type Turn, activityOf, clock, outcomeLine, promptLine } from './turns';

/** Keep in step with .claude-bubble-button in styles.css. */
const SIZE = 44;
const LINGER_MS = 2600;
const LINGER_AFTER_HOVER_MS = 1200;
/** A launched prompt with no sign of a turn after this long was not taken up by the host. */
const PENDING_TIMEOUT_MS = 6000;
/** A turn whose closing line has not arrived this long after the session went idle is closed anyway. */
const SETTLE_MS = 1500;
const RIPPLE_GAP_MS = 140;
/** Ripples waiting beyond this many are dropped, oldest first, so a burst of tool calls doesn't keep rippling long after. */
const MAX_RIPPLE_BACKLOG = 4;
const SHEET_EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';

export type ClaudeBubblePhase = 'launching' | 'working' | 'waiting' | 'stopping' | 'done' | 'interrupted' | 'failed';

export interface ClaudeBubbleEvents {
  open(bubble: ClaudeBubble): void;
  /** A launched prompt the host never started; the composer can take it back. */
  abandoned(prompt: string): void;
}

/**
 * One session on the graph screen: Claude's spark in a glass disc, and a label that slides out to say what it is doing.
 * `key` is its conversation: known from the start for a reply, else claimed by the first conversation the host reports working.
 */
export class ClaudeBubble {
  readonly root = el('div', 'claude-bubble');
  readonly button = button('', 'claude-bubble-button');
  readonly label = el('div', 'claude-bubble-label');
  readonly title = el('p', 'claude-bubble-title');
  readonly verb = el('span', 'claude-bubble-verb');
  readonly path = el('span', 'claude-bubble-path');
  readonly time = el('span', 'claude-bubble-time');
  phase: ClaudeBubblePhase = 'launching';
  key: string | undefined;
  turn: Turn | undefined;
  readonly startedAt = Date.now();
  lastRipple = 0;
  /** Ripple colours waiting to play, RIPPLE_GAP_MS apart. */
  readonly ripples: string[] = [];
  rippleTimer: ReturnType<typeof setTimeout> | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly prompt: string | undefined,
    key?: string,
  ) {
    this.key = key;
    const halo = el('span', 'claude-bubble-halo');
    const spark = el('span', 'spark');
    halo.setAttribute('aria-hidden', 'true');
    spark.setAttribute('aria-hidden', 'true');
    this.button.append(halo, spark);
    const detail = el('p', 'claude-bubble-detail');
    detail.append(this.verb, this.path, this.time);
    this.label.append(this.title, detail);
    this.label.setAttribute('aria-hidden', 'true');
    this.root.append(this.button, this.label);
  }

  get ended(): boolean {
    return this.phase === 'done' || this.phase === 'interrupted' || this.phase === 'failed';
  }
}

/**
 * Bottom left: a bubble per session, of as many conversations as run at once. A prompt sent from the drawer flies
 * here from the composer and lands with a burst; while the session runs the bubble pulses, and every file Claude
 * reads or edits sends a cyan or amber ripple through it. A finished session says how it ended and leaves; a failed
 * one stays until it is opened.
 */
export class ClaudeBubbles {
  private readonly root = el('div', 'claude-bubbles');
  private readonly bubbles: ClaudeBubble[] = [];
  /** The latest state of each conversation, by key. */
  private readonly states = new Map<string, SessionState>();
  private covered: ClaudeBubble | null | undefined;
  private ticker: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly host: HTMLElement,
    private readonly events: ClaudeBubbleEvents,
  ) {
    this.root.setAttribute('aria-label', 'Claude sessions');
    host.append(this.root);
  }

  /** The session still running for the conversation `key`, or for any conversation without one. */
  live(key?: string): ClaudeBubble | undefined {
    return this.bubbles.findLast((bubble) => !bubble.ended && (key === undefined || bubble.key === key));
  }

  forTurn(turn: Turn): ClaudeBubble | undefined {
    return this.bubbles.find((bubble) => bubble.turn === turn);
  }

  /**
   * A new session. It flies to its slot from `from` (carrying `prompt` out of the composer when `fromComposer`),
   * or appears in place with no rect or while the session view covers the stack. `key` is known for a reply; a
   * drawer prompt's conversation is whichever the host starts for it.
   */
  launch(prompt: string | undefined, from: DOMRect | undefined, fromComposer = false, key?: string): ClaudeBubble {
    for (const bubble of this.bubbles.filter((b) => b.ended && b !== this.covered)) this.remove(bubble);
    const bubble = new ClaudeBubble(prompt, key);
    this.bubbles.push(bubble);
    this.root.prepend(bubble.root);
    bubble.button.addEventListener('click', () => this.events.open(bubble));
    bubble.root.addEventListener('pointerenter', () => {
      if (bubble.ended && bubble.phase !== 'failed') clearTimeout(bubble.timer);
    });
    bubble.root.addEventListener('pointerleave', () => {
      if (bubble.ended && bubble.phase !== 'failed' && this.covered === undefined) this.linger(bubble, LINGER_AFTER_HOVER_MS);
    });
    bubble.timer = setTimeout(() => {
      // A conversation that took the prompt claims the bubble at once; one still unclaimed, or whose conversation sits idle, was not taken up.
      const phase = bubble.key === undefined ? undefined : this.states.get(bubble.key)?.phase;
      if (bubble.turn || !this.bubbles.includes(bubble) || phase === 'working' || phase === 'stopping') return;
      this.remove(bubble);
      if (prompt) this.events.abandoned(prompt);
    }, PENDING_TIMEOUT_MS);
    this.render(bubble);
    if (from && this.covered === undefined && !reducedMotion()) this.fly(bubble, from, fromComposer ? prompt : undefined);
    this.syncTicker();
    return bubble;
  }

  /** Attaches a turn to the session launched for it (its conversation's, else the oldest unclaimed), or launches one from `origin` for a turn started elsewhere. */
  bind(turn: Turn, origin: DOMRect | undefined): ClaudeBubble {
    const bubble = this.bubbles.find((b) => !b.turn && !b.ended && b.key === turn.key) ?? this.unclaimed() ?? this.launch(turn.prompt, origin, false, turn.key);
    clearTimeout(bubble.timer);
    bubble.key = turn.key;
    bubble.turn = turn;
    this.render(bubble);
    return bubble;
  }

  /** Whether a bubble launched from the composer is still waiting for the host to name its conversation. */
  get pendingLaunch(): boolean {
    return this.unclaimed() !== undefined;
  }

  /** A bubble launched from the composer, whose conversation the host has not named yet. */
  private unclaimed(): ClaudeBubble | undefined {
    return this.bubbles.find((b) => !b.turn && !b.ended && b.key === undefined);
  }

  /** A turn already running when the transcript was replayed: its bubble is simply there. */
  restore(turn: Turn): void {
    if (!this.forTurn(turn)) this.bind(turn, undefined);
  }

  /** The turn's activity changed; `ripple` is set for a file read or edit, or a call to an MCP server. */
  update(turn: Turn, ripple?: 'read' | 'edit' | 'mcp'): void {
    const bubble = this.forTurn(turn);
    if (!bubble || bubble.ended) return;
    this.render(bubble);
    if (!ripple || this.covered !== undefined) return;
    // Calls that arrive together (parallel tool calls, one host tick) ripple one after another instead of as one.
    bubble.ripples.push(`var(--${ripple})`);
    if (bubble.ripples.length > MAX_RIPPLE_BACKLOG) bubble.ripples.shift();
    this.nextRipple(bubble);
  }

  finish(turn: Turn): void {
    const bubble = this.forTurn(turn);
    if (bubble && !bubble.ended) this.end(bubble);
  }

  /** One conversation's state. A conversation that started working claims the bubble launched from the composer for it. */
  setState(state: SessionState): void {
    this.states.set(state.key, state);
    const busy = state.phase === 'working' || state.phase === 'stopping';
    let live = this.live(state.key);
    if (!live && busy) {
      live = this.unclaimed();
      if (live) live.key = state.key;
    }
    if (live) {
      if (state.phase === 'working') live.phase = state.permission ? 'waiting' : 'working';
      else if (state.phase === 'stopping') live.phase = 'stopping';
      else if (live.turn && !live.turn.end) {
        clearTimeout(live.timer);
        live.timer = setTimeout(() => {
          const phase = live.key === undefined ? undefined : this.states.get(live.key)?.phase;
          if (!live.ended && phase !== 'working' && phase !== 'stopping') this.end(live);
        }, SETTLE_MS);
      }
      this.render(live);
    }
    this.syncTicker();
  }

  /** The conversation `key` is gone: its bubbles with it. */
  forget(key: string): void {
    this.states.delete(key);
    for (const bubble of this.bubbles.filter((b) => b.key === key)) this.remove(bubble);
  }

  /** The session view opened over `bubble` (null: over the whole conversation). The stack hides meanwhile. */
  cover(bubble: ClaudeBubble | null): void {
    this.covered = bubble;
    this.root.dataset.covered = 'true';
  }

  /** The view closed: its bubble goes if the session ended, and sessions that ended meanwhile start leaving. */
  uncover(): void {
    const covered = this.covered;
    this.covered = undefined;
    delete this.root.dataset.covered;
    for (const bubble of [...this.bubbles]) {
      if (!bubble.ended) continue;
      if (bubble === covered) this.remove(bubble);
      else if (bubble.phase !== 'failed') this.linger(bubble, LINGER_MS);
    }
  }

  /** The conversation's transcript starts over: its sessions go. A prompt still launching stays. */
  clear(key: string): void {
    for (const bubble of this.bubbles.filter((b) => b.turn && b.key === key)) this.remove(bubble);
  }

  private end(bubble: ClaudeBubble): void {
    clearTimeout(bubble.timer);
    this.stopRipples(bubble);
    bubble.phase = bubble.turn?.end?.outcome ?? 'done';
    this.render(bubble);
    this.syncTicker();
    if (this.covered !== undefined) return;
    this.ring(bubble, bubble.phase === 'failed' ? 'var(--error)' : 'var(--claude)');
    if (bubble.phase !== 'failed') this.linger(bubble, LINGER_MS);
  }

  private linger(bubble: ClaudeBubble, ms: number): void {
    clearTimeout(bubble.timer);
    bubble.root.dataset.peek = 'true';
    bubble.timer = setTimeout(() => this.leave(bubble), ms);
  }

  private leave(bubble: ClaudeBubble): void {
    if (!this.bubbles.includes(bubble) || bubble.root.dataset.leaving) return;
    bubble.root.dataset.leaving = 'true';
    if (reducedMotion()) {
      this.remove(bubble);
      return;
    }
    const motion = bubble.root.animate(
      [
        { transform: 'none', opacity: 1 },
        { transform: 'translateY(10px) scale(0.35)', opacity: 0 },
      ],
      { duration: 380, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' },
    );
    motion.onfinish = () => this.remove(bubble);
  }

  private remove(bubble: ClaudeBubble): void {
    clearTimeout(bubble.timer);
    this.stopRipples(bubble);
    const at = this.bubbles.indexOf(bubble);
    if (at >= 0) this.bubbles.splice(at, 1);
    bubble.root.remove();
    this.syncTicker();
  }

  private render(bubble: ClaudeBubble): void {
    const title = bubble.turn ? promptLine(bubble.turn.prompt, bubble.turn.skills) : (bubble.prompt ?? 'Claude session');
    bubble.root.dataset.phase = bubble.phase;
    bubble.title.textContent = title;
    if (bubble.ended) {
      bubble.verb.textContent = bubble.turn?.end ? outcomeLine(bubble.turn.end) : 'Done';
      bubble.path.textContent = bubble.time.textContent = '';
      bubble.root.dataset.peek = String(bubble.phase === 'failed' || bubble.root.dataset.peek === 'true');
    } else {
      const state = bubble.key === undefined ? undefined : this.states.get(bubble.key);
      const activity = state ? activityOf(bubble.turn, state) : { verb: 'Starting' };
      bubble.verb.textContent = bubble.phase === 'launching' ? 'Starting' : activity.verb;
      bubble.path.textContent = bubble.phase === 'launching' ? '' : (activity.detail ?? '');
      bubble.time.textContent = clock(Date.now() - bubble.startedAt);
      bubble.root.dataset.peek = String(bubble.phase === 'waiting');
    }
    bubble.button.setAttribute('aria-label', `Claude session: ${title}. ${bubble.verb.textContent}${bubble.path.textContent ? ` ${bubble.path.textContent}` : ''}. Open`);
  }

  /** Elapsed time moves once a second, only while a session runs. */
  private syncTicker(): void {
    const live = this.live();
    if (live && !this.ticker) {
      this.ticker = setInterval(() => {
        for (const bubble of this.bubbles) if (!bubble.ended) bubble.time.textContent = clock(Date.now() - bubble.startedAt);
      }, 1000);
    } else if (!live && this.ticker) {
      clearInterval(this.ticker);
      this.ticker = undefined;
    }
  }

  private ring(bubble: ClaudeBubble, color: string): void {
    if (reducedMotion()) return;
    const ring = el('span', 'claude-bubble-ring');
    ring.style.setProperty('--ring', color);
    bubble.button.append(ring);
    const motion = ring.animate(
      [
        { transform: 'scale(1)', opacity: 0.9 },
        { transform: 'scale(2.4)', opacity: 0 },
      ],
      { duration: 900, easing: 'cubic-bezier(0.2, 0.6, 0.3, 1)' },
    );
    motion.onfinish = motion.oncancel = () => ring.remove();
  }

  /** Plays the bubble's waiting ripples RIPPLE_GAP_MS apart; the session view covering the stack drops them. */
  private nextRipple(bubble: ClaudeBubble): void {
    if (this.covered !== undefined) bubble.ripples.length = 0;
    if (bubble.rippleTimer !== undefined || bubble.ripples.length === 0) return;
    const wait = bubble.lastRipple + RIPPLE_GAP_MS - performance.now();
    if (wait > 0) {
      bubble.rippleTimer = setTimeout(() => {
        bubble.rippleTimer = undefined;
        this.nextRipple(bubble);
      }, wait);
      return;
    }
    bubble.lastRipple = performance.now();
    this.ring(bubble, bubble.ripples.shift()!);
    this.nextRipple(bubble);
  }

  private stopRipples(bubble: ClaudeBubble): void {
    clearTimeout(bubble.rippleTimer);
    bubble.rippleTimer = undefined;
    bubble.ripples.length = 0;
  }

  /**
   * The launch. The composer text condenses into a star (the pill narrows to a disc, the words fade, the
   * spark turns in) while it arcs to the bubble's slot: x and y are animated on separate elements with
   * different easings, so the path rises and falls. It lands with a squash and a burst.
   */
  private fly(bubble: ClaudeBubble, from: DOMRect, text: string | undefined): void {
    bubble.root.dataset.arriving = 'true';
    const to = bubble.button.getBoundingClientRect();
    const sx = from.left + from.width / 2;
    const sy = from.top + from.height / 2;
    const tx = to.left + to.width / 2;
    const ty = to.top + to.height / 2;
    const apex = Math.min(sy, ty) - Math.min(170, Math.max(64, Math.abs(sx - tx) * 0.24));
    const duration = text ? 780 : 620;
    const startWidth = text ? Math.min(from.width, 460) : SIZE;
    const startHeight = text ? Math.min(Math.max(from.height, 36), 72) : SIZE;

    const x = el('div', 'launch');
    const y = el('div', 'launch-y');
    const body = el('div', 'launch-body');
    const words = el('span', 'launch-text', text ?? '');
    const spark = el('span', 'spark');
    x.setAttribute('aria-hidden', 'true');
    body.append(words, spark);
    y.append(body);
    x.append(y);
    this.host.append(x);

    const timing = { duration, fill: 'both' } as const;
    x.animate([{ transform: `translateX(${sx}px)` }, { transform: `translateX(${tx}px)` }], { ...timing, easing: 'cubic-bezier(0.45, 0, 0.3, 1)' });
    y.animate(
      [
        { transform: `translateY(${sy}px)`, easing: 'cubic-bezier(0.2, 0.7, 0.4, 1)' },
        { transform: `translateY(${apex}px)`, offset: 0.46, easing: 'cubic-bezier(0.6, 0, 0.85, 0.5)' },
        { transform: `translateY(${ty}px)` },
      ],
      timing,
    );
    body.animate(
      [
        { width: `${startWidth}px`, height: `${startHeight}px`, borderRadius: '10px', background: 'rgba(3, 6, 16, 0.8)', boxShadow: '0 0 0 rgba(165, 139, 255, 0)' },
        { width: `${SIZE}px`, height: `${SIZE}px`, borderRadius: `${SIZE / 2}px`, background: 'rgba(22, 20, 52, 0.95)', boxShadow: '0 0 26px rgba(165, 139, 255, 0.75)', offset: text ? 0.36 : 0.2 },
        { width: `${SIZE}px`, height: `${SIZE}px`, borderRadius: `${SIZE / 2}px`, background: 'rgba(22, 20, 52, 0.95)', boxShadow: '0 0 16px rgba(165, 139, 255, 0.55)' },
      ],
      { ...timing, easing: SHEET_EASE },
    );
    words.animate([{ opacity: 1 }, { opacity: 0, offset: 0.18 }, { opacity: 0 }], timing);
    const flight = spark.animate(
      [
        { opacity: 0, transform: 'scale(0.3) rotate(-120deg)' },
        { opacity: 0, transform: 'scale(0.3) rotate(-120deg)', offset: text ? 0.2 : 0 },
        { opacity: 1, transform: 'scale(1) rotate(0deg)', offset: 0.62 },
        { opacity: 1, transform: 'scale(1) rotate(0deg)' },
      ],
      timing,
    );

    flight.onfinish = flight.oncancel = () => {
      x.remove();
      delete bubble.root.dataset.arriving;
      if (!this.bubbles.includes(bubble) || this.covered !== undefined) return;
      bubble.button.animate(
        [
          { transform: 'scale(1.24)' },
          { transform: 'scale(0.9)', offset: 0.5 },
          { transform: 'scale(1)' },
        ],
        { duration: 440, easing: 'ease-out' },
      );
      this.ring(bubble, 'var(--claude)');
    };
  }
}

function reducedMotion(): boolean {
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}
