import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  extractScreenshots,
  getDomSnapshots,
  getFailedTestSummaries,
  getNetworkTraffic,
  getReportMetadata,
  getSummary,
  getTestSteps,
  getTestTitle,
  getTimeline,
  getTopLevelFailures,
  listTraces,
  prepareTraceDir,
} from '../src/index';
import {
  cleanupSyntheticReportFixture,
  createSyntheticReportFixture,
  type SyntheticReportFixture,
} from './syntheticReport';

jest.setTimeout(20000);

describe('playwright-traces-reader sanity', () => {
  let fixture: SyntheticReportFixture;

  beforeAll(async () => {
    fixture = await createSyntheticReportFixture();
  });

  afterAll(async () => {
    await cleanupSyntheticReportFixture(fixture);
  });

  test('prepareTraceDir resolves both directory and zip traces', async () => {
    const [dirCtx, zipCtx] = await Promise.all([
      prepareTraceDir(fixture.traces.failedLatest.tracePath),
      prepareTraceDir(fixture.traces.failedEarlierZip.tracePath),
    ]);

    expect(fs.existsSync(path.join(dirCtx.traceDir, 'test.trace'))).toBe(true);
    expect(fs.existsSync(path.join(zipCtx.traceDir, 'test.trace'))).toBe(true);
  });

  test('listTraces includes extracted and zip-only traces while ignoring unrelated files', async () => {
    const traces = await listTraces(fixture.dataDir);
    const traceNames = traces.map(trace => path.basename(trace.traceDir)).sort();

    expect(traceNames).toEqual([
      fixture.traces.failedEarlierZip.sha1,
      fixture.traces.failedLatest.sha1,
      fixture.traces.passed.sha1,
      fixture.traces.skipped.sha1,
    ].sort());
  });

  test('getTestSteps reconstructs hooks and nested test steps', async () => {
    const ctx = await prepareTraceDir(fixture.traces.failedLatest.tracePath);
    const steps = await getTestSteps(ctx);

    expect(steps.length).toBe(2);
    expect(steps[0]!.title).toBe('Before Hooks');
    expect(steps[1]!.title).toBe(fixture.traces.failedLatest.rootTitle);
    expect(steps[1]!.children).toHaveLength(1);
    expect(steps[1]!.children[0]!.title).toBe('Verify failure state');
  });

  test('getTopLevelFailures returns only failed root steps', async () => {
    const ctx = await prepareTraceDir(fixture.traces.failedLatest.tracePath);
    const failures = await getTopLevelFailures(ctx);

    expect(failures).toHaveLength(1);
    expect(failures[0]!.title).toBe(fixture.traces.failedLatest.rootTitle);
    expect(failures[0]!.error?.message).toContain('Synthetic failure');
  });

  test('getNetworkTraffic separates browser and api entries and resolves bodies', async () => {
    const ctx = await prepareTraceDir(fixture.traces.failedLatest.tracePath);
    const traffic = await getNetworkTraffic(ctx);

    expect(traffic).toHaveLength(2);
    expect(traffic.some(entry => entry.source === 'browser')).toBe(true);
    expect(traffic.some(entry => entry.source === 'api')).toBe(true);
    expect(traffic.find(entry => entry.source === 'api')!.responseBody).toContain('trace-fail-latest');
  });

  test('extractScreenshots writes image files to disk', async () => {
    const ctx = await prepareTraceDir(fixture.traces.failedLatest.tracePath);
    const outDir = path.join(os.tmpdir(), 'pw-traces-reader-screenshots', Date.now().toString());

    try {
      const screenshots = await extractScreenshots(ctx, outDir);
      expect(screenshots).toHaveLength(1);
      expect(fs.existsSync(screenshots[0]!.savedPath)).toBe(true);
    } finally {
      await fs.promises.rm(outDir, { recursive: true, force: true });
    }
  });

  test('getDomSnapshots returns before, action, and after snapshots with a target element', async () => {
    const ctx = await prepareTraceDir(fixture.traces.failedLatest.tracePath);
    const snapshots = await getDomSnapshots(ctx);

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.callId).toBe(fixture.traces.failedLatest.rootCallId);
    expect(snapshots[0]!.before?.html).toContain('Before submit');
    expect(snapshots[0]!.action?.html).toContain('Submitting');
    expect(snapshots[0]!.after?.html).toContain('Submission failed');
    expect(snapshots[0]!.before?.targetElement).toBe(fixture.traces.failedLatest.rootCallId);
  });

  test('getDomSnapshots options filter by phase and location', async () => {
    const ctx = await prepareTraceDir(fixture.traces.failedLatest.tracePath);
    const [afterOnly, nearCall] = await Promise.all([
      getDomSnapshots(ctx, { phase: 'after' }),
      getDomSnapshots(ctx, { near: fixture.traces.failedLatest.rootCallId, limit: 1 }),
    ]);

    expect(afterOnly).toHaveLength(1);
    expect(afterOnly[0]!.before).toBeNull();
    expect(afterOnly[0]!.action).toBeNull();
    expect(afterOnly[0]!.after?.html).toContain('Submission failed');
    expect(nearCall).toHaveLength(1);
    expect(nearCall[0]!.callId).toBe(fixture.traces.failedLatest.rootCallId);
  });

  test('getTimeline merges all event types in chronological order', async () => {
    const ctx = await prepareTraceDir(fixture.traces.failedLatest.tracePath);
    const timeline = await getTimeline(ctx);

    expect(timeline.some(entry => entry.type === 'step')).toBe(true);
    expect(timeline.some(entry => entry.type === 'network')).toBe(true);
    expect(timeline.some(entry => entry.type === 'dom')).toBe(true);
    expect(timeline.some(entry => entry.type === 'screenshot')).toBe(true);

    for (let index = 1; index < timeline.length; index++) {
      expect(timeline[index]!.timestamp).toBeGreaterThanOrEqual(timeline[index - 1]!.timestamp);
    }
  });

  test('getTestTitle returns the full synthetic Playwright title', async () => {
    const ctx = await prepareTraceDir(fixture.traces.failedLatest.tracePath);
    const title = await getTestTitle(ctx);

    expect(title).toBe(fixture.traces.failedLatest.fullTitle);
    expect(title).toContain(' › ');
  });

  test('getSummary returns failure details and excludes hook roots from topLevelSteps', async () => {
    const ctx = await prepareTraceDir(fixture.traces.failedLatest.tracePath);
    const reportMetadata = await getReportMetadata(fixture.rootDir);
    const summary = await getSummary(ctx, { reportMetadata });

    expect(summary.status).toBe('failed');
    expect(summary.outcome).toBe('unexpected');
    expect(summary.title).toBe(fixture.traces.failedLatest.rootTitle);
    expect(summary.topLevelSteps).toHaveLength(1);
    expect(summary.topLevelSteps[0]!.title).toBe(fixture.traces.failedLatest.rootTitle);
    expect(summary.failureDomSnapshot?.callId).toBe(fixture.traces.failedLatest.rootCallId);
  });

  test('getSummary returns passed status and no failure DOM for successful traces', async () => {
    const ctx = await prepareTraceDir(fixture.traces.passed.tracePath);
    const reportMetadata = await getReportMetadata(fixture.rootDir);
    const summary = await getSummary(ctx, { reportMetadata });

    expect(summary.status).toBe('passed');
    expect(summary.outcome).toBe('expected');
    expect(summary.error).toBeNull();
    expect(summary.failureDomSnapshot).toBeNull();
  });

  test('getFailedTestSummaries keeps the latest retry and can exclude skipped outcomes', async () => {
    const allFailures = await getFailedTestSummaries(fixture.dataDir);
    const unexpectedOnly = await getFailedTestSummaries(fixture.dataDir, { excludeSkipped: true });

    expect(allFailures).toHaveLength(2);
    expect(allFailures.some(summary => summary.outcome === 'skipped')).toBe(true);
    expect(allFailures.some(summary => summary.title === fixture.traces.failedLatest.rootTitle)).toBe(true);

    expect(unexpectedOnly).toHaveLength(1);
    expect(unexpectedOnly[0]!.outcome).toBe('unexpected');
    expect(unexpectedOnly[0]!.title).toBe(fixture.traces.failedLatest.rootTitle);
  });
});