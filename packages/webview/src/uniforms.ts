import * as THREE from 'three';
import { PALETTE } from './palette';

/**
 * Uniform objects shared by reference across every material, so one write
 * (uTime per frame, uRestT per result, uFocus per click) animates all layers.
 */
export function createSharedUniforms(state: THREE.DataTexture, stateWidth: number) {
  return {
    /** Animation clock in seconds. Only advances on rendered frames. */
    uTime: { value: 0 },
    /** Clock time of the last `result`; everything that started earlier fades to rest. */
    uRestT: { value: -1e6 },
    uState: { value: state },
    uStateWidth: { value: stateWidth },
    /** The directory (cluster index) whose contents are shown. */
    uFocus: { value: 0 },
    /** The directory the view is leaving while uFocusMix rises. */
    uFocusFrom: { value: 0 },
    /** 0 = showing uFocusFrom's contents, 1 = showing uFocus's. Follows the zoom (focus.ts). */
    uFocusMix: { value: 1 },
    /** The directories around uFocus and uFocusFrom (-1 above the root): their other sub-directories show as ghosts. */
    uFocusParent: { value: -1 },
    uFocusFromParent: { value: -1 },
    uHover: { value: -1 },
    uHoverCluster: { value: -1 },
    /** The file the file menu is open for, -1 for none; the clock time it was chosen; 1 while its delete waits for confirmation. */
    uSelected: { value: -1 },
    uSelectedAt: { value: -1e6 },
    uSelectTone: { value: 0 },
    /** CSS pixel height of the viewport; 1 during the 1×1 pick pass. */
    uViewportHeight: { value: 1 },
    uPixelRatio: { value: 1 },
    /** 0 at rest, 1 while a turn is in progress. Speeds up edge flow. */
    uFlow: { value: 0 },
    /** Clock time the current burst of thinking began; import lines fire from then on (edges.ts). */
    uThinkStart: { value: -1e6 },
    /** Clock time the firing starts to fade: a hold after the latest thought, or the end of the turn. */
    uThinkEnd: { value: -1e6 },
    uReadColor: { value: new THREE.Vector3(...PALETTE.read) },
    uEditColor: { value: new THREE.Vector3(...PALETTE.edit) },
  };
}

export type SharedUniforms = ReturnType<typeof createSharedUniforms>;

/** Which directory's contents are on screen, crossfading while the view moves between two. */
export const FOCUS_GLSL = /* glsl */ `
uniform float uFocus;
uniform float uFocusFrom;
uniform float uFocusMix;
uniform float uFocusParent;
uniform float uFocusFromParent;

float isDir(float value, float dir) {
  return abs(value - dir) < 0.5 ? 1.0 : 0.0;
}

// 1 while the view shows the contents of directory \`dir\`, 0 otherwise, blended during a move.
float shownIn(float dir) {
  return mix(isDir(dir, uFocusFrom), isDir(dir, uFocus), uFocusMix);
}

// 1 while directory \`dir\` is a sibling of the directory whose contents are shown (a sub-directory of the same parent),
// blended during a move: what is beside the directory being looked into.
float besideShown(float dir, float parent) {
  return mix(isDir(parent, uFocusFromParent) * (1.0 - isDir(dir, uFocusFrom)), isDir(parent, uFocusParent) * (1.0 - isDir(dir, uFocus)), uFocusMix);
}

// The directory whose contents dominate the screen; its files and bubbles take the clicks.
float shownDir() {
  return uFocusMix >= 0.5 ? uFocus : uFocusFrom;
}
`;

/** Id pass colour: 24-bit id → RGB bytes. */
export const ENCODE_ID_GLSL = /* glsl */ `
vec4 encodeId(float id) {
  return vec4(mod(floor(id / 65536.0), 256.0), mod(floor(id / 256.0), 256.0), mod(id, 256.0), 255.0) / 255.0;
}
`;

export const PICK_CLUSTER_BASE = 0x800000;
/** Pick ids of Claude's stars: PICK_CLAUDE_BASE + the star's index in its layer (claude.ts). */
export const PICK_CLAUDE_BASE = 0xc00000;
