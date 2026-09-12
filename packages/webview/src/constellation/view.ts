import * as THREE from 'three';
import { type CoreInstance, CoreMesh, type GlyphInstance, GlyphMesh, type GlowUniforms, type LinkInstance, LinkMesh, type Point, gyroscopeTemplate, stationTemplate, tesseractTemplate } from './glyphs';

export interface Field {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A point to frame in the field, with the radius around it that must fit too. */
export interface FitPoint extends Point {
  pad: number;
}

/** Glyphs by kind: a tesseract per skill, a gyroscope per conversation, a 16-cell per MCP server. */
export interface Glyphs {
  tesseracts: readonly GlyphInstance[];
  gyroscopes: readonly GlyphInstance[];
  stations?: readonly GlyphInstance[];
}

const FOV = 36;

/**
 * The constellations' own WebGL canvas: transparent, over the whole viewport and under no pointer, so a skill dragged
 * out of its panel is still drawn on its way to the composer. The camera frames the graph inside the panel's field:
 * its projection is scaled and shifted so the field's centre is the centre of the view. The renderer is created on
 * first use, and only while a panel is open does anything render.
 */
export class ConstellationView {
  readonly canvas = document.createElement('canvas');
  readonly camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 4000);
  private renderer: THREE.WebGLRenderer | undefined;
  private failed = false;
  private readonly scene = new THREE.Scene();
  private readonly uniforms: GlowUniforms = { uTime: { value: 0 }, uViewport: { value: new THREE.Vector2(1, 1) }, uPixelRatio: { value: 1 } };
  private meshes: { tesseracts: GlyphMesh; gyroscopes: GlyphMesh; stations: GlyphMesh; cores: CoreMesh; links: LinkMesh } | undefined;
  private viewport = { width: 1, height: 1, ratio: 0 };
  private field: Field = { left: 0, top: 0, width: 1, height: 1 };
  private readonly shift = new THREE.Matrix4();
  private readonly v = new THREE.Vector3();
  private readonly w = new THREE.Vector3();

  constructor(host: HTMLElement, onLost: () => void) {
    this.canvas.className = 'constellation-canvas';
    this.canvas.hidden = true;
    this.canvas.setAttribute('aria-hidden', 'true');
    host.append(this.canvas);
    this.canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      this.failed = true;
      this.canvas.hidden = true;
      onLost();
    });
  }

  /** Whether glyphs can be drawn; creates the renderer the first time. */
  get ready(): boolean {
    if (this.renderer) return true;
    if (this.failed) return false;
    try {
      this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true, premultipliedAlpha: true, powerPreference: 'low-power' });
    } catch {
      this.failed = true;
      return false;
    }
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.autoClear = false;
    this.meshes = {
      tesseracts: new GlyphMesh(tesseractTemplate(), this.uniforms, 0.55, 1.5),
      gyroscopes: new GlyphMesh(gyroscopeTemplate(), this.uniforms, 0.4, 1.2),
      stations: new GlyphMesh(stationTemplate(), this.uniforms, 0.35, 1.4),
      cores: new CoreMesh(this.uniforms),
      links: new LinkMesh(this.uniforms),
    };
    this.scene.add(this.meshes.links.mesh, this.meshes.cores.mesh, this.meshes.tesseracts.mesh, this.meshes.gyroscopes.mesh, this.meshes.stations.mesh);
    this.viewport.ratio = 0;
    return true;
  }

  setVisible(visible: boolean): void {
    this.canvas.hidden = !visible || this.failed;
  }

  /** The viewport and the field the graph is framed in, in CSS pixels. Cheap when neither changed. */
  place(width: number, height: number, field: Field): void {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const resized = width !== this.viewport.width || height !== this.viewport.height || ratio !== this.viewport.ratio;
    if (resized) {
      this.viewport = { width, height, ratio };
      this.renderer?.setPixelRatio(ratio);
      this.renderer?.setSize(width, height, false);
      this.uniforms.uViewport.value.set(width * ratio, height * ratio);
      this.uniforms.uPixelRatio.value = ratio;
    }
    const f = this.field;
    if (!resized && f.left === field.left && f.top === field.top && f.width === field.width && f.height === field.height) return;
    this.field = { ...field };
    this.camera.aspect = Math.max(1, field.width) / Math.max(1, field.height);
    this.camera.updateProjectionMatrix();
    const tx = ((field.left + field.width / 2) / width) * 2 - 1;
    const ty = 1 - ((field.top + field.height / 2) / height) * 2;
    this.shift.set(field.width / width, 0, 0, tx, 0, field.height / height, 0, ty, 0, 0, 1, 0, 0, 0, 0, 1);
    this.camera.projectionMatrix.premultiply(this.shift);
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
  }

  /**
   * How far from the origin the camera must be for every point, and `pad` world units around it, to sit inside the field
   * `margin` CSS pixels clear of its edges, looking from each of `angles` about the vertical at `elevation` (radians).
   * Points turned toward the camera come out larger, so a point's depth counts as well as its offset.
   */
  fitDistance(points: readonly FitPoint[], angles: readonly number[], elevation: number, margin: { x: number; y: number }): number {
    const vertical = Math.tan(THREE.MathUtils.degToRad(FOV) / 2);
    const { width, height } = this.field;
    const tanUp = vertical * Math.max(0.3, 1 - (2 * margin.y) / Math.max(1, height));
    const tanAcross = vertical * this.camera.aspect * Math.max(0.3, 1 - (2 * margin.x) / Math.max(1, width));
    const ce = Math.cos(elevation);
    const se = Math.sin(elevation);
    let distance = 1;
    for (const angle of angles) {
      const ca = Math.cos(angle);
      const sa = Math.sin(angle);
      for (const { x, y, z, pad } of points) {
        // The point in the camera's own axes: right, up, and toward the camera.
        const across = x * ca - z * sa;
        const up = -x * sa * se + y * ce - z * ca * se;
        const toward = x * sa * ce + y * se + z * ca * ce + pad;
        distance = Math.max(distance, (Math.abs(across) + pad) / tanAcross + toward, (Math.abs(up) + pad) / tanUp + toward);
      }
    }
    return distance;
  }

  /** Looks at `centre` (the origin unless zoomed toward a spot) from `distance` away, turned `angle` about the vertical and raised `elevation` (radians). */
  aim(distance: number, angle: number, elevation: number, centre: Point = { x: 0, y: 0, z: 0 }): void {
    this.camera.position.set(
      centre.x + Math.sin(angle) * Math.cos(elevation) * distance,
      centre.y + Math.sin(elevation) * distance,
      centre.z + Math.cos(angle) * Math.cos(elevation) * distance,
    );
    this.camera.lookAt(centre.x, centre.y, centre.z);
    this.camera.updateMatrixWorld();
  }

  /** Draws a frame; with `clip`, only inside the field, so nothing zoomed or turned past its edges shows outside the panel. */
  render(time: number, glyphs: Glyphs, cores: readonly CoreInstance[], links: readonly LinkInstance[], clip: boolean): void {
    if (!this.ready || !this.renderer || !this.meshes || this.canvas.hidden) return;
    this.uniforms.uTime.value = time;
    this.meshes.tesseracts.set(glyphs.tesseracts);
    this.meshes.gyroscopes.set(glyphs.gyroscopes);
    this.meshes.stations.set(glyphs.stations ?? []);
    this.meshes.cores.set(cores);
    this.meshes.links.set(links);
    const renderer = this.renderer;
    // The scissor limits the clear too, so the whole canvas is cleared first.
    renderer.setScissorTest(false);
    renderer.clear();
    if (clip) {
      const f = this.field;
      renderer.setScissor(f.left, this.viewport.height - f.top - f.height, f.width, f.height);
      renderer.setScissorTest(true);
    }
    renderer.render(this.scene, this.camera);
    renderer.setScissorTest(false);
  }

  /** Where a point is on screen (client pixels), and how many pixels `radius` world units span there. */
  project(point: Point, radius: number): { x: number; y: number; pixels: number; inFront: boolean } {
    const { width, height } = this.viewport;
    const at = this.v.set(point.x, point.y, point.z).project(this.camera);
    const x = ((at.x + 1) / 2) * width;
    const y = ((1 - at.y) / 2) * height;
    const inFront = at.z < 1;
    const edge = this.w.setFromMatrixColumn(this.camera.matrixWorld, 0).multiplyScalar(radius).add(this.v.set(point.x, point.y, point.z)).project(this.camera);
    const pixels = Math.hypot(((edge.x + 1) / 2) * width - x, ((1 - edge.y) / 2) * height - y);
    return { x, y, pixels, inFront };
  }

  /** The point under client pixel (x, y) at the depth of `through`, on the plane facing the camera. */
  unproject(x: number, y: number, through: Point): Point {
    const { width, height } = this.viewport;
    const origin = this.camera.position;
    const direction = this.v.set((x / width) * 2 - 1, 1 - (y / height) * 2, 0.5).unproject(this.camera).sub(origin).normalize();
    const forward = this.camera.getWorldDirection(this.w);
    const depth = (through.x - origin.x) * forward.x + (through.y - origin.y) * forward.y + (through.z - origin.z) * forward.z;
    const along = depth / Math.max(1e-6, direction.dot(forward));
    return { x: origin.x + direction.x * along, y: origin.y + direction.y * along, z: origin.z + direction.z * along };
  }

  dispose(): void {
    if (!this.meshes) return;
    for (const mesh of Object.values(this.meshes)) mesh.dispose();
    this.renderer?.dispose();
  }
}
