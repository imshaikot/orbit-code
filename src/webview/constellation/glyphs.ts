import * as THREE from 'three';
import type { Rgb } from '../palette';

// Glow geometry for the skill and history constellations. Lines are screen-space quads, so they have a width in pixels
// at any distance: every glyph of one kind is a single instanced mesh whose wireframe template turns in four dimensions
// in the vertex shader (a tesseract for a skill, a gyroscope of rings for a conversation), every link is an instance of
// a second mesh, and every node's core an instance of a third. Colours are premultiplied and added onto a transparent
// canvas, so the glass panel behind shows through everywhere but the light itself.

export interface Point {
  x: number;
  y: number;
  z: number;
}

export interface GlyphInstance extends Point {
  size: number;
  /** Offset into the 4D turn, so glyphs do not all turn alike. */
  phase: number;
  /** 0 at rest, 1 hovered or held: larger, brighter, turning faster. */
  emphasis: number;
  /** 0..1 as it appears or leaves. */
  appear: number;
  color: Rgb;
  alpha: number;
}

export interface CoreInstance extends Point {
  size: number;
  appear: number;
  emphasis: number;
  /** 0..1: a ring around it (an attached skill, the current conversation). */
  ring: number;
  color: Rgb;
  alpha: number;
}

export interface LinkInstance {
  from: Point;
  to: Point;
  color: Rgb;
  alpha: number;
  /** CSS pixels. */
  width: number;
  /** Pulses per second travelling from `from` to `to`; 0 for none. */
  flow: number;
  seed: number;
}

export interface GlowUniforms {
  uTime: { value: number };
  /** Drawing buffer size in device pixels. */
  uViewport: { value: THREE.Vector2 };
  uPixelRatio: { value: number };
}

const GLOW = {
  transparent: true,
  depthTest: false,
  depthWrite: false,
  blending: THREE.CustomBlending,
  blendEquation: THREE.AddEquation,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneFactor,
  blendSrcAlpha: THREE.OneFactor,
  blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
} as const;

/** Premultiplied output: alpha follows the brightest channel, so faint light stays see-through. */
const OUTPUT_GLSL = /* glsl */ `
vec4 glow(vec3 rgb) {
  return vec4(rgb, clamp(max(rgb.r, max(rgb.g, rgb.b)), 0.0, 1.0));
}
`;

/** Offsets a clip-space point sideways from the segment a–b by `pixels` on `side`. */
const WIDEN_GLSL = /* glsl */ `
vec4 widen(vec4 a, vec4 b, float along, float side, float pixels) {
  vec2 delta = (b.xy / b.w - a.xy / a.w) * uViewport;
  vec2 normal = length(delta) > 1e-4 ? normalize(vec2(-delta.y, delta.x)) : vec2(0.0, 1.0);
  vec4 clip = mix(a, b, along);
  clip.xy += normal * side * pixels / uViewport * clip.w;
  return clip;
}
`;

const GLYPH_VERTEX = /* glsl */ `
uniform float uTime;
uniform vec2 uViewport;
uniform float uPixelRatio;
uniform float uSpin;
uniform float uWidth;
attribute vec4 aA;
attribute vec4 aB;
attribute vec3 iCenter;
attribute vec4 iParams; // size, phase, emphasis, appear
attribute vec4 iColor;
varying vec4 vColor;
varying float vSide;
varying float vDepth;
${WIDEN_GLSL}

// Turns in the xw, yz and zw planes at unrelated rates, so the inner cell keeps passing through the outer one.
vec4 turn4(vec4 p, float t) {
  float a = t * 0.61;
  float b = t * 0.37;
  float c = t * 0.23;
  p = vec4(p.x * cos(a) - p.w * sin(a), p.y, p.z, p.x * sin(a) + p.w * cos(a));
  p = vec4(p.x, p.y * cos(b) - p.z * sin(b), p.y * sin(b) + p.z * cos(b), p.w);
  p = vec4(p.x, p.y, p.z * cos(c) - p.w * sin(c), p.z * sin(c) + p.w * cos(c));
  return p;
}

// Perspective from four dimensions into three: what lies further along w shrinks toward the centre.
vec3 fold(vec4 p) {
  return p.xyz * (1.8 / (3.2 - p.w));
}

void main() {
  float t = uTime * uSpin * (1.0 + 1.5 * iParams.z) + iParams.y;
  vec4 a4 = turn4(aA, t);
  vec4 b4 = turn4(aB, t);
  float size = iParams.x * iParams.w * (1.0 + 0.22 * iParams.z);
  vec4 a = projectionMatrix * modelViewMatrix * vec4(iCenter + fold(a4) * size, 1.0);
  vec4 b = projectionMatrix * modelViewMatrix * vec4(iCenter + fold(b4) * size, 1.0);
  float w = mix(a4.w, b4.w, position.x);
  float pixels = uWidth * uPixelRatio * (1.1 - 0.22 * w) * (0.85 + 0.45 * iParams.z) * iParams.w;
  gl_Position = widen(a, b, position.x, position.y, pixels);
  vColor = iColor;
  vSide = position.y;
  vDepth = w;
}
`;

const GLYPH_FRAGMENT = /* glsl */ `
varying vec4 vColor;
varying float vSide;
varying float vDepth;
${OUTPUT_GLSL}

void main() {
  float core = smoothstep(0.0, 0.7, 1.0 - abs(vSide));
  float near = 0.5 + 0.5 * clamp(0.5 + vDepth * 0.3, 0.0, 1.0);
  gl_FragColor = glow(vColor.rgb * core * near * vColor.a);
}
`;

const CORE_VERTEX = /* glsl */ `
attribute vec3 iCenter;
attribute vec4 iParams; // size, appear, emphasis, ring
attribute vec4 iColor;
varying vec2 vCorner;
varying vec4 vColor;
varying vec3 vParams;

void main() {
  vec4 viewPosition = modelViewMatrix * vec4(iCenter, 1.0);
  viewPosition.xy += position.xy * iParams.x * iParams.y * (1.0 + 0.35 * iParams.z);
  gl_Position = projectionMatrix * viewPosition;
  vCorner = position.xy;
  vColor = iColor;
  vParams = iParams.yzw;
}
`;

const CORE_FRAGMENT = /* glsl */ `
uniform float uTime;
varying vec2 vCorner;
varying vec4 vColor;
varying vec3 vParams;
${OUTPUT_GLSL}

void main() {
  float d = length(vCorner);
  if (d > 1.0) discard;
  float core = 1.0 - smoothstep(0.06, 0.16, d);
  float halo = exp(-d * 5.0) * (0.3 + 0.45 * vParams.y);
  float ring = vParams.z * (1.0 - smoothstep(0.0, 0.07, abs(d - (0.7 + 0.05 * sin(uTime * 3.0)))));
  vec3 rgb = mix(vColor.rgb, vec3(1.0), 0.65) * core + vColor.rgb * (halo + ring * 0.9);
  gl_FragColor = glow(rgb * vColor.a * vParams.x);
}
`;

const LINK_VERTEX = /* glsl */ `
uniform vec2 uViewport;
uniform float uPixelRatio;
attribute vec3 iFrom;
attribute vec3 iTo;
attribute vec4 iColor;
attribute vec3 iStyle; // width, flow, seed
varying float vSide;
varying float vAlong;
varying vec4 vColor;
varying vec2 vFlow;
${WIDEN_GLSL}

void main() {
  vec4 a = projectionMatrix * modelViewMatrix * vec4(iFrom, 1.0);
  vec4 b = projectionMatrix * modelViewMatrix * vec4(iTo, 1.0);
  gl_Position = widen(a, b, position.x, position.y, iStyle.x * uPixelRatio);
  vSide = position.y;
  vAlong = position.x;
  vColor = iColor;
  vFlow = iStyle.yz;
}
`;

const LINK_FRAGMENT = /* glsl */ `
uniform float uTime;
varying float vSide;
varying float vAlong;
varying vec4 vColor;
varying vec2 vFlow;
${OUTPUT_GLSL}

void main() {
  float core = smoothstep(0.0, 0.9, 1.0 - abs(vSide));
  float pulse = vFlow.x > 0.0 ? pow(fract(vAlong - uTime * vFlow.x + vFlow.y), 10.0) : 0.0;
  gl_FragColor = glow(vColor.rgb * core * (vColor.a + pulse * 1.3 * step(0.01, vColor.a)));
}
`;

/** A unit tesseract: its 16 corners (±1, ±1, ±1, ±1), joined along the 32 edges where two corners differ in one coordinate. */
export function tesseractTemplate(): Float32Array {
  const corner = (i: number) => [0, 1, 2, 3].map((bit) => ((i >> bit) & 1 ? 1 : -1));
  const edges: number[] = [];
  for (let i = 0; i < 16; i++) {
    for (let bit = 0; bit < 4; bit++) {
      const j = i ^ (1 << bit);
      if (j > i) edges.push(...corner(i), ...corner(j));
    }
  }
  return new Float32Array(edges);
}

/** Four rings through the centre, three in space and one tipped into w: a gyroscope. */
export function gyroscopeTemplate(segments = 28): Float32Array {
  const edges: number[] = [];
  for (const [u, v] of [
    [0, 1],
    [0, 2],
    [1, 2],
    [0, 3],
  ]) {
    for (let k = 0; k < segments; k++) {
      const p = [0, 0, 0, 0];
      const q = [0, 0, 0, 0];
      const a = (k / segments) * Math.PI * 2;
      const b = ((k + 1) / segments) * Math.PI * 2;
      p[u] = Math.cos(a) * 1.25;
      p[v] = Math.sin(a) * 1.25;
      q[u] = Math.cos(b) * 1.25;
      q[v] = Math.sin(b) * 1.25;
      edges.push(...p, ...q);
    }
  }
  return new Float32Array(edges);
}

/** Quad corners for a segment: `x` is 0 at its start and 1 at its end, `y` the side. */
const SEGMENT_CORNERS = [0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0];

export class GlyphMesh {
  readonly mesh: THREE.Mesh;
  private readonly geometry = new THREE.InstancedBufferGeometry();
  private readonly centers: THREE.InstancedBufferAttribute;
  private readonly params: THREE.InstancedBufferAttribute;
  private readonly colors: THREE.InstancedBufferAttribute;

  constructor(
    template: Float32Array,
    uniforms: GlowUniforms,
    spin: number,
    width: number,
    private readonly capacity = 256,
  ) {
    const edges = template.length / 8;
    const a = new Float32Array(edges * 16);
    const b = new Float32Array(edges * 16);
    const corners = new Float32Array(edges * 12);
    const index: number[] = [];
    for (let e = 0; e < edges; e++) {
      for (let v = 0; v < 4; v++) {
        a.set(template.subarray(e * 8, e * 8 + 4), (e * 4 + v) * 4);
        b.set(template.subarray(e * 8 + 4, e * 8 + 8), (e * 4 + v) * 4);
      }
      corners.set(SEGMENT_CORNERS, e * 12);
      index.push(e * 4, e * 4 + 1, e * 4 + 2, e * 4, e * 4 + 2, e * 4 + 3);
    }
    this.geometry.setAttribute('position', new THREE.BufferAttribute(corners, 3));
    this.geometry.setAttribute('aA', new THREE.BufferAttribute(a, 4));
    this.geometry.setAttribute('aB', new THREE.BufferAttribute(b, 4));
    this.geometry.setIndex(index);
    this.centers = instanced(this.geometry, 'iCenter', capacity, 3);
    this.params = instanced(this.geometry, 'iParams', capacity, 4);
    this.colors = instanced(this.geometry, 'iColor', capacity, 4);
    this.geometry.instanceCount = 0;
    const material = new THREE.ShaderMaterial({
      vertexShader: GLYPH_VERTEX,
      fragmentShader: GLYPH_FRAGMENT,
      uniforms: { ...uniforms, uSpin: { value: spin }, uWidth: { value: width } },
      ...GLOW,
    });
    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
  }

  set(instances: readonly GlyphInstance[]): void {
    const count = Math.min(instances.length, this.capacity);
    const centers = this.centers.array as Float32Array;
    const params = this.params.array as Float32Array;
    const colors = this.colors.array as Float32Array;
    for (let i = 0; i < count; i++) {
      const g = instances[i];
      centers[i * 3] = g.x;
      centers[i * 3 + 1] = g.y;
      centers[i * 3 + 2] = g.z;
      params[i * 4] = g.size;
      params[i * 4 + 1] = g.phase;
      params[i * 4 + 2] = g.emphasis;
      params[i * 4 + 3] = g.appear;
      colors.set(g.color, i * 4);
      colors[i * 4 + 3] = g.alpha;
    }
    this.geometry.instanceCount = count;
    this.centers.needsUpdate = this.params.needsUpdate = this.colors.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

export class CoreMesh {
  readonly mesh: THREE.Mesh;
  private readonly geometry = new THREE.InstancedBufferGeometry();
  private readonly centers: THREE.InstancedBufferAttribute;
  private readonly params: THREE.InstancedBufferAttribute;
  private readonly colors: THREE.InstancedBufferAttribute;

  constructor(
    uniforms: GlowUniforms,
    private readonly capacity = 320,
  ) {
    this.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    this.geometry.setIndex([0, 1, 2, 0, 2, 3]);
    this.centers = instanced(this.geometry, 'iCenter', capacity, 3);
    this.params = instanced(this.geometry, 'iParams', capacity, 4);
    this.colors = instanced(this.geometry, 'iColor', capacity, 4);
    this.geometry.instanceCount = 0;
    this.mesh = new THREE.Mesh(this.geometry, new THREE.ShaderMaterial({ vertexShader: CORE_VERTEX, fragmentShader: CORE_FRAGMENT, uniforms: { uTime: uniforms.uTime }, ...GLOW }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
  }

  set(instances: readonly CoreInstance[]): void {
    const count = Math.min(instances.length, this.capacity);
    const centers = this.centers.array as Float32Array;
    const params = this.params.array as Float32Array;
    const colors = this.colors.array as Float32Array;
    for (let i = 0; i < count; i++) {
      const c = instances[i];
      centers[i * 3] = c.x;
      centers[i * 3 + 1] = c.y;
      centers[i * 3 + 2] = c.z;
      params[i * 4] = c.size;
      params[i * 4 + 1] = c.appear;
      params[i * 4 + 2] = c.emphasis;
      params[i * 4 + 3] = c.ring;
      colors.set(c.color, i * 4);
      colors[i * 4 + 3] = c.alpha;
    }
    this.geometry.instanceCount = count;
    this.centers.needsUpdate = this.params.needsUpdate = this.colors.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

export class LinkMesh {
  readonly mesh: THREE.Mesh;
  private readonly geometry = new THREE.InstancedBufferGeometry();
  private readonly from: THREE.InstancedBufferAttribute;
  private readonly to: THREE.InstancedBufferAttribute;
  private readonly colors: THREE.InstancedBufferAttribute;
  private readonly styles: THREE.InstancedBufferAttribute;

  constructor(
    uniforms: GlowUniforms,
    private readonly capacity = 640,
  ) {
    this.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SEGMENT_CORNERS), 3));
    this.geometry.setIndex([0, 1, 2, 0, 2, 3]);
    this.from = instanced(this.geometry, 'iFrom', capacity, 3);
    this.to = instanced(this.geometry, 'iTo', capacity, 3);
    this.colors = instanced(this.geometry, 'iColor', capacity, 4);
    this.styles = instanced(this.geometry, 'iStyle', capacity, 3);
    this.geometry.instanceCount = 0;
    this.mesh = new THREE.Mesh(this.geometry, new THREE.ShaderMaterial({ vertexShader: LINK_VERTEX, fragmentShader: LINK_FRAGMENT, uniforms: { ...uniforms }, ...GLOW }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  set(instances: readonly LinkInstance[]): void {
    const count = Math.min(instances.length, this.capacity);
    const from = this.from.array as Float32Array;
    const to = this.to.array as Float32Array;
    const colors = this.colors.array as Float32Array;
    const styles = this.styles.array as Float32Array;
    for (let i = 0; i < count; i++) {
      const link = instances[i];
      from[i * 3] = link.from.x;
      from[i * 3 + 1] = link.from.y;
      from[i * 3 + 2] = link.from.z;
      to[i * 3] = link.to.x;
      to[i * 3 + 1] = link.to.y;
      to[i * 3 + 2] = link.to.z;
      colors.set(link.color, i * 4);
      colors[i * 4 + 3] = link.alpha;
      styles[i * 3] = link.width;
      styles[i * 3 + 1] = link.flow;
      styles[i * 3 + 2] = link.seed;
    }
    this.geometry.instanceCount = count;
    this.from.needsUpdate = this.to.needsUpdate = this.colors.needsUpdate = this.styles.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

function instanced(geometry: THREE.InstancedBufferGeometry, name: string, capacity: number, size: number): THREE.InstancedBufferAttribute {
  const attribute = new THREE.InstancedBufferAttribute(new Float32Array(capacity * size), size).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute(name, attribute);
  return attribute;
}
