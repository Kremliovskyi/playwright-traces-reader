import { prepareFailureDigest, type FailureWorkerInit } from './failureDigest';
import { buildReportTraceMaps, type ReportTraceMaps } from './parseTrace';
import { startTraceCacheSession, type TraceCacheSession } from './traceCache';
import type { FailureWorkerRequest, FailureWorkerResponse } from './failureWorkerPool';

let init: FailureWorkerInit | undefined;
let maps: ReportTraceMaps | null = null;
let session: TraceCacheSession | undefined;
let busy = false;
let stopping = false;

async function stop(): Promise<void> {
  stopping = true;
  if (busy) return;
  await session?.close();
  if (process.connected) process.disconnect?.();
}

function reply(response: FailureWorkerResponse): void {
  if (process.connected) {
    process.send?.(response, error => {
      if (error) {
        console.error('Failure preparation worker IPC error:', error);
        process.exitCode = 1;
        void stop();
      }
    });
  }
}

process.on('message', async (message: FailureWorkerRequest) => {
  if (message.type === 'stop') {
    await stop();
    return;
  }
  if (busy || stopping) {
    reply({ type: 'error', message: 'Failure preparation worker received overlapping jobs.' });
    return;
  }
  busy = true;
  try {
    if (message.type === 'init') {
      if (init) throw new Error('Failure preparation worker was initialized twice.');
      init = message.init;
      maps = init.metadata ? buildReportTraceMaps(init.metadata) : null;
      session = await startTraceCacheSession();
      reply({ type: 'ready' });
    } else {
      if (!init) throw new Error('Failure preparation worker is not initialized.');
      const entry = await prepareFailureDigest(message.task, init, maps);
      reply({ type: 'result', entry });
    }
  } catch (error) {
    reply({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  } finally {
    busy = false;
    if (stopping) await stop();
  }
});

process.on('disconnect', () => { void stop(); });
