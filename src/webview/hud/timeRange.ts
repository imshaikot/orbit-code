import { button, el } from './dom';
import { relativeTime } from './turns';

type Edge = 'from' | 'to';

/** A step of PageUp or PageDown, as a share of the whole span. */
const PAGE = 0.1;

/**
 * A slider with two thumbs over the time the earlier conversations span, with a tick for each conversation where it
 * was last active. Dragging a thumb, pressing on the track (the nearer thumb comes to the pointer) or the arrow keys
 * (one conversation at a time) narrow the history constellation to the conversations last active in between.
 *
 * A thumb left at an end of the span stays open rather than holding a time, so a conversation newer than the span
 * still shows after a refresh.
 */
export class TimeRange {
  readonly element = el('div', 'time-range');
  private readonly fromLabel = el('span', 'tr-label tr-label-from');
  private readonly toLabel = el('span', 'tr-label tr-label-to');
  private readonly track = el('div', 'tr-track');
  private readonly rail = el('div', 'tr-rail');
  private readonly ticks = el('div', 'tr-ticks');
  private readonly fill = el('div', 'tr-fill');
  private readonly thumbs: Record<Edge, HTMLDivElement> = { from: thumb('from', 'Oldest last activity shown'), to: thumb('to', 'Newest last activity shown') };
  private readonly allButton = button('All', 'link-button tr-all', 'Show the conversations of the whole time again');
  /** When each conversation was last active, oldest first. */
  private times: number[] = [];
  private min = 0;
  private max = 0;
  /** The chosen bounds in epoch ms; undefined leaves that end open at the edge of the span. */
  private from: number | undefined;
  private to: number | undefined;

  constructor(private readonly onChange: () => void) {
    this.element.setAttribute('role', 'group');
    this.element.setAttribute('aria-label', 'Time range');
    this.rail.append(this.ticks, this.fill, this.thumbs.from, this.thumbs.to);
    this.track.append(this.rail);
    this.element.append(this.fromLabel, this.track, this.toLabel, this.allButton);
    this.track.addEventListener('pointerdown', (event) => this.startDrag(event));
    for (const edge of ['from', 'to'] as const) this.thumbs[edge].addEventListener('keydown', (event) => this.key(edge, event));
    this.allButton.addEventListener('click', () => {
      this.from = this.to = undefined;
      this.changed();
    });
  }

  /** True when there is a span to choose from: two or more conversations, not all at one moment. */
  get usable(): boolean {
    return this.times.length > 1 && this.max > this.min;
  }

  /** The chosen range in epoch ms, or undefined while it is the whole span. Read by scripts/harness.mjs too. */
  get bounds(): [number, number] | undefined {
    if (!this.usable || (this.from === undefined && this.to === undefined)) return undefined;
    return [this.from ?? this.min, this.to ?? this.max];
  }

  setTimes(times: readonly number[]): void {
    this.times = [...times].sort((a, b) => a - b);
    this.min = this.times[0] ?? 0;
    this.max = this.times.at(-1) ?? 0;
    if (this.from !== undefined && this.from <= this.min) this.from = undefined;
    if (this.to !== undefined && this.to >= this.max) this.to = undefined;
    this.ticks.replaceChildren(
      ...this.times.map((time) => {
        const tick = el('span', 'tr-tick');
        tick.style.left = `${(this.fraction(time) * 100).toFixed(2)}%`;
        return tick;
      }),
    );
    this.render();
  }

  /** Whether a conversation last active at `time` is inside the range. */
  includes(time: number): boolean {
    const bounds = this.bounds;
    return !bounds || (time >= bounds[0] && time <= bounds[1]);
  }

  private fraction(time: number): number {
    return this.max > this.min ? (time - this.min) / (this.max - this.min) : 0;
  }

  private value(edge: Edge): number {
    return edge === 'from' ? (this.from ?? this.min) : (this.to ?? this.max);
  }

  /** Moves one thumb to `time`, never past the other; at an end of the span it opens. */
  private set(edge: Edge, time: number): void {
    const before = this.bounds;
    if (edge === 'from') {
      const at = Math.max(this.min, Math.min(this.value('to'), time));
      this.from = at <= this.min ? undefined : at;
    } else {
      const at = Math.min(this.max, Math.max(this.value('from'), time));
      this.to = at >= this.max ? undefined : at;
    }
    const after = this.bounds;
    if (before?.[0] !== after?.[0] || before?.[1] !== after?.[1]) this.changed();
  }

  private changed(): void {
    this.render();
    this.onChange();
  }

  private render(): void {
    const from = this.fraction(this.value('from'));
    const to = this.fraction(this.value('to'));
    this.fill.style.left = `${(from * 100).toFixed(2)}%`;
    this.fill.style.right = `${((1 - to) * 100).toFixed(2)}%`;
    this.times.forEach((time, k) => {
      const tick = this.ticks.children[k] as HTMLElement | undefined;
      if (tick) tick.dataset.in = String(this.includes(time));
    });
    for (const edge of ['from', 'to'] as const) {
      const at = edge === 'from' ? from : to;
      const node = this.thumbs[edge];
      node.style.left = `${(at * 100).toFixed(2)}%`;
      node.setAttribute('aria-valuenow', String(Math.round(at * 1000)));
      node.setAttribute('aria-valuetext', relativeTime(this.value(edge)));
    }
    this.fromLabel.textContent = this.usable ? relativeTime(this.value('from')) : '';
    this.toLabel.textContent = this.usable ? relativeTime(this.value('to')) : '';
    const narrowed = this.bounds !== undefined;
    this.element.dataset.narrowed = String(narrowed);
    this.allButton.disabled = !narrowed;
  }

  /**
   * A thumb is dragged from where it was taken; a press on the track brings the nearer thumb there first. Of two thumbs
   * on top of each other, the one on the side the pointer then moves toward goes, so neither can be stuck at an end.
   */
  private startDrag(down: PointerEvent): void {
    if (down.button !== 0 || !this.usable) return;
    down.preventDefault();
    const rect = this.rail.getBoundingClientRect();
    const at = (clientX: number) => (rect.width > 0 ? (clientX - rect.left) / rect.width : 0);
    const pressed = at(down.clientX);
    const taken = (down.target as HTMLElement).closest<HTMLElement>('.tr-thumb')?.dataset.edge as Edge | undefined;
    const from = this.fraction(this.value('from'));
    const to = this.fraction(this.value('to'));
    let edge: Edge | undefined;
    if (from !== to) edge = taken ?? (Math.abs(pressed - from) <= Math.abs(pressed - to) ? 'from' : 'to');
    else if (!taken) edge = pressed < from ? 'from' : 'to';
    const offset = taken ? pressed - (taken === 'from' ? from : to) : 0;
    const time = (fraction: number) => this.min + Math.max(0, Math.min(1, fraction - offset)) * (this.max - this.min);
    this.thumbs[edge ?? taken ?? 'to'].focus({ preventScroll: true });
    if (edge && !taken) this.set(edge, time(pressed));
    this.track.setPointerCapture(down.pointerId);
    this.element.dataset.dragging = 'true';
    const move = (event: PointerEvent) => {
      if (event.pointerId !== down.pointerId) return;
      const now = at(event.clientX);
      if (!edge) {
        if (now === pressed) return;
        edge = now < pressed ? 'from' : 'to';
        this.thumbs[edge].focus({ preventScroll: true });
      }
      this.set(edge, time(now));
    };
    const end = (event: PointerEvent) => {
      if (event.pointerId !== down.pointerId) return;
      this.track.removeEventListener('pointermove', move);
      this.track.removeEventListener('pointerup', end);
      this.track.removeEventListener('pointercancel', end);
      delete this.element.dataset.dragging;
    };
    this.track.addEventListener('pointermove', move);
    this.track.addEventListener('pointerup', end);
    this.track.addEventListener('pointercancel', end);
  }

  /** The arrows step to the next conversation's time, PageUp and PageDown a tenth of the span, Home and End to the ends. */
  private key(edge: Edge, event: KeyboardEvent): void {
    const now = this.value(edge);
    let time: number | undefined;
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') time = this.times.find((t) => t > now) ?? this.max;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') time = this.times.findLast((t) => t < now) ?? this.min;
    else if (event.key === 'PageUp') time = now + (this.max - this.min) * PAGE;
    else if (event.key === 'PageDown') time = now - (this.max - this.min) * PAGE;
    else if (event.key === 'Home') time = this.min;
    else if (event.key === 'End') time = this.max;
    if (time === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    this.set(edge, time);
  }
}

function thumb(edge: Edge, label: string): HTMLDivElement {
  const node = el('div', 'tr-thumb');
  node.dataset.edge = edge;
  node.tabIndex = 0;
  node.setAttribute('role', 'slider');
  node.setAttribute('aria-label', label);
  node.setAttribute('aria-valuemin', '0');
  node.setAttribute('aria-valuemax', '1000');
  return node;
}
