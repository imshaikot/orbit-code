import * as THREE from 'three';
import { PALETTE } from './palette';
import type { SharedUniforms } from './uniforms';

// Claude: a violet-white star per running conversation, each moving over the files its conversation reads or
// edits, flaring cyan or amber as it does, and returning to its home orbit when the turn ends. One billboard and
// one draw call per star; one star is always there, and the others fade in beside it and out again once home.

/** Seconds a flare's ring takes to run out to the star's edge. */
const FLARE_S = 0.7;
/** How fast the star closes in on its destination, per second: most of the way there in half a second. */
const FOLLOW_RATE = 4;
/** How fast a star fades in or out, per second. */
const FADE_RATE = 4;
/** Homes of further stars sit this many star sizes around the first one's. */
const HOME_RING = 3.2;

const VERTEX = /* glsl */ `
uniform float uTime;
uniform float uSize;
uniform float uFlareAt;
uniform float uFade;
varying vec2 vCorner;

void main() {
  float age = uTime - uFlareAt;
  float swell = age < 0.0 ? 0.0 : 0.3 * exp(-age * 6.0);
  vec4 viewPosition = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  viewPosition.xy += position.xy * uSize * (1.0 + swell) * (0.4 + 0.6 * uFade);
  gl_Position = projectionMatrix * viewPosition;
  vCorner = position.xy;
}
`;

const FRAGMENT = /* glsl */ `
uniform float uTime;
uniform float uBusy;
uniform float uFlareAt;
uniform float uFade;
uniform vec3 uCore;
uniform vec3 uHalo;
uniform vec3 uFlare;
varying vec2 vCorner;

void main() {
  float d = length(vCorner);
  if (d > 1.0) discard;
  float angle = atan(vCorner.y, vCorner.x);
  float core = 1.0 - smoothstep(0.07, 0.12, d);
  float halo = exp(-d * 6.0) * 0.8;
  float rays = pow(abs(cos(angle * 2.0 + uTime * 0.5)), 40.0) * exp(-d * 3.0) * 0.55;
  float ring = (1.0 - smoothstep(0.0, 0.025, abs(d - (0.26 + 0.04 * sin(uTime * 3.0))))) * 0.45 * uBusy;
  // A read or an edit: the halo takes its colour for a moment while a ring runs out to the edge.
  float age = uTime - uFlareAt;
  float spread = clamp(age / ${FLARE_S.toFixed(2)}, 0.0, 1.0);
  float flare = age < 0.0 ? 0.0 : exp(-age * 6.0) * halo * 1.4;
  float wave = age < 0.0 ? 0.0 : (1.0 - smoothstep(0.0, 0.04, abs(d - mix(0.14, 0.9, spread)))) * (1.0 - spread) * (1.0 - spread) * 0.8;
  vec3 color = uCore * core + (uHalo * (halo + rays + ring) + uFlare * (flare + wave)) * (1.0 - smoothstep(0.85, 1.0, d));
  gl_FragColor = vec4(color * uFade, 1.0);
}
`;

export class ClaudeNode {
  readonly mesh: THREE.Mesh;
  readonly home = new THREE.Vector3();
  private readonly material: THREE.ShaderMaterial;
  private readonly target = new THREE.Vector3();
  private busyTarget = 0;
  /** 1 while the star is wanted; 0 once it is to go, which it does when it has faded. */
  private fadeTarget = 1;

  constructor(home: THREE.Vector3, size: number, uniforms: SharedUniforms, fadeIn = false) {
    this.home.copy(home);
    this.target.copy(home);
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: {
        uTime: uniforms.uTime,
        uSize: { value: size },
        uBusy: { value: 0 },
        uFlareAt: { value: -1e6 },
        uFade: { value: fadeIn ? 0 : 1 },
        uCore: { value: new THREE.Vector3(...PALETTE.claudeCore) },
        uHalo: { value: new THREE.Vector3(...PALETTE.claudeHalo) },
        uFlare: { value: new THREE.Vector3(...PALETTE.read) },
      },
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const geometry = new THREE.PlaneGeometry(2, 2);
    geometry.deleteAttribute('normal');
    geometry.deleteAttribute('uv');
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.position.copy(home);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
  }

  get position(): THREE.Vector3 {
    return this.mesh.position;
  }

  /** A turn is running: the ring comes on wherever the star is. */
  busy(): void {
    this.busyTarget = 1;
  }

  /** Moves over the file Claude is working on, and flares in the colour of what it does there. */
  workOn(point: THREE.Vector3, kind: 'read' | 'edit', at: number): void {
    this.target.copy(point);
    this.busyTarget = 1;
    const { uFlareAt, uFlare } = this.material.uniforms;
    uFlareAt.value = at;
    (uFlare.value as THREE.Vector3).set(...PALETTE[kind]);
  }

  goHome(): void {
    this.target.copy(this.home);
    this.busyTarget = 0;
  }

  /** Whether the star is heading home or there, with its ring off. */
  get resting(): boolean {
    return this.busyTarget === 0 && this.target.equals(this.home);
  }

  /** Whether the star is heading home or there, ring or not: free for a conversation to take. */
  get homeward(): boolean {
    return this.target.equals(this.home);
  }

  /** At its home spot, or close enough. */
  get atHome(): boolean {
    return this.mesh.position.distanceToSquared(this.home) <= 0.0004;
  }

  /** The star is no longer wanted: it fades out, and `gone` says when it can be dropped. */
  retire(): void {
    this.fadeTarget = 0;
  }

  get retiring(): boolean {
    return this.fadeTarget === 0;
  }

  get gone(): boolean {
    return this.fadeTarget === 0 && (this.material.uniforms.uFade.value as number) < 0.01;
  }

  /** Continues from the star this one replaces: same spot, same destination unless it was heading home, same ring, flare and fade. */
  adopt(previous: ClaudeNode): void {
    this.mesh.position.copy(previous.mesh.position);
    this.busyTarget = previous.busyTarget;
    this.fadeTarget = previous.fadeTarget;
    const uniforms = this.material.uniforms;
    const before = previous.material.uniforms;
    uniforms.uBusy.value = before.uBusy.value;
    uniforms.uFlareAt.value = before.uFlareAt.value;
    uniforms.uFade.value = before.uFade.value;
    (uniforms.uFlare.value as THREE.Vector3).copy(before.uFlare.value);
    if (!previous.target.equals(previous.home)) this.target.copy(previous.target);
  }

  /** Returns true while moving, flaring, fading, or fading its ring, so the frame loop keeps running. */
  update(dt: number): boolean {
    const { uBusy: busy, uFlareAt, uFade: fade, uTime } = this.material.uniforms;
    busy.value += (this.busyTarget - busy.value) * Math.min(1, dt * 3);
    fade.value += (this.fadeTarget - fade.value) * Math.min(1, dt * FADE_RATE);
    if (Math.abs(fade.value - this.fadeTarget) < 0.005) fade.value = this.fadeTarget;
    const travelling = this.mesh.position.distanceToSquared(this.target) > 0.0004;
    if (travelling) this.mesh.position.lerp(this.target, 1 - Math.exp(-dt * FOLLOW_RATE));
    else this.mesh.position.copy(this.target);
    const flaring = uTime.value - uFlareAt.value < FLARE_S;
    return travelling || flaring || Math.abs(busy.value - this.busyTarget) > 0.01 || fade.value !== this.fadeTarget;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

/**
 * The stars, one per conversation with a turn under way. The first star is always there, at home when no
 * conversation works. A conversation takes a star at home if one is free, else a new one fades in beside it;
 * a turn's end sends its star home, where it is free for the next conversation, and stars beyond the first
 * fade out once home.
 */
export class ClaudeLayer {
  readonly group = new THREE.Group();
  /** Every star drawn, in the order they came. */
  private stars: ClaudeNode[] = [];
  /** The star each working conversation has. */
  private readonly assigned = new Map<string, ClaudeNode>();
  private made = 0;

  constructor(
    private readonly home: THREE.Vector3,
    private readonly size: number,
    private readonly uniforms: SharedUniforms,
  ) {
    this.add(false);
  }

  /** Stars drawn right now. */
  get count(): number {
    return this.stars.length;
  }

  /** The conversation `key`'s star, taking a free one or making one on its first use. */
  star(key: string): ClaudeNode {
    let star = this.assigned.get(key);
    if (!star) {
      star = this.stars.find((candidate) => !this.isAssigned(candidate) && candidate.homeward && !candidate.retiring) ?? this.add(true);
      this.assigned.set(key, star);
    }
    return star;
  }

  /** Where the conversation `key`'s star is, or the first star's home if it has none. */
  position(key: string | undefined): THREE.Vector3 {
    return (key === undefined ? undefined : this.assigned.get(key))?.position ?? this.stars[0]?.position ?? this.home;
  }

  /** A turn is running somewhere: a star at home that no conversation has yet wears the ring, until it is taken or the turns end. */
  busy(): void {
    const free = this.stars.find((candidate) => !this.isAssigned(candidate) && !candidate.retiring);
    free?.busy();
  }

  /** The conversation `key`'s turn ended: its star goes home and is free for the next one. */
  goHome(key: string): void {
    const star = this.assigned.get(key);
    this.assigned.delete(key);
    star?.goHome();
  }

  /** No turn runs anywhere: every star goes home. */
  rest(): void {
    for (const star of this.stars) star.goHome();
    this.assigned.clear();
  }

  /** Returns true while any star moves, flares or fades. Stars beyond the first fade out once home and unassigned. */
  update(dt: number): boolean {
    let moving = false;
    for (const star of this.stars) {
      if (star !== this.stars[0] && !this.isAssigned(star) && star.resting && star.atHome && !star.retiring) star.retire();
      if (star.update(dt)) moving = true;
    }
    const gone = this.stars.filter((star) => star.gone && star !== this.stars[0]);
    for (const star of gone) {
      this.group.remove(star.mesh);
      star.dispose();
    }
    if (gone.length > 0) this.stars = this.stars.filter((star) => !gone.includes(star));
    return moving;
  }

  /** Continues every star of the layer this one replaces, with the same conversations. */
  adopt(previous: ClaudeLayer): void {
    for (const star of this.stars) {
      this.group.remove(star.mesh);
      star.dispose();
    }
    this.stars = previous.stars.map((before) => {
      const star = new ClaudeNode(before.home, this.size, this.uniforms);
      star.adopt(before);
      this.group.add(star.mesh);
      return star;
    });
    this.made = previous.made;
    for (const [key, before] of previous.assigned) {
      const at = previous.stars.indexOf(before);
      if (at >= 0) this.assigned.set(key, this.stars[at]);
    }
  }

  dispose(): void {
    for (const star of this.stars) star.dispose();
  }

  private isAssigned(star: ClaudeNode): boolean {
    for (const assigned of this.assigned.values()) if (assigned === star) return true;
    return false;
  }

  /** A new star; those after the first have homes on a ring around it. */
  private add(fadeIn: boolean): ClaudeNode {
    const k = this.made++;
    const angle = k * Math.PI * (3 - Math.sqrt(5));
    const home = k === 0 ? this.home.clone() : this.home.clone().add(new THREE.Vector3(Math.cos(angle), 0.2 * Math.sin(angle * 1.7), Math.sin(angle)).multiplyScalar(this.size * HOME_RING));
    const star = new ClaudeNode(home, this.size, this.uniforms, fadeIn);
    this.stars.push(star);
    this.group.add(star.mesh);
    return star;
  }
}
