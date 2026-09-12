import * as THREE from 'three';
import type { SharedUniforms } from './uniforms';

// Read particles: a fixed ring buffer of comets. Launching one writes a single
// slot; the flight path (a lifted quadratic Bézier) is evaluated in the shader.

const CAPACITY = 96;
const TRAIL = 10;
const TRAIL_LAG = 0.028;

const VERTEX = /* glsl */ `
uniform float uTime;
uniform float uViewportHeight;
uniform float uPixelRatio;
attribute vec3 aTo;
attribute vec4 aTiming; // start, duration, trail step, arc seed
varying float vFade;

void main() {
  float t = (uTime - aTiming.x - aTiming.z * ${TRAIL_LAG}) / aTiming.y;
  if (aTiming.y <= 0.0 || t <= 0.0 || t >= 1.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    return;
  }
  float e = t * t * (3.0 - 2.0 * t);
  float span = distance(position, aTo);
  vec3 side = normalize(cross(aTo - position, vec3(0.0, 1.0, 0.0)) + vec3(1e-4));
  vec3 control = mix(position, aTo, 0.5) + vec3(0.0, span * 0.22, 0.0) + side * span * (aTiming.w - 0.5) * 0.3;
  vec3 p = mix(mix(position, control, e), mix(control, aTo, e), e);
  vec4 viewPosition = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * viewPosition;

  float head = 1.0 - aTiming.z / ${TRAIL}.0;
  float pixels = 0.9 * head * projectionMatrix[1][1] * uViewportHeight * 0.5 / max(-viewPosition.z, 1e-3);
  gl_PointSize = clamp(pixels, 1.5, 18.0) * uPixelRatio;
  vFade = head * head * smoothstep(0.0, 0.08, t) * (1.0 - smoothstep(0.92, 1.0, t));
}
`;

const FRAGMENT = /* glsl */ `
uniform vec3 uReadColor;
varying float vFade;

void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;
  float a = (1.0 - d) * (1.0 - d) * vFade;
  gl_FragColor = vec4(mix(uReadColor, vec3(1.0), 0.35) * a * 1.4, 1.0);
}
`;

export class ParticleLayer {
  readonly points: THREE.Points;
  private readonly from: THREE.BufferAttribute;
  private readonly to: THREE.BufferAttribute;
  private readonly timing: THREE.BufferAttribute;
  private next = 0;

  constructor(uniforms: SharedUniforms) {
    const vertices = CAPACITY * TRAIL;
    this.from = new THREE.BufferAttribute(new Float32Array(vertices * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.to = new THREE.BufferAttribute(new Float32Array(vertices * 3), 3).setUsage(THREE.DynamicDrawUsage);
    const timing = new Float32Array(vertices * 4);
    for (let v = 0; v < vertices; v++) timing[v * 4 + 2] = v % TRAIL;
    this.timing = new THREE.BufferAttribute(timing, 4).setUsage(THREE.DynamicDrawUsage);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', this.from);
    geometry.setAttribute('aTo', this.to);
    geometry.setAttribute('aTiming', this.timing);
    this.points = new THREE.Points(
      geometry,
      new THREE.ShaderMaterial({
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        uniforms: { ...uniforms },
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
      }),
    );
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
  }

  /** Launches a comet and returns the clock time it lands. */
  launch(from: THREE.Vector3, to: THREE.Vector3, start: number): { landsAt: number; goneAt: number } {
    const duration = THREE.MathUtils.clamp(from.distanceTo(to) / 90, 0.45, 1.1);
    const slot = this.next;
    this.next = (this.next + 1) % CAPACITY;
    const seed = Math.random();
    const fromArray = this.from.array as Float32Array;
    const toArray = this.to.array as Float32Array;
    const timingArray = this.timing.array as Float32Array;
    for (let k = 0; k < TRAIL; k++) {
      const v = slot * TRAIL + k;
      fromArray[v * 3] = from.x;
      fromArray[v * 3 + 1] = from.y;
      fromArray[v * 3 + 2] = from.z;
      toArray[v * 3] = to.x;
      toArray[v * 3 + 1] = to.y;
      toArray[v * 3 + 2] = to.z;
      timingArray[v * 4] = start;
      timingArray[v * 4 + 1] = duration;
      timingArray[v * 4 + 3] = seed;
    }
    this.from.addUpdateRange(slot * TRAIL * 3, TRAIL * 3);
    this.to.addUpdateRange(slot * TRAIL * 3, TRAIL * 3);
    this.timing.addUpdateRange(slot * TRAIL * 4, TRAIL * 4);
    this.from.needsUpdate = true;
    this.to.needsUpdate = true;
    this.timing.needsUpdate = true;
    return { landsAt: start + duration, goneAt: start + duration + TRAIL * TRAIL_LAG };
  }

  /** Comets in flight carry over as they are: their paths are in world space. */
  adopt(previous: ParticleLayer): void {
    for (const name of ['from', 'to', 'timing'] as const) {
      (this[name].array as Float32Array).set(previous[name].array as Float32Array);
      this[name].needsUpdate = true;
    }
    this.next = previous.next;
  }

  dispose(): void {
    this.points.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}
