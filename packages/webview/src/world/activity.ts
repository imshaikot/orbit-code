import type { ActivityEvent } from '@orbit-code/protocol';
import type * as THREE from 'three';
import type { Bubbles } from '../bubbles';
import type { ClaudeLayer } from '../claude';
import { FIRING_FADE_S } from '../edges';
import type { McpLayer } from '../mcp';
import type { NodeState } from '../nodeState';
import type { ParticleLayer } from '../particles';
import type { SharedUniforms } from '../uniforms';

/** Gap between events that arrive in the same batch (parallel tool calls), in seconds. */
const STAGGER_S = 0.14;
const MAX_QUEUE_LAG_S = 1;
/** Import lines keep firing this long after the latest sign of thinking, in seconds, before they fade. */
const FIRING_HOLD_S = 2.5;
const ACTIVE_LABELS = 6;

interface Touch {
  node: number;
  kind: 'read' | 'edit';
  at: number;
}

/** A read whose comet is in flight: its file and bubbles light up at `at`, when it lands. */
interface Landing {
  node: number;
  at: number;
  key: string;
}

/** An activity event waiting its turn in the queue, with the conversation it belongs to. */
interface Pending {
  event: ActivityEvent;
  key: string;
  applyAt: number;
}

/** What activity plays on: one World's layers, and how it asks that World for frames and labels. */
export interface ActivityLayers {
  uniforms: SharedUniforms;
  state: NodeState;
  bubbles: Bubbles;
  particles: ParticleLayer;
  claude: ClaudeLayer;
  mcp: McpLayer;
  clusterOf: Uint16Array;
  count: number;
  /** Where a file is drawn right now. */
  position(node: number): THREE.Vector3;
  /** Where a star working on a file hovers over it. */
  starPoint(node: number): THREE.Vector3;
  /** Keeps frames coming until `until` on the scene clock. */
  keepAnimating(until: number): void;
  labelsChanged(): void;
}

/** The key a subagent's star is drawn under: its conversation's key, then the id of the tool call running it. */
function subagentKey(key: string, agent: string): string {
  return `${key}/${agent}`;
}

/** How session activity animates one World: queued events, comets landing, thinking, subagents and turns ending. */
export class Activity {
  private readonly pending: Pending[] = [];
  /** A read's glow is written when its comet lands, never at launch: shaders draw a time ahead of the clock as unlit, which would put out a glow already there. */
  private landings: Landing[] = [];
  /** Conversations with a turn drawn on the graph, and their subagents at work: rest comes when the last of them ends. */
  private active = new Set<string>();
  /** Subagents with a star out, by their key (`subagentKey`), with the conversation each works for. */
  private subagents = new Map<string, string>();
  /** The conversation that last touched a file, whose star follows files a live update adds mid-turn. */
  private lastKey: string | undefined;
  private lastQueuedAt = -Infinity;
  private touches: Touch[] = [];
  private working = false;

  constructor(private readonly layers: ActivityLayers) {}

  /** Files lately read or edited, oldest first, which keep a label. */
  get touched(): readonly Touch[] {
    return this.touches;
  }

  /** Import edges flow faster, and a star at home wears its ring, while any conversation is working. Every turn's end takes its star home. */
  setWorking(working: boolean): void {
    this.working = working;
    if (working) this.layers.claude.busy();
    // Turns that ended without their turnEnd reaching the scene (the panel was replaced, the host restarted) still let stars and MCP stations go.
    if (!working) {
      this.layers.mcp.settle(this.layers.uniforms.uTime.value);
      this.layers.claude.rest();
      this.active.clear();
      this.subagents.clear();
    }
  }

  /** Queues a delta's events, from the conversation `key`. Hidden panels apply them at once, without particles or firing. */
  enqueue(events: readonly ActivityEvent[], visible: boolean, key: string): void {
    const now = this.layers.uniforms.uTime.value;
    if (!visible) {
      for (const event of events) this.apply(event, now, false, key);
      return;
    }
    let at = Math.max(now, this.lastQueuedAt + STAGGER_S);
    if (at - now > MAX_QUEUE_LAG_S) at = now;
    for (const event of events) {
      if (event.kind === 'thinking') {
        // No file to fly to, so no place in the queue: the firing starts now.
        this.active.add(key);
        this.think(now);
        continue;
      }
      this.pending.push({ event, key, applyAt: at });
      this.lastQueuedAt = at;
      at += STAGGER_S;
    }
  }

  /** Files a live update added: during a turn they glow like edits until it ends, and Claude's star goes to the last of them; otherwise they pulse once. */
  pulseAdded(added: Uint32Array): void {
    if (added.length === 0) return;
    const { uniforms, state, bubbles, clusterOf, count } = this.layers;
    const t = uniforms.uTime.value;
    let written = -1;
    for (const node of added) {
      if (node >= count) continue;
      if (!this.working) {
        state.added(node, t);
        continue;
      }
      state.edit(node, t, uniforms.uRestT.value);
      bubbles.touch(clusterOf[node], t);
      this.remember(node, 'edit', t);
      written = node;
    }
    if (written >= 0 && this.lastKey !== undefined && this.active.has(this.lastKey)) this.moveClaude(written, 'edit', t, this.lastKey);
    this.layers.keepAnimating(t + 3);
    this.layers.labelsChanged();
  }

  /** Plays the queued events whose time has come, lights the files comets landed on, and eases the lines' flow. Returns whether another frame is needed. */
  update(t: number, dt: number): boolean {
    while (this.pending.length > 0 && this.pending[0].applyAt <= t) {
      const { event, key } = this.pending.shift()!;
      this.apply(event, t, true, key);
    }
    this.land(t);
    const flow = this.layers.uniforms.uFlow;
    const flowTarget = this.working ? 1 : 0;
    flow.value += (flowTarget - flow.value) * Math.min(1, dt * 2);
    return this.pending.length > 0 || flowTarget > 0 || Math.abs(flow.value - flowTarget) > 0.01;
  }

  /** Takes over the replaced World's queue, comets, touched files, conversations and subagents; `node` maps its node indices to these. */
  adopt(previous: Activity, node: (i: number) => number): void {
    this.touches = previous.touches.flatMap((touch) => (node(touch.node) >= 0 ? [{ ...touch, node: node(touch.node) }] : []));
    this.landings = previous.landings.flatMap((landing) => (node(landing.node) >= 0 ? [{ ...landing, node: node(landing.node) }] : []));
    for (const { event, key, applyAt } of previous.pending) {
      if (!('node' in event)) this.pending.push({ event, key, applyAt });
      else if (node(event.node) >= 0) this.pending.push({ event: { ...event, node: node(event.node) }, key, applyAt });
    }
    this.active = new Set(previous.active);
    this.subagents = new Map(previous.subagents);
    this.lastKey = previous.lastKey;
    this.lastQueuedAt = previous.lastQueuedAt;
    this.working = previous.working;
  }

  private remember(node: number, kind: 'read' | 'edit', at: number): void {
    this.touches = this.touches.filter((touch) => touch.node !== node);
    this.touches.push({ node, kind, at });
    if (this.touches.length > ACTIVE_LABELS) this.touches.shift();
  }

  /** Claude is thinking: import lines on screen fire until FIRING_HOLD_S after the latest sign of it, then fade (edges.ts). */
  private think(t: number): void {
    const { uThinkStart, uThinkEnd } = this.layers.uniforms;
    // A new burst, unless one is still running or fading: that one carries on, in phase.
    if (t > uThinkEnd.value + FIRING_FADE_S) uThinkStart.value = t;
    uThinkEnd.value = Math.max(uThinkEnd.value, t + FIRING_HOLD_S);
    this.layers.keepAnimating(uThinkEnd.value + FIRING_FADE_S);
  }

  /** One event of the conversation `key`'s turn. */
  private apply(event: ActivityEvent, t: number, animate: boolean, key: string): void {
    const { uniforms, state, bubbles, particles, claude, mcp } = this.layers;
    if (event.kind === 'thinking') {
      // Hidden panels skip it, like comets: the clock stands still while hidden, so the burst would play late.
      this.active.add(key);
      if (animate) this.think(t);
      return;
    }
    if (event.kind === 'agentStart') {
      this.startAgent(key, event.agent, event.name, t);
      return;
    }
    if (event.kind === 'agentEnd') {
      this.endAgent(subagentKey(key, event.agent), t);
      return;
    }
    if (event.kind === 'mcp') {
      // Hidden panels skip it, like comets: its pulses are timed on a clock that stands still while hidden.
      if (!animate) return;
      const by = event.agent === undefined ? key : this.startAgent(key, event.agent, undefined, t);
      this.active.add(by);
      claude.star(by);
      if (event.phase === 'call') mcp.call(event.server, event.tool, t, by);
      else mcp.answer(event.server, event.phase === 'done', t);
      if (!this.working) mcp.settle(t);
      this.layers.keepAnimating(t + 1.5);
      this.layers.labelsChanged();
      return;
    }
    if (event.kind === 'turnEnd') {
      for (const [sub, owner] of [...this.subagents]) if (owner === key) this.endAgent(sub, t);
      this.active.delete(key);
      // Comets still in flight, its subagents' too, light nothing: lit after the rest, their files would never fade.
      this.landings = this.landings.filter((landing) => landing.key !== key && !landing.key.startsWith(subagentKey(key, '')));
      mcp.settle(t, key);
      claude.goHome(key);
      if (this.active.size === 0) {
        // The last turn on the graph ended: everything fades back to rest.
        uniforms.uRestT.value = t;
        uniforms.uThinkEnd.value = Math.min(uniforms.uThinkEnd.value, t);
        this.touches = [];
        this.landings = [];
      }
      this.layers.keepAnimating(t + 1.2);
      this.layers.labelsChanged();
      return;
    }
    const node = event.node;
    if (node < 0 || node >= this.layers.count) return;
    const cluster = this.layers.clusterOf[node];
    // A subagent's read or edit moves its own star, which comes out of the conversation's if the subagent is new here.
    const by = event.agent === undefined ? key : this.startAgent(key, event.agent, undefined, t);
    this.active.add(by);
    this.lastKey = by;

    if (event.kind === 'read' && animate) {
      // The comet leaves from where the star is, before the star sets off after it.
      const flight = particles.launch(claude.star(by).position, this.layers.position(node), t);
      this.landings.push({ node, at: flight.landsAt, key: by });
      this.layers.keepAnimating(Math.max(flight.goneAt, flight.landsAt + 2.5));
    } else if (event.kind === 'read') {
      state.read(node, t);
      bubbles.touch(cluster, t);
      this.layers.keepAnimating(t + 2.5);
    } else {
      state.edit(node, t, uniforms.uRestT.value);
      bubbles.touch(cluster, t);
      this.layers.keepAnimating(t + 3);
    }

    this.remember(node, event.kind, t);
    this.moveClaude(node, event.kind, t, by);
    this.layers.labelsChanged();
  }

  /** The key the subagent `agent` of the conversation `key` is drawn under; the first time it is seen, its star comes out of the conversation's. */
  private startAgent(key: string, agent: string, name: string | undefined, t: number): string {
    const sub = subagentKey(key, agent);
    if (!this.subagents.has(sub)) {
      this.subagents.set(sub, key);
      this.active.add(sub);
      this.layers.keepAnimating(t + 1);
    }
    this.layers.claude.spawn(sub, key, agent, name);
    return sub;
  }

  /** A subagent is done: its star goes back into its conversation's, and the MCP stations orbiting it leave. */
  private endAgent(sub: string, t: number): void {
    if (!this.subagents.delete(sub)) return;
    this.active.delete(sub);
    this.layers.mcp.settle(t, sub);
    this.layers.claude.recall(sub);
    this.layers.keepAnimating(t + 1.2);
    this.layers.labelsChanged();
  }

  /** Comets that have arrived light up their file and every bubble around it, from the moment each one landed. */
  private land(t: number): void {
    if (this.landings.length === 0) return;
    const flying: Landing[] = [];
    for (const landing of this.landings) {
      if (landing.at > t) {
        flying.push(landing);
        continue;
      }
      this.layers.state.read(landing.node, landing.at);
      this.layers.bubbles.touch(this.layers.clusterOf[landing.node], landing.at);
    }
    this.landings = flying;
  }

  /** The conversation's or subagent's star moves over the file it works on, and flares cyan for a read or amber for an edit. */
  private moveClaude(node: number, kind: 'read' | 'edit', t: number, key: string): void {
    this.layers.claude.workOn(key, this.layers.starPoint(node), kind, t);
  }
}
