import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import {
  prepareTraceDir,
  listTraces,
  getFailedTests,
  getTestSteps,
  getNetworkTraffic,
  extractScreenshots,
  getDomSnapshots,
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

  test('getFailedTests returns at least one failure with error details', async () => {
    const failures = await getFailedTests(ctx);
    expect(failures.length).toBeGreaterThan(0);

    const first = failures[0]!;
    expect(first.callId).toBeTruthy();
    expect(first.title).toBeTruthy();
    expect(first.error).toBeTruthy();
    expect(typeof first.error.message).toBe('string');
    expect(first.error.message.length).toBeGreaterThan(0);
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

  test('getFailedTests works across all traces in a multi-test report', async () => {
    // Aggregate failures across three reports (same as a real multi-test run)
    const allDataDirs = [REPORT_A_DATA, REPORT_B_DATA, REPORT_C_DATA];
    const allFailures = [];

    for (const dataDir of allDataDirs) {
      const traces = await listTraces(dataDir);
      for (const t of traces) {
        const failures = await getFailedTests(t);
        allFailures.push(...failures);
      }
    }

    // At least one of the three reports should have failures
    expect(allFailures.length).toBeGreaterThan(0);
  });
});

