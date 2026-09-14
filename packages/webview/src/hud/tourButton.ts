import { el } from './dom';

/** Top right: Take a Tour, which reads Stop Tour while one runs. */
export class TourButton {
  private readonly root = el('button', 'tour-button');
  private readonly label = el('span', 'tour-label', 'Take a Tour');

  constructor(host: HTMLElement, toggle: () => void) {
    this.root.type = 'button';
    this.root.setAttribute('aria-pressed', 'false');
    const glyph = el('span', 'tour-glyph');
    glyph.setAttribute('aria-hidden', 'true');
    this.root.append(glyph, this.label);
    this.root.addEventListener('click', toggle);
    host.append(this.root);
    this.set(false);
  }

  set(on: boolean): void {
    this.root.setAttribute('aria-pressed', String(on));
    this.label.textContent = on ? 'Stop Tour' : 'Take a Tour';
    this.root.title = on ? 'End the tour and take the view back' : 'Fly from place to place round the workspace, with a word about some of them, until you stop';
  }
}
