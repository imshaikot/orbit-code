// Minimal typings for the parts of d3-force-3d Orbit uses (the package ships none).
declare module 'd3-force-3d' {
  export interface SimulationNode {
    index?: number;
    x?: number;
    y?: number;
    z?: number;
    vx?: number;
    vy?: number;
    vz?: number;
  }

  export interface SimulationLink<N extends SimulationNode> {
    source: number | N;
    target: number | N;
    index?: number;
  }

  type Accessor<T, R = number> = R | ((datum: T) => R);

  export interface Force<N extends SimulationNode> {
    (alpha: number): void;
  }

  export interface Simulation<N extends SimulationNode> {
    tick(iterations?: number): this;
    stop(): this;
    nodes(): N[];
    force(name: string, force: Force<N> | null): this;
    randomSource(source: () => number): this;
    alphaDecay(decay: number): this;
    velocityDecay(decay: number): this;
  }

  export interface ManyBodyForce<N extends SimulationNode> extends Force<N> {
    strength(strength: Accessor<N>): this;
    theta(theta: number): this;
    distanceMax(distance: number): this;
  }

  export interface LinkForce<N extends SimulationNode, L extends SimulationLink<N>> extends Force<N> {
    distance(distance: Accessor<L>): this;
    strength(strength: Accessor<L>): this;
  }

  export interface CollideForce<N extends SimulationNode> extends Force<N> {
    strength(strength: number): this;
    iterations(iterations: number): this;
  }

  export interface PositionForce<N extends SimulationNode> extends Force<N> {
    strength(strength: Accessor<N>): this;
  }

  export function forceSimulation<N extends SimulationNode>(nodes?: N[], numDimensions?: 1 | 2 | 3): Simulation<N>;
  export function forceManyBody<N extends SimulationNode>(): ManyBodyForce<N>;
  export function forceLink<N extends SimulationNode, L extends SimulationLink<N>>(links?: L[]): LinkForce<N, L>;
  export function forceCollide<N extends SimulationNode>(radius?: Accessor<N>): CollideForce<N>;
  export function forceX<N extends SimulationNode>(x?: Accessor<N>): PositionForce<N>;
  export function forceY<N extends SimulationNode>(y?: Accessor<N>): PositionForce<N>;
  export function forceZ<N extends SimulationNode>(z?: Accessor<N>): PositionForce<N>;
}
