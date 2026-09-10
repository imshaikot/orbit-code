// Layout Web Worker (inlined into webview.js and started from a Blob URL).
// Computes the nested bubble layout once (see nested.ts) and hands it back, frozen.

import type { LayoutRequest, LayoutResponse } from '../../shared/protocol';
import { computeNestedLayout } from './nested';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<LayoutRequest>) => void) | null;
  postMessage(message: LayoutResponse, transfer?: Transferable[]): void;
};

scope.onmessage = ({ data }) => {
  const layout = computeNestedLayout(data, (message) => scope.postMessage(message));
  scope.postMessage({ type: 'done', layout }, [
    layout.positions.buffer,
    layout.clusterOf.buffer,
    layout.clusters.centers.buffer,
    layout.clusters.radii.buffer,
  ]);
};
