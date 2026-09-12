// Project configuration that import resolution depends on, read from the manifests in the file listing:
//   package.json        workspace package names, entry points, `exports` and `imports` maps
//   tsconfig, jsconfig  which one governs each file (dependency-cruiser runs once per tsconfig)
//   go.mod              module paths, for any number of modules
//   Cargo.toml          crate names and roots, for `use other_crate::…` inside a workspace
//   pyproject.toml, setup.py, setup.cfg   Python source roots: the project directory, src/, where = […], from = "…"
//   composer.json       PSR-4 namespace prefixes
//   pubspec.yaml        Dart package names
//   *.csproj            root namespaces
//   Package.swift       SwiftPM target directories
// Manifests are few and small, so every run reads all of them. `key` fingerprints what resolution takes from them:
// when an update's key differs from the previous graph's, every file is read again (planUpdate in main.ts).

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { depthOf, isWithin } from '@orbit-code/graph/dirTree';
import { basenameOf, dirnameOf } from '@orbit-code/graph/languages';
import { type PathIndex, joinPath } from './pathIndex';

const MAX_MANIFEST_BYTES = 1_000_000;
const READ_CONCURRENCY = 32;
/** Condition keys of `exports` and `imports`, most source-like first; other keys keep their order after these. */
const CONDITIONS = ['source', 'types', 'import', 'module', 'default', 'require', 'node', 'browser'];

type ManifestKind = 'npm' | 'tsconfig' | 'go' | 'cargo' | 'python' | 'composer' | 'pubspec' | 'dotnet' | 'swift';

export interface JsPackage {
  name: string | undefined;
  dir: string;
  /** Entry points, most source-like first: source, exports["."], types, module, main, browser. */
  entries: string[];
  /** `exports` subpaths ("./feature", "./*") and their targets. */
  exports: Array<[string, string[]]>;
  /** `imports` ("#internal", "#utils/*") and their targets. */
  imports: Array<[string, string[]]>;
}

export interface Crate {
  dir: string;
  /** The crate root ([lib] path, src/lib.rs or src/main.rs), when the graph has that file. */
  root: string | undefined;
}

interface Manifest {
  id: string;
  kind: ManifestKind;
  /** Undefined when the file could not be read or is too large. */
  text: string | undefined;
}

function manifestKind(id: string): ManifestKind | undefined {
  const name = basenameOf(id);
  switch (name) {
    case 'package.json':
      return 'npm';
    case 'go.mod':
      return 'go';
    case 'Cargo.toml':
      return 'cargo';
    case 'pyproject.toml':
    case 'setup.py':
    case 'setup.cfg':
      return 'python';
    case 'composer.json':
      return 'composer';
    case 'pubspec.yaml':
      return 'pubspec';
    case 'Package.swift':
      return 'swift';
  }
  if (/^[tj]sconfig(?:\..+)?\.json$/.test(name)) return 'tsconfig';
  if (name.endsWith('.csproj')) return 'dotnet';
  return undefined;
}

export async function loadProjects(files: readonly { id: string; path: string }[], sizes: readonly number[], index: PathIndex): Promise<Projects> {
  const manifests: Manifest[] = [];
  const paths: string[] = [];
  files.forEach((file, i) => {
    const kind = manifestKind(file.id);
    if (!kind) return;
    manifests.push({ id: file.id, kind, text: undefined });
    paths.push(sizes[i] <= MAX_MANIFEST_BYTES ? file.path : '');
  });
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(READ_CONCURRENCY, manifests.length) }, async () => {
      while (cursor < manifests.length) {
        const k = cursor++;
        if (!paths[k]) continue;
        try {
          manifests[k].text = await readFile(paths[k], 'utf8');
        } catch {
          // deleted or unreadable: resolution goes on without it
        }
      }
    }),
  );
  return new Projects(manifests, index);
}

export class Projects {
  /** Fingerprint of everything import resolution takes from the manifests. */
  readonly key: string;
  /** Manifests found, by kind. */
  readonly summary: Record<string, number> = {};
  private readonly packagesByDir = new Map<string, JsPackage>();
  private readonly packagesByName = new Map<string, JsPackage>();
  private readonly tsconfigs = new Map<string, string>();
  private readonly goModules: Array<{ path: string; dir: string }> = [];
  private readonly cratesByName = new Map<string, Crate>();
  private readonly cratesByDir = new Map<string, Crate>();
  private readonly cargoDirs = new Set<string>();
  private readonly pythonRoots: string[];
  private readonly psr4: Array<{ prefix: string; dirs: string[] }> = [];
  private readonly dartPackages = new Map<string, string>();
  private readonly dotnetProjects: Array<{ namespace: string; dir: string }> = [];
  private readonly swiftTargets = new Map<string, string>();

  constructor(manifests: readonly Manifest[], index: PathIndex) {
    const roots = new Set<string>(['.']);
    const fingerprint: string[] = [];
    for (const { id, kind, text } of manifests) {
      this.summary[kind] = (this.summary[kind] ?? 0) + 1;
      if (text === undefined) {
        fingerprint.push(`${kind}\0${id}\0unreadable`);
        continue;
      }
      const dir = dirnameOf(id);
      let used: unknown;
      switch (kind) {
        case 'npm':
          used = this.addPackage(dir, text);
          break;
        case 'tsconfig':
          used = this.addTsconfig(id, dir, text);
          break;
        case 'go':
          used = this.addGoModule(dir, text);
          break;
        case 'cargo':
          used = this.addCrate(dir, text, index);
          break;
        case 'python':
          used = addPythonRoots(dir, text, roots);
          break;
        case 'composer':
          used = this.addComposer(dir, text);
          break;
        case 'pubspec':
          used = this.addPubspec(dir, text);
          break;
        case 'dotnet':
          used = this.addDotnetProject(id, dir, text);
          break;
        case 'swift':
          used = this.addSwiftPackage(dir, text);
          break;
      }
      fingerprint.push(`${kind}\0${id}\0${JSON.stringify(used ?? null)}`);
    }
    // Longest first, so the most specific module, prefix or namespace wins.
    this.goModules.sort((a, b) => b.path.length - a.path.length);
    this.psr4.sort((a, b) => b.prefix.length - a.prefix.length);
    this.dotnetProjects.sort((a, b) => b.namespace.length - a.namespace.length);
    this.pythonRoots = [...roots].sort();
    this.key = createHash('sha1').update(fingerprint.join('\n')).digest('hex');
  }

  /** The tsconfig.json (or jsconfig.json) nearest `id`. */
  tsconfigFor(id: string): string | undefined {
    return nearest(this.tsconfigs, id);
  }

  /** The package.json nearest `id`. */
  packageFor(id: string): JsPackage | undefined {
    return nearest(this.packagesByDir, id);
  }

  packageAt(dir: string): JsPackage | undefined {
    return this.packagesByDir.get(dir);
  }

  /** A workspace package named by a bare specifier ("@scope/name/sub" or "name/sub"), and the rest of the specifier. */
  jsPackage(spec: string): { pkg: JsPackage; sub: string } | undefined {
    const segments = spec.split('/');
    const length = spec.startsWith('@') ? 2 : 1;
    const pkg = this.packagesByName.get(segments.slice(0, length).join('/'));
    return pkg && { pkg, sub: segments.slice(length).join('/') };
  }

  /** The Go module an import path belongs to. */
  goModuleFor(spec: string): { path: string; dir: string } | undefined {
    return this.goModules.find((module) => spec === module.path || spec.startsWith(`${module.path}/`));
  }

  /** A crate of this workspace, by the name `use` refers to it with (dashes as underscores). */
  crate(name: string): Crate | undefined {
    return this.cratesByName.get(name);
  }

  crateAt(dir: string): Crate | undefined {
    return this.cratesByDir.get(dir);
  }

  /** The directory of the Cargo.toml nearest `id`. */
  cargoDirFor(id: string): string | undefined {
    for (let dir = dirnameOf(id); ; dir = dirnameOf(dir)) {
      if (this.cargoDirs.has(dir)) return dir;
      if (dir === '.') return undefined;
    }
  }

  /** Where absolute Python imports start: the roots around `fromId`, deepest first, then the others. */
  pythonRootsFor(fromId: string): string[] {
    const around = this.pythonRoots.filter((root) => isWithin(fromId, root)).sort((a, b) => depthOf(b) - depthOf(a));
    return around.length === this.pythonRoots.length ? around : [...around, ...this.pythonRoots.filter((root) => !isWithin(fromId, root))];
  }

  /** The PSR-4 prefix a fully qualified PHP class name falls under. */
  psr4For(className: string): { prefix: string; dirs: string[] } | undefined {
    return this.psr4.find((entry) => className.startsWith(entry.prefix));
  }

  dartPackage(name: string): string | undefined {
    return this.dartPackages.get(name);
  }

  /** The .csproj whose root namespace `namespace` is, or lies under. */
  dotnetProjectFor(namespace: string): { namespace: string; dir: string } | undefined {
    return this.dotnetProjects.find((project) => namespace === project.namespace || namespace.startsWith(`${project.namespace}.`));
  }

  swiftTarget(name: string): string | undefined {
    return this.swiftTargets.get(name);
  }

  private addPackage(dir: string, text: string): unknown {
    const json = parseJsonObject(text);
    if (!json) return 'invalid';
    const name = typeof json.name === 'string' ? json.name : undefined;
    const rootExports: string[] = [];
    const exports: Array<[string, string[]]> = [];
    const declared = json.exports;
    if (isObject(declared) && Object.keys(declared).some((key) => key.startsWith('.'))) {
      for (const [key, value] of Object.entries(declared)) {
        if (key === '.') rootExports.push(...leaves(value));
        else if (key.startsWith('./')) exports.push([key, leaves(value)]);
      }
    } else {
      rootExports.push(...leaves(declared));
    }
    const imports: Array<[string, string[]]> = isObject(json.imports)
      ? Object.entries(json.imports).flatMap(([key, value]): Array<[string, string[]]> => (key.startsWith('#') ? [[key, leaves(value)]] : []))
      : [];
    const entries = [...new Set([json.source, ...rootExports, json.types, json.typings, json.module, json.main, json.browser].filter((entry): entry is string => typeof entry === 'string'))];
    const pkg: JsPackage = { name, dir, entries, exports, imports };
    this.packagesByDir.set(dir, pkg);
    if (name !== undefined && !this.packagesByName.has(name)) this.packagesByName.set(name, pkg);
    return [name, entries, exports, imports];
  }

  private addTsconfig(id: string, dir: string, text: string): string {
    const name = basenameOf(id);
    // Only these two govern a directory; tsconfig.*.json files still count through the fingerprint, since `extends` reaches them.
    if (name === 'tsconfig.json' || (name === 'jsconfig.json' && !this.tsconfigs.has(dir))) this.tsconfigs.set(dir, id);
    return createHash('sha1').update(text).digest('hex');
  }

  private addGoModule(dir: string, text: string): string | null {
    const path = /^module\s+"?([^\s"]+)"?/m.exec(text)?.[1];
    if (path === undefined) return null;
    this.goModules.push({ path, dir });
    return path;
  }

  private addCrate(dir: string, text: string, index: PathIndex): unknown {
    this.cargoDirs.add(dir);
    const { name, libName, libPath } = readCargo(text);
    const crateName = libName ?? name;
    if (crateName === undefined) return null; // a virtual workspace manifest
    const candidates = libPath !== undefined ? [libPath] : ['src/lib.rs', 'src/main.rs'];
    const root = candidates.map((path) => joinPath(dir, path)).find((path) => index.exact(path) !== undefined);
    const crate = { dir, root };
    const key = crateName.replace(/-/g, '_');
    if (!this.cratesByName.has(key)) this.cratesByName.set(key, crate);
    this.cratesByDir.set(dir, crate);
    return [key, libPath ?? null];
  }

  private addComposer(dir: string, text: string): unknown {
    const json = parseJsonObject(text);
    if (!json) return 'invalid';
    const used: Array<[string, string[]]> = [];
    for (const section of [json.autoload, json['autoload-dev']]) {
      const map = isObject(section) ? section['psr-4'] : undefined;
      if (!isObject(map)) continue;
      for (const [prefix, value] of Object.entries(map)) {
        const dirs = (Array.isArray(value) ? value : [value])
          .filter((entry): entry is string => typeof entry === 'string')
          .flatMap((entry) => joinPath(dir, entry.replace(/\/+$/, '')) ?? []);
        const namespace = prefix.replace(/^\\+/, '');
        this.psr4.push({ prefix: namespace, dirs });
        used.push([namespace, dirs]);
      }
    }
    return used;
  }

  private addPubspec(dir: string, text: string): string | null {
    const name = /^name:\s*["']?([A-Za-z_]\w*)/m.exec(text)?.[1];
    if (name === undefined) return null;
    if (!this.dartPackages.has(name)) this.dartPackages.set(name, dir);
    return name;
  }

  private addDotnetProject(id: string, dir: string, text: string): string {
    const declared = /<RootNamespace>\s*([^<\s]+)\s*<\/RootNamespace>/.exec(text)?.[1] ?? /<AssemblyName>\s*([^<\s]+)\s*<\/AssemblyName>/.exec(text)?.[1];
    // Without a literal RootNamespace, .NET uses the project name with anything not valid in a namespace replaced.
    const namespace = declared !== undefined && !declared.includes('$') ? declared : basenameOf(id).replace(/\.csproj$/, '').replace(/[^\w.]/g, '_');
    this.dotnetProjects.push({ namespace, dir });
    return namespace;
  }

  private addSwiftPackage(dir: string, text: string): Array<[string, string]> {
    const used: Array<[string, string]> = [];
    let consumed = 0;
    for (const m of text.matchAll(/\.(target|executableTarget|testTarget|macro|plugin|systemLibrary)\s*\(/g)) {
      // `.target(name:)` also appears inside another target's dependencies; only declarations count.
      if (m.index < consumed) continue;
      const open = m.index + m[0].length - 1;
      const body = parenthesized(text, open);
      consumed = open + body.length + 2;
      const name = /\bname\s*:\s*"([^"]+)"/.exec(body)?.[1];
      if (name === undefined) continue;
      const path = /\bpath\s*:\s*"([^"]+)"/.exec(body)?.[1] ?? `${m[1] === 'testTarget' ? 'Tests' : m[1] === 'plugin' ? 'Plugins' : 'Sources'}/${name}`;
      const target = joinPath(dir, path);
      if (target === undefined) continue;
      if (!this.swiftTargets.has(name)) this.swiftTargets.set(name, target);
      used.push([name, target]);
    }
    return used;
  }
}

/** Source roots a Python project declares: its directory, src/, and setuptools, Poetry and setup.cfg package directories. */
function addPythonRoots(dir: string, text: string, roots: Set<string>): string[] {
  const named = new Set<string>(['src']);
  for (const m of text.matchAll(/\bwhere\s*=\s*\[([^\]]*)\]/g)) for (const s of m[1].matchAll(/["']([^"']+)["']/g)) named.add(s[1]);
  for (const m of text.matchAll(/\bfrom\s*=\s*["']([^"']+)["']/g)) named.add(m[1]);
  for (const m of text.matchAll(/["']{2}\s*[:=]\s*["']([^"']+)["']/g)) named.add(m[1]);
  for (const m of text.matchAll(/\bpackage_dir\s*=\s*\n?\s*=\s*(\S+)/g)) named.add(m[1]);
  roots.add(dir);
  const values = [...named].sort();
  for (const value of values) {
    const root = joinPath(dir, value.replace(/\/+$/, ''));
    if (root !== undefined) roots.add(root || '.');
  }
  return values;
}

function readCargo(text: string): { name?: string; libName?: string; libPath?: string } {
  const cargo: { name?: string; libName?: string; libPath?: string } = {};
  let section = '';
  for (const line of text.split('\n')) {
    const header = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(line);
    if (header) {
      section = header[1];
      continue;
    }
    const pair = /^\s*([\w-]+)\s*=\s*["']([^"']*)["']/.exec(line);
    if (!pair) continue;
    if (section === 'package' && pair[1] === 'name') cargo.name = pair[2];
    else if (section === 'lib' && pair[1] === 'name') cargo.libName = pair[2];
    else if (section === 'lib' && pair[1] === 'path') cargo.libPath = pair[2];
  }
  return cargo;
}

/** String leaves of an `exports` or `imports` value, most source-like conditions first. */
function leaves(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(leaves);
  if (!isObject(value)) return [];
  const rank = (key: string) => (CONDITIONS.includes(key) ? CONDITIONS.indexOf(key) : CONDITIONS.length);
  return Object.keys(value)
    .sort((a, b) => rank(a) - rank(b))
    .flatMap((key) => leaves(value[key]));
}

function nearest<T>(byDir: ReadonlyMap<string, T>, id: string): T | undefined {
  for (let dir = dirnameOf(id); ; dir = dirnameOf(dir)) {
    const found = byDir.get(dir);
    if (found !== undefined) return found;
    if (dir === '.') return undefined;
  }
}

/** The text inside the parenthesis that opens at `open`, string literals skipped. */
function parenthesized(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
    } else if (char === '(') {
      depth++;
    } else if (char === ')' && --depth === 0) {
      return text.slice(open + 1, i);
    }
  }
  return text.slice(open + 1);
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
