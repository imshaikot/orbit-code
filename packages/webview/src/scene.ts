import { FILE_KINDS, FILE_KIND_LABELS, type FileKind, fileKindOf } from '@orbit-code/graph/languages';
import type { ActivityDelta, GraphContent, GraphDelta, GraphUpdate } from '@orbit-code/protocol';
import type { HostBridge } from './host';
import type { GraphSummary, KindGroup } from './hud/identity';
import type { ViewMode } from './hud/viewTabs';
import { computeLayout } from './layout/client';
import { KIND_COLORS, type Rgb } from './palette';
import type { Stage } from './stage';
import { World } from './world';

export interface SceneView {
  showStatus(phase: 'layout' | 'error', message: string, progress?: number): void;
  hideStatus(): void;
  graphChanged(summary: GraphSummary): void;
  /** The previous World is gone; drop anything that pointed into it. */
  worldCleared(): void;
  worldReady(world: World): void;
  /** A live update replaced the World in place: node indices moved, the camera and animation did not. */
  worldUpdated(world: World, ms: number): void;
}

/**
 * Graph resets become a laid-out World (from the cached layout, or the layout worker), live updates
 * replace the World in place, and activity deltas animate it. A newer graph supersedes a layout still in progress.
 */
export class SceneController {
  private current: World | undefined;
  private generation = 0;
  private cancelLayout: (() => void) | undefined;
  private working = false;
  /** Every World starts in this view; a live update's World continues its predecessor's. */
  private mode: ViewMode = 'nested';

  constructor(
    private readonly stage: Stage,
    private readonly host: HostBridge,
    private readonly view: SceneView,
  ) {}

  get world(): World | undefined {
    return this.current;
  }

  /** An update applies in place only on top of its base graph; anything else starts over, like a reset. */
  async load(delta: GraphDelta): Promise<void> {
    const previous = this.current;
    if (delta.op === 'update' && previous && previous.graph.hash === delta.baseHash) {
      this.update(previous, delta);
      return;
    }

    const generation = ++this.generation;
    this.cancelLayout?.();
    this.cancelLayout = undefined;
    this.current?.dispose();
    this.current = undefined;
    this.view.worldCleared();
    this.view.graphChanged(summarize(delta));

    let layout = delta.layout;
    if (!layout) {
      const files = delta.nodes.count.toLocaleString('en-US');
      const started = performance.now();
      this.view.showStatus('layout', `Laying out ${files} files`, 0);
      const job = computeLayout({ hash: delta.hash, nodes: delta.nodes, edges: delta.edges }, (progress) => {
        if (generation !== this.generation) return;
        if (progress.stage === 'files') {
          this.view.showStatus('layout', `Laying out ${files} files, directory ${progress.done} of ${progress.total}`, (0.9 * progress.done) / progress.total);
        } else {
          this.view.showStatus('layout', 'Placing directories', 1);
        }
      });
      this.cancelLayout = job.cancel;
      try {
        layout = await job.result;
      } catch (error) {
        if (generation !== this.generation) return;
        const text = error instanceof Error ? error.message : String(error);
        this.view.showStatus('error', `Layout failed: ${text}`);
        this.host.log('error', `layout failed: ${text}`);
        return;
      }
      if (generation !== this.generation) return;
      this.cancelLayout = undefined;
      this.host.log('info', `layout of ${files} files computed in ${Math.round(performance.now() - started)} ms`);
      this.host.post({ type: 'layoutComputed', layout });
    }

    this.view.hideStatus();
    const world = new World(this.stage, delta, layout);
    world.setMode(this.mode, false);
    world.setWorking(this.working);
    this.current = world;
    this.host.post({ type: 'sceneReady', hash: delta.hash });
    this.view.worldReady(world);
  }

  /** Returns whether the delta reached a World (and so a frame is due). */
  activity(delta: ActivityDelta, visible: boolean): boolean {
    const world = this.current;
    if (!world || delta.hash !== world.graph.hash) return false;
    world.enqueue(delta.events, visible, delta.key);
    return true;
  }

  setWorking(working: boolean): void {
    this.working = working;
    this.current?.setWorking(working);
  }

  /** Shows the Nested or Flat view, in the World there is (animated, unless `animate` is false) and in every one after it. */
  setMode(mode: ViewMode, animate: boolean): void {
    this.mode = mode;
    this.current?.setMode(mode, animate);
  }

  private update(previous: World, update: GraphUpdate): void {
    this.generation++;
    const started = performance.now();
    const world = new World(this.stage, update, update.layout, { world: previous, remap: update.remap });
    world.setWorking(this.working);
    world.pulseAdded(update.added);
    previous.dispose();
    this.current = world;
    const ms = performance.now() - started;
    this.view.graphChanged(summarize(update));
    this.host.log('info', `graph update applied: ${update.nodes.count.toLocaleString('en-US')} files (+${update.added.length} −${update.removed.length}) in ${Math.round(ms)} ms`);
    this.view.worldUpdated(world, ms);
  }
}

function summarize(graph: GraphContent): GraphSummary {
  return {
    root: graph.root,
    files: graph.nodes.count,
    imports: graph.edges.length / 2,
    directories: graph.nodes.dirs.length,
    kinds: kindGroups(graph),
  };
}

/** File counts per colour, most files first; kinds sharing a colour are listed together. */
function kindGroups(graph: GraphContent): KindGroup[] {
  const counts = new Map<FileKind, number>();
  for (const name of graph.nodes.names) {
    const kind = fileKindOf(name);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const groups = new Map<Rgb, KindGroup>();
  for (const kind of FILE_KINDS) {
    const count = counts.get(kind);
    if (!count) continue;
    const color = KIND_COLORS[kind];
    const group = groups.get(color) ?? { labels: [], color, count: 0 };
    group.labels.push(FILE_KIND_LABELS[kind]);
    group.count += count;
    groups.set(color, group);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}
