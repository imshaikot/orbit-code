// Regex import scan for every language dependency-cruiser does not handle, and for JS/TS files it failed on.
// Each rule pairs an import regex with a resolver that maps the specifier onto files already in the graph,
// through the project configuration (projects.ts) where the language has one. No parsing, no language servers:
// a specifier lands on indexed files, counts as local but unresolved, or is dropped as external.

import { type LanguageId, basenameOf, dirnameOf, extensionOf } from '../shared/languages';
import { scanConfig } from './configScan';
import { type PathIndex, joinPath } from './pathIndex';
import { Found, type Resolved, type ScanContext, type ScanResult, first, hit, hitOrExternal, resolveJsEntry, resolveJsPath } from './scan';

/**
 * What one import statement names. A statement listing several specifiers (`import a, b`, a Go import block, a Rust
 * use tree) resolves each on its own, so one that resolved does not hide another that is local but missing.
 */
type Resolution = Resolved | { each: Resolved[] };
type Resolver = (match: RegExpExecArray, fromId: string, ctx: ScanContext) => Resolution;

interface Rule {
  re: RegExp;
  resolve: Resolver;
}

export function scanImports(language: LanguageId, text: string, fromId: string, ctx: ScanContext): ScanResult {
  if (language === 'config') return scanConfig(text, fromId, ctx);
  if (language === 'notebook') return scanImports('python', notebookCode(text), fromId, ctx);
  const found = new Found();
  for (const rule of RULES[language]) {
    rule.re.lastIndex = 0;
    for (let m = rule.re.exec(text); m !== null; m = rule.re.exec(text)) {
      if (m[0].length === 0) rule.re.lastIndex++;
      const resolution = rule.resolve(m, fromId, ctx);
      if (resolution !== null && !Array.isArray(resolution)) for (const each of resolution.each) found.add(each);
      else found.add(resolution);
    }
  }
  return found.result();
}

/* ── Shared lookups ── */

/** A path relative to the importing file, else the indexed file whose path ends with it (the nearest one). */
function relativeOrSuffix(spec: string, fromId: string, index: PathIndex): number | undefined {
  const relative = index.exact(joinPath(dirnameOf(fromId), spec));
  if (relative !== undefined) return relative;
  const suffix = spec.replace(/^(?:\.\/)+/, '');
  if (suffix === '' || suffix.startsWith('../')) return undefined;
  const candidates = index.pathSuffix(suffix);
  return candidates.length ? index.closest(fromId, candidates) : undefined;
}

/** The nearest file for a module path, trying shorter prefixes of its segments down to `min` of them. */
function modulePath(segments: readonly string[], exts: readonly string[], fromId: string, index: PathIndex, min: number): number | undefined {
  for (let k = segments.length; k >= Math.max(1, Math.min(min, segments.length)); k--) {
    const candidates = index.stemSuffix(segments.slice(0, k).join('/'), exts);
    if (candidates.length) return index.closest(fromId, candidates);
  }
  return undefined;
}

/** A module whose dotted (or `::`) name is its path: found, else external. */
const moduleFile =
  (separator: string, exts: readonly string[]): Resolver =>
  (m, fromId, { index }) => {
    const segments = m[1].split(separator);
    return hitOrExternal(modulePath(segments, exts, fromId, index, segments.length));
  };

/** A path relative to the importing file: found, else external (it may come from a search path). */
const nearby: Resolver = (m, fromId, { index }) => hitOrExternal(relativeOrSuffix(m[1], fromId, index));

/** A file path relative to the importing file, which must exist: found, else unresolved. */
const relativeFile: Resolver = (m, fromId, { index }) => hit(index.exact(joinPath(dirnameOf(fromId), m[1])));

function notebookCode(text: string): string {
  try {
    const notebook = JSON.parse(text) as { cells?: Array<{ cell_type?: string; source?: string | string[] }> };
    return (notebook.cells ?? [])
      .filter((cell) => cell.cell_type === 'code')
      .map((cell) => (Array.isArray(cell.source) ? cell.source.join('') : (cell.source ?? '')))
      .join('\n');
  } catch {
    return '';
  }
}

/* ── JS family (vue, svelte, astro, and JS/TS files dependency-cruiser failed on) ── */

const resolveJs: Resolver = (m, fromId, ctx) => {
  const spec = m[1].split('?')[0];
  if (!spec.startsWith('.')) return resolveJsSpecifier(spec, fromId, ctx);
  const target = joinPath(dirnameOf(fromId), spec);
  return target === undefined ? [] : hit(resolveJsPath(target, ctx.index));
};

/**
 * A bare JS specifier: package.json `imports` (#name), tsconfig `paths` and `baseUrl`, a package of this workspace
 * (by its package.json name), or the @/ and ~/ source aliases. Anything else is an npm dependency or a builtin.
 */
export function resolveJsSpecifier(spec: string, fromId: string, ctx: ScanContext): Resolved {
  const { index, projects } = ctx;
  if (spec.startsWith('#')) {
    const pkg = projects.packageFor(fromId);
    const targets = pkg && matchSubpath(pkg.imports, spec);
    return pkg && targets ? hit(first(targets, (target) => resolveJsEntry(pkg.dir, target, index))) : null;
  }
  const alias = ctx.aliases(fromId, spec);
  if (alias?.paths) return hit(first(alias.paths, (path) => resolveJsPath(path, index)));
  const underBaseUrl = resolveJsPath(alias?.baseUrl, index);
  if (underBaseUrl !== undefined) return [underBaseUrl];
  const workspace = projects.jsPackage(spec);
  if (workspace) {
    const { pkg, sub } = workspace;
    if (sub === '') {
      return hit(first(pkg.entries, (entry) => resolveJsEntry(pkg.dir, entry, index)) ?? first(['src/index', 'index'], (stem) => resolveJsPath(joinPath(pkg.dir, stem), index)));
    }
    const exported = matchSubpath(pkg.exports, `./${sub}`);
    return hit(
      (exported && first(exported, (target) => resolveJsEntry(pkg.dir, target, index))) ??
        resolveJsEntry(pkg.dir, sub, index) ??
        resolveJsPath(joinPath(pkg.dir, `src/${sub}`), index),
    );
  }
  if (spec.startsWith('@/') || spec.startsWith('~/')) {
    const base = projects.packageFor(fromId)?.dir ?? '.';
    return hit(resolveJsPath(joinPath(base, `src/${spec.slice(2)}`), index) ?? resolveJsPath(joinPath(base, spec.slice(2)), index));
  }
  return null;
}

/** Targets of an `exports`/`imports` key for `spec`: an exact key, else a `*` pattern with its match substituted. */
function matchSubpath(map: ReadonlyArray<readonly [string, readonly string[]]>, spec: string): string[] | undefined {
  for (const [key, targets] of map) if (key === spec) return [...targets];
  for (const [key, targets] of map) {
    const star = key.indexOf('*');
    if (star === -1) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (spec.length < prefix.length + suffix.length || !spec.startsWith(prefix) || !spec.endsWith(suffix)) continue;
    const middle = spec.slice(prefix.length, spec.length - suffix.length);
    return targets.map((target) => target.split('*').join(middle));
  }
  return undefined;
}

/* ── Python ── */

const PY_EXTS = ['.py', '.pyx', '.pyi'];

function resolvePythonModule(module: string, fromId: string, { index, projects }: ScanContext): number | undefined | null {
  const dots = module.length - module.replace(/^\.+/, '').length;
  const path = module.slice(dots).replace(/\./g, '/');
  const moduleAt = (stem: string | undefined) => index.withExtension(stem, PY_EXTS) ?? index.exact(stem === undefined ? undefined : joinPath(stem, '__init__.py'));
  if (dots > 0) {
    let dir = dirnameOf(fromId);
    for (let i = 1; i < dots; i++) dir = dirnameOf(dir);
    return moduleAt(path ? joinPath(dir, path) : dir);
  }
  if (!path.includes('/')) {
    const sibling = index.withExtension(joinPath(dirnameOf(fromId), path), PY_EXTS);
    if (sibling !== undefined) return sibling;
  }
  const roots = projects.pythonRootsFor(fromId);
  for (const root of roots) {
    const found = moduleAt(joinPath(root, path));
    if (found !== undefined) return found;
  }
  const candidates = [...index.stemSuffix(path, PY_EXTS), ...index.stemSuffix(`${path}/__init__`, ['.py'])].filter((i) => {
    if (path.includes('/')) return true;
    // Single-segment absolute imports only match top-level packages (optionally under src/),
    // otherwise every stdlib `import json` would hit some json.py deep in the tree.
    const depth = index.ids[i].split('/').length - (index.ids[i].endsWith('__init__.py') ? 1 : 0);
    return depth <= 2;
  });
  if (candidates.length) return index.closest(fromId, candidates);
  // A package that exists under a source root is local: a module missing from it is unresolved, not external.
  const top = path.split('/')[0];
  return path.includes('/') && roots.some((root) => index.hasDir(joinPath(root, top))) ? undefined : null;
}

const resolvePythonFrom: Resolver = (m, fromId, ctx) => {
  const module = m[1];
  const names = m[2]
    .replace(/[()\\\n]/g, ' ')
    .split(',')
    .map((name) => name.trim().split(/\s+/)[0])
    .filter((name) => name && name !== '*');
  const found: number[] = [];
  for (const name of names) {
    const sub = resolvePythonModule(module.endsWith('.') ? module + name : `${module}.${name}`, fromId, ctx);
    if (typeof sub === 'number') found.push(sub);
  }
  if (found.length) return found;
  const base = resolvePythonModule(module, fromId, ctx);
  return typeof base === 'number' ? [base] : base === null ? null : [];
};

const resolvePythonImport: Resolver = (m, fromId, ctx) => ({
  each: m[1].split(',').map((module) => {
    const target = resolvePythonModule(module.trim(), fromId, ctx);
    return typeof target === 'number' ? [target] : target === null ? null : [];
  }),
});

/* ── Go: a package import is a directory of the module that declares its path, so link to a few of its files ── */

function resolveGoSpec(spec: string, { index, projects }: ScanContext): Resolved {
  const module = projects.goModuleFor(spec);
  if (!module) return null;
  const dir = spec === module.path ? module.dir : joinPath(module.dir, spec.slice(module.path.length + 1));
  if (dir === undefined) return null;
  return index
    .inDir(dir)
    .filter((i) => index.ids[i].endsWith('.go') && !index.ids[i].endsWith('_test.go'))
    .slice(0, 4);
}

const resolveGoBlock: Resolver = (m, _fromId, ctx) => ({ each: [...m[1].matchAll(/"([^"\n]+)"/g)].map((spec) => resolveGoSpec(spec[1], ctx)) });

/* ── Rust ── */

function rustModuleDir(fromId: string): string {
  const base = basenameOf(fromId).replace(/\.rs$/, '');
  const dir = dirnameOf(fromId);
  return base === 'mod' || base === 'lib' || base === 'main' ? dir : (joinPath(dir, base) ?? dir);
}

/** The directory of the crate root (lib.rs or main.rs) above `fromId`, within its Cargo package. */
function rustCrateRoot(fromId: string, { index, projects }: ScanContext): string {
  const cargo = projects.cargoDirFor(fromId);
  for (let dir = dirnameOf(fromId); ; dir = dirnameOf(dir)) {
    if (index.exact(joinPath(dir, 'lib.rs')) !== undefined || index.exact(joinPath(dir, 'main.rs')) !== undefined) return dir;
    if (dir === '.' || dir === cargo) return (cargo === undefined ? undefined : joinPath(cargo, 'src')) ?? 'src';
  }
}

const resolveRustMod: Resolver = (m, fromId, { index }) => {
  const owner = rustModuleDir(fromId);
  return hit(index.exact(joinPath(owner, `${m[1]}.rs`)) ?? index.exact(joinPath(owner, `${m[1]}/mod.rs`)));
};

/** `a::{b::{C, D}, e}` → a::b::C, a::b::D, a::e. */
function expandUseTree(tree: string): string[] {
  const open = tree.indexOf('{');
  if (open === -1) return [tree.replace(/::self$/, '')];
  let depth = 0;
  let close = tree.length;
  for (let k = open; k < tree.length; k++) {
    if (tree[k] === '{') depth++;
    else if (tree[k] === '}' && --depth === 0) {
      close = k;
      break;
    }
  }
  const inner = tree.slice(open + 1, close);
  const parts: string[] = [];
  let start = 0;
  depth = 0;
  for (let k = 0; k <= inner.length; k++) {
    const char = inner[k];
    if (char === '{') depth++;
    else if (char === '}') depth--;
    else if ((char === ',' || k === inner.length) && depth === 0) {
      if (k > start) parts.push(inner.slice(start, k));
      start = k + 1;
    }
  }
  return parts.flatMap((part) => expandUseTree(tree.slice(0, open) + part));
}

function resolveRustPath(head: string, segments: string[], fromId: string, ctx: ScanContext): Resolved {
  const { index, projects } = ctx;
  let base: string;
  let root: number | undefined;
  if (head === 'crate') {
    base = rustCrateRoot(fromId, ctx);
    root = index.exact(joinPath(base, 'lib.rs')) ?? index.exact(joinPath(base, 'main.rs'));
  } else if (head === 'self') {
    base = rustModuleDir(fromId);
  } else if (head === 'super') {
    base = dirnameOf(rustModuleDir(fromId));
    while (segments[0] === 'super') {
      segments.shift();
      base = dirnameOf(base);
    }
  } else {
    const crate = projects.crate(head);
    if (!crate) return null;
    root = index.exact(crate.root);
    base = crate.root === undefined ? (joinPath(crate.dir, 'src') ?? crate.dir) : dirnameOf(crate.root);
  }
  for (let k = segments.length; k >= 1; k--) {
    const stem = joinPath(base, segments.slice(0, k).join('/'));
    if (stem === undefined) break;
    const found = index.exact(`${stem}.rs`) ?? index.exact(`${stem}/mod.rs`);
    if (found !== undefined) return [found];
  }
  // `use crate::Item` or `use other_crate::Item`: an item (CamelCase by convention) defined in, or re-exported from, the crate root.
  if (root !== undefined && (segments.length === 0 || /^[A-Z]/.test(segments[0]))) return [root];
  return [];
}

const resolveRustUse: Resolver = (m, fromId, ctx) => {
  const tree = m[1].replace(/\/\/[^\n]*/g, '').replace(/\s+as\s+\w+/g, '').replace(/\s+/g, '');
  return {
    each: expandUseTree(tree).map((path) => {
      const segments = path.split('::').filter((segment) => segment !== '' && segment !== '*');
      const head = segments.shift();
      return head === undefined ? null : resolveRustPath(head, segments, fromId, ctx);
    }),
  };
};

const resolveRustExternCrate: Resolver = (m, _fromId, { index, projects }) => {
  const crate = projects.crate(m[1]);
  return crate ? hit(index.exact(crate.root)) : null;
};

/* ── Java / Kotlin / Scala / Groovy, Clojure ── */

const JVM_EXTS = ['.java', '.kt', '.kts', '.scala', '.groovy'];

const resolveJvm: Resolver = (m, fromId, { index }) => {
  if (m[2]) return null; // wildcard import: no single file
  const parts = m[1].split('.');
  for (let k = parts.length; k >= Math.max(2, parts.length - 2); k--) {
    const candidates = index.stemSuffix(parts.slice(0, k).join('/'), JVM_EXTS);
    if (candidates.length) return [index.closest(fromId, candidates)!];
  }
  return null;
};

const resolveClojure: Resolver = (m, fromId, { index }) => ({
  each: [...m[1].matchAll(/(?:^|[\s[(])'?([a-z][\w-]*(?:\.[\w-]+)+)/g)].map((ns) => {
    const segments = ns[1].split('.').map((segment) => segment.replace(/-/g, '_'));
    return hitOrExternal(modulePath(segments, ['.clj', '.cljs', '.cljc'], fromId, index, segments.length));
  }),
});

/* ── C / C++ / Objective-C ── */

const resolveCInclude: Resolver = (m, fromId, { index }) => {
  const sibling = index.exact(joinPath(dirnameOf(fromId), m[1]));
  if (sibling !== undefined) return [sibling];
  const candidates = index.pathSuffix(m[1]);
  return candidates.length ? [index.closest(fromId, candidates)!] : [];
};

/** `#include <project/header.h>`: a project header when some indexed path ends with it; system headers are external. */
const resolveCSystemInclude: Resolver = (m, fromId, { index }) => {
  if (!m[1].includes('/')) return null;
  const candidates = index.pathSuffix(m[1]);
  return hitOrExternal(candidates.length ? index.closest(fromId, candidates) : undefined);
};

/* ── C#: a namespace is the folder under the .csproj it names (by root namespace), so link to a few of its files ── */

const resolveCsharpUsing: Resolver = (m, fromId, { index, projects }) => {
  const namespace = m[1];
  const csFiles = (dir: string | undefined) => (dir === undefined ? [] : index.inDir(dir).filter((i) => index.ids[i].endsWith('.cs')).slice(0, 4));
  const project = projects.dotnetProjectFor(namespace);
  if (project) {
    const rest = namespace.slice(project.namespace.length + 1).split('.').filter(Boolean).join('/');
    const dir = rest ? joinPath(project.dir, rest) : project.dir;
    const files = csFiles(dir);
    if (files.length) return files;
    // `using static Namespace.Type;` names the type's own file.
    const type = dir === undefined ? undefined : index.exact(`${dir}.cs`);
    if (type !== undefined) return [type];
  }
  // No project claims the namespace: a folder path ending in its last two or more segments.
  const segments = namespace.split('.');
  for (let k = 0; k <= segments.length - 2; k++) {
    const dirs = index.dirSuffix(segments.slice(k).join('/')).filter((dir) => csFiles(dir).length > 0);
    const files = csFiles(index.closestDir(fromId, dirs));
    if (files.length) return files;
  }
  return null;
};

/* ── Swift: a module is a SwiftPM target directory ── */

const resolveSwiftImport: Resolver = (m, fromId, { index, projects }) => {
  const swiftFiles = (dir: string) =>
    index
      .under(dir)
      .filter((i) => index.ids[i].endsWith('.swift'))
      .slice(0, 4);
  const declared = projects.swiftTarget(m[1]);
  if (declared !== undefined) return swiftFiles(declared);
  const dir = index.closestDir(fromId, index.dirSuffix(`Sources/${m[1]}`));
  return dir === undefined ? null : swiftFiles(dir);
};

/* ── Ruby ── */

const resolveRubyRelative: Resolver = (m, fromId, { index }) => {
  const target = joinPath(dirnameOf(fromId), m[1]);
  return hit(target === undefined ? undefined : index.exact(target.endsWith('.rb') ? target : `${target}.rb`));
};

const resolveRubyRequire: Resolver = (m, fromId, { index }) => {
  const candidates = index.stemSuffix(m[1].replace(/\.rb$/, ''), ['.rb']);
  return hitOrExternal(candidates.length ? index.closest(fromId, candidates) : undefined);
};

/* ── PHP ── */

const resolvePhpInclude: Resolver = (m, fromId, { index }) => {
  const spec = m[1].replace(/^\//, '');
  const sibling = index.exact(joinPath(dirnameOf(fromId), spec));
  if (sibling !== undefined) return [sibling];
  const candidates = index.pathSuffix(spec);
  return candidates.length ? [index.closest(fromId, candidates)!] : [];
};

/** `use A\B, C\D as E;` and `use A\{B, C};` → the fully qualified names. */
function phpUseNames(body: string): string[] {
  const clean = (name: string) => name.trim().replace(/^(?:function|const)\s+/, '').replace(/\s+as\s+\w+$/i, '').replace(/^\\/, '');
  const text = body.replace(/\s+/g, ' ').trim();
  const brace = text.indexOf('{');
  if (brace === -1) return text.split(',').map(clean).filter(Boolean);
  const prefix = clean(text.slice(0, brace)).replace(/\\$/, '');
  return text
    .slice(brace + 1, text.lastIndexOf('}'))
    .split(',')
    .map(clean)
    .filter(Boolean)
    .map((name) => `${prefix}\\${name}`);
}

function resolvePhpClass(className: string, fromId: string, { index, projects }: ScanContext): Resolved {
  const psr4 = projects.psr4For(className);
  if (psr4) {
    const relative = `${className.slice(psr4.prefix.length).split('\\').join('/')}.php`;
    return hit(first(psr4.dirs, (dir) => index.exact(joinPath(dir, relative))));
  }
  const parts = className.split('\\').filter(Boolean);
  // Without composer.json: drop leading vendor namespace segments until a PSR-4 style path matches; keep at least two segments.
  for (let k = 0; k <= Math.max(0, parts.length - 2); k++) {
    const candidates = index.stemSuffix(parts.slice(k).join('/'), ['.php']);
    if (candidates.length) return [index.closest(fromId, candidates)!];
  }
  return null;
}

const resolvePhpUse: Resolver = (m, fromId, ctx) => ({ each: phpUseNames(m[1]).map((name) => resolvePhpClass(name, fromId, ctx)) });

/** Blade `@extends('layouts.app')`: resources/views/layouts/app.blade.php. */
const resolveBlade: Resolver = (m, fromId, { index }) => {
  if (m[1].includes('::')) return null;
  const candidates = index.pathSuffix(`${m[1].replace(/\./g, '/')}.blade.php`);
  return hitOrExternal(candidates.length ? index.closest(fromId, candidates) : undefined);
};

/* ── CSS / SCSS / Sass / Less ── */

const STYLE_EXTS = ['.scss', '.sass', '.css', '.less'];

const resolveStyle: Resolver = (m, fromId, { index }) => {
  const spec = m[1];
  if (/^(?:[a-z]+:|\/\/|~)/i.test(spec)) return null;
  const target = joinPath(dirnameOf(fromId), spec);
  if (target === undefined) return [];
  const partial = joinPath(dirnameOf(target), `_${basenameOf(target)}`);
  return hit(
    index.exact(target) ??
      index.withExtension(target, STYLE_EXTS) ??
      index.withExtension(partial, STYLE_EXTS) ??
      index.withExtension(joinPath(target, '_index'), STYLE_EXTS),
  );
};

/* ── Dart ── */

const resolveDart: Resolver = (m, fromId, { index, projects }) => {
  const spec = m[1];
  if (spec.startsWith('dart:')) return null;
  if (spec.startsWith('package:')) {
    const [name, ...rest] = spec.slice('package:'.length).split('/');
    const inLib = `lib/${rest.join('/')}`;
    const dir = projects.dartPackage(name);
    if (dir !== undefined) return hit(index.exact(joinPath(dir, inLib)));
    const candidates = index.pathSuffix(inLib);
    return hitOrExternal(candidates.length ? index.closest(fromId, candidates) : undefined);
  }
  return hit(index.exact(joinPath(dirnameOf(fromId), spec)));
};

/* ── Elixir ── */

/** Macro.underscore: MyAppWeb → my_app_web, HTTPClient → http_client. */
const underscore = (name: string) =>
  name
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .toLowerCase();

const resolveElixir: Resolver = (m, fromId, { index }) => {
  const modules = m[2] === undefined ? [m[1]] : m[2].split(',').map((name) => `${m[1]}.${name.trim()}`);
  return {
    each: modules.map((module) => {
      const segments = module.split('.').filter(Boolean).map(underscore);
      // A nested module (MyApp.Accounts.User.Query) lives in its parent's file.
      const target = modulePath(segments, ['.ex', '.exs'], fromId, index, 2);
      if (target !== undefined) return [target];
      // Under an application's own lib/<app> directory it is local, only missing; anything else is a dependency.
      return segments.length > 1 && index.dirSuffix(`lib/${segments[0]}`).length > 0 ? [] : null;
    }),
  };
};

/* ── Other languages ── */

const resolveLua: Resolver = (m, fromId, { index }) => {
  const path = m[1].replace(/\.lua$/, '').replace(/\./g, '/');
  const candidates = [...index.stemSuffix(path, ['.lua']), ...index.stemSuffix(`${path}/init`, ['.lua'])];
  return hitOrExternal(candidates.length ? index.closest(fromId, candidates) : undefined);
};

const resolveNim: Resolver = (m, fromId, { index }) => ({
  each: m[1].split(',').map((spec) => hitOrExternal(index.exact(joinPath(dirnameOf(fromId), `${spec.trim()}.nim`)))),
});

const resolveCrystal: Resolver = (m, fromId, { index }) => {
  if (m[1].includes('*')) return null;
  const target = joinPath(dirnameOf(fromId), m[1]);
  return target === undefined ? [] : hit(index.exact(`${target}.cr`) ?? index.exact(target));
};

const resolveSolidity: Resolver = (m, fromId, { index }) => {
  const spec = m[1];
  if (spec.startsWith('.')) return hit(index.exact(joinPath(dirnameOf(fromId), spec)));
  return hitOrExternal(relativeOrSuffix(spec, fromId, index));
};

/** `source "$(dirname "$0")/lib.sh"`, `. ./env.sh`: variables and command substitutions before the path stand for the script's directory. */
const resolveShell: Resolver = (m, fromId, { index }) => {
  const path = m[1]
    .replace(/\$\([^)]*\)|\$\{[^}]*\}|\$\w+/g, '')
    .replace(/["']/g, '')
    .trim()
    .split(/[\s;|&]/)[0]
    .replace(/^\/+/, '');
  if (!path || path.startsWith('~')) return null;
  return hitOrExternal(relativeOrSuffix(path, fromId, index));
};

const resolvePowershell: Resolver = (m, fromId, { index }) =>
  hitOrExternal(relativeOrSuffix(m[1].replace(/^\$PSScriptRoot[\\/]/i, '').replace(/\\/g, '/'), fromId, index));

const resolveHtml: Resolver = (m, fromId, { index }) => {
  const spec = m[1].split(/[?#]/)[0];
  if (!spec || /^(?:[a-z][\w+.-]*:|\/\/)/i.test(spec)) return null;
  if (!spec.startsWith('/')) return hitOrExternal(index.exact(joinPath(dirnameOf(fromId), spec)));
  const candidates = index.pathSuffix(spec.slice(1));
  return hitOrExternal(candidates.length ? index.closest(fromId, candidates) : undefined);
};

/** Jinja, Twig, Nunjucks, Liquid, EJS and Pug includes; a name without an extension shares the including file's. */
const resolveTemplate: Resolver = (m, fromId, { index }) => {
  const spec = m[1];
  if (/^(?:[a-z][\w+.-]*:|\/\/)/i.test(spec)) return null;
  const names = extensionOf(spec) ? [spec] : [spec, `${spec}${extensionOf(fromId)}`];
  return hitOrExternal(first(names, (name) => relativeOrSuffix(name.replace(/^\//, ''), fromId, index)));
};

/** A local Terraform module is a directory: link to its main.tf first, then its other .tf files. */
const resolveTerraformModule: Resolver = (m, fromId, { index }) => {
  const dir = joinPath(dirnameOf(fromId), m[1].replace(/\/+$/, ''));
  if (dir === undefined) return [];
  const files = index.inDir(dir).filter((i) => index.ids[i].endsWith('.tf'));
  const main = files.find((i) => basenameOf(index.ids[i]) === 'main.tf');
  return (main === undefined ? files : [main, ...files.filter((i) => i !== main)]).slice(0, 4);
};

const resolveNix: Resolver = (m, fromId, { index }) => {
  const target = joinPath(dirnameOf(fromId), m[1].replace(/\/+$/, ''));
  return target === undefined ? [] : hit(index.exact(target) ?? index.exact(joinPath(target, 'default.nix')));
};

const RULES: Record<Exclude<LanguageId, 'config' | 'notebook'>, Rule[]> = {
  js: [
    { re: /\bimport\s+(?:type\s+)?(?:[\w$*{}\s,]+?\s+from\s+)?['"]([^'"\n]+)['"]/g, resolve: resolveJs },
    { re: /\bexport\s+(?:type\s+)?[\w$*{}\s,]+?\s+from\s+['"]([^'"\n]+)['"]/g, resolve: resolveJs },
    { re: /\b(?:require|import)\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g, resolve: resolveJs },
  ],
  python: [
    { re: /^[ \t]*from[ \t]+(\.+[\w.]*|[A-Za-z_][\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n#]+)/gm, resolve: resolvePythonFrom },
    { re: /^[ \t]*import[ \t]+([A-Za-z_][\w.]*(?:[ \t]*,[ \t]*[A-Za-z_][\w.]*)*)/gm, resolve: resolvePythonImport },
  ],
  go: [
    { re: /^[ \t]*import[ \t]+(?:[\w.]+[ \t]+)?"([^"\n]+)"/gm, resolve: (m, _f, ctx) => resolveGoSpec(m[1], ctx) },
    { re: /^[ \t]*import[ \t]*\(([^)]*)\)/gm, resolve: resolveGoBlock },
  ],
  rust: [
    { re: /^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?mod[ \t]+([A-Za-z_]\w*)[ \t]*;/gm, resolve: resolveRustMod },
    { re: /^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?use[ \t]+(?:::)?([^;]+);/gm, resolve: resolveRustUse },
    { re: /^[ \t]*extern[ \t]+crate[ \t]+([A-Za-z_]\w*)/gm, resolve: resolveRustExternCrate },
  ],
  jvm: [{ re: /^[ \t]*import[ \t]+(?:static[ \t]+)?([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+)(\.\*)?/gm, resolve: resolveJvm }],
  clojure: [{ re: /\(:?require\b([^()]*)/g, resolve: resolveClojure }],
  c: [
    { re: /^[ \t]*#[ \t]*(?:include|import)[ \t]*"([^"\n]+)"/gm, resolve: resolveCInclude },
    { re: /^[ \t]*#[ \t]*(?:include|import)[ \t]*<([^>\n]+)>/gm, resolve: resolveCSystemInclude },
  ],
  csharp: [
    { re: /^[ \t]*(?:global[ \t]+)?using[ \t]+(?:static[ \t]+)?(?:[A-Za-z_]\w*[ \t]*=[ \t]*)?([A-Za-z_][\w.]*)[ \t]*;/gm, resolve: resolveCsharpUsing },
    { re: /^[ \t]*@using[ \t]+([A-Za-z_][\w.]*)/gm, resolve: resolveCsharpUsing },
  ],
  swift: [
    {
      re: /^[ \t]*(?:@\w+(?:\([^)\n]*\))?[ \t]+)*import[ \t]+(?:(?:struct|class|enum|protocol|func|var|let|typealias)[ \t]+)?([A-Za-z_]\w*)/gm,
      resolve: resolveSwiftImport,
    },
  ],
  ruby: [
    { re: /\brequire_relative[ \t(]+['"]([^'"\n]+)['"]/g, resolve: resolveRubyRelative },
    { re: /^[ \t]*require[ \t(]+['"]([^'"\n]+)['"]/gm, resolve: resolveRubyRequire },
  ],
  php: [
    { re: /\b(?:require|include)(?:_once)?[ \t(]*(?:__DIR__[ \t]*\.[ \t]*)?['"]([^'"\n]+)['"]/g, resolve: resolvePhpInclude },
    { re: /^[ \t]*use[ \t]+([^;(]+);/gm, resolve: resolvePhpUse },
    { re: /@(?:extends|include|includeIf|includeWhen|includeFirst|component|each)\([ \t]*['"]([\w.\-/:]+)['"]/g, resolve: resolveBlade },
  ],
  css: [{ re: /@(?:import|use|forward)[ \t]+(?:url\([ \t]*)?['"]([^'"\n]+)['"]/g, resolve: resolveStyle }],
  dart: [{ re: /^[ \t]*(?:import|export|part)[ \t]+['"]([^'"\n]+)['"]/gm, resolve: resolveDart }],
  elixir: [{ re: /^[ \t]*(?:alias|import|require|use)[ \t]+([A-Z]\w*(?:\.[A-Z]\w*)*)(?:\.\{([^}]*)\})?/gm, resolve: resolveElixir }],
  erlang: [{ re: /^-include(?:_lib)?\([ \t]*"([^"\n]+)"[ \t]*\)/gm, resolve: nearby }],
  haskell: [{ re: /^import[ \t]+(?:safe[ \t]+)?(?:qualified[ \t]+)?(?:"[^"\n]*"[ \t]+)?([A-Z][\w.]*)/gm, resolve: moduleFile('.', ['.hs', '.lhs']) }],
  elm: [{ re: /^import[ \t]+([A-Z][\w.]*)/gm, resolve: moduleFile('.', ['.elm']) }],
  lua: [{ re: /\brequire[ \t]*\(?[ \t]*["']([\w.\-/]+)["']/g, resolve: resolveLua }],
  perl: [
    { re: /^[ \t]*(?:use|require)[ \t]+([A-Z]\w*(?:::\w+)*)/gm, resolve: moduleFile('::', ['.pm']) },
    { re: /\b(?:require|do)[ \t]+["']([^"'\n]+\.p[lm])["']/g, resolve: nearby },
  ],
  r: [{ re: /\bsource[ \t]*\([ \t]*["']([^"'\n]+)["']/g, resolve: nearby }],
  julia: [{ re: /\binclude[ \t]*\([ \t]*"([^"\n]+)"/g, resolve: relativeFile }],
  zig: [{ re: /@import[ \t]*\([ \t]*"([^"\n]+\.zig)"/g, resolve: relativeFile }],
  nim: [{ re: /^[ \t]*(?:import|include)[ \t]+([\w/.]+(?:[ \t]*,[ \t]*[\w/.]+)*)/gm, resolve: resolveNim }],
  crystal: [{ re: /\brequire[ \t]+"(\.{1,2}\/[^"\n]+)"/g, resolve: resolveCrystal }],
  solidity: [{ re: /^[ \t]*import[ \t]+(?:[^'";]*?from[ \t]+)?["']([^"'\n]+)["']/gm, resolve: resolveSolidity }],
  shell: [{ re: /^[ \t]*(?:source|\.)[ \t]+([^\n#]+)/gm, resolve: resolveShell }],
  powershell: [{ re: /^[ \t]*(?:\.|Import-Module)[ \t]+["']?([^\s"']+\.ps[dm]?1)/gim, resolve: resolvePowershell }],
  html: [{ re: /<(?:script|link)\b[^>]*?\b(?:src|href)[ \t]*=[ \t]*["']([^"']+)["']/gi, resolve: resolveHtml }],
  template: [
    { re: /\{%-?[ \t]*(?:extends|include|import|from|embed|render)[ \t]+["']([^"'\n]+)["']/g, resolve: resolveTemplate },
    { re: /\binclude\([ \t]*["']([^"'\n]+)["']/g, resolve: resolveTemplate },
    { re: /^[ \t]*(?:include|extends)[ \t]+([^\s'"]+)[ \t]*$/gm, resolve: resolveTemplate },
  ],
  proto: [{ re: /^[ \t]*import[ \t]+(?:public[ \t]+|weak[ \t]+)?"([^"\n]+)"/gm, resolve: nearby }],
  graphql: [{ re: /^#[ \t]*import[ \t]+["']([^"'\n]+)["']/gm, resolve: relativeFile }],
  terraform: [{ re: /\bsource[ \t]*=[ \t]*"(\.{1,2}\/[^"\n]*)"/g, resolve: resolveTerraformModule }],
  nix: [{ re: /\b(?:import|callPackage)[ \t]+(\.{1,2}\/[\w.\-/]*)/g, resolve: resolveNix }],
};
