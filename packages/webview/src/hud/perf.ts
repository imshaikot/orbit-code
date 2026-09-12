import { el } from './dom';

export interface PerfSample {
  fps: number;
  cpuMs: number;
  calls: number;
  triangles: number;
  pixelRatio: number;
}

export class PerfReadout {
  private readonly root = el('p', 'perf');

  constructor(host: HTMLElement) {
    this.root.setAttribute('aria-hidden', 'true');
    host.append(this.root);
  }

  /** Undefined means the frame loop is parked. */
  set(sample: PerfSample | undefined): void {
    if (!sample) {
      this.root.textContent = 'Idle, not rendering';
      return;
    }
    this.root.textContent =
      `${sample.fps.toFixed(0)} fps   ${sample.cpuMs.toFixed(1)} ms CPU   ${sample.calls} draw calls   ` +
      `${formatCompact(sample.triangles)} triangles   ${sample.pixelRatio}× pixels`;
  }
}

function formatCompact(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}
