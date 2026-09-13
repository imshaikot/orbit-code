import { type FileKind, extensionOf, fileKindOf } from '@orbit-code/graph/languages';
import * as THREE from 'three';

// File-type icons for the Flat view, drawn once into a texture atlas on a canvas: nothing is loaded. Where developers
// already read a monogram (TS, Py, Go, C#) the icon is one, set in a single weight; where they read a symbol (markup,
// a shell prompt, a database, a container, a gear for configuration) it is one, stroked at a single width. The shader
// uses the atlas's alpha as a mask and prints the icon onto each file's sphere.

const CELL = 128;
export const ICON_COLUMNS = 8;
/** Half the glyph box, as a share of the cell: the rest is padding, so mipmaps never bleed a neighbour in. */
export const ICON_BOX = 0.33;
const FONT = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

type Draw = (g: CanvasRenderingContext2D) => void;

/** Unit-box line art, y pointing down, drawn within [-1, 1]. */
const SYMBOLS: Record<string, Draw> = {
  markup: (g) => {
    polyline(g, [-0.3, -0.55], [-0.92, 0], [-0.3, 0.55]);
    polyline(g, [0.3, -0.55], [0.92, 0], [0.3, 0.55]);
    polyline(g, [0.16, -0.78], [-0.16, 0.78]);
  },
  shell: (g) => {
    polyline(g, [-0.85, -0.55], [-0.2, 0], [-0.85, 0.55]);
    polyline(g, [0.08, 0.62], [0.9, 0.62]);
  },
  data: (g) => {
    g.beginPath();
    g.ellipse(0, -0.58, 0.72, 0.26, 0, 0, Math.PI * 2);
    g.stroke();
    polyline(g, [-0.72, -0.58], [-0.72, 0.58]);
    polyline(g, [0.72, -0.58], [0.72, 0.58]);
    g.beginPath();
    g.ellipse(0, 0.58, 0.72, 0.26, 0, 0, Math.PI);
    g.stroke();
    g.beginPath();
    g.ellipse(0, 0, 0.72, 0.26, 0, 0, Math.PI);
    g.stroke();
  },
  infra: (g) => {
    polyline(g, [0, -0.9], [0.8, -0.46], [0.8, 0.46], [0, 0.9], [-0.8, 0.46], [-0.8, -0.46], [0, -0.9]);
    polyline(g, [-0.8, -0.46], [0, 0], [0.8, -0.46]);
    polyline(g, [0, 0], [0, 0.9]);
  },
  config: (g) => {
    g.beginPath();
    const teeth = 8;
    for (let k = 0; k < teeth * 4; k++) {
      const angle = (k / (teeth * 4)) * Math.PI * 2;
      const r = k % 4 < 2 ? 0.95 : 0.7;
      if (k === 0) g.moveTo(Math.cos(angle) * r, Math.sin(angle) * r);
      else g.lineTo(Math.cos(angle) * r, Math.sin(angle) * r);
    }
    g.closePath();
    g.fill();
    g.globalCompositeOperation = 'destination-out';
    g.beginPath();
    g.arc(0, 0, 0.32, 0, Math.PI * 2);
    g.fill();
    g.globalCompositeOperation = 'source-over';
  },
  file: (g) => {
    polyline(g, [-0.62, -0.9], [0.22, -0.9], [0.66, -0.46], [0.66, 0.9], [-0.62, 0.9], [-0.62, -0.9]);
    polyline(g, [0.22, -0.9], [0.22, -0.46], [0.66, -0.46]);
    polyline(g, [-0.3, 0.06], [0.34, 0.06]);
    polyline(g, [-0.3, 0.46], [0.34, 0.46]);
  },
};

const MONOGRAMS = [
  'TS', 'JS', 'Py', 'Go', 'Rs', 'Jv', 'Kt', 'Sc', 'Gr', 'C', 'C++', 'Oc', 'Cu', 'C#', 'F#', 'VB', 'Sw', 'Rb', 'php', 'Dt', 'Ex', 'Er', 'Gl',
  'Vue', 'Sv', 'As', 'Lua', 'Pl', 'R', 'Jl', 'Zig', 'Nim', 'Cr', 'Sol', 'λ', 'Elm', 'Pb', 'GQ', 'Tf', 'Nix', 'Bi', 'yml', 'toml', '{ }', '#',
];

/** Every icon, in atlas order. */
const ICONS = [...Object.keys(SYMBOLS), ...MONOGRAMS];
const INDEX = new Map(ICONS.map((name, k) => [name, k]));
export const ICON_ROWS = Math.ceil(ICONS.length / ICON_COLUMNS);

const BY_EXTENSION: Record<string, string> = {};
const extensions = (icon: string, ...list: string[]) => list.forEach((ext) => (BY_EXTENSION[ext] = icon));
extensions('TS', '.ts', '.tsx', '.mts', '.cts');
extensions('JS', '.js', '.jsx', '.mjs', '.cjs');
extensions('Py', '.py', '.pyi', '.pyw', '.pyx', '.pxd', '.ipynb');
extensions('Go', '.go');
extensions('Rs', '.rs');
extensions('Jv', '.java');
extensions('Kt', '.kt', '.kts');
extensions('Sc', '.scala', '.sc');
extensions('Gr', '.groovy', '.gvy', '.gradle');
extensions('λ', '.clj', '.cljs', '.cljc', '.hs', '.lhs', '.ml', '.mli');
extensions('C', '.c', '.h');
extensions('C++', '.cc', '.cpp', '.cxx', '.c++', '.hpp', '.hh', '.hxx', '.h++', '.ipp', '.inl', '.tpp', '.ino');
extensions('Oc', '.m', '.mm');
extensions('Cu', '.cu', '.cuh');
extensions('C#', '.cs', '.csx');
extensions('F#', '.fs', '.fsx', '.fsi');
extensions('VB', '.vb');
extensions('Sw', '.swift');
extensions('Rb', '.rb', '.rake', '.ru');
extensions('php', '.php', '.phtml');
extensions('Dt', '.dart');
extensions('Ex', '.ex', '.exs');
extensions('Er', '.erl', '.hrl');
extensions('Gl', '.gleam');
extensions('Vue', '.vue');
extensions('Sv', '.svelte');
extensions('As', '.astro');
extensions('Lua', '.lua');
extensions('Pl', '.pl', '.pm');
extensions('R', '.r');
extensions('Jl', '.jl');
extensions('Zig', '.zig');
extensions('Nim', '.nim');
extensions('Cr', '.cr');
extensions('Sol', '.sol');
extensions('Elm', '.elm');
extensions('Pb', '.proto');
extensions('GQ', '.graphql', '.gql');
extensions('Tf', '.tf', '.tfvars', '.hcl');
extensions('Nix', '.nix');
extensions('Bi', '.bicep');
extensions('yml', '.yaml', '.yml');
extensions('toml', '.toml');
extensions('{ }', '.json', '.jsonc');
extensions('data', '.sql', '.prisma', '.thrift', '.avsc', '.fbs', '.capnp');

const BY_NAME: Record<string, string> = {
  Dockerfile: 'infra', Containerfile: 'infra', Earthfile: 'infra', Tiltfile: 'infra', Vagrantfile: 'infra',
  'go.mod': 'Go', 'go.work': 'Go', 'Cargo.toml': 'Rs', 'pyproject.toml': 'Py', 'requirements.txt': 'Py', Pipfile: 'Py',
  Gemfile: 'Rb', Rakefile: 'Rb', 'Package.swift': 'Sw', 'pom.xml': 'Jv', 'build.gradle.kts': 'Kt', 'composer.json': 'php', 'pubspec.yaml': 'Dt',
};

const BY_KIND: Readonly<Record<FileKind, string>> = {
  typescript: 'TS', javascript: 'JS', python: 'Py', go: 'Go', rust: 'Rs', jvm: 'Jv', c: 'C', dotnet: 'C#', swift: 'Sw', ruby: 'Rb', php: 'php',
  dart: 'Dt', beam: 'Ex', markup: 'markup', styles: '#', shell: 'shell', data: 'data', infra: 'infra', other: 'file', config: 'config',
};

/** The atlas cell of a file's icon, from its basename: known names first, then the extension, then its kind. */
export function iconOf(name: string): number {
  const kind = fileKindOf(name);
  const byName = BY_NAME[name] ?? (/^(?:docker-)?compose\b/.test(name) ? 'infra' : undefined);
  const byExtension = BY_EXTENSION[extensionOf(name)];
  // A config-kind file only takes a monogram named for configuration (yml, toml, { }); a Makefile or .cfg wears the gear.
  const icon = byName ?? (kind === 'config' && byExtension && !['yml', 'toml', '{ }'].includes(byExtension) ? undefined : byExtension) ?? BY_KIND[kind];
  return INDEX.get(icon) ?? INDEX.get('file')!;
}

let atlas: THREE.CanvasTexture | undefined;

/** The icon atlas, drawn on first use and kept for the page's life. */
export function iconAtlas(): THREE.CanvasTexture {
  if (atlas) return atlas;
  const canvas = document.createElement('canvas');
  canvas.width = ICON_COLUMNS * CELL;
  canvas.height = ICON_ROWS * CELL;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#fff';
  g.strokeStyle = '#fff';
  g.lineCap = 'round';
  g.lineJoin = 'round';
  ICONS.forEach((name, k) => {
    const cx = ((k % ICON_COLUMNS) + 0.5) * CELL;
    const cy = (Math.floor(k / ICON_COLUMNS) + 0.5) * CELL;
    const symbol = SYMBOLS[name];
    if (symbol) {
      g.save();
      g.translate(cx, cy);
      g.scale(CELL * ICON_BOX, CELL * ICON_BOX);
      g.lineWidth = 0.24;
      symbol(g);
      g.restore();
    } else {
      monogram(g, name, cx, cy);
    }
  });
  atlas = new THREE.CanvasTexture(canvas);
  atlas.flipY = false;
  atlas.generateMipmaps = true;
  atlas.minFilter = THREE.LinearMipmapLinearFilter;
  atlas.magFilter = THREE.LinearFilter;
  atlas.needsUpdate = true;
  return atlas;
}

/** Text as large as fits the glyph box, centred on its ink rather than its line box. */
function monogram(g: CanvasRenderingContext2D, text: string, cx: number, cy: number): void {
  const box = CELL * ICON_BOX * 2;
  const tight = text.length > 2 ? -0.02 : -0.01;
  g.font = `700 100px ${FONT}`;
  g.letterSpacing = `${tight * 100}px`;
  const probe = g.measureText(text);
  const size = Math.min(100 * (box / Math.max(1, probe.width)), 100 * ((box * 0.74) / Math.max(1, probe.actualBoundingBoxAscent + probe.actualBoundingBoxDescent)), CELL * 0.62);
  g.font = `700 ${size.toFixed(1)}px ${FONT}`;
  g.letterSpacing = `${tight * size}px`;
  const metrics = g.measureText(text);
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  const x = cx - (metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight) / 2 + metrics.actualBoundingBoxLeft;
  const y = cy + (metrics.actualBoundingBoxAscent - metrics.actualBoundingBoxDescent) / 2;
  g.fillText(text, x, y);
}

function polyline(g: CanvasRenderingContext2D, ...points: Array<[number, number]>): void {
  g.beginPath();
  points.forEach(([x, y], k) => (k === 0 ? g.moveTo(x, y) : g.lineTo(x, y)));
  g.stroke();
}
