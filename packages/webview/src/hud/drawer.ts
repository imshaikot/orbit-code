import type { AgentCatalog, SessionOptions, SessionState } from '@orbit-code/protocol';
import { Composer, type ComposerHost } from './composer';
import { button, el } from './dom';
import { dollars } from './turns';

export type DrawerToggle = 'skills' | 'history' | 'mcp';

export interface DrawerActions {
  /** Sends the prompt with the attached skills and files; false if it could not be sent. `from` is where the typed text sat, for the launch animation. */
  submit(text: string, from: DOMRect, skills: readonly string[], files: readonly string[]): boolean;
  setOptions(options: Partial<SessionOptions>): void;
  newSession(): void;
  viewConversation(): void;
  /** A toggle in the composer bar, or the MCP button, was pressed: show or hide that panel. */
  toggle(kind: DrawerToggle, from: DOMRect): void;
  /** Files was pressed: the host's open dialog picks files to attach. */
  pickFiles(): void;
  /** The prompt is a slash command being typed (`/gra`): `query` is the text after the slash, undefined once it is not. */
  slash(query: string | undefined, from: DOMRect): void;
  /** A key pressed while a slash command is being typed; true if the skills panel took it (a pick, or moving the pick). */
  slashKey(key: string): boolean;
  /** The skills attached to the prompt changed. */
  skillsChanged(names: readonly string[]): void;
  /** The sheet was put away. */
  closed(): void;
}

const MAX_INPUT_PX = 180;
const DRAG_SLOP_PX = 4;
/** Release speed that decides the direction on its own, whatever the position. */
const FLING_PX_PER_MS = 0.45;
/** A pointer that rested this long before release is not flinging. */
const FLING_STALE_MS = 90;

/**
 * The bottom edge: a tab carrying Claude's spark. A click or an upward drag opens a sheet attached to
 * the edge with the prompt composer; a click on its grabber, a downward drag or Esc puts it away.
 * Sending closes it too, while the coordinator launches the prompt into a session bubble.
 */
export class PromptDrawer implements ComposerHost {
  readonly tab = button('', 'drawer-tab');
  private readonly root = el('div', 'drawer');
  private readonly sheet = el('section', 'sheet');
  private readonly grabber = button('', 'sheet-grabber');
  private readonly contextText = el('span', 'sheet-context-text');
  private readonly view = button('View conversation', 'link-button sheet-link');
  private readonly startNew = button('New conversation', 'link-button sheet-link', 'The next prompt starts a fresh conversation');
  private readonly composer: Composer;
  private readonly historyToggle = button('', 'composer-toggle', 'Earlier conversations of this workspace');
  /** Top right of the sheet: the MCP servers, wearing the state that most needs the user. */
  private readonly mcpToggle = button('', 'composer-toggle sheet-mcp');
  private readonly mcpCount = el('span', 'sheet-mcp-count');
  /** Where the skill and history panels open, on the sheet's top edge. */
  readonly overlay = el('div', 'drawer-overlay');
  private dragged = false;

  constructor(
    host: HTMLElement,
    private readonly actions: DrawerActions,
  ) {
    const spark = el('span', 'spark');
    spark.setAttribute('aria-hidden', 'true');
    this.tab.append(spark);
    this.tab.title = 'Ask Claude: click, or drag up';
    this.tab.setAttribute('aria-label', 'Ask Claude');
    this.tab.setAttribute('aria-controls', 'orbit-sheet');

    this.sheet.id = 'orbit-sheet';
    this.sheet.setAttribute('role', 'dialog');
    this.sheet.setAttribute('aria-label', 'Ask Claude');
    this.grabber.title = 'Close: click, or drag down';
    this.grabber.setAttribute('aria-label', 'Close');

    const context = el('p', 'sheet-context');
    context.append(this.contextText, this.view, this.startNew);

    this.composer = new Composer(
      {
        send: (text, from, skills, files) => actions.submit(text, from, skills, files),
        sent: () => this.close(),
        setOptions: (options) => actions.setOptions(options),
        toggleSkills: (from) => actions.toggle('skills', from),
        pickFiles: () => actions.pickFiles(),
        slash: (query, from) => actions.slash(query, from),
        slashKey: (key) => actions.slashKey(key),
        skillsChanged: (names) => actions.skillsChanged(names),
      },
      { placeholder: 'Ask Claude about this workspace… or type / for a skill', label: 'Prompt', maxInputPx: MAX_INPUT_PX },
    );
    this.historyToggle.dataset.kind = 'history';
    this.historyToggle.setAttribute('aria-pressed', 'false');
    const gyroscope = el('span', 'composer-toggle-icon composer-toggle-history');
    gyroscope.setAttribute('aria-hidden', 'true');
    this.historyToggle.append(gyroscope, 'History');
    this.historyToggle.addEventListener('click', () => actions.toggle('history', this.historyToggle.getBoundingClientRect()));
    this.composer.addToggle(this.historyToggle);
    this.mcpToggle.dataset.kind = 'mcp';
    this.mcpToggle.dataset.state = 'none';
    this.mcpToggle.setAttribute('aria-pressed', 'false');
    this.mcpToggle.title = 'MCP servers Claude Code loads here';
    const station = el('span', 'composer-toggle-icon composer-toggle-mcp');
    station.setAttribute('aria-hidden', 'true');
    this.mcpToggle.append(station, 'MCP', this.mcpCount);
    this.mcpToggle.addEventListener('click', () => actions.toggle('mcp', this.mcpToggle.getBoundingClientRect()));

    this.sheet.append(this.grabber, this.mcpToggle, context, this.composer.element);
    this.root.append(this.overlay, this.sheet, this.tab);
    host.append(this.root);
    this.setOpen(false);
    // The panels above the sheet stand on its top edge, however tall attached skills make it.
    new ResizeObserver(() => this.root.style.setProperty('--sheet-height', `${this.sheet.offsetHeight}px`)).observe(this.sheet);

    this.tab.addEventListener('click', () => this.consumeDrag() || this.open());
    this.grabber.addEventListener('click', () => this.consumeDrag() || this.close());
    this.draggable(this.tab, true);
    this.draggable(this.grabber, false);
    this.view.addEventListener('click', () => {
      this.close();
      actions.viewConversation();
    });
    this.startNew.addEventListener('click', () => actions.newSession());
  }

  get isOpen(): boolean {
    return this.root.dataset.open === 'true';
  }

  /** Skills attached to the prompt. */
  get skills(): readonly string[] {
    return this.composer.skills;
  }

  get slashQuery(): string | undefined {
    return this.composer.slashQuery;
  }

  /** Where a session started elsewhere (the command palette) rises from. */
  origin(): DOMRect {
    return this.tab.getBoundingClientRect();
  }

  open(): void {
    this.setOpen(true);
    this.composer.focus();
  }

  close(): void {
    const hadFocus = this.sheet.contains(document.activeElement);
    const wasOpen = this.isOpen;
    this.setOpen(false);
    if (wasOpen) this.actions.closed();
    if (hadFocus) this.tab.focus({ preventScroll: true });
  }

  /** Hides the tab while the session view is open; the view has its own composer. */
  setTabHidden(hidden: boolean): void {
    this.root.dataset.tabHidden = String(hidden);
  }

  /** Puts a prompt the host never took up back into an empty composer. */
  restore(text: string): void {
    this.composer.restore(text);
  }

  setState(state: SessionState): void {
    const { phase } = state;
    this.tab.dataset.phase = phase;
    this.composer.setState(state);

    // A busy conversation is no reason to wait: the next prompt starts another one beside it.
    const busy = phase === 'working' || phase === 'stopping';
    this.contextText.dataset.level = phase === 'unavailable' ? 'warn' : '';
    this.contextText.textContent =
      phase === 'unavailable'
        ? (state.error ?? 'Claude Code is not available.')
        : busy
          ? 'Claude is still on the last prompt. This one starts a new conversation beside it.'
          : state.turns > 0
            ? `Continues this conversation: ${state.turns} ${state.turns === 1 ? 'prompt' : 'prompts'}, ${dollars(state.costUsd)}.`
            : state.sessionId
              ? 'Continues the conversation picked from History.'
              : 'Files Claude reads light up cyan. Files it edits pulse amber.';
    this.view.hidden = state.turns === 0;
    this.startNew.hidden = phase !== 'idle' || state.sessionId === undefined;
  }

  /** Models from Claude Code itself, and the MCP button's summary of its servers. Attached skills it no longer offers are dropped. */
  setCatalog(catalog: AgentCatalog): void {
    this.composer.setCatalog(catalog);
    const servers = catalog.mcpServers;
    const count = (status: string) => servers.filter((server) => server.status === status).length;
    const parts = [
      count('connected') > 0 ? `${count('connected')} connected` : '',
      count('needs-auth') > 0 ? `${count('needs-auth')} need sign-in` : '',
      count('failed') > 0 ? `${count('failed')} failed` : '',
      count('pending') > 0 ? `${count('pending')} connecting` : '',
      count('disabled') > 0 ? `${count('disabled')} disabled` : '',
    ].filter(Boolean);
    const summary = servers.length === 0 ? 'none found yet' : parts.join(', ') || `${servers.length} servers`;
    // The button wears the state that most needs the user.
    this.mcpToggle.dataset.state =
      count('failed') > 0 ? 'failed' : count('needs-auth') > 0 ? 'needs-auth' : count('pending') > 0 || catalog.mcp?.loading ? 'pending' : count('connected') > 0 ? 'connected' : 'none';
    this.mcpCount.textContent = servers.length > 0 ? `${count('connected')}/${servers.length}` : '';
    this.mcpToggle.setAttribute('aria-label', `MCP servers: ${summary}`);
    this.mcpToggle.title = [
      `MCP servers: ${summary}. Click to see them, reload them, and sign in, reconnect, enable or disable one.`,
      ...servers.map((server) => `${server.name}: ${server.status}${server.tools > 0 ? `, ${server.tools} tools` : ''}`),
    ].join('\n');
  }

  /** Which toggle in the composer bar, or the MCP button, is on. */
  setToggled(kind: DrawerToggle | undefined): void {
    this.composer.setSkillsPressed(kind === 'skills');
    for (const toggle of [this.historyToggle, this.mcpToggle]) toggle.setAttribute('aria-pressed', String(toggle.dataset.kind === kind));
  }

  /** Attaches a skill to the prompt: it pops into the row above the input. */
  attach(name: string): void {
    this.composer.attach(name);
    if (this.isOpen) this.composer.focus();
  }

  /** Attaches files to the prompt as context. */
  attachFiles(paths: readonly string[]): void {
    this.composer.attachFiles(paths);
    if (this.isOpen) this.composer.focus();
  }

  /** Where a dragged skill is dropped: anywhere on the composer, while the sheet is open. */
  dropRect(): DOMRect | undefined {
    return this.isOpen ? this.composer.dropRect() : undefined;
  }

  setDropState(state: 'ready' | 'over' | undefined): void {
    this.composer.setDropState(state);
  }

  private setOpen(open: boolean): void {
    this.root.dataset.open = String(open);
    this.tab.setAttribute('aria-expanded', String(open));
    this.sheet.setAttribute('aria-hidden', String(!open));
  }

  /** True once after a drag, so the click that ends it does not toggle the sheet back. */
  private consumeDrag(): boolean {
    const dragged = this.dragged;
    this.dragged = false;
    return dragged;
  }

  /** The sheet follows the pointer; on release, speed decides, else whether it is more than half open. */
  private draggable(handle: HTMLElement, fromClosed: boolean): void {
    handle.addEventListener('pointerdown', (down) => {
      if (down.button !== 0 || fromClosed === this.isOpen) return;
      const height = this.sheet.offsetHeight;
      const base = fromClosed ? height : 0;
      let offset = base;
      let moved = false;
      let lastY = down.clientY;
      let lastT = down.timeStamp;
      let velocity = 0;
      handle.setPointerCapture(down.pointerId);

      const move = (event: PointerEvent) => {
        const dy = event.clientY - down.clientY;
        if (!moved) {
          if (Math.abs(dy) < DRAG_SLOP_PX) return;
          moved = true;
          this.root.dataset.dragging = 'true';
        }
        const dt = event.timeStamp - lastT;
        if (dt > 0) velocity = 0.6 * velocity + 0.4 * ((event.clientY - lastY) / dt);
        lastY = event.clientY;
        lastT = event.timeStamp;
        const raw = base + dy;
        offset = raw < 0 ? -stretch(-raw) : Math.min(raw, height);
        this.sheet.style.setProperty('--sheet-offset', `${offset}px`);
      };
      const end = (event: PointerEvent) => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', end);
        handle.removeEventListener('pointercancel', end);
        if (!moved) return;
        this.dragged = true;
        setTimeout(() => (this.dragged = false), 0);
        if (event.timeStamp - lastT > FLING_STALE_MS) velocity = 0;
        delete this.root.dataset.dragging;
        this.sheet.style.removeProperty('--sheet-offset');
        const open = velocity < -FLING_PX_PER_MS || (velocity <= FLING_PX_PER_MS && offset < height / 2);
        if (open) this.open();
        else this.close();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
    });
  }
}

/** Past the open position the sheet gives a little, less the further it is pulled. */
function stretch(px: number): number {
  return 28 * Math.log1p(px / 28);
}
