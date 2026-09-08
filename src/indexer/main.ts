// dist/indexer.mjs
//
// Worker thread (spawned by the extension host): workerData is an IndexerRequest,
// messages back are IndexerResponse.
// CLI (main thread): `node dist/indexer.mjs <dir> [--out graph.json] [--max N] [--previous graph.json]`
// lists files and then runs itself as a worker, exactly like the extension does.
// --previous updates from an earlier graph the way a live update does.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { type LanguageId, classify, dirnameOf } from '../shared/languages';
import type { GraphChanges, GraphFile, IndexStats, IndexerRequest, IndexerResponse } from '../shared/protocol';
import { TsConfigs, depcruiseEdges } from './depcruise';
import { listFilesOnDisk } from './listFiles';
import { PathIndex } from './pathIndex';
import { loadProjects } from './projects';
import { resolveJsSpecifier, scanImports } from './regexScan';
import type { ScanContext } from './scan';

const MAX_SCAN_BYTES = 1_000_000;
const STAT_CONCURRENCY = 64;
/** An update that would read more than this share of the files again reads all of them. */
const FULL_EXTRACT_SHARE = 0.3;

type Emit = (message: IndexerResponse) => void;

async function indexWorkspace(request: IndexerRequest, emit: Emit): Promise<GraphFile> {
  const started = Date.now();

  const sizes = new Array<number>(request.files.length).fill(-1);
  const mtimes = new Array<number>(request.files.length).fill(0);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: STAT_CONCURRENCY }, async () => {
      while (cursor < request.files.length) {
        const i = cursor++;
        try {
          const info = await stat(request.files[i].path);
          if (info.isFile()) {
            sizes[i] = info.size;
            mtimes[i] = info.mtimeMs;
          }
        } catch {
          // deleted between listing and indexing
        }
      }
    }),
  );
  const present = request.files.flatMap((_, i) => (sizes[i] >= 0 ? [i] : []));
  const files = present.map((i) => request.files[i]);
  const fileSizes = present.map((i) => sizes[i]);
  const fileMtimes = present.map((i) => mtimes[i]);
  emit({ type: 'progress', stage: 'stat', done: files.length, total: files.length });

  const index = new PathIndex(files.map((f) => f.id));
  const projects = await loadProjects(files, fileSizes, index);
  const previous = request.previous?.root === request.root ? request.previous : undefined;
  const plan = previous && planUpdate(previous, files, fileSizes, fileMtimes, index, new Set(request.changed), projects.key);
  const incremental = plan !== undefined && plan.extractCount <= files.length * FULL_EXTRACT_SHARE;

  const jsFiles: number[] = [];
  const scanFiles: Array<{ i: number; language: LanguageId }> = [];
  let jsTotal = 0;
  let scanTotal = 0;
  files.forEach((file, i) => {
    const extractor = classify(file.id)?.extractor ?? 'none';
    if (extractor === 'none') return;
    if (extractor === 'depcruise') jsTotal++;
    else scanTotal++;
    if (incremental && !plan.extract[i]) return;
    if (extractor === 'depcruise') jsFiles.push(i);
    else scanFiles.push({ i, language: extractor });
  });

  const edgeKeys = new Set<number>();
  const addEdge = (source: number, target: number) => {
    if (source !== target) edgeKeys.add(source * files.length + target);
  };
  const unresolved = new Uint32Array(files.length);
  if (incremental) {
    for (const [source, target] of plan.keptEdges) addEdge(source, target);
    plan.keptUnresolved.forEach((count, i) => (unresolved[i] = count));
  }

  const tsconfigs = new TsConfigs(request.root);
  const context: ScanContext = {
    index,
    projects,
    aliases: (fromId, spec) => {
      const tsconfig = projects.tsconfigFor(fromId);
      return tsconfig === undefined ? undefined : tsconfigs.aliases(tsconfig, spec);
    },
  };
  const depcruise = await depcruiseEdges(
    request.root,
    jsFiles,
    index,
    projects,
    tsconfigs,
    (spec, fromId) => resolveJsSpecifier(spec, fromId, context),
    (done) => emit({ type: 'progress', stage: 'depcruise', done, total: jsFiles.length }),
  );
  for (const [source, target] of depcruise.edges) addEdge(source, target);
  for (const [i, count] of depcruise.unresolved) unresolved[i] = count;

  const scanList = [...scanFiles, ...depcruise.failed.map((i) => ({ i, language: 'js' as const }))];
  for (let n = 0; n < scanList.length; n++) {
    const { i, language } = scanList[n];
    unresolved[i] = 0;
    if (fileSizes[i] <= MAX_SCAN_BYTES) {
      try {
        const result = scanImports(language, await readFile(files[i].path, 'utf8'), files[i].id, context);
        for (const target of result.targets) addEdge(i, target);
        unresolved[i] = result.unresolved;
      } catch {
        // unreadable file: keep the node, skip its edges
      }
    }
    if (n % 250 === 249 || n === scanList.length - 1) emit({ type: 'progress', stage: 'regex', done: n + 1, total: scanList.length });
  }

  const sortedKeys = [...edgeKeys].sort((a, b) => a - b);
  const hash = createHash('sha1');
  files.forEach((file, i) => hash.update(`${file.id}\0${fileSizes[i]}\n`));
  for (const key of sortedKeys) hash.update(`${key}\n`);

  // For an update, fallbacks are only known for the files read in this run.
  const stats: IndexStats = {
    files: files.length,
    depcruiseFiles: jsTotal - depcruise.failed.length,
    regexFiles: scanTotal + depcruise.failed.length,
    edges: sortedKeys.length,
    unresolvedImports: unresolved.reduce((sum, count) => sum + count, 0),
    depcruiseFallbacks: depcruise.failed.length,
    ms: Date.now() - started,
    truncated: request.truncated,
    projects: projects.summary,
    ...(plan ? { changes: { ...plan.changes, extracted: jsFiles.length + scanFiles.length } } : {}),
  };

  return {
    version: 1,
    hash: hash.digest('hex'),
    root: request.root,
    projects: projects.key,
    indexedAt: Date.now(),
    stats,
    nodes: files.map((file, i) => ({
      id: file.id,
      path: file.path,
      dir: dirnameOf(file.id),
      size: fileSizes[i],
      mtime: fileMtimes[i],
      unresolved: unresolved[i],
    })),
    edges: sortedKeys.map((key) => ({
      source: files[Math.floor(key / files.length)].id,
      target: files[key % files.length].id,
    })),
  };
}

interface UpdatePlan {
  /** 1 = extract this file's imports again. */
  extract: Uint8Array;
  extractCount: number;
  /** Outgoing edges of files that are not extracted again, between files still in the graph. */
  keptEdges: Array<[number, number]>;
  keptUnresolved: Map<number, number>;
  changes: Omit<GraphChanges, 'extracted'>;
}

/**
 * Which files an update must read again: new ones; changed ones (size, mtime, or reported by the
 * watcher; a node without an mtime counts as changed); importers of removed files; and, when
 * anything was added, files with unresolved imports the new file might satisfy. When the project
 * configuration imports resolve through changed (`projectsKey`), every file.
 */
function planUpdate(
  previous: GraphFile,
  files: readonly { id: string }[],
  sizes: readonly number[],
  mtimes: readonly number[],
  index: PathIndex,
  forced: ReadonlySet<string>,
  projectsKey: string,
): UpdatePlan {
  const before = new Map(previous.nodes.map((node) => [node.id, node]));
  const extract = new Uint8Array(files.length);
  let added = 0;
  let changed = 0;
  files.forEach((file, i) => {
    const node = before.get(file.id);
    if (!node) {
      added++;
      extract[i] = 1;
    } else if (forced.has(file.id) || node.mtime === undefined || node.size !== sizes[i] || node.mtime !== mtimes[i]) {
      changed++;
      extract[i] = 1;
    }
  });
  const removed = previous.nodes.reduce((sum, node) => sum + (index.exact(node.id) === undefined ? 1 : 0), 0);

  if (previous.projects !== projectsKey) {
    // A package name, module path, tsconfig or source root changed: no kept edge can be trusted.
    extract.fill(1);
  } else {
    if (removed > 0) {
      for (const edge of previous.edges) {
        if (index.exact(edge.target) !== undefined) continue;
        const source = index.exact(edge.source);
        if (source !== undefined) extract[source] = 1;
      }
    }
    if (added > 0) {
      files.forEach((file, i) => {
        if ((before.get(file.id)?.unresolved ?? 0) > 0) extract[i] = 1;
      });
    }
  }

  const keptEdges: Array<[number, number]> = [];
  for (const edge of previous.edges) {
    const source = index.exact(edge.source);
    const target = index.exact(edge.target);
    if (source !== undefined && target !== undefined && !extract[source]) keptEdges.push([source, target]);
  }
  const keptUnresolved = new Map<number, number>();
  files.forEach((file, i) => {
    const count = before.get(file.id)?.unresolved ?? 0;
    if (!extract[i] && count > 0) keptUnresolved.set(i, count);
  });

  return { extract, extractCount: extract.reduce((sum, bit) => sum + bit, 0), keptEdges, keptUnresolved, changes: { added, removed, changed } };
}

async function runCli(argv: string[]): Promise<void> {
  const value = (name: string) => {
    const at = argv.indexOf(name);
    return at === -1 ? undefined : argv[at + 1];
  };
  const root = resolve(argv.find((arg, i) => !arg.startsWith('--') && !argv[i - 1]?.startsWith('--')) ?? process.cwd());
  const out = value('--out');
  const listed = await listFilesOnDisk(root, Number(value('--max') ?? 20000));
  console.log(`[orbit] ${root}: ${listed.files.length} files via ${listed.via}${listed.truncated ? ' (truncated)' : ''}`);

  const previousFile = value('--previous');
  const previous = previousFile ? (JSON.parse(readFileSync(previousFile, 'utf8')) as GraphFile) : undefined;
  const request: IndexerRequest = { root, files: listed.files, truncated: listed.truncated, previous };
  const graph = await new Promise<GraphFile>((done, fail) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: request });
    let lastStage = '';
    worker.on('message', (message: IndexerResponse) => {
      if (message.type === 'progress') {
        if (message.stage !== lastStage || message.done === message.total) {
          console.log(`[orbit]   ${message.stage} ${message.done}/${message.total}`);
          lastStage = message.stage;
        }
      } else if (message.type === 'done') done(message.graph);
      else fail(new Error(message.message));
    });
    worker.on('error', fail);
  });

  const s = graph.stats;
  console.log(
    `[orbit] ${s.files} nodes, ${s.edges} edges in ${s.ms} ms ` +
      `(depcruise ${s.depcruiseFiles}, regex ${s.regexFiles}, fallbacks ${s.depcruiseFallbacks}, unresolved local imports ${s.unresolvedImports})`,
  );
  const manifests = Object.entries(s.projects ?? {});
  if (manifests.length) console.log(`[orbit] project config: ${manifests.map(([kind, count]) => `${kind} ${count}`).join(', ')}`);
  if (s.changes) {
    const c = s.changes;
    console.log(`[orbit] update: +${c.added} −${c.removed} ~${c.changed} files, ${c.extracted} extracted again, hash ${graph.hash}`);
  }
  if (out) {
    writeFileSync(out, JSON.stringify(graph));
    console.log(`[orbit] wrote ${out}`);
  }
}

if (!isMainThread && parentPort) {
  const port = parentPort;
  const emit: Emit = (message) => port.postMessage(message);
  indexWorkspace(workerData as IndexerRequest, emit).then(
    (graph) => emit({ type: 'done', graph }),
    (error: unknown) => emit({ type: 'error', message: error instanceof Error ? (error.stack ?? error.message) : String(error) }),
  );
} else if (isMainThread) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
