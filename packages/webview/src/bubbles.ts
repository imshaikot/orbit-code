import * as THREE from 'three';
import type { DirView } from './dirView';
import { STATE_GLSL } from './nodeState';
import { ENCODE_ID_GLSL, FOCUS_GLSL, PICK_CLUSTER_BASE, type SharedUniforms } from './uniforms';

// One bubble per directory: instanced camera-facing quads shaded as glass, a faint fill that thickens
// toward a rim in the colour of the file type most of the directory is, unlike the solid files. While a
// directory's contents are shown, its sub-directories are drawn as bubbles and the directory itself as a
// faint frame around them. One level further down, their own sub-directories show through them as glass
// outlines, and fainter one level below that, so the nesting reads while zoomed out. A bubble brightens while
// Claude works on files anywhere inside it. The directories beside the one looked into (its parent's other
// sub-directories) stay as ghosts, a faint rim each, so the view inside a directory keeps its place among its neighbours.

/** aParent of a directory never drawn: a skipped one, or the root, whose contents fill the whole view anyway. */
const SKIPPED = -2;
/** How strongly a directory's sub-directories show through its bubble, one level up, before the view zooms in. */
const PREVIEW = 0.9;
/** And two levels up, inside a sub-directory bubble of the directory on screen. */
const DEEP_PREVIEW = 0.45;
/** How strongly the directories beside the one looked into show, as rims. */
const GHOST = 0.6;
/** However small a bubble is on screen, its rim stays at least this many CSS pixels wide. */
const RIM_PX = 2.2;

const VERTEX = /* glsl */ `
${STATE_GLSL}
${FOCUS_GLSL}
uniform float uHoverCluster;
uniform float uViewportHeight;
attribute vec3 aColor;
attribute float aActiveAt;
attribute float aParent;
attribute float aOuter;
attribute float aDeep;
varying vec2 vCorner;
varying vec3 vColor;
varying float vActive;
varying float vHover;
varying float vBody;
varying float vFrame;
varying float vPreview;
varying float vGhost;
varying float vNear;
varying float vRimScale;
flat varying float vId;

void main() {
  float id = float(gl_InstanceID);
  float body = aParent < -0.5 ? 0.0 : shownIn(aParent);
  float frame = aParent < -1.5 ? 0.0 : shownIn(id);
  float ghost = aParent < -0.5 ? 0.0 : ${GHOST.toFixed(2)} * besideShown(id, aParent);
  // Shown inside its parent's bubble while the directory around that one is on screen, fainter one level further out.
  float preview = max(aOuter < -0.5 ? 0.0 : ${PREVIEW.toFixed(2)} * shownIn(aOuter), aDeep < -0.5 ? 0.0 : ${DEEP_PREVIEW.toFixed(2)} * shownIn(aDeep));
  // The Flat view has no directories: bubbles fade as the files leave them, and take no clicks there.
  float nested = 1.0 - smoothstep(0.0, 0.45, uFlatMix);
#ifdef PICK
  // Only the sub-directories of the directory on screen take clicks.
  if (aParent < -0.5 || isDir(aParent, shownDir()) < 0.5 || uFlatMix >= 0.5) {
#else
  if ((body + frame + preview + ghost) * nested < 0.01) {
#endif
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  float radius = instanceMatrix[0][0];
  vec4 viewPosition = modelViewMatrix * vec4(instanceMatrix[3].xyz, 1.0);
  // A bubble the camera is inside of, or almost, would wash over the whole view: fade it out.
  vNear = smoothstep(1.15, 2.4, -viewPosition.z / radius);
  // The rim is a share of the radius, widened for a bubble small on screen so it never thins below RIM_PX.
  float radiusPx = radius * projectionMatrix[1][1] * uViewportHeight * 0.5 / max(-viewPosition.z, 1e-3);
  vRimScale = clamp(${RIM_PX.toFixed(2)} / (0.08 * radiusPx), 1.0, 5.0);
  viewPosition.xy += position.xy * radius;
  gl_Position = projectionMatrix * viewPosition;

  float dt = uTime - aActiveAt;
  vActive = aActiveAt < 0.0 || dt < 0.0 ? 0.0 : (0.35 + 0.65 * exp(-dt * 0.8)) * restFade(aActiveAt);
  vHover = abs(id - uHoverCluster) < 0.5 ? 1.0 : 0.0;
  vBody = body * nested;
  vFrame = frame * nested;
  vPreview = preview * nested;
  vGhost = ghost * nested;
  vCorner = position.xy;
  vColor = aColor;
  vId = id + ${PICK_CLUSTER_BASE}.0;
}
`;

const FRAGMENT = /* glsl */ `
${ENCODE_ID_GLSL}
uniform vec3 uReadColor;
varying vec2 vCorner;
varying vec3 vColor;
varying float vActive;
varying float vHover;
varying float vBody;
varying float vFrame;
varying float vPreview;
varying float vGhost;
varying float vNear;
varying float vRimScale;
flat varying float vId;

void main() {
  float d = length(vCorner);
  if (d > 1.0) discard;
#ifdef PICK
  if (vNear < 0.5) discard;
  gl_FragColor = encodeId(vId);
#else
  float z = sqrt(max(0.0, 1.0 - d * d));
  float fresnel = pow(1.0 - z, 2.2);
  float peak = 1.0 - 0.018 * vRimScale;
  float rim = smoothstep(1.0 - 0.08 * vRimScale, peak, d) * (1.0 - smoothstep(peak, 1.0, d));
  // A soft highlight toward the key light the files are lit from.
  float gloss = pow(max(dot(vec3(vCorner, z), vec3(-0.45, 0.6, 0.66)), 0.0), 48.0);
  vec3 color = mix(vColor, uReadColor, vActive * 0.7);
  float glow = (fresnel + rim) * vActive * 0.5;
  float body = (0.04 + 0.34 * fresnel + 0.5 * rim + 0.16 * gloss) * (1.0 + 0.9 * vHover) + glow;
  float frame = rim * 0.2 + fresnel * 0.04;
  // Mostly rim, with little fill, so the files and lines inside stay readable through it.
  float preview = 0.03 + 0.2 * fresnel + 0.5 * rim + glow;
  // A neighbour of the directory looked into: its rim alone, like the frame, plus the glow of Claude working in it.
  float ghost = rim * 0.2 + fresnel * 0.03 + glow;
  gl_FragColor = vec4(color * (body * vBody + frame * vFrame + preview * vPreview + ghost * vGhost) * vNear, 1.0);
#endif
}
`;

export class Bubbles {
  readonly mesh: THREE.InstancedMesh;
  private readonly visibleMaterial: THREE.ShaderMaterial;
  private readonly pickMaterial: THREE.ShaderMaterial;
  private readonly geometry: THREE.BufferGeometry;
  private readonly activeAt: THREE.InstancedBufferAttribute;

  /** `colors`: rgb per directory, the colour of the file type most of its files are. */
  constructor(
    centers: Float32Array,
    radii: Float32Array,
    colors: Float32Array,
    private readonly view: DirView,
    uniforms: SharedUniforms,
  ) {
    const count = radii.length;
    this.geometry = new THREE.PlaneGeometry(2, 2);
    this.geometry.deleteAttribute('normal');
    this.geometry.deleteAttribute('uv');
    const parents = new Float32Array(count);
    const outers = new Float32Array(count);
    const deeps = new Float32Array(count);
    for (let c = 0; c < count; c++) {
      const p = view.viewParent[c];
      parents[c] = !view.shown[c] || p < 0 ? SKIPPED : p;
      outers[c] = parents[c] < 0 ? -1 : view.viewParent[p];
      deeps[c] = outers[c] < 0 ? -1 : view.viewParent[outers[c]];
    }
    this.geometry.setAttribute('aColor', new THREE.InstancedBufferAttribute(colors, 3));
    this.geometry.setAttribute('aParent', new THREE.InstancedBufferAttribute(parents, 1));
    this.geometry.setAttribute('aOuter', new THREE.InstancedBufferAttribute(outers, 1));
    this.geometry.setAttribute('aDeep', new THREE.InstancedBufferAttribute(deeps, 1));
    this.activeAt = new THREE.InstancedBufferAttribute(new Float32Array(count).fill(-1), 1);
    this.geometry.setAttribute('aActiveAt', this.activeAt);

    this.visibleMaterial = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: { ...uniforms },
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    this.pickMaterial = new THREE.ShaderMaterial({ vertexShader: VERTEX, fragmentShader: FRAGMENT, uniforms: { ...uniforms }, defines: { PICK: '' } });
    this.mesh = new THREE.InstancedMesh(this.geometry, this.visibleMaterial, count);
    const matrices = this.mesh.instanceMatrix.array as Float32Array;
    for (let c = 0; c < count; c++) {
      const o = c * 16;
      matrices[o] = radii[c];
      matrices[o + 5] = radii[c];
      matrices[o + 10] = radii[c];
      matrices[o + 12] = centers[c * 3];
      matrices[o + 13] = centers[c * 3 + 1];
      matrices[o + 14] = centers[c * 3 + 2];
    }
    this.mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  /** Switches the mesh to its id-pass shaders for the 1×1 pick render, and back. */
  setPickPass(on: boolean): void {
    this.mesh.material = on ? this.pickMaterial : this.visibleMaterial;
  }

  /** Claude is working on a file in `cluster`: that bubble and every one around it light up. */
  touch(cluster: number, at: number): void {
    for (let c = cluster; c >= 0; c = this.view.parent[c]) this.activeAt.array[c] = at;
    this.activeAt.needsUpdate = true;
  }

  /** Takes over when each bubble last lit up. `clusterRemap`: previous cluster → cluster here, or -1. */
  adopt(previous: Bubbles, clusterRemap: Int32Array): void {
    for (let c = 0; c < clusterRemap.length; c++) {
      if (clusterRemap[c] >= 0) this.activeAt.array[clusterRemap[c]] = previous.activeAt.array[c];
    }
    this.activeAt.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.visibleMaterial.dispose();
    this.pickMaterial.dispose();
    this.mesh.dispose();
  }
}
