// The few globals every runtime Orbit runs in provides (browsers, Node, workers) that runtime:neutral packages use.
// Their tsconfigs load neither the DOM library nor @types/node, so anything else a browser or Node alone offers fails
// to typecheck there. A project that imports these packages compiles them against its own, fuller declarations.

declare function setTimeout(callback: () => void, ms?: number): unknown;
declare function clearTimeout(handle: unknown): void;
declare const console: {
  log(...data: unknown[]): void;
  warn(...data: unknown[]): void;
  error(...data: unknown[]): void;
};
declare class TextEncoder {
  encode(input?: string): Uint8Array;
}
declare class TextDecoder {
  constructor(label?: string, options?: { fatal?: boolean });
  decode(input?: Uint8Array): string;
}
