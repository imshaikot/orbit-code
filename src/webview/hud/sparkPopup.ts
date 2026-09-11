import { button, el } from './dom';

export interface SparkPopupActions {
  /** Follow was on: turn it off. Off: turn it on, framing the star at a fair distance and panning to keep pace with it. */
  toggleFollow(): void;
  /** The popup closed, by Esc, an outside click, or choosing the toggle. */
  closed(): void;
}

/**
 * The small popup a click on Claude's star opens: one toggle, "Follow Spark" while the star isn't followed,
 * "Stop Following" while it is. Closes itself once chosen; clicking the star again reopens it with the current
 * state, which is how Follow is turned back off.
 */
export class SparkPopup {
  private readonly root = el('section', 'spark-popup');
  private readonly toggle = button('Follow Spark', 'button primary spark-popup-toggle');
  private open_ = false;

  constructor(
    host: HTMLElement,
    private readonly actions: SparkPopupActions,
  ) {
    this.root.hidden = true;
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', 'Claude');
    this.root.tabIndex = -1;
    this.root.append(this.toggle);
    host.append(this.root);

    this.toggle.addEventListener('click', () => {
      this.actions.toggleFollow();
      this.close();
    });

    // Esc closes the popup before anything else sees it, like the file menu's.
    window.addEventListener(
      'keydown',
      (event) => {
        if (event.key !== 'Escape' || !this.open_) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        this.close();
      },
      true,
    );
    window.addEventListener(
      'pointerdown',
      (event) => {
        if (this.open_ && !this.root.contains(event.target as Node)) this.close();
      },
      true,
    );
  }

  get isOpen(): boolean {
    return this.open_;
  }

  /** Opens with the toggle reading `following`'s state; `place()` positions it beside the star. */
  open(following: boolean): void {
    this.setFollowing(following);
    this.root.hidden = false;
    this.open_ = true;
    this.root.dataset.offscreen = 'false';
    this.root.focus({ preventScroll: true });
  }

  /** Relabels the toggle for the current Follow state, while open. */
  setFollowing(following: boolean): void {
    this.toggle.textContent = following ? 'Stop Following' : 'Follow Spark';
  }

  /** Keeps the popup beside the star: (x, y) in client pixels, or off screen (the star left the view). */
  place(x: number, y: number, onScreen: boolean): void {
    if (this.root.hidden) return;
    this.root.dataset.offscreen = String(!onScreen);
    if (!onScreen) return;
    const width = this.root.offsetWidth;
    const height = this.root.offsetHeight;
    const left = Math.min(Math.max(8, x - width / 2), window.innerWidth - width - 8);
    const top = Math.min(Math.max(8, y - height - 16), window.innerHeight - height - 8);
    this.root.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
  }

  close(): void {
    if (this.root.hidden) return;
    this.root.hidden = true;
    this.open_ = false;
    this.actions.closed();
  }
}
