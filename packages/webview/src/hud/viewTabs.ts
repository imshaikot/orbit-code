import { el } from './dom';

/** How the graph is laid out: directories as bubbles inside bubbles, or every file at once on orbits. */
export type ViewMode = 'nested' | 'flat';

const VIEWS: ReadonlyArray<{ mode: ViewMode; label: string; title: string }> = [
  { mode: 'nested', label: 'Nested', title: 'Directories as bubbles inside bubbles, one to look into at a time' },
  { mode: 'flat', label: 'Flat', title: 'Every file at once, on orbits around the workspace' },
];

export interface ViewTabsActions {
  select(mode: ViewMode): void;
}

/** Top middle: the switch between the Nested and Flat views, a tab list whose arrow keys move between them. */
export class ViewTabs {
  private readonly list = el('div', 'view-tablist');
  private readonly thumb = el('span', 'view-thumb');
  private readonly tabs = new Map<ViewMode, HTMLButtonElement>();
  private current: ViewMode = 'nested';

  constructor(
    host: HTMLElement,
    private readonly actions: ViewTabsActions,
  ) {
    const root = el('nav', 'view-tabs');
    root.setAttribute('aria-label', 'View');
    this.list.setAttribute('role', 'tablist');
    this.thumb.setAttribute('aria-hidden', 'true');
    this.list.append(this.thumb);
    VIEWS.forEach((view, k) => {
      const tab = el('button', 'view-tab');
      tab.type = 'button';
      tab.dataset.view = view.mode;
      tab.title = view.title;
      tab.setAttribute('role', 'tab');
      const glyph = el('span', 'view-glyph');
      glyph.setAttribute('aria-hidden', 'true');
      tab.append(glyph, el('span', 'view-label', view.label));
      tab.addEventListener('click', () => this.choose(view.mode));
      tab.addEventListener('keydown', (event) => {
        const last = VIEWS.length - 1;
        const next = { ArrowLeft: k - 1, ArrowRight: k + 1, Home: 0, End: last }[event.key];
        if (next === undefined) return;
        event.preventDefault();
        const mode = VIEWS[(next + VIEWS.length) % VIEWS.length].mode;
        this.tabs.get(mode)!.focus();
        this.choose(mode);
      });
      this.tabs.set(view.mode, tab);
      this.list.append(tab);
    });
    root.append(this.list);
    host.append(root);
    this.set('nested');
    // Measured from the tabs, which the page's fonts may still resize; the thumb only slides once it has a place.
    new ResizeObserver(() => this.placeThumb()).observe(this.list);
    requestAnimationFrame(() => (this.list.dataset.ready = ''));
  }

  get mode(): ViewMode {
    return this.current;
  }

  /** Shows `mode` as the chosen view, without telling anyone. */
  set(mode: ViewMode): void {
    this.current = mode;
    for (const [view, tab] of this.tabs) {
      tab.setAttribute('aria-selected', String(view === mode));
      tab.tabIndex = view === mode ? 0 : -1;
    }
    this.placeThumb();
  }

  private choose(mode: ViewMode): void {
    if (mode === this.current) return;
    this.set(mode);
    this.actions.select(mode);
  }

  private placeThumb(): void {
    const tab = this.tabs.get(this.current)!;
    this.thumb.style.width = `${tab.offsetWidth}px`;
    this.thumb.style.transform = `translateX(${tab.offsetLeft}px)`;
  }
}
