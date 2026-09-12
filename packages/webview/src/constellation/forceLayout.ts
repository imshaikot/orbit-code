// A small 3D force simulation for the skill and history constellations: tens of nodes, so plain O(n²) repulsion,
// springs along links, and a pull toward each node's anchor. It runs a tick per frame while the panel is open, which
// is what makes the graph unfold when it appears and settle again after a node is dragged.

export interface ForceNode {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Where the node is pulled, per axis with `pull`. A pull of 1 or more pins the node to its anchor on that axis. */
  anchor: [number, number, number];
  pull: [number, number, number];
  /** How hard it pushes other nodes away. */
  charge: number;
  /** Held where it is (dragged). */
  fixed: boolean;
}

export interface ForceLink {
  source: number;
  target: number;
  distance: number;
  strength: number;
}

const ALPHA_MIN = 0.004;
const ALPHA_DECAY = 0.975;
const VELOCITY_KEPT = 0.62;

export class ForceLayout {
  alpha = 1;

  constructor(
    readonly nodes: ForceNode[],
    readonly links: ForceLink[],
  ) {}

  get settled(): boolean {
    return this.alpha < ALPHA_MIN;
  }

  reheat(alpha: number): void {
    this.alpha = Math.max(this.alpha, alpha);
  }

  /** Ticks until settled, at most `ticks` of them: for reduced motion. */
  settle(ticks: number): void {
    for (let k = 0; k < ticks && this.step(); k++);
  }

  /** One tick. False once settled. */
  step(): boolean {
    if (this.settled) return false;
    const { nodes, links, alpha } = this;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let dz = a.z - b.z;
        let d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < 1e-6) {
          // Coincident: separate them along a direction that depends on the pair, so it is not the same for all.
          dx = Math.cos(i * 2.39996 + j);
          dy = Math.sin(i * 2.39996 + j);
          dz = 0;
          d2 = 1;
        }
        const d = Math.sqrt(d2);
        const push = (alpha * (a.charge + b.charge) * 0.5) / Math.max(d2, 0.8);
        const fx = (dx / d) * push;
        const fy = (dy / d) * push;
        const fz = (dz / d) * push;
        a.vx += fx;
        a.vy += fy;
        a.vz += fz;
        b.vx -= fx;
        b.vy -= fy;
        b.vz -= fz;
      }
    }
    for (const link of links) {
      const a = nodes[link.source];
      const b = nodes[link.target];
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dz = b.z - a.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-3;
      const k = ((d - link.distance) / d) * link.strength * alpha * 0.5;
      a.vx += dx * k;
      a.vy += dy * k;
      a.vz += dz * k;
      b.vx -= dx * k;
      b.vy -= dy * k;
      b.vz -= dz * k;
    }
    for (const node of nodes) {
      if (node.fixed) {
        node.vx = node.vy = node.vz = 0;
        continue;
      }
      node.vx = (node.vx + (node.anchor[0] - node.x) * node.pull[0] * alpha) * VELOCITY_KEPT;
      node.vy = (node.vy + (node.anchor[1] - node.y) * node.pull[1] * alpha) * VELOCITY_KEPT;
      node.vz = (node.vz + (node.anchor[2] - node.z) * node.pull[2] * alpha) * VELOCITY_KEPT;
      node.x += node.vx;
      node.y += node.vy;
      node.z += node.vz;
      if (node.pull[0] >= 1) [node.x, node.vx] = [node.anchor[0], 0];
      if (node.pull[1] >= 1) [node.y, node.vy] = [node.anchor[1], 0];
      if (node.pull[2] >= 1) [node.z, node.vz] = [node.anchor[2], 0];
    }
    this.alpha *= ALPHA_DECAY;
    return true;
  }
}
