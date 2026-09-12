import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { PALETTE } from './palette';

const PIXEL_RATIOS = [2, 1.5, 1];
const SLOW_FRAME_MS = 45;
const SLOW_FRAMES_BEFORE_DEGRADE = 45;

/** Renderer, camera and controls. Knows nothing about graphs. */
export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(50, 1, 0.5, 20000);
  readonly controls: OrbitControls;
  width = 1;
  height = 1;
  private pixelRatioStep: number;
  private slowFrames = 0;

  /** `onResize` fires on later size changes, not for the initial sizing inside the constructor. */
  constructor(host: HTMLElement, private readonly onResize: () => void, onContextLost: () => void) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setClearColor(PALETTE.dome, 1);
    this.renderer.domElement.className = 'stage';
    this.renderer.domElement.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      onContextLost();
    });
    host.appendChild(this.renderer.domElement);

    const initial = Math.min(window.devicePixelRatio || 1, 2);
    this.pixelRatioStep = Math.max(0, PIXEL_RATIOS.findIndex((ratio) => ratio <= initial));
    this.renderer.setPixelRatio(this.pixelRatio);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.rotateSpeed = 0.6;
    this.controls.zoomSpeed = 0.9;
    this.controls.screenSpacePanning = true;
    // The wheel is SmoothZoom's (zoom.ts): eased over frames and toward the pointer, so zooming in on a bubble opens it (focus.ts).
    this.controls.enableZoom = false;
    // The orbit is free all the way around: every file, bubble, star and label is camera-facing, and a click's camera
    // move (focus.ts) keeps the direction the camera already has, so the graph reads from any side.

    new ResizeObserver(() => this.resize(host, true)).observe(host);
    this.resize(host, false);
  }

  get pixelRatio(): number {
    return PIXEL_RATIOS[this.pixelRatioStep];
  }

  /**
   * Fed the interval between consecutive rendered frames. If 30 fps keeps
   * being missed, render fewer pixels. Returns true when it stepped down.
   */
  observeFrameInterval(intervalMs: number): boolean {
    this.slowFrames = intervalMs > SLOW_FRAME_MS ? this.slowFrames + 1 : Math.max(0, this.slowFrames - 1);
    if (this.slowFrames < SLOW_FRAMES_BEFORE_DEGRADE || this.pixelRatioStep >= PIXEL_RATIOS.length - 1) return false;
    this.slowFrames = 0;
    this.pixelRatioStep++;
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(this.width, this.height, false);
    return true;
  }

  private resize(host: HTMLElement, notify: boolean): void {
    this.width = Math.max(1, host.clientWidth);
    this.height = Math.max(1, host.clientHeight);
    this.renderer.setSize(this.width, this.height, false);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    if (notify) this.onResize();
  }
}
