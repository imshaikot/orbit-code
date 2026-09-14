#!/usr/bin/env node
// Checks the rules that keep Orbit's packages usable from every editor, using each project's project.json tags, its
// package.json dependencies and the imports in its src/:
//   tags      every project has one type: tag (lib, app, tool) and one runtime: tag (neutral, browser, node, vscode, electron)
//   type      a lib depends only on libs; an app or a tool depends only on libs
//   runtime   code imports only projects that run where it runs, and nothing its runtime lacks:
//               neutral  neutral projects; no Node builtins, no 'vscode'
//               browser  neutral and browser projects; no Node builtins, no 'vscode'
//               node     neutral and node projects; no 'vscode'
//               vscode   neutral, node and vscode projects; the only runtime that imports 'vscode'
//   declared  every package a project's code imports is in its package.json, and no relative import leaves its src/
//   indexer   outside @orbit-code/indexer only its listFiles module is imported: dependency-cruiser and TypeScript
//             load in the indexer worker, never in a host or the webview
// Prints one line per violation and exits non-zero if there are any.
//
//   yarn boundaries

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TYPES = ['lib', 'app', 'tool'];
const RUNTIMES = { neutral: ['neutral'], browser: ['neutral', 'browser'], node: ['neutral', 'node'], vscode: ['neutral', 'node', 'vscode'], electron: ['neutral', 'node', 'electron'] };
const INDEXER_API = new Set(['@orbit-code/indexer/listFiles']);
const builtins = new Set(builtinModules);

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const problems = [];

const projects = [];
for (const group of ['apps', 'packages', 'tools']) {
  if (!existsSync(join(root, group))) continue;
  for (const entry of readdirSync(join(root, group), { withFileTypes: true })) {
    const dir = join(group, entry.name);
    if (!entry.isDirectory() || !existsSync(join(root, dir, 'package.json'))) continue;
    if (!existsSync(join(root, dir, 'project.json'))) {
      problems.push(`${dir}: a workspace package without project.json, so it has no tags`);
      continue;
    }
    const project = readJson(join(root, dir, 'project.json'));
    const manifest = readJson(join(root, dir, 'package.json'));
    const tags = project.tags ?? [];
    const tag = (prefix) => tags.filter((value) => value.startsWith(`${prefix}:`)).map((value) => value.slice(prefix.length + 1));
    const [type, ...extraTypes] = tag('type');
    const [runtime, ...extraRuntimes] = tag('runtime');
    if (!TYPES.includes(type) || extraTypes.length > 0) problems.push(`${dir}: needs exactly one of ${TYPES.map((t) => `type:${t}`).join(', ')}`);
    if (!(runtime in RUNTIMES) || extraRuntimes.length > 0) problems.push(`${dir}: needs exactly one of ${Object.keys(RUNTIMES).map((r) => `runtime:${r}`).join(', ')}`);
    projects.push({ dir, name: project.name, packageName: manifest.name, type, runtime, dependencies: { ...manifest.dependencies, ...manifest.devDependencies } });
  }
}
const byPackage = new Map(projects.map((project) => [project.packageName, project]));

// type: from package.json, which is also what orders Nx's builds.
for (const project of projects) {
  for (const name of Object.keys(project.dependencies)) {
    const target = byPackage.get(name);
    if (target && target.type !== 'lib') problems.push(`${project.dir}: depends on ${name}, a ${target.type}; only libs are depended on`);
  }
}

// runtime, declared, indexer: from the imports in src/.
// Import and export statements (their braces may span lines), side-effect imports, import() and require().
const IMPORT = /^(?:import|export)\b[^;'"]*?\bfrom\s*(['"])([^'"\n]+)\1|^import\s*(['"])([^'"\n]+)\3|\b(?:import|require)\(\s*(['"])([^'"\n]+)\5\s*\)/gm;
const walk = (dir) =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? walk(join(dir, entry.name)) : /\.[cm]?tsx?$/.test(entry.name) ? [join(dir, entry.name)] : [],
      )
    : [];

let imports = 0;
for (const project of projects) {
  const src = join(root, project.dir, 'src');
  for (const file of walk(src)) {
    const where = relative(root, file);
    for (const [, , fromClause, , sideEffect, , called] of readFileSync(file, 'utf8').matchAll(IMPORT)) {
      const specifier = fromClause ?? sideEffect ?? called;
      if (specifier.includes('${')) continue; // an import written inside a template string, not one this file makes
      imports++;
      if (specifier.startsWith('.')) {
        if (!resolve(dirname(file), specifier).startsWith(src + sep)) problems.push(`${where}: '${specifier}' leaves ${project.dir}/src; import the package that owns it`);
        continue;
      }
      if (specifier === 'vscode') {
        if (project.runtime !== 'vscode') problems.push(`${where}: imports 'vscode' in a runtime:${project.runtime} project; only an editor app may`);
        continue;
      }
      const bare = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
      if (specifier.startsWith('node:') || builtins.has(bare.split('/')[0])) {
        if (project.runtime === 'neutral' || project.runtime === 'browser') problems.push(`${where}: imports Node's '${specifier}' in a runtime:${project.runtime} project`);
        continue;
      }
      if (/^[a-z][\w+.-]*:/.test(specifier)) continue; // a virtual module a build provides, such as orbit:layout-worker
      const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
      if (name !== project.packageName && !(name in project.dependencies)) problems.push(`${where}: imports '${specifier}', but ${project.dir}/package.json does not list ${name}`);
      const target = byPackage.get(name);
      if (!target || target === project) continue;
      if (!RUNTIMES[project.runtime]?.includes(target.runtime)) problems.push(`${where}: imports ${name} (runtime:${target.runtime}) from a runtime:${project.runtime} project`);
      if (name === '@orbit-code/indexer' && !INDEXER_API.has(specifier)) problems.push(`${where}: imports '${specifier}'; outside the indexer only ${[...INDEXER_API].join(', ')} may be, so its worker's dependencies stay out of other bundles`);
    }
  }
}

if (problems.length > 0) {
  console.error(`[boundaries] ${problems.length} problem${problems.length === 1 ? '' : 's'}:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`[boundaries] ${projects.length} projects, ${imports} imports: every dependency and import keeps to its type and runtime`);
