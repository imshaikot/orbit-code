import { el } from './dom';

export class Tooltip {
  private readonly root = el('div', 'tooltip');
  private readonly title = el('p', 'tooltip-title');
  private readonly detail = el('p', 'tooltip-detail');
  private width = 0;

  constructor(host: HTMLElement) {
    this.root.hidden = true;
    this.root.append(this.title, this.detail);
    host.append(this.root);
  }

  /** (x, y) in client pixels; flips left of the pointer near the right edge. */
  show(x: number, y: number, title: string, detail: string): void {
    // Measured only when the text changes: reading the width lays the page out, and hover asks on every pick.
    if (this.root.hidden || title !== this.title.textContent || detail !== this.detail.textContent) {
      this.title.textContent = title;
      this.detail.textContent = detail;
      this.root.hidden = false;
      this.width = this.root.offsetWidth;
    }
    const width = this.width;
    const left = x + 16 + width > window.innerWidth - 8 ? x - 16 - width : x + 16;
    this.root.style.transform = `translate3d(${Math.max(8, left)}px, ${y + 14}px, 0)`;
  }

  hide(): void {
    this.root.hidden = true;
  }
}
