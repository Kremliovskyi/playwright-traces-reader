import * as fs from 'fs';
import * as path from 'path';
import { readNdjson, getResourceBuffer, type TraceContext } from './parseTrace';

// ---------- Types ----------

export interface TestStep {
  callId: string;
  parentId: string | null;
  title: string;
  method: string;
  startTime: number;
  endTime: number | null;
  durationMs: number | null;
  error: TraceError | null;
  children: TestStep[];
}

export interface TraceError {
  name: string;
  message: string;
  stack?: string;
}

export interface FailedStep {
  callId: string;
  title: string;
  error: TraceError;
  durationMs: number | null;
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
  annotations: unknown[];
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
      }
    }
  }

  return roots;
}

// ---------- getFailedTests ----------

/**
 * Scans test.trace for steps that have errors.
 * Returns a flat list of all steps (at any nesting level) that failed,
 * with the error details and duration.
 */
export async function getFailedTests(traceContext: TraceContext): Promise<FailedStep[]> {
  const roots = await getTestSteps(traceContext);
  const failed: FailedStep[] = [];

  function collect(steps: TestStep[]): void {
    for (const step of steps) {
      if (step.error) {
        failed.push({
          callId: step.callId,
          title: step.title,
          error: step.error,
          durationMs: step.durationMs,
        });
      }
      collect(step.children);
    }
  }

  collect(roots);
  return failed;
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
export async function getDomSnapshots(traceContext: TraceContext): Promise<ActionDomSnapshots[]> {
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
  const result: ActionDomSnapshots[] = [];
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

