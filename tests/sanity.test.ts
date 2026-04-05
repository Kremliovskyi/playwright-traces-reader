import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  extractAttachment,
  extractScreenshots,
  getAttachments,
  getConsoleEntries,
  getDomSnapshots,
  getFailedTestSummaries,
  getNetworkTraffic,
  getNetworkRequest,
  getReportFailurePatterns,
  getReportMetadata,
  getSummary,
  getTestSteps,
  getTestTitle,
  getTimeline,
  getTraceIssues,
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
      fixture.traces.failedPeer.sha1,
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
    expect(traffic.every(entry => entry.relatedAction?.callId === fixture.traces.failedLatest.rootCallId)).toBe(true);
  });

  test('getNetworkTraffic supports filtering and getNetworkRequest returns one request by id', async () => {
    const ctx = await prepareTraceDir(fixture.traces.failedLatest.tracePath);
    const filtered = await getNetworkTraffic(ctx, {
      source: 'api',
      near: fixture.traces.failedLatest.rootCallId,
    });

    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.source).toBe('api');

    const request = await getNetworkRequest(ctx, filtered[0]!.id);
    expect(request.url).toContain('/api-call');
    expect(request.relatedAction?.callId).toBe(fixture.traces.failedLatest.rootCallId);
  });

  test('getConsoleEntries returns browser console, page errors, and stdio entries', async () => {
    const ctx = await prepareTraceDir(fixture.traces.failedLatest.tracePath);
    const entries = await getConsoleEntries(ctx);

    expect(entries.some(entry => entry.source === 'browser' && entry.level === 'info')).toBe(true);
    expect(entries.some(entry => entry.source === 'browser' && entry.text.includes('page error'))).toBe(true);
    expect(entries.some(entry => entry.source === 'stdout')).toBe(true);
    expect(entries.some(entry => entry.source === 'stderr')).toBe(true);
  });

  test('getTraceIssues combines step failures, page errors, and trace-level errors', async () => {
    const ctx = await prepareTraceDir(fixture.traces.failedLatest.tracePath);
    const issues = await getTraceIssues(ctx);

    expect(issues.some(issue => issue.source === 'step' && issue.title === fixture.traces.failedLatest.rootTitle)).toBe(true);
    expect(issues.some(issue => issue.source === 'page' && issue.message.includes('page error') && issue.relatedAction?.callId === fixture.traces.failedLatest.rootCallId)).toBe(true);
    expect(issues.some(issue => issue.source === 'trace' && issue.message.includes('trace error'))).toBe(true);
  });

  test('getAttachments lists attachments and extractAttachment writes one to disk', async () => {
    const ctx = await prepareTraceDir(fixture.traces.failedLatest.tracePath);
    const attachments = await getAttachments(ctx);
    const outPath = path.join(os.tmpdir(), 'pw-traces-reader-attachment', `${Date.now()}.txt`);

    try {
      expect(attachments).toHaveLength(1);
      expect(attachments[0]!.actionTitle).toBe(fixture.traces.failedLatest.rootTitle);

      const saved = await extractAttachment(ctx, attachments[0]!.id, outPath);
      expect(saved.savedPath).toBe(outPath);
      expect(fs.existsSync(saved.savedPath)).toBe(true);
      expect(await fs.promises.readFile(saved.savedPath, 'utf8')).toContain('trace-fail-latest');
    } finally {
      await fs.promises.rm(path.dirname(outPath), { recursive: true, force: true });
    }
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
    expect(summary.issues.some(issue => issue.relatedAction?.callId === fixture.traces.failedLatest.rootCallId)).toBe(true);
    expect(summary.actionDiagnostics[0]!.action.callId).toBe(fixture.traces.failedLatest.rootCallId);
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

    expect(allFailures).toHaveLength(3);
    expect(allFailures.some(summary => summary.outcome === 'skipped')).toBe(true);
    expect(allFailures.some(summary => summary.title === fixture.traces.failedLatest.rootTitle)).toBe(true);
    expect(allFailures.some(summary => summary.title === fixture.traces.failedPeer.rootTitle)).toBe(true);

    expect(unexpectedOnly).toHaveLength(2);
    expect(unexpectedOnly.every(summary => summary.outcome === 'unexpected')).toBe(true);
    expect(unexpectedOnly.some(summary => summary.title === fixture.traces.failedLatest.rootTitle)).toBe(true);
    expect(unexpectedOnly.some(summary => summary.title === fixture.traces.failedPeer.rootTitle)).toBe(true);
  });

  test('getReportFailurePatterns groups repeated failing requests and correlated issues across unique failures', async () => {
    const patterns = await getReportFailurePatterns(fixture.dataDir, { excludeSkipped: true });

    expect(patterns.repeatedFailingRequests.some(pattern => pattern.signature === 'GET /:id/browser-call' && pattern.count === 2)).toBe(true);
    expect(patterns.repeatedFailingRequests.some(pattern => pattern.signature === 'POST /:id/api-call' && pattern.count === 2)).toBe(true);
    expect(patterns.repeatedIssues.some(pattern => pattern.source === 'page' && pattern.count === 2)).toBe(true);
  });
});