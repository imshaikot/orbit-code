import type { AgentCatalog, PermissionMode, SessionOptions, SessionState } from '@orbit-code/protocol';
import type { ConstellationMode } from './constellation';
import { button, el } from './dom';
import { EffortMeter } from './effortMeter';
import { fileName } from './turns';

export interface ComposerActions {
  /** Enter or Send, with something written or attached; false if it was not taken, and the composer keeps all of it. `from` is where the typed text sat. */
  send(text: string, from: DOMRect, skills: readonly string[], files: readonly string[]): boolean;
  /** What was sent has left the composer. */
  sent(): void;
  /**
   * Given, the composer belongs to one conversation: while it works, Stop takes Send's place and calls this, and what is
   * written, attached or picked meanwhile waits for the turn to end. Without it a working conversation changes nothing,
   * because the host starts another beside it.
   */
  stop?(): void;
  setOptions(options: Partial<SessionOptions>): void;
  /** The Skills toggle was pressed. */
  toggleSkills(from: DOMRect): void;
  /** Files was pressed: the host's open dialog picks files to attach. */
  pickFiles(): void;
  /** The prompt is a slash command being typed (`/gra`): `query` is the text after the slash, undefined once it is not. */
  slash(query: string | undefined, from: DOMRect): void;
  /** A key pressed while a slash command is being typed; true if the skills panel took it (a pick, or moving the pick). */
  slashKey(key: string): boolean;
  /** The skills attached to the prompt changed. */
  skillsChanged(names: readonly string[]): void;
}

export interface ComposerOptions {
  placeholder: string;
  /** The input's accessible name. */
  label: string;
  /** Tallest the input grows, in CSS pixels. */
  maxInputPx: number;
}

/** A panel holding a composer, as the skills panel sees it: where the panel opens, and what a skill is attached to. */
export interface ComposerHost {
  /** Where the skills panel opens, standing on the composer. */
  readonly overlay: HTMLElement;
  /** Skills attached to the prompt. */
  readonly skills: readonly string[];
  /** The slash command being typed in the composer, if any. */
  readonly slashQuery: string | undefined;
  attach(name: string): void;
  /** Where a dragged skill can be dropped, while the composer is on show. */
  dropRect(): DOMRect | undefined;
  setDropState(state: 'ready' | 'over' | undefined): void;
  /** Which of its toggles is on. */
  setToggled(kind: ConstellationMode | undefined): void;
}

type Choice = readonly [value: string, label: string];

/** Until Claude Code has said which models it offers (the catalog), the aliases every version knows. */
const FALLBACK_MODELS: readonly Choice[] = [
  ['', 'Default model'],
  ['opus', 'Opus'],
  ['sonnet', 'Sonnet'],
  ['haiku', 'Haiku'],
];
/** Skills one prompt can carry; the host takes no more. */
const MAX_SKILLS = 8;
/** Files one prompt can carry; the host takes no more. */
const MAX_FILES = 20;
const MODE_LABELS: Record<PermissionMode, string> = {
  default: 'Ask before edits',
  acceptEdits: 'Accept edits',
  plan: 'Plan only',
  bypassPermissions: 'Bypass permissions',
};
/** bypassPermissions can only be set in VS Code settings, so it is listed only while it is active. */
const PICKABLE_MODES: readonly PermissionMode[] = ['default', 'acceptEdits', 'plan'];

/**
 * A prompt composer: the skills and files attached to the prompt as chips above the input, and a bar of Files, Skills,
 * the model, the effort meter, the permission mode and Send. The drawer's sheet holds one; the session view holds another
 * for replies to its conversation.
 */
export class Composer {
  readonly element = el('form', 'composer');
  private readonly input = el('textarea', 'composer-input');
  private readonly model = el('select', 'composer-select');
  private readonly mode = el('select', 'composer-select');
  private readonly effort = new EffortMeter((effort) => this.actions.setOptions({ effort }));
  private readonly action = el('button');
  private readonly chips = el('div', 'composer-skills');
  private readonly skillsToggle = button('', 'composer-toggle', 'Skills Claude Code offers here: drag one onto the prompt to attach it');
  private readonly filesToggle = button('', 'composer-toggle', 'Attach files for Claude to read with the prompt');
  private attached: string[] = [];
  /** Files attached to the prompt: workspace ids, or absolute paths outside the workspace. */
  private files: string[] = [];
  private catalog: AgentCatalog | undefined;
  private state: SessionState | undefined;
  /** The slash command being typed, as last told to the coordinator. */
  private slash: string | undefined;

  constructor(
    private readonly actions: ComposerActions,
    private readonly options: ComposerOptions,
  ) {
    const { element: form, input } = this;
    input.rows = 1;
    input.placeholder = options.placeholder;
    input.setAttribute('aria-label', options.label);
    this.model.setAttribute('aria-label', 'Model');
    this.mode.setAttribute('aria-label', 'Permission mode');
    this.mode.title = 'What Claude may do without asking';
    this.action.type = 'submit';
    this.chips.hidden = true;
    this.chips.setAttribute('aria-label', 'Skills and files attached to the prompt');
    const toggles = [
      [this.filesToggle, 'files', 'Files'],
      [this.skillsToggle, 'skills', 'Skills'],
    ] as const;
    for (const [toggle, kind, label] of toggles) {
      toggle.dataset.kind = kind;
      const icon = el('span', `composer-toggle-icon composer-toggle-${kind}`);
      icon.setAttribute('aria-hidden', 'true');
      toggle.append(icon, label);
    }
    this.skillsToggle.setAttribute('aria-pressed', 'false');
    this.skillsToggle.addEventListener('click', () => actions.toggleSkills(this.skillsToggle.getBoundingClientRect()));
    this.filesToggle.addEventListener('click', () => actions.pickFiles());
    const bar = el('div', 'composer-bar');
    bar.append(this.filesToggle, this.skillsToggle, this.model, this.effort.element, this.mode, this.action);
    form.append(this.chips, input, bar);
    this.refreshAction();

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (this.stops) actions.stop?.();
      else this.send();
    });
    input.addEventListener('keydown', (event) => {
      if (event.isComposing) return;
      // While a slash command is being typed, the skills panel takes Enter, Tab and the arrows: a pick, or moving it.
      if (this.slash !== undefined && ['Enter', 'Tab', 'ArrowDown', 'ArrowUp'].includes(event.key) && !event.shiftKey && actions.slashKey(event.key)) {
        event.preventDefault();
        return;
      }
      // Enter sends. While Stop stands in for Send it does nothing, so a prompt written ahead never stops Claude.
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        if (!this.stops) this.send();
      }
    });
    input.addEventListener('input', () => {
      this.autosize();
      this.refreshAction();
      this.refreshSlash();
    });
    this.model.addEventListener('change', () => actions.setOptions({ model: this.model.value }));
    this.mode.addEventListener('change', () => actions.setOptions({ permissionMode: this.mode.value as PermissionMode }));
  }

  /** Skills attached to the prompt. */
  get skills(): readonly string[] {
    return this.attached;
  }

  /** The slash command being typed, if any: the text after the slash. */
  get slashQuery(): string | undefined {
    return this.slash;
  }

  /** Focuses the input unless it is disabled; true if it took focus. */
  focus(): boolean {
    if (this.input.disabled) return false;
    this.input.focus({ preventScroll: true });
    return true;
  }

  /** Puts another toggle in the bar, after Skills. */
  addToggle(toggle: HTMLElement): void {
    this.skillsToggle.after(toggle);
  }

  /** Puts another button in the bar, just before Send. */
  addAction(control: HTMLElement): void {
    this.action.before(control);
  }

  setPlaceholder(text: string): void {
    this.input.placeholder = text;
  }

  /** The conversation the composer sends to; undefined while there is none, which disables it. */
  setState(state: SessionState | undefined): void {
    this.state = state;
    const unavailable = !state || state.phase === 'unavailable';
    this.input.disabled = this.model.disabled = this.mode.disabled = this.filesToggle.disabled = unavailable;
    this.effort.setDisabled(unavailable);
    this.syncModels();
    const current = state?.options.permissionMode ?? 'default';
    const modes = PICKABLE_MODES.includes(current) ? PICKABLE_MODES : [...PICKABLE_MODES, current];
    syncSelect(
      this.mode,
      modes.map((mode) => [mode, MODE_LABELS[mode]] as const),
      current,
    );
    this.refreshAction();
  }

  /** Models from Claude Code itself. Attached skills it no longer offers are dropped. */
  setCatalog(catalog: AgentCatalog): void {
    this.catalog = catalog;
    this.syncModels();
    const offered = new Set(catalog.skills.map((skill) => skill.name));
    if (catalog.known && this.attached.some((name) => !offered.has(name))) {
      this.attached = this.attached.filter((name) => offered.has(name));
      this.renderChips();
    }
  }

  setSkillsPressed(pressed: boolean): void {
    this.skillsToggle.setAttribute('aria-pressed', String(pressed));
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
      this.popIn([...this.chips.querySelectorAll('.skill-chip')].slice(-1));
    }
  }

  /** Attaches files to the prompt as context: each pops into the row above the input, after any skills. */
  attachFiles(paths: readonly string[]): void {
    const added = [...new Set(paths)].filter((path) => !this.files.includes(path)).slice(0, Math.max(0, MAX_FILES - this.files.length));
    if (added.length === 0) return;
    this.files = [...this.files, ...added];
    this.renderChips();
    this.popIn([...this.chips.querySelectorAll('.file-chip')].slice(-added.length));
  }

  /** Puts a prompt the host never took up back into an empty composer. */
  restore(text: string): void {
    if (this.input.value.trim()) return;
    this.input.value = text;
    this.autosize();
    this.refreshAction();
    this.refreshSlash();
  }

  /** Where a dragged skill is dropped: anywhere on the composer. */
  dropRect(): DOMRect {
    return this.element.getBoundingClientRect();
  }

  setDropState(state: 'ready' | 'over' | undefined): void {
    if (state) this.element.dataset.drop = state;
    else delete this.element.dataset.drop;
  }

  private detach(name: string): void {
    this.attached = this.attached.filter((attached) => attached !== name);
    this.renderChips();
    this.input.focus({ preventScroll: true });
  }

  private detachFile(path: string): void {
    this.files = this.files.filter((file) => file !== path);
    this.renderChips();
    this.input.focus({ preventScroll: true });
  }

  private get empty(): boolean {
    return this.input.value.trim() === '' && this.attached.length === 0 && this.files.length === 0;
  }

  /** Whether what is written can go now: whenever Claude Code is there, or, for a composer that stops its conversation, once that conversation is idle. */
  private get canSend(): boolean {
    const phase = this.state?.phase ?? 'unavailable';
    return this.actions.stop ? phase === 'idle' : phase !== 'unavailable';
  }

  /** Stop stands in for Send. */
  private get stops(): boolean {
    const phase = this.state?.phase;
    return this.actions.stop !== undefined && (phase === 'working' || phase === 'stopping');
  }

  private send(): void {
    if (this.empty || !this.canSend) return;
    if (!this.actions.send(this.input.value.trim(), this.input.getBoundingClientRect(), [...this.attached], [...this.files])) return;
    this.input.value = '';
    this.attached = [];
    this.files = [];
    this.renderChips();
    this.autosize();
    this.refreshAction();
    this.refreshSlash();
    this.actions.sent();
  }

  /** Tells the coordinator when the prompt becomes, changes as, or stops being a slash command. */
  private refreshSlash(): void {
    const query = slashQuery(this.input.value);
    if (query === this.slash) return;
    this.slash = query;
    this.actions.slash(query, this.input.getBoundingClientRect());
  }

  private refreshAction(): void {
    if (this.stops) {
      const stopping = this.state?.phase === 'stopping';
      this.action.textContent = stopping ? 'Stopping' : 'Stop';
      this.action.className = 'button danger composer-action';
      this.action.disabled = stopping;
    } else {
      this.action.textContent = 'Send';
      this.action.className = 'button primary composer-action';
      this.action.disabled = !this.canSend || this.empty;
    }
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
      ...this.files.map((path) => {
        const chip = el('span', 'file-chip');
        chip.dataset.path = path;
        chip.title = path;
        const icon = el('span', 'file-chip-icon');
        icon.setAttribute('aria-hidden', 'true');
        const remove = button('', 'file-chip-remove', `Detach ${path}`);
        remove.setAttribute('aria-label', `Detach ${path}`);
        remove.addEventListener('click', () => this.detachFile(path));
        chip.append(icon, el('span', 'file-chip-name', fileName(path)), remove);
        return chip;
      }),
    );
    this.chips.hidden = this.attached.length === 0 && this.files.length === 0;
    this.actions.skillsChanged([...this.attached]);
    this.refreshAction();
  }

  /** Chips just attached pop in. */
  private popIn(chips: readonly Element[]): void {
    if (reducedMotion()) return;
    for (const chip of chips) {
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

  private autosize(): void {
    this.input.style.height = 'auto';
    this.input.style.height = `${Math.min(this.input.scrollHeight, this.options.maxInputPx)}px`;
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
