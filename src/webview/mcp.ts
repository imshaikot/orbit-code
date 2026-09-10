import * as THREE from 'three';
import type { LabelSpec } from './labels';
import { PALETTE } from './palette';
import type { SharedUniforms } from './uniforms';

// MCP servers Claude calls: each one a small station that comes out to orbit the star of the conversation that
// called it when its first tool is called, joined to the star by a beam. A call sends a lime pulse out along the
// beam and the station flares when it lands; the answer travels back, red if the tool failed. Stations leave a
// while after their conversation's turn ends. Two draw calls; while a station is out, its few vertices follow the
// star on the CPU and the shaders do the timing.

const MAX_STATIONS = 8;
const SEGMENTS = 20;
const APPEAR_S = 0.6;
const PULSE_S = 0.7;
const LINGER_S = 2.5;
const LEAVE_S = 0.8;
const UNUSED = 1e9;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

const STATION_VERTEX = /* glsl */ `
uniform float uTime;
uniform float uSize;
attribute vec3 aCenter;
attribute vec4 aTiming; // born, called, answered, leaving
attribute float aFailed;
varying vec2 vCorner;
varying float vAlive;
varying float vFlare;
varying float vFailed;

void main() {
  float appear = smoothstep(aTiming.x, aTiming.x + ${APPEAR_S.toFixed(2)}, uTime);
  vAlive = appear * (1.0 - smoothstep(aTiming.w, aTiming.w + ${LEAVE_S.toFixed(2)}, uTime));
  float landed = uTime - aTiming.y - ${PULSE_S.toFixed(2)};
  float answered = uTime - aTiming.z;
  vFlare = (landed > 0.0 ? exp(-landed * 4.0) : 0.0) + (answered > 0.0 ? 0.6 * exp(-answered * 5.0) : 0.0);
  vFailed = aFailed;
  vCorner = position.xy;
  vec4 viewPosition = modelViewMatrix * vec4(aCenter, 1.0);
  viewPosition.xy += position.xy * uSize * (0.55 + 0.45 * appear) * (1.0 + 0.25 * min(vFlare, 1.0));
  gl_Position = projectionMatrix * viewPosition;
}
`;

const STATION_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform vec3 uColor;
uniform vec3 uError;
varying vec2 vCorner;
varying float vAlive;
varying float vFlare;
varying float vFailed;

void main() {
  float d = length(vCorner);
  if (vAlive < 0.002 || d > 1.0) discard;
  float core = 1.0 - smoothstep(0.1, 0.18, d);
  float ring = 1.0 - smoothstep(0.0, 0.05, abs(d - 0.42));
  // Two panels on a slowly turning axis, like a station's wings.
  float turn = uTime * 0.7;
  vec2 axis = vec2(cos(turn), sin(turn));
  float along = abs(dot(vCorner, axis));
  float across = abs(dot(vCorner, vec2(-axis.y, axis.x)));
  float panel = step(0.5, along) * (1.0 - step(0.86, along)) * (1.0 - smoothstep(0.08, 0.12, across));
  float halo = exp(-d * 4.0) * 0.45;
  vec3 tint = mix(uColor, uError, vFailed);
  vec3 color = vec3(1.0) * core + tint * (ring * 0.9 + panel * 0.75 + halo + vFlare * exp(-d * 2.2));
  gl_FragColor = vec4(color * vAlive, 1.0);
}
`;

const BEAM_VERTEX = /* glsl */ `
attribute float aT;
attribute vec4 aTiming;
attribute float aFailed;
varying float vT;
varying vec4 vTiming;
varying float vFailed;

void main() {
  vT = aT;
  vTiming = aTiming;
  vFailed = aFailed;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const BEAM_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform vec3 uColor;
uniform vec3 uError;
varying float vT;
varying vec4 vTiming;
varying float vFailed;

float pulse(float along, float start) {
  float travelled = (uTime - start) / ${PULSE_S.toFixed(2)};
  if (travelled < 0.0 || travelled > 1.25) return 0.0;
  float gap = (along - travelled) * 8.0;
  return exp(-gap * gap);
}

void main() {
  float alive = (1.0 - smoothstep(vTiming.w, vTiming.w + ${LEAVE_S.toFixed(2)}, uTime));
  // The beam grows out from the star as its station appears.
  float reach = smoothstep(vTiming.x, vTiming.x + ${APPEAR_S.toFixed(2)}, uTime);
  if (alive < 0.002 || vT > reach) discard;
  float flow = 0.6 + 0.4 * sin(vT * 22.0 - uTime * 4.0);
  vec3 back = mix(uColor, uError, vFailed);
  vec3 color = uColor * (0.2 * flow + 1.4 * pulse(vT, vTiming.y)) + back * 1.4 * pulse(1.0 - vT, vTiming.z);
  gl_FragColor = vec4(color * alive, 1.0);
}
`;

interface Station {
  server: string;
  tool: string;
  /** The conversation that last called it: whose star it orbits. */
  key: string;
  slot: number;
  bornAt: number;
  calledAt: number;
  answeredAt: number;
  leavingAt: number;
  failed: boolean;
  readonly position: THREE.Vector3;
}

export class McpLayer {
  readonly group = new THREE.Group();
  private readonly stationMesh: THREE.Mesh;
  private readonly beams: THREE.LineSegments;
  private readonly stationMaterial: THREE.ShaderMaterial;
  private readonly beamMaterial: THREE.ShaderMaterial;
  private readonly centers: THREE.BufferAttribute;
  private readonly stationTiming: THREE.BufferAttribute;
  private readonly stationFailed: THREE.BufferAttribute;
  private readonly beamPositions: THREE.BufferAttribute;
  private readonly beamTiming: THREE.BufferAttribute;
  private readonly beamFailed: THREE.BufferAttribute;
  private stations: Station[] = [];

  constructor(uniforms: SharedUniforms) {
    const shared = { uTime: uniforms.uTime, uColor: { value: new THREE.Vector3(...PALETTE.mcp) }, uError: { value: new THREE.Vector3(...PALETTE.error) } };
    const blend = { blending: THREE.AdditiveBlending, transparent: true, depthTest: false, depthWrite: false } as const;

    const corners = new Float32Array(MAX_STATIONS * 4 * 3);
    const index: number[] = [];
    for (let s = 0; s < MAX_STATIONS; s++) {
      corners.set([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], s * 12);
      const v = s * 4;
      index.push(v, v + 1, v + 2, v, v + 2, v + 3);
    }
    const stationGeometry = new THREE.BufferGeometry();
    stationGeometry.setAttribute('position', new THREE.BufferAttribute(corners, 3));
    this.centers = new THREE.BufferAttribute(new Float32Array(MAX_STATIONS * 4 * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.stationTiming = new THREE.BufferAttribute(new Float32Array(MAX_STATIONS * 4 * 4).fill(UNUSED), 4).setUsage(THREE.DynamicDrawUsage);
    this.stationFailed = new THREE.BufferAttribute(new Float32Array(MAX_STATIONS * 4), 1).setUsage(THREE.DynamicDrawUsage);
    stationGeometry.setAttribute('aCenter', this.centers);
    stationGeometry.setAttribute('aTiming', this.stationTiming);
    stationGeometry.setAttribute('aFailed', this.stationFailed);
    stationGeometry.setIndex(index);
    this.stationMaterial = new THREE.ShaderMaterial({ vertexShader: STATION_VERTEX, fragmentShader: STATION_FRAGMENT, uniforms: { ...shared, uSize: { value: 1 } }, ...blend });
    this.stationMesh = new THREE.Mesh(stationGeometry, this.stationMaterial);

    const beamVertices = MAX_STATIONS * SEGMENTS * 2;
    const along = new Float32Array(beamVertices);
    for (let s = 0; s < MAX_STATIONS; s++) {
      for (let k = 0; k < SEGMENTS; k++) {
        along[(s * SEGMENTS + k) * 2] = k / SEGMENTS;
        along[(s * SEGMENTS + k) * 2 + 1] = (k + 1) / SEGMENTS;
      }
    }
    const beamGeometry = new THREE.BufferGeometry();
    this.beamPositions = new THREE.BufferAttribute(new Float32Array(beamVertices * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.beamTiming = new THREE.BufferAttribute(new Float32Array(beamVertices * 4).fill(UNUSED), 4).setUsage(THREE.DynamicDrawUsage);
    this.beamFailed = new THREE.BufferAttribute(new Float32Array(beamVertices), 1).setUsage(THREE.DynamicDrawUsage);
    beamGeometry.setAttribute('position', this.beamPositions);
    beamGeometry.setAttribute('aT', new THREE.BufferAttribute(along, 1));
    beamGeometry.setAttribute('aTiming', this.beamTiming);
    beamGeometry.setAttribute('aFailed', this.beamFailed);
    this.beamMaterial = new THREE.ShaderMaterial({ vertexShader: BEAM_VERTEX, fragmentShader: BEAM_FRAGMENT, uniforms: shared, ...blend });
    this.beams = new THREE.LineSegments(beamGeometry, this.beamMaterial);

    for (const object of [this.stationMesh, this.beams]) {
      object.frustumCulled = false;
      object.renderOrder = 9;
    }
    this.group.add(this.beams, this.stationMesh);
  }

  /** Stations out now, arriving or leaving. */
  get count(): number {
    return this.stations.length;
  }

  /** The conversation `key` called `tool` on `server`: its station comes out if it is not out already, and a pulse travels to it. */
  call(server: string, tool: string, t: number, key: string): void {
    let station = this.stations.find((candidate) => candidate.server === server);
    if (!station) {
      const slot = this.freeSlot();
      station = { server, tool, key, slot, bornAt: t, calledAt: t, answeredAt: -UNUSED, leavingAt: UNUSED, failed: false, position: new THREE.Vector3() };
      this.stations.push(station);
    } else if (t > station.leavingAt) {
      // Already on its way out: it comes back.
      station.bornAt = t;
    }
    station.key = key;
    station.tool = tool;
    station.calledAt = t;
    station.leavingAt = UNUSED;
    station.failed = false;
    this.writeTiming(station);
  }

  /** The answer leaves the station, no earlier than the call's pulse has landed there. */
  answer(server: string, ok: boolean, t: number): void {
    const station = this.stations.find((candidate) => candidate.server === server);
    if (!station) return;
    station.answeredAt = Math.max(t, station.calledAt + PULSE_S);
    station.failed = !ok;
    // A station already told to leave waits for this answer to get home.
    if (station.leavingAt < UNUSED) station.leavingAt = Math.max(station.leavingAt, station.answeredAt + PULSE_S + 0.4);
    this.writeTiming(station);
  }

  /** The conversation `key`'s turn is over (or none runs, without a key): its stations not already leaving go once their last answer is home, and a moment later. */
  settle(t: number, key?: string): void {
    for (const station of this.stations) {
      if (station.leavingAt < UNUSED || (key !== undefined && station.key !== key)) continue;
      station.leavingAt = Math.max(t + LINGER_S, station.answeredAt + PULSE_S + 0.4);
      this.writeTiming(station);
    }
  }

  /** Stations follow their conversation's star (`starOf`) around a slowly turning ring `reach` away. Returns whether any is out. */
  update(t: number, starOf: (key: string) => THREE.Vector3, reach: number): boolean {
    this.stations = this.stations.filter((station) => {
      if (t < station.leavingAt + LEAVE_S) return true;
      this.clearSlot(station.slot);
      return false;
    });
    if (this.stations.length === 0) return false;
    this.stationMaterial.uniforms.uSize.value = reach * 0.2;
    const control = new THREE.Vector3();
    const point = new THREE.Vector3();
    const centers = this.centers.array as Float32Array;
    const beam = this.beamPositions.array as Float32Array;
    for (const station of this.stations) {
      const star = starOf(station.key);
      const angle = station.slot * GOLDEN_ANGLE + t * 0.12;
      station.position.set(star.x + Math.cos(angle) * reach, star.y + reach * (0.35 + 0.15 * Math.sin(angle * 2 + station.slot)), star.z + Math.sin(angle) * reach);
      for (let v = 0; v < 4; v++) centers.set([station.position.x, station.position.y, station.position.z], (station.slot * 4 + v) * 3);
      // A shallow arc lifted above the straight line.
      control.copy(star).lerp(station.position, 0.5).add(point.set(0, reach * 0.25, 0));
      const at = (k: number, offset: number) => {
        const u = k / SEGMENTS;
        const a = (1 - u) * (1 - u);
        const b = 2 * (1 - u) * u;
        const c = u * u;
        beam[offset] = a * star.x + b * control.x + c * station.position.x;
        beam[offset + 1] = a * star.y + b * control.y + c * station.position.y;
        beam[offset + 2] = a * star.z + b * control.z + c * station.position.z;
      };
      for (let k = 0; k < SEGMENTS; k++) {
        const vertex = (station.slot * SEGMENTS + k) * 2;
        at(k, vertex * 3);
        at(k + 1, (vertex + 1) * 3);
      }
    }
    this.centers.needsUpdate = true;
    this.beamPositions.needsUpdate = true;
    return true;
  }

  /** A label per station out: the server, and the tool it was last asked for. */
  labelSpecs(t: number): LabelSpec[] {
    return this.stations
      .filter((station) => t < station.leavingAt + LEAVE_S * 0.5)
      .map((station) => ({ key: `mcp:${station.server}`, kind: 'mcp' as const, text: station.server, detail: station.tool, position: station.position.clone(), lift: (this.stationMaterial.uniforms.uSize.value as number) * 0.9, priority: 8000 + station.calledAt }));
  }

  /** Stations out carry over as they are; their positions follow the new star from the next update. */
  adopt(previous: McpLayer): void {
    this.stations = previous.stations.map((station) => ({ ...station, position: station.position.clone() }));
    this.stationMaterial.uniforms.uSize.value = previous.stationMaterial.uniforms.uSize.value;
    for (const station of this.stations) this.writeTiming(station);
  }

  dispose(): void {
    this.stationMesh.geometry.dispose();
    this.beams.geometry.dispose();
    this.stationMaterial.dispose();
    this.beamMaterial.dispose();
  }

  private freeSlot(): number {
    for (let slot = 0; slot < MAX_STATIONS; slot++) if (!this.stations.some((station) => station.slot === slot)) return slot;
    // Every slot taken: the station called longest ago gives way.
    const oldest = this.stations.reduce((a, b) => (a.calledAt <= b.calledAt ? a : b));
    this.stations.splice(this.stations.indexOf(oldest), 1);
    return oldest.slot;
  }

  private writeTiming(station: Station): void {
    const timing = [station.bornAt, station.calledAt, station.answeredAt, station.leavingAt];
    const failed = station.failed ? 1 : 0;
    for (let v = 0; v < 4; v++) {
      (this.stationTiming.array as Float32Array).set(timing, (station.slot * 4 + v) * 4);
      (this.stationFailed.array as Float32Array)[station.slot * 4 + v] = failed;
    }
    for (let v = 0; v < SEGMENTS * 2; v++) {
      (this.beamTiming.array as Float32Array).set(timing, (station.slot * SEGMENTS * 2 + v) * 4);
      (this.beamFailed.array as Float32Array)[station.slot * SEGMENTS * 2 + v] = failed;
    }
    this.stationTiming.needsUpdate = this.stationFailed.needsUpdate = this.beamTiming.needsUpdate = this.beamFailed.needsUpdate = true;
  }

  private clearSlot(slot: number): void {
    const unused = [UNUSED, UNUSED, UNUSED, UNUSED];
    for (let v = 0; v < 4; v++) (this.stationTiming.array as Float32Array).set(unused, (slot * 4 + v) * 4);
    for (let v = 0; v < SEGMENTS * 2; v++) (this.beamTiming.array as Float32Array).set(unused, (slot * SEGMENTS * 2 + v) * 4);
    this.stationTiming.needsUpdate = this.beamTiming.needsUpdate = true;
  }
}
