// How a page outside an editor reaches a local Orbit server (apps/server) and the web client (packages/web-client):
// where the server listens, the link it prints, the handshake, and the binary frames that carry protocol messages with
// their typed arrays intact, which JSON alone would not.

import type { HostToWebview, WebviewToHost } from './protocol';

/** The npm package that is the server; the web client tells people to run it. */
export const SERVER_PACKAGE = '@imshaikot/orbit-code-server';
/** The server listens on loopback only, and the web client connects nowhere else. */
export const SERVER_HOST = '127.0.0.1';
/** The ports a server tries, in order. The web client's CSP allows exactly these, so no other port can be reached. */
export const SERVER_PORTS: readonly number[] = Array.from({ length: 10 }, (_, i) => 6728 + i);
/** Where the web client is hosted: the only page origin a server accepts unless it is started with others. */
export const WEB_CLIENT_ORIGIN = 'https://orbit-code.imshaikot.com';
export const WEB_CLIENT_PATH = '/web-client/';

/** What the link a server prints carries to the page, in its fragment, so it never reaches the website. */
export interface ServerLink {
  port: number;
  token: string;
}

export function isServerPort(value: unknown): value is number {
  return typeof value === 'number' && SERVER_PORTS.includes(value);
}

/** A token a server made or was given: long enough not to be guessed, and safe in a URL fragment. */
export function isServerToken(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value);
}

export function serverLink({ port, token }: ServerLink, origin = WEB_CLIENT_ORIGIN): string {
  return `${origin}${WEB_CLIENT_PATH}#port=${port}&token=${token}`;
}

/** The link a server printed, just its fragment, or `<port> <token>`; undefined for anything else. */
export function parseServerLink(text: string): ServerLink | undefined {
  const trimmed = text.trim();
  const hash = trimmed.indexOf('#');
  const fragment = hash === -1 ? trimmed : trimmed.slice(hash + 1);
  const fields = new Map<string, string>();
  for (const part of fragment.split('&')) {
    const at = part.indexOf('=');
    if (at > 0) fields.set(part.slice(0, at), part.slice(at + 1));
  }
  let port = fields.get('port');
  let token = fields.get('token');
  if (port === undefined || token === undefined) {
    const pair = /^(\d{1,5})[\s:/]+(\S+)$/.exec(trimmed);
    if (!pair) return undefined;
    [, port, token] = pair;
  }
  const number = /^\d{1,5}$/.test(port ?? '') ? Number(port) : Number.NaN;
  if (!Number.isInteger(number) || number < 1 || number > 65535 || !isServerToken(token)) return undefined;
  return { port: number, token: token as string };
}

/** Sent to a page the server turns away, after which it closes the socket. */
export type RefusedReason = 'token' | 'protocol' | 'replaced' | 'handshake';

/** From the page: first a `hello`, then the page's messages and whether the tab is seen. */
export type ClientFrame =
  | { t: 'hello'; token: string; protocol: number }
  | { t: 'message'; message: WebviewToHost }
  | { t: 'sight'; visible: boolean; focused: boolean };

/** From the server: `welcome` or `refused` answers the `hello`; then the host's messages. */
export type ServerFrame =
  | { t: 'welcome'; version: string; protocol: number; folder: string }
  | { t: 'refused'; reason: RefusedReason; version: string; protocol: number }
  | { t: 'message'; message: HostToWebview };

/** The key of a typed array's place holder in a frame's JSON; no protocol field starts with a NUL. */
const BINARY = '\u0000binary';

const TYPED_ARRAYS = {
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
} as const;
type TypedArrayName = keyof typeof TYPED_ARRAYS;
const TYPED_ARRAY_NAMES = Object.keys(TYPED_ARRAYS) as TypedArrayName[];

/**
 * A frame as bytes: `u32 json length | u32 array count | u32 byte length per array | json | each array's bytes`, all
 * little-endian. Each typed array in the value becomes a place holder in the JSON naming its type and index.
 */
export function encodeFrame(frame: ClientFrame | ServerFrame): Uint8Array {
  const arrays: Uint8Array[] = [];
  const json = JSON.stringify(frame, (_key, value: unknown) => {
    if (!ArrayBuffer.isView(value)) return value;
    const type = TYPED_ARRAY_NAMES.find((name) => value instanceof TYPED_ARRAYS[name]);
    if (!type) throw new Error('only typed arrays cross the wire');
    arrays.push(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    return { [BINARY]: arrays.length - 1, type };
  });
  const text = new TextEncoder().encode(json);
  const header = 8 + 4 * arrays.length;
  const size = header + text.byteLength + arrays.reduce((sum, array) => sum + array.byteLength, 0);
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, text.byteLength, true);
  view.setUint32(4, arrays.length, true);
  arrays.forEach((array, i) => view.setUint32(8 + 4 * i, array.byteLength, true));
  bytes.set(text, header);
  let offset = header + text.byteLength;
  for (const array of arrays) {
    bytes.set(array, offset);
    offset += array.byteLength;
  }
  return bytes;
}

/** The value `encodeFrame` wrote, each typed array on a buffer of its own. Throws on anything malformed. */
export function decodeFrame(bytes: Uint8Array): unknown {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 8) throw new Error('frame too short');
  const textLength = view.getUint32(0, true);
  const count = view.getUint32(4, true);
  const header = 8 + 4 * count;
  if (header > bytes.byteLength || header + textLength > bytes.byteLength) throw new Error('frame header out of range');
  const ranges: Array<[number, number]> = [];
  let offset = header + textLength;
  for (let i = 0; i < count; i++) {
    const length = view.getUint32(8 + 4 * i, true);
    if (offset + length > bytes.byteLength) throw new Error('frame array out of range');
    ranges.push([offset, offset + length]);
    offset += length;
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(header, header + textLength));
  return JSON.parse(text, (_key, value: unknown) => {
    if (value === null || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, BINARY)) return value;
    const { [BINARY]: index, type } = value as Record<string, unknown>;
    const range = typeof index === 'number' ? ranges[index] : undefined;
    if (!range || typeof type !== 'string' || !(TYPED_ARRAY_NAMES as string[]).includes(type)) throw new Error('bad typed array in frame');
    const Constructor = TYPED_ARRAYS[type as TypedArrayName];
    const length = range[1] - range[0];
    if (length % Constructor.BYTES_PER_ELEMENT !== 0) throw new Error('typed array length does not fit its type');
    // A buffer of its own: `bytes` may be a Node Buffer, whose slice() shares a pooled ArrayBuffer instead of copying.
    const copy = new Uint8Array(length);
    copy.set(bytes.subarray(range[0], range[1]));
    return new Constructor(copy.buffer);
  });
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A page's frame, its shape checked; the message inside is the controller's to check. */
export function readClientFrame(bytes: Uint8Array): ClientFrame | undefined {
  let frame: unknown;
  try {
    frame = decodeFrame(bytes);
  } catch {
    return undefined;
  }
  if (!isRecord(frame)) return undefined;
  if (frame.t === 'hello') return typeof frame.token === 'string' && typeof frame.protocol === 'number' ? (frame as ClientFrame) : undefined;
  if (frame.t === 'message') return isRecord(frame.message) && typeof frame.message.type === 'string' ? (frame as ClientFrame) : undefined;
  if (frame.t === 'sight') return typeof frame.visible === 'boolean' && typeof frame.focused === 'boolean' ? (frame as ClientFrame) : undefined;
  return undefined;
}

/** A server's frame, its shape checked. */
export function readServerFrame(bytes: Uint8Array): ServerFrame | undefined {
  let frame: unknown;
  try {
    frame = decodeFrame(bytes);
  } catch {
    return undefined;
  }
  if (!isRecord(frame)) return undefined;
  if (frame.t === 'welcome') return typeof frame.version === 'string' && typeof frame.protocol === 'number' && typeof frame.folder === 'string' ? (frame as ServerFrame) : undefined;
  if (frame.t === 'refused') return typeof frame.reason === 'string' && typeof frame.protocol === 'number' ? (frame as ServerFrame) : undefined;
  if (frame.t === 'message') return isRecord(frame.message) && typeof frame.message.type === 'string' ? (frame as ServerFrame) : undefined;
  return undefined;
}
