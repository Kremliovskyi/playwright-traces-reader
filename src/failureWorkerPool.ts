import { fork, type ChildProcess } from 'child_process';
import * as path from 'path';
import type { FailureDigestTask, FailureWorkerInit } from './failureDigest';
import type { FailureManifestEntry } from './cli/json';

export type FailureWorkerRequest =
  | { type: 'init'; init: FailureWorkerInit }
  | { type: 'prepare'; task: FailureDigestTask }
  | { type: 'stop' };

export type FailureWorkerResponse =
  | { type: 'ready' }
  | { type: 'result'; entry: FailureManifestEntry | null }
  | { type: 'error'; message: string };

export async function runFailureWorkers(
  tasks: FailureDigestTask[],
  init: FailureWorkerInit,
  count: number,
): Promise<Array<FailureManifestEntry | null>> {
  const results: Array<FailureManifestEntry | null> = new Array(tasks.length);
  let cursor = 0;
  let failure: Error | undefined;
  const fail = (error: unknown) => {
    failure ??= error instanceof Error ? error : new Error(String(error));
  };

  const runWorker = async (): Promise<void> => {
    if (failure) return;
    let child: ChildProcess;
    try {
      child = fork(path.join(__dirname, 'failureDigestWorker.js'), [], {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
    } catch (error) {
      fail(error);
      return;
    }
    let stderr = '';
    let stopped = false;
    let exited = false;
    let taskPath = '';
    let pending: {
      resolve: (response: FailureWorkerResponse) => void;
      reject: (error: Error) => void;
    } | undefined;
    child.stderr?.on('data', chunk => {
      stderr += String(chunk).slice(0, Math.max(0, 8192 - stderr.length));
    });
    child.on('message', (response: FailureWorkerResponse) => {
      if (!pending) {
        fail(new Error('Unexpected failure preparation worker response.'));
        return;
      }
      const request = pending;
      pending = undefined;
      if (response.type === 'error') request.reject(new Error(response.message));
      else request.resolve(response);
    });
    child.on('error', error => {
      fail(error);
      pending?.reject(error);
      pending = undefined;
    });
    const closed = new Promise<void>(resolve => {
      child.once('close', (code, signal) => {
        exited = true;
        if (!stopped || code !== 0) {
          const error = new Error(
            `Failure preparation worker exited (${signal ?? code})${taskPath ? ` while preparing ${taskPath}` : ''}${stderr ? `: ${stderr.trim()}` : ''}`,
          );
          fail(error);
          pending?.reject(error);
          pending = undefined;
        }
        resolve();
      });
    });
    const request = (message: FailureWorkerRequest): Promise<FailureWorkerResponse> =>
      new Promise((resolve, reject) => {
        if (exited || !child.connected) {
          reject(new Error('Failure preparation worker is not connected.'));
          return;
        }
        pending = { resolve, reject };
        child.send(message, error => {
          if (error) {
            fail(error);
            pending?.reject(error);
            pending = undefined;
          }
        });
      });

    try {
      const ready = await request({ type: 'init', init });
      if (ready.type !== 'ready') throw new Error('Failure preparation worker did not initialize.');
      while (!failure && cursor < tasks.length) {
        const index = cursor++;
        const task = tasks[index]!;
        taskPath = task.tracePath;
        const response = await request({ type: 'prepare', task });
        if (response.type !== 'result') throw new Error('Invalid failure preparation worker result.');
        results[index] = response.entry;
      }
    } catch (error) {
      fail(error);
    } finally {
      // Drain in-flight jobs before cleanup. Abrupt termination during cache
      // publication could leave incomplete staging or a maintenance lock.
      stopped = true;
      if (child.pid === undefined) {
        // A failed spawn has no writer to drain. Sending another IPC message
        // after ENOENT/EPIPE can prevent Node from emitting "close".
        if (child.connected) child.disconnect();
      } else if (child.connected) {
        try {
          child.send({ type: 'stop' } satisfies FailureWorkerRequest, error => {
            if (error) {
              fail(error);
              if (child.connected) child.disconnect();
            }
          });
        } catch (error) {
          fail(error);
          if (child.connected) child.disconnect();
        }
      }
      if (child.pid !== undefined) await closed;
    }
  };

  await Promise.all(Array.from({ length: Math.min(count, tasks.length) }, () => runWorker()));
  if (failure) throw failure;
  return results;
}
