import * as THREE from 'three';
import { PICK_CLAUDE_BASE, PICK_CLUSTER_BASE, type SharedUniforms } from './uniforms';

/** What is under a pixel: a file, a directory bubble, one of Claude's stars (its index in the layer), or nothing. */
export type Picked = { kind: 'node'; index: number } | { kind: 'cluster'; index: number } | { kind: 'claude'; index: number } | { kind: 'none' };

/**
 * GPU picking. The id pass renders the scene's own meshes (id shaders swapped in)
 * for just the pixel under the pointer, via a camera view offset into a 1×1
 * target, then reads that pixel back asynchronously so the GPU never stalls.
 */
export class Picker {
  private readonly target = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    depthBuffer: true,
    generateMipmaps: false,
  });
  private readonly pixel = new Uint8Array(4);
  private readonly clearColor = new THREE.Color();
  private inFlight = false;

  constructor(private readonly renderer: THREE.WebGLRenderer) {}

  get busy(): boolean {
    return this.inFlight;
  }

  /**
   * (x, y) in CSS pixels from the top-left of a width × height viewport. `setPickPass`
   * switches the scene into and out of its id shaders. Undefined when a pick is already in flight.
   */
  async pick(
    camera: THREE.PerspectiveCamera,
    x: number,
    y: number,
    width: number,
    height: number,
    uniforms: SharedUniforms,
    scene: THREE.Scene,
    setPickPass: (on: boolean) => void,
  ): Promise<Picked | undefined> {
    if (x < 0 || y < 0 || x >= width || y >= height) return { kind: 'none' };
    if (this.inFlight) return undefined;
    this.inFlight = true;

    const renderer = this.renderer;
    const clearAlpha = renderer.getClearAlpha();
    const viewportHeight = uniforms.uViewportHeight.value;
    renderer.getClearColor(this.clearColor);

    camera.setViewOffset(width, height, Math.floor(x), Math.floor(y), 1, 1);
    uniforms.uViewportHeight.value = 1; // keeps the shaders' minimum-pixel-size rule identical to the visible pass
    setPickPass(true);
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.setClearColor(this.clearColor, clearAlpha);
    setPickPass(false);
    uniforms.uViewportHeight.value = viewportHeight;
    camera.clearViewOffset();

    try {
      await renderer.readRenderTargetPixelsAsync(this.target, 0, 0, 1, 1, this.pixel);
      const id = (this.pixel[0] << 16) | (this.pixel[1] << 8) | this.pixel[2];
      if (id === 0) return { kind: 'none' };
      if (id >= PICK_CLAUDE_BASE) return { kind: 'claude', index: id - PICK_CLAUDE_BASE };
      return id >= PICK_CLUSTER_BASE ? { kind: 'cluster', index: id - PICK_CLUSTER_BASE } : { kind: 'node', index: id - 1 };
    } finally {
      this.inFlight = false;
    }
  }

  dispose(): void {
    this.target.dispose();
  }
}
