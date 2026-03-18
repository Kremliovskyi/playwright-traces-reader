import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import {
  prepareTraceDir,
  listTraces,
  getTopLevelFailures,
  getTestTitle,
  getTestSteps,
  getNetworkTraffic,
  extractScreenshots,
  getDomSnapshots,
  getTimeline,
  getSummary,
  getFailedTestSummaries,
} from '../src/index';

// Three different report data dirs — each currently has exactly one SHA1 trace.
const REPORT_A_DATA = path.resolve(__dirname, '../../sc-tests/playwright-report 3/data');
const REPORT_B_DATA = path.resolve(__dirname, '../../sc-tests/playwright-report/data');
const REPORT_C_DATA = path.resolve(__dirname, '../../sc-tests/playwright-report 2/data');

const TRACE_DIR = path.resolve(__dirname, '../../sc-tests/playwright-report 3/data/68e5ae746c4743054736c07b48a5f44e7eb65526');
const TRACE_ZIP = path.resolve(__dirname, '../../sc-tests/playwright-report 3/data/68e5ae746c4743054736c07b48a5f44e7eb65526.zip');

// Use the already-extracted directory if available, otherwise the zip
const tracePath = fs.existsSync(TRACE_DIR) ? TRACE_DIR : TRACE_ZIP;

describe('playwright-traces-reader sanity', () => {
  let ctx: Awaited<ReturnType<typeof prepareTraceDir>>;

  beforeAll(async () => {
    ctx = await prepareTraceDir(tracePath);
  });

  test('prepareTraceDir resolves to a valid directory', () => {
    expect(ctx.traceDir).toBeTruthy();
    expect(fs.existsSync(ctx.traceDir)).toBe(true);
    const testTrace = path.join(ctx.traceDir, 'test.trace');
    expect(fs.existsSync(testTrace)).toBe(true);
  });

  test('getTestSteps returns a non-empty step tree with durations', async () => {
    const steps = await getTestSteps(ctx);
    expect(steps.length).toBeGreaterThan(0);

    // At least some steps should have computed durations
    function flatten(ss: typeof steps): typeof steps {
      return ss.flatMap(s => [s, ...flatten(s.children)]);
    }
    const all = flatten(steps);
    const withDuration = all.filter(s => s.durationMs !== null);
    expect(withDuration.length).toBeGreaterThan(0);
  });

  test('getNetworkTraffic resolves response bodies from resources/', async () => {
    const traffic = await getNetworkTraffic(ctx);
    expect(traffic.length).toBeGreaterThan(0);

    // Expect at least one entry with a resolved JSON response body
    const jsonEntry = traffic.find(e => e.mimeType.includes('json') && e.responseBody !== null);
    expect(jsonEntry).toBeDefined();
    if (jsonEntry?.responseBody) {
      expect(() => JSON.parse(jsonEntry.responseBody!)).not.toThrow();
    }
  });

  test('getNetworkTraffic separates browser and api traffic', async () => {
    const traffic = await getNetworkTraffic(ctx);
    const apiTraffic = traffic.filter(e => e.source === 'api');
    const browserTraffic = traffic.filter(e => e.source === 'browser');

    // This trace has both browser and API traffic
    expect(apiTraffic.length).toBeGreaterThan(0);
    expect(browserTraffic.length).toBeGreaterThan(0);
  });

  test('extractScreenshots saves .jpeg files to the output directory', async () => {
    const outDir = path.join(os.tmpdir(), 'pw-screenshots-sanity-test', Date.now().toString());
    const screenshots = await extractScreenshots(ctx, outDir);

    expect(screenshots.length).toBeGreaterThan(0);

    for (const s of screenshots) {
      expect(fs.existsSync(s.savedPath)).toBe(true);
      const stat = fs.statSync(s.savedPath);
      expect(stat.size).toBeGreaterThan(0);
    }

    // Cleanup
    await fs.promises.rm(outDir, { recursive: true, force: true });
  });

  test('getDomSnapshots returns before/action/after snapshots for browser actions', async () => {
    const snapshots = await getDomSnapshots(ctx);

    // This trace has browser UI interactions, so we expect DOM snapshots
    expect(snapshots.length).toBeGreaterThan(0);

    // Every entry must have a callId
    for (const s of snapshots) {
      expect(s.callId).toBeTruthy();
    }

    // At least some entries should have a "before" phase (always recorded)
    const withBefore = snapshots.filter(s => s.before !== null);
    expect(withBefore.length).toBeGreaterThan(0);

    // At least some should have an "after" phase
    const withAfter = snapshots.filter(s => s.after !== null);
    expect(withAfter.length).toBeGreaterThan(0);

    // HTML should be a non-empty string
    const first = withBefore[0]!;
    expect(typeof first.before!.html).toBe('string');
    expect(first.before!.html.length).toBeGreaterThan(0);
    expect(first.before!.html).toContain('<');
  });

  test('getDomSnapshot HTML contains real page content (not just blank)', async () => {
    const snapshots = await getDomSnapshots(ctx);

    // Find a snapshot with a real page URL (not about:blank)
    const realPage = snapshots.find(
      s => (s.before?.frameUrl ?? '').startsWith('https://')
    );
    expect(realPage).toBeDefined();

    const html = realPage!.before!.html;
    // Should contain HTML elements
    expect(html).toMatch(/<(html|body|div|button|input)/i);
  });

  test('getDomSnapshot targetElement links to callId on interacted element', async () => {
    const snapshots = await getDomSnapshots(ctx);

    // At least one snapshot should record the targeted element (click/fill/etc)
    const withTarget = snapshots.filter(
      s => s.before?.targetElement !== null || s.after?.targetElement !== null
    );
    expect(withTarget.length).toBeGreaterThan(0);
  });
});

describe('listTraces — multi-test report support', () => {
  test('listTraces on a single-test report data dir returns exactly 1 trace', async () => {
    const traces = await listTraces(REPORT_A_DATA);
    expect(traces.length).toBe(1);
    const testTraceFile = path.join(traces[0]!.traceDir, 'test.trace');
    expect(fs.existsSync(testTraceFile)).toBe(true);
  });

  test('listTraces ignores non-trace files (.md, .png, .zip when dir already extracted)', async () => {
    // REPORT_A_DATA contains a .zip, a directory (extracted), a .md, and a .png —
    // only the extracted directory should be returned.
    const traces = await listTraces(REPORT_A_DATA);
    for (const t of traces) {
      // Every returned context must actually be a valid trace directory
      expect(fs.existsSync(path.join(t.traceDir, 'test.trace'))).toBe(true);
    }
  });

  test('listTraces extracts .zip when no extracted directory exists yet', async () => {
    // Build a synthetic data dir with only a .zip, no extracted folder
    const tmpDataDir = path.join(os.tmpdir(), 'pw-listtraces-zip-test', Date.now().toString());
    await fs.promises.mkdir(tmpDataDir, { recursive: true });

    const sourceZip = path.resolve(
      __dirname,
      '../../sc-tests/playwright-report 3/data/68e5ae746c4743054736c07b48a5f44e7eb65526.zip'
    );
    const destZip = path.join(tmpDataDir, '68e5ae746c4743054736c07b48a5f44e7eb65526.zip');
    await fs.promises.copyFile(sourceZip, destZip);

    const traces = await listTraces(tmpDataDir);
    expect(traces.length).toBe(1);
    expect(fs.existsSync(path.join(traces[0]!.traceDir, 'test.trace'))).toBe(true);

    await fs.promises.rm(tmpDataDir, { recursive: true, force: true });
  });

  test('listTraces on a synthetic multi-test data dir returns all traces', async () => {
    // Create a temporary data dir and symlink trace dirs from three different reports into it
    const tmpDataDir = path.join(os.tmpdir(), 'pw-multi-trace-test', Date.now().toString());
    await fs.promises.mkdir(tmpDataDir, { recursive: true });

    const traceDirs = [
      path.resolve(__dirname, '../../sc-tests/playwright-report 3/data/68e5ae746c4743054736c07b48a5f44e7eb65526'),
      path.resolve(__dirname, '../../sc-tests/playwright-report/data/4fd2226e8703a95238fdafe0bde6b3b7b647163e'),
      path.resolve(__dirname, '../../sc-tests/playwright-report 2/data/45e9ba9f6bac13a9cf875e0ccc7553e41a518275'),
    ].filter(d => fs.existsSync(path.join(d, 'test.trace')));

    for (const traceDir of traceDirs) {
      const linkName = path.join(tmpDataDir, path.basename(traceDir));
      await fs.promises.symlink(traceDir, linkName, 'dir');
    }

    const traces = await listTraces(tmpDataDir);
    expect(traces.length).toBe(traceDirs.length);

    // Every trace should be independently operable
    for (const t of traces) {
      const steps = await getTestSteps(t);
      expect(steps.length).toBeGreaterThan(0);
    }

    await fs.promises.rm(tmpDataDir, { recursive: true, force: true });
  });

  test('getTopLevelFailures works across all traces in a multi-test report', async () => {
    const allDataDirs = [REPORT_A_DATA, REPORT_B_DATA, REPORT_C_DATA];
    const allFailures = [];

    for (const dataDir of allDataDirs) {
      const traces = await listTraces(dataDir);
      for (const t of traces) {
        const failures = await getTopLevelFailures(t);
        allFailures.push(...failures);
      }
    }

    expect(allFailures.length).toBeGreaterThan(0);
  });
});

describe('getTopLevelFailures', () => {
  let ctx: Awaited<ReturnType<typeof prepareTraceDir>>;

  beforeAll(async () => {
    const traceDir = path.resolve(__dirname, '../../sc-tests/playwright-report 3/data/68e5ae746c4743054736c07b48a5f44e7eb65526');
    const traceZip = path.resolve(__dirname, '../../sc-tests/playwright-report 3/data/68e5ae746c4743054736c07b48a5f44e7eb65526.zip');
    ctx = await prepareTraceDir(fs.existsSync(traceDir) ? traceDir : traceZip);
  });

  test('returns only root-level failed steps (each has error and children)', async () => {
    const top = await getTopLevelFailures(ctx);
    expect(top.length).toBeGreaterThan(0);
    for (const step of top) {
      expect(step.error).not.toBeNull();
      expect(step.callId).toBeTruthy();
      expect(step.title).toBeTruthy();
      expect(Array.isArray(step.children)).toBe(true);
    }
  });

  test('deduplication across listTraces gives unique test count', async () => {
    const REPORT_4 = path.resolve(__dirname, '../../sc-tests/playwright-report 4/data');
    if (!fs.existsSync(REPORT_4)) return; // skip if not available

    const summaries = await getFailedTestSummaries(REPORT_4);
    // 10 failed × 2 retries + 3 flaky × 1 trace = 23 traces → 13 unique failures
    expect(summaries.length).toBe(13);
    for (const s of summaries) {
      expect(s.status).toBe('failed');
    }
  });
});

describe('getDomSnapshots with options', () => {
  let ctx: Awaited<ReturnType<typeof prepareTraceDir>>;

  beforeAll(async () => {
    const traceDir = path.resolve(__dirname, '../../sc-tests/playwright-report 3/data/68e5ae746c4743054736c07b48a5f44e7eb65526');
    const traceZip = path.resolve(__dirname, '../../sc-tests/playwright-report 3/data/68e5ae746c4743054736c07b48a5f44e7eb65526.zip');
    ctx = await prepareTraceDir(fs.existsSync(traceDir) ? traceDir : traceZip);
  });

  test('near: last with limit returns tail entries', async () => {
    const [all, tail] = await Promise.all([
      getDomSnapshots(ctx),
      getDomSnapshots(ctx, { near: 'last', limit: 3 }),
    ]);
    expect(tail.length).toBeLessThanOrEqual(3);
    if (all.length >= 3) {
      const lastCallId = all[all.length - 1]!.callId;
      expect(tail[tail.length - 1]!.callId).toBe(lastCallId);
    }
  });

  test('phase filter returns only entries with that phase populated', async () => {
    const afterOnly = await getDomSnapshots(ctx, { phase: 'after' });
    expect(afterOnly.length).toBeGreaterThan(0);
    for (const s of afterOnly) {
      expect(s.after).not.toBeNull();
      expect(s.before).toBeNull();
      expect(s.action).toBeNull();
    }
  });

  test('limit without near caps from the beginning', async () => {
    const [all, limited] = await Promise.all([
      getDomSnapshots(ctx),
      getDomSnapshots(ctx, { limit: 2 }),
    ]);
    expect(limited.length).toBeLessThanOrEqual(2);
    if (all.length >= 2) {
      expect(limited[0]!.callId).toBe(all[0]!.callId);
    }
  });

  test('near: callId returns a window around that call', async () => {
    const all = await getDomSnapshots(ctx);
    if (all.length < 3) return; // skip if not enough data

    const targetCallId = all[Math.floor(all.length / 2)]!.callId;
    const window = await getDomSnapshots(ctx, { near: targetCallId, limit: 4 });
    expect(window.length).toBeGreaterThan(0);
    const callIds = window.map(e => e.callId);
    expect(callIds).toContain(targetCallId);
  });
});

describe('getTimeline', () => {
  let ctx: Awaited<ReturnType<typeof prepareTraceDir>>;

  beforeAll(async () => {
    const traceDir = path.resolve(__dirname, '../../sc-tests/playwright-report 3/data/68e5ae746c4743054736c07b48a5f44e7eb65526');
    const traceZip = path.resolve(__dirname, '../../sc-tests/playwright-report 3/data/68e5ae746c4743054736c07b48a5f44e7eb65526.zip');
    ctx = await prepareTraceDir(fs.existsSync(traceDir) ? traceDir : traceZip);
  });

  test('returns entries of all 4 types', async () => {
    const timeline = await getTimeline(ctx);
    expect(timeline.length).toBeGreaterThan(0);
    const types = new Set(timeline.map(e => e.type));
    expect(types.has('step')).toBe(true);
    expect(types.has('screenshot')).toBe(true);
    expect(types.has('dom')).toBe(true);
    expect(types.has('network')).toBe(true);
  });

  test('entries are sorted chronologically', async () => {
    const timeline = await getTimeline(ctx);
    for (let i = 1; i < timeline.length; i++) {
      expect(timeline[i]!.timestamp).toBeGreaterThanOrEqual(timeline[i - 1]!.timestamp);
    }
  });

  test('screenshot entries have no savedPath field', async () => {
    const timeline = await getTimeline(ctx);
    const shots = timeline.filter(e => e.type === 'screenshot');
    expect(shots.length).toBeGreaterThan(0);
    for (const s of shots) {
      expect((s.data as any).savedPath).toBeUndefined();
    }
  });
});

describe('getSummary', () => {
  let ctx: Awaited<ReturnType<typeof prepareTraceDir>>;

  beforeAll(async () => {
    const traceDir = path.resolve(__dirname, '../../sc-tests/playwright-report 3/data/68e5ae746c4743054736c07b48a5f44e7eb65526');
    const traceZip = path.resolve(__dirname, '../../sc-tests/playwright-report 3/data/68e5ae746c4743054736c07b48a5f44e7eb65526.zip');
    ctx = await prepareTraceDir(fs.existsSync(traceDir) ? traceDir : traceZip);
  });

  test('returns a summary with title, status, and durationMs', async () => {
    const summary = await getSummary(ctx);
    expect(summary.title).toBeTruthy();
    expect(['passed', 'failed']).toContain(summary.status);
    expect(summary.durationMs).not.toBeNull();
    expect(summary.durationMs!).toBeGreaterThan(0);
  });

  test('failed trace has error and failureDomSnapshot', async () => {
    const summary = await getSummary(ctx);
    if (summary.status === 'failed') {
      expect(summary.error).not.toBeNull();
      expect(summary.error!.message.length).toBeGreaterThan(0);
      expect(summary.failureDomSnapshot).not.toBeNull();
    }
  });

  test('slowestSteps has at most 5 entries sorted descending', async () => {
    const summary = await getSummary(ctx);
    expect(summary.slowestSteps.length).toBeLessThanOrEqual(5);
    for (let i = 1; i < summary.slowestSteps.length; i++) {
      expect(summary.slowestSteps[i - 1]!.durationMs!).toBeGreaterThanOrEqual(
        summary.slowestSteps[i]!.durationMs!
      );
    }
  });

  test('networkCalls contains all network entries (both api and browser)', async () => {
    const summary = await getSummary(ctx);
    const allTraffic = await getNetworkTraffic(ctx);
    expect(summary.networkCalls.length).toBe(allTraffic.length);
    const sources = new Set(summary.networkCalls.map(c => c.source));
    // At least one source type must be present
    expect(sources.size).toBeGreaterThan(0);
  });

  test('topLevelSteps are the non-hook root steps', async () => {
    const [summary, roots] = await Promise.all([getSummary(ctx), getTestSteps(ctx)]);
    const HOOK_TITLES = new Set(['Before Hooks', 'After Hooks', 'Worker Cleanup', 'Worker Cleanup Hooks', 'Worker Setup']);
    const nonHookRoots = roots.filter(r => !HOOK_TITLES.has(r.title) && !r.title.startsWith('Attach "'));
    expect(summary.topLevelSteps.length).toBe(nonHookRoots.length);
    expect(summary.topLevelSteps.length).toBeGreaterThan(0);
  });

  test('testTitle is a non-null full Playwright title containing › separators', async () => {
    const summary = await getSummary(ctx);
    expect(summary.testTitle).not.toBeNull();
    expect(summary.testTitle).toContain(' › ');
  });
});

describe('getTestTitle', () => {
  let ctx: Awaited<ReturnType<typeof prepareTraceDir>>;

  beforeAll(async () => {
    const traceDir = path.resolve(__dirname, '../../sc-tests/playwright-report 3/data/68e5ae746c4743054736c07b48a5f44e7eb65526');
    const traceZip = path.resolve(__dirname, '../../sc-tests/playwright-report 3/data/68e5ae746c4743054736c07b48a5f44e7eb65526.zip');
    ctx = await prepareTraceDir(fs.existsSync(traceDir) ? traceDir : traceZip);
  });

  test('returns the full test title from context-options in a numbered trace file', async () => {
    const title = await getTestTitle(ctx);
    expect(title).not.toBeNull();
    expect(typeof title).toBe('string');
    expect(title!.length).toBeGreaterThan(0);
  });

  test('full title contains › separators (spec path, describe, test name)', async () => {
    const title = await getTestTitle(ctx);
    // Playwright full titles look like: "path/spec.ts:N › describe › test name"
    expect(title).toContain(' › ');
  });

  test('full title is consistent for the same trace across multiple calls', async () => {
    const [a, b] = await Promise.all([getTestTitle(ctx), getTestTitle(ctx)]);
    expect(a).toBe(b);
  });

  test('dedup by testTitle across listTraces gives exact unique count for report 4', async () => {
    const REPORT_4 = path.resolve(__dirname, '../../sc-tests/playwright-report 4/data');
    if (!fs.existsSync(REPORT_4)) return; // skip if not available

    const traces = await listTraces(REPORT_4);
    const seen = new Set<string>();
    for (const t of traces) {
      const title = await getTestTitle(t);
      if (title) seen.add(title);
    }
    // Report 4 has 10 failed + 3 flaky = 13 unique tests across 23 traces
    expect(seen.size).toBe(13);
  });
});

describe('getFailedTestSummaries', () => {
  test('returns only failed summaries (no passing tests leak through)', async () => {
    const traces = await listTraces(REPORT_A_DATA);
    if (traces.length === 0) return;

    const summaries = await getFailedTestSummaries(REPORT_A_DATA);
    for (const s of summaries) {
      expect(s.status).toBe('failed');
    }
  });

  test('all testTitle values in results are unique (retries deduplicated)', async () => {
    const summaries = await getFailedTestSummaries(REPORT_A_DATA);
    const titles = summaries.map(s => s.testTitle ?? s.title);
    const uniqueTitles = new Set(titles);
    expect(uniqueTitles.size).toBe(titles.length);
  });

  test('each summary has the full TraceSummary shape', async () => {
    const summaries = await getFailedTestSummaries(REPORT_A_DATA);
    for (const s of summaries) {
      expect(s.title).toBeTruthy();
      expect(['passed', 'failed']).toContain(s.status);
      expect(Array.isArray(s.topLevelSteps)).toBe(true);
      expect(Array.isArray(s.slowestSteps)).toBe(true);
      expect(Array.isArray(s.networkCalls)).toBe(true);
    }
  });

  test('report 4: returns exactly 13 unique failures', async () => {
    const REPORT_4 = path.resolve(__dirname, '../../sc-tests/playwright-report 4/data');
    if (!fs.existsSync(REPORT_4)) return; // skip if not available

    const summaries = await getFailedTestSummaries(REPORT_4);
    expect(summaries.length).toBe(13);
    for (const s of summaries) {
      expect(s.status).toBe('failed');
    }
    // All testTitles unique
    const titles = summaries.map(s => s.testTitle ?? s.title);
    expect(new Set(titles).size).toBe(summaries.length);
  });
});

