import * as THREE from 'three';
import { ARC_GAP, CORE_RADIUS, type FlatLayout } from './flatLayout';
import { PALETTE } from './palette';
import type { SharedUniforms } from './uniforms';

// The Flat view's orbits and core: a thin ring along the middle of each orbit's band, lit along each group's arc and dim
// in the gaps between arcs, and the workspace's core at the centre. While a turn runs, light travels round every ring,
// the inner ones faster, as planets go; at rest the rings are still, so the frame loop can park.

const RING_VERTEX = /* glsl */ `
attribute vec4 aRing; // how far round, 0 to 1; turns per second of its current; where its current starts; 1 along an arc
varying vec4 vRing;

void main() {
  vRing = aRing;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const RING_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform float uFlow;
uniform float uFlatMix;
uniform vec3 uRingColor;
uniform vec3 uCurrentColor;
varying vec4 vRing;

void main() {
  // Two currents half a turn apart, each a bright head trailing a fading tail.
  float head = fract(vRing.x - uTime * vRing.y + vRing.z);
  float current = pow(head, 16.0) + pow(fract(head + 0.5), 16.0);
  vec3 color = uRingColor * mix(0.07, 0.42, vRing.w) + uCurrentColor * current * uFlow * mix(0.35, 1.0, vRing.w);
  gl_FragColor = vec4(color * smoothstep(0.35, 1.0, uFlatMix), 1.0);
}
`;

const CORE_VERTEX = /* glsl */ `
uniform float uSize;
varying vec2 vCorner;

void main() {
  vec4 viewPosition = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  viewPosition.xy += position.xy * uSize;
  gl_Position = projectionMatrix * viewPosition;
  vCorner = position.xy;
}
`;

const CORE_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform float uFlow;
uniform float uFlatMix;
uniform vec3 uCore;
uniform vec3 uHalo;
varying vec2 vCorner;

void main() {
  float d = length(vCorner);
  if (d > 1.0) discard;
  // A small violet nucleus in a soft halo, with a faint ring; it breathes while a turn runs. Quieter than Claude's star,
  // which is the brightest thing in the view.
  float nucleus = 1.0 - smoothstep(0.1, 0.13, d);
  float halo = exp(-d * 5.5) * (0.3 + 0.3 * uFlow);
  float ring = (1.0 - smoothstep(0.0, 0.015, abs(d - 0.46))) * 0.22;
  float breathe = 1.0 + 0.18 * sin(uTime * 2.2) * uFlow;
  vec3 color = mix(uHalo, uCore, 0.4) * nucleus * 0.62 + uHalo * (halo + ring) * breathe;
  gl_FragColor = vec4(color * (1.0 - smoothstep(0.8, 1.0, d)) * smoothstep(0.35, 1.0, uFlatMix), 1.0);
}
`;

export class OrbitLayer {
  readonly group = new THREE.Group();
  private readonly rings: THREE.LineSegments;
  private readonly core: THREE.Mesh;

  constructor(layout: FlatLayout, uniforms: SharedUniforms) {
    const { rings, arcs } = layout;
    // Enough segments that a gap between two arcs shows, within reason.
    const segmentsOf = rings.map((ring) => Math.min(720, Math.max(128, ring.columns * 2)));
    const vertices = segmentsOf.reduce((sum, segments) => sum + segments * 2, 0);
    const position = new Float32Array(vertices * 3);
    const attributes = new Float32Array(vertices * 4);
    const innermost = rings.reduce((min, ring) => Math.min(min, ring.radius), Infinity);
    let v = 0;
    rings.forEach((ring, r) => {
      const along = arcs.filter((arc) => arc.ring === r);
      // Kepler's third law, loosely: an orbit twice as far out goes round at a third of the speed.
      const speed = 0.07 * Math.pow(innermost / ring.radius, 1.5);
      const start = hashAngle(ring.phase);
      const segments = segmentsOf[r];
      const point: number[] = [0, 0, 0];
      for (let k = 0; k < segments; k++) {
        for (const end of [k, k + 1]) {
          const u = end / segments;
          const column = u * ring.columns;
          const onArc = along.some((arc) => column >= arc.start - 0.5 && column <= arc.start + arc.columns - ARC_GAP - 0.5) ? 1 : 0;
          const angle = ring.phase + u * Math.PI * 2;
          const [c, s] = [Math.cos(angle) * ring.radius, Math.sin(angle) * ring.radius];
          point[0] = c * ring.u[0] + s * ring.w[0];
          point[1] = c * ring.u[1] + s * ring.w[1];
          point[2] = c * ring.u[2] + s * ring.w[2];
          position.set(point, v * 3);
          attributes.set([u, speed, start, onArc], v * 4);
          v++;
        }
      }
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geometry.setAttribute('aRing', new THREE.BufferAttribute(attributes, 4));
    this.rings = new THREE.LineSegments(
      geometry,
      new THREE.ShaderMaterial({
        vertexShader: RING_VERTEX,
        fragmentShader: RING_FRAGMENT,
        uniforms: {
          uTime: uniforms.uTime,
          uFlow: uniforms.uFlow,
          uFlatMix: uniforms.uFlatMix,
          uRingColor: { value: new THREE.Vector3(...PALETTE.chartLineBright) },
          uCurrentColor: { value: new THREE.Vector3(...PALETTE.think) },
        },
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
      }),
    );
    this.rings.frustumCulled = false;

    const quad = new THREE.PlaneGeometry(2, 2);
    quad.deleteAttribute('normal');
    quad.deleteAttribute('uv');
    this.core = new THREE.Mesh(
      quad,
      new THREE.ShaderMaterial({
        vertexShader: CORE_VERTEX,
        fragmentShader: CORE_FRAGMENT,
        uniforms: {
          uTime: uniforms.uTime,
          uFlow: uniforms.uFlow,
          uFlatMix: uniforms.uFlatMix,
          uSize: { value: CORE_RADIUS * 2.6 },
          uCore: { value: new THREE.Vector3(...PALETTE.claudeCore) },
          uHalo: { value: new THREE.Vector3(...PALETTE.claudeHalo) },
        },
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
      }),
    );
    this.core.frustumCulled = false;
    this.core.renderOrder = 1;
    this.group.add(this.rings, this.core);
  }

  dispose(): void {
    this.rings.geometry.dispose();
    (this.rings.material as THREE.Material).dispose();
    this.core.geometry.dispose();
    (this.core.material as THREE.Material).dispose();
  }
}

/** Where a ring's currents start, from its phase, so neighbouring rings' currents don't line up. */
function hashAngle(phase: number): number {
  const x = Math.sin(phase * 91.7) * 43758.5453;
  return x - Math.floor(x);
}
