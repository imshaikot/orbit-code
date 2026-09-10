import * as THREE from 'three';
import type { DirView } from './dirView';
import { STATE_GLSL } from './nodeState';
import { ENCODE_ID_GLSL, FOCUS_GLSL, PICK_CLUSTER_BASE, type SharedUniforms } from './uniforms';

// One bubble per directory: instanced camera-facing quads shaded as glass, a faint fill that thickens
// toward a rim in the colour of the file type most of the directory is, unlike the solid files. While a
// directory's contents are shown, its sub-directories are drawn as bubbles and the directory itself as a
// faint frame around them. A bubble brightens while Claude works on files anywhere inside it.

/** aParent of a directory never drawn: a skipped one, or the root, whose contents fill the whole view anyway. */
const SKIPPED = -2;

const VERTEX = /* glsl */ `
${STATE_GLSL}
${FOCUS_GLSL}
uniform float uHoverCluster;
attribute vec3 aColor;
attribute float aActiveAt;
attribute float aParent;
varying vec2 vCorner;
varying vec3 vColor;
varying float vActive;
varying float vHover;
varying float vBody;
varying float vFrame;
varying float vNear;
flat varying float vId;

void main() {
  float id = float(gl_InstanceID);
  float body = aParent < -0.5 ? 0.0 : shownIn(aParent);
  float frame = aParent < -1.5 ? 0.0 : shownIn(id);
#ifdef PICK
  // Only the sub-directories of the directory on screen take clicks.
  if (aParent < -0.5 || isDir(aParent, shownDir()) < 0.5) {
#else
  if (body + frame < 0.01) {
#endif
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  float radius = instanceMatrix[0][0];
  vec4 viewPosition = modelViewMatrix * vec4(instanceMatrix[3].xyz, 1.0);
  // A bubble the camera is inside of, or almost, would wash over the whole view: fade it out.
  vNear = smoothstep(1.15, 2.4, -viewPosition.z / radius);
  viewPosition.xy += position.xy * radius;
  gl_Position = projectionMatrix * viewPosition;

  float dt = uTime - aActiveAt;
  vActive = aActiveAt < 0.0 || dt < 0.0 ? 0.0 : (0.35 + 0.65 * exp(-dt * 0.8)) * restFade(aActiveAt);
  vHover = abs(id - uHoverCluster) < 0.5 ? 1.0 : 0.0;
  vBody = body;
  vFrame = frame;
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
varying float vNear;
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
  float rim = smoothstep(0.92, 0.982, d) * (1.0 - smoothstep(0.982, 1.0, d));
  // A soft highlight toward the key light the files are lit from.
  float gloss = pow(max(dot(vec3(vCorner, z), vec3(-0.45, 0.6, 0.66)), 0.0), 48.0);
  vec3 color = mix(vColor, uReadColor, vActive * 0.7);
  float body = (0.04 + 0.34 * fresnel + 0.5 * rim + 0.16 * gloss) * (1.0 + 0.9 * vHover) + (fresnel + rim) * vActive * 0.5;
  float frame = rim * 0.2 + fresnel * 0.04;
  gl_FragColor = vec4(color * (body * vBody + frame * vFrame) * vNear, 1.0);
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
    for (let c = 0; c < count; c++) {
      const p = view.viewParent[c];
      parents[c] = !view.shown[c] || p < 0 ? SKIPPED : p;
    }
    this.geometry.setAttribute('aColor', new THREE.InstancedBufferAttribute(colors, 3));
    this.geometry.setAttribute('aParent', new THREE.InstancedBufferAttribute(parents, 1));
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
