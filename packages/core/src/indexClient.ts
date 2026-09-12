import { Worker } from 'node:worker_threads';
import type { GraphFile, IndexerRequest, IndexerResponse } from '@orbit-code/protocol';

export type IndexerProgress = Extract<IndexerResponse, { type: 'progress' }>;

/** A run given up because a newer load or update superseded it. */
export class IndexCancelled extends Error {
  constructor() {
    super('Indexing was cancelled.');
    this.name = 'IndexCancelled';
  }
}

/** Runs @orbit-code/indexer's dist/indexer.mjs on a worker thread, so a large cruise never blocks the host. */
export function runIndexer(
  indexerPath: string,
  request: IndexerRequest,
  onProgress: (progress: IndexerProgress) => void,
  signal: AbortSignal,
): Promise<GraphFile> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new IndexCancelled());
      return;
    }
    const worker = new Worker(indexerPath, { workerData: request });
    let settled = false;
    const cancel = () => settle(() => reject(new IndexCancelled()));
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', cancel);
      action();
      void worker.terminate();
    };
    signal.addEventListener('abort', cancel);

    worker.on('message', (message: IndexerResponse) => {
      if (message.type === 'progress') onProgress(message);
      else if (message.type === 'done') settle(() => resolve(message.graph));
      else settle(() => reject(new Error(message.message)));
    });
    worker.on('error', (error) => settle(() => reject(error)));
    worker.on('exit', (code) => settle(() => reject(new Error(`indexer exited with code ${code}`))));
  });
}
