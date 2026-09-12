import { isAbsolute, join, relative, sep } from 'node:path';
import { dirnameOf } from '@orbit-code/graph/languages';
import { type ICruiseOptions, type ICruiseResult, cruise } from 'dependency-cruiser';
import extractTSConfig from 'dependency-cruiser/config-utl/extract-ts-config';
import { type PathIndex, joinPath } from './pathIndex';
import type { Projects } from './projects';
import type { AliasTargets, Resolved } from './scan';

/** Files per cruise() call. Bounds memory and gives the host progress to show. */
const BATCH_SIZE = 400;

export interface DepcruiseResult {
  edges: Array<[number, number]>;
  /** File → imports that looked local but could not be resolved. */
  unresolved: Map<number, number>;
  /** Files whose batch threw; the caller regex scans them instead. */
  failed: number[];
}

type ParsedTsConfig = ReturnType<typeof extractTSConfig>;

/** tsconfig and jsconfig files, parsed by TypeScript (extends included) on first use and kept for the run. */
export class TsConfigs {
  private readonly parsed = new Map<string, ParsedTsConfig | undefined>();

  constructor(private readonly root: string) {}

  get(id: string): ParsedTsConfig | undefined {
    if (!this.parsed.has(id)) {
      let config: ParsedTsConfig | undefined;
      try {
        config = extractTSConfig(join(this.root, id));
      } catch {
        config = undefined; // unreadable or invalid: no path aliases from it
      }
      this.parsed.set(id, config);
    }
    return this.parsed.get(id);
  }

  /** What `spec` may name through the `paths` and `baseUrl` of tsconfig `id`, as workspace-relative paths. */
  aliases(id: string, spec: string): AliasTargets | undefined {
    const options = this.get(id)?.options as { paths?: Record<string, string[]>; baseUrl?: string; pathsBasePath?: string } | undefined;
    if (!options) return undefined;
    const baseUrl = this.workspacePath(options.baseUrl);
    const pathsBase = this.workspacePath(options.pathsBasePath) ?? baseUrl ?? dirnameOf(id);
    let paths: string[] | undefined;
    let longest = -1;
    // Like TypeScript: the pattern with the longest prefix before its `*` wins.
    for (const [pattern, targets] of Object.entries(options.paths ?? {})) {
      const star = pattern.indexOf('*');
      const prefix = star === -1 ? pattern : pattern.slice(0, star);
      const suffix = star === -1 ? '' : pattern.slice(star + 1);
      const matches = star === -1 ? spec === pattern : spec.length >= prefix.length + suffix.length && spec.startsWith(prefix) && spec.endsWith(suffix);
      if (!matches || prefix.length <= longest) continue;
      longest = prefix.length;
      const middle = star === -1 ? '' : spec.slice(prefix.length, spec.length - suffix.length);
      paths = targets.flatMap((target) => joinPath(pathsBase, target.replace('*', middle)) ?? []);
    }
    return { paths, baseUrl: baseUrl === undefined ? undefined : joinPath(baseUrl, spec) };
  }

  private workspacePath(absolute: string | undefined): string | undefined {
    if (absolute === undefined) return undefined;
    const path = relative(this.root, absolute);
    if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) return undefined;
    return path === '' ? '.' : path.split(sep).join('/');
  }
}

/**
 * Imports of JS/TS files through dependency-cruiser. Each tsconfig's files are cruised with that tsconfig, so path
 * aliases of every package in a monorepo resolve. Specifiers it cannot follow into the graph (a workspace package
 * without node_modules, build output, an alias to a missing file) go to `resolveSpecifier`.
 */
export async function depcruiseEdges(
  root: string,
  files: readonly number[],
  index: PathIndex,
  projects: Projects,
  tsconfigs: TsConfigs,
  resolveSpecifier: (spec: string, fromId: string) => Resolved,
  onProgress: (done: number) => void,
): Promise<DepcruiseResult> {
  const base: ICruiseOptions = {
    baseDir: root,
    // Every file is passed explicitly, so only direct dependencies are needed.
    maxDepth: 1,
    doNotFollow: 'node_modules',
    exclude: 'node_modules',
    moduleSystems: ['es6', 'cjs', 'tsd', 'amd'],
    tsPreCompilationDeps: true,
    parser: 'tsc',
    skipAnalysisNotInRules: true,
  };

  const groups = new Map<string, number[]>();
  for (const i of files) {
    const tsconfig = projects.tsconfigFor(index.ids[i]) ?? '';
    const group = groups.get(tsconfig);
    if (group) group.push(i);
    else groups.set(tsconfig, [i]);
  }

  const edges: Array<[number, number]> = [];
  const failed: number[] = [];
  const unresolved = new Map<number, number>();
  const countUnresolved = (source: number) => unresolved.set(source, (unresolved.get(source) ?? 0) + 1);
  let done = 0;

  for (const [tsconfig, group] of groups) {
    const tsConfig = tsconfig ? tsconfigs.get(tsconfig) : undefined;
    const options: ICruiseOptions = tsConfig ? { ...base, tsConfig: { fileName: join(root, tsconfig) } } : base;
    for (let start = 0; start < group.length; start += BATCH_SIZE) {
      const batch = group.slice(start, start + BATCH_SIZE);
      try {
        const { output } = await cruise(
          batch.map((i) => index.ids[i]),
          options,
          undefined,
          tsConfig ? { tsConfig } : undefined,
        );
        for (const module of (output as ICruiseResult).modules) {
          const source = index.exact(module.source);
          if (source === undefined) continue;
          for (const dependency of module.dependencies) {
            if (dependency.coreModule) continue;
            const target = dependency.couldNotResolve ? undefined : index.exact(dependency.resolved);
            if (target !== undefined) {
              if (target !== source) edges.push([source, target]);
            } else if (dependency.module.startsWith('.')) {
              if (dependency.couldNotResolve) countUnresolved(source);
            } else {
              const resolved = resolveSpecifier(dependency.module, index.ids[source]);
              if (resolved?.length === 0) countUnresolved(source);
              for (const via of resolved ?? []) if (via !== source) edges.push([source, via]);
            }
          }
        }
      } catch {
        failed.push(...batch);
      }
      done += batch.length;
      onProgress(done);
    }
  }

  return { edges, unresolved, failed };
}
