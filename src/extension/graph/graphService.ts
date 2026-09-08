import * as vscode from 'vscode';
import type { ListedFiles } from '../../indexer/listFiles';
import { toColumnar } from '../../shared/columnar';
import { ALWAYS_EXCLUDED_DIRS, FALLBACK_EXCLUDED_DIRS, dirnameOf, isIndexable } from '../../shared/languages';
import { extendLayout } from '../../shared/layoutExtend';
import type { GraphFile, LayoutSnapshot } from '../../shared/protocol';
import { listWorkspaceFiles } from './files';
import { type IndexerProgress, runIndexer } from './indexClient';
import { type PathResolver, createPathResolver } from './pathResolver';
import { Store, normalizeLayout } from './store';
import type { WatchedChanges } from './watcher';

export interface LoadedGraph {
  graph: GraphFile;
  /** Workspace folder name, display only. */
  folderName: string;
  /** Read from graph.json rather than indexed just now. */
  cached: boolean;
  /** The frozen layout for `graph.hash`, once one is cached or computed. */
  layout: LayoutSnapshot | undefined;
  resolve: PathResolver;
  /** Set when a live update replaced the previous graph; `layout` then extends the previous layout. */
  update?: GraphUpdateInfo;
}

export interface GraphUpdateInfo {
  baseHash: string;
  /** Previous node index → new node index, -1 for removed files. */
  remap: Int32Array;
  added: Uint32Array;
  removed: Uint32Array;
}

export type GraphStatus = { phase: 'indexing'; message: string; progress: number } | { phase: 'error'; message: string };

interface RefreshJob {
  touched: Set<string>;
  deleted: Set<string>;
  /** New id → id before, for files Orbit renamed: within their directory they keep their place. */
  renamed: Map<string, string>;
  /** Stat every file, even if the watcher reported nothing relevant. */
  sweep: boolean;
}

const STAGES: Record<IndexerProgress['stage'], { label: string; start: number; span: number }> = {
  stat: { label: 'Reading file sizes', start: 0.05, span: 0.05 },
  depcruise: { label: 'dependency-cruiser', start: 0.1, span: 0.7 },
  regex: { label: 'Regex import scan', start: 0.8, span: 0.2 },
};

/**
 * Owns the workspace graph: the cached graph.json, indexing on a worker thread, live updates
 * from file changes, and frozen layouts. Knows nothing about panels or sessions.
 */
export class GraphService implements vscode.Disposable {
  private readonly statusEmitter = new vscode.EventEmitter<GraphStatus>();
  private readonly graphEmitter = new vscode.EventEmitter<LoadedGraph>();
  readonly onStatus = this.statusEmitter.event;
  /** A graph was loaded, reindexed or updated. */
  readonly onGraph = this.graphEmitter.event;

  private readonly store: Store;
  private loaded: LoadedGraph | undefined;
  private loading = false;
  private generation = 0;
  private indexing: vscode.CancellationTokenSource | undefined;
  private listedVia: ListedFiles['via'] | undefined;
  private pending: RefreshJob | undefined;
  private refreshing = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.LogOutputChannel,
    private readonly maxFiles: () => number,
  ) {
    this.store = new Store(context);
  }

  get current(): LoadedGraph | undefined {
    return this.loaded;
  }

  /** Loads the cached graph, or indexes, unless a graph is already loaded or on its way. */
  ensureLoaded(): void {
    if (!this.loaded && !this.loading) void this.load(false);
  }

  /**
   * A newer load supersedes an older one and any update in progress; only the newest fires `onGraph`.
   * `reindex` starts over: a full index, and no cached layout, so the webview lays the graph out again.
   */
  async load(reindex: boolean): Promise<void> {
    const generation = ++this.generation;
    this.indexing?.cancel();
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      this.statusEmitter.fire({ phase: 'error', message: 'Open a folder first, there is nothing to index.' });
      return;
    }
    this.loading = true;
    try {
      const stored = reindex ? undefined : await this.store.readGraph();
      const cached = stored !== undefined && stored.root === folder.uri.fsPath;
      const graph = cached ? stored : await this.index(folder);
      const layout = reindex ? undefined : await this.store.readLayout(graph.hash);
      if (generation !== this.generation) return;
      this.loaded = {
        graph,
        folderName: folder.name,
        cached,
        layout,
        resolve: createPathResolver(graph.root, graph.nodes.map((node) => node.id)),
      };
      this.log.info(
        `graph ${graph.hash.slice(0, 12)}: ${graph.stats.files} files, ${graph.stats.edges} edges, ` +
          `${cached ? 'from cache' : `indexed in ${graph.stats.ms} ms`}, layout ${layout ? 'cached' : reindex ? 'to be computed again' : 'not cached'}`,
      );
      this.graphEmitter.fire(this.loaded);
      // Files may have changed while VS Code was closed.
      if (cached) this.refresh();
    } catch (error) {
      if (error instanceof vscode.CancellationError || generation !== this.generation) return;
      this.log.error(error instanceof Error ? error : String(error));
      this.statusEmitter.fire({ phase: 'error', message: `Indexing failed: ${error instanceof Error ? error.message : String(error)}` });
    } finally {
      if (generation === this.generation) {
        this.loading = false;
        void this.drainRefreshes();
      }
    }
  }

  /**
   * Brings the loaded graph up to date with the disk, reading only what changed, and extends the
   * layout instead of recomputing it. Without `changes` every file is checked (after a cached load).
   * Refreshes run one at a time; requests that arrive meanwhile are merged into the next one. `renamed` lists files
   * Orbit itself renamed, which the watcher would only report as a delete and a create.
   */
  refresh(changes?: WatchedChanges, renamed: ReadonlyArray<{ from: string; to: string }> = []): void {
    if (!this.loaded && !this.loading) return; // nothing to update; the next load reads the disk anyway
    const job = (this.pending ??= { touched: new Set(), deleted: new Set(), renamed: new Map(), sweep: false });
    if (!changes) job.sweep = true;
    for (const id of changes?.touched ?? []) job.touched.add(id);
    for (const id of changes?.deleted ?? []) job.deleted.add(id);
    for (const { from, to } of renamed) {
      // Renamed twice before an update ran: the file is still known by its first name.
      job.renamed.set(to, job.renamed.get(from) ?? from);
      job.renamed.delete(from);
    }
    void this.drainRefreshes();
  }

  /** Persists a layout the webview computed, if it still belongs to the current graph. */
  saveLayout(raw: unknown): void {
    const layout = normalizeLayout(raw);
    if (!layout || !this.loaded || layout.hash !== this.loaded.graph.hash) return;
    this.loaded.layout = layout;
    this.store.writeLayout(layout).catch((error) => this.log.warn(`could not cache layout: ${error}`));
  }

  dispose(): void {
    this.generation++;
    this.pending = undefined;
    this.indexing?.cancel();
    this.statusEmitter.dispose();
    this.graphEmitter.dispose();
  }

  private async index(folder: vscode.WorkspaceFolder): Promise<GraphFile> {
    this.statusEmitter.fire({ phase: 'indexing', message: 'Listing files', progress: 0.02 });
    const listed = await listWorkspaceFiles(folder, this.maxFiles());
    this.listedVia = listed.via;
    this.log.info(`listed ${listed.files.length} files via ${listed.via}${listed.truncated ? ' (truncated)' : ''}`);

    const cancellation = new vscode.CancellationTokenSource();
    this.indexing = cancellation;
    try {
      const request = { root: folder.uri.fsPath, files: listed.files, truncated: listed.truncated };
      const graph = await runIndexer(
        this.context.extensionUri,
        request,
        (progress) => {
          const stage = STAGES[progress.stage];
          this.statusEmitter.fire({
            phase: 'indexing',
            message: `${stage.label} · ${progress.done} / ${progress.total}`,
            progress: stage.start + stage.span * (progress.total ? progress.done / progress.total : 1),
          });
        },
        cancellation.token,
      );
      await this.store.writeGraph(graph);
      return graph;
    } finally {
      if (this.indexing === cancellation) this.indexing = undefined;
      cancellation.dispose();
    }
  }

  private async drainRefreshes(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      while (this.pending && this.loaded && !this.loading) {
        const job = this.pending;
        this.pending = undefined;
        try {
          await this.update(this.loaded, job);
        } catch (error) {
          if (!(error instanceof vscode.CancellationError)) this.log.error(`graph update failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
        }
      }
    } finally {
      this.refreshing = false;
    }
  }

  private async update(base: LoadedGraph, job: RefreshJob): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder || folder.uri.fsPath !== base.graph.root) return;
    const generation = this.generation;
    const started = Date.now();
    const current = () => generation === this.generation && this.loaded === base;

    // Most events cannot change the graph (build output, files outside it): skip those without listing.
    const known = new Set(base.graph.nodes.map((node) => node.id));
    const excluded = this.listedVia === 'git' ? ALWAYS_EXCLUDED_DIRS : new Set(FALLBACK_EXCLUDED_DIRS);
    const forced = [...job.touched].filter((id) => known.has(id));
    const maybeAdded = [...job.touched].some((id) => !known.has(id) && isIndexable(id, excluded));
    if (!job.sweep && forced.length === 0 && !maybeAdded && !removesKnown(base.graph, known, job.deleted)) return;

    const listed = await listWorkspaceFiles(folder, this.maxFiles());
    if (!current()) return;
    this.listedVia = listed.via;
    if (!job.sweep && forced.length === 0 && sameIds(listed.files, base.graph.nodes)) return;

    const cancellation = new vscode.CancellationTokenSource();
    this.indexing = cancellation;
    let graph: GraphFile;
    try {
      const request = { root: folder.uri.fsPath, files: listed.files, truncated: listed.truncated, previous: base.graph, changed: forced };
      graph = await runIndexer(this.context.extensionUri, request, () => undefined, cancellation.token);
    } finally {
      if (this.indexing === cancellation) this.indexing = undefined;
      cancellation.dispose();
    }
    if (!current()) return;

    if (graph.hash === base.graph.hash) {
      // Nothing drawn changed. Keep new mtimes and the project fingerprint so the next start does not read these files again.
      if (
        graph.projects !== base.graph.projects ||
        graph.nodes.some((node, i) => node.mtime !== base.graph.nodes[i].mtime || node.unresolved !== base.graph.nodes[i].unresolved)
      ) {
        base.graph = { ...graph, indexedAt: base.graph.indexedAt, stats: base.graph.stats };
        await this.store.writeGraph(base.graph);
      }
      return;
    }

    const { nodes, edges } = toColumnar(graph);
    const extension = base.layout && extendLayout(base.graph.nodes.map((node) => node.id), base.layout, { hash: graph.hash, nodes, edges }, job.renamed);
    await this.store.writeGraph(graph);
    if (extension) await this.store.writeLayout(extension.layout);
    if (!current()) return;

    this.loaded = {
      graph,
      folderName: base.folderName,
      cached: false,
      layout: extension?.layout,
      resolve: createPathResolver(graph.root, graph.nodes.map((node) => node.id)),
      update: extension && { baseHash: base.graph.hash, remap: extension.remap, added: extension.added, removed: extension.removed },
    };
    const changes = graph.stats.changes;
    this.log.info(
      `graph updated ${graph.hash.slice(0, 12)}: +${changes?.added ?? 0} −${changes?.removed ?? 0} ~${changes?.changed ?? 0} files, ` +
        `${graph.stats.edges} edges in ${Date.now() - started} ms`,
    );
    this.graphEmitter.fire(this.loaded);
  }
}

/** Whether a deleted path is a graph file, or a folder that held some. */
function removesKnown(graph: GraphFile, known: ReadonlySet<string>, deleted: ReadonlySet<string>): boolean {
  const unknown = [...deleted].filter((id) => !known.has(id));
  if (unknown.length < deleted.size) return true;
  if (unknown.length === 0) return false;
  const folders = new Set<string>();
  for (const node of graph.nodes) {
    for (let dir = node.dir; dir !== '.' && !folders.has(dir); dir = dirnameOf(dir)) folders.add(dir);
  }
  return unknown.some((id) => folders.has(id));
}

function sameIds(files: readonly { id: string }[], nodes: readonly { id: string }[]): boolean {
  return files.length === nodes.length && files.every((file, i) => file.id === nodes[i].id);
}
