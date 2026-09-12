// Edges out of project configuration: a manifest or build file links to the files and projects it names.
//   - Path strings in any config format, quoted or as YAML, INI and XML values. A file links to that file; a
//     directory links to its manifest (one named like the referring file first, then package.json, Cargo.toml,
//     go.mod, …); a directory glob (npm workspaces, Cargo members) links to the manifest of every match.
//   - package.json entry points, mapped back to source (dist/index.js → src/index.ts), and a Cargo.toml's crate root.
//   - Unquoted forms: Maven <module>, Gradle include, CMake add_subdirectory and include, Makefile include,
//     go.work use and go.mod replace, Bazel labels, compose build contexts and dockerfiles.
// A path string that matches nothing is dropped. Only what a build requires (a module, subdirectory or label)
// counts as unresolved when it is missing.

import { basenameOf, dirnameOf, extensionOf } from '@orbit-code/graph/languages';
import { type PathIndex, joinPath } from './pathIndex';
import { Found, type Resolved, type ScanContext, type ScanResult, hit, hitOrExternal, resolveJsEntry } from './scan';

/** Links from path strings per file; long file lists in project files stop here. */
const MAX_PATH_LINKS = 64;
/** What a referenced directory links to, after a manifest named like the referring file. */
const MANIFESTS = [
  'package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'setup.py', 'pom.xml', 'build.gradle.kts', 'build.gradle', 'settings.gradle.kts',
  'settings.gradle', 'CMakeLists.txt', 'composer.json', 'pubspec.yaml', 'mix.exs', 'Package.swift', 'BUILD.bazel', 'BUILD', 'Dockerfile',
  'Containerfile', 'action.yml', 'action.yaml', 'Chart.yaml', 'kustomization.yaml', 'main.tf', 'tsconfig.json', 'Makefile',
];
const PROJECT_FILE = /\.(?:cs|fs|vb|vcx)proj$/;
/** Configs whose paths start at the workspace root rather than at their own directory. */
const ROOT_RELATIVE = new Set(['angular.json', 'nx.json', 'project.json', 'workspace.json']);
const XML_EXTS = new Set(['.xml', '.csproj', '.fsproj', '.vbproj', '.vcxproj', '.props', '.targets']);
const INI_EXTS = new Set(['.ini', '.cfg', '.conf', '.properties']);

export function scanConfig(text: string, fromId: string, ctx: ScanContext): ScanResult {
  const { index, projects } = ctx;
  const found = new Found();
  const name = basenameOf(fromId);
  const ext = extensionOf(name);
  const dir = dirnameOf(fromId);
  let pathText = text;

  if (name === 'package.json') {
    for (const entry of projects.packageAt(dir)?.entries ?? []) {
      const target = resolveJsEntry(dir, entry, index);
      if (target !== undefined) found.add([target]);
    }
  } else if (name === 'Cargo.toml') {
    const root = projects.crateAt(dir)?.root;
    if (root !== undefined) found.add(hitOrExternal(index.exact(root)));
  } else if (name === 'pom.xml') {
    for (const m of text.matchAll(/<module>\s*([^<\s]+)\s*<\/module>/g)) found.add(project(joinPath(dir, m[1]), ['pom.xml'], index));
  } else if (name === 'settings.gradle' || name === 'settings.gradle.kts') {
    for (const m of text.matchAll(/\binclude\b[ \t(]*((?:["'][^"'\n]+["'][ \t]*,?[ \t]*)+)/g)) {
      for (const s of m[1].matchAll(/["']([^"'\n]+)["']/g)) {
        const projectDir = joinPath(dir, s[1].split(':').filter(Boolean).join('/'));
        // A Gradle project need not have a build file of its own: only a missing directory is unresolved.
        found.add(projectDir !== undefined && index.hasDir(projectDir) ? hitOrExternal(manifest(projectDir, ['build.gradle.kts', 'build.gradle'], index)) : []);
      }
    }
  } else if (name === 'CMakeLists.txt' || ext === '.cmake') {
    for (const m of text.matchAll(/\badd_subdirectory\s*\(\s*"?([^\s")$]+)/gi)) found.add(project(joinPath(dir, m[1]), ['CMakeLists.txt'], index));
    for (const m of text.matchAll(/\binclude\s*\(\s*"?([^\s")$]+\.cmake)"?\s*\)/gi)) found.add(hitOrExternal(index.exact(joinPath(dir, m[1]))));
  } else if (name === 'Makefile' || name === 'makefile' || name === 'GNUmakefile' || ext === '.mk') {
    for (const m of text.matchAll(/^-?include[ \t]+([^\n#]+)/gm)) {
      for (const token of m[1].trim().split(/\s+/)) if (!token.includes('$')) found.add(hitOrExternal(index.exact(joinPath(dir, token))));
    }
    for (const m of text.matchAll(/(?:^|[\s=])(\.{1,2}\/[\w.\-/]+)/gm)) found.add(hitOrExternal(index.exact(joinPath(dir, m[1]))));
  } else if (name === 'go.work') {
    for (const m of text.matchAll(/^[ \t]*use[ \t]*(?:\(([^)]*)\)|(\S+))/gm)) {
      const specs = m[1] === undefined ? [m[2]] : m[1].split('\n').map((line) => line.replace(/\/\/.*/, '').trim()).filter(Boolean);
      for (const spec of specs) found.add(project(joinPath(dir, spec.replace(/^"|"$/g, '')), ['go.mod'], index));
    }
  } else if (name === 'go.mod') {
    for (const m of text.matchAll(/=>[ \t]*(\.{1,2}(?:\/\S*)?)[ \t]*$/gm)) found.add(project(joinPath(dir, m[1]), ['go.mod'], index));
  } else if (name === 'BUILD' || name === 'WORKSPACE' || name === 'BUCK' || ext === '.bazel' || ext === '.bzl') {
    // "//pkg/path:target" names a file or a package of this workspace; "@repo//…" is external.
    for (const m of text.matchAll(/["']@?\/\/([\w\-./]*)(?::([\w\-./+=]+))?["']/g)) {
      const pkg = m[1] || '.';
      if (pkg === 'visibility' || pkg.startsWith('visibility/')) continue;
      if (m[2]?.endsWith('.bzl')) found.add(hit(index.exact(joinPath(pkg, m[2]))));
      else if (m[2] !== undefined && extensionOf(m[2])) found.add(hitOrExternal(index.exact(joinPath(pkg, m[2]))));
      else found.add(project(pkg, ['BUILD.bazel', 'BUILD'], index));
    }
    for (const m of text.matchAll(/\bload\(\s*["']:([\w\-./]+\.bzl)["']/g)) found.add(hit(index.exact(joinPath(dir, m[1]))));
  } else if (/^(?:docker-)?compose\b/.test(name)) {
    let context = '.';
    for (const line of text.split('\n')) {
      if (/^[ \t]*build:[ \t]*$/.test(line)) context = '.';
      const value = /^[ \t]*(build|context|dockerfile):[ \t]*["']?([^"'\s#{]+)/.exec(line);
      if (!value) continue;
      if (value[1] === 'dockerfile') {
        found.add(hitOrExternal(index.exact(joinPath(joinPath(dir, context) ?? dir, value[2]))));
        continue;
      }
      context = value[2];
      const contextDir = joinPath(dir, context);
      if (contextDir !== undefined) found.add(hitOrExternal(index.exact(joinPath(contextDir, 'Dockerfile')) ?? index.exact(joinPath(contextDir, 'Containerfile'))));
    }
    // Build contexts and dockerfiles are done: a dockerfile path is relative to its context, not to the compose file.
    pathText = text.replace(/^[ \t]*(?:build|context|dockerfile):.*$/gm, '');
  }

  const preferred = preferredManifests(name);
  const rootRelative = ROOT_RELATIVE.has(name) || dir.split('/').some((segment) => segment.startsWith('.'));
  let links = 0;
  for (const value of pathStrings(pathText, ext)) {
    if (links >= MAX_PATH_LINKS) break;
    const path = pathLike(value);
    if (path === undefined) continue;
    const targets = resolvePath(path, dir, rootRelative, preferred, index);
    if (targets.length === 0) continue;
    found.add(targets);
    links += targets.length;
  }
  return found.result();
}

function preferredManifests(name: string): string[] {
  if (/^[tj]sconfig(?:\..+)?\.json$/.test(name)) return ['tsconfig.json', 'jsconfig.json'];
  if (/^(?:docker-)?compose\b/.test(name)) return ['Dockerfile', 'Containerfile'];
  return [name];
}

/** A directory's manifest: the preferred names, then the usual ones, then a .NET project file. */
function manifest(dir: string, preferred: readonly string[], index: PathIndex): number | undefined {
  for (const name of [...preferred, ...MANIFESTS]) {
    const found = index.exact(joinPath(dir, name));
    if (found !== undefined) return found;
  }
  return index.inDir(dir).find((i) => PROJECT_FILE.test(index.ids[i]));
}

/** A project the build requires, by the manifest it must have: found, else unresolved. */
function project(dir: string | undefined, names: readonly string[], index: PathIndex): Resolved {
  if (dir === undefined) return null;
  for (const name of names) {
    const found = index.exact(joinPath(dir, name));
    if (found !== undefined) return [found];
  }
  return [];
}

/** Candidate path values: quoted strings everywhere, plus unquoted YAML, INI and XML values. */
function pathStrings(text: string, ext: string): string[] {
  const values: string[] = [];
  for (const m of text.matchAll(/"((?:[^"\\\n]|\\.){1,300})"|'([^'\n]{1,300})'/g)) values.push((m[1] ?? m[2]).replace(/\\\\/g, '\\'));
  if (ext === '.yaml' || ext === '.yml') {
    for (const m of text.matchAll(/^[ \t]*(?:-[ \t]+(?:[\w.-]+:[ \t]+)?|[\w.-]+:[ \t]+)([^\s#"'&*!|>{}[\],][^\s#,]*)[ \t]*(?:#.*)?$/gm)) values.push(m[1]);
  } else if (INI_EXTS.has(ext)) {
    for (const m of text.matchAll(/^[ \t]*[\w.-]+[ \t]*[=:][ \t]*([^\s#;"']+)[ \t]*$/gm)) values.push(m[1]);
  } else if (XML_EXTS.has(ext)) {
    for (const m of text.matchAll(/>[ \t]*([^<>\s]{1,300})[ \t]*</g)) values.push(m[1]);
  }
  return values;
}

/** The value as a workspace path, if it looks like one: no spaces, URLs, variables or absolute paths; a slash or an extension. */
function pathLike(value: string): string | undefined {
  const path = value.trim().replace(/\\/g, '/');
  if (path === '' || /[\s$<>|`"'{}]/.test(path) || path.includes('://') || /^[/~@#:!-]/.test(path) || /^[A-Za-z]:\//.test(path)) return undefined;
  const last = path.replace(/\/+$/, '').split('/').pop() ?? '';
  return path.includes('/') || /\.[A-Za-z][\w+-]*$/.test(last) ? path : undefined;
}

function resolvePath(path: string, dir: string, rootRelative: boolean, preferred: readonly string[], index: PathIndex): number[] {
  const bases = rootRelative && dir !== '.' ? [dir, '.'] : [dir];
  for (const base of bases) {
    if (path.includes('*')) {
      const matches = globDirs(base, path, index).flatMap((match) => manifest(match, preferred, index) ?? []);
      if (matches.length) return matches;
      continue;
    }
    const target = joinPath(base, path);
    if (!target) continue;
    const file = index.exact(target);
    if (file !== undefined) return [file];
    if (index.hasDir(target)) {
      const found = manifest(target, preferred, index);
      return found === undefined ? [] : [found];
    }
  }
  return [];
}

/** Directories a directory glob ("packages/*", "apps/**") matches; file globs ("src/**\/*.ts") match nothing here. */
function globDirs(base: string, pattern: string, index: PathIndex): string[] {
  const glob = joinPath(base, pattern);
  if (glob === undefined || basenameOf(glob).includes('.')) return [];
  const source = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, ' ')
    .replace(/\*/g, '[^/]*')
    .replace(/ /g, '.*');
  const re = new RegExp(`^${source}$`);
  return [...index.directories()]
    .filter((candidate) => re.test(candidate))
    .sort()
    .slice(0, MAX_PATH_LINKS);
}
