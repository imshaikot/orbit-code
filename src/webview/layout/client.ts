import workerSource from 'orbit:layout-worker';
import type { LayoutRequest, LayoutResponse, LayoutSnapshot } from '../../shared/protocol';

export type LayoutProgress = Extract<LayoutResponse, { type: 'progress' }>;

let workerUrl: string | undefined;

/**
 * Runs the force layout off the main thread. The worker ships inside webview.js
 * and starts from a Blob URL: a worker loaded from a webview resource URI would
 * be cross-origin, and this keeps the webview a single file (CSP: worker-src blob:).
 */
export function computeLayout(request: LayoutRequest, onProgress: (progress: LayoutProgress) => void): { result: Promise<LayoutSnapshot>; cancel(): void } {
  workerUrl ??= URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
  const worker = new Worker(workerUrl);

  const result = new Promise<LayoutSnapshot>((resolve, reject) => {
    worker.onmessage = ({ data }: MessageEvent<LayoutResponse>) => {
      if (data.type === 'progress') {
        onProgress(data);
      } else {
        worker.terminate();
        resolve(data.layout);
      }
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || 'layout worker failed'));
    };
  });

  // The main thread keeps its arrays for rendering, so the worker gets copies, transferred.
  const dirIndex = request.nodes.dirIndex.slice();
  const sizes = request.nodes.sizes.slice();
  const edges = request.edges.slice();
  const message: LayoutRequest = { hash: request.hash, nodes: { ...request.nodes, dirIndex, sizes }, edges };
  worker.postMessage(message, [dirIndex.buffer, sizes.buffer, edges.buffer]);

  return { result, cancel: () => worker.terminate() };
}
