import type { Stop, StopCard } from '../tour';
import { el } from './dom';

const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';
/** Room between the anchor and the card, and between the card and the window's edge, in pixels. */
const OFFSET_PX = 18;
const EDGE_PX = 8;

/** The caption a tour stop gets: where it is, what it is, and a few things the graph knows about it, beside the file or bubble. */
export class TourCard {
  private readonly root = el('section', 'tour-card');
  /** The box itself: animated apart from the root, whose transform places the card. */
  private readonly body = el('div', 'tc-body');
  private readonly kicker = el('p', 'tc-kicker');
  private readonly title = el('h2', 'tc-title');
  private readonly facts = el('ul', 'tc-facts');
  private leaving: Animation | undefined;

  constructor(host: HTMLElement) {
    this.root.hidden = true;
    this.root.setAttribute('aria-live', 'polite');
    this.body.append(this.kicker, this.title, this.facts);
    this.root.append(this.body);
    host.append(this.root);
  }

  get isOpen(): boolean {
    return !this.root.hidden && this.leaving === undefined;
  }

  show(card: StopCard, kind: Stop['kind']): void {
    this.leaving?.cancel();
    this.leaving = undefined;
    this.root.dataset.kind = kind;
    this.kicker.textContent = card.kicker;
    this.title.textContent = card.title;
    this.facts.replaceChildren(...card.facts.map((fact) => el('li', 'tc-fact', fact)));
    this.root.hidden = false;
    this.root.dataset.offscreen = 'false';
    if (reducedMotion()) return;
    this.body.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 320, easing: EASE });
    [...this.facts.children].forEach((fact, k) =>
      fact.animate([{ opacity: 0, transform: 'translateX(-6px)' }, { opacity: 1, transform: 'none' }], { duration: 260, delay: 160 + k * 90, easing: 'ease-out', fill: 'backwards' }),
    );
  }

  /** Keeps the card beside its anchor: (x, y) in client pixels, `clear` of it by at least that many (a file's ring), or off screen. */
  place(x: number, y: number, onScreen: boolean, clear = 0): void {
    if (this.root.hidden) return;
    this.root.dataset.offscreen = String(!onScreen);
    if (!onScreen) return;
    const width = this.root.offsetWidth;
    const height = this.root.offsetHeight;
    const offset = Math.max(OFFSET_PX, clear);
    const right = x + offset + width <= window.innerWidth - EDGE_PX;
    const left = right ? x + offset : Math.max(EDGE_PX, x - offset - width);
    const top = Math.min(Math.max(EDGE_PX, y - height / 2), window.innerHeight - height - EDGE_PX);
    this.root.dataset.side = right ? 'right' : 'left';
    this.root.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
  }

  hide(): void {
    if (this.root.hidden || this.leaving) return;
    if (reducedMotion()) {
      this.root.hidden = true;
      return;
    }
    const motion = this.body.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, easing: 'ease-out', fill: 'forwards' });
    this.leaving = motion;
    motion.onfinish = () => {
      if (this.leaving !== motion) return;
      this.leaving = undefined;
      this.root.hidden = true;
      motion.cancel();
    };
  }
}

function reducedMotion(): boolean {
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}
