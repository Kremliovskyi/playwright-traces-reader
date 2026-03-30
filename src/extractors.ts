import * as fs from 'fs';
import * as path from 'path';
import { readNdjson, getResourceBuffer, listTraces, getReportMetadata, type TraceContext } from './parseTrace';

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
  source: 'browser' | 'api';
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
  durationMs: number;
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
export async function getNetworkTraffic(traceContext: TraceContext): Promise<NetworkEntry[]> {
  const entries: NetworkEntry[] = [];

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
          if (buf) requestBody = buf.toString('utf8');
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
        source,
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
        durationMs: snap.time,
      });
    }
  }

  return entries;
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

/**
 * Resolves a snapshot node tree into an HTML string.
 *
 * `snapshotIndex` is the 0-based index of the current snapshot in `frameHistory`.
 * `frameHistory` is the ordered list of all raw snapshot HTMLs seen so far for
 * this frame (current snapshot is already appended before this call).
 * `dfsCache` is a memoization cache shared across the entire trace-file pass to
 * avoid rebuilding the same DFS node lists repeatedly.
 *
 * Back-references `[[offset, nodeIdx]]` are resolved as:
 *   refIndex = snapshotIndex - offset
 *   node     = snapshotNodes(frameHistory[refIndex])[nodeIdx]
 */
function resolveSnapshotNode(
  node: SnapshotNode,
  snapshotIndex: number,
  frameHistory: SnapshotNode[],
  dfsCache: Map<SnapshotNode, SnapshotNode[]>
): string {
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
      const nodes = buildSnapshotNodeList(refHtml, dfsCache);
      if (nodeIdx >= 0 && nodeIdx < nodes.length) {
        return resolveSnapshotNode(nodes[nodeIdx]!, refIndex, frameHistory, dfsCache);
      }
    }
    return `<!-- ref: [${offset}, ${nodeIdx}] unresolved -->`;
  }

  // Element node: [tagName, attrs, ...children]
  const [tagName, attrs, ...children] = node as [string, Record<string, string>, ...SnapshotNode[]];
  if (typeof tagName !== 'string') return '';

  const tag = tagName.toLowerCase();
  if (tag === 'script') return '';  // not useful for AI analysis

  const attrStr = attrs && typeof attrs === 'object' && !Array.isArray(attrs)
    ? Object.entries(attrs)
        .filter(([k]) => !k.startsWith('__playwright'))
        .map(([k, v]) => ` ${k}="${escapeAttr(String(v))}"`)
        .join('')
    : '';

  if (VOID_TAGS.has(tag)) {
    return `<${tag}${attrStr}>`;
  }

  const inner = children.map(c => resolveSnapshotNode(c, snapshotIndex, frameHistory, dfsCache)).join('');
  return `<${tag}${attrStr}>${inner}</${tag}>`;
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

  // Per-frame snapshot history: frameId → ordered list of raw html nodes
  const frameHistory = new Map<string, SnapshotNode[]>();

  // Memoization cache for buildSnapshotNodeList — keyed by html object reference
  const dfsCache = new Map<SnapshotNode, SnapshotNode[]>();

  // Collect resolved snapshots keyed by callId → phase
  const rawByCallId = new Map<string, Map<string, DomSnapshot>>();

  for (const traceFile of traceFiles) {
    const filePath = path.join(traceContext.traceDir, traceFile);

    for await (const event of readNdjson<RawFrameSnapshot>(filePath)) {
      if (event.type !== 'frame-snapshot') continue;
      const snap = event.snapshot;

      const { snapshotName, callId, frameId, frameUrl, pageId, viewport, timestamp, html } = snap;

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

      // Append to per-frame history BEFORE resolving (so refs can point back to it)
      if (!frameHistory.has(frameId)) frameHistory.set(frameId, []);
      const history = frameHistory.get(frameId)!;
      history.push(html);
      const snapshotIndex = history.length - 1;

      // Resolve the full html to a string using the correct ref algorithm
      const resolvedHtml = resolveSnapshotNode(html, snapshotIndex, history, dfsCache);

      // Extract the __playwright_target__ attribute to identify the targeted element
      const targetElement = findPlaywrightTarget(html);

      const domSnapshot: DomSnapshot = {
        callId,
        phase,
        snapshotName,
        frameId,
        frameUrl,
        pageId,
        timestamp,
        viewport,
        html: resolvedHtml,
        targetElement,
      };

      if (!rawByCallId.has(callId)) rawByCallId.set(callId, new Map());
      rawByCallId.get(callId)!.set(phase, domSnapshot);
    }
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

/** Recursively searches the snapshot tree for a node with __playwright_target__ */
function findPlaywrightTarget(node: SnapshotNode): string | null {
  if (!Array.isArray(node) || node.length < 2) return null;
  const attrs = node[1];
  if (attrs && typeof attrs === 'object' && !Array.isArray(attrs)) {
    const target = (attrs as Record<string, string>)['__playwright_target__'];
    if (target) return target;
  }
  for (let i = 2; i < node.length; i++) {
    const child = node[i];
    if (Array.isArray(child)) {
      const found = findPlaywrightTarget(child as SnapshotNode[]);
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
  /** The DOM snapshot (before/action/after) closest in time to the failure, or null if passed. */
  failureDomSnapshot: ActionDomSnapshots | null;
  /**
   * Test outcome from the HTML report's `report.json` when available.
   * Populated by `getFailedTestSummaries()` — always `null` from `getSummary()` directly.
   *
   * - `'unexpected'` — the test failed (all retries exhausted)
   * - `'skipped'` — the test was skipped via `test.skip()`
   * - `'flaky'` — the test eventually passed after retries
   * - `'expected'` — the test passed (should not appear in failed summaries)
   * - `null` — outcome unknown (`report.json` not available)
   */
  outcome: 'expected' | 'unexpected' | 'flaky' | 'skipped' | null;
}

/**
 * Returns a TraceSummary bundling the most commonly needed trace data in one
 * call. Recommended as the starting point for any AI failure analysis —  it
 * covers the 90% case without requiring separate calls to getTestSteps(),
 * getNetworkTraffic(), and getDomSnapshots().
 */
export async function getSummary(traceContext: TraceContext): Promise<TraceSummary> {
  const [roots, network, domAll, testTitle] = await Promise.all([
    getTestSteps(traceContext),
    getNetworkTraffic(traceContext),
    getDomSnapshots(traceContext),
    getTestTitle(traceContext),
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

  let failureDomSnapshot: ActionDomSnapshots | null = null;
  if (error && mainRoot && domAll.length > 0) {
    const failureTime = mainRoot.endTime ?? mainRoot.startTime;
    failureDomSnapshot = domAll.reduce((closest, current) => {
      const ct = (current.before ?? current.action ?? current.after)?.timestamp ?? 0;
      const cct = (closest.before ?? closest.action ?? closest.after)?.timestamp ?? 0;
      return Math.abs(ct - failureTime) < Math.abs(cct - failureTime) ? current : closest;
    }, domAll[0]!);
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
    failureDomSnapshot,
    outcome: null,
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
  const traces = await listTraces(reportDataDir);

  // Always try to load report.json for:
  // 1. Authoritative outcome data (skip detection + TraceSummary.outcome)
  // 2. testId-based dedup (fixes null-title API traces having duplicate retries)
  let outcomeByTraceSha1: Map<string, string> | null = null;
  let testIdByTraceSha1: Map<string, string> | null = null;
  const meta = await getReportMetadata(reportDataDir);
  if (meta) {
    outcomeByTraceSha1 = new Map();
    testIdByTraceSha1 = new Map();
    for (const file of meta.files) {
      for (const t of file.tests) {
        for (const result of t.results) {
          for (const att of result.attachments) {
            if (att.name === 'trace' && att.path) {
              // att.path is like "data/<sha1>.zip"
              const sha1 = path.basename(att.path, '.zip');
              outcomeByTraceSha1.set(sha1, t.outcome);
              testIdByTraceSha1.set(sha1, t.testId);
            }
          }
        }
      }
    }
  }

  // --- Pass 1: group failing trace contexts by unique test key ---
  // Multiple contexts with the same key are retries of the same test.
  // We keep track of the latest end time seen for each key so we can
  // select the last retry (the most recent execution) in Pass 2.
  type Outcome = TraceSummary['outcome'];
  type CtxMeta = { ctx: TraceContext; latestEndTime: number; outcome: Outcome };
  const byKey = new Map<string, CtxMeta>();

  for (const ctx of traces) {
    // Cheap check — reads only test.trace. Skip passing tests immediately.
    const topFailures = await getTopLevelFailures(ctx);
    if (topFailures.length === 0) continue;

    const sha1 = path.basename(ctx.traceDir);
    const outcome: Outcome = outcomeByTraceSha1?.get(sha1) as Outcome ?? null;

    // Exclude skipped tests when requested.
    if (options?.excludeSkipped) {
      let isSkipped = false;

      if (outcomeByTraceSha1) {
        if (outcome === 'skipped') isSkipped = true;
      } else {
        // Fallback heuristic when report.json is unavailable:
        // check step annotations and error messages.
        isSkipped = topFailures.every(
          f => f.annotations.some(a => a.type === 'skip') ||
               f.error?.message?.includes('Test is skipped:'),
        );
      }

      if (isSkipped) continue;
    }

    // Dedup key: testId from report.json (works for all trace types including
    // API-only), then getTestTitle, then traceDir as last resort.
    const testId = testIdByTraceSha1?.get(sha1);
    const key = testId ?? (await getTestTitle(ctx)) ?? ctx.traceDir;

    // Use the latest endTime of any root step as the proxy for when this
    // retry finished. Fall back to 0 if no step has an endTime.
    const latestEndTime = topFailures.reduce(
      (max, s) => Math.max(max, s.endTime ?? s.startTime ?? 0),
      0,
    );

    const existing = byKey.get(key);
    if (!existing || latestEndTime > existing.latestEndTime) {
      byKey.set(key, { ctx, latestEndTime, outcome });
    }
  }

  // --- Pass 2: build summaries only for the last retry of each unique failure ---
  const results: TraceSummary[] = [];
  for (const { ctx, outcome } of byKey.values()) {
    const summary = await getSummary(ctx);
    results.push({ ...summary, outcome });
  }

  return results;
}

