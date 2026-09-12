import { EFFORT_LEVELS, type EffortLevel } from '../../shared/protocol';
import { button, el } from './dom';

/** An effort level, or '' for Claude Code's own default. */
export type Effort = EffortLevel | '';

const EFFORTS: readonly Effort[] = ['', ...EFFORT_LEVELS];
const NAMES: Record<Effort, string> = { '': 'Auto', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
const HINTS: Record<Effort, string> = {
  '': "Claude Code's own default, from your settings",
  low: 'Quick answers with the least thinking',
  medium: 'A balance of speed and depth',
  high: 'Thinks problems through',
  xhigh: 'Deeper reasoning for hard problems',
  max: 'The deepest reasoning: slowest, and the most tokens',
};
/** As the meter shows them, short enough to keep it narrow. */
const LABELS: Record<Effort, string> = { ...NAMES, xhigh: 'X-High' };
/** What the label says, in place of the level names, for a model that takes no effort level. */
const NOT_OFFERED = 'Not offered';

/**
 * How hard Claude thinks, in the composer bar: a ring for Claude Code's own default, then a bar per level, rising and
 * warming toward max. A radio group: a click or the arrow keys pick, and the pointer previews a level before it is
 * picked. A model that takes no effort level dims it, and the pick is kept for the next model that does.
 */
export class EffortMeter {
  readonly element = el('div', 'composer-effort');
  private readonly radios = new Map<Effort, HTMLButtonElement>();
  /** A name per level, and one for a model that takes none, stacked in one cell so the meter keeps its width. */
  private readonly names = new Map<string, HTMLElement>();
  private value: Effort = '';
  /** Levels the selected model takes; undefined while that is unknown, which offers them all. */
  private offered: readonly EffortLevel[] | undefined;
  private model = '';
  private disabled = false;

  constructor(private readonly pick: (effort: Effort) => void) {
    const root = this.element;
    root.setAttribute('role', 'radiogroup');
    root.setAttribute('aria-label', 'Effort');
    const bars = el('span', 'effort-bars');
    for (const [index, effort] of EFFORTS.entries()) {
      const radio = button('', effort ? 'effort-bar' : 'effort-auto', `${NAMES[effort]} effort: ${HINTS[effort]}`);
      radio.dataset.effort = effort;
      radio.setAttribute('role', 'radio');
      radio.setAttribute('aria-label', `${NAMES[effort]} effort`);
      if (effort) radio.style.setProperty('--i', String(index - 1));
      radio.addEventListener('click', () => this.choose(effort));
      radio.addEventListener('pointerenter', () => this.render(effort));
      this.radios.set(effort, radio);
      (effort ? bars : root).append(radio);
    }
    const label = el('span', 'effort-label');
    label.setAttribute('aria-hidden', 'true');
    for (const [key, text] of [...EFFORTS.map((effort) => [effort, LABELS[effort]] as const), ['none', NOT_OFFERED] as const]) {
      const name = el('span', 'effort-name', text);
      name.dataset.key = key;
      this.names.set(key, name);
      label.append(name);
    }
    root.append(bars, label);
    root.addEventListener('pointerleave', () => this.render());
    root.addEventListener('keydown', (event) => this.key(event));
    this.render();
  }

  /** The chosen effort, and the selected model: its name, and the levels it takes (undefined when not known). */
  set(effort: Effort, model: string, offered: readonly EffortLevel[] | undefined): void {
    this.value = effort;
    this.model = model;
    this.offered = offered;
    this.render();
  }

  setDisabled(disabled: boolean): void {
    this.disabled = disabled;
    this.render();
  }

  private get takesEffort(): boolean {
    return this.offered === undefined || this.offered.length > 0;
  }

  private enabled(effort: Effort): boolean {
    return !this.disabled && this.takesEffort && (effort === '' || this.offered === undefined || this.offered.includes(effort));
  }

  private choose(effort: Effort): void {
    if (!this.enabled(effort) || effort === this.value) return;
    this.value = effort;
    this.render();
    this.pick(effort);
    this.pop(effort);
  }

  /** Draws `shown`, a level the pointer is over, else the chosen one. */
  private render(shown?: Effort): void {
    const root = this.element;
    const takes = this.takesEffort;
    const level = shown !== undefined && this.enabled(shown) ? shown : this.value;
    const lit = EFFORTS.indexOf(level);
    root.dataset.level = level || 'auto';
    root.dataset.previewing = String(level !== this.value);
    root.dataset.offered = String(takes);
    root.setAttribute('aria-disabled', String(this.disabled || !takes));
    root.title = takes ? `Effort: ${NAMES[level]}. ${HINTS[level]}` : `${this.model || 'This model'} takes no effort level`;
    for (const [effort, radio] of this.radios) {
      radio.disabled = !this.enabled(effort);
      radio.dataset.lit = String(effort === '' ? level === '' : EFFORTS.indexOf(effort) <= lit);
      radio.setAttribute('aria-checked', String(effort === this.value));
      radio.tabIndex = effort === this.value ? 0 : -1;
    }
    const name = takes ? level : 'none';
    for (const [key, element] of this.names) element.dataset.shown = String(key === name);
  }

  /** Arrows step through the levels the model takes, Home goes back to the default and End to the most. */
  private key(event: KeyboardEvent): void {
    const choices = EFFORTS.filter((effort) => this.enabled(effort));
    const at = Math.max(0, choices.indexOf(this.value));
    const step = event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1 : 0;
    const next = event.key === 'Home' ? choices[0] : event.key === 'End' ? choices.at(-1) : step ? choices[Math.min(Math.max(at + step, 0), choices.length - 1)] : undefined;
    if (next === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    this.choose(next);
    this.radios.get(next)?.focus({ preventScroll: true });
  }

  /** The picked bar jumps and flares from its foot; the ring swells when the pick goes back to the default. */
  private pop(effort: Effort): void {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    this.radios.get(effort)?.animate(
      [
        { transform: effort ? 'scale(1.15, 1.6)' : 'scale(1.6)', filter: 'brightness(1.9)' },
        { transform: 'none', filter: 'none' },
      ],
      { duration: 420, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)' },
    );
  }
}
