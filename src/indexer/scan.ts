// What the import scanners share: the scan context, what a specifier resolves to, and JS-style path lookup
// (for JS family files, package.json entry points, and specifiers dependency-cruiser could not follow).

import { type PathIndex, joinPath } from './pathIndex';
import type { Projects } from './projects';

/** What one specifier may name through a tsconfig or jsconfig, as workspace-relative paths. */
export interface AliasTargets {
  /** Candidates from the `paths` pattern that matched; undefined when none did. */
  paths: string[] | undefined;
  /** The specifier under `baseUrl`, when one is set. */
  baseUrl: string | undefined;
}

export interface ScanContext {
  index: PathIndex;
  projects: Projects;
  /** Aliases from the tsconfig or jsconfig nearest `fromId`; undefined when there is none. */
  aliases(fromId: string, spec: string): AliasTargets | undefined;
}

export interface ScanResult {
  targets: number[];
  /** Imports that looked local but matched no indexed file. */
  unresolved: number;
}

/** number[]: resolved (empty = local but unresolved). null: external, not counted. */
export type Resolved = number[] | null;

export const hit = (index: number | undefined): Resolved => (index === undefined ? [] : [index]);
export const hitOrExternal = (index: number | undefined): Resolved => (index === undefined ? null : [index]);

/** Collects what one file's imports resolved to. */
export class Found {
  private readonly targets = new Set<number>();
  private unresolved = 0;

  add(resolved: Resolved): void {
    if (resolved === null) return;
    if (resolved.length === 0) this.unresolved++;
    for (const target of resolved) this.targets.add(target);
  }

  result(): ScanResult {
    return { targets: [...this.targets], unresolved: this.unresolved };
  }
}

/** The first defined result of `resolve` over `items`. */
export function first<T>(items: readonly T[], resolve: (item: T) => number | undefined): number | undefined {
  for (const item of items) {
    const found = resolve(item);
    if (found !== undefined) return found;
  }
  return undefined;
}

const JS_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '.astro'];

/** A file for a JS-style path: as written, with a script extension instead of the one written, or its directory's index. */
export function resolveJsPath(target: string | undefined, index: PathIndex): number | undefined {
  if (target === undefined) return undefined;
  const exact = index.exact(target);
  if (exact !== undefined) return exact;
  const stem = target.replace(/\.d\.[cm]?ts$/, '').replace(/\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/, '');
  return index.withExtension(stem, JS_EXTS) ?? index.withExtension(joinPath(stem, 'index'), JS_EXTS);
}

/** An entry point a package names, mapped back to source when it points into build output: dist/index.js → src/index.ts. */
export function resolveJsEntry(dir: string, entry: string, index: PathIndex): number | undefined {
  const target = joinPath(dir, entry);
  if (target === undefined || (dir !== '.' && !target.startsWith(`${dir}/`))) return undefined;
  const found = resolveJsPath(target, index);
  if (found !== undefined) return found;
  const inPackage = dir === '.' ? target : target.slice(dir.length + 1);
  const source = inPackage.replace(/^(?:dist|build|lib|out|esm|cjs|es|types)\//, 'src/');
  return source === inPackage ? undefined : resolveJsPath(joinPath(dir, source), index);
}
