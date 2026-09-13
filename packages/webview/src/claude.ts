import * as THREE from 'three';
import { PALETTE } from './palette';
import { ENCODE_ID_GLSL, PICK_CLAUDE_BASE, type SharedUniforms } from './uniforms';

// Claude: a violet-white star per running conversation, each moving over the files its conversation reads or
// edits, flaring cyan or amber as it does, and returning to its home orbit when the turn ends. One billboard and
// one draw call per star; one star is always there, and the others fade in beside it and out again once home.
// A star never draws smaller than MIN_PX on screen, so it stays in sight however far out the camera is. Like
// nodes.ts and bubbles.ts, it takes clicks through the id pass, the same shader source with PICK defined.
// A subagent gets a smaller orchid star of its own: it comes out of its conversation's star and waits beside it, moves
// over the files the subagent reads or edits, and goes back into that star to fade once done, joined to it all along
// by a faint line. It takes clicks like any star.

/** A subagent's star is this much the size of a conversation's. */
const AGENT_SCALE = 0.55;
/** Until it works on a file, a subagent's star waits this many star sizes from its conversation's. */
const AGENT_WAIT = 1.8;
/** Subagents drawn with a line back to their conversation's star; any more go without one. */
const MAX_TETHERS = 16;
const TETHER_SEGMENTS = 12;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
/** Seconds a flare's ring takes to run out to the star's edge. */
const FLARE_S = 0.7;
/** How fast the star closes in on its destination, per second: most of the way there in half a second. */
const FOLLOW_RATE = 4;
/** How fast a star fades in or out, per second. */
const FADE_RATE = 4;
/** Homes of further stars sit this many star sizes around the first one's. */
const HOME_RING = 3.2;
/** The star's half-size never drops below this many CSS pixels, however far out the camera is. */
const MIN_PX = 16;
/** Only the bright middle of the star takes clicks, not the faint halo out to its edge. */
const PICK_RADIUS = 0.6;

const VERTEX = /* glsl */ `
uniform float uTime;
uniform float uFlareAt;
uniform float uFade;
uniform float uSize;
uniform float uViewportHeight;
varying vec2 vCorner;

void main() {
  vec4 viewPosition = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  // Never let the star shrink below a few CSS px, however far out the camera is.
  float pixelsPerUnit = projectionMatrix[1][1] * uViewportHeight * 0.5 / max(-viewPosition.z, 1e-3);
  float size = max(uSize, ${MIN_PX.toFixed(1)} / pixelsPerUnit);
#ifdef PICK
  viewPosition.xy += position.xy * size;
#else
  float age = uTime - uFlareAt;
  float swell = age < 0.0 ? 0.0 : 0.3 * exp(-age * 6.0);
  viewPosition.xy += position.xy * size * (1.0 + swell) * (0.4 + 0.6 * uFade);
#endif
  gl_Position = projectionMatrix * viewPosition;
  vCorner = position.xy;
}
`;

const FRAGMENT = /* glsl */ `
${ENCODE_ID_GLSL}
uniform float uTime;
uniform float uBusy;
uniform float uFlareAt;
uniform float uFade;
uniform float uPickId;
uniform vec3 uCore;
uniform vec3 uHalo;
uniform vec3 uFlare;
varying vec2 vCorner;

void main() {
  float d = length(vCorner);
#ifdef PICK
  // A star still fading in, or on its way out, is not there to be clicked.
  if (d > ${PICK_RADIUS.toFixed(2)} || uFade < 0.5) discard;
  gl_FragColor = encodeId(uPickId);
#else
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
#endif
}
`;

const TETHER_VERTEX = /* glsl */ `
attribute float aT;
attribute float aFade;
varying float vT;
varying float vFade;

void main() {
  vT = aT;
  vFade = aFade;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const TETHER_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform vec3 uColor;
varying float vT;
varying float vFade;

void main() {
  // Faint at the conversation's star and brighter toward the subagent's, with a slow flow out to it.
  float flow = 0.5 + 0.5 * sin(vT * 24.0 - uTime * 3.0);
  gl_FragColor = vec4(uColor * (0.12 + 0.22 * flow) * mix(0.4, 1.0, vT) * vFade, 1.0);
}
`;

export class ClaudeNode {
  readonly mesh: THREE.Mesh;
  readonly home = new THREE.Vector3();
  /** Stable for the star's life, unlike its index in the layer's array, which shifts as stars come and go; a live update's replacement star keeps its predecessor's id (ClaudeLayer.adopt). Lets World follow a star by id across both, and is baked into its pick id. */
  readonly id: number;
  /** A subagent's star: orchid, and never taken by a conversation. */
  readonly subagent: boolean;
  private readonly visibleMaterial: THREE.ShaderMaterial;
  /** The id-pass variant of the same shaders (PICK defined), sharing every uniform with the visible material. */
  private readonly pickMaterial: THREE.ShaderMaterial;
  private readonly target = new THREE.Vector3();
  private busyTarget = 0;
  /** 1 while the star is wanted; 0 once it is to go, which it does when it has faded. */
  private fadeTarget = 1;

  constructor(id: number, home: THREE.Vector3, size: number, uniforms: SharedUniforms, fadeIn = false, subagent = false) {
    this.id = id;
    this.subagent = subagent;
    this.home.copy(home);
    this.target.copy(home);
    const shaderUniforms = {
      uTime: uniforms.uTime,
      uViewportHeight: uniforms.uViewportHeight,
      uSize: { value: size },
      uBusy: { value: 0 },
      uFlareAt: { value: -1e6 },
      uFade: { value: fadeIn ? 0 : 1 },
      uPickId: { value: PICK_CLAUDE_BASE + id },
      uCore: { value: new THREE.Vector3(...PALETTE.claudeCore) },
      uHalo: { value: new THREE.Vector3(...(subagent ? PALETTE.agentHalo : PALETTE.claudeHalo)) },
      uFlare: { value: new THREE.Vector3(...PALETTE.read) },
    };
    // Drawn last and without a depth test, in both passes: the star wins the pixel over a file behind it.
    this.visibleMaterial = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: shaderUniforms,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.pickMaterial = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: shaderUniforms,
      defines: { PICK: '' },
      depthTest: false,
      depthWrite: false,
    });
    const geometry = new THREE.PlaneGeometry(2, 2);
    geometry.deleteAttribute('normal');
    geometry.deleteAttribute('uv');
    this.mesh = new THREE.Mesh(geometry, this.visibleMaterial);
    this.mesh.position.copy(home);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
  }

  get position(): THREE.Vector3 {
    return this.mesh.position;
  }

  /** Switches the star to its id-pass shader for the 1×1 pick render, and back. */
  setPickPass(on: boolean): void {
    this.mesh.material = on ? this.pickMaterial : this.visibleMaterial;
  }

  /** A turn is running: the ring comes on wherever the star is. */
  busy(): void {
    this.busyTarget = 1;
  }

  /** Moves over the file Claude is working on, and flares in the colour of what it does there. */
  workOn(point: THREE.Vector3, kind: 'read' | 'edit', at: number): void {
    this.target.copy(point);
    this.busyTarget = 1;
    const { uFlareAt, uFlare } = this.visibleMaterial.uniforms;
    uFlareAt.value = at;
    (uFlare.value as THREE.Vector3).set(...PALETTE[kind]);
  }

  goHome(): void {
    this.target.copy(this.home);
    this.busyTarget = 0;
  }

  /** Heads for `point` with its ring on, flaring nothing: a subagent waiting beside its conversation's star. */
  wait(point: THREE.Vector3): void {
    this.target.copy(point);
    this.busyTarget = 1;
  }

  /** Moves home to `point`, heading there if it was heading home, ring and all. */
  rehome(point: THREE.Vector3): void {
    if (this.target.equals(this.home)) this.target.copy(point);
    this.home.copy(point);
  }

  /** Makes `point` home and heads there: a subagent going back into its conversation's star, which may be moving. */
  returnTo(point: THREE.Vector3): void {
    this.home.copy(point);
    this.goHome();
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

  /** Within its own size of home: close enough for a subagent's star, whose home keeps moving, to fade there. */
  get nearHome(): boolean {
    const size = this.visibleMaterial.uniforms.uSize.value as number;
    return this.mesh.position.distanceToSquared(this.home) <= size * size;
  }

  /** The star is no longer wanted: it fades out, and `gone` says when it can be dropped. */
  retire(): void {
    this.fadeTarget = 0;
  }

  get retiring(): boolean {
    return this.fadeTarget === 0;
  }

  get gone(): boolean {
    return this.fadeTarget === 0 && (this.visibleMaterial.uniforms.uFade.value as number) < 0.01;
  }

  /** How far the star has faded in, from 0 to 1. */
  get fade(): number {
    return this.visibleMaterial.uniforms.uFade.value as number;
  }

  /** Continues from the star this one replaces: same spot, same destination unless it was heading home, same ring, flare and fade. */
  adopt(previous: ClaudeNode): void {
    this.mesh.position.copy(previous.mesh.position);
    this.busyTarget = previous.busyTarget;
    this.fadeTarget = previous.fadeTarget;
    const uniforms = this.visibleMaterial.uniforms;
    const before = previous.visibleMaterial.uniforms;
    uniforms.uBusy.value = before.uBusy.value;
    uniforms.uFlareAt.value = before.uFlareAt.value;
    uniforms.uFade.value = before.uFade.value;
    (uniforms.uFlare.value as THREE.Vector3).copy(before.uFlare.value);
    if (!previous.target.equals(previous.home)) this.target.copy(previous.target);
  }

  /** Returns true while moving, flaring, fading, or fading its ring, so the frame loop keeps running. */
  update(dt: number): boolean {
    const { uBusy: busy, uFlareAt, uFade: fade, uTime } = this.visibleMaterial.uniforms;
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
    this.visibleMaterial.dispose();
    this.pickMaterial.dispose();
  }
}

/** A subagent drawn: which conversation's star it came out of, and what its own star is doing. */
interface Subagent {
  /** The conversation it works for. */
  key: string;
  /** The id of the tool call running it. */
  agent: string;
  /** Its type, once its start has said. */
  name: string | undefined;
  star: ClaudeNode;
  /** Which way from its conversation's star it waits, as a unit vector. */
  offset: THREE.Vector3;
  /** It has worked on a file, so its star stays where that took it rather than beside its conversation's. */
  working: boolean;
  /** Its call returned: its star goes back into its conversation's, and the subagent is dropped once that star has faded. */
  done: boolean;
}

/**
 * The stars, one per conversation with a turn under way and one per subagent. The first star is always there, at home
 * when no conversation works. A conversation takes a star at home if one is free, else a new one fades in beside it;
 * a turn's end sends its star home, where it is free for the next conversation, and stars beyond the first
 * fade out once home. A subagent's star is its own, never taken by anyone else, and fades out inside its conversation's.
 */
export class ClaudeLayer {
  readonly group = new THREE.Group();
  /** Every star drawn, in the order they came. */
  private stars: ClaudeNode[] = [];
  /** The star each working conversation, and each subagent at work, has. */
  private readonly assigned = new Map<string, ClaudeNode>();
  /** Subagents by the key their star is assigned under, until that star has gone back and faded. */
  private readonly agents = new Map<string, Subagent>();
  private made = 0;
  private agentsMade = 0;
  private readonly tethers: THREE.LineSegments;
  private readonly tetherMaterial: THREE.ShaderMaterial;
  private readonly tetherPositions: THREE.BufferAttribute;
  private readonly tetherFades: THREE.BufferAttribute;
  /** How far along its line each tether vertex sits, 0 at the conversation's star. */
  private readonly tetherAlong: Float32Array;
  private readonly waiting = new THREE.Vector3();

  constructor(
    private readonly home: THREE.Vector3,
    private readonly size: number,
    private readonly uniforms: SharedUniforms,
  ) {
    // A line per subagent back to its conversation's star: its vertices follow both stars on the CPU, and the shader flows along it.
    const vertices = MAX_TETHERS * TETHER_SEGMENTS * 2;
    this.tetherAlong = Float32Array.from({ length: vertices }, (_, v) => ((Math.floor(v / 2) % TETHER_SEGMENTS) + (v % 2)) / TETHER_SEGMENTS);
    this.tetherPositions = new THREE.BufferAttribute(new Float32Array(vertices * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.tetherFades = new THREE.BufferAttribute(new Float32Array(vertices), 1).setUsage(THREE.DynamicDrawUsage);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', this.tetherPositions);
    geometry.setAttribute('aT', new THREE.BufferAttribute(this.tetherAlong, 1));
    geometry.setAttribute('aFade', this.tetherFades);
    geometry.setDrawRange(0, 0);
    this.tetherMaterial = new THREE.ShaderMaterial({
      vertexShader: TETHER_VERTEX,
      fragmentShader: TETHER_FRAGMENT,
      uniforms: { uTime: uniforms.uTime, uColor: { value: new THREE.Vector3(...PALETTE.agentHalo) } },
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.tethers = new THREE.LineSegments(geometry, this.tetherMaterial);
    this.tethers.frustumCulled = false;
    this.tethers.renderOrder = 9;
    this.group.add(this.tethers);
    this.add(false);
  }

  /** Stars drawn right now, subagents' included. */
  get count(): number {
    return this.stars.length;
  }

  /** The conversation `key`'s star, taking a free one or making one on its first use. */
  star(key: string): ClaudeNode {
    let star = this.assigned.get(key);
    if (!star) {
      star = this.stars.find((candidate) => !candidate.subagent && !this.isAssigned(candidate) && candidate.homeward && !candidate.retiring) ?? this.add(true);
      this.assigned.set(key, star);
    }
    return star;
  }

  /**
   * The subagent `agent` of the conversation `key`, drawn under `sub`: a star of its own comes out of the conversation's
   * and waits beside it until it works on a file. A subagent already out only learns its `name`, if it had none.
   */
  spawn(sub: string, key: string, agent: string, name: string | undefined): void {
    const out = this.agents.get(sub);
    if (out && !out.done) {
      out.name ??= name;
      return;
    }
    // Seen again after its end: a new star, while the one going back fades on its own.
    if (out) this.agents.delete(sub);
    const star = this.make(this.star(key).position, this.size * AGENT_SCALE, true, true);
    const angle = this.agentsMade++ * GOLDEN_ANGLE;
    this.assigned.set(sub, star);
    this.agents.set(sub, { key, agent, name, star, offset: new THREE.Vector3(Math.cos(angle), 0.4, Math.sin(angle)).normalize(), working: false, done: false });
  }

  /** Where the conversation `key`'s star is, or the first star's home if it has none. */
  position(key: string | undefined): THREE.Vector3 {
    return (key === undefined ? undefined : this.assigned.get(key))?.position ?? this.stars[0]?.position ?? this.home;
  }

  /** The stable id of the star drawn at `index` right now (a pick result), or undefined past the end of the array. */
  idAt(index: number): number | undefined {
    return this.stars[index]?.id;
  }

  /** Where the star `id` is, if it is still drawn: undefined once it has faded out and gone. */
  positionById(id: number): THREE.Vector3 | undefined {
    return this.stars.find((star) => star.id === id)?.position;
  }

  /** The subagent the star `id` draws: its conversation, the id of the tool call running it, and its type. Undefined for any other star. */
  agentOf(id: number): { key: string; agent: string; name: string | undefined } | undefined {
    for (const { key, agent, name, star } of this.agents.values()) if (star.id === id) return { key, agent, name };
    return undefined;
  }

  /** The stable ids of the subagents' stars drawn right now, those going back included. */
  get agentIds(): number[] {
    return [...this.agents.values()].map((agent) => agent.star.id);
  }

  /** Id pass: every star draws its pick id (PICK_CLAUDE_BASE + its stable id, baked in at construction) instead of its light; the lines are left out. */
  setPickPass(on: boolean): void {
    for (const star of this.stars) star.setPickPass(on);
    this.tethers.visible = !on;
  }

  /** Home moves (the view switched between Nested and Flat): every conversation's star takes its place around the new one. */
  rehome(home: THREE.Vector3): void {
    this.home.copy(home);
    for (const star of this.stars) if (!star.subagent) star.rehome(this.homeOf(star.id));
  }

  /** A turn is running somewhere: a star at home that no conversation has yet wears the ring, until it is taken or the turns end. */
  busy(): void {
    const free = this.stars.find((candidate) => !candidate.subagent && !this.isAssigned(candidate) && !candidate.retiring);
    free?.busy();
  }

  /** The conversation or subagent `key` works on the file at `point`: its star moves over it and flares. */
  workOn(key: string, point: THREE.Vector3, kind: 'read' | 'edit', at: number): void {
    this.star(key).workOn(point, kind, at);
    const agent = this.agents.get(key);
    if (agent) agent.working = true;
  }

  /** The conversation `key`'s turn ended: its star goes home and is free for the next one. */
  goHome(key: string): void {
    const star = this.assigned.get(key);
    this.assigned.delete(key);
    star?.goHome();
  }

  /** The subagent drawn under `sub` is done: its star goes back into its conversation's, and fades there. */
  recall(sub: string): void {
    const agent = this.agents.get(sub);
    if (!agent || agent.done) return;
    agent.done = true;
    this.assigned.delete(sub);
    agent.star.returnTo(this.position(agent.key));
  }

  /** No turn runs anywhere: every star goes home, and subagents' back into their conversations'. */
  rest(): void {
    for (const star of this.stars) star.goHome();
    this.assigned.clear();
    for (const agent of this.agents.values()) agent.done = true;
  }

  /** Returns true while any star moves, flares or fades. Stars beyond the first fade out once home and unassigned. */
  update(dt: number): boolean {
    for (const agent of this.agents.values()) {
      // Beside its conversation's star until it works on a file, back into it once done; that star may move meanwhile.
      const parent = this.position(agent.key);
      if (agent.done) agent.star.returnTo(parent);
      else if (!agent.working) agent.star.wait(this.waiting.copy(agent.offset).multiplyScalar(this.size * AGENT_WAIT).add(parent));
    }
    let moving = false;
    for (const star of this.stars) {
      const home = star.subagent ? star.nearHome : star.atHome;
      if (star !== this.stars[0] && !this.isAssigned(star) && star.resting && home && !star.retiring) star.retire();
      if (star.update(dt)) moving = true;
    }
    const gone = this.stars.filter((star) => star.gone && star !== this.stars[0]);
    for (const star of gone) {
      this.group.remove(star.mesh);
      star.dispose();
    }
    if (gone.length > 0) {
      this.stars = this.stars.filter((star) => !gone.includes(star));
      for (const [sub, agent] of this.agents) if (gone.includes(agent.star)) this.agents.delete(sub);
    }
    this.drawTethers();
    return moving;
  }

  /** Continues every star of the layer this one replaces, with the same conversations and subagents. */
  adopt(previous: ClaudeLayer): void {
    for (const star of this.stars) {
      this.group.remove(star.mesh);
      star.dispose();
    }
    this.stars = previous.stars.map((before) => {
      const star = new ClaudeNode(before.id, before.home, before.subagent ? this.size * AGENT_SCALE : this.size, this.uniforms, false, before.subagent);
      star.adopt(before);
      this.group.add(star.mesh);
      return star;
    });
    this.made = previous.made;
    this.agentsMade = previous.agentsMade;
    const successor = (before: ClaudeNode) => this.stars[previous.stars.indexOf(before)];
    for (const [key, before] of previous.assigned) {
      const star = successor(before);
      if (star) this.assigned.set(key, star);
    }
    for (const [sub, before] of previous.agents) {
      const star = successor(before.star);
      if (star) this.agents.set(sub, { ...before, star, offset: before.offset.clone() });
    }
  }

  dispose(): void {
    for (const star of this.stars) star.dispose();
    this.tethers.geometry.dispose();
    this.tetherMaterial.dispose();
  }

  private isAssigned(star: ClaudeNode): boolean {
    for (const assigned of this.assigned.values()) if (assigned === star) return true;
    return false;
  }

  /** A new star for a conversation. */
  private add(fadeIn: boolean): ClaudeNode {
    return this.make(this.homeOf(this.made), this.size, fadeIn, false);
  }

  /** The home of the conversation star `id`: the layer's home for the first, a place on a ring around it for the others. */
  private homeOf(id: number): THREE.Vector3 {
    const angle = id * GOLDEN_ANGLE;
    return id === 0 ? this.home.clone() : this.home.clone().add(new THREE.Vector3(Math.cos(angle), 0.2 * Math.sin(angle * 1.7), Math.sin(angle)).multiplyScalar(this.size * HOME_RING));
  }

  private make(home: THREE.Vector3, size: number, fadeIn: boolean, subagent: boolean): ClaudeNode {
    const star = new ClaudeNode(this.made++, home, size, this.uniforms, fadeIn, subagent);
    this.stars.push(star);
    this.group.add(star.mesh);
    return star;
  }

  /** A faint line from each subagent's star back to its conversation's, lifted into a shallow arc. */
  private drawTethers(): void {
    const positions = this.tetherPositions.array as Float32Array;
    const fades = this.tetherFades.array as Float32Array;
    let count = 0;
    for (const agent of this.agents.values()) {
      if (count === MAX_TETHERS) break;
      const from = this.position(agent.key);
      const to = agent.star.position;
      const lift = from.distanceTo(to) * 0.1;
      const fade = agent.star.fade;
      for (let v = count * TETHER_SEGMENTS * 2, end = v + TETHER_SEGMENTS * 2; v < end; v++) {
        const u = this.tetherAlong[v];
        positions[v * 3] = from.x + (to.x - from.x) * u;
        positions[v * 3 + 1] = from.y + (to.y - from.y) * u + lift * 4 * u * (1 - u);
        positions[v * 3 + 2] = from.z + (to.z - from.z) * u;
        fades[v] = fade;
      }
      count++;
    }
    this.tethers.geometry.setDrawRange(0, count * TETHER_SEGMENTS * 2);
    if (count === 0) return;
    this.tetherPositions.needsUpdate = true;
    this.tetherFades.needsUpdate = true;
  }
}
