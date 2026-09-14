declare module '*.css' {
  /** The stylesheet's text (esbuild's text loader); client.ts injects it with the page nonce. */
  const text: string;
  export default text;
}

interface Window {
  /** What webview.js talks to its host through (packages/webview/src/host.ts); the client defines it once connected. */
  orbitHost?: {
    postMessage(message: import('@orbit-code/protocol').WebviewToHost): void;
    getState?(): unknown;
    setState?(state: unknown): void;
  };
}
