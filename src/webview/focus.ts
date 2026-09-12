import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { SharedUniforms } from './uniforms';

/** A camera move eases out: most of the way in the first third, then it settles, so a click answers at once. */
const DURATION_MS = 600;
/**
 * Zooming from framing a directory to framing one of its sub-directories, measured on a log scale from 0 to 1:
 * the sub-directory's contents start to show at REVEAL_START and it opens at REVEAL_END. Zooming back out
 * retraces the same curve, so nothing jumps either way.
 */
const REVEAL_START = 0.25;
const REVEAL_END = 0.9;

export interface Sphere {
  center: THREE.Vector3;
  radius: number;
}

/** The directories the view moves through (DirView). */
export interface FocusTree {
  readonly viewParent: Int32Array;
  readonly children: number[][];
}

interface Tween {
  start: number;
  fromPosition: THREE.Vector3;
  toPosition: THREE.Vector3;
  fromTarget: THREE.Vector3;
  toTarget: THREE.Vector3;
  /** The directory being framed: only its path opens on the way. -1 once a live update has dropped it. */
  to: number;
}

/**
 * Which directory's contents are on screen, decided by the camera. Zooming toward a sub-directory bubble (the one
 * around the orbit target) fades its contents in with the zoom, and far enough in it opens; zooming back out fades
 * them out again and backs out to the parent. uFocusFrom and uFocus name the outer and inner directory of that
 * crossfade, uFocusMix how far it has gone. Clicks, Esc and the breadcrumb only move the camera.
 */
export class Focus {
  /** The directory whose contents are on screen: the inner one once the crossfade is past half way. */
  cluster: number;
  /** The directory the camera is inside of, on the way into one of its sub-directories or not. */
  private open: number;
  private tween: Tween | undefined;
  private changed = false;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly controls: OrbitControls,
    private readonly uniforms: SharedUniforms,
    private readonly sphereOf: (cluster: number) => Sphere,
    private readonly tree: FocusTree,
    root: number,
  ) {
    this.cluster = root;
    this.open = root;
    this.show(root, root, 1);
  }

  get animating(): boolean {
    return this.tween !== undefined;
  }

  /** The directory the camera is inside of; a live update carries it over. */
  get opened(): number {
    return this.open;
  }

  /** Whether `cluster` changed since the last call. */
  consumeChanged(): boolean {
    const changed = this.changed;
    this.changed = false;
    return changed;
  }

  /** Moves the camera to frame a directory. Opening it, or backing out to it, follows from the zoom. */
  go(cluster: number, animate: boolean): void {
    const sphere = this.sphereOf(cluster);
    const direction = new THREE.Vector3().subVectors(this.camera.position, this.controls.target);
    if (direction.lengthSq() < 1e-6) direction.set(0.3, 0.42, 1);
    direction.normalize();
    const toPosition = sphere.center.clone().addScaledVector(direction, fitDistance(sphere.radius, this.camera));

    if (!animate) {
      this.tween = undefined;
      this.camera.position.copy(toPosition);
      this.controls.target.copy(sphere.center);
      this.controls.update();
      this.sync();
      return;
    }
    this.tween = {
      start: performance.now(),
      fromPosition: this.camera.position.clone(),
      toPosition,
      fromTarget: this.controls.target.clone(),
      toTarget: sphere.center.clone(),
      to: cluster,
    };
    this.controls.enabled = false;
  }

  /**
   * Takes over from the Focus of the graph this one replaces, camera untouched: the directory the camera is inside of
   * (`open`, its index here) and any camera move in progress, its destination mapped through `cluster` (-1 when gone).
   * `moved`: that directory is gone, so the camera backs out to `open`.
   */
  adopt(previous: Focus, open: number, moved: boolean, cluster: (c: number) => number): void {
    this.tween = previous.tween && { ...previous.tween, to: cluster(previous.tween.to) };
    this.open = open;
    this.cluster = previous.cluster;
    if (moved) this.go(open, true);
    this.sync();
    this.changed = true;
  }

  /** Advances the camera tween, then derives what is on screen from the zoom. True while the tween runs. */
  update(now: number): boolean {
    const tween = this.tween;
    if (tween) {
      const t = Math.min(1, (now - tween.start) / DURATION_MS);
      const eased = 1 - Math.pow(1 - t, 3);
      this.camera.position.lerpVectors(tween.fromPosition, tween.toPosition, eased);
      this.controls.target.lerpVectors(tween.fromTarget, tween.toTarget, eased);
      this.camera.lookAt(this.controls.target);
      if (t >= 1) {
        this.tween = undefined;
        this.controls.enabled = true;
        this.controls.update();
      }
    }
    this.sync();
    return tween !== undefined;
  }

  private sync(): void {
    const target = this.controls.target;
    const distance = this.camera.position.distanceTo(target);
    const destination = this.tween?.to ?? -1;
    // Zoomed out past where the open directory fully shows: its parent's contents return, and further out the parent
    // opens. An open directory is also left at once when a bubble beside it has taken the orbit target (zooming
    // toward a neighbour), or when it is off the path of a camera move: what it shows is no longer where the camera looks.
    for (let parent = this.tree.viewParent[this.open]; parent >= 0; parent = this.tree.viewParent[this.open]) {
      if (destination >= 0 && !this.onPath(this.open, destination)) {
        this.open = parent;
        continue;
      }
      const reveal = this.reveal(parent, this.open, distance);
      const rival = reveal >= 1 ? this.childAround(parent, target) : -1;
      if (reveal >= 1 && (rival < 0 || rival === this.open)) break;
      if (reveal > 0 && reveal < 1) return this.show(parent, this.open, reveal);
      this.open = parent;
    }
    // Zoomed in on a sub-directory: its contents fade in with the zoom, and at the end it opens. A camera move opens
    // only the directories on the way to the one it frames: the orbit target crosses other bubbles on the way there.
    for (;;) {
      const child = destination >= 0 ? this.towards(this.open, destination) : this.childAround(this.open, target);
      const reveal = child < 0 ? 0 : this.reveal(this.open, child, distance);
      if (reveal < 1) return reveal > 0 ? this.show(this.open, child, reveal) : this.show(this.open, this.open, 1);
      this.open = child;
    }
  }

  /** 0 → 1 as the camera zooms from framing `outer` to framing `inner`, eased. */
  private reveal(outer: number, inner: number, distance: number): number {
    const outerRadius = this.sphereOf(outer).radius;
    const span = Math.log(outerRadius / this.sphereOf(inner).radius);
    const zoom = Math.log(fitDistance(outerRadius, this.camera) / distance);
    if (span < 1e-3) return zoom >= 0 ? 1 : 0;
    const x = THREE.MathUtils.clamp((zoom / span - REVEAL_START) / (REVEAL_END - REVEAL_START), 0, 1);
    return x * x * (3 - 2 * x);
  }

  /** The sub-directory of `cluster` whose bubble holds `point`, or -1. */
  private childAround(cluster: number, point: THREE.Vector3): number {
    for (const child of this.tree.children[cluster]) {
      const { center, radius } = this.sphereOf(child);
      if (center.distanceToSquared(point) <= radius * radius) return child;
    }
    return -1;
  }

  /** The sub-directory of `cluster` on the way down to `destination`, or -1 when `destination` isn't below it. */
  private towards(cluster: number, destination: number): number {
    for (let at = destination; at >= 0; at = this.tree.viewParent[at]) if (this.tree.viewParent[at] === cluster) return at;
    return -1;
  }

  /** Whether `cluster` lies on the path to `destination`: the destination itself, above it, or below it. */
  private onPath(cluster: number, destination: number): boolean {
    for (let at = destination; at >= 0; at = this.tree.viewParent[at]) if (at === cluster) return true;
    for (let at = cluster; at >= 0; at = this.tree.viewParent[at]) if (at === destination) return true;
    return false;
  }

  private show(outer: number, inner: number, mix: number): void {
    const { uniforms, tree } = this;
    uniforms.uFocusFrom.value = outer;
    uniforms.uFocus.value = inner;
    uniforms.uFocusMix.value = mix;
    // The directories around them, whose other sub-directories show as ghosts (bubbles.ts).
    uniforms.uFocusFromParent.value = tree.viewParent[outer];
    uniforms.uFocusParent.value = tree.viewParent[inner];
    const shown = mix >= 0.5 ? inner : outer;
    if (shown !== this.cluster) {
      this.cluster = shown;
      this.changed = true;
    }
  }
}

function fitDistance(radius: number, camera: THREE.PerspectiveCamera): number {
  const vertical = THREE.MathUtils.degToRad(camera.fov) / 2;
  const horizontal = Math.atan(Math.tan(vertical) * camera.aspect);
  return (radius * 1.08) / Math.sin(Math.min(vertical, horizontal));
}
