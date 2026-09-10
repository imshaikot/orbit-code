/** The ambient animation (a turn's flow, glows, comets) is capped here, so a long turn stays cheap. */
const AMBIENT_FPS = 30;
/** Camera moves, drags and hover follow the display, up to this. */
const SMOOTH_FPS = 60;
/** A gap longer than this between frames counts as a pause: the clock doesn't jump to catch up. */
const PAUSE_MS = 100;

/** What the next frame is for: nothing, the ambient animation, or something the eye follows (a camera move, a drag, a hover). */
export type Pace = 'parked' | 'ambient' | 'smooth';

export interface FrameSample {
  now: number;
  /** Seconds since the previous rendered frame; one frame's worth after a pause. */
  dt: number;
  /** The loop is coming back from being parked or hidden. */
  resumed: boolean;
}

/**
 * requestAnimationFrame at two paces: 30 fps for the ambient animation and up to 60 fps while the camera
 * or the pointer moves. Stops while the panel or page is hidden and parks whenever a frame reports
 * nothing left to animate; `wake()` restarts it.
 */
export class FrameLoop {
  private raf = 0;
  private lastFrame = 0;
  private frameMs = 1000 / AMBIENT_FPS;
  private pageVisible = document.visibilityState === 'visible';
  private panelVisible = true;

  constructor(
    /** Renders one frame. Returns whether another frame is needed, and at which pace. */
    private readonly render: (sample: FrameSample) => Pace,
    private readonly onVisibility: (visible: boolean) => void,
  ) {
    document.addEventListener('visibilitychange', () => {
      this.pageVisible = document.visibilityState === 'visible';
      this.visibilityChanged();
    });
  }

  get visible(): boolean {
    return this.pageVisible && this.panelVisible;
  }

  setPanelVisible(visible: boolean): void {
    this.panelVisible = visible;
    this.visibilityChanged();
  }

  readonly wake = (): void => {
    if (this.raf === 0 && this.visible) this.raf = requestAnimationFrame(this.tick);
  };

  private visibilityChanged(): void {
    if (this.visible) {
      this.lastFrame = 0;
      this.onVisibility(true);
      this.wake();
    } else if (this.raf !== 0) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.onVisibility(false);
    }
  }

  private readonly tick = (now: number): void => {
    this.raf = 0;
    if (!this.visible) return;
    const elapsed = now - this.lastFrame;
    // The cap skips display refreshes until the frame interval has passed. The 2 ms slack absorbs rAF
    // timestamp jitter, so at 30 fps a 60 Hz display renders every second refresh and 120 Hz every fourth.
    if (elapsed < this.frameMs - 2) {
      this.raf = requestAnimationFrame(this.tick);
      return;
    }
    const resumed = elapsed > PAUSE_MS;
    this.lastFrame = now;
    const pace = this.render({ now, dt: (resumed ? this.frameMs : elapsed) / 1000, resumed });
    if (pace === 'parked') return;
    this.frameMs = 1000 / (pace === 'smooth' ? SMOOTH_FPS : AMBIENT_FPS);
    this.raf = requestAnimationFrame(this.tick);
  };
}
