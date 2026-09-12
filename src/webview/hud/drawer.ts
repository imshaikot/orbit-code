import type { AgentCatalog, PermissionMode, SessionOptions, SessionState } from '../../shared/protocol';
import { button, el } from './dom';
import { EffortMeter } from './effortMeter';
import { dollars } from './turns';

export type DrawerToggle = 'skills' | 'history';

export interface DrawerActions {
  /** Sends the prompt with the attached skills; false if it could not be sent. `from` is where the typed text sat, for the launch animation. */
  submit(text: string, from: DOMRect, skills: readonly string[]): boolean;
  setOptions(options: Partial<SessionOptions>): void;
  newSession(): void;
  viewConversation(): void;
  /** A toggle in the composer bar was pressed: show or hide that panel. */
  toggle(kind: DrawerToggle, from: DOMRect): void;
  /** The prompt is a slash command being typed (`/gra`): `query` is the text after the slash, undefined once it is not. */
  slash(query: string | undefined, from: DOMRect): void;
  /** A key pressed while a slash command is being typed; true if the skills panel took it (a pick, or moving the pick). */
  slashKey(key: string): boolean;
  /** The skills attached to the prompt changed. */
  skillsChanged(names: readonly string[]): void;
  /** The sheet was put away. */
  closed(): void;
}

type Choice = readonly [value: string, label: string];

const MAX_INPUT_PX = 180;
const DRAG_SLOP_PX = 4;
/** Release speed that decides the direction on its own, whatever the position. */
const FLING_PX_PER_MS = 0.45;
/** A pointer that rested this long before release is not flinging. */
const FLING_STALE_MS = 90;
/** Until Claude Code has said which models it offers (the catalog), the aliases every version knows. */
const FALLBACK_MODELS: readonly Choice[] = [
  ['', 'Default model'],
  ['opus', 'Opus'],
  ['sonnet', 'Sonnet'],
  ['haiku', 'Haiku'],
];
/** Skills one prompt can carry; the host takes no more. */
const MAX_SKILLS = 8;
const MODE_LABELS: Record<PermissionMode, string> = {
  default: 'Ask before edits',
  acceptEdits: 'Accept edits',
  plan: 'Plan only',
  bypassPermissions: 'Bypass permissions',
};
/** bypassPermissions can only be set in VS Code settings, so it is listed only while it is active. */
const PICKABLE_MODES: readonly PermissionMode[] = ['default', 'acceptEdits', 'plan'];

/**
 * The bottom edge: a tab carrying Claude's spark. A click or an upward drag opens a sheet attached to
 * the edge with the prompt composer; a click on its grabber, a downward drag or Esc puts it away.
 * Sending closes it too, while the coordinator launches the prompt into a session bubble.
 */
export class PromptDrawer {
  readonly tab = button('', 'drawer-tab');
  private readonly root = el('div', 'drawer');
  private readonly sheet = el('section', 'sheet');
  private readonly grabber = button('', 'sheet-grabber');
  private readonly contextText = el('span', 'sheet-context-text');
  private readonly view = button('View conversation', 'link-button sheet-link');
  private readonly startNew = button('New conversation', 'link-button sheet-link', 'The next prompt starts a fresh conversation');
  private readonly input = el('textarea', 'composer-input');
  private readonly model = el('select', 'composer-select');
  private readonly mode = el('select', 'composer-select');
  private readonly effort = new EffortMeter((effort) => this.actions.setOptions({ effort }));
  private readonly action = el('button', 'button primary composer-action', 'Send');
  private readonly form = el('form', 'composer');
  private readonly chips = el('div', 'composer-skills');
  private readonly skillsToggle = button('', 'composer-toggle', 'Skills Claude Code offers here: drag one onto the prompt to attach it');
  private readonly historyToggle = button('', 'composer-toggle', 'Earlier conversations of this workspace');
  private readonly mcp = el('span', 'sheet-mcp');
  /** Where the skill and history panels open, on the sheet's top edge. */
  readonly overlay = el('div', 'drawer-overlay');
  private attached: string[] = [];
  private catalog: AgentCatalog | undefined;
  private state: SessionState | undefined;
  private dragged = false;
  /** The slash command being typed, as last told to the coordinator. */
  private slash: string | undefined;

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
    context.append(this.contextText, this.mcp, this.view, this.startNew);
    this.mcp.hidden = true;

    const form = this.form;
    this.input.rows = 1;
    this.input.placeholder = 'Ask Claude about this workspace… or type / for a skill';
    this.input.setAttribute('aria-label', 'Prompt');
    this.model.setAttribute('aria-label', 'Model');
    this.mode.setAttribute('aria-label', 'Permission mode');
    this.mode.title = 'What Claude may do without asking';
    this.action.type = 'submit';
    this.chips.hidden = true;
    this.chips.setAttribute('aria-label', 'Skills attached to the prompt');
    const toggles = [
      [this.skillsToggle, 'skills', 'Skills'],
      [this.historyToggle, 'history', 'History'],
    ] as const;
    for (const [toggle, kind, label] of toggles) {
      toggle.dataset.kind = kind;
      toggle.setAttribute('aria-pressed', 'false');
      const icon = el('span', `composer-toggle-icon composer-toggle-${kind}`);
      icon.setAttribute('aria-hidden', 'true');
      toggle.append(icon, label);
      toggle.addEventListener('click', () => actions.toggle(kind, toggle.getBoundingClientRect()));
    }
    const bar = el('div', 'composer-bar');
    bar.append(this.skillsToggle, this.historyToggle, this.model, this.effort.element, this.mode, this.action);
    form.append(this.chips, this.input, bar);

    this.sheet.append(this.grabber, context, form);
    this.root.append(this.overlay, this.sheet, this.tab);
    host.append(this.root);
    this.setOpen(false);
    // The panels above the sheet stand on its top edge, however tall attached skills make it.
    new ResizeObserver(() => this.root.style.setProperty('--sheet-height', `${this.sheet.offsetHeight}px`)).observe(this.sheet);

    this.tab.addEventListener('click', () => this.consumeDrag() || this.open());
    this.grabber.addEventListener('click', () => this.consumeDrag() || this.close());
    this.draggable(this.tab, true);
    this.draggable(this.grabber, false);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      this.send();
    });
    this.input.addEventListener('keydown', (event) => {
      if (event.isComposing) return;
      // While a slash command is being typed, the skills panel takes Enter, Tab and the arrows: a pick, or moving it.
      if (this.slash !== undefined && ['Enter', 'Tab', 'ArrowDown', 'ArrowUp'].includes(event.key) && !event.shiftKey && actions.slashKey(event.key)) {
        event.preventDefault();
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        this.send();
      }
    });
    this.input.addEventListener('input', () => {
      this.autosize();
      this.refreshAction();
      this.refreshSlash();
    });
    this.view.addEventListener('click', () => {
      this.close();
      actions.viewConversation();
    });
    this.startNew.addEventListener('click', () => actions.newSession());
    this.model.addEventListener('change', () => actions.setOptions({ model: this.model.value }));
    this.mode.addEventListener('change', () => actions.setOptions({ permissionMode: this.mode.value as PermissionMode }));
  }

  get isOpen(): boolean {
    return this.root.dataset.open === 'true';
  }

  /** Where a session started elsewhere (the command palette) rises from. */
  origin(): DOMRect {
    return this.tab.getBoundingClientRect();
  }

  open(): void {
    this.setOpen(true);
    this.input.focus({ preventScroll: true });
  }

  close(): void {
    const hadFocus = this.sheet.contains(document.activeElement);
    const wasOpen = this.isOpen;
    this.setOpen(false);
    if (wasOpen) this.actions.closed();
    if (hadFocus) this.tab.focus({ preventScroll: true });
  }

  /** Hides the tab while the session view is open; the view has its own reply box. */
  setTabHidden(hidden: boolean): void {
    this.root.dataset.tabHidden = String(hidden);
  }

  /** Puts a prompt the host never took up back into an empty composer. */
  restore(text: string): void {
    if (this.input.value.trim()) return;
    this.input.value = text;
    this.autosize();
    this.refreshAction();
    this.refreshSlash();
  }

  setState(state: SessionState): void {
    this.state = state;
    const { phase } = state;
    this.tab.dataset.phase = phase;
    this.input.disabled = this.model.disabled = this.mode.disabled = phase === 'unavailable';
    this.effort.setDisabled(phase === 'unavailable');
    this.syncModels();
    const modes = PICKABLE_MODES.includes(state.options.permissionMode) ? PICKABLE_MODES : [...PICKABLE_MODES, state.options.permissionMode];
    syncSelect(
      this.mode,
      modes.map((mode) => [mode, MODE_LABELS[mode]] as const),
      state.options.permissionMode,
    );

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
    this.refreshAction();
  }

  /** Models from Claude Code itself, and a line on its MCP servers. Attached skills it no longer offers are dropped. */
  setCatalog(catalog: AgentCatalog): void {
    this.catalog = catalog;
    this.syncModels();
    const servers = catalog.mcpServers;
    const count = (status: string) => servers.filter((server) => server.status === status).length;
    const parts = [
      count('connected') > 0 ? `${count('connected')} connected` : '',
      count('needs-auth') > 0 ? `${count('needs-auth')} need sign-in` : '',
      count('failed') > 0 ? `${count('failed')} failed` : '',
      count('pending') > 0 ? `${count('pending')} connecting` : '',
    ].filter(Boolean);
    this.mcp.hidden = servers.length === 0;
    this.mcp.textContent = `MCP: ${parts.join(', ') || `${servers.length} servers`}`;
    this.mcp.title = servers.map((server) => `${server.name}: ${server.status}${server.tools > 0 ? `, ${server.tools} tools` : ''}`).join('\n');
    const offered = new Set(catalog.skills.map((skill) => skill.name));
    if (catalog.known && this.attached.some((name) => !offered.has(name))) {
      this.attached = this.attached.filter((name) => offered.has(name));
      this.renderChips();
    }
  }

  /** Which toggle in the composer bar is on. */
  setToggled(kind: DrawerToggle | undefined): void {
    for (const toggle of [this.skillsToggle, this.historyToggle]) toggle.setAttribute('aria-pressed', String(toggle.dataset.kind === kind));
  }

  /** Attaches a skill to the prompt: it pops into the row above the input. A slash command being typed is what it stands for, so that goes. */
  attach(name: string): void {
    if (slashQuery(this.input.value) !== undefined) {
      this.input.value = '';
      this.autosize();
      this.refreshAction();
      this.refreshSlash();
    }
    if (!this.attached.includes(name) && this.attached.length < MAX_SKILLS) {
      this.attached = [...this.attached, name];
      this.renderChips();
      const chip = this.chips.lastElementChild;
      if (chip && !reducedMotion()) {
        chip.animate(
          [
            { transform: 'scale(0.3)', opacity: 0 },
            { transform: 'scale(1.1)', opacity: 1, offset: 0.6 },
            { transform: 'none', opacity: 1 },
          ],
          { duration: 440, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)' },
        );
      }
    }
    if (this.isOpen) this.input.focus({ preventScroll: true });
  }

  detach(name: string): void {
    this.attached = this.attached.filter((attached) => attached !== name);
    this.renderChips();
    this.input.focus({ preventScroll: true });
  }

  /** Where a dragged skill is dropped: anywhere on the composer, while the sheet is open. */
  dropRect(): DOMRect | undefined {
    return this.isOpen ? this.form.getBoundingClientRect() : undefined;
  }

  setDropState(state: 'ready' | 'over' | undefined): void {
    if (state) this.form.dataset.drop = state;
    else delete this.form.dataset.drop;
  }

  private send(): void {
    const text = this.input.value.trim();
    if ((!text && this.attached.length === 0) || !this.state || this.state.phase === 'unavailable') return;
    if (!this.actions.submit(text, this.input.getBoundingClientRect(), [...this.attached])) return;
    this.input.value = '';
    this.attached = [];
    this.renderChips();
    this.autosize();
    this.refreshAction();
    this.refreshSlash();
    this.close();
  }

  /** Tells the coordinator when the prompt becomes, changes as, or stops being a slash command. */
  private refreshSlash(): void {
    const query = slashQuery(this.input.value);
    if (query === this.slash) return;
    this.slash = query;
    this.actions.slash(query, this.input.getBoundingClientRect());
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

  private refreshAction(): void {
    this.action.disabled = !this.state || this.state.phase === 'unavailable' || (this.input.value.trim() === '' && this.attached.length === 0);
  }

  /** The models Claude Code offers, else the fallback aliases; a setting naming another model is listed too. The effort meter offers what the selected model takes. */
  private syncModels(): void {
    const offered = this.catalog?.known && this.catalog.models.length > 0 ? this.catalog.models.map((model) => [model.value, model.label] as const) : FALLBACK_MODELS;
    syncSelect(this.model, offered, this.state?.options.model ?? '');
    const choice = this.catalog?.known ? this.catalog.models.find((model) => model.value === this.model.value) : undefined;
    this.model.title = choice?.description ?? 'Model';
    this.effort.set(this.state?.options.effort ?? '', choice?.label ?? this.model.value, choice?.efforts);
  }

  private renderChips(): void {
    this.chips.replaceChildren(
      ...this.attached.map((name) => {
        const chip = el('span', 'skill-chip');
        chip.dataset.skill = name;
        const icon = el('span', 'skill-chip-icon');
        icon.setAttribute('aria-hidden', 'true');
        const remove = button('', 'skill-chip-remove', `Detach /${name}`);
        remove.setAttribute('aria-label', `Detach /${name}`);
        remove.addEventListener('click', () => this.detach(name));
        chip.append(icon, el('span', 'skill-chip-name', `/${name}`), remove);
        return chip;
      }),
    );
    this.chips.hidden = this.attached.length === 0;
    this.actions.skillsChanged([...this.attached]);
    this.refreshAction();
  }

  private autosize(): void {
    this.input.style.height = 'auto';
    this.input.style.height = `${Math.min(this.input.scrollHeight, MAX_INPUT_PX)}px`;
  }
}

function reducedMotion(): boolean {
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** The text after a leading slash while nothing but the command has been typed (`/gra` → `gra`); undefined otherwise. */
export function slashQuery(text: string): string | undefined {
  const match = /^\s*\/(\S*)$/.exec(text);
  return match ? match[1] : undefined;
}

/** Past the open position the sheet gives a little, less the further it is pulled. */
function stretch(px: number): number {
  return 28 * Math.log1p(px / 28);
}

function syncSelect(select: HTMLSelectElement, choices: readonly Choice[], value: string): void {
  const all = choices.some(([choice]) => choice === value) ? choices : [...choices, [value, value] as const];
  const signature = all.map(([choice, label]) => `${choice}=${label}`).join('|');
  if (select.dataset.signature !== signature) {
    select.replaceChildren(
      ...all.map(([choice, label]) => {
        const option = el('option', undefined, label);
        option.value = choice;
        return option;
      }),
    );
    select.dataset.signature = signature;
  }
  select.value = value;
}
