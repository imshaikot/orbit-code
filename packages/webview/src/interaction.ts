import * as THREE from 'three';
import type { Picked, Picker } from './picking';
import type { Stage } from './stage';
import type { World } from './world';

const CLICK_SLOP_PX = 5;
/** While the camera glides (a zoom, damping), what is under the pointer is looked up again at most this often. */
const MOTION_PICK_MS = 80;

export interface InteractionView {
  showTooltip(x: number, y: number, title: string, detail: string): void;
  hideTooltip(): void;
  /** The directory being looked into changed. */
  locationChanged(): void;
  /** A file was clicked. */
  fileClicked(node: number): void;
  /** Claude's star was clicked, by its index in the last pick (World.claudeIdAt resolves it to a stable id). */
  sparkClicked(index: number): void;
  /** A frame is due. */
  wake(): void;
  /** Labels need placing again, and a frame is due. */
  relabel(): void;
}

/** What a pick found, and the view it found it in: the same pixel with the same camera over the same World gives the same answer. */
interface LastPick {
  x: number;
  y: number;
  picked: Picked;
  world: World;
  view: THREE.Matrix4;
  projection: THREE.Matrix4;
}

/**
 * Hover and click through GPU picking: a click on a bubble looks inside it, Esc backs out one level. Hover picks run
 * between frames, one at a time. A click is answered at once: from the hover pick already under the pointer while it
 * still holds, else by a pick started right away rather than after the next frame.
 */
export class Interaction {
  private pointer: { x: number; y: number; clientX: number; clientY: number } | undefined;
  private hoverRequested = false;
  private pressedAt: { x: number; y: number } | undefined;
  /** The button is down and the pointer has moved: the camera is being dragged, and nothing is hovered until it is let go. */
  private dragging = false;
  /** The camera moved under a still pointer: pick again once MOTION_PICK_MS have passed since the last pick. */
  private motionPickWanted = false;
  private lastPickAt = 0;
  private last: LastPick | undefined;
  /** Picks run one after another; the picker takes one at a time. */
  private queue: Promise<unknown> = Promise.resolve();
  private inFlight = 0;
  /** A tour has the graph: nothing is hovered, clicked, backed out of or gone to until it is over. */
  private locked = false;

  constructor(
    private readonly stage: Stage,
    private readonly picker: Picker,
    private readonly world: () => World | undefined,
    private readonly view: InteractionView,
  ) {
    const canvas = stage.renderer.domElement;

    canvas.addEventListener('pointermove', (event) => {
      this.pointer = { x: event.offsetX, y: event.offsetY, clientX: event.clientX, clientY: event.clientY };
      if (this.locked) return;
      const pressed = this.pressedAt;
      if (pressed && !this.dragging && Math.hypot(event.offsetX - pressed.x, event.offsetY - pressed.y) > CLICK_SLOP_PX) {
        // A drag: the camera moves with the pointer, so nothing is under it to hover, and a pick per frame would be wasted.
        this.dragging = true;
        this.world()?.hover({ kind: 'none' });
        view.hideTooltip();
        canvas.style.cursor = 'grabbing';
      }
      this.hoverRequested = !this.dragging;
      view.wake();
    });

    canvas.addEventListener('pointerleave', () => {
      this.pointer = undefined;
      this.hoverRequested = false;
      this.world()?.hover({ kind: 'none' });
      view.hideTooltip();
      canvas.style.cursor = '';
      view.wake();
    });

    canvas.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || this.locked) return;
      this.pressedAt = { x: event.offsetX, y: event.offsetY };
      // Whatever is under the pointer is looked up now, so the answer is usually in by the time the button comes up.
      if (!this.fresh(event.offsetX, event.offsetY)) void this.pickAt(event.offsetX, event.offsetY, 'hover');
    });

    canvas.addEventListener('pointerup', (event) => {
      const pressed = this.pressedAt;
      this.pressedAt = undefined;
      if (this.dragging) {
        this.dragging = false;
        canvas.style.cursor = '';
        // Let go: whatever is now under the pointer is hovered again.
        this.hoverRequested = this.pointer !== undefined;
        view.wake();
      }
      if (event.button !== 0 || !pressed || Math.hypot(event.offsetX - pressed.x, event.offsetY - pressed.y) > CLICK_SLOP_PX) return;
      const fresh = this.fresh(event.offsetX, event.offsetY);
      if (fresh) this.clicked(fresh.world, fresh.picked);
      else void this.pickAt(event.offsetX, event.offsetY, 'click');
    });

    window.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      const target = event.target;
      if (target instanceof HTMLElement && target.matches('input, textarea, select')) {
        target.blur();
        return;
      }
      // Inside the editor or the file card, Esc belongs to them.
      if (target instanceof HTMLElement && target.closest('.editor-sheet, .file-menu')) return;
      this.up();
    });
  }

  /** Takes the pointer and the keys away from the graph (a tour has it), or gives them back. */
  setLocked(on: boolean): void {
    this.locked = on;
    this.pressedAt = undefined;
    this.dragging = false;
    this.motionPickWanted = false;
    this.hoverRequested = !on && this.pointer !== undefined;
    if (on) {
      this.world()?.hover({ kind: 'none' });
      this.view.hideTooltip();
      this.stage.renderer.domElement.style.cursor = '';
    }
    this.view.wake();
  }

  /** Runs after each rendered frame and starts at most one hover pick. True while one is still wanted, so the frame loop keeps pace. */
  afterFrame(): boolean {
    if (this.motionPickWanted && this.pointer && !this.dragging && performance.now() - this.lastPickAt >= MOTION_PICK_MS) {
      this.motionPickWanted = false;
      this.hoverRequested = true;
    }
    if (this.hoverRequested && this.pointer && this.inFlight === 0) {
      this.hoverRequested = false;
      this.lastPickAt = performance.now();
      void this.pickAt(this.pointer.x, this.pointer.y, 'hover');
    }
    return this.hoverRequested || this.inFlight > 0;
  }

  /** A live update replaced the World and node indices moved: pick again under the pointer. */
  worldReplaced(): void {
    this.hoverRequested = this.pointer !== undefined && !this.locked;
    this.view.wake();
  }

  /** The camera moved under a still pointer (a zoom, damping, a directory opened by the zoom): what is under it may have changed. */
  cameraMoved(): void {
    if (this.pointer && !this.dragging && !this.locked) this.motionPickWanted = true;
  }

  /** The file the pointer is over, from the latest pick over the current World, or undefined. */
  hoveredNode(): number | undefined {
    const last = this.last;
    return this.pointer && last && last.world === this.world() && last.picked.kind === 'node' ? last.picked.index : undefined;
  }

  /** The directory bubble the pointer is over, from the latest pick over the current World, or undefined. */
  hoveredCluster(): number | undefined {
    const last = this.last;
    return this.pointer && last && last.world === this.world() && last.picked.kind === 'cluster' ? last.picked.index : undefined;
  }

  /** Back out to the directory around the one in view. */
  up(): void {
    if (!this.locked && this.world()?.up()) this.moved();
  }

  /** Straight to a directory on the current path (the breadcrumb). */
  goTo(cluster: number): void {
    const world = this.world();
    if (!world || this.locked || world.focus.cluster === cluster) return;
    world.goTo(cluster);
    this.moved();
  }

  private moved(): void {
    this.world()?.hover({ kind: 'none' });
    this.view.hideTooltip();
    this.stage.renderer.domElement.style.cursor = '';
    this.view.locationChanged();
    // What is under the pointer changes with the directory.
    this.hoverRequested = this.pointer !== undefined;
    this.view.relabel();
  }

  /** The latest pick, if it was at this pixel, over this World, with the camera where it still is. */
  private fresh(x: number, y: number): LastPick | undefined {
    const last = this.last;
    if (!last || last.world !== this.world() || Math.floor(x) !== last.x || Math.floor(y) !== last.y) return undefined;
    const camera = this.stage.camera;
    camera.updateMatrixWorld();
    return camera.matrixWorld.equals(last.view) && camera.projectionMatrix.equals(last.projection) ? last : undefined;
  }

  private clicked(world: World, picked: Picked): void {
    if (picked.kind === 'cluster') {
      world.goTo(picked.index);
      this.moved();
    } else if (picked.kind === 'node') {
      this.view.hideTooltip();
      this.view.fileClicked(picked.index);
    } else if (picked.kind === 'claude') {
      this.view.hideTooltip();
      this.view.sparkClicked(picked.index);
    }
    this.view.wake();
  }

  private async pickAt(x: number, y: number, reason: 'hover' | 'click'): Promise<void> {
    const { camera, width, height, scene, renderer } = this.stage;
    this.inFlight++;
    try {
      let seen: LastPick | undefined;
      const run = async (): Promise<Picked | undefined> => {
        const world = this.world();
        if (!world) return undefined;
        camera.updateMatrixWorld();
        const view = camera.matrixWorld.clone();
        const projection = camera.projectionMatrix.clone();
        const picked = await this.picker.pick(camera, x, y, width, height, world.uniforms, scene, (on) => world.setPickPass(on));
        if (picked) seen = { x: Math.floor(x), y: Math.floor(y), picked, world, view, projection };
        return picked;
      };
      const result = this.queue.then(run);
      this.queue = result.catch(() => undefined);
      const picked = await result;
      if (!picked || !seen || seen.world !== this.world()) return;
      this.last = seen;
      if (reason === 'click') {
        this.clicked(seen.world, picked);
        return;
      }
      if (!this.pointer || this.dragging) return; // left the canvas, or started a drag, meanwhile: the hover was already cleared
      const tip = seen.world.hover(picked);
      if (tip && this.pointer) this.view.showTooltip(this.pointer.clientX, this.pointer.clientY, tip.title, tip.detail);
      else this.view.hideTooltip();
      renderer.domElement.style.cursor = picked.kind === 'none' ? '' : 'pointer';
      this.view.wake();
    } finally {
      this.inFlight--;
    }
  }
}
