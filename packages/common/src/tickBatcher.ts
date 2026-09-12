/**
 * Collects items and hands them over at most once per interval, so a burst of
 * session events crosses the webview boundary as one message per host tick.
 */
export class TickBatcher<T> {
  private items: T[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly intervalMs: number,
    private readonly flush: (items: T[]) => void,
  ) {}

  push(...items: T[]): void {
    if (items.length === 0) return;
    this.items.push(...items);
    this.timer ??= setTimeout(() => this.drain(), this.intervalMs);
  }

  /** Hands over whatever is pending right now. */
  drain(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.items.length === 0) return;
    const items = this.items;
    this.items = [];
    this.flush(items);
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.items = [];
  }
}
