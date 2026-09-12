// Colours are authored in sRGB and written straight to the framebuffer by the
// custom shaders, so they are kept as plain [r, g, b] triples, not THREE.Color
// (which would convert to linear space behind our back).

import type { FileKind } from '@orbit-code/graph/languages';

export type Rgb = readonly [number, number, number];

export function hex(value: string): Rgb {
  const n = Number.parseInt(value.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** The same colour for the HUD, e.g. a legend swatch. */
export function cssColor([r, g, b]: Rgb): string {
  return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
}

export const PALETTE = {
  /** Planetarium dome: the scene ground. */
  dome: '#0a1024',
  /** Resting import edge. */
  chartLine: hex('#39508f'),
  /** Directory-to-directory edge in the overview. */
  chartLineBright: hex('#6d85cc'),
  /** Claude read a file. */
  read: hex('#6fe3ff'),
  /** Claude edited a file (and the ripple through its neighbours). */
  edit: hex('#ffb23e'),
  /** Claude is thinking: spikes firing along the import lines. */
  think: hex('#c9a8ff'),
  claudeCore: hex('#f6f3ff'),
  claudeHalo: hex('#a58bff'),
  /**
   * An MCP server Claude calls, and the calls travelling to it. Lime, to stay apart from read cyan, edit amber and the
   * violets in OKLab: normal vision ΔE ≥ 19, protanopia ≥ 17, deuteranopia ≥ 12.
   */
  mcp: hex('#e2ff5a'),
  /** A tool call that failed. */
  error: hex('#ff8f9a'),
} as const;

/**
 * How an MCP server connected, in the MCP view: the lime of an MCP call when connected, cyan-blue while connecting,
 * amber when it needs the user (sign-in, approval), pink-red when it failed, a dim grey when disabled. Checked in OKLab
 * against each other: normal vision ΔE ≥ 19, protanopia ≥ 9, deuteranopia ≥ 12.
 */
export const MCP_STATUS_COLORS = {
  connected: PALETTE.mcp,
  pending: hex('#6fc8ff'),
  'needs-auth': hex('#ffae42'),
  failed: hex('#ff5c9a'),
  disabled: hex('#5f6782'),
} as const;

/**
 * Where a skill comes from, in the skill constellation: this workspace, the user's own skills, a plugin. Checked in
 * OKLab against each other: normal vision ΔE ≥ 19, protanopia ≥ 13, deuteranopia ≥ 8.
 */
export const SCOPE_COLORS = {
  project: hex('#bba8ff'),
  user: hex('#7dffb0'),
  plugin: hex('#ffc46b'),
} as const;

/*
 * File type colours: each file wears its kind's, each directory bubble the colour of the kind most of its files are.
 * They sit at mid lightness, so the bright activity colours (read cyan, edit amber, Claude's violet) stay apart from them.
 * Eleven colours cannot keep twenty kinds apart, so kinds that seldom share a repository share one (Go and Dart, Rust
 * and Swift, …) and the legend names every kind present under its colour. Checked in OKLab for the kinds that most
 * often share a repository: normal vision ΔE ≥ 15, protanopia and deuteranopia ΔE ≥ 6. Project config is a dark
 * neutral, so it recedes behind the code.
 */
const TYPESCRIPT = hex('#3186e9');
const JAVASCRIPT = hex('#95c42a');
const PYTHON = hex('#3d9406');
const GO_DART = hex('#009f83');
const RUST_SWIFT = hex('#e65909');
const JVM_RUBY = hex('#af4da9');
const C_FAMILY = hex('#c2b6a2');
const DOTNET_PHP_ELIXIR = hex('#9d4ab9');
const WEB = hex('#fa7ed5');
const SUPPORT = hex('#c2736c');
const CONFIG = hex('#575b62');

export const KIND_COLORS: Readonly<Record<FileKind, Rgb>> = {
  typescript: TYPESCRIPT,
  javascript: JAVASCRIPT,
  python: PYTHON,
  go: GO_DART,
  rust: RUST_SWIFT,
  jvm: JVM_RUBY,
  c: C_FAMILY,
  dotnet: DOTNET_PHP_ELIXIR,
  swift: RUST_SWIFT,
  ruby: JVM_RUBY,
  php: DOTNET_PHP_ELIXIR,
  dart: GO_DART,
  beam: DOTNET_PHP_ELIXIR,
  markup: WEB,
  styles: WEB,
  shell: SUPPORT,
  data: SUPPORT,
  infra: SUPPORT,
  other: SUPPORT,
  config: CONFIG,
};
