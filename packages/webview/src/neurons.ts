import * as THREE from 'three';
import { FIRING_GLSL } from './edges';
import type { FlatLayout } from './flatLayout';
import { STATE_GLSL } from './nodeState';
import { PALETTE } from './palette';
import type { SharedUniforms } from './uniforms';

// The Flat view's import lines, drawn as neurons: each import is an arc from the importer's sphere up and over to the
// file it imports, lifted in proportion to its length, so the network rises as a canopy over the orbits instead of
// cutting across them. Tinted from the importer's file type to the imported one's and brighter where it meets a file,
// it flows while a turn runs, lights the path between files Claude touched, and fires exactly as the Nested view's
// lines do while Claude thinks (FIRING_GLSL). One draw object, built when the Flat view is first shown.

/** Distinct firing rhythms, as in edges.ts. */
const NEURONS = 1024;
/** Arc height per unit of its length: low, so the network reads as part of the disc, not a dome over it. */
const LIFT = 0.12;

const VERTEX = /* glsl */ `
${STATE_GLSL}
uniform float uFlatMix;
attribute vec4 aInfo; // distance along the arc, dash offset, importer, imported file
attribute vec4 aArc; // 0 at the importer to 1 at the imported end, base alpha, firing rhythm
attribute vec3 aColor;
varying float vAlong;
varying float vOffset;
varying float vAlpha;
varying float vRead;
varying float vEdit;
varying float vEnd;
varying float vNeuron;
varying vec3 vColor;

void main() {
  vec4 a = nodeState(aInfo.z);
  vec4 b = nodeState(aInfo.w);
  // Lit only when both ends are active: the path between touched files, not every import of a hub.
  float read = min(readGlow(a), readGlow(b));
  float edit = min(editPulse(a), editPulse(b));
  float gone = smoothstep(0.0, 0.3, max(removedFor(a), removedFor(b)));
  // The arcs grow in once the files have reached their orbits, and go first on the way back.
  float alpha = max(aArc.y, max(edit, read * 0.55)) * (1.0 - gone) * smoothstep(0.7, 1.0, uFlatMix);
  if (alpha < 0.012) {
    // Every vertex of an arc computes the same alpha, so the whole arc is clipped.
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vAlong = aInfo.x;
  vOffset = aInfo.y;
  vAlpha = alpha;
  vRead = read;
  vEdit = edit;
  vEnd = aArc.x;
  vNeuron = aArc.z;
  vColor = aColor;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
uniform float uTime;
uniform float uFlow;
uniform float uThinkStart;
uniform float uThinkEnd;
uniform vec3 uLineColor;
uniform vec3 uReadColor;
uniform vec3 uEditColor;
uniform vec3 uThinkColor;
varying float vAlong;
varying float vOffset;
varying float vAlpha;
varying float vRead;
varying float vEdit;
varying float vEnd;
varying float vNeuron;
varying vec3 vColor;

${FIRING_GLSL}

void main() {
  // Dashes travel from importer to imported; the per-arc offset breaks up lockstep marching.
  float phase = fract(vAlong / 7.0 - uTime * (0.25 + 0.95 * uFlow) + vOffset);
  float pulse = smoothstep(0.0, 0.06, phase) * (1.0 - smoothstep(0.06, 0.45, phase));
  // Brighter where it meets a file, like a synapse.
  float terminal = pow(vEnd, 12.0) + pow(1.0 - vEnd, 12.0);
  vec3 color = mix(uLineColor, vColor, 0.55);
  color = mix(color, uReadColor, clamp(vRead * 1.4, 0.0, 1.0));
  color = mix(color, uEditColor, clamp(vEdit * 1.4, 0.0, 1.0));
  float strength = vAlpha * (0.4 + 0.35 * pulse + 0.8 * terminal) + max(vRead, vEdit) * pulse * 0.5;
  // Every import of the workspace is on screen at once here, so each fires a little softer than in a directory.
  float fire = firing(vNeuron, vEnd) * (0.3 + 0.4 * clamp(vAlpha / 0.3, 0.0, 1.0));
  vec3 spark = mix(uThinkColor, vec3(1.0), clamp(fire - 0.8, 0.0, 0.5));
  gl_FragColor = vec4(color * strength + spark * fire, 1.0);
}
`;

export class NeuronLayer {
  readonly lines: THREE.LineSegments;

  /** `colors`: rgb per file, its file type's colour. */
  constructor(edges: Uint32Array, layout: FlatLayout, colors: Float32Array, uniforms: SharedUniforms) {
    const imports = edges.length / 2;
    // Smooth arcs for small graphs; fewer segments where there are many thousands of them.
    const segments = imports > 30_000 ? 3 : imports > 8_000 ? 5 : 8;
    const vertices = imports * segments * 2;
    const position = new Float32Array(vertices * 3);
    const info = new Float32Array(vertices * 4);
    const arc = new Float32Array(vertices * 4);
    const color = new Float32Array(vertices * 3);
    // A dense network draws each line fainter.
    const alpha = THREE.MathUtils.clamp(9 / Math.sqrt(Math.max(1, imports)), 0.05, 0.3);
    const { positions, radii } = layout;
    const points = new Float32Array((segments + 1) * 3);
    const lengths = new Float32Array(segments + 1);

    let v = 0;
    for (let e = 0; e < edges.length; e += 2) {
      const from = edges[e];
      const to = edges[e + 1];
      let [ax, ay, az] = [positions[from * 3], positions[from * 3 + 1], positions[from * 3 + 2]];
      let [bx, by, bz] = [positions[to * 3], positions[to * 3 + 1], positions[to * 3 + 2]];
      const chord = Math.hypot(bx - ax, by - ay, bz - az);
      // Seeded by the importer's position: every line out of one file fires together, before and after a live update.
      const neuron = Math.floor(fract(Math.sin(ax * 63.7264 + ay * 10.873 + az * 32.1411) * 43758.5453) * NEURONS);
      const offset = fract(Math.sin(ax * 12.9898 + ay * 78.233 + az * 37.719 + bx * 4.1414 + by * 9.2712 + bz * 3.1374) * 43758.5453);
      if (chord > radii[from] + radii[to] + 0.5) {
        // From one sphere's surface to the other's.
        const [ux, uy, uz] = [(bx - ax) / chord, (by - ay) / chord, (bz - az) / chord];
        [ax, ay, az] = [ax + ux * radii[from], ay + uy * radii[from], az + uz * radii[from]];
        [bx, by, bz] = [bx - ux * radii[to], by - uy * radii[to], bz - uz * radii[to]];
      }
      // Up and over, with a little sideways lean of its own so arcs between neighbouring files don't lie on top of each other.
      const lean = (offset - 0.5) * chord * 0.14;
      const sideLength = Math.hypot(bz - az, ax - bx) || 1;
      const cx = (ax + bx) / 2 + ((bz - az) / sideLength) * lean;
      const cy = (ay + by) / 2 + chord * LIFT + 1;
      const cz = (az + bz) / 2 + ((ax - bx) / sideLength) * lean;
      lengths[0] = 0;
      for (let k = 0; k <= segments; k++) {
        const t = k / segments;
        const [p, q, r] = [(1 - t) * (1 - t), 2 * (1 - t) * t, t * t];
        points[k * 3] = p * ax + q * cx + r * bx;
        points[k * 3 + 1] = p * ay + q * cy + r * by;
        points[k * 3 + 2] = p * az + q * cz + r * bz;
        if (k > 0) lengths[k] = lengths[k - 1] + Math.hypot(points[k * 3] - points[k * 3 - 3], points[k * 3 + 1] - points[k * 3 - 2], points[k * 3 + 2] - points[k * 3 - 1]);
      }
      for (let k = 0; k < segments; k++) {
        for (const end of [k, k + 1]) {
          const t = end / segments;
          position.set(points.subarray(end * 3, end * 3 + 3), v * 3);
          info.set([lengths[end], offset, from, to], v * 4);
          arc.set([t, alpha, neuron, 0], v * 4);
          for (let c = 0; c < 3; c++) color[v * 3 + c] = colors[from * 3 + c] * (1 - t) + colors[to * 3 + c] * t;
          v++;
        }
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geometry.setAttribute('aInfo', new THREE.BufferAttribute(info, 4));
    geometry.setAttribute('aArc', new THREE.BufferAttribute(arc, 4));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(color, 3));
    this.lines = new THREE.LineSegments(
      geometry,
      new THREE.ShaderMaterial({
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        uniforms: {
          ...uniforms,
          uLineColor: { value: new THREE.Vector3(...PALETTE.chartLineBright) },
          uThinkColor: { value: new THREE.Vector3(...PALETTE.think) },
        },
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
      }),
    );
    this.lines.frustumCulled = false;
  }

  dispose(): void {
    this.lines.geometry.dispose();
    (this.lines.material as THREE.Material).dispose();
  }
}

function fract(value: number): number {
  return value - Math.floor(value);
}
