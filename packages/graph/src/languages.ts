// Which files become graph nodes, what kind of file each one is (its colour in the view), and which
// extractor reads its imports. Shared by the indexer, the extension host (listing, watching) and the webview.

/** Kinds of file, in tie-break order: a directory holding as many files of two kinds takes the earlier one's colour. */
export const FILE_KINDS = [
  'typescript',
  'javascript',
  'python',
  'go',
  'rust',
  'jvm',
  'c',
  'dotnet',
  'swift',
  'ruby',
  'php',
  'dart',
  'beam',
  'markup',
  'styles',
  'shell',
  'data',
  'infra',
  'other',
  'config',
] as const;

export type FileKind = (typeof FILE_KINDS)[number];

export const FILE_KIND_LABELS: Readonly<Record<FileKind, string>> = {
  typescript: 'TypeScript',
  javascript: 'JavaScript',
  python: 'Python',
  go: 'Go',
  rust: 'Rust',
  jvm: 'Java & Kotlin',
  c: 'C & C++',
  dotnet: 'C# & .NET',
  swift: 'Swift',
  ruby: 'Ruby',
  php: 'PHP',
  dart: 'Dart',
  beam: 'Elixir & Erlang',
  markup: 'HTML & templates',
  styles: 'Styles',
  shell: 'Shell',
  data: 'SQL & schemas',
  infra: 'Infrastructure',
  other: 'Other code',
  config: 'Project config',
};

/** Describes a project rather than making it up: a directory takes this colour only when it holds nothing else. */
export const SUPPORTING_KIND: FileKind = 'config';

/** Regex import rules in indexer/regexScan.ts; `config` is indexer/configScan.ts. */
export type LanguageId =
  | 'js'
  | 'python'
  | 'notebook'
  | 'go'
  | 'rust'
  | 'jvm'
  | 'clojure'
  | 'c'
  | 'csharp'
  | 'swift'
  | 'ruby'
  | 'php'
  | 'dart'
  | 'elixir'
  | 'erlang'
  | 'haskell'
  | 'elm'
  | 'lua'
  | 'perl'
  | 'r'
  | 'julia'
  | 'zig'
  | 'nim'
  | 'crystal'
  | 'solidity'
  | 'shell'
  | 'powershell'
  | 'css'
  | 'html'
  | 'template'
  | 'proto'
  | 'graphql'
  | 'terraform'
  | 'nix'
  | 'config';

/** `depcruise`: dependency-cruiser, with the `js` regex rules as its fallback. `none`: a node without edges. */
export type Extractor = 'depcruise' | LanguageId | 'none';

export interface FileClass {
  readonly kind: FileKind;
  readonly extractor: Extractor;
}

const byExtension = new Map<string, FileClass>();
const byBasename = new Map<string, FileClass>();
/** Basename globs: `*` is any run of characters. Checked before extensions, so `docker-compose.yml` is not plain YAML. */
const byPattern: Array<{ glob: string; re: RegExp; cls: FileClass }> = [];

function extensions(kind: FileKind, extractor: Extractor, ...list: string[]): void {
  const cls = Object.freeze({ kind, extractor });
  for (const ext of list) byExtension.set(ext, cls);
}

function basenames(kind: FileKind, extractor: Extractor, ...list: string[]): void {
  const cls = Object.freeze({ kind, extractor });
  for (const name of list) byBasename.set(name, cls);
}

function patterns(kind: FileKind, extractor: Extractor, ...globs: string[]): void {
  const cls = Object.freeze({ kind, extractor });
  for (const glob of globs) byPattern.push({ glob, re: new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`), cls });
}

extensions('typescript', 'depcruise', '.ts', '.tsx', '.mts', '.cts');
extensions('javascript', 'depcruise', '.js', '.jsx', '.mjs', '.cjs');
extensions('python', 'python', '.py', '.pyi', '.pyw', '.pyx', '.pxd');
extensions('python', 'notebook', '.ipynb');
extensions('go', 'go', '.go');
extensions('rust', 'rust', '.rs');
extensions('jvm', 'jvm', '.java', '.kt', '.kts', '.scala', '.sc', '.groovy', '.gvy');
extensions('jvm', 'clojure', '.clj', '.cljs', '.cljc');
extensions('c', 'c', '.c', '.h', '.cc', '.cpp', '.cxx', '.c++', '.hpp', '.hh', '.hxx', '.h++', '.ipp', '.inl', '.tpp', '.m', '.mm', '.cu', '.cuh', '.ino');
extensions('dotnet', 'csharp', '.cs', '.csx');
extensions('dotnet', 'none', '.fs', '.fsx', '.fsi', '.vb');
extensions('swift', 'swift', '.swift');
extensions('ruby', 'ruby', '.rb', '.rake', '.ru');
extensions('php', 'php', '.php', '.phtml');
extensions('dart', 'dart', '.dart');
extensions('beam', 'elixir', '.ex', '.exs');
extensions('beam', 'erlang', '.erl', '.hrl');
extensions('beam', 'none', '.gleam');
extensions('markup', 'js', '.vue', '.svelte', '.astro');
extensions('markup', 'html', '.html', '.htm');
extensions('markup', 'template', '.njk', '.jinja', '.jinja2', '.j2', '.twig', '.liquid', '.ejs', '.pug', '.jade');
extensions('markup', 'csharp', '.cshtml', '.razor');
extensions('markup', 'none', '.hbs', '.handlebars', '.mustache', '.erb', '.haml', '.slim', '.heex', '.eex', '.leex');
extensions('styles', 'css', '.css', '.scss', '.sass', '.less', '.styl', '.pcss', '.postcss');
extensions('shell', 'shell', '.sh', '.bash', '.zsh', '.ksh', '.fish');
extensions('shell', 'powershell', '.ps1', '.psm1', '.psd1');
extensions('shell', 'none', '.bat', '.cmd');
extensions('data', 'proto', '.proto');
extensions('data', 'graphql', '.graphql', '.gql');
extensions('data', 'none', '.sql', '.prisma', '.thrift', '.avsc', '.fbs', '.capnp');
extensions('infra', 'terraform', '.tf', '.tfvars', '.hcl');
extensions('infra', 'nix', '.nix');
extensions('infra', 'none', '.bicep');
extensions('other', 'haskell', '.hs', '.lhs');
extensions('other', 'elm', '.elm');
extensions('other', 'lua', '.lua');
extensions('other', 'perl', '.pl', '.pm');
extensions('other', 'r', '.r');
extensions('other', 'julia', '.jl');
extensions('other', 'zig', '.zig');
extensions('other', 'nim', '.nim');
extensions('other', 'crystal', '.cr');
extensions('other', 'solidity', '.sol');
extensions(
  'other',
  'none',
  '.ml', '.mli', '.re', '.rei', '.res', '.resi', '.purs', '.hx', '.pas', '.f', '.f90', '.f95', '.f03', '.for', '.asm', '.s', '.v', '.sv', '.svh',
  '.vhd', '.vhdl', '.scm', '.rkt', '.lisp', '.el', '.vim', '.gd', '.glsl', '.vert', '.frag', '.wgsl', '.hlsl', '.metal', '.mojo', '.odin',
);

basenames('ruby', 'ruby', 'Rakefile', 'Guardfile', 'Capfile', 'Dangerfile');
basenames('infra', 'ruby', 'Vagrantfile');
basenames('infra', 'none', 'Dockerfile', 'Containerfile', 'Earthfile', 'Tiltfile');
patterns('infra', 'none', 'Dockerfile.*', '*.Dockerfile', '*.dockerfile', 'Containerfile.*');
patterns('infra', 'config', 'docker-compose*.yml', 'docker-compose*.yaml', 'compose.yml', 'compose.yaml', 'compose.*.yml', 'compose.*.yaml');
patterns('markup', 'php', '*.blade.php');

/* ── Project config: manifests, build files, and the formats configuration is written in ── */

extensions(
  'config',
  'config',
  '.toml', '.yaml', '.yml', '.ini', '.cfg', '.conf', '.properties', '.gradle', '.cmake', '.mk', '.bzl', '.bazel', '.csproj', '.fsproj', '.vbproj',
  '.vcxproj', '.props', '.targets', '.sln', '.cabal', '.gemspec', '.podspec', '.xcconfig', '.opam', '.zon',
);
basenames(
  'config',
  'config',
  // JavaScript and TypeScript
  'package.json', 'tsconfig.json', 'jsconfig.json', 'deno.json', 'deno.jsonc', 'angular.json', 'nx.json', 'project.json', 'workspace.json',
  'turbo.json', 'lerna.json', 'rush.json', 'vercel.json', 'firebase.json', 'app.json', 'babel.config.json', '.babelrc', 'biome.json',
  'biome.jsonc', '.eslintrc', '.eslintrc.json', '.prettierrc', '.prettierrc.json', '.swcrc', 'tslint.json', 'jest.config.json', 'nodemon.json',
  'nest-cli.json', 'components.json', 'devcontainer.json', '.devcontainer.json', 'renovate.json',
  // Go, Python, Ruby, PHP, Elm, Clojure, Elixir, Swift, Zig
  'go.mod', 'go.work', 'requirements.txt', 'constraints.txt', 'Pipfile', 'MANIFEST.in', 'Gemfile', 'Podfile', 'Cartfile', 'Brewfile',
  'Fastfile', 'Appfile', 'Matchfile', 'Pluginfile', 'composer.json', 'elm.json', 'project.clj', 'deps.edn', 'mix.exs', 'rebar.config',
  'Package.swift', 'build.zig',
  // JVM and .NET
  'pom.xml', 'build.xml', 'ivy.xml', 'AndroidManifest.xml', 'build.gradle.kts', 'settings.gradle.kts', 'global.json', 'appsettings.json',
  'launchSettings.json', 'nuget.config', 'NuGet.Config', 'packages.config', 'web.config', 'App.config',
  // C, C++ and build systems
  'CMakeLists.txt', 'Makefile', 'makefile', 'GNUmakefile', 'Justfile', 'justfile', 'meson.build', 'meson_options.txt', 'meson.options',
  'configure.ac', 'SConstruct', 'SConscript', 'BUILD', 'WORKSPACE', 'BUCK', 'vcpkg.json', 'dune', 'dune-project',
  // Deployment
  'Procfile', 'Jenkinsfile',
);
patterns('config', 'config', 'tsconfig.*.json', 'jsconfig.*.json', 'appsettings.*.json', 'requirements*.txt');

/** Lock files and other generated output: large, written by tools, never read by people. */
const GENERATED: ReadonlySet<string> = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'deno.lock', '.pnp.cjs', '.pnp.loader.mjs',
  'Cargo.lock', 'go.sum', 'go.work.sum', 'poetry.lock', 'Pipfile.lock', 'uv.lock', 'pdm.lock', 'Gemfile.lock', 'composer.lock', 'pubspec.lock',
  'mix.lock', 'flake.lock', 'Package.resolved', 'Podfile.lock', 'packages.lock.json', 'gradle.lockfile', '.terraform.lock.hcl', 'conan.lock',
  'Manifest.toml',
]);

/** Always skipped, even when tracked by git. */
export const ALWAYS_EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  'node_modules', '.git', 'bower_components', 'vendor', '.harness',
]);

/** Additionally skipped when there is no .gitignore to trust. */
export const FALLBACK_EXCLUDED_DIRS: readonly string[] = [
  ...ALWAYS_EXCLUDED_DIRS,
  'dist', 'out', 'build', 'coverage', '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', 'target',
  '__pycache__', '.venv', 'venv', '.tox', '.mypy_cache', '.gradle', 'Pods', 'DerivedData', '.yarn', '.vscode-test',
  'obj', '_build', '.dart_tool', 'elm-stuff', '.stack-work', 'zig-cache', 'zig-out', '.terraform', 'Carthage',
];

/** What kind of file `id` (a path or a basename) is, and how its imports are read. Undefined: not a graph node. */
export function classify(id: string): FileClass | undefined {
  const name = basenameOf(id);
  if (GENERATED.has(name) || /\.min\.(?:js|mjs|cjs|css)$/.test(name)) return undefined;
  const exact = byBasename.get(name);
  if (exact) return exact;
  for (const { re, cls } of byPattern) if (re.test(name)) return cls;
  return byExtension.get(extensionOf(name));
}

/** The kind a graph node's basename belongs to. Every graph file classifies; `other` covers anything that no longer does. */
export function fileKindOf(name: string): FileKind {
  return classify(name)?.kind ?? 'other';
}

export function extensionOf(path: string): string {
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  return dot > slash + 1 ? path.slice(dot).toLowerCase() : '';
}

export function isIndexable(id: string, excludedDirs: ReadonlySet<string> = ALWAYS_EXCLUDED_DIRS): boolean {
  if (classify(id) === undefined) return false;
  for (const segment of id.split('/').slice(0, -1)) {
    if (excludedDirs.has(segment)) return false;
  }
  return true;
}

/** Glob for workspace.findFiles and the file watcher: every extension, basename and basename pattern above. */
export function indexableGlob(): string {
  // extensionOf lowercases, so `.R` needs its own entry on case-sensitive file systems.
  const alternatives = [...[...byExtension.keys()].map((ext) => `*${ext}`), '*.R', ...byBasename.keys(), ...byPattern.map((p) => p.glob)];
  return `**/{${alternatives.join(',')}}`;
}

export function fallbackExcludeGlob(): string {
  return `**/{${FALLBACK_EXCLUDED_DIRS.join(',')}}/**`;
}

export function dirnameOf(id: string): string {
  const slash = id.lastIndexOf('/');
  return slash === -1 ? '.' : id.slice(0, slash);
}

export function basenameOf(id: string): string {
  return id.slice(id.lastIndexOf('/') + 1);
}
