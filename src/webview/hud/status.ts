import { el } from './dom';

export type StatusPhase = 'indexing' | 'layout' | 'error';

/** Centre of the screen: indexing and layout progress, or a blocking error. */
export class StatusOverlay {
  private readonly root = el('div', 'status');
  private readonly message = el('p', 'status-message', 'Starting');
  private readonly fill = el('div', 'status-fill');

  constructor(host: HTMLElement) {
    this.root.setAttribute('role', 'status');
    const bar = el('div', 'status-bar');
    bar.append(this.fill);
    this.root.append(this.message, bar);
    host.append(this.root);
  }

  show(phase: StatusPhase, message: string, progress?: number): void {
    this.root.hidden = false;
    this.root.dataset.phase = phase;
    this.message.textContent = message;
    this.fill.style.setProperty('--progress', String(Math.max(0, Math.min(1, progress ?? 0))));
  }

  hide(): void {
    this.root.hidden = true;
  }
}
