import * as fs from 'fs';
import * as path from 'path';

import {
  getConsoleEntries,
  getDomSnapshots,
  getNetworkTraffic,
  getSummary,
  getTestSteps,
  type NetworkEntry,
  type TestStep,
} from './extractors';
import {
  buildReportTraceMaps,
  getReportMetadata,
  getResourceBuffer,
  readNdjson,
  type ReportMetadata,
  type TraceContext,
} from './parseTrace';
import {
  CLI_JSON_SCHEMA_VERSION,
  type DigestCommandJson,
  type DigestFolderJson,
  type DigestStepNode,
  type NetworkBodyLineJson,
  type NetworkLineJson,
} from './cli/json';

/** Bodies (text) larger than this are spilled into `network-bodies.ndjson`. */
const BODY_SPILL_THRESHOLD_BYTES = 32 * 1024;

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '');
}

function sanitizeFolderName(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return (cleaned || 'trace').slice(0, 80).replace(/-$/, '');
}

/** Sanitizes a callId (e.g. `pw:api@71`) into a filesystem-safe stem (`pw-api-71`). */
function sanitizeCallId(callId: string): string {
  return callId.replace(/[^a-zA-Z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

/** Finds the trace's retry index by matching its SHA1 against report metadata. */
function findRetryIndex(meta: ReportMetadata | null, traceSha1: string): number {
  if (!meta) return 0;
  const maps = buildReportTraceMaps(meta);
  return maps.retryByTraceSha1.get(traceSha1) ?? 0;
}

interface FlatStep {
  step: TestStep;
  isLeaf: boolean;
}

/** Depth-first flatten preserving order, marking leaf nodes. */
function flattenWithLeaf(steps: TestStep[], out: FlatStep[]): void {
  for (const step of steps) {
    const isLeaf = step.children.length === 0;
    out.push({ step, isLeaf });
    if (!isLeaf) flattenWithLeaf(step.children, out);
  }
}

/** True when `t` falls inside the step's monotonic window [startTime, endTime]. */
function inStepWindow(step: TestStep, t: number | null): boolean {
  if (t === null) return false;
  const end = step.endTime ?? step.startTime;
  return t >= step.startTime && t <= end;
}

function isBinaryBody(body: string | null): boolean {
  return body !== null && body.startsWith('[binary:');
}

/**
 * Builds the chronological network NDJSON lines and the spilled-body lines.
 * Every entry gets a global `seq` assigned after sorting by monotonic time
 * (falling back to wall-clock when monotonic is unavailable).
 */
function buildNetworkLines(entries: NetworkEntry[]): {
  lines: NetworkLineJson[];
  bodies: NetworkBodyLineJson[];
  seqByEntry: Map<NetworkEntry, number>;
} {
  const sorted = [...entries].sort((a, b) => {
    const am = a.monotonicTime ?? Date.parse(a.startedDateTime);
    const bm = b.monotonicTime ?? Date.parse(b.startedDateTime);
    return am - bm;
  });

  const lines: NetworkLineJson[] = [];
  const bodies: NetworkBodyLineJson[] = [];
  const seqByEntry = new Map<NetworkEntry, number>();

  let seq = 1;
  for (const entry of sorted) {
    seqByEntry.set(entry, seq);

    const responseBody = entry.responseBody;
    const isBinary = isBinaryBody(responseBody);
    const bodySizeBytes = responseBody !== null ? Buffer.byteLength(responseBody, 'utf8') : 0;
    const isLarge = !isBinary && responseBody !== null && bodySizeBytes > BODY_SPILL_THRESHOLD_BYTES;

    const line: NetworkLineJson = {
      seq,
      monotonicTime: entry.monotonicTime,
      startedDateTime: entry.startedDateTime,
      source: entry.source,
      method: entry.method,
      url: entry.url,
      status: entry.status,
      statusText: entry.statusText,
      mimeType: entry.mimeType,
      durationMs: entry.durationMs,
      requestHeaders: entry.requestHeaders,
      responseHeaders: entry.responseHeaders,
      requestBody: entry.requestBody,
      responseBody: isLarge ? null : responseBody,
      bodySizeBytes,
      isBinary,
      isLarge,
      bodyRef: isLarge ? seq : null,
      relatedActionCallId: entry.relatedAction?.callId ?? null,
    };
    lines.push(line);

    if (isLarge && responseBody !== null) {
      bodies.push({
        seq,
        url: entry.url,
        mimeType: entry.mimeType,
        encoding: 'utf8',
        bodySizeBytes,
        body: responseBody,
      });
    }

    seq += 1;
  }

  return { lines, bodies, seqByEntry };
}

async function writeNdjson(filePath: string, records: unknown[]): Promise<void> {
  const content = records.map(r => JSON.stringify(r)).join('\n');
  await fs.promises.writeFile(filePath, records.length > 0 ? `${content}\n` : '', 'utf-8');
}

interface ScreencastFrame {
  sha1: string;
  timestamp: number;
  pageId: string;
}

/** Reads all screencast-frame events (sha1 + monotonic timestamp) across browser trace files. */
async function readScreencastFrames(ctx: TraceContext): Promise<ScreencastFrame[]> {
  const files = await fs.promises.readdir(ctx.traceDir);
  const traceFiles = files.filter(f => f.endsWith('.trace') && f !== 'test.trace').sort();
  const frames: ScreencastFrame[] = [];
  for (const traceFile of traceFiles) {
    for await (const event of readNdjson<{ type: string; sha1: string; timestamp: number; pageId: string }>(
      path.join(ctx.traceDir, traceFile),
    )) {
      if (event.type === 'screencast-frame')
        frames.push({ sha1: event.sha1, timestamp: event.timestamp, pageId: event.pageId });
    }
  }
  frames.sort((a, b) => a.timestamp - b.timestamp);
  return frames;
}

/** Returns the screencast frame whose timestamp is nearest `t`, or null when none exist. */
function nearestFrame(frames: ScreencastFrame[], t: number): ScreencastFrame | null {
  let best: ScreencastFrame | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const frame of frames) {
    const distance = Math.abs(frame.timestamp - t);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = frame;
    }
  }
  return best;
}

/**
 * Digests a single trace (any status) into a self-contained folder under
 * `outputDir`. Produces a chronological step tree (`digest.json`) whose leaf
 * actions each link to one Action-phase DOM snapshot and the nearest screenshot,
 * plus full chronological `network.ndjson` (large bodies spilled to
 * `network-bodies.ndjson`) and `console.ndjson`. Every step is linked to the
 * seq ids of all network calls that occurred within its monotonic time window.
 *
 * Returns a compact manifest (the full tree lives in `<folder>/digest.json`).
 *
 * @param tracePath   Path to a trace directory (already prepared/extracted).
 * @param outputDir   Directory to write the run folder into (created if missing).
 * @param options     Optional report metadata for outcome/retry resolution.
 */
export async function writeTraceDigest(
  ctx: TraceContext,
  outputDir: string,
  options?: { reportMetadata?: ReportMetadata | null },
): Promise<DigestCommandJson> {
  const resolvedOutputDir = path.resolve(outputDir);
  const runDir = path.join(resolvedOutputDir, `run-${new Date().toISOString().replace(/[:.]/g, '-')}`);

  const traceSha1 = path.basename(ctx.traceDir);
  const meta = options?.reportMetadata ?? (await getReportMetadata(path.dirname(ctx.traceDir)));
  const reportTraceMaps = meta ? buildReportTraceMaps(meta) : null;

  const [summary, roots, network, consoleEntries, domActions] = await Promise.all([
    getSummary(ctx, { reportMetadata: meta, reportTraceMaps }),
    getTestSteps(ctx),
    getNetworkTraffic(ctx),
    getConsoleEntries(ctx),
    getDomSnapshots(ctx, { phase: 'action' }),
  ]);

  const retryIndex = findRetryIndex(meta, traceSha1);
  const folderName = `${sanitizeFolderName(summary.testTitle ?? summary.title)}__retry${retryIndex}`;
  const folderDir = path.join(runDir, folderName);
  await fs.promises.mkdir(folderDir, { recursive: true });

  // ---- Network NDJSON (chronological, global seq, large bodies spilled) ----
  const { lines: networkLines, bodies: networkBodies, seqByEntry } = buildNetworkLines(network);
  await writeNdjson(path.join(folderDir, 'network.ndjson'), networkLines);
  if (networkBodies.length > 0)
    await writeNdjson(path.join(folderDir, 'network-bodies.ndjson'), networkBodies);

  // Pre-index network seq by time for fast per-step window queries. Prefer the
  // monotonic clock (matches step times in real traces); fall back to wall-clock
  // when monotonic is unavailable. A wall-clock epoch can never fall inside a
  // monotonic step window, so the fallback never produces false links.
  const networkByTime = networkLines
    .map(l => ({ seq: l.seq, t: l.monotonicTime ?? Date.parse(l.startedDateTime) }))
    .filter(n => Number.isFinite(n.t))
    .sort((a, b) => a.t - b.t);

  // ---- Console NDJSON (chronological, not linked) ----
  const consoleSorted = [...consoleEntries].sort((a, b) => a.timestamp - b.timestamp);
  await writeNdjson(path.join(folderDir, 'console.ndjson'), consoleSorted);
  const consoleErrors = consoleSorted.filter(e => e.level === 'error');

  // ---- DOM (Action phase) + screenshots, one per leaf action that has input@ ----
  const flat: FlatStep[] = [];
  flattenWithLeaf(roots, flat);

  // Action-phase DOM snapshot timestamps (browser clock == step clock).
  const actionSnapshots = domActions
    .map(a => a.action)
    .filter((s): s is NonNullable<typeof s> => s !== null)
    .sort((a, b) => a.timestamp - b.timestamp);

  // Match each leaf step to the action snapshot whose timestamp is inside its window.
  const domByStepCallId = new Map<string, { html: string; timestamp: number }>();
  const usedSnapshots = new Set<typeof actionSnapshots[number]>();
  for (const { step, isLeaf } of flat) {
    if (!isLeaf) continue;
    let chosen: typeof actionSnapshots[number] | null = null;
    for (const snap of actionSnapshots) {
      if (usedSnapshots.has(snap)) continue;
      if (inStepWindow(step, snap.timestamp)) {
        chosen = snap;
        break;
      }
    }
    if (chosen) {
      usedSnapshots.add(chosen);
      domByStepCallId.set(step.callId, { html: chosen.html, timestamp: chosen.timestamp });
    }
  }

  // Write DOM html files.
  const domFileByStepCallId = new Map<string, string>();
  if (domByStepCallId.size > 0) {
    const domDir = path.join(folderDir, 'dom');
    await fs.promises.mkdir(domDir, { recursive: true });
    for (const [stepCallId, { html }] of domByStepCallId) {
      const stem = sanitizeCallId(stepCallId);
      const rel = `dom/${stem}.html`;
      await fs.promises.writeFile(path.join(folderDir, rel), html, 'utf-8');
      domFileByStepCallId.set(stepCallId, rel);
    }
  }

  // Screenshots: nearest frame to each chosen action snapshot timestamp, written
  // once per leaf action and named by the (sanitized) step callId for a clean 1:1 pairing.
  const screenshotFileByStepCallId = new Map<string, string>();
  if (domByStepCallId.size > 0) {
    const frames = await readScreencastFrames(ctx);
    if (frames.length > 0) {
      const screenshotsDir = path.join(folderDir, 'screenshots');
      await fs.promises.mkdir(screenshotsDir, { recursive: true });
      for (const [stepCallId, { timestamp }] of domByStepCallId) {
        const frame = nearestFrame(frames, timestamp);
        if (!frame) continue;
        const buf = await getResourceBuffer(ctx, frame.sha1);
        if (!buf) continue;
        const ext = frame.sha1.endsWith('.jpeg') ? 'jpeg' : 'png';
        const rel = `screenshots/${sanitizeCallId(stepCallId)}.${ext}`;
        await fs.promises.writeFile(path.join(folderDir, rel), buf);
        screenshotFileByStepCallId.set(stepCallId, rel);
      }
    }
  }

  // ---- Build the digest step tree ----
  const buildNode = (step: TestStep): DigestStepNode => {
    const end = step.endTime ?? step.startTime;

    // All network calls whose monotonic time falls in this step's window.
    const networkSeq = networkByTime
      .filter(n => n.t >= step.startTime && n.t <= end)
      .map(n => n.seq);

    const consoleErrorCount = consoleErrors.filter(e => inStepWindow(step, e.timestamp)).length;

    // dom/screenshot are only ever populated for leaf actions with an input@ snapshot.
    const dom = domFileByStepCallId.get(step.callId) ?? null;
    const screenshot = screenshotFileByStepCallId.get(step.callId) ?? null;

    return {
      callId: step.callId,
      parentId: step.parentId,
      title: step.title,
      method: step.method,
      startTime: step.startTime,
      endTime: step.endTime,
      durationMs: step.durationMs,
      error: step.error
        ? {
            ...step.error,
            message: stripAnsi(step.error.message),
            ...(step.error.stack !== undefined ? { stack: stripAnsi(step.error.stack) } : {}),
          }
        : null,
      artifacts: {
        dom,
        screenshot,
        network: networkSeq,
        consoleErrors: consoleErrorCount,
      },
      children: step.children.map(buildNode),
    };
  };

  const steps = roots.map(buildNode);

  const folderJson: DigestFolderJson = {
    schemaVersion: CLI_JSON_SCHEMA_VERSION,
    command: 'digest',
    testTitle: summary.testTitle,
    title: summary.title,
    status: summary.status,
    outcome: summary.outcome,
    durationMs: summary.durationMs,
    retryIndex,
    traceSha1,
    tracePath: ctx.traceDir,
    counts: {
      steps: flat.length,
      leafActionsWithDom: domByStepCallId.size,
      screenshots: screenshotFileByStepCallId.size,
      networkCalls: networkLines.length,
      networkBodiesSpilled: networkBodies.length,
      consoleEntries: consoleSorted.length,
    },
    files: {
      network: 'network.ndjson',
      networkBodies: networkBodies.length > 0 ? 'network-bodies.ndjson' : null,
      console: 'console.ndjson',
    },
    steps,
  };

  await fs.promises.writeFile(
    path.join(folderDir, 'digest.json'),
    `${JSON.stringify(folderJson, null, 2)}\n`,
    'utf-8',
  );

  return {
    schemaVersion: CLI_JSON_SCHEMA_VERSION,
    command: 'digest',
    outputDir: resolvedOutputDir,
    runDir,
    folder: folderName,
    testTitle: summary.testTitle,
    title: summary.title,
    status: summary.status,
    outcome: summary.outcome,
    retryIndex,
    traceSha1,
    domCount: domByStepCallId.size,
    screenshotCount: screenshotFileByStepCallId.size,
    networkCallCount: networkLines.length,
    consoleEntryCount: consoleSorted.length,
  };
}
