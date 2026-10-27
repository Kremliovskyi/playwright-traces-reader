import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { runCli } from '../dist/cli';
import { writeFailureDigests as writeDigests, type FailureDigestOptions } from '../dist/failureDigest';
import { getReportMetadata, listTraces, type ReportMetadata } from '../src/parseTrace';
import {
  cleanupSyntheticReportFixture,
  createSyntheticReportFixture,
  type SyntheticReportFixture,
} from './syntheticReport';

const writeFailureDigests = (dataDir: string, outputDir: string, options?: FailureDigestOptions) =>
  writeDigests(dataDir, outputDir, { ...options, workers: 1 });

async function artifactHashes(directory: string): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  async function visit(relative: string): Promise<void> {
    for (const entry of await fs.promises.readdir(path.join(directory, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        await visit(name);
      } else if (name !== 'index.json') {
        hashes[name] = crypto.createHash('sha256')
          .update(await fs.promises.readFile(path.join(directory, name)))
          .digest('hex');
      }
    }
  }
  await visit('');
  return hashes;
}

describe('conservative failure preparation', () => {
  let fixture: SyntheticReportFixture;
  let outputDir: string;
  let metadata: ReportMetadata;
  let reads: jest.SpyInstance;

  beforeEach(async () => {
    fixture = await createSyntheticReportFixture();
    outputDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pwtr-failure-filter-'));
    const report = await getReportMetadata(fixture.rootDir);
    if (!report) throw new Error('Synthetic report metadata is missing');
    metadata = report;
    reads = jest.spyOn(fs.promises, 'readFile');
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await cleanupSyntheticReportFixture(fixture);
    await fs.promises.rm(outputDir, { recursive: true, force: true });
  });

  function testById(id: string) {
    const test = metadata.files.flatMap(file => file.tests).find(test => test.testId === id);
    if (!test) throw new Error(`Synthetic test not found: ${id}`);
    return test;
  }

  async function writeMetadata(details: ReportMetadata['files'] = []): Promise<void> {
    const zip = new AdmZip();
    zip.addFile('report.json', Buffer.from(JSON.stringify(metadata)));
    for (const file of details)
      zip.addFile(`${file.fileId}.json`, Buffer.from(JSON.stringify(file)));
    await fs.promises.writeFile(
      path.join(fixture.rootDir, 'index.html'),
      `<template id="playwrightReportBase64">data:application/zip;base64,${zip.toBuffer().toString('base64')}</template>`,
    );
  }

  function archiveWasRead(sha1: string): boolean {
    return reads.mock.calls.some(([file]) => file === path.join(fixture.dataDir, `${sha1}.zip`));
  }

  test('does not open known-passing ZIPs, but prepares every failed and skipped attempt', async () => {
    const manifest = await writeFailureDigests(fixture.dataDir, outputDir);
    expect(manifest.count).toBe(5);
    expect(archiveWasRead(fixture.traces.passed.sha1)).toBe(false);
    for (const trace of Object.values(fixture.traces).filter(trace => trace !== fixture.traces.passed)) {
      expect(archiveWasRead(trace.sha1)).toBe(true);
      expect(manifest.failures.some(entry => entry.traceSha1 === trace.sha1)).toBe(true);
    }
  });

  test('does not open any of 500 additional passing archives or lose the failed attempts', async () => {
    const passingTest = testById('passing-test');
    for (let index = 0; index < 500; index++) {
      const test = structuredClone(passingTest);
      test.testId = `passing-${index}`;
      test.results[0]!.attachments[0]!.path = `data/passing-${index}.zip`;
      metadata.files[0]!.tests.push(test);
      await fs.promises.writeFile(path.join(fixture.dataDir, `passing-${index}.zip`), 'must not be opened');
    }
    await writeMetadata();
    const manifest = await writeFailureDigests(fixture.dataDir, outputDir);
    expect(manifest.failures.map(entry => entry.traceSha1).sort()).toEqual(
      Object.values(fixture.traces)
        .filter(trace => trace !== fixture.traces.passed)
        .map(trace => trace.sha1)
        .sort(),
    );
    const archiveReads = reads.mock.calls.filter(([file]) => typeof file === 'string' && file.endsWith('.zip'));
    expect(archiveReads).toHaveLength(5);
  });

  test('keeps failure manifests and every evidence file identical to the legacy unfiltered preparation path', async () => {
    const legacy = structuredClone(metadata);
    for (const file of metadata.files)
      for (const test of file.tests)
        for (const result of test.results)
          delete result.status;
    await writeMetadata();
    const baseline = await writeFailureDigests(fixture.dataDir, path.join(outputDir, 'legacy'));
    expect(archiveWasRead(fixture.traces.passed.sha1)).toBe(true);

    metadata = legacy;
    await writeMetadata();
    reads.mockClear();
    const optimized = await writeFailureDigests(fixture.dataDir, path.join(outputDir, 'optimized'));
    expect(archiveWasRead(fixture.traces.passed.sha1)).toBe(false);
    expect(optimized.failures).toEqual(baseline.failures);
    expect(optimized.count).toBe(baseline.count);
    expect(await artifactHashes(optimized.runDir)).toEqual(await artifactHashes(baseline.runDir));
  });

  test('a corrupt known-passing ZIP is not opened, while listTraces still prepares all traces', async () => {
    await fs.promises.writeFile(path.join(fixture.dataDir, `${fixture.traces.passed.sha1}.zip`), 'invalid zip');
    const manifest = await writeFailureDigests(fixture.dataDir, outputDir);
    expect(manifest.count).toBe(5);
    expect(archiveWasRead(fixture.traces.passed.sha1)).toBe(false);
    await expect(listTraces(fixture.dataDir)).rejects.toThrow();
    expect(archiveWasRead(fixture.traces.passed.sha1)).toBe(true);
  });

  test('also skips known-passing extracted directories without validating their trace contents', async () => {
    await fs.promises.unlink(path.join(fixture.dataDir, `${fixture.traces.passed.sha1}.zip`));
    await fs.promises.writeFile(
      path.join(fixture.traces.passed.tracePath, '0-trace.trace'),
      '{"type":"context-options","version":999}\n',
    );
    const manifest = await writeFailureDigests(fixture.dataDir, outputDir);
    expect(manifest.count).toBe(5);
    await expect(listTraces(fixture.dataDir)).rejects.toThrow('newer than the maximum supported version');
  });

  test.each(['failed', 'timedOut', 'interrupted'])(
    'retains a child-only %s attempt even when its test outcome is expected and ok',
    async status => {
      const test = testById('child-only-failure-test');
      test.outcome = 'expected';
      test.ok = true;
      test.results[0]!.status = status;
      await writeMetadata();
      const manifest = await writeFailureDigests(fixture.dataDir, outputDir);
      expect(archiveWasRead(fixture.traces.childOnlyFailure.sha1)).toBe(true);
      expect(manifest.failures.some(entry => entry.traceSha1 === fixture.traces.childOnlyFailure.sha1)).toBe(true);
    },
  );

  test.each(['flaky', 'unexpected'] as const)(
    'selects individual attempts rather than the aggregate %s outcome',
    async outcome => {
      const retryTest = testById('retry-test');
      const passedResult = testById('passing-test').results[0]!;
      metadata.files[0]!.tests = metadata.files[0]!.tests.filter(test => test.testId !== 'passing-test');
      retryTest.outcome = outcome;
      retryTest.ok = outcome === 'flaky';
      if (outcome === 'flaky') retryTest.results.push(passedResult);
      else retryTest.results.unshift(passedResult);
      await writeMetadata();

      const manifest = await writeFailureDigests(fixture.dataDir, outputDir);
      const retries = manifest.failures.filter(entry =>
        [fixture.traces.failedEarlierZip.sha1, fixture.traces.failedLatest.sha1].includes(entry.traceSha1),
      );
      expect(retries.map(entry => entry.retryIndex).sort()).toEqual(outcome === 'flaky' ? [0, 1] : [1, 2]);
      expect(archiveWasRead(fixture.traces.passed.sha1)).toBe(false);
      expect(manifest.failures.some(entry => entry.traceSha1 === fixture.traces.passed.sha1)).toBe(false);
      expect(manifest.count).toBe(5);
    },
  );

  test.each([false, true])('preserves skipped-attempt handling with excludeSkipped=%s', async excludeSkipped => {
    const manifest = await writeFailureDigests(fixture.dataDir, outputDir, { excludeSkipped });
    expect(archiveWasRead(fixture.traces.skipped.sha1)).toBe(true);
    expect(manifest.failures.some(entry => entry.traceSha1 === fixture.traces.skipped.sha1)).toBe(!excludeSkipped);
    expect(manifest.count).toBe(excludeSkipped ? 4 : 5);
  });

  test('does not infer an early pass from legacy expected/ok metadata', async () => {
    delete testById('passing-test').results[0]!.status;
    await writeMetadata();
    const manifest = await writeFailureDigests(fixture.dataDir, outputDir);
    expect(archiveWasRead(fixture.traces.passed.sha1)).toBe(true);
    expect(manifest.count).toBe(5);
  });

  test('prepares unreferenced traces and retains their root-step failures', async () => {
    metadata.files[0]!.tests = metadata.files[0]!.tests.filter(test => test.testId !== 'peer-failure-test');
    await writeMetadata();
    const manifest = await writeFailureDigests(fixture.dataDir, outputDir);
    expect(archiveWasRead(fixture.traces.failedPeer.sha1)).toBe(true);
    expect(manifest.failures.some(entry => entry.traceSha1 === fixture.traces.failedPeer.sha1)).toBe(true);
  });

  test('prepares every trace when the report has no metadata', async () => {
    await fs.promises.unlink(path.join(fixture.rootDir, 'index.html'));
    const manifest = await writeFailureDigests(fixture.dataDir, outputDir);
    for (const trace of Object.values(fixture.traces))
      expect(archiveWasRead(trace.sha1)).toBe(true);
    expect(manifest.failures.some(entry => entry.traceSha1 === fixture.traces.failedEarlierZip.sha1)).toBe(true);
    expect(manifest.failures.some(entry => entry.traceSha1 === fixture.traces.failedPeer.sha1)).toBe(true);
  });

  test.each(['failed', 'missing', 'unreferenced'])(
    'does not hide a corrupt %s trace behind early filtering',
    async kind => {
      const test = testById('peer-failure-test');
      if (kind === 'missing') delete test.results[0]!.status;
      if (kind === 'unreferenced')
        metadata.files[0]!.tests = metadata.files[0]!.tests.filter(candidate => candidate !== test);
      await writeMetadata();
      await fs.promises.writeFile(path.join(fixture.dataDir, `${fixture.traces.failedPeer.sha1}.zip`), 'invalid zip');
      await expect(writeFailureDigests(fixture.dataDir, outputDir)).rejects.toThrow();
      expect(archiveWasRead(fixture.traces.failedPeer.sha1)).toBe(true);
    },
  );

  test('rejects unknown statuses explicitly instead of treating them as passed', async () => {
    testById('peer-failure-test').results[0]!.status = 'future-status';
    await writeMetadata();
    await expect(writeFailureDigests(fixture.dataDir, outputDir)).rejects.toThrow(
      'Unsupported result status "future-status" for trace "trace-fail-peer"',
    );
  });

  test.each([false, true])('rejects shared passed/failed trace references regardless of order (reverse=%s)', async reverse => {
    testById('passing-test').results[0]!.attachments[0]!.path = `data/${fixture.traces.failedPeer.sha1}.zip`;
    if (reverse) metadata.files[0]!.tests.reverse();
    await writeMetadata();
    await expect(writeFailureDigests(fixture.dataDir, outputDir)).rejects.toThrow(
      'Trace "trace-fail-peer" is referenced by multiple report attempts',
    );
  });

  test('keeps every trace attachment of a failed attempt', async () => {
    const childResult = testById('child-only-failure-test').results[0]!;
    testById('peer-failure-test').results[0]!.attachments.push(...childResult.attachments);
    metadata.files[0]!.tests = metadata.files[0]!.tests.filter(test => test.testId !== 'child-only-failure-test');
    await writeMetadata();
    const manifest = await writeFailureDigests(fixture.dataDir, outputDir);
    expect(manifest.failures.some(entry => entry.traceSha1 === fixture.traces.childOnlyFailure.sha1)).toBe(true);
    expect(manifest.failures.some(entry => entry.traceSha1 === fixture.traces.failedPeer.sha1)).toBe(true);
    expect(manifest.count).toBe(5);
  });

  test('uses the detailed HTML report attempt statuses before excluding a pass', async () => {
    const details = structuredClone(metadata.files);
    for (const file of metadata.files)
      for (const test of file.tests)
        for (const result of test.results)
          delete result.status;
    await writeMetadata(details);
    const manifest = await writeFailureDigests(fixture.dataDir, outputDir);
    expect(archiveWasRead(fixture.traces.passed.sha1)).toBe(false);
    expect(manifest.count).toBe(5);
  });

  test('surfaces conflicting summary/detail statuses through the CLI instead of emitting a success manifest', async () => {
    const details = structuredClone(metadata.files);
    details[0]!.tests.find(test => test.testId === 'child-only-failure-test')!.results[0]!.status = 'passed';
    await writeMetadata(details);
    let stdout = '';
    let stderr = '';
    const exitCode = await runCli(['failures', fixture.rootDir, outputDir], {
      stdout: text => { stdout += text; },
      stderr: text => { stderr += text; },
    });
    expect(exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('Conflicting result statuses');
    expect(stderr).toContain('child-only-failure-test');
  });

  test('rejects mismatched detail trace attachments rather than borrowing another attempt status', async () => {
    const details = structuredClone(metadata.files);
    details[0]!.tests.find(test => test.testId === 'child-only-failure-test')!.results[0] =
      structuredClone(testById('passing-test').results[0]!);
    await writeMetadata(details);
    await expect(writeFailureDigests(fixture.dataDir, outputDir)).rejects.toThrow(
      'Trace attachments disagree',
    );
  });

  test('does not merge failures with identical titles in different projects', async () => {
    const other = structuredClone(testById('peer-failure-test'));
    other.testId = 'other-project-failure';
    other.projectName = 'other-project';
    other.results[0]!.attachments[0]!.path = 'data/trace-other-project.zip';
    metadata.files[0]!.tests.push(other);
    await fs.promises.copyFile(
      path.join(fixture.dataDir, `${fixture.traces.failedPeer.sha1}.zip`),
      path.join(fixture.dataDir, 'trace-other-project.zip'),
    );
    await writeMetadata();
    const manifest = await writeFailureDigests(fixture.dataDir, outputDir);
    const peers = manifest.failures.filter(entry =>
      [fixture.traces.failedPeer.sha1, 'trace-other-project'].includes(entry.traceSha1),
    );
    expect(peers).toHaveLength(2);
    expect(new Set(peers.map(entry => entry.folder)).size).toBe(2);
    expect(manifest.count).toBe(6);
  });
});
