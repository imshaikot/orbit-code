import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Sphere } from './focus';

/** Zoom per unit of wheel delta, on a log scale: a 100-unit notch is about 8 %. */
const ZOOM_PER_UNIT = 0.0008;
/** A wheel delta given in lines or pages, as pixels. */
const LINE_PX = 16;
/** How fast a pending zoom plays out, per second: a notch is mostly done within 150 ms. */
const RATE = 14;
/** How strongly zooming in draws the bubble under the pointer to the middle of the screen: zooming in 2.7× brings it 92 % of the way. */
const PULL = 2.5;
/** Pending zoom below this is dropped. */
const EPSILON = 1e-4;

export interface ZoomView {
  /** The bubble under the pointer, if it is a sub-directory of the directory in view: zooming in draws it to the middle. */
  anchor(): Sphere | undefined;
  /** The file under the pointer when zooming should close in on it (the Flat view): how far it is, and how near the camera may come. */
  under?(): { distance: number; closest: number } | undefined;
  /** Whether a wheel event may zoom right now (not while a camera move plays). */
  allowed(): boolean;
  /** A frame is due. */
  wake(): void;
}

const direction = new THREE.Vector3();
const forward = new THREE.Vector3();
const offset = new THREE.Vector3();

/**
 * Wheel zoom played out over the following frames instead of jumping per event: each frame applies a share of what is
 * pending, toward the point under the pointer, which so stays put on screen while everything else grows around it (what
 * OrbitControls' zoomToCursor does, but eased, and rendered at the smooth pace). Zooming in over a sub-directory bubble
 * also draws that bubble toward the middle of the screen, so zooming into a bubble ends up framing it, and the view
 * opens it (focus.ts). The orbit target stays straight ahead at the new distance, so a drag afterwards orbits what is in
 * the middle of the screen.
 */
export class SmoothZoom {
  private pending = 0;
  private readonly cursor = new THREE.Vector2();

  constructor(
    canvas: HTMLElement,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly controls: OrbitControls,
    private readonly view: ZoomView,
  ) {
    canvas.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        if (!view.allowed()) return;
        const units =
          event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * LINE_PX : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? event.deltaY * canvas.clientHeight : event.deltaY;
        this.pending -= units * ZOOM_PER_UNIT;
        this.cursor.set((event.offsetX / canvas.clientWidth) * 2 - 1, 1 - (event.offsetY / canvas.clientHeight) * 2);
        view.wake();
      },
      { passive: false },
    );
  }

  /** Whether zoom is still pending, so frames must keep coming. */
  get active(): boolean {
    return Math.abs(this.pending) > EPSILON;
  }

  /** Drops what is left of the gesture: a click started a camera move. */
  cancel(): void {
    this.pending = 0;
  }

  /** Plays out a share of the pending zoom. True when the camera moved. */
  update(dt: number): boolean {
    if (!this.active) {
      this.pending = 0;
      return false;
    }
    let step = this.pending * (1 - Math.exp(-dt * RATE));
    if (Math.abs(this.pending - step) < EPSILON) step = this.pending;
    this.pending -= step;

    const { camera, controls } = this;
    // Measured from a file under the pointer nearer than the orbit target, the zoom closes in on that file and never flies past it.
    const under = this.view.under?.();
    const onFile = under !== undefined && under.distance < camera.position.distanceTo(controls.target);
    const radius = onFile ? under.distance : camera.position.distanceTo(controls.target);
    const nearest = Math.max(controls.minDistance, onFile ? under.closest : 0);
    if (step > 0 && radius <= nearest) {
      this.pending = 0;
      return false;
    }
    const next = THREE.MathUtils.clamp(radius * Math.exp(-step), nearest, controls.maxDistance);
    if (next === radius) return false;
    // Along the ray through the pointer, so the point under it stays put on screen.
    camera.updateMatrixWorld();
    direction.set(this.cursor.x, this.cursor.y, 0.5).unproject(camera).sub(camera.position).normalize();
    camera.position.addScaledVector(direction, radius - next);
    camera.getWorldDirection(forward);
    controls.target.copy(camera.position).addScaledVector(forward, next);

    const anchor = step > 0 ? this.view.anchor() : undefined;
    if (anchor) {
      // The bubble's offset from the middle of the screen; this step closes a share of it, camera and target together.
      offset.subVectors(anchor.center, camera.position);
      const depth = offset.dot(forward);
      if (depth > 0) {
        offset.addScaledVector(forward, -depth).multiplyScalar(1 - Math.exp(-step * PULL));
        camera.position.add(offset);
        controls.target.add(offset);
      }
    }
    return true;
  }
}
