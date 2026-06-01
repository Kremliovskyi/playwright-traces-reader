import * as fs from 'fs';
import * as path from 'path';

import {
  extractFailureScreenshots,
  getConsoleEntries,
  getSummary,
  getTopLevelFailures,
  type FailureAnchor,
  type GetFailedTestSummariesOptions,
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
  type ConsoleErrorsFileJson,
  type FailureFolderJson,
  type FailureManifestEntry,
  type FailuresCommandJson,
  type NetworkErrorEntryJson,
  type NetworkErrorsFileJson,
  type NetworkErrorTimingJson,
} from './cli/json';

/** Per-trace metadata gathered from the HTML report's `report.json`. */
interface FailureReportInfo {
  outcome: 'expected' | 'unexpected' | 'flaky' | 'skipped' | null;
  retryIndex: number;
  /** Absolute path to Playwright's human-readable failure markdown, if present. */
  markdownPath: string | null;
}

function firstLine(value?: string | null): string | null {
  return value ? value.split(/\r?\n/, 1)[0] ?? null : null;
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
          index.set(traceSha1, {
            outcome: test.outcome,
            retryIndex,
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
): NetworkErrorEntryJson[] {
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
    const topFailures = await getTopLevelFailures(ctx);
    if (topFailures.length === 0)
      continue;

    const traceSha1 = path.basename(ctx.traceDir);
    const info = reportIndex?.get(traceSha1) ?? null;
    const outcome = (info?.outcome ?? null) as TraceSummary['outcome'];

    if (options?.excludeSkipped) {
      const isSkipped = traceMaps
        ? outcome === 'skipped'
        : topFailures.every(
            f =>
              f.annotations.some(a => a.type === 'skip') ||
              f.error?.message?.includes('Test is skipped:'),
          );
      if (isSkipped)
        continue;
    }

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
  const screenshots = screenshotSets.map(set => ({
    anchorCallId: set.anchorCallId,
    anchorTitle: set.anchorTitle,
    anchorTimestamp: set.anchorTimestamp,
    before: set.before ? `screenshots/${set.before}` : null,
    action: set.action ? `screenshots/${set.action}` : null,
    after: set.after ? `screenshots/${set.after}` : null,
  }));
  const screenshotCount = screenshots.reduce(
    (total, set) => total + [set.before, set.action, set.after].filter(Boolean).length,
    0,
  );

  // Network errors file.
  const networkErrorEntries = buildNetworkErrorEntries(summary, anchors);
  let networkErrorsFile: string | null = null;
  if (networkErrorEntries.length > 0) {
    const payload: NetworkErrorsFileJson = {
      schemaVersion: CLI_JSON_SCHEMA_VERSION,
      traceSha1,
      failureAnchors: anchors.map(a => ({ callId: a.callId, title: a.title, timestamp: a.timestamp })),
      count: networkErrorEntries.length,
      errors: networkErrorEntries,
    };
    networkErrorsFile = 'network-errors.json';
    await fs.promises.writeFile(
      path.join(folderDir, networkErrorsFile),
      `${JSON.stringify(payload, null, 2)}\n`,
      'utf-8',
    );
  }

  // Console errors file.
  const consoleEntries = (await getConsoleEntries(ctx)).filter(e => e.level === 'error');
  let consoleErrorsFile: string | null = null;
  if (consoleEntries.length > 0) {
    const payload: ConsoleErrorsFileJson = {
      schemaVersion: CLI_JSON_SCHEMA_VERSION,
      traceSha1,
      count: consoleEntries.length,
      entries: consoleEntries,
    };
    consoleErrorsFile = 'console-errors.json';
    await fs.promises.writeFile(
      path.join(folderDir, consoleErrorsFile),
      `${JSON.stringify(payload, null, 2)}\n`,
      'utf-8',
    );
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

  const errorMessage = firstLine(summary.error?.message);
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
    errorMessage,
    error: summary.error,
    traceSha1,
    tracePath: ctx.traceDir,
    topLevelSteps: summary.topLevelSteps,
    issues: summary.issues,
    actionDiagnostics: summary.actionDiagnostics,
    failureDomSnapshot: summary.failureDomSnapshot,
    networkCallCount: summary.networkCalls.length,
    networkErrorCount,
    consoleErrorCount,
    screenshots,
    files: {
      networkErrors: networkErrorsFile,
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
    errorMessage,
    traceSha1,
    screenshotCount,
    networkErrorCount,
    consoleErrorCount,
  };
}
