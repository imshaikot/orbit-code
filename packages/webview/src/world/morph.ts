/** How long the files take to fly between the Nested and Flat views. */
export const MORPH_MS = 1400;

/** The files' flight between the Nested and Flat views: uFlatMix eased from one to the other. */
export class Morph {
  private flight: { from: number; to: number; start: number; duration: number } | undefined;

  constructor(private readonly mix: { value: number }) {}

  get active(): boolean {
    return this.flight !== undefined;
  }

  /** Flies to `to` from wherever the files are, or puts them there at once. */
  start(to: number, animate: boolean): void {
    this.flight = animate ? { from: this.mix.value, to, start: performance.now(), duration: MORPH_MS } : undefined;
    if (!animate) this.mix.value = to;
  }

  /** Plays out the flight, easing in and out. Returns whether it is still under way. */
  advance(now: number): boolean {
    const flight = this.flight;
    if (!flight) return false;
    const t = Math.min(1, Math.max(0, (now - flight.start) / flight.duration));
    const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    this.mix.value = flight.from + (flight.to - flight.from) * eased;
    if (t >= 1) this.flight = undefined;
    return true;
  }

  adopt(previous: Morph): void {
    this.flight = previous.flight;
  }
}
