import * as THREE from 'three';
import { type CoreInstance, CoreMesh, type GlyphInstance, GlyphMesh, type GlowUniforms, type LinkInstance, LinkMesh, type Point, gyroscopeTemplate, tesseractTemplate } from './glyphs';

export interface Field {
  left: number;
  top: number;
  width: number;
  height: number;
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
  private meshes: { tesseracts: GlyphMesh; gyroscopes: GlyphMesh; cores: CoreMesh; links: LinkMesh } | undefined;
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
    this.meshes = {
      tesseracts: new GlyphMesh(tesseractTemplate(), this.uniforms, 0.55, 1.5),
      gyroscopes: new GlyphMesh(gyroscopeTemplate(), this.uniforms, 0.4, 1.2),
      cores: new CoreMesh(this.uniforms),
      links: new LinkMesh(this.uniforms),
    };
    this.scene.add(this.meshes.links.mesh, this.meshes.cores.mesh, this.meshes.tesseracts.mesh, this.meshes.gyroscopes.mesh);
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

  /** How far away the camera must be for a box around the origin (half extents across, up, and in depth) to fit the field. */
  fitDistance(across: number, up: number, depth: number): number {
    const vertical = THREE.MathUtils.degToRad(FOV) / 2;
    const horizontal = Math.atan(Math.tan(vertical) * this.camera.aspect);
    return Math.max(across / Math.tan(horizontal), up / Math.tan(vertical)) + depth;
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

  render(time: number, glyphs: { tesseracts: readonly GlyphInstance[]; gyroscopes: readonly GlyphInstance[] }, cores: readonly CoreInstance[], links: readonly LinkInstance[]): void {
    if (!this.ready || !this.renderer || !this.meshes || this.canvas.hidden) return;
    this.uniforms.uTime.value = time;
    this.meshes.tesseracts.set(glyphs.tesseracts);
    this.meshes.gyroscopes.set(glyphs.gyroscopes);
    this.meshes.cores.set(cores);
    this.meshes.links.set(links);
    this.renderer.render(this.scene, this.camera);
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
