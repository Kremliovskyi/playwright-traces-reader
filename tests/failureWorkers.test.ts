import childProcess = require('child_process');
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { writeFailureDigests } from '../dist/failureDigest';
import { runCli } from '../dist/cli';
import { getReportMetadata, type ReportMetadata } from '../dist/parseTrace';
import { getTraceCacheRoot } from '../dist/traceCache';
import type { FailureWorkerRequest, FailureWorkerResponse } from '../dist/failureWorkerPool';
import {
  cleanupSyntheticReportFixture,
  createSyntheticReportFixture,
  type SyntheticReportFixture,
} from './syntheticReport';

jest.setTimeout(30000);

async function fileHashes(root: string, excludeManifest = false): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  const visit = async (relative: string): Promise<void> => {
    for (const entry of await fs.promises.readdir(path.join(root, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) await visit(name);
      else if (!excludeManifest || name !== 'index.json')
        hashes[name] = crypto.createHash('sha256').update(await fs.promises.readFile(path.join(root, name))).digest('hex');
    }
  };
  await visit('');
  return hashes;
}

describe('bounded failure preparation workers', () => {
  let fixture: SyntheticReportFixture;
  let outputDir: string;
  let metadata: ReportMetadata;
  let children: childProcess.ChildProcess[];
  let forkSpy: jest.SpyInstance;
  let active: Set<childProcess.ChildProcess>;
  let maxActive: number;
  let tasksByPid: Map<number, string[]>;
  let completionOrder: string[];
  let dispatchedAtFirstCompletion: number | undefined;
  let delayFirstTask: boolean;
  let onChild: ((child: childProcess.ChildProcess) => void) | undefined;

  beforeEach(async () => {
    fixture = await createSyntheticReportFixture();
    outputDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pwtr-workers-'));
    const report = await getReportMetadata(fixture.rootDir);
    if (!report) throw new Error('Missing fixture metadata');
    metadata = report;
    children = [];
    active = new Set();
    maxActive = 0;
    tasksByPid = new Map();
    completionOrder = [];
    dispatchedAtFirstCompletion = undefined;
    delayFirstTask = false;
    onChild = undefined;
    const originalFork = childProcess.fork;
    forkSpy = jest.spyOn(childProcess, 'fork').mockImplementation((...args) => {
      const child = originalFork(...args);
      children.push(child);
      const send = child.send.bind(child);
      let tracePath = '';
      jest.spyOn(child, 'send').mockImplementation((...sendArgs) => {
        const message = sendArgs[0] as FailureWorkerRequest;
        if (message.type === 'prepare') {
          expect(active.has(child)).toBe(false);
          active.add(child);
          maxActive = Math.max(maxActive, active.size);
          tracePath = message.task.tracePath;
          const previous = tasksByPid.get(child.pid!) ?? [];
          tasksByPid.set(child.pid!, [...previous, tracePath]);
          if (delayFirstTask) {
            delayFirstTask = false;
            setTimeout(() => send(...sendArgs), 250);
            return true;
          }
        }
        return send(...sendArgs);
      });
      child.on('message', (message: FailureWorkerResponse) => {
        if (message.type === 'result' || message.type === 'error') {
          active.delete(child);
          if (message.type === 'result') {
            dispatchedAtFirstCompletion ??= [...tasksByPid.values()].flat().length;
            completionOrder.push(tracePath);
          }
        }
      });
      child.on('close', () => active.delete(child));
      onChild?.(child);
      return child;
    });
  });

  afterEach(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
        child.kill('SIGTERM');
        await closed;
      }
    }
    jest.restoreAllMocks();
    await cleanupSyntheticReportFixture(fixture);
    await fs.promises.rm(outputDir, { recursive: true, force: true });
  });

  async function writeMetadata(): Promise<void> {
    const zip = new AdmZip();
    zip.addFile('report.json', Buffer.from(JSON.stringify(metadata)));
    await fs.promises.writeFile(
      path.join(fixture.rootDir, 'index.html'),
      `<template id="playwrightReportBase64">data:application/zip;base64,${zip.toBuffer().toString('base64')}</template>`,
    );
  }

  async function addCollidingFailures(count: number): Promise<void> {
    const template = metadata.files[0]!.tests.find(test => test.testId === 'peer-failure-test')!;
    for (let index = 0; index < count; index++) {
      const test = structuredClone(template);
      test.testId = `peer-copy-${index}`;
      test.projectName = `project-${index}`;
      test.results[0]!.attachments[0]!.path = `data/trace-peer-copy-${index}.zip`;
      metadata.files[0]!.tests.push(test);
      await fs.promises.copyFile(
        path.join(fixture.dataDir, `${fixture.traces.failedPeer.sha1}.zip`),
        path.join(fixture.dataDir, `trace-peer-copy-${index}.zip`),
      );
    }
    await writeMetadata();
  }

  async function assertWorkersClosed(): Promise<void> {
    expect(active.size).toBe(0);
    for (const child of children) {
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      expect(child.connected).toBe(false);
    }
    const leases = await fs.promises.readdir(path.join(getTraceCacheRoot(), '.leases'));
    expect(leases.filter(lease => children.some(child => lease.startsWith(`${child.pid}-`)))).toEqual([]);
  }

  test.each([3, 4, 5])('%s workers produce exactly the serial files, retry records, ordering, and collision suffixes', async workers => {
    await addCollidingFailures(8);
    const before = await fileHashes(fixture.rootDir);
    const serial = await writeFailureDigests(fixture.dataDir, path.join(outputDir, 'serial'), { workers: 1 });
    expect(forkSpy).not.toHaveBeenCalled();
    const parallel = await writeFailureDigests(fixture.dataDir, path.join(outputDir, 'parallel'), { workers });
    expect(parallel.failures).toEqual(serial.failures);
    expect(parallel.count).toBe(serial.count);
    expect(await fileHashes(parallel.runDir, true)).toEqual(await fileHashes(serial.runDir, true));
    expect(await fileHashes(fixture.rootDir)).toEqual(before);
    expect(children).toHaveLength(workers);
    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(workers);
    expect([...tasksByPid.values()].flat()).toHaveLength(13);
    expect(dispatchedAtFirstCompletion).toBeLessThanOrEqual(workers);
    expect([...tasksByPid.values()].some(tasks => tasks.length > 1)).toBe(true);
    expect((await fs.promises.readdir(parallel.runDir)).some(name => name.startsWith('.attempt-'))).toBe(false);
    await assertWorkersClosed();
  });

  test('the CLI defaults to four real processes without changing its JSON contract', async () => {
    await addCollidingFailures(6);
    let stdout = '';
    let stderr = '';
    const code = await runCli(['failures', fixture.rootDir, outputDir], {
      stdout: value => { stdout += value; },
      stderr: value => { stderr += value; },
    });
    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(children).toHaveLength(4);
    const manifest = JSON.parse(stdout);
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.count).toBe(11);
    expect(JSON.parse(await fs.promises.readFile(path.join(manifest.runDir, 'index.json'), 'utf8'))).toEqual(manifest);
    await assertWorkersClosed();
  });

  test('out-of-order completion cannot change folder naming or manifest order', async () => {
    await addCollidingFailures(6);
    const serial = await writeFailureDigests(fixture.dataDir, path.join(outputDir, 'serial'), { workers: 1 });
    delayFirstTask = true;
    const parallel = await writeFailureDigests(fixture.dataDir, path.join(outputDir, 'parallel'), { workers: 4 });
    expect(path.basename(completionOrder[0]!)).not.toBe(`${serial.failures[0]!.traceSha1}.zip`);
    expect(parallel.failures).toEqual(serial.failures);
    expect(await fileHashes(parallel.runDir, true)).toEqual(await fileHashes(serial.runDir, true));
    await assertWorkersClosed();
  });

  test('all passing traces launch no workers; a single candidate launches only one', async () => {
    for (const test of metadata.files[0]!.tests)
      for (const result of test.results)
        result.status = 'passed';
    await writeMetadata();
    const empty = await writeFailureDigests(fixture.dataDir, outputDir);
    expect(empty.count).toBe(0);
    expect(children).toHaveLength(0);
    metadata.files[0]!.tests.find(test => test.testId === 'child-only-failure-test')!.results[0]!.status = 'failed';
    await writeMetadata();
    const one = await writeFailureDigests(fixture.dataDir, outputDir);
    expect(one.failures.map(entry => entry.traceSha1)).toEqual([fixture.traces.childOnlyFailure.sha1]);
    expect(children).toHaveLength(1);
    await assertWorkersClosed();
  });

  test('500 known-passing ZIPs never enter the parallel work queue', async () => {
    const template = metadata.files[0]!.tests.find(test => test.testId === 'passing-test')!;
    for (let index = 0; index < 500; index++) {
      const test = structuredClone(template);
      test.testId = `passing-${index}`;
      test.results[0]!.attachments[0]!.path = `data/passing-${index}.zip`;
      metadata.files[0]!.tests.push(test);
      await fs.promises.writeFile(path.join(fixture.dataDir, `passing-${index}.zip`), 'must not open');
    }
    await writeMetadata();
    const manifest = await writeFailureDigests(fixture.dataDir, outputDir);
    expect(manifest.count).toBe(5);
    expect([...tasksByPid.values()].flat().map(file => path.basename(file)).sort()).toEqual(
      Object.values(fixture.traces).filter(trace => trace !== fixture.traces.passed).map(trace => `${trace.sha1}.zip`).sort(),
    );
    await assertWorkersClosed();
  });

  test('parallel workers retain failed retries, timeouts, interruptions, and expected failures', async () => {
    const tests = metadata.files[0]!.tests;
    const retry = tests.find(test => test.testId === 'retry-test')!;
    retry.outcome = 'flaky';
    retry.ok = true;
    retry.results[0]!.status = 'timedOut';
    retry.results[1]!.status = 'interrupted';
    retry.results.push(tests.find(test => test.testId === 'passing-test')!.results[0]!);
    metadata.files[0]!.tests = tests.filter(test => test.testId !== 'passing-test');
    const childOnly = tests.find(test => test.testId === 'child-only-failure-test')!;
    childOnly.outcome = 'expected';
    childOnly.ok = true;
    await writeMetadata();
    const serial = await writeFailureDigests(fixture.dataDir, path.join(outputDir, 'serial'), { workers: 1, excludeSkipped: true });
    const parallel = await writeFailureDigests(fixture.dataDir, path.join(outputDir, 'parallel'), { workers: 4, excludeSkipped: true });
    expect(parallel.failures).toEqual(serial.failures);
    expect(parallel.count).toBe(4);
    expect(parallel.failures.filter(entry => entry.outcome === 'flaky').map(entry => entry.retryIndex).sort()).toEqual([0, 1]);
    await assertWorkersClosed();
  });

  test('concurrent runs safely share a cold cache and never share output directories', async () => {
    const zipPath = path.join(fixture.dataDir, `${fixture.traces.failedPeer.sha1}.zip`);
    const zip = new AdmZip(zipPath);
    zip.addFile('unique-marker', Buffer.from(crypto.randomUUID()));
    zip.writeZip(zipPath);
    const [left, right] = await Promise.all([
      writeFailureDigests(fixture.dataDir, outputDir, { workers: 3 }),
      writeFailureDigests(fixture.dataDir, outputDir, { workers: 3 }),
    ]);
    expect(left.runDir).not.toBe(right.runDir);
    expect(left.failures).toEqual(right.failures);
    expect(await fileHashes(left.runDir, true)).toEqual(await fileHashes(right.runDir, true));
    await assertWorkersClosed();
  });

  test('worker extraction errors drain active jobs and remove only the failed run', async () => {
    await addCollidingFailures(12);
    const existing = await writeFailureDigests(fixture.dataDir, outputDir, { workers: 1 });
    const before = await fileHashes(existing.runDir);
    const failedArchive = path.join(fixture.dataDir, `${fixture.traces.failedEarlierZip.sha1}.zip`);
    await fs.promises.writeFile(failedArchive, 'broken zip');
    await expect(writeFailureDigests(fixture.dataDir, outputDir)).rejects.toThrow(failedArchive);
    await assertWorkersClosed();
    expect(await fs.promises.readdir(outputDir)).toEqual([path.basename(existing.runDir)]);
    expect(await fileHashes(existing.runDir)).toEqual(before);
  });

  test('unexpected worker exit rejects, drains surviving workers, and removes unpublished output', async () => {
    let killed = false;
    onChild = child => {
      child.on('message', (message: FailureWorkerResponse) => {
        if (!killed && message.type === 'ready') {
          killed = true;
          child.kill('SIGTERM');
        }
      });
    };
    await expect(writeFailureDigests(fixture.dataDir, outputDir)).rejects.toThrow(/worker|EPIPE|closed/i);
    expect(killed).toBe(true);
    expect(active.size).toBe(0);
    expect(children.every(child => child.exitCode !== null || child.signalCode !== null)).toBe(true);
    expect(await fs.promises.readdir(outputDir)).toEqual([]);
  });

  test('synchronous worker startup errors clean the run without starting more workers', async () => {
    forkSpy.mockImplementation(() => { throw new Error('simulated fork failure'); });
    await expect(writeFailureDigests(fixture.dataDir, outputDir)).rejects.toThrow('simulated fork failure');
    expect(await fs.promises.readdir(outputDir)).toEqual([]);
    expect(forkSpy).toHaveBeenCalledTimes(1);
  });

  test('asynchronous process spawn failures reject and clean the unpublished run', async () => {
    forkSpy.mockRestore();
    const realFork = childProcess.fork;
    forkSpy = jest.spyOn(childProcess, 'fork').mockImplementation((modulePath, args, options) =>
      realFork(modulePath, args ?? [], { ...options, execPath: path.join(outputDir, 'missing-node') }),
    );
    await expect(writeFailureDigests(fixture.dataDir, outputDir)).rejects.toThrow('ENOENT');
    expect(await fs.promises.readdir(outputDir)).toEqual([]);
  });

  test.each([0, -1, 1.5, 6, NaN, Infinity])('rejects invalid worker count %s before creating output', async workers => {
    await expect(writeFailureDigests(fixture.dataDir, outputDir, { workers })).rejects.toThrow('integer from 1 to 5');
    expect(forkSpy).not.toHaveBeenCalled();
    expect(await fs.promises.readdir(outputDir)).toEqual([]);
  });

  test('CLI worker overrides are honored and invalid values emit no success JSON', async () => {
    for (const value of ['1', '3', '0', '6', '1.5', 'many']) {
      children = [];
      let stdout = '';
      let stderr = '';
      const code = await runCli(['failures', fixture.rootDir, outputDir, '--workers', value], {
        stdout: text => { stdout += text; },
        stderr: text => { stderr += text; },
      });
      if (value === '1' || value === '3') {
        expect(code).toBe(0);
        expect(JSON.parse(stdout).count).toBe(5);
        expect(children).toHaveLength(value === '1' ? 0 : 3);
        await assertWorkersClosed();
      } else {
        expect(code).toBe(1);
        expect(stdout).toBe('');
        expect(stderr).toContain('integer from 1 to 5');
      }
    }
  });
});
