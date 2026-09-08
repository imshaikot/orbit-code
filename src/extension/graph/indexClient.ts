import { Worker } from 'node:worker_threads';
import * as vscode from 'vscode';
import type { GraphFile, IndexerRequest, IndexerResponse } from '../../shared/protocol';

export type IndexerProgress = Extract<IndexerResponse, { type: 'progress' }>;

/** Runs dist/indexer.mjs on a worker thread so a large cruise never blocks the extension host. */
export function runIndexer(
  extensionUri: vscode.Uri,
  request: IndexerRequest,
  onProgress: (progress: IndexerProgress) => void,
  token: vscode.CancellationToken,
): Promise<GraphFile> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(vscode.Uri.joinPath(extensionUri, 'dist', 'indexer.mjs').fsPath, { workerData: request });
    let settled = false;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      cancellation.dispose();
      action();
      void worker.terminate();
    };
    const cancellation = token.onCancellationRequested(() => settle(() => reject(new vscode.CancellationError())));

    worker.on('message', (message: IndexerResponse) => {
      if (message.type === 'progress') onProgress(message);
      else if (message.type === 'done') settle(() => resolve(message.graph));
      else settle(() => reject(new Error(message.message)));
    });
    worker.on('error', (error) => settle(() => reject(error)));
    worker.on('exit', (code) => settle(() => reject(new Error(`indexer exited with code ${code}`))));
  });
}
