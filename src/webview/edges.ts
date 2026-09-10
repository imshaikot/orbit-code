import * as THREE from 'three';
import type { DirView } from './dirView';
import { STATE_GLSL } from './nodeState';
import { PALETTE } from './palette';
import { FOCUS_GLSL, type SharedUniforms } from './uniforms';

// All edges live in ONE BufferGeometry drawn as LineSegments. Every import is drawn inside exactly one
// directory: the deepest one holding both files, between the two things shown there that contain them,
// each either the file itself or the sub-directory bubble around it. Imports that land on the same pair
// share one segment. Which directory's segments show, flow animation, activity highlighting and the
// firing while Claude thinks are all decided in the shaders from uniforms, the node state texture and
// per-vertex attributes.

/** Seconds the firing takes to die out after its hold, or once the turn ends. */
export const FIRING_FADE_S = 1.2;
/** Distinct firing rhythms. Whole numbers, so interpolating between a line's two vertices can't perturb them. */
const NEURONS = 1024;
/** How strongly a directory's lines show through its bubble, one level up, before the view zooms in. */
const PREVIEW = 0.4;

const VERTEX = /* glsl */ `
${STATE_GLSL}
${FOCUS_GLSL}
attribute vec4 aInfo; // distance along the segment, per-segment offset, this end's file, the other end's file (-1 at a bubble)
attribute vec4 aEdge; // directory whose contents it belongs to, base alpha, 1 when an end is a bubble, firing rhythm of the source end
attribute float aOuter; // the directory shown around that one, from where the line shows faintly through its bubble
varying float vAlong;
varying float vOffset;
varying float vAlpha;
varying float vRead;
varying float vEdit;
varying float vBundle;
varying float vEnd;
varying float vNeuron;

void main() {
  float read = 0.0;
  float edit = 0.0;
  float gone = 0.0;
  if (aEdge.z < 0.5) {
    vec4 a = nodeState(aInfo.z);
    vec4 b = nodeState(aInfo.w);
    // Lit only when both ends are active: the path between touched files, not every import of a hub.
    read = min(readGlow(a), readGlow(b));
    edit = min(editPulse(a), editPulse(b));
    // The lines of a file being deleted go with it.
    gone = smoothstep(0.0, 0.3, max(removedFor(a), removedFor(b)));
  }
  float alpha = max(aEdge.y * max(shownIn(aEdge.x), ${PREVIEW.toFixed(2)} * shownIn(aOuter)), max(edit, read * 0.55)) * (1.0 - gone);
  if (alpha < 0.012) {
    // Both vertices compute the same alpha, so the whole segment is clipped: no fragments.
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vAlong = aInfo.x;
  vOffset = aInfo.y;
  vAlpha = alpha;
  vRead = read;
  vEdit = edit;
  vBundle = aEdge.z;
  vEnd = aInfo.x > 0.0 ? 1.0 : 0.0;
  vNeuron = aEdge.w;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
uniform float uTime;
uniform float uFlow;
uniform float uThinkStart;
uniform float uThinkEnd;
uniform vec3 uLineColor;
uniform vec3 uBundleColor;
uniform vec3 uReadColor;
uniform vec3 uEditColor;
uniform vec3 uThinkColor;
varying float vAlong;
varying float vOffset;
varying float vAlpha;
varying float vRead;
varying float vEdit;
varying float vBundle;
varying float vEnd; // 0 at the importer, 1 at the imported end
varying float vNeuron;

const float FADE = ${FIRING_FADE_S.toFixed(2)};

float hash(float n) {
  return fract(sin(n * 12.9898 + 78.233) * 43758.5453);
}

// While Claude thinks, lines fire like axons. Every visible line holds a flickering violet charge for the whole
// burst. Lines leaving the same file (or directory) share a rhythm, so they fire together: a spike runs to the
// imported end and flashes where it lands, then the line rests. Every line fires within 2 s of a burst starting;
// after that a beat is skipped now and then, so the network sparks instead of marching.
float firing() {
  if (uTime < uThinkStart || uTime > uThinkEnd + FADE) return 0.0;
  float envelope = smoothstep(uThinkStart, uThinkStart + 0.3, uTime) * (1.0 - smoothstep(uThinkEnd, uThinkEnd + FADE, uTime));
  float neuron = floor(vNeuron + 0.5);
  float charge = 0.2 + 0.08 * sin(uTime * 9.0 + neuron);
  float period = mix(0.8, 2.0, hash(neuron));
  float local = uTime - uThinkStart - hash(neuron + 0.5) * period;
  if (local < 0.0) return charge * envelope;
  float beat = floor(local / period);
  if (beat > 0.0 && hash(neuron * 1.618 + beat * 7.0) < 0.15) return charge * envelope;
  float head = (local - beat * period) / 0.7; // line lengths the spike has travelled this beat
  float behind = head - vEnd;
  float spike = exp(-behind * behind * 160.0) + (behind > 0.0 ? 0.6 * exp(-behind * 4.0) : 0.0);
  float landing = exp(-(head - 1.0) * (head - 1.0) * 24.0) * smoothstep(0.6, 1.0, vEnd);
  return (charge + spike + landing) * envelope;
}

void main() {
  // Dashes travel from importer to imported; the per-edge offset breaks up lockstep marching.
  float phase = fract(vAlong / 6.0 - uTime * (0.25 + 0.95 * uFlow) + vOffset);
  float pulse = smoothstep(0.0, 0.06, phase) * (1.0 - smoothstep(0.06, 0.45, phase));
  vec3 color = mix(uLineColor, uBundleColor, 0.55 + 0.45 * vBundle);
  color = mix(color, uReadColor, clamp(vRead * 1.4, 0.0, 1.0));
  color = mix(color, uEditColor, clamp(vEdit * 1.4, 0.0, 1.0));
  float strength = vAlpha * (0.5 + 0.5 * pulse) + max(vRead, vEdit) * pulse * 0.5;
  // Faint lines fire too, a little dimmer than the ones in focus; the strongest spikes run white-hot.
  float fire = firing() * (0.45 + 0.55 * clamp(vAlpha / 0.3, 0.0, 1.0));
  vec3 spark = mix(uThinkColor, vec3(1.0), clamp(fire - 0.7, 0.0, 0.6));
  gl_FragColor = vec4(color * strength + spark * fire, 1.0);
}
`;

interface Segment {
  /** Directory whose contents it belongs to. */
  level: number;
  /** Ends: file i is i, bubble c is fileCount + c. */
  low: number;
  high: number;
  /** Imports from low to high, and back. */
  forward: number;
  backward: number;
}

export class EdgeLayer {
  readonly lines: THREE.LineSegments;
  /** Segments with a sub-directory bubble at one end. */
  readonly bundleCount: number;

  constructor(edges: Uint32Array, positions: Float32Array, clusterOf: Uint16Array, centers: Float32Array, radii: Float32Array, view: DirView, uniforms: SharedUniforms) {
    const files = clusterOf.length;
    const ends = files + radii.length;
    const depth = new Uint16Array(radii.length);
    // A view parent comes before its children in canonical order.
    for (let c = 0; c < radii.length; c++) if (view.viewParent[c] >= 0) depth[c] = depth[view.viewParent[c]] + 1;

    const segments = new Map<number, Segment>();
    const fileSegmentsIn = new Map<number, number>();
    for (let e = 0; e < edges.length; e += 2) {
      let a = clusterOf[edges[e]];
      let b = clusterOf[edges[e + 1]];
      let endA = edges[e];
      let endB = edges[e + 1];
      while (depth[a] > depth[b]) [endA, a] = [files + a, view.viewParent[a]];
      while (depth[b] > depth[a]) [endB, b] = [files + b, view.viewParent[b]];
      while (a !== b && a >= 0 && b >= 0) {
        [endA, a] = [files + a, view.viewParent[a]];
        [endB, b] = [files + b, view.viewParent[b]];
      }
      if (a !== b || endA === endB) continue;
      const low = Math.min(endA, endB);
      const high = Math.max(endA, endB);
      let segment = segments.get(low * ends + high);
      if (!segment) {
        segments.set(low * ends + high, (segment = { level: a, low, high, forward: 0, backward: 0 }));
        if (high < files) fileSegmentsIn.set(a, (fileSegmentsIn.get(a) ?? 0) + 1);
      }
      if (endA === low) segment.forward++;
      else segment.backward++;
    }

    const position = new Float32Array(segments.size * 6);
    const info = new Float32Array(segments.size * 8);
    const edge = new Float32Array(segments.size * 8);
    const outer = new Float32Array(segments.size * 2);
    const end = (id: number): [number, number, number, number] =>
      id < files
        ? [positions[id * 3], positions[id * 3 + 1], positions[id * 3 + 2], 0]
        : [centers[(id - files) * 3], centers[(id - files) * 3 + 1], centers[(id - files) * 3 + 2], radii[id - files]];
    let s = 0;
    let bundles = 0;
    for (const { level, low, high, forward, backward } of segments.values()) {
      const [from, to] = forward >= backward ? [low, high] : [high, low];
      let [ax, ay, az, ar] = end(from);
      let [bx, by, bz, br] = end(to);
      // Seeded by the source end alone: every line out of one file or bubble fires together, before and after a live update.
      const neuron = Math.floor(fract(Math.sin(ax * 63.7264 + ay * 10.873 + az * 32.1411) * 43758.5453) * NEURONS);
      const span = Math.hypot(bx - ax, by - ay, bz - az);
      if (span > ar + br + 0.5) {
        // From rim to rim, so a line ends at a bubble instead of running to its centre.
        const [ux, uy, uz] = [(bx - ax) / span, (by - ay) / span, (bz - az) / span];
        [ax, ay, az] = [ax + ux * ar, ay + uy * ar, az + uz * ar];
        [bx, by, bz] = [bx - ux * br, by - uy * br, bz - uz * br];
      }
      position.set([ax, ay, az, bx, by, bz], s * 6);
      // Seeded by the endpoints rather than the segment index, so dashes keep their phase across a live update.
      const offset = fract(Math.sin(ax * 12.9898 + ay * 78.233 + az * 37.719 + bx * 4.1414 + by * 9.2712 + bz * 3.1374) * 43758.5453);
      const betweenFiles = high < files;
      const [nodeA, nodeB] = betweenFiles ? [from, to] : [-1, -1];
      info.set([0, offset, nodeA, nodeB, Math.hypot(bx - ax, by - ay, bz - az), offset, nodeB, nodeA], s * 8);
      // Crowded directories draw their file imports fainter.
      const alpha = betweenFiles ? Math.min(0.7, Math.max(0.1, 90 / fileSegmentsIn.get(level)!)) : Math.min(0.5, 0.16 + 0.08 * Math.log2(1 + forward + backward));
      const kind = betweenFiles ? 0 : 1;
      edge.set([level, alpha, kind, neuron, level, alpha, kind, neuron], s * 8);
      outer.set([view.viewParent[level], view.viewParent[level]], s * 2);
      if (!betweenFiles) bundles++;
      s++;
    }
    this.bundleCount = bundles;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geometry.setAttribute('aInfo', new THREE.BufferAttribute(info, 4));
    geometry.setAttribute('aEdge', new THREE.BufferAttribute(edge, 4));
    geometry.setAttribute('aOuter', new THREE.BufferAttribute(outer, 1));
    this.lines = new THREE.LineSegments(
      geometry,
      new THREE.ShaderMaterial({
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        uniforms: {
          ...uniforms,
          uLineColor: { value: new THREE.Vector3(...PALETTE.chartLine) },
          uBundleColor: { value: new THREE.Vector3(...PALETTE.chartLineBright) },
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
