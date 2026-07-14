import * as fs from 'fs';
import * as path from 'path';

import {
  extractFailureScreenshots,
  getConsoleEntries,
  getDomSnapshots,
  getSummary,
  getTopLevelFailures,
  type FailureAnchor,
  type GetFailedTestSummariesOptions,
  type TestStep,
  type TraceIssue,
  type TraceSummary,
} from './extractors';
import {
  buildReportTraceMaps,
  getReportMetadata,
  listTraces,
  type ReportMetadata,
  type TraceContext,
} from './parseTrace';
import {
  CLI_JSON_SCHEMA_VERSION,
  type FailureFolderJson,
  type FailureManifestEntry,
  type FailuresCommandJson,
  type FailureScreenshotSetJson,
  type NetworkErrorBaseJson,
  type NetworkErrorBodyLineJson,
  type NetworkErrorEntryJson,
  type NetworkErrorTimingJson,
} from './cli/json';

/** Response bodies (text) larger than this are spilled into `network-error-bodies.ndjson`. */
const BODY_SPILL_THRESHOLD_BYTES = 32 * 1024;

/**
 * Playwright per-result statuses that count as a failure. `passed` and
 * `skipped` are deliberately excluded; `skipped` is handled separately so the
 * `--exclude-skipped` option can opt out of it.
 */
const FAILING_RESULT_STATUSES = new Set(['failed', 'timedOut', 'interrupted']);

/** Per-trace metadata gathered from the HTML report's `report.json`. */
interface FailureReportInfo {
  outcome: 'expected' | 'unexpected' | 'flaky' | 'skipped' | null;
  retryIndex: number;
  /** Per-result status from `report.json` (failed/passed/timedOut/skipped/interrupted). */
  status: string | null;
  /** Absolute path to Playwright's human-readable failure markdown, if present. */
  markdownPath: string | null;
}

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

/** Remove ANSI SGR color/style escape codes from a string. */
function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '');
}

/**
 * Deep copy of the step tree with ANSI escape codes stripped from any step
 * error message/stack. The original summary objects are left untouched because
 * they are still used for in-memory skip detection and the manifest.
 */
function cleanSteps(steps: TestStep[]): TestStep[] {
  return steps.map(step => ({
    ...step,
    error: step.error
      ? {
          ...step.error,
          message: stripAnsi(step.error.message),
          ...(step.error.stack !== undefined ? { stack: stripAnsi(step.error.stack) } : {}),
        }
      : step.error,
    children: cleanSteps(step.children),
  }));
}

/** Copy of the issues list with ANSI escape codes stripped from message/stack. */
function cleanIssues(issues: TraceIssue[]): TraceIssue[] {
  return issues.map(issue => ({
    ...issue,
    message: stripAnsi(issue.message),
    stack: issue.stack ? stripAnsi(issue.stack) : issue.stack,
  }));
}

// Playwright's error-context markdown starts with a generic "# Instructions"
// block telling an AI to explain and fix the test. That guidance is meant for a
// one-off fix prompt and can derail higher-level analysis flows, so we drop it
// and keep only the diagnostic sections. If the block is absent, the content is
// returned unchanged.
function stripInstructionsBlock(markdown: string): string {
  if (!/^\s*#\s+Instructions\b/.test(markdown)) return markdown;
  // Remove from the start up to the next top-level heading.
  const stripped = markdown.replace(/^\s*#\s+Instructions\b[\s\S]*?(?=^#\s+)/m, '');
  return stripped.replace(/^\s+/, '');
}

function sanitizeFolderName(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return (cleaned || 'failure').slice(0, 80).replace(/-$/, '');
}

/** Sanitizes a callId (e.g. `pw:api@71`) into a filesystem-safe stem (`pw-api-71`). */
function sanitizeCallId(callId: string): string {
  return callId.replace(/[^a-zA-Z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Builds a per-trace index from report metadata: outcome, retry index, and the
 * path to the human-readable failure markdown attachment (when present in the
 * same result as the trace).
 */
function buildFailureReportIndex(
  meta: ReportMetadata,
  reportRootDir: string,
): Map<string, FailureReportInfo> {
  const index = new Map<string, FailureReportInfo>();

  for (const file of meta.files) {
    for (const test of file.tests) {
      for (let retryIndex = 0; retryIndex < test.results.length; retryIndex++) {
        const result = test.results[retryIndex]!;

        let traceSha1: string | null = null;
        let markdownPath: string | null = null;

        for (const att of result.attachments) {
          if (att.name === 'trace' && att.path)
            traceSha1 = path.basename(att.path, '.zip');

          const isMarkdown =
            att.contentType?.includes('markdown') ||
            att.name === 'error-context' ||
            (att.path?.toLowerCase().endsWith('.md') ?? false);
          if (isMarkdown && att.path)
            markdownPath = path.resolve(reportRootDir, att.path);
        }

        if (traceSha1) {
          let status = result.status ?? null;
          if (status === null) {
            if (test.outcome === 'skipped') {
              status = 'skipped';
            } else if (test.outcome === 'unexpected') {
              status = 'failed';
            } else if (test.outcome === 'flaky') {
              status = retryIndex < test.results.length - 1 ? 'failed' : 'passed';
            } else if (test.outcome === 'expected') {
              status = test.ok ? 'passed' : 'failed';
            }
          }

          index.set(traceSha1, {
            outcome: test.outcome,
            retryIndex,
            status,
            markdownPath: markdownPath && fs.existsSync(markdownPath) ? markdownPath : null,
          });
        }
      }
    }
  }

  return index;
}

/** Derives failure anchors (failing steps / assertions) from a trace summary. */
function deriveFailureAnchors(summary: TraceSummary): FailureAnchor[] {
  const anchors: FailureAnchor[] = [];
  const seen = new Set<string>();

  for (const issue of summary.issues) {
    if (issue.source !== 'step' || issue.timestamp === null)
      continue;
    const key = issue.callId ?? `t:${issue.timestamp}`;
    if (seen.has(key))
      continue;
    seen.add(key);
    anchors.push({ callId: issue.callId, title: issue.title, timestamp: issue.timestamp });
  }

  if (anchors.length === 0 && summary.failureDomSnapshot) {
    anchors.push({
      callId: summary.failureDomSnapshot.callId,
      title: summary.title,
      timestamp: summary.failureDomSnapshot.timestamp,
    });
  }

  return anchors;
}

function buildNetworkErrorEntries(
  summary: TraceSummary,
  anchors: FailureAnchor[],
): NetworkErrorBaseJson[] {
  return summary.networkCalls
    .filter(entry => entry.status >= 400)
    .map(entry => {
      const start = Date.parse(entry.startedDateTime);
      const end = Number.isNaN(start) ? NaN : start + (entry.durationMs ?? 0);

      const timingRelativeToFailures: NetworkErrorTimingJson[] = anchors.map(anchor => {
        let relation: NetworkErrorTimingJson['relation'] = 'unknown';
        if (!Number.isNaN(start)) {
          if (end < anchor.timestamp) relation = 'before';
          else if (start > anchor.timestamp) relation = 'after';
          else relation = 'during';
        }
        return { anchorCallId: anchor.callId, anchorTimestamp: anchor.timestamp, relation };
      });

      return {
        method: entry.method,
        url: entry.url,
        status: entry.status,
        statusText: entry.statusText,
        requestMimeType: entry.requestHeaders.find(header => header.name.toLowerCase() === 'content-type')?.value ?? '',
        mimeType: entry.mimeType,
        durationMs: entry.durationMs,
        startedDateTime: entry.startedDateTime,
        requestBody: entry.requestBody,
        responseBody: entry.responseBody,
        relatedAction: entry.relatedAction
          ? { callId: entry.relatedAction.callId, title: entry.relatedAction.title }
          : null,
        timingRelativeToFailures,
      };
    });
}

/** True when a resolved body is a placeholder for non-text/binary content. */
function isBinaryBody(body: string | null): boolean {
  return body !== null && body.startsWith('[binary:');
}

/**
 * Promotes triage network-error entries to NDJSON lines: assigns a global `seq`
 * (chronological by startedDateTime), computes body-spill metadata, and returns
 * both the inline lines and the direction-tagged spilled-body lines (>32 KB). Aligned
 * with the `digest` command's `network.ndjson` body-spill contract.
 */
function buildNetworkErrorLines(entries: NetworkErrorBaseJson[]): {
  lines: NetworkErrorEntryJson[];
  bodies: NetworkErrorBodyLineJson[];
} {
  const sorted = [...entries].sort((a, b) => Date.parse(a.startedDateTime) - Date.parse(b.startedDateTime));
  const lines: NetworkErrorEntryJson[] = [];
  const bodies: NetworkErrorBodyLineJson[] = [];

  let seq = 1;
  for (const entry of sorted) {
    const requestBodyIsBinary = isBinaryBody(entry.requestBody);
    const requestBodySizeBytes = entry.requestBody !== null ? Buffer.byteLength(entry.requestBody, 'utf8') : 0;
    const requestBodyIsLarge = !requestBodyIsBinary && entry.requestBody !== null && requestBodySizeBytes > BODY_SPILL_THRESHOLD_BYTES;
    const responseBodyIsBinary = isBinaryBody(entry.responseBody);
    const responseBodySizeBytes = entry.responseBody !== null ? Buffer.byteLength(entry.responseBody, 'utf8') : 0;
    const responseBodyIsLarge = !responseBodyIsBinary && entry.responseBody !== null && responseBodySizeBytes > BODY_SPILL_THRESHOLD_BYTES;

    lines.push({
      ...entry,
      requestBody: requestBodyIsLarge ? null : entry.requestBody,
      responseBody: responseBodyIsLarge ? null : entry.responseBody,
      seq,
      requestBodySizeBytes,
      requestBodyIsBinary,
      requestBodyIsLarge,
      requestBodyRef: requestBodyIsLarge ? seq : null,
      responseBodySizeBytes,
      responseBodyIsBinary,
      responseBodyIsLarge,
      responseBodyRef: responseBodyIsLarge ? seq : null,
    });

    if (requestBodyIsLarge && entry.requestBody !== null) {
      bodies.push({
        seq,
        direction: 'request',
        url: entry.url,
        mimeType: entry.requestMimeType,
        encoding: 'utf8',
        bodySizeBytes: requestBodySizeBytes,
        body: entry.requestBody,
      });
    }

    if (responseBodyIsLarge && entry.responseBody !== null) {
      bodies.push({
        seq,
        direction: 'response',
        url: entry.url,
        mimeType: entry.mimeType,
        encoding: 'utf8',
        bodySizeBytes: responseBodySizeBytes,
        body: entry.responseBody,
      });
    }

    seq += 1;
  }

  return { lines, bodies };
}

/** Serializes records to an NDJSON file (one JSON object per line). */
async function writeNdjson(filePath: string, records: unknown[]): Promise<void> {
  const content = records.map(r => JSON.stringify(r)).join('\n');
  await fs.promises.writeFile(filePath, records.length > 0 ? `${content}\n` : '', 'utf-8');
}

/**
 * Analyzes a Playwright report and writes one self-contained folder per failed
 * test attempt (including each failed retry) into `outputDir`. Each folder
 * bundles a `failure.json` plus companion artifacts (screenshots around every
 * failure point, failing network requests, console errors, the failure DOM,
 * and Playwright's human-readable error markdown when available).
 *
 * Returns the run manifest (also written to `<runDir>/index.json`).
 *
 * @param reportDataDir  Path to the report `data/` directory.
 * @param outputDir      Directory to write the run folder into (created if missing).
 * @param options        Optional filtering (e.g. `excludeSkipped`).
 */
export async function writeFailureDigests(
  reportDataDir: string,
  outputDir: string,
  options?: GetFailedTestSummariesOptions,
): Promise<FailuresCommandJson> {
  const resolvedOutputDir = path.resolve(outputDir);
  const runDir = path.join(resolvedOutputDir, `run-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await fs.promises.mkdir(runDir, { recursive: true });

  const meta = await getReportMetadata(reportDataDir);
  const traceMaps = meta ? buildReportTraceMaps(meta) : null;
  const reportRootDir = path.dirname(path.resolve(reportDataDir));
  const reportIndex = meta ? buildFailureReportIndex(meta, reportRootDir) : null;

  const traces = await listTraces(reportDataDir);
  const usedFolderNames = new Set<string>();
  const manifestEntries: FailureManifestEntry[] = [];

  for (const ctx of traces) {
    const traceSha1 = path.basename(ctx.traceDir);
    const info = reportIndex?.get(traceSha1) ?? null;
    const status = info?.status ?? null;

    // Decide whether this trace represents a failure worth digesting.
    //
    // Prefer the report's authoritative per-result status (from `report.json`) —
    // the same signal the HTML report uses. Crucially, it also catches tests
    // aborted mid-step whose error never propagated up to a root step. For
    // example, a `waitForResponse` timeout inside a `toPass` block leaves the
    // failing root step without an `after` event, so `getTopLevelFailures()`
    // returns nothing and the failure would otherwise be silently dropped.
    //
    // Fall back to scanning root-level step errors only when no report metadata
    // is available for this trace (e.g. a bare trace directory).
    let shouldInclude: boolean;
    if (status !== null) {
      if (FAILING_RESULT_STATUSES.has(status))
        shouldInclude = true;
      else if (status === 'skipped')
        shouldInclude = !options?.excludeSkipped;
      else
        shouldInclude = false;
    } else {
      const topFailures = await getTopLevelFailures(ctx);
      if (topFailures.length === 0) {
        shouldInclude = false;
      } else if (options?.excludeSkipped) {
        const isSkipped = topFailures.every(
          f =>
            f.annotations.some(a => a.type === 'skip') ||
            f.error?.message?.includes('Test is skipped:'),
        );
        shouldInclude = !isSkipped;
      } else {
        shouldInclude = true;
      }
    }
    if (!shouldInclude)
      continue;

    const summary = await getSummary(ctx, { reportMetadata: meta, reportTraceMaps: traceMaps });
    const retryIndex = info?.retryIndex ?? 0;

    const folderName = uniqueFolderName(
      `${sanitizeFolderName(summary.testTitle ?? summary.title)}__retry${retryIndex}`,
      usedFolderNames,
    );
    const folderDir = path.join(runDir, folderName);
    await fs.promises.mkdir(folderDir, { recursive: true });

    const entry = await writeSingleFailure({
      ctx,
      summary,
      traceSha1,
      retryIndex,
      folderDir,
      folderName,
      markdownPath: info?.markdownPath ?? null,
    });
    manifestEntries.push(entry);
  }

  const manifest: FailuresCommandJson = {
    schemaVersion: CLI_JSON_SCHEMA_VERSION,
    command: 'failures',
    outputDir: resolvedOutputDir,
    runDir,
    count: manifestEntries.length,
    failures: manifestEntries,
  };

  await fs.promises.writeFile(
    path.join(runDir, 'index.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf-8',
  );

  return manifest;
}

function uniqueFolderName(base: string, used: Set<string>): string {
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

async function writeSingleFailure(args: {
  ctx: TraceContext;
  summary: TraceSummary;
  traceSha1: string;
  retryIndex: number;
  folderDir: string;
  folderName: string;
  markdownPath: string | null;
}): Promise<FailureManifestEntry> {
  const { ctx, summary, traceSha1, retryIndex, folderDir, folderName, markdownPath } = args;

  const anchors = deriveFailureAnchors(summary);

  // Screenshots around every failure point.
  const screenshotSets = await extractFailureScreenshots(
    ctx,
    anchors,
    path.join(folderDir, 'screenshots'),
  );

  // Action-phase DOM nearest each failure anchor, written to disk so the folder
  // is self-contained (no second `dom --near` call needed for triage). Paired to
  // the screenshot sets by anchor, aligned with the `digest` command's DOM output.
  const actionSnapshots = (await getDomSnapshots(ctx, { phase: 'action' }))
    .map(a => a.action)
    .filter((s): s is NonNullable<typeof s> => s !== null)
    .sort((a, b) => a.timestamp - b.timestamp);

  const domByAnchorIndex = new Map<number, string>();
  if (actionSnapshots.length > 0) {
    const domDir = path.join(folderDir, 'dom');
    await fs.promises.mkdir(domDir, { recursive: true });
    const usedNames = new Set<string>();
    for (let i = 0; i < anchors.length; i++) {
      const anchor = anchors[i]!;
      const nearest = actionSnapshots.reduce((best, cur) =>
        Math.abs(cur.timestamp - anchor.timestamp) < Math.abs(best.timestamp - anchor.timestamp) ? cur : best,
      actionSnapshots[0]!);
      const stem = anchor.callId ? sanitizeCallId(anchor.callId) : `anchor-${i}`;
      let name = stem;
      let suffix = 2;
      while (usedNames.has(name)) { name = `${stem}-${suffix}`; suffix += 1; }
      usedNames.add(name);
      const rel = `dom/${name}.html`;
      await fs.promises.writeFile(path.join(folderDir, rel), nearest.html, 'utf-8');
      domByAnchorIndex.set(i, rel);
    }
  }

  const screenshots: FailureScreenshotSetJson[] = screenshotSets.map((set, i) => ({
    anchorCallId: set.anchorCallId,
    anchorTitle: set.anchorTitle,
    anchorTimestamp: set.anchorTimestamp,
    before: set.before ? `screenshots/${set.before}` : null,
    action: set.action ? `screenshots/${set.action}` : null,
    after: set.after ? `screenshots/${set.after}` : null,
    dom: domByAnchorIndex.get(i) ?? null,
  }));
  const screenshotCount = screenshots.reduce(
    (total, set) => total + [set.before, set.action, set.after].filter(Boolean).length,
    0,
  );
  const domCount = domByAnchorIndex.size;

  // Network errors file (NDJSON, chronological seq, large bodies spilled).
  const networkErrorEntries = buildNetworkErrorEntries(summary, anchors);
  let networkErrorsFile: string | null = null;
  let networkErrorBodiesFile: string | null = null;
  if (networkErrorEntries.length > 0) {
    const { lines, bodies } = buildNetworkErrorLines(networkErrorEntries);
    networkErrorsFile = 'network-errors.ndjson';
    await writeNdjson(path.join(folderDir, networkErrorsFile), lines);
    if (bodies.length > 0) {
      networkErrorBodiesFile = 'network-error-bodies.ndjson';
      await writeNdjson(path.join(folderDir, networkErrorBodiesFile), bodies);
    }
  }

  // Console errors file (NDJSON, chronological).
  const consoleEntries = (await getConsoleEntries(ctx))
    .filter(e => e.level === 'error')
    .sort((a, b) => a.timestamp - b.timestamp);
  let consoleErrorsFile: string | null = null;
  if (consoleEntries.length > 0) {
    consoleErrorsFile = 'console-errors.ndjson';
    await writeNdjson(path.join(folderDir, consoleErrorsFile), consoleEntries);
  }

  // Playwright's human-readable error markdown.
  let errorMarkdownFile: string | null = null;
  if (markdownPath) {
    errorMarkdownFile = 'error.md';
    const raw = await fs.promises.readFile(markdownPath, 'utf-8');
    await fs.promises.writeFile(
      path.join(folderDir, errorMarkdownFile),
      stripInstructionsBlock(raw),
      'utf-8',
    );
  }

  const networkErrorCount = networkErrorEntries.length;
  const consoleErrorCount = consoleEntries.length;

  const failureJson: FailureFolderJson = {
    schemaVersion: CLI_JSON_SCHEMA_VERSION,
    testTitle: summary.testTitle,
    title: summary.title,
    status: summary.status,
    outcome: summary.outcome,
    durationMs: summary.durationMs,
    retryIndex,
    traceSha1,
    tracePath: ctx.traceDir,
    topLevelSteps: cleanSteps(summary.topLevelSteps),
    issues: cleanIssues(summary.issues),
    actionDiagnostics: summary.actionDiagnostics,
    failureDomSnapshot: summary.failureDomSnapshot,
    networkCallCount: summary.networkCalls.length,
    networkErrorCount,
    consoleErrorCount,
    domCount,
    screenshots,
    files: {
      networkErrors: networkErrorsFile,
      networkErrorBodies: networkErrorBodiesFile,
      consoleErrors: consoleErrorsFile,
      errorMarkdown: errorMarkdownFile,
    },
  };

  await fs.promises.writeFile(
    path.join(folderDir, 'failure.json'),
    `${JSON.stringify(failureJson, null, 2)}\n`,
    'utf-8',
  );

  return {
    folder: folderName,
    testTitle: summary.testTitle,
    title: summary.title,
    retryIndex,
    status: summary.status,
    outcome: summary.outcome,
    traceSha1,
    screenshotCount,
    domCount,
    networkErrorCount,
    consoleErrorCount,
  };
}
