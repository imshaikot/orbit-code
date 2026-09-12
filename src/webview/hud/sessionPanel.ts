import type { AgentCatalog, ConversationSummary, HistorySnapshot, PermissionAnswer, SessionOptions, SessionState, SessionsSnapshot, TranscriptEntry } from '../../shared/protocol';
import { type ClaudeBubble, ClaudeBubbles } from './claudeBubbles';
import { Constellation } from './constellation';
import { type DrawerToggle, PromptDrawer } from './drawer';
import { HistoryPanel } from './historyPanel';
import { SessionView } from './sessionView';
import { type Turn, promptLine } from './turns';

export interface SessionActions {
  /** `key`: the conversation to continue; without one the host continues the current conversation, or starts one beside a busy one. */
  prompt(text: string, skills: readonly string[], key?: string): void;
  interrupt(key: string): void;
  newSession(): void;
  setOptions(options: Partial<SessionOptions>): void;
  answerPermission(key: string, id: string, answer: PermissionAnswer): void;
  openFile(path: string): void;
  refreshCatalog(): void;
  loadHistory(): void;
  resumeConversation(id: string): void;
}

/** Turns remembered per conversation for bubbles and the view's header; the transcript itself is bounded by the view. */
const MAX_TURNS = 100;

/** Before the host has said anything. */
const NO_SESSION: SessionState = { key: '', phase: 'unavailable', options: { model: '', effort: '', permissionMode: 'default' }, turns: 0, costUsd: 0, error: 'Looking for Claude Code' };

/** One conversation as the HUD keeps it: the host's latest state and its turns. */
interface Conversation {
  state: SessionState;
  readonly turns: Turn[];
}

/**
 * Claude in the HUD, kept off the graph until it is wanted. The drawer at the bottom edge holds the
 * composer; a sent prompt becomes a session bubble at the bottom left that pulses while Claude works and
 * leaves when it is done; a bubble opens into the session view. Several conversations run at once, each
 * with its own bubbles and transcript; the drawer continues the current one, or starts another beside it
 * while it is busy. This class splits host state and the transcripts into sessions (turns) and keeps the
 * three in step.
 */
export class SessionPanel {
  private readonly bubbles: ClaudeBubbles;
  private readonly view: SessionView;
  private readonly drawer: PromptDrawer;
  private readonly constellation: Constellation;
  private readonly history: HistoryPanel;
  private readonly conversations = new Map<string, Conversation>();
  /** The conversation the drawer continues, as the host names it. */
  private current: string | undefined;
  /** What the open view came out of: a bubble, or null for the conversation opened from the drawer. */
  private opened: ClaudeBubble | null | undefined;
  /** The skills panel was opened by a slash typed in the composer, so it goes when the slash does. */
  private slashOpened = false;
  /** Esc closed the panel the slash opened; it stays closed until the slash is gone and typed again. */
  private slashDismissed = false;
  private slashQuery: string | undefined;

  constructor(
    host: HTMLElement,
    private readonly actions: SessionActions,
    wake: () => void,
  ) {
    this.bubbles = new ClaudeBubbles(host, {
      open: (bubble) => this.openView(bubble),
      abandoned: (prompt) => this.drawer.restore(prompt),
    });
    this.view = new SessionView(host, {
      prompt: (text, key) => this.reply(text, key),
      interrupt: (key) => actions.interrupt(key),
      answerPermission: (key, id, answer) => actions.answerPermission(key, id, answer),
      openFile: (path) => actions.openFile(path),
      close: () => this.closeView(),
    });
    this.drawer = new PromptDrawer(host, {
      submit: (text, from, skills) => this.launch(text, from, skills),
      setOptions: (options) => actions.setOptions(options),
      newSession: () => actions.newSession(),
      viewConversation: () => this.openView(null),
      toggle: (kind, from) => this.toggle(kind, from),
      slash: (query, from) => this.slash(query, from),
      slashKey: (key) => this.slashKey(key),
      skillsChanged: (names) => this.constellation.setAttached(names),
      closed: () => this.constellation.close(),
    });
    this.constellation = new Constellation(this.drawer.overlay, host, {
      attach: (name) => this.drawer.attach(name),
      dropTarget: () => this.drawer.dropRect(),
      dragState: (state) => this.drawer.setDropState(state),
      openConversation: (conversation, origin) => this.openHistory(conversation, origin),
      refresh: (mode) => (mode === 'skills' ? actions.refreshCatalog() : actions.loadHistory()),
      openFile: (path) => actions.openFile(path),
      closed: () => {
        this.drawer.setToggled(undefined);
        // Closed by anything but the slash going away (Esc, the close button, a toggle): the slash still typed does not reopen it.
        if (this.slashOpened && this.slashQuery !== undefined) this.slashDismissed = true;
        this.slashOpened = false;
      },
      wake,
    });
    this.history = new HistoryPanel(host, {
      resume: (id) => this.resume(id),
      openFile: (path) => actions.openFile(path),
      close: () => this.closeHistory(),
    });

    // Esc puts away what Claude has open before it moves the graph view: capturing on window runs ahead of Interaction,
    // wherever focus is (after Allow hides the permission card, focus is on the body). A skill being dragged goes back first.
    window.addEventListener(
      'keydown',
      (event) => {
        if (event.key !== 'Escape') return;
        if (this.constellation.cancelDrag()) {
          // Nothing else closes on the same key.
        } else if (this.view.isOpen) this.closeView();
        else if (this.history.isOpen) this.closeHistory();
        else if (this.constellation.mode) this.constellation.close();
        else if (this.drawer.isOpen) this.drawer.close();
        else return;
        event.stopPropagation();
      },
      true,
    );

    this.syncCurrent();
  }

  /** Whether any conversation has a turn running. */
  get anyWorking(): boolean {
    return [...this.conversations.values()].some(({ state }) => state.phase === 'working' || state.phase === 'stopping');
  }

  /** Every conversation the host has, and which one the drawer continues; conversations no longer listed go, bubbles and transcript included. */
  setSessions({ states, current }: SessionsSnapshot): void {
    const kept = new Set(states.map((state) => state.key));
    for (const key of [...this.conversations.keys()]) if (!kept.has(key)) this.forget(key);
    this.current = current;
    for (const state of states) this.setState(state);
    this.syncCurrent();
  }

  /** One conversation's state. */
  setState(state: SessionState): void {
    this.conversation(state.key).state = state;
    // A turn started elsewhere (Orbit Code: Ask Claude…) rises from the drawer tab; one launched from the composer is claimed below.
    if ((state.phase === 'working' || state.phase === 'stopping') && !this.bubbles.live(state.key) && !this.bubbles.pendingLaunch) {
      const last = this.conversation(state.key).turns.at(-1);
      if (last && !last.end) this.bubbles.restore(last);
      else this.bubbles.launch(undefined, this.drawer.origin(), false, state.key);
    }
    this.bubbles.setState(state);
    this.view.setState(state);
    if (state.key === this.current) this.syncCurrent();
  }

  /** The drawer, the history panel and the constellation follow the current conversation. */
  private syncCurrent(): void {
    const state = this.currentState;
    this.drawer.setState(state);
    this.history.setState(state);
    this.constellation.setConversation(state.sessionId);
    if (this.current !== undefined) this.view.setCurrent(this.current);
  }

  private get currentState(): SessionState {
    return (this.current === undefined ? undefined : this.conversations.get(this.current)?.state) ?? NO_SESSION;
  }

  private conversation(key: string): Conversation {
    let conversation = this.conversations.get(key);
    if (!conversation) {
      conversation = { state: { ...NO_SESSION, key }, turns: [] };
      this.conversations.set(key, conversation);
    }
    return conversation;
  }

  /** The conversation `key` is gone: its bubbles, its transcript, and the view if it was showing it. */
  private forget(key: string): void {
    if (this.view.key === key) this.closeView();
    this.bubbles.forget(key);
    this.view.forget(key);
    this.conversations.delete(key);
  }

  setCatalog(catalog: AgentCatalog): void {
    this.drawer.setCatalog(catalog);
    this.constellation.setCatalog(catalog);
  }

  setHistory(history: HistorySnapshot): void {
    this.constellation.setHistory(history);
    this.history.update(history.conversations);
  }

  /** Renders the constellation, if open. True while it needs frames. */
  frame(dt: number): boolean {
    return this.constellation.frame(dt);
  }

  /** Read by scripts/harness.mjs. */
  get constellationState(): Constellation['debug'] {
    return this.constellation.debug;
  }

  /** The transcript of the conversation `key` grew, or starts over (a reloaded webview, a conversation continued from History). */
  appendTranscript(key: string, reset: boolean, entries: readonly TranscriptEntry[]): void {
    this.view.appendTranscript(key, reset, entries);
    const { turns, state } = this.conversation(key);
    if (reset) {
      turns.length = 0;
      this.bubbles.clear(key);
      if (this.opened && this.view.key === key) {
        this.opened = null;
        this.view.follow(undefined);
      }
    }

    for (const entry of entries) {
      if (entry.kind === 'prompt') {
        const turn: Turn = { key, id: entry.id, prompt: entry.text, skills: entry.skills, startedAt: Date.now(), end: undefined, lastTool: undefined, replying: false };
        turns.push(turn);
        if (turns.length > MAX_TURNS) turns.splice(0, turns.length - MAX_TURNS);
        if (reset) continue;
        const bubble = this.bubbles.bind(turn, this.drawer.origin());
        if (bubble === this.opened) this.view.follow(turn);
        continue;
      }
      const turn = turns.at(-1);
      if (!turn || turn.end) continue;
      if (entry.kind === 'tool') {
        turn.lastTool = entry;
        turn.replying = false;
      } else if (entry.kind === 'text') {
        turn.replying = true;
      } else if (entry.kind === 'turn') {
        turn.end = entry;
      }
      if (reset) continue;
      if (entry.kind === 'turn') this.bubbles.finish(turn);
      else this.bubbles.update(turn, entry.kind === 'tool' ? (entry.mcp ? 'mcp' : entry.action) : undefined);
    }

    const last = turns.at(-1);
    const phase = state.phase;
    if (reset && last && !last.end && (phase === 'working' || phase === 'stopping')) this.bubbles.restore(last);
    this.view.refresh();
  }

  /**
   * From the drawer: the prompt goes to the host and flies out of the composer into a new bubble. The host continues
   * the current conversation, or starts one beside it while it is busy; the bubble learns which when that one starts working.
   */
  private launch(text: string, from: DOMRect, skills: readonly string[]): boolean {
    if (this.currentState.phase === 'unavailable') return false;
    if (this.view.isOpen) this.closeView();
    if (this.history.isOpen) this.closeHistory();
    this.actions.prompt(text, skills);
    this.bubbles.launch(promptLine(text, skills), from, true);
    return true;
  }

  /** A toggle in the composer bar: opens its panel, switches to it from the other one, or closes it. */
  private toggle(kind: DrawerToggle, from: DOMRect): void {
    if (this.constellation.mode === kind) {
      this.constellation.close();
      return;
    }
    // History is read from disk each time it is opened; conversations change while Orbit runs.
    if (kind === 'history') this.actions.loadHistory();
    this.constellation.open(kind, from);
    this.drawer.setToggled(kind);
    this.slashOpened = false;
    if (kind === 'skills') this.constellation.setFilter(this.slashQuery ?? '');
  }

  /**
   * A slash command typed in the composer: the skills panel opens over the sheet, narrowed to what was typed, and goes
   * away once the text is no longer just a command (a space, or the slash deleted). Its skills stay visible while typing.
   */
  private slash(query: string | undefined, from: DOMRect): void {
    this.slashQuery = query;
    if (query === undefined) {
      this.slashDismissed = false;
      if (this.slashOpened) {
        this.slashOpened = false;
        this.constellation.close();
      } else if (this.constellation.mode === 'skills') {
        this.constellation.setFilter('');
      }
      return;
    }
    if (this.constellation.mode !== 'skills') {
      if (this.slashDismissed) return;
      this.constellation.open('skills', from);
      this.drawer.setToggled('skills');
      this.slashOpened = true;
    }
    this.constellation.setFilter(query);
  }

  /** Enter or Tab attaches the picked skill in place of the typed command; the arrows move the pick. */
  private slashKey(key: string): boolean {
    if (this.constellation.mode !== 'skills') return false;
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      this.constellation.moveHighlight(key === 'ArrowDown' ? 1 : -1);
      return true;
    }
    const name = this.constellation.highlightedSkill();
    if (!name) return false;
    this.drawer.attach(name);
    return true;
  }

  /** Out of a conversation's glyph: the drawer and its panel go away, the history panel opens where the session view would. */
  private openHistory(conversation: ConversationSummary, origin: DOMRect): void {
    if (this.view.isOpen) this.closeView();
    this.drawer.close();
    this.drawer.setTabHidden(true);
    this.bubbles.cover(null);
    this.history.open(conversation, origin);
  }

  private closeHistory(): void {
    if (!this.history.isOpen) return;
    this.history.close();
    this.bubbles.uncover();
    this.drawer.setTabHidden(false);
  }

  /** Continue an earlier conversation: the host resets the transcript, and the drawer opens for the next prompt. */
  private resume(id: string): void {
    this.actions.resumeConversation(id);
    this.closeHistory();
    this.drawer.open();
  }

  /** From the open view: the conversation continues in place, and the new session's bubble waits under the view. */
  private reply(text: string, key: string): boolean {
    if (this.conversations.get(key)?.state.phase !== 'idle') return false;
    this.actions.prompt(text, [], key);
    const bubble = this.bubbles.launch(text, undefined, false, key);
    this.opened = bubble;
    this.bubbles.cover(bubble);
    this.view.follow({ key, id: -1, prompt: text, startedAt: Date.now(), end: undefined, lastTool: undefined, replying: false });
    return true;
  }

  /** A bubble opens its conversation; the drawer's View conversation (null) opens the current one. */
  private openView(bubble: ClaudeBubble | null): void {
    const key = bubble?.key ?? this.current;
    if (key === undefined) return;
    if (this.history.isOpen) this.closeHistory();
    if (this.drawer.isOpen) this.drawer.close();
    this.drawer.setTabHidden(true);
    const origin = bubble?.button.getBoundingClientRect();
    this.opened = bubble;
    this.bubbles.cover(bubble);
    const turn = bubble ? (bubble.turn ?? { key, id: -1, prompt: bubble.prompt ?? 'Claude session', startedAt: bubble.startedAt, end: undefined, lastTool: undefined, replying: false }) : undefined;
    this.view.open(turn, origin, key);
  }

  private closeView(): void {
    const bubble = this.opened;
    const hadFocus = document.activeElement instanceof HTMLElement && document.activeElement.closest('.session-view') !== null;
    this.view.close(bubble?.button.getBoundingClientRect());
    this.opened = undefined;
    this.bubbles.uncover();
    this.drawer.setTabHidden(false);
    if (!hadFocus) return;
    if (bubble && !bubble.ended) bubble.button.focus({ preventScroll: true });
    else this.drawer.tab.focus({ preventScroll: true });
  }
}
