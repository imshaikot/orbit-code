import { nodeRadius } from '@orbit-code/graph/visual';
import * as THREE from 'three';
import { REMOVE_S, STATE_GLSL } from './nodeState';
import { PALETTE } from './palette';
import { ENCODE_ID_GLSL, FOCUS_GLSL, type SharedUniforms } from './uniforms';

// Every file is one instance of a single InstancedMesh: a camera-facing quad
// shaded as a sphere (2 triangles instead of a tessellated sphere), in the colour of
// its file type. A file is drawn
// while its directory's contents are shown, or while Claude is working on it. GPU
// picking renders this same mesh with the PICK variant of its shaders swapped in.

/** How strongly a directory's files show through its bubble, one level up, before the view zooms in. */
const PREVIEW = 0.6;
/** And two levels up, inside a sub-directory bubble of the directory on screen. */
const DEEP_PREVIEW = 0.3;

const VERTEX = /* glsl */ `
${STATE_GLSL}
${FOCUS_GLSL}
uniform float uHover;
uniform float uSelected;
uniform float uSelectedAt;
uniform float uViewportHeight;
attribute float aDir;
attribute float aOuter;
attribute float aDeep;
attribute vec3 aColor;
varying vec2 vCorner;
varying vec3 vColor;
varying float vQuad;
varying float vRead;
varying float vEdit;
varying float vRing;
varying float vShade;
varying float vSelect;
varying float vRemove;
varying float vCore;
flat varying float vId;

void main() {
  float id = float(gl_InstanceID);
  vec4 state = nodeState(id);
  float removed = removedFor(state);
  float read = readGlow(state);
  float edit = max(editPulse(state), addedPulse(state));
  float hovered = abs(id - uHover) < 0.5 ? 1.0 : 0.0;
  float selected = abs(id - uSelected) < 0.5 ? 1.0 : 0.0;
  // A file being deleted stays in sight while it collapses.
  float lit = removed >= 0.0 ? 1.0 : max(max(read, edit), max(hovered, selected));
  // Shown in its own directory, through that directory's bubble one and two levels up, and wherever Claude works on it.
  float preview = max(${PREVIEW.toFixed(2)} * shownIn(aOuter), ${DEEP_PREVIEW.toFixed(2)} * shownIn(aDeep));
  float shown = max(max(shownIn(aDir), preview), lit);

#ifdef PICK
  // Only the files of the directory on screen take clicks, and never one being deleted.
  if (isDir(aDir, shownDir()) < 0.5 || removed >= 0.0) {
#else
  if (shown < 0.01 || removed > ${REMOVE_S.toFixed(2)}) {
#endif
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  vec3 center = instanceMatrix[3].xyz;
  float scale = instanceMatrix[0][0] * (1.0 + 0.3 * read + 0.5 * edit + 0.3 * max(hovered, selected)) * mix(0.35, 1.0, shown);
  vec4 viewPosition = modelViewMatrix * vec4(center, 1.0);
  // Never let a file shrink below a few CSS px: however big the bubbles beside it, it can still be seen and clicked.
  float pixelsPerUnit = projectionMatrix[1][1] * uViewportHeight * 0.5 / max(-viewPosition.z, 1e-3);
  scale = max(scale, mix(1.5, 4.5, shown) / pixelsPerUnit);

#ifdef PICK
  float quad = 1.0;
#else
  float quad = lit > 0.02 ? 2.8 : 1.0; // room for halo and edit ring, only when lit
#endif
  // Being deleted: the file swells for an instant, then its sphere shrinks to nothing inside a ring running outward.
  float core = 1.0;
  if (removed >= 0.0) {
    scale *= 1.0 + 0.3 * exp(-removed * 14.0);
    core = 1.0 - smoothstep(0.05, 0.3, removed);
  }
  viewPosition.xy += position.xy * scale * quad;
  gl_Position = projectionMatrix * viewPosition;

  vCorner = position.xy;
  vColor = aColor;
  vQuad = quad;
  vRead = read;
  vEdit = edit;
  vRing = editRing(state);
  vShade = shown;
  vSelect = selected > 0.5 ? max(0.0, uTime - uSelectedAt) : -1.0;
  vRemove = removed;
  vCore = core;
  vId = id + 1.0;
}
`;

const FRAGMENT = /* glsl */ `
${ENCODE_ID_GLSL}
uniform vec3 uReadColor;
uniform vec3 uEditColor;
uniform vec3 uSelectColor;
uniform vec3 uDangerColor;
uniform float uSelectTone;
varying vec2 vCorner;
varying vec3 vColor;
varying float vQuad;
varying float vRead;
varying float vEdit;
varying float vRing;
varying float vShade;
varying float vSelect;
varying float vRemove;
varying float vCore;
flat varying float vId;

void main() {
  vec2 p = vCorner * vQuad;
  float d = length(p);
#ifdef PICK
  if (d > 1.0) discard;
  gl_FragColor = encodeId(vId);
#else
  if (d > vQuad) discard;
  if (d <= vCore) {
    vec2 q = p / vCore;
    float z = sqrt(max(0.0, 1.0 - dot(q, q)));
    float light = 0.32 + 0.68 * max(dot(vec3(q, z), vec3(-0.36, 0.56, 0.75)), 0.0);
    vec3 color = vColor * (light + pow(1.0 - z, 3.0) * 0.45) * vShade;
    color = mix(color, uReadColor * (0.7 + 0.35 * light), clamp(vRead * 1.1, 0.0, 1.0));
    color = mix(color, uEditColor * (0.75 + 0.35 * light), clamp(vEdit * 1.2, 0.0, 1.0));
    if (vRemove >= 0.0) color = mix(color, mix(uDangerColor, vec3(1.0), 0.45), 1.0 - smoothstep(0.0, 0.25, vRemove));
    gl_FragDepth = gl_FragCoord.z;
    gl_FragColor = vec4(color, 1.0);
  } else {
    float halo = clamp((vQuad - d) / (vQuad - 1.0), 0.0, 1.0);
    vec3 glow = (uReadColor * vRead * 0.5 + uEditColor * vEdit * 0.7) * halo * halo * halo;
    if (vRing >= 0.0) {
      float ringRadius = 1.0 + vRing * (vQuad - 1.0);
      glow += uEditColor * (1.0 - smoothstep(0.0, 0.14, abs(d - ringRadius))) * (1.0 - vRing) * 0.9;
    }
    if (vSelect >= 0.0) {
      // The file menu's file: a ring that settles in close, violet, or red while its delete waits for confirmation.
      float selectRadius = 1.5 + 0.9 * exp(-vSelect * 9.0);
      glow += mix(uSelectColor, uDangerColor, uSelectTone) * (1.0 - smoothstep(0.05, 0.17, abs(d - selectRadius))) * 0.95;
    }
    if (vRemove >= 0.0) {
      float spread = clamp(vRemove / ${REMOVE_S.toFixed(2)}, 0.0, 1.0);
      glow += uDangerColor * (1.0 - smoothstep(0.0, 0.2, abs(d - (0.8 + spread * (vQuad - 0.9))))) * (1.0 - spread) * 1.2;
    }
    if (max(glow.r, max(glow.g, glow.b)) < 0.004) discard;
    // Halo adds light (premultiplied, alpha 0) and sits at the far plane so it never hides other files.
    gl_FragDepth = 1.0;
    gl_FragColor = vec4(glow, 0.0);
  }
#endif
}
`;

export class NodeLayer {
  readonly mesh: THREE.InstancedMesh;
  private readonly visibleMaterial: THREE.ShaderMaterial;
  private readonly pickMaterial: THREE.ShaderMaterial;
  private readonly geometry: THREE.BufferGeometry;

  /**
   * `colors`: rgb per file, its file type's colour. `clusterOf` (the directory each file sits in) and `viewParent`
   * (the directory shown around that one) decide when a file shows.
   */
  constructor(positions: Float32Array, sizes: Float32Array, colors: Float32Array, clusterOf: Uint16Array, viewParent: Int32Array, uniforms: SharedUniforms) {
    const count = sizes.length;
    this.geometry = new THREE.PlaneGeometry(2, 2);
    this.geometry.deleteAttribute('normal');
    this.geometry.deleteAttribute('uv');
    this.geometry.setAttribute('aDir', new THREE.InstancedBufferAttribute(Float32Array.from(clusterOf), 1));
    this.geometry.setAttribute('aOuter', new THREE.InstancedBufferAttribute(Float32Array.from(clusterOf, (c) => viewParent[c]), 1));
    this.geometry.setAttribute('aDeep', new THREE.InstancedBufferAttribute(Float32Array.from(clusterOf, (c) => (viewParent[c] < 0 ? -1 : viewParent[viewParent[c]])), 1));
    this.geometry.setAttribute('aColor', new THREE.InstancedBufferAttribute(colors, 3));

    const shaderUniforms = {
      ...uniforms,
      uSelectColor: { value: new THREE.Vector3(...PALETTE.think) },
      uDangerColor: { value: new THREE.Vector3(...PALETTE.error) },
    };
    this.visibleMaterial = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: shaderUniforms,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.pickMaterial = new THREE.ShaderMaterial({ vertexShader: VERTEX, fragmentShader: FRAGMENT, uniforms: shaderUniforms, defines: { PICK: '' } });
    this.mesh = new THREE.InstancedMesh(this.geometry, this.visibleMaterial, count);
    // Written once when the layout freezes: scale = radius, translation = position.
    const matrices = this.mesh.instanceMatrix.array as Float32Array;
    for (let i = 0; i < count; i++) {
      const r = nodeRadius(sizes[i]);
      const o = i * 16;
      matrices[o] = r;
      matrices[o + 5] = r;
      matrices[o + 10] = r;
      matrices[o + 12] = positions[i * 3];
      matrices[o + 13] = positions[i * 3 + 1];
      matrices[o + 14] = positions[i * 3 + 2];
    }
    this.mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.frustumCulled = false;
  }

  /** Switches the mesh to its id-pass shaders for the 1×1 pick render, and back. */
  setPickPass(on: boolean): void {
    this.mesh.material = on ? this.pickMaterial : this.visibleMaterial;
  }

  dispose(): void {
    this.geometry.dispose();
    this.visibleMaterial.dispose();
    this.pickMaterial.dispose();
    this.mesh.dispose();
  }
}
