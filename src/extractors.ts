import * as fs from 'fs';
import * as path from 'path';
import { readNdjson, getResourceBuffer, listTraces, getReportMetadata, buildReportTraceMaps, type TraceContext, type ReportMetadata, type ReportTraceMaps } from './parseTrace';

// ---------- Types ----------

export interface StepAnnotation {
  type: string;
  description?: string;
}

export interface TestStep {
  callId: string;
  parentId: string | null;
  title: string;
  method: string;
  startTime: number;
  endTime: number | null;
  durationMs: number | null;
  error: TraceError | null;
  annotations: StepAnnotation[];
  children: TestStep[];
}

export interface TraceError {
  name: string;
  message: string;
  stack?: string;
}

export interface NetworkEntry {
  id: number;
  source: 'browser' | 'api';
  pageId: string | null;
  method: string;
  url: string;
  status: number;
  statusText: string;
  requestHeaders: Array<{ name: string; value: string }>;
  responseHeaders: Array<{ name: string; value: string }>;
  requestBody: string | null;
  responseBody: string | null;
  mimeType: string;
  startedDateTime: string;
  /** Monotonic timestamp (ms) of the request, on the same clock as TestStep.startTime/endTime. Null when not captured. */
  monotonicTime: number | null;
  durationMs: number;
  relatedAction: RelatedActionRef | null;
}

export interface RelatedActionRef {
  callId: string;
  title: string;
  method: string;
  pageId: string | null;
  startTime: number;
  endTime: number | null;
}

export interface ActionDiagnosticSummary {
  action: RelatedActionRef;
  networkCallCount: number;
  failingNetworkCallCount: number;
  issueCount: number;
}

export interface ConsoleEntry {
  source: 'browser' | 'stdout' | 'stderr';
  level: string;
  text: string;
  timestamp: number;
  pageId: string | null;
  location: {
    url: string;
    lineNumber: number;
    columnNumber: number;
  } | null;
}

export interface TraceIssue {
  source: 'step' | 'page' | 'trace';
  message: string;
  name: string | null;
  stack: string | null;
  timestamp: number | null;
  callId: string | null;
  title: string | null;
  location: {
    file: string;
    line: number;
    column: number;
  } | null;
  relatedAction: RelatedActionRef | null;
}

export interface NetworkFilterOptions {
  source?: 'all' | 'browser' | 'api';
  grep?: string;
  method?: string;
  status?: number;
  failed?: boolean;
  near?: string;
  limit?: number;
}

export interface AttachmentEntry {
  id: number;
  callId: string;
  actionTitle: string | null;
  name: string;
  contentType: string;
  path: string | null;
  sha1: string | null;
  base64: string | null;
  size: number | null;
}

export interface SavedAttachment extends AttachmentEntry {
  savedPath: string;
}

export interface Screenshot {
  sha1: string;
  timestamp: number;
  pageId: string;
  width: number;
  height: number;
  savedPath: string;
}

/**
 * Screenshot metadata without a savedPath — returned by getTimeline() and
 * other helpers that read screencast-frame events without writing to disk.
 */
export interface ScreenshotMetadata {
  sha1: string;
  timestamp: number;
  pageId: string;
  width: number;
  height: number;
}

// ---------- Internal trace event types ----------

interface TraceEventBefore {
  type: 'before';
  callId: string;
  stepId?: string;
  parentId?: string;
  startTime: number;
  class: string;
  method: string;
  title: string;
  params: Record<string, unknown>;
  stack: Array<{ file: string; line: number; column: number }>;
}

interface TraceEventAfter {
  type: 'after';
  callId: string;
  endTime: number;
  annotations?: Array<{ type: string; description?: string }>;
  error?: TraceError;
  attachments?: Array<{
    name: string;
    contentType: string;
    path?: string;
    sha1?: string;
    base64?: string;
  }>;
}

interface TraceEventConsole {
  type: 'console';
  time: number;
  pageId?: string;
  messageType: string;
  text: string;
  location: {
    url: string;
    lineNumber: number;
    columnNumber: number;
  };
}

interface TraceEventStdio {
  type: 'stdout' | 'stderr';
  timestamp: number;
  text?: string;
  base64?: string;
}

interface TraceEventPageError {
  type: 'event';
  time: number;
  class: string;
  method: string;
  params: {
    error?: {
      error?: {
        name?: string;
        message?: string;
        stack?: string;
      };
      value?: unknown;
    };
  };
  pageId?: string;
}

interface TraceEventError {
  type: 'error';
  message: string;
  stack?: Array<{ file: string; line: number; column: number }>;
}

interface TraceEventScreencast {
  type: 'screencast-frame';
  pageId: string;
  sha1: string;
  width: number;
  height: number;
  timestamp: number;
  frameSwapWallTime: number;
}

interface ResourceSnapshot {
  type: 'resource-snapshot';
  snapshot: {
    pageref?: string;
    _apiRequest?: boolean;
    startedDateTime: string;
    time: number;
    _monotonicTime?: number;
    request: {
      method: string;
      url: string;
      headers: Array<{ name: string; value: string }>;
      postData?: { mimeType: string; text?: string; _sha1?: string };
    };
    response: {
      status: number;
      statusText: string;
      headers: Array<{ name: string; value: string }>;
      content: {
        size: number;
        mimeType: string;
        _sha1?: string;
        text?: string;
      };
    };
  };
}

interface TraceActionBeforeEvent {
  type: 'before';
  callId: string;
  startTime: number;
  title?: string;
  class: string;
  method: string;
  pageId?: string;
}

interface TraceActionAfterEvent {
  type: 'after';
  callId: string;
  endTime: number;
}

// ---------- getTestSteps ----------

/**
 * Reconstructs the test step tree from a test.trace file.
 * Returns top-level steps (roots), each with nested children.
 */
export async function getTestSteps(traceContext: TraceContext): Promise<TestStep[]> {
  const testTracePath = path.join(traceContext.traceDir, 'test.trace');
  const stepMap = new Map<string, TestStep>();
  const roots: TestStep[] = [];

  for await (const event of readNdjson<TraceEventBefore | TraceEventAfter>(testTracePath)) {
    if (event.type === 'before') {
      const step: TestStep = {
        callId: event.callId,
        parentId: event.parentId ?? null,
        title: event.title,
        method: event.method,
        startTime: event.startTime,
        endTime: null,
        durationMs: null,
        error: null,
        annotations: [],
        children: [],
      };
      stepMap.set(event.callId, step);

      if (event.parentId) {
        const parent = stepMap.get(event.parentId);
        if (parent) {
          parent.children.push(step);
        } else {
          roots.push(step);
        }
      } else {
        roots.push(step);
      }
    } else if (event.type === 'after') {
      const step = stepMap.get(event.callId);
      if (step) {
        step.endTime = event.endTime;
        step.durationMs = event.endTime - step.startTime;
        if (event.error) {
          step.error = event.error;
        }
        if (event.annotations?.length) {
          step.annotations = event.annotations;
        }
      }
    }
  }

  return roots;
}

// ---------- getTopLevelFailures ----------

/**
 * Returns only the root-level steps that failed — one entry per failing test
 * per trace, matching exactly what the Playwright HTML report counts.
 *
 * Each returned `TestStep` includes the full `.children` tree, so you can
 * drill into nested steps to find the specific assertion or action that failed.
 * Use `getTestTitle()` to deduplicate retry traces across a full report run.
 */
export async function getTopLevelFailures(traceContext: TraceContext): Promise<TestStep[]> {
  const roots = await getTestSteps(traceContext);
  return roots.filter(step => step.error !== null);
}

// ---------- getNetworkTraffic ----------

/**
 * Reads all *.network files in the trace directory and returns structured
 * network entries. Each entry is tagged as 'browser' (has pageref) or
 * 'api' (has _apiRequest, no pageref). Response and request bodies are
 * resolved from the resources/ directory when a _sha1 reference exists.
 */
export async function getNetworkTraffic(traceContext: TraceContext, options?: NetworkFilterOptions): Promise<NetworkEntry[]> {
  const entries: NetworkEntry[] = [];
  const actions = await getBrowserActions(traceContext);

  const files = await fs.promises.readdir(traceContext.traceDir);
  const networkFiles = files.filter(f => f.endsWith('.network')).sort();

  for (const networkFile of networkFiles) {
    const filePath = path.join(traceContext.traceDir, networkFile);
    for await (const event of readNdjson<ResourceSnapshot>(filePath)) {
      if (event.type !== 'resource-snapshot') continue;

      const snap = event.snapshot;
      const isBrowser = Boolean(snap.pageref);
      const source: 'browser' | 'api' = isBrowser ? 'browser' : 'api';

      // Resolve request body
      let requestBody: string | null = null;
      const postData = snap.request.postData;
      if (postData) {
        if (postData.text) {
          requestBody = postData.text;
        } else if (postData._sha1) {
          const sha1 = postData._sha1.replace(/\.bin$/, '');
          const buf = await getResourceBuffer(traceContext, postData._sha1) ??
            await getResourceBuffer(traceContext, sha1);
          if (buf) {
            if (postData.mimeType.includes('json') || postData.mimeType.includes('text')) {
              requestBody = buf.toString('utf8');
            } else {
              requestBody = `[binary: ${postData.mimeType}, ${buf.length} bytes]`;
            }
          }
        }
      }

      // Resolve response body
      let responseBody: string | null = null;
      const content = snap.response.content;
      if (content._sha1) {
        const buf = await getResourceBuffer(traceContext, content._sha1);
        if (buf) {
          if (content.mimeType.includes('json') || content.mimeType.includes('text')) {
            responseBody = buf.toString('utf8');
          } else {
            responseBody = `[binary: ${content.mimeType}, ${buf.length} bytes]`;
          }
        }
      } else if (content.text) {
        responseBody = content.text;
      }

      entries.push({
        id: entries.length + 1,
        source,
        pageId: snap.pageref ?? null,
        method: snap.request.method,
        url: snap.request.url,
        status: snap.response.status,
        statusText: snap.response.statusText,
        requestHeaders: snap.request.headers,
        responseHeaders: snap.response.headers,
        requestBody,
        responseBody,
        mimeType: content.mimeType,
        startedDateTime: snap.startedDateTime,
        monotonicTime: snap._monotonicTime ?? null,
        durationMs: snap.time,
        relatedAction: correlateAction(actions, new Date(snap.startedDateTime).getTime(), snap.pageref ?? null),
      });
    }
  }

  return filterNetworkEntries(entries, options);
}

export async function getNetworkRequest(traceContext: TraceContext, requestId: number): Promise<NetworkEntry> {
  const entries = await getNetworkTraffic(traceContext);
  const entry = entries.find(candidate => candidate.id === requestId);
  if (!entry)
    throw new Error(`Request '${requestId}' not found.`);
  return entry;
}

// ---------- getConsoleEntries ----------

export async function getConsoleEntries(traceContext: TraceContext): Promise<ConsoleEntry[]> {
  const entries: ConsoleEntry[] = [];
  const files = await fs.promises.readdir(traceContext.traceDir);
  const traceFiles = files.filter(f => f.endsWith('.trace')).sort();

  for (const traceFile of traceFiles) {
    const filePath = path.join(traceContext.traceDir, traceFile);
    for await (const event of readNdjson<TraceEventConsole | TraceEventPageError | TraceEventStdio>(filePath)) {
      if (event.type === 'console') {
        entries.push({
          source: 'browser',
          level: event.messageType,
          text: event.text,
          timestamp: event.time,
          pageId: event.pageId ?? null,
          location: event.location,
        });
        continue;
      }

      if (event.type === 'event' && event.method === 'pageError') {
        const text = event.params.error?.error?.message ?? String(event.params.error?.value ?? '');
        if (!text)
          continue;
        entries.push({
          source: 'browser',
          level: 'error',
          text,
          timestamp: event.time,
          pageId: event.pageId ?? null,
          location: null,
        });
        continue;
      }

      if (event.type === 'stdout' || event.type === 'stderr') {
        let text = event.text?.trim() ?? '';
        if (!text && event.base64)
          text = Buffer.from(event.base64, 'base64').toString('utf8').trim();
        if (!text)
          continue;
        entries.push({
          source: event.type,
          level: event.type === 'stderr' ? 'error' : 'info',
          text,
          timestamp: event.timestamp,
          pageId: null,
          location: null,
        });
      }
    }
  }

  entries.sort((a, b) => a.timestamp - b.timestamp);
  return entries;
}

// ---------- getTraceIssues ----------

export async function getTraceIssues(traceContext: TraceContext): Promise<TraceIssue[]> {
  const issues: TraceIssue[] = [];
  const actions = await getBrowserActions(traceContext);
  const steps = await getTestSteps(traceContext);

  for (const step of flattenSteps(steps)) {
    if (!step.error)
      continue;
    issues.push({
      source: 'step',
      message: step.error.message,
      name: step.error.name,
      stack: step.error.stack ?? null,
      timestamp: step.endTime ?? step.startTime,
      callId: step.callId,
      title: step.title,
      location: null,
      relatedAction: resolveIssueRelatedAction(actions, step.callId, step.endTime ?? step.startTime, null),
    });
  }

  const files = await fs.promises.readdir(traceContext.traceDir);
  const traceFiles = files.filter(f => f.endsWith('.trace')).sort();

  for (const traceFile of traceFiles) {
    const filePath = path.join(traceContext.traceDir, traceFile);
    for await (const event of readNdjson<TraceEventError | TraceEventPageError>(filePath)) {
      if (event.type === 'error') {
        const firstFrame = event.stack?.[0];
        issues.push({
          source: 'trace',
          message: event.message,
          name: 'TraceError',
          stack: formatStackFrames(event.stack),
          timestamp: null,
          callId: null,
          title: null,
          location: firstFrame ? { file: firstFrame.file, line: firstFrame.line, column: firstFrame.column } : null,
          relatedAction: null,
        });
        continue;
      }

      if (event.type === 'event' && event.method === 'pageError') {
        const pageError = event.params.error?.error;
        const message = pageError?.message ?? String(event.params.error?.value ?? '');
        if (!message)
          continue;
        issues.push({
          source: 'page',
          message,
          name: pageError?.name ?? 'PageError',
          stack: pageError?.stack ?? null,
          timestamp: event.time,
          callId: null,
          title: null,
          location: null,
          relatedAction: resolveIssueRelatedAction(actions, null, event.time, event.pageId ?? null),
        });
      }
    }
  }

  issues.sort((a, b) => {
    if (a.timestamp === null && b.timestamp === null)
      return 0;
    if (a.timestamp === null)
      return 1;
    if (b.timestamp === null)
      return -1;
    return a.timestamp - b.timestamp;
  });

  return issues;
}

// ---------- getAttachments ----------

export async function getAttachments(traceContext: TraceContext): Promise<AttachmentEntry[]> {
  const files = await fs.promises.readdir(traceContext.traceDir);
  const traceFiles = files.filter(f => f.endsWith('.trace')).sort();
  const actionTitleByCallId = new Map<string, string>();
  const attachments: AttachmentEntry[] = [];

  for (const traceFile of traceFiles) {
    const filePath = path.join(traceContext.traceDir, traceFile);
    for await (const event of readNdjson<TraceEventBefore | TraceEventAfter>(filePath)) {
      if (event.type === 'before') {
        actionTitleByCallId.set(event.callId, event.title);
        continue;
      }

      if (event.type !== 'after' || !event.attachments?.length)
        continue;

      for (const attachment of event.attachments) {
        attachments.push({
          id: attachments.length + 1,
          callId: event.callId,
          actionTitle: actionTitleByCallId.get(event.callId) ?? null,
          name: attachment.name,
          contentType: attachment.contentType,
          path: attachment.path ?? null,
          sha1: attachment.sha1 ?? null,
          base64: attachment.base64 ?? null,
          size: await attachmentSize(traceContext, attachment),
        });
      }
    }
  }

  return attachments;
}

export async function extractAttachment(traceContext: TraceContext, attachmentId: number, outputPath?: string): Promise<SavedAttachment> {
  const attachments = await getAttachments(traceContext);
  const attachment = attachments.find(entry => entry.id === attachmentId);
  if (!attachment)
    throw new Error(`Attachment '${attachmentId}' not found.`);

  const content = await attachmentContent(traceContext, attachment);
  if (!content)
    throw new Error(`Could not extract attachment '${attachmentId}'.`);

  const savedPath = outputPath ?? path.join(process.cwd(), path.basename(attachment.name));
  await fs.promises.mkdir(path.dirname(savedPath), { recursive: true });
  await fs.promises.writeFile(savedPath, content);
  return {
    ...attachment,
    savedPath,
  };
}

// ---------- extractScreenshots ----------

/**
 * Finds all screencast-frame entries across all *-trace.trace files,
 * copies the referenced JPEG/PNG blobs from resources/ into outDir as
 * numbered files, and returns metadata including the saved file path.
 */
export async function extractScreenshots(
  traceContext: TraceContext,
  outDir: string
): Promise<Screenshot[]> {
  const screenshots: Screenshot[] = [];

  await fs.promises.mkdir(outDir, { recursive: true });

  const files = await fs.promises.readdir(traceContext.traceDir);
  const traceFiles = files.filter(f => f.endsWith('.trace') && f !== 'test.trace').sort();

  let index = 0;
  for (const traceFile of traceFiles) {
    const filePath = path.join(traceContext.traceDir, traceFile);
    for await (const event of readNdjson<TraceEventScreencast>(filePath)) {
      if (event.type !== 'screencast-frame') continue;

      const buf = await getResourceBuffer(traceContext, event.sha1);
      if (!buf) continue;

      const ext = event.sha1.endsWith('.jpeg') ? 'jpeg' : 'png';
      const outFileName = `screenshot-${String(index).padStart(4, '0')}.${ext}`;
      const savedPath = path.join(outDir, outFileName);
      await fs.promises.writeFile(savedPath, buf);

      screenshots.push({
        sha1: event.sha1,
        timestamp: event.timestamp,
        pageId: event.pageId,
        width: event.width,
        height: event.height,
        savedPath,
      });
      index++;
    }
  }

  return screenshots;
}

// ---------- extractFailureScreenshots ----------

/** A point of interest in a failing test (a failing step / assertion). */
export interface FailureAnchor {
  /** The failing action/step callId, when known. */
  callId: string | null;
  /** Human-readable step/issue title, when known. */
  title: string | null;
  /** Wall-clock timestamp (ms) of the failure point. */
  timestamp: number;
}

/** Screencast frames captured around a single failure anchor. */
export interface FailureScreenshotSet {
  anchorCallId: string | null;
  anchorTitle: string | null;
  anchorTimestamp: number;
  /** Relative file name of the frame just before the failure, or null. */
  before: string | null;
  /** Relative file name of the frame closest to the failure, or null. */
  action: string | null;
  /** Relative file name of the frame just after the failure, or null. */
  after: string | null;
}

/**
 * For each failure anchor, locates the nearest screencast frame `before`
 * (timestamp ≤ anchor), `action` (closest in time), and `after`
 * (timestamp ≥ anchor), writes the referenced image blobs into `outDir`, and
 * returns the saved file names per anchor.
 *
 * Frames are de-duplicated by SHA1 — the same underlying image is written once
 * and referenced by multiple roles/anchors. Returns an empty array when the
 * trace has no screencast frames (e.g. API-only tests or capture disabled).
 */
export async function extractFailureScreenshots(
  traceContext: TraceContext,
  anchors: FailureAnchor[],
  outDir: string,
): Promise<FailureScreenshotSet[]> {
  const frames = await getScreenshotMetadata(traceContext);
  if (frames.length === 0 || anchors.length === 0)
    return [];

  frames.sort((a, b) => a.timestamp - b.timestamp);

  await fs.promises.mkdir(outDir, { recursive: true });

  // SHA1 → relative file name (written once, referenced many times).
  const writtenBySha1 = new Map<string, string>();

  const ensureWritten = async (sha1: string): Promise<string | null> => {
    const cached = writtenBySha1.get(sha1);
    if (cached !== undefined)
      return cached;

    const buf = await getResourceBuffer(traceContext, sha1);
    if (!buf)
      return null;

    const ext = sha1.endsWith('.jpeg') ? 'jpeg' : 'png';
    // The frame sha1 has the form `page@<pageId>-<wallMs>.<ext>`, so a fixed-prefix
    // slice collides for every frame of the same page. Sanitize the full sha1 to a
    // filesystem-safe stem so each distinct frame writes to a distinct file.
    const safeStem = sha1.replace(/\.(jpeg|png)$/, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '');
    const fileName = `frame-${safeStem}.${ext}`;
    await fs.promises.writeFile(path.join(outDir, fileName), buf);
    writtenBySha1.set(sha1, fileName);
    return fileName;
  };

  const sets: FailureScreenshotSet[] = [];

  for (const anchor of anchors) {
    let before: ScreenshotMetadata | null = null;
    let after: ScreenshotMetadata | null = null;
    let action: ScreenshotMetadata | null = null;
    let actionDistance = Number.POSITIVE_INFINITY;

    for (const frame of frames) {
      if (frame.timestamp <= anchor.timestamp)
        before = frame; // frames are sorted, so the last match wins
      if (after === null && frame.timestamp >= anchor.timestamp)
        after = frame;

      const distance = Math.abs(frame.timestamp - anchor.timestamp);
      if (distance < actionDistance) {
        actionDistance = distance;
        action = frame;
      }
    }

    sets.push({
      anchorCallId: anchor.callId,
      anchorTitle: anchor.title,
      anchorTimestamp: anchor.timestamp,
      before: before ? await ensureWritten(before.sha1) : null,
      action: action ? await ensureWritten(action.sha1) : null,
      after: after ? await ensureWritten(after.sha1) : null,
    });
  }

  return sets;
}

// ---------- getDomSnapshots ----------

/**
 * A single serialized DOM snapshot for one phase of one action.
 *
 * `phase`:
 *   - `"before"` — DOM state before the action started (default recorded point)
 *   - `"action"` — DOM state during the action (corresponds to Trace Viewer's "Action" tab)
 *   - `"after"`  — DOM state after the action completed
 *
 * `html` is the snapshot serialized to an HTML string. Back-references inside
 * Playwright's compact snapshot format (`[[offset, nodeIdx]]`) are resolved using
 * the per-frame snapshot history: `offset` is how many snapshots to go back (from
 * the current snapshot's index) within this frame's history, and `nodeIdx` is the
 * index in the post-order DFS traversal of that historical snapshot.
 *
 * `targetElement` is the value of the `__playwright_target__` attribute on
 * the interacted element (the `callId` of the action that targeted it), if any.
 */
export interface DomSnapshot {
  callId: string;
  phase: 'before' | 'action' | 'after';
  snapshotName: string;
  frameId: string;
  frameUrl: string;
  pageId: string;
  timestamp: number;
  viewport: { width: number; height: number };
  html: string;
  targetElement: string | null;
}

/**
 * A complete set of DOM snapshots for a single browser action, grouping
 * the before/action/after phases together.
 */
export interface ActionDomSnapshots {
  callId: string;
  before: DomSnapshot | null;
  action: DomSnapshot | null;
  after: DomSnapshot | null;
}

/**
 * Lightweight metadata reference to the DOM snapshot closest to the failure.
 * Does NOT contain the full HTML — use the `dom` CLI command with
 * `--near <callId>` to retrieve the actual snapshots.
 */
export interface FailureDomSnapshotRef {
  /** The action's callId — pass to `dom --near <callId>` to retrieve full HTML. */
  callId: string;
  /** Which snapshot phases are available for this action. */
  phases: Array<'before' | 'action' | 'after'>;
  /** Wall-clock timestamp of the primary phase snapshot. */
  timestamp: number;
  /** Frame URL from the primary phase, if available. */
  frameUrl: string | null;
  /** The targeted element's callId, if any. */
  targetElement: string | null;
}

/**
 * Optional filtering options for getDomSnapshots().
 *
 * @param near   `'last'` returns the last `limit` entries (default 5).
 *               A callId string like `'call@585'` returns a window of
 *               `limit` entries centred on that action.
 * @param phase  Filter to a single snapshot phase.
 * @param limit  Max entries to return. With `near: 'last'` this is the tail
 *               count; with `near: callId` it is the window size (default 5);
 *               without `near` it caps the result from the beginning.
 */
export interface DomSnapshotOptions {
  near?: 'last' | string;
  phase?: 'before' | 'action' | 'after';
  limit?: number;
}

// Internal types
type SnapshotNode = string | SnapshotNode[];

interface RawFrameSnapshot {
  type: 'frame-snapshot';
  snapshot: {
    callId: string;
    snapshotName: string;
    pageId: string;
    frameId: string;
    frameUrl: string;
    html: SnapshotNode;
    viewport: { width: number; height: number };
    timestamp: number;
    wallTime: number;
    resourceOverrides: Array<{ url: string; sha1?: string; content?: string }>;
    isMainFrame: boolean;
  };
}

/**
 * Builds the post-order DFS node list for a snapshot tree (mirroring
 * Playwright's `snapshotNodes()` in snapshotRenderer.ts). Only "real"
 * element/text nodes are added — subtree refs are not in the list.
 * This list is used for back-reference resolution.
 *
 * Results are memoized in `cache` (keyed by the html object reference) to avoid
 * recomputing the same large trees when many back-references point to the same
 * historical snapshot.
 */
function buildSnapshotNodeList(
  html: SnapshotNode,
  cache: Map<SnapshotNode, SnapshotNode[]>
): SnapshotNode[] {
  const cached = cache.get(html);
  if (cached) return cached;
  const nodes: SnapshotNode[] = [];
  function visit(n: SnapshotNode): void {
    if (typeof n === 'string') {
      nodes.push(n);
      return;
    }
    if (!Array.isArray(n)) return;
    // Subtree ref: [[offset, idx]] — skip (not a real node)
    if (Array.isArray(n[0])) return;
    // Element: [tagName, attrs, ...children] — recurse children first (post-order)
    const [, , ...children] = n as [string, unknown, ...SnapshotNode[]];
    for (const child of children) visit(child);
    nodes.push(n);
  }
  visit(html);
  cache.set(html, nodes);
  return nodes;
}

const VOID_TAGS = new Set([
  'area','base','br','col','embed','hr','img','input',
  'keygen','link','menuitem','meta','param','source','track','wbr',
]);

/** Maximum iframe nesting depth to inline before bailing out (cycle/runaway guard). */
const MAX_IFRAME_DEPTH = 10;

/**
 * A single captured snapshot for one frame, indexed by its position in that
 * frame's history (needed for back-reference resolution).
 */
interface FrameSnapshotEntry {
  html: SnapshotNode;
  historyIndex: number;
}

/**
 * Shared state for a single render pass, allowing `resolveSnapshotNode` to
 * recurse into child iframe snapshots and inline them.
 *
 * Playwright captures every frame (the main page and each child iframe) as its
 * own snapshot series keyed by `frameId`, all sharing the same `snapshotName`
 * for a given action (e.g. `before@call@98`). At capture time an iframe's `src`
 * is rewritten to `/snapshot/<childFrameId>` and the trace viewer resolves it
 * lazily via a service worker. Since we produce a self-contained HTML file
 * instead, we resolve each child frame here and inline it as `srcdoc`.
 */
interface RenderContext {
  /** frameId → ordered list of that frame's raw snapshot HTMLs (for back-refs). */
  frameHistory: Map<string, SnapshotNode[]>;
  /** frameId → snapshotName → the matching snapshot entry for that frame. */
  frameSnapshotsByName: Map<string, Map<string, FrameSnapshotEntry>>;
  /** Memoization cache for buildSnapshotNodeList. */
  dfsCache: Map<SnapshotNode, SnapshotNode[]>;
  /** The action snapshot name being rendered (used to pick child snapshots). */
  snapshotName: string;
  /** frameIds currently on the render stack (cycle guard). */
  stack: Set<string>;
}

/**
 * Resolves a snapshot node tree into an HTML string for a given frame.
 *
 * `snapshotIndex` is the 0-based index of the current snapshot in the frame's
 * history. `frameId` identifies the frame so back-references resolve against the
 * correct history and child iframes can be inlined recursively.
 *
 * Back-references `[[offset, nodeIdx]]` are resolved as:
 *   refIndex = snapshotIndex - offset
 *   node     = snapshotNodes(frameHistory[refIndex])[nodeIdx]
 *
 * `<iframe>` / `<frame>` elements whose `src` is `/snapshot/<childFrameId>` are
 * replaced with the recursively-rendered child frame HTML inlined via `srcdoc`,
 * producing a complete, self-contained page.
 */
function resolveSnapshotNode(
  node: SnapshotNode,
  snapshotIndex: number,
  frameId: string,
  ctx: RenderContext
): string {
  const frameHistory = ctx.frameHistory.get(frameId) ?? [];

  if (typeof node === 'string') {
    return escapeHtml(node);
  }
  if (!Array.isArray(node)) return '';

  // Subtree reference: [[offset, nodeIdx]]
  if (
    Array.isArray(node[0]) &&
    (node[0] as unknown[]).length === 2 &&
    typeof (node[0] as unknown[])[0] === 'number' &&
    typeof (node[0] as unknown[])[1] === 'number'
  ) {
    const [offset, nodeIdx] = node[0] as unknown as [number, number];
    const refIndex = snapshotIndex - offset;
    if (refIndex >= 0 && refIndex < frameHistory.length) {
      const refHtml = frameHistory[refIndex]!;
      const nodes = buildSnapshotNodeList(refHtml, ctx.dfsCache);
      if (nodeIdx >= 0 && nodeIdx < nodes.length) {
        return resolveSnapshotNode(nodes[nodeIdx]!, refIndex, frameId, ctx);
      }
    }
    return `<!-- ref: [${offset}, ${nodeIdx}] unresolved -->`;
  }

  // Element node: [tagName, attrs, ...children]
  const [tagName, attrs, ...children] = node as [string, Record<string, string>, ...SnapshotNode[]];
  if (typeof tagName !== 'string') return '';

  const tag = tagName.toLowerCase();
  if (tag === 'script') return '';  // not useful for AI analysis

  const safeAttrs = attrs && typeof attrs === 'object' && !Array.isArray(attrs)
    ? (attrs as Record<string, string>)
    : {};

  // Inline child frames: <iframe>/<frame> with src="/snapshot/<frameId>".
  if (tag === 'iframe' || tag === 'frame') {
    const childFrameId = parseSnapshotFrameId(safeAttrs['src']);
    const baseAttrs = Object.entries(safeAttrs)
      .filter(([k]) => !k.startsWith('__playwright') && k.toLowerCase() !== 'src' && k.toLowerCase() !== 'srcdoc')
      .map(([k, v]) => ` ${k}="${escapeAttr(String(v))}"`)
      .join('');

    if (childFrameId) {
      const childHtml = renderChildFrame(childFrameId, ctx);
      if (childHtml !== null) {
        return `<${tag}${baseAttrs} srcdoc="${escapeAttr(childHtml)}"></${tag}>`;
      }
      return `<${tag}${baseAttrs}><!-- child frame ${escapeHtml(childFrameId)} not captured for ${escapeHtml(ctx.snapshotName)} --></${tag}>`;
    }
    return `<${tag}${baseAttrs}></${tag}>`;
  }

  const attrStr = Object.entries(safeAttrs)
    .filter(([k]) => !k.startsWith('__playwright'))
    .map(([k, v]) => ` ${k}="${escapeAttr(String(v))}"`)
    .join('');

  if (VOID_TAGS.has(tag)) {
    return `<${tag}${attrStr}>`;
  }

  const inner = children.map(c => resolveSnapshotNode(c, snapshotIndex, frameId, ctx)).join('');
  return `<${tag}${attrStr}>${inner}</${tag}>`;
}

/**
 * Extracts the child frameId from an iframe `src` of the form
 * `/snapshot/<frameId>` (Playwright's capture-time rewrite). Returns null for
 * any other value (empty, blank, or a real URL).
 */
function parseSnapshotFrameId(src: string | undefined): string | null {
  if (!src) return null;
  const prefix = '/snapshot/';
  if (!src.startsWith(prefix)) return null;
  const id = src.substring(prefix.length).trim();
  return id.length > 0 ? id : null;
}

/**
 * Renders a child frame's snapshot (matching the current action's snapshotName)
 * to an HTML string, recursing into its own child frames. Returns null when the
 * frame has no snapshot for this action or when the depth/cycle guard trips.
 */
function renderChildFrame(childFrameId: string, ctx: RenderContext): string | null {
  if (ctx.stack.has(childFrameId)) return null;       // cycle guard
  if (ctx.stack.size >= MAX_IFRAME_DEPTH) return null; // runaway depth guard

  const entry = ctx.frameSnapshotsByName.get(childFrameId)?.get(ctx.snapshotName);
  if (!entry) return null;

  ctx.stack.add(childFrameId);
  try {
    return resolveSnapshotNode(entry.html, entry.historyIndex, childFrameId, ctx);
  } finally {
    ctx.stack.delete(childFrameId);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/**
 * Extracts DOM snapshots from all browser context trace files (`[N]-trace.trace`
 * where the context is a browser context, i.e. has frame-snapshot entries).
 *
 * Returns one `ActionDomSnapshots` per unique `callId` found, with all three
 * phases (`before`, `action`, `after`) populated when available.
 *
 * Back-references in Playwright's compact snapshot format are resolved using
 * the per-frame snapshot history: `[[offset, nodeIdx]]` means "go back `offset`
 * snapshots in this frame's history, find the `nodeIdx`-th node in post-order
 * DFS of that snapshot".
 */
export async function getDomSnapshots(traceContext: TraceContext, options?: DomSnapshotOptions): Promise<ActionDomSnapshots[]> {
  const files = await fs.promises.readdir(traceContext.traceDir);
  const traceFiles = files.filter(f => f.endsWith('.trace') && f !== 'test.trace').sort();

  // Per-frame snapshot history: frameId → ordered list of raw html nodes (for back-refs).
  const frameHistory = new Map<string, SnapshotNode[]>();
  // Per-frame snapshot lookup: frameId → snapshotName → entry (for inlining child frames).
  const frameSnapshotsByName = new Map<string, Map<string, FrameSnapshotEntry>>();

  // Memoization cache for buildSnapshotNodeList — keyed by html object reference
  const dfsCache = new Map<SnapshotNode, SnapshotNode[]>();

  // Raw metadata for main-frame snapshots, rendered in a second pass once every
  // frame (including child iframes) has been collected.
  interface MainFrameRecord {
    callId: string;
    phase: 'before' | 'action' | 'after';
    snapshotName: string;
    frameId: string;
    frameUrl: string;
    pageId: string;
    timestamp: number;
    viewport: { width: number; height: number };
    html: SnapshotNode;
    snapshotIndex: number;
  }
  const mainFrameRecords: MainFrameRecord[] = [];

  // ---- Pass 1: collect every frame snapshot (main + child iframes) ----
  for (const traceFile of traceFiles) {
    const filePath = path.join(traceContext.traceDir, traceFile);

    for await (const event of readNdjson<RawFrameSnapshot>(filePath)) {
      if (event.type !== 'frame-snapshot') continue;
      const snap = event.snapshot;

      const { snapshotName, callId, frameId, frameUrl, pageId, viewport, timestamp, html, isMainFrame } = snap;

      // Append to per-frame history BEFORE anything else (so refs can point back to it)
      if (!frameHistory.has(frameId)) frameHistory.set(frameId, []);
      const history = frameHistory.get(frameId)!;
      history.push(html);
      const snapshotIndex = history.length - 1;

      // Index by snapshotName so parent frames can inline this child by name.
      if (!frameSnapshotsByName.has(frameId)) frameSnapshotsByName.set(frameId, new Map());
      frameSnapshotsByName.get(frameId)!.set(snapshotName, { html, historyIndex: snapshotIndex });

      if (!isMainFrame) continue; // child frames are only inlined, never top-level entries

      // Determine phase from snapshotName prefix
      let phase: 'before' | 'action' | 'after';
      if (snapshotName.startsWith('before@')) {
        phase = 'before';
      } else if (snapshotName.startsWith('after@')) {
        phase = 'after';
      } else if (snapshotName.startsWith('input@')) {
        phase = 'action';
      } else {
        continue; // unknown phase, skip
      }

      mainFrameRecords.push({
        callId, phase, snapshotName, frameId, frameUrl, pageId, timestamp, viewport, html, snapshotIndex,
      });
    }
  }

  // ---- Pass 2: render each main-frame snapshot, inlining child iframes ----
  // When a single phase is requested, skip rendering the other phases entirely.
  // The final result is filtered by phase anyway, so this avoids the expensive
  // back-reference DFS for snapshots that would be discarded (e.g. ~3x fewer
  // renders when only 'action'/input@ snapshots are needed).
  const rawByCallId = new Map<string, Map<string, DomSnapshot>>();
  for (const rec of mainFrameRecords) {
    if (options?.phase && rec.phase !== options.phase) continue;
    const ctx: RenderContext = {
      frameHistory,
      frameSnapshotsByName,
      dfsCache,
      snapshotName: rec.snapshotName,
      stack: new Set<string>([rec.frameId]),
    };

    const resolvedHtml = resolveSnapshotNode(rec.html, rec.snapshotIndex, rec.frameId, ctx);
    const targetElement = findPlaywrightTarget(rec.html, {
      ...ctx,
      stack: new Set<string>([rec.frameId]),
    });

    const domSnapshot: DomSnapshot = {
      callId: rec.callId,
      phase: rec.phase,
      snapshotName: rec.snapshotName,
      frameId: rec.frameId,
      frameUrl: rec.frameUrl,
      pageId: rec.pageId,
      timestamp: rec.timestamp,
      viewport: rec.viewport,
      html: resolvedHtml,
      targetElement,
    };

    if (!rawByCallId.has(rec.callId)) rawByCallId.set(rec.callId, new Map());
    rawByCallId.get(rec.callId)!.set(rec.phase, domSnapshot);
  }

  // Assemble into ActionDomSnapshots
  let result: ActionDomSnapshots[] = [];
  for (const [callId, phases] of rawByCallId) {
    result.push({
      callId,
      before: phases.get('before') ?? null,
      action: phases.get('action') ?? null,
      after:  phases.get('after')  ?? null,
    });
  }

  result.sort((a, b) => {
    const ta = (a.before ?? a.action ?? a.after)?.timestamp ?? 0;
    const tb = (b.before ?? b.action ?? b.after)?.timestamp ?? 0;
    return ta - tb;
  });

  // Apply options filters
  if (options) {
    if (options.phase) {
      const p = options.phase;
      result = result
        .map(r => ({
          ...r,
          before: p === 'before' ? r.before : null,
          action: p === 'action' ? r.action : null,
          after:  p === 'after'  ? r.after  : null,
        }))
        .filter(r => r.before !== null || r.action !== null || r.after !== null);
    }

    if (options.near === 'last') {
      const n = options.limit ?? 5;
      result = result.slice(-n);
    } else if (options.near) {
      const idx = result.findIndex(r => r.callId === options.near);
      if (idx >= 0) {
        const n = options.limit ?? 5;
        const half = Math.floor(n / 2);
        const start = Math.max(0, idx - half);
        result = result.slice(start, start + n);
      }
    } else if (options.limit !== undefined) {
      result = result.slice(0, options.limit);
    }
  }

  return result;
}

/**
 * Recursively searches the snapshot tree for a node with __playwright_target__.
 *
 * When `ctx` is provided, the search also descends into child `<iframe>`/`<frame>`
 * elements (matched by `src="/snapshot/<frameId>"`) so a target living inside a
 * child frame is still found. Cycles and runaway depth are guarded via `ctx.stack`.
 */
function findPlaywrightTarget(node: SnapshotNode, ctx?: RenderContext): string | null {
  if (!Array.isArray(node) || node.length < 2) return null;
  const attrs = node[1];
  if (attrs && typeof attrs === 'object' && !Array.isArray(attrs)) {
    const target = (attrs as Record<string, string>)['__playwright_target__'];
    if (target) return target;

    // Descend into child frames so targets inside iframes are still found.
    if (ctx && typeof node[0] === 'string') {
      const tag = node[0].toLowerCase();
      if (tag === 'iframe' || tag === 'frame') {
        const childFrameId = parseSnapshotFrameId((attrs as Record<string, string>)['src']);
        if (childFrameId && !ctx.stack.has(childFrameId) && ctx.stack.size < MAX_IFRAME_DEPTH) {
          const entry = ctx.frameSnapshotsByName.get(childFrameId)?.get(ctx.snapshotName);
          if (entry) {
            ctx.stack.add(childFrameId);
            try {
              const found = findPlaywrightTarget(entry.html, ctx);
              if (found) return found;
            } finally {
              ctx.stack.delete(childFrameId);
            }
          }
        }
      }
    }
  }
  for (let i = 2; i < node.length; i++) {
    const child = node[i];
    if (Array.isArray(child)) {
      const found = findPlaywrightTarget(child as SnapshotNode[], ctx);
      if (found) return found;
    }
  }
  return null;
}

// ---------- getScreenshotMetadata (internal) ----------

/**
 * Reads screencast-frame events from trace files and returns screenshot
 * metadata WITHOUT writing any files to disk. Used internally by getTimeline().
 */
async function getScreenshotMetadata(traceContext: TraceContext): Promise<ScreenshotMetadata[]> {
  const screenshots: ScreenshotMetadata[] = [];

  const files = await fs.promises.readdir(traceContext.traceDir);
  const traceFiles = files.filter(f => f.endsWith('.trace') && f !== 'test.trace').sort();

  for (const traceFile of traceFiles) {
    const filePath = path.join(traceContext.traceDir, traceFile);
    for await (const event of readNdjson<TraceEventScreencast>(filePath)) {
      if (event.type !== 'screencast-frame') continue;
      screenshots.push({
        sha1: event.sha1,
        timestamp: event.timestamp,
        pageId: event.pageId,
        width: event.width,
        height: event.height,
      });
    }
  }

  return screenshots;
}

// ---------- Shared helper ----------

/** Flattens a step tree into a single array (depth-first). */
function flattenSteps(steps: TestStep[]): TestStep[] {
  const out: TestStep[] = [];
  for (const s of steps) {
    out.push(s);
    out.push(...flattenSteps(s.children));
  }
  return out;
}

function buildActionDiagnostics(networkCalls: NetworkEntry[], issues: TraceIssue[]): ActionDiagnosticSummary[] {
  const byCallId = new Map<string, ActionDiagnosticSummary>();

  const ensure = (action: RelatedActionRef): ActionDiagnosticSummary => {
    const existing = byCallId.get(action.callId);
    if (existing)
      return existing;

    const created: ActionDiagnosticSummary = {
      action,
      networkCallCount: 0,
      failingNetworkCallCount: 0,
      issueCount: 0,
    };
    byCallId.set(action.callId, created);
    return created;
  };

  for (const entry of networkCalls) {
    if (!entry.relatedAction)
      continue;
    const bucket = ensure(entry.relatedAction);
    bucket.networkCallCount += 1;
    if (entry.status >= 400)
      bucket.failingNetworkCallCount += 1;
  }

  for (const issue of issues) {
    if (!issue.relatedAction)
      continue;
    ensure(issue.relatedAction).issueCount += 1;
  }

  return [...byCallId.values()].sort((left, right) => {
    const leftScore = left.failingNetworkCallCount * 10 + left.issueCount * 5 + left.networkCallCount;
    const rightScore = right.failingNetworkCallCount * 10 + right.issueCount * 5 + right.networkCallCount;
    return rightScore - leftScore;
  });
}

async function attachmentSize(
  traceContext: TraceContext,
  attachment: { sha1?: string; base64?: string; path?: string }
): Promise<number | null> {
  if (attachment.sha1) {
    const buffer = await getResourceBuffer(traceContext, attachment.sha1);
    if (buffer)
      return buffer.length;
  }

  if (attachment.base64)
    return Buffer.from(attachment.base64, 'base64').length;

  if (attachment.path && fs.existsSync(attachment.path)) {
    const stat = await fs.promises.stat(attachment.path);
    return stat.size;
  }

  return null;
}

async function attachmentContent(traceContext: TraceContext, attachment: AttachmentEntry): Promise<Buffer | null> {
  if (attachment.sha1) {
    const buffer = await getResourceBuffer(traceContext, attachment.sha1);
    if (buffer)
      return buffer;
  }

  if (attachment.base64)
    return Buffer.from(attachment.base64, 'base64');

  if (attachment.path && fs.existsSync(attachment.path))
    return fs.promises.readFile(attachment.path);

  return null;
}

function formatStackFrames(stack?: Array<{ file: string; line: number; column: number }>): string | null {
  if (!stack?.length)
    return null;
  return stack.map(frame => `at ${frame.file}:${frame.line}:${frame.column}`).join('\n');
}

async function getBrowserActions(traceContext: TraceContext): Promise<RelatedActionRef[]> {
  const files = await fs.promises.readdir(traceContext.traceDir);
  const traceFiles = files.filter(f => /^\d+-trace\.trace$/.test(f)).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  const actions = new Map<string, RelatedActionRef>();

  for (const traceFile of traceFiles) {
    const filePath = path.join(traceContext.traceDir, traceFile);
    for await (const event of readNdjson<TraceActionBeforeEvent | TraceActionAfterEvent>(filePath)) {
      if (event.type === 'before') {
        actions.set(event.callId, {
          callId: event.callId,
          title: event.title ?? `${event.class}.${event.method}`,
          method: event.method,
          pageId: event.pageId ?? null,
          startTime: event.startTime,
          endTime: null,
        });
        continue;
      }

      if (event.type === 'after') {
        const action = actions.get(event.callId);
        if (action)
          action.endTime = event.endTime;
      }
    }
  }

  return [...actions.values()].sort((a, b) => a.startTime - b.startTime);
}

function correlateAction(actions: RelatedActionRef[], timestamp: number, pageId: string | null): RelatedActionRef | null {
  let best: RelatedActionRef | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const action of actions) {
    if (pageId && action.pageId && action.pageId !== pageId)
      continue;

    const endTime = action.endTime ?? action.startTime;
    const withinWindow = timestamp >= action.startTime && timestamp <= endTime;
    const distance = withinWindow ? 0 : Math.min(
      Math.abs(timestamp - action.startTime),
      Math.abs(timestamp - endTime),
    );

    if (distance < bestDistance) {
      best = action;
      bestDistance = distance;
    }
  }

  return best;
}

function resolveIssueRelatedAction(
  actions: RelatedActionRef[],
  callId: string | null,
  timestamp: number,
  pageId: string | null,
): RelatedActionRef | null {
  if (callId) {
    const directMatch = actions.find(action => action.callId === callId);
    if (directMatch)
      return directMatch;
  }

  return correlateAction(actions, timestamp, pageId);
}

function filterNetworkEntries(entries: NetworkEntry[], options?: NetworkFilterOptions): NetworkEntry[] {
  if (!options)
    return entries;

  let filtered = entries;

  if (options.source && options.source !== 'all')
    filtered = filtered.filter(entry => entry.source === options.source);

  if (options.grep) {
    const pattern = new RegExp(options.grep, 'i');
    filtered = filtered.filter(entry => pattern.test(entry.url));
  }

  if (options.method)
    filtered = filtered.filter(entry => entry.method.toLowerCase() === options.method!.toLowerCase());

  if (options.status !== undefined)
    filtered = filtered.filter(entry => entry.status === options.status);

  if (options.failed)
    filtered = filtered.filter(entry => entry.status >= 400);

  if (options.near)
    filtered = filtered.filter(entry => entry.relatedAction?.callId === options.near);

  if (options.limit !== undefined)
    filtered = filtered.slice(0, options.limit);

  return filtered;
}

// ---------- getTimeline ----------

/**
 * A single event in the merged chronological timeline produced by getTimeline().
 */
export interface TimelineEntry {
  /** Wall-clock timestamp in milliseconds since epoch. */
  timestamp: number;
  /** Event category. */
  type: 'step' | 'screenshot' | 'dom' | 'network';
  /**
   * Payload. Cast based on `type`:
   * - `'step'`       → TestStep
   * - `'screenshot'` → ScreenshotMetadata
   * - `'dom'`        → ActionDomSnapshots
   * - `'network'`    → NetworkEntry
   */
  data: TestStep | ScreenshotMetadata | ActionDomSnapshots | NetworkEntry;
}

/**
 * Merges all trace event types (steps, screenshots, DOM snapshots, network
 * calls) into a single chronologically sorted array.
 *
 * This makes it trivial to build a narrative of what happened during a test —
 * all events share the same timeline without requiring manual timestamp
 * correlation across four separate API calls.
 *
 * Steps are flattened (all nesting levels included). Screenshots are metadata
 * only (no disk writes — use extractScreenshots() for that).
 */
export async function getTimeline(traceContext: TraceContext): Promise<TimelineEntry[]> {
  const [steps, screenshots, domSnapshots, network] = await Promise.all([
    getTestSteps(traceContext),
    getScreenshotMetadata(traceContext),
    getDomSnapshots(traceContext),
    getNetworkTraffic(traceContext),
  ]);

  const entries: TimelineEntry[] = [];

  for (const step of flattenSteps(steps)) {
    entries.push({ timestamp: step.startTime, type: 'step', data: step });
  }

  for (const shot of screenshots) {
    entries.push({ timestamp: shot.timestamp, type: 'screenshot', data: shot });
  }

  for (const dom of domSnapshots) {
    const ts = (dom.before ?? dom.action ?? dom.after)?.timestamp ?? 0;
    entries.push({ timestamp: ts, type: 'dom', data: dom });
  }

  for (const net of network) {
    entries.push({ timestamp: new Date(net.startedDateTime).getTime(), type: 'network', data: net });
  }

  entries.sort((a, b) => a.timestamp - b.timestamp);
  return entries;
}

// ---------- getTestTitle ----------

/** Internal event shape for context-options entries in numbered trace files. */
interface TraceEventContextOptions {
  type: 'context-options';
  title?: string;
}

/**
 * Extracts the full unique test title from the `context-options` event in a
 * numbered browser context trace file (e.g. `0-trace.trace`).
 *
 * The full title includes the spec file path, describe-block names, and test
 * name — e.g.:
 *   `"e2e/spec.ts:24 › Describe block › TC01 - should do something"`
 *
 * This is the canonical unique identifier for a test execution. Unlike root
 * step titles in `test.trace`, it is guaranteed to be unique across different
 * tests even when they share the same `test.step()` description.
 *
 * Returns `null` when no numbered trace file with a `context-options` title is
 * found (e.g. pure API traces with no browser context).
 */
export async function getTestTitle(traceContext: TraceContext): Promise<string | null> {
  const files = await fs.promises.readdir(traceContext.traceDir);
  const traceFiles = files
    .filter(f => /^\d+-trace\.trace$/.test(f))
    .sort((a, b) => parseInt(a) - parseInt(b));

  for (const traceFile of traceFiles) {
    const filePath = path.join(traceContext.traceDir, traceFile);
    for await (const event of readNdjson<TraceEventContextOptions>(filePath)) {
      if (event.type === 'context-options' && event.title) {
        return event.title;
      }
    }
  }

  return null;
}

// ---------- getSummary ----------

/**
 * A single-call bundle of the most commonly needed trace data, useful as a
 * starting point for any failure analysis.
 */
export interface TraceSummary {
  /**
   * Full unique test title from the `context-options` event in a numbered trace
   * file — includes spec file path, describe-block names, and test name.
   * Use this for deduplication across retries instead of `title`.
   * `null` for pure API traces with no browser context.
   */
  testTitle: string | null;
  /** Title of the top-level test step (from test.trace root step). */
  title: string;
  /** Whether the test passed or failed. */
  status: 'passed' | 'failed';
  /** Total test duration in ms, or null if unavailable. */
  durationMs: number | null;
  /** The top-level error, or null if passed. */
  error: TraceError | null;
  /** Non-hook root steps representing the visible test flow (test.step() blocks). */
  topLevelSteps: TestStep[];  /** Top 5 slowest steps across the entire tree. */
  slowestSteps: TestStep[];
  /** All HTTP calls (both Node.js APIRequestContext and browser XHR/fetch/navigation). */
  networkCalls: NetworkEntry[];
  /** Step, page, and trace issues captured for the trace. */
  issues: TraceIssue[];
  /** Aggregated diagnostics per related browser action. */
  actionDiagnostics: ActionDiagnosticSummary[];
  /** Metadata reference to the DOM snapshot closest to the failure, or null if passed. Use `dom --near <callId>` to retrieve full HTML. */
  failureDomSnapshot: FailureDomSnapshotRef | null;
  /**
   * Test outcome from the HTML report's `report.json` when available.
   * Populated when `reportMetadata` is passed to `getSummary()` or
   * automatically by `getFailedTestSummaries()`.
   *
   * - `'unexpected'` — the test failed (all retries exhausted)
   * - `'skipped'` — the test was skipped via `test.skip()`
   * - `'flaky'` — the test eventually passed after retries
   * - `'expected'` — the test passed (should not appear in failed summaries)
   * - `null` — outcome unknown (`reportMetadata` was `null` or trace SHA1 not found)
   */
  outcome: 'expected' | 'unexpected' | 'flaky' | 'skipped' | null;
}

/** Options for {@link getSummary}. */
export interface GetSummaryOptions {
  /**
   * Parsed report metadata from `getReportMetadata()`. When provided, the
   * returned `TraceSummary.outcome` is populated by matching the trace's SHA1
   * against test results in the report. Pass `null` when report metadata is
   * unavailable — `outcome` will be `null`.
   */
  reportMetadata: ReportMetadata | null;
  /**
   * Pre-built trace lookup maps from `buildReportTraceMaps()`. When provided,
   * avoids rebuilding the maps on every call — useful when calling `getSummary`
   * in a loop with the same report metadata. If omitted, maps are built
   * on-the-fly from `reportMetadata`.
   */
  reportTraceMaps?: ReportTraceMaps | null;
}

/**
 * Returns a TraceSummary bundling the most commonly needed trace data in one
 * call. Recommended as the starting point for any AI failure analysis —  it
 * covers the 90% case without requiring separate calls to getTestSteps(),
 * getNetworkTraffic(), and getDomSnapshots().
 */
export async function getSummary(traceContext: TraceContext, options: GetSummaryOptions): Promise<TraceSummary> {
  const [roots, network, domAll, testTitle, issues] = await Promise.all([
    getTestSteps(traceContext),
    getNetworkTraffic(traceContext),
    getDomSnapshots(traceContext),
    getTestTitle(traceContext),
    getTraceIssues(traceContext),
  ]);

  // Infrastructure steps injected by Playwright — not meaningful test content.
  const HOOK_TITLES = new Set([
    'Before Hooks', 'After Hooks',
    'Worker Cleanup', 'Worker Cleanup Hooks', 'Worker Setup',
  ]);
  const isHook = (s: TestStep) =>
    HOOK_TITLES.has(s.title) || s.title.startsWith('Attach "');

  // Test steps = non-infrastructure roots (the user-visible test.step() blocks)
  const testRoots = roots.filter(r => !isHook(r));

  // Main root: the failing step if any, otherwise the longest test step
  const mainRoot =
    testRoots.find(r => r.error !== null) ??
    testRoots.reduce<TestStep | null>(
      (best, r) => best === null || (r.durationMs ?? 0) > (best.durationMs ?? 0) ? r : best,
      null
    ) ??
    roots[0] ??
    null;

  const title = mainRoot?.title ?? 'Unknown';
  const status: 'passed' | 'failed' = roots.some(r => r.error !== null) ? 'failed' : 'passed';
  const durationMs = mainRoot?.durationMs ?? null;
  const error = mainRoot?.error ?? null;

  // topLevelSteps = visible test steps (non-hook roots)
  const topLevelSteps = testRoots;

  const allSteps = flattenSteps(roots);
  const slowestSteps = allSteps
    .filter(s => s.durationMs !== null)
    .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))
    .slice(0, 5);

  const networkCalls = network;
  const actionDiagnostics = buildActionDiagnostics(networkCalls, issues);

  let failureDomSnapshot: FailureDomSnapshotRef | null = null;
  if (error && mainRoot && domAll.length > 0) {
    const failureTime = mainRoot.endTime ?? mainRoot.startTime;
    const closest = domAll.reduce((best, current) => {
      const ct = (current.before ?? current.action ?? current.after)?.timestamp ?? 0;
      const cct = (best.before ?? best.action ?? best.after)?.timestamp ?? 0;
      return Math.abs(ct - failureTime) < Math.abs(cct - failureTime) ? current : best;
    }, domAll[0]!);

    const phases: Array<'before' | 'action' | 'after'> = [];
    if (closest.before) phases.push('before');
    if (closest.action) phases.push('action');
    if (closest.after) phases.push('after');
    const primary = closest.action ?? closest.before ?? closest.after;

    failureDomSnapshot = {
      callId: closest.callId,
      phases,
      timestamp: primary?.timestamp ?? 0,
      frameUrl: primary?.frameUrl ?? null,
      targetElement: primary?.targetElement ?? null,
    };
  }

  return {
    testTitle,
    title,
    status,
    durationMs,
    error,
    topLevelSteps,
    slowestSteps,
    networkCalls,
    issues,
    actionDiagnostics,
    failureDomSnapshot,
    outcome: options.reportMetadata
      ? (options.reportTraceMaps ?? buildReportTraceMaps(options.reportMetadata)).outcomeByTraceSha1.get(path.basename(traceContext.traceDir)) as TraceSummary['outcome'] ?? null
      : null,
  };
}

// ---------- getFailedTestSummaries ----------

/**
 * Options for {@link getFailedTestSummaries}.
 */
export interface GetFailedTestSummariesOptions {
  /**
   * When `true`, excludes tests that were skipped via `test.skip()`.
   *
   * Detection strategy (in priority order):
   * 1. **`report.json`** (authoritative) — the HTML report embeds a ZIP with
   *    structured test metadata. Each test result's `attachments` array
   *    contains `{ name: "trace", path: "data/<sha1>.zip" }` entries that
   *    map directly to trace directories by SHA1 basename. If `index.html`
   *    is found, skipped tests are identified by `outcome === 'skipped'`
   *    and matched to traces via this SHA1 mapping.
   * 2. **Trace heuristic** (fallback) — when `index.html` is not available,
   *    falls back to checking trace step data: a `{ type: 'skip' }` annotation
   *    or an error message containing `"Test is skipped:"`.
   *
   * Pre-annotated skips (suite-level annotations or conditional
   * `test.skip(condition)` evaluated before the test body) are already
   * excluded unconditionally because they produce no root-step failures.
   */
  excludeSkipped?: boolean;
}

export interface FailedTraceSelection {
  tracePath: string;
  traceSha1: string;
  summary: TraceSummary;
}

export async function getFailedTraceSelections(
  reportDataDir: string,
  options?: GetFailedTestSummariesOptions,
): Promise<FailedTraceSelection[]> {
  const traces = await listTraces(reportDataDir);

  const meta = await getReportMetadata(reportDataDir);
  const traceMaps = meta ? buildReportTraceMaps(meta) : null;
  const outcomeByTraceSha1 = traceMaps?.outcomeByTraceSha1 ?? null;
  const testIdByTraceSha1 = traceMaps?.testIdByTraceSha1 ?? null;

  type CtxMeta = { ctx: TraceContext; latestEndTime: number };
  const byKey = new Map<string, CtxMeta>();

  for (const ctx of traces) {
    const topFailures = await getTopLevelFailures(ctx);
    if (topFailures.length === 0) continue;

    const sha1 = path.basename(ctx.traceDir);
    const outcome = outcomeByTraceSha1?.get(sha1) ?? null;

    if (options?.excludeSkipped) {
      let isSkipped = false;

      if (outcomeByTraceSha1) {
        if (outcome === 'skipped') isSkipped = true;
      } else {
        isSkipped = topFailures.every(
          f => f.annotations.some(a => a.type === 'skip') ||
               f.error?.message?.includes('Test is skipped:'),
        );
      }

      if (isSkipped) continue;
    }

    const testId = testIdByTraceSha1?.get(sha1);
    const key = testId ?? (await getTestTitle(ctx)) ?? ctx.traceDir;

    const latestEndTime = topFailures.reduce(
      (max, s) => Math.max(max, s.endTime ?? s.startTime ?? 0),
      0,
    );

    const existing = byKey.get(key);
    if (!existing || latestEndTime > existing.latestEndTime) {
      byKey.set(key, { ctx, latestEndTime });
    }
  }

  const results: FailedTraceSelection[] = [];
  for (const { ctx } of byKey.values()) {
    const summary = await getSummary(ctx, { reportMetadata: meta, reportTraceMaps: traceMaps });
    results.push({
      tracePath: ctx.traceDir,
      traceSha1: path.basename(ctx.traceDir),
      summary,
    });
  }

  return results;
}

/**
 * High-level report-level helper: finds all **unique** failing tests across
 * an entire Playwright report data directory and returns a `TraceSummary` for
 * each one.
 *
 * Each returned `TraceSummary` has an `outcome` field populated from `report.json`
 * when `index.html` is available:
 * - `'unexpected'` — the test failed (all retries exhausted)
 * - `'skipped'` — the test was skipped via `test.skip()`
 * - `'flaky'` — the test eventually passed after retries
 * - `null` — `report.json` not available
 *
 * Handles three tricky cases automatically:
 * - **Passing tests**: skipped cheaply (no `getSummary` call) by checking
 *   `getTopLevelFailures()` first.
 * - **Retries**: deduplicated by `testId` from `report.json` (when available),
 *   falling back to `getTestTitle()` or `ctx.traceDir`. When multiple retries
 *   exist for the same test, the **last retry** (highest root step `endTime`)
 *   is used — it reflects the most recent execution and has the most relevant
 *   DOM snapshot and network traffic for debugging.
 * - **Pure API traces** (no browser context, so `getTestTitle` returns `null`):
 *   deduplicated by `testId` from `report.json` when available (same as browser
 *   traces), falling back to `ctx.traceDir` only when `report.json` is absent.
 *
 * @param reportDataDir  Path to the `playwright-report/data/` directory.
 * @param options        Optional filtering options.
 * @returns `TraceSummary[]` for each unique failing test (one per unique test).
 */
export async function getFailedTestSummaries(reportDataDir: string, options?: GetFailedTestSummariesOptions): Promise<TraceSummary[]> {
  const selections = await getFailedTraceSelections(reportDataDir, options);
  return selections.map(selection => selection.summary);
}

