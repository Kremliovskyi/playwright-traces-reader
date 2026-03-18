---
name: analyze-playwright-traces
description: Analyze Playwright test traces to find test failures, extract network request/response payloads, identify slow steps, locate UI screenshots, and inspect DOM state before/during/after each browser action.
---

# Analyze Playwright Traces

Use this skill when the user asks about test failures, API payloads in tests, slow steps, or UI screenshots from Playwright test runs.

## Prerequisites

This skill requires the `@kremlovskyi/playwright-traces-reader` npm package in the project:
```bash
npm install @andrii_kremlovskyi/playwright-traces-reader
```

And a built trace directory under `playwright-report/data/<sha1>/` (or a `.zip` of the same).

## How to Use

### 1. Find failed tests

Use `getFailedTestSummaries()` — a single call that returns `TraceSummary[]` for every **unique** failing test in a report. It handles three tricky cases internally:

- **Passing tests** skipped cheaply (no full summary built)
- **Retries** deduplicated by the full unique title from `context-options` (spec path + describe + test name). The **last retry** is used — highest root step `endTime` — so the summary reflects the most recent execution with the most relevant DOM snapshot and network traffic
- **Pure API traces** (no browser context) deduplicated by trace directory name

```typescript
import { getFailedTestSummaries } from '@andrii_kremlovskyi/playwright-traces-reader';

const failures = await getFailedTestSummaries('/path/to/playwright-report/data');
// failures.length = number of distinct failing tests
// Retries and passing tests are already excluded

console.log(`Unique failed tests: ${failures.length}`);
for (const f of failures) {
  console.log(`FAILED: ${f.testTitle ?? f.title}`);
  console.log(`Error: ${f.error?.message}`);
}
```

### 2. Inspect failure details

Each item returned by `getFailedTestSummaries()` is a `TraceSummary` — it already contains everything needed for failure analysis. No second call required.

```typescript
import { getFailedTestSummaries } from '@andrii_kremlovskyi/playwright-traces-reader';

const failures = await getFailedTestSummaries('/path/to/playwright-report/data');

for (const f of failures) {
  console.log(`[FAILED] ${f.testTitle ?? f.title}`);
  console.log(`Duration: ${f.durationMs}ms`);
  console.log(`Error: ${f.error?.message}`);

  console.log('Test steps:');
  for (const step of f.topLevelSteps) {
    const failed = step.error ? ' ✗' : '';
    console.log(`  ${step.title} (${step.durationMs}ms)${failed}`);
  }

  console.log('Slowest 5 steps:');
  for (const step of f.slowestSteps) {
    console.log(`  ${step.durationMs}ms — ${step.title}`);
  }

  console.log(`Network calls: ${f.networkCalls.length}`);
  for (const call of f.networkCalls) {
    console.log(`  ${call.method} ${call.url} → ${call.status}`);
  }

  if (f.failureDomSnapshot?.after) {
    // DOM state at the time of failure — AI-readable HTML
    console.log('DOM at failure:', f.failureDomSnapshot.after.html.slice(0, 500));
  }

  // Drill into the nested step tree to find the specific failing assertion/action
  function collectErrors(steps, out = []) {
    for (const s of steps) {
      if (s.error) out.push(s);
      collectErrors(s.children, out);
    }
    return out;
  }
  const deepFailures = f.topLevelSteps.flatMap(s => collectErrors(s.children));
  for (const s of deepFailures) {
    console.log(`  nested failure: ${s.title} — ${s.error.message}`);
  }
}
```

`TraceSummary` fields:
- **`testTitle`** — **full unique test title** from `context-options` (spec path + describe + test name). Use for display. `null` for pure API traces with no browser context.
- **`title`** — root `test.step()` title (from `test.trace`). The failing step or longest non-hook step.
- **`status`** — `'passed'` | `'failed'`
- **`durationMs`** — duration of the main test step
- **`error`** — the top-level error, or `null` if passed
- **`topLevelSteps`** — non-hook root steps (the visible `test.step()` blocks), each with `.children` for drilling down
- **`slowestSteps`** — top 5 slowest steps across the full step tree
- **`networkCalls`** — all HTTP calls made during the test (`source: 'api'` = Node.js `APIRequestContext`; `source: 'browser'` = XHR / fetch / navigation)
- **`failureDomSnapshot`** — `ActionDomSnapshots` closest in time to the failure, or `null`

### 3. Find slow steps

```typescript
import { prepareTraceDir, getTestSteps } from '@andrii_kremlovskyi/playwright-traces-reader';

const ctx = await prepareTraceDir('/path/to/trace-dir');
const steps = await getTestSteps(ctx);

function flatten(steps: TestStep[], out: TestStep[] = []): TestStep[] {
  for (const s of steps) { out.push(s); flatten(s.children, out); }
  return out;
}

const allSteps = flatten(steps);
const sorted = allSteps
  .filter(s => s.durationMs !== null)
  .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0));

console.log('Top 5 slowest steps:');
sorted.slice(0, 5).forEach(s => console.log(`  ${s.durationMs}ms — ${s.title}`));
```

> **Shortcut**: `getSummary()` already returns the top 5 slowest steps in `summary.slowestSteps` — no manual flattening needed.

### 4. Extract network traffic

```typescript
import { prepareTraceDir, getNetworkTraffic } from '@andrii_kremlovskyi/playwright-traces-reader';

const ctx = await prepareTraceDir('/path/to/trace-dir');
const traffic = await getNetworkTraffic(ctx);

for (const call of traffic) {
  console.log(`[${call.source}] ${call.method} ${call.url} → ${call.status}`);
  if (call.responseBody) console.log('Response:', call.responseBody.slice(0, 500));
}

// Filter by source if needed:
const apiOnly = traffic.filter(e => e.source === 'api');      // Node.js APIRequestContext
const browserOnly = traffic.filter(e => e.source === 'browser'); // XHR / fetch / navigation
```

### 5. Extract screenshots for human visual inspection

> **AI agent limitation**: AI agents cannot read or understand JPEG/PNG image files from disk. `extractScreenshots()` is for **human visual inspection only** — open the `savedPath` files in your image viewer. For AI analysis of UI state, use `getDomSnapshots()` (section 6), which returns full HTML that an AI can read and reason about.

```typescript
import { prepareTraceDir, extractScreenshots } from '@andrii_kremlovskyi/playwright-traces-reader';
import * as os from 'os';

const ctx = await prepareTraceDir('/path/to/trace-dir');
const screenshots = await extractScreenshots(ctx, `${os.tmpdir()}/pw-screenshots`);

for (const s of screenshots) {
  console.log(`Screenshot at ${s.timestamp}ms: ${s.savedPath}`);
}
// Open savedPath files in an image viewer for visual inspection
// An AI agent cannot interpret these files — use getDomSnapshots() for AI analysis
```

### 6. Inspect DOM state before/during/after each action

`getDomSnapshots()` accepts an optional `options` argument to filter the results — especially useful for long traces with many snapshots.

```typescript
import { prepareTraceDir, getDomSnapshots } from '@andrii_kremlovskyi/playwright-traces-reader';

const ctx = await prepareTraceDir('/path/to/trace-dir');

// Full list (may be large — 40+ entries per trace)
const all = await getDomSnapshots(ctx);

// Most useful for AI failure analysis: just the last 3 actions before the test ended
const last3 = await getDomSnapshots(ctx, { near: 'last', limit: 3 });

// Window of 5 entries around a specific action (e.g. from getSummary().failureDomSnapshot.callId)
const window = await getDomSnapshots(ctx, { near: 'call@585', limit: 5 });

// Only 'after' phase snapshots (post-action DOM state, most useful for debugging)
const afterOnly = await getDomSnapshots(ctx, { phase: 'after' });

for (const action of last3) {
  const snap = action.after ?? action.before;
  if (!snap) continue;
  console.log(`callId: ${action.callId} | url: ${snap.frameUrl}`);
  if (snap.targetElement) {
    console.log(`  targeted element (callId attr): ${snap.targetElement}`);
  }
  console.log(`  DOM snippet: ${snap.html.slice(0, 300)}`);
}
```

`DomSnapshotOptions`:
- `near: 'last'` — return the last `limit` entries (default 5). Best for "what was the page doing just before it failed?"
- `near: 'call@N'` — return a window of `limit` entries centred on that callId
- `phase: 'before' | 'action' | 'after'` — filter to one snapshot phase
- `limit: number` — max entries to return; meaning varies by `near` (see above), or caps from the beginning when `near` is omitted

Each `DomSnapshot` includes:
- `html` — full serialized HTML string (back-references resolved, `<script>` tags stripped)
- `phase` — `"before"` | `"action"` | `"after"`
- `frameUrl` — URL of the page frame at snapshot time
- `targetElement` — `callId` of the action that targeted an element (from `__playwright_target__` attr), or `null`
- `viewport` — `{ width, height }` at snapshot time

### 7. Get a merged chronological timeline

`getTimeline()` merges all event types into a single chronologically sorted array, eliminating the need for manual timestamp correlation across four separate API calls.

```typescript
import { prepareTraceDir, getTimeline } from '@andrii_kremlovskyi/playwright-traces-reader';
import type { TestStep, ScreenshotMetadata, ActionDomSnapshots, NetworkEntry } from '@andrii_kremlovskyi/playwright-traces-reader';

const ctx = await prepareTraceDir('/path/to/trace-dir');
const timeline = await getTimeline(ctx);

for (const entry of timeline) {
  switch (entry.type) {
    case 'step': {
      const step = entry.data as TestStep;
      console.log(`[step]       ${step.title} (${step.durationMs}ms)`);
      break;
    }
    case 'screenshot': {
      const shot = entry.data as ScreenshotMetadata;
      // No savedPath — call extractScreenshots() if you need the files
      console.log(`[screenshot] sha1=${shot.sha1}`);
      break;
    }
    case 'dom': {
      const dom = entry.data as ActionDomSnapshots;
      console.log(`[dom]        callId=${dom.callId}`);
      break;
    }
    case 'network': {
      const net = entry.data as NetworkEntry;
      console.log(`[network]    ${net.method} ${net.url} → ${net.status}`);
      break;
    }
  }
}

// Focus on the last events before the test ended
for (const entry of timeline.slice(-10)) {
  console.log(`[${entry.type}] @${entry.timestamp}`);
}
```

`TimelineEntry` fields:
- `timestamp` — wall-clock time in milliseconds since epoch
- `type` — `'step'` | `'screenshot'` | `'dom'` | `'network'`
- `data` — cast based on `type` (see above)

> Note: screenshot entries in the timeline are `ScreenshotMetadata` (no `savedPath`). Screenshots are metadata-only to avoid unexpected disk writes. Call `extractScreenshots()` separately if you need the files.

## Locating Trace Directories

A Playwright report's `data/` directory holds **one SHA1 entry per test execution** (including retries). `getFailedTestSummaries()` handles this automatically. For lower-level iteration use `listTraces()`:

```typescript
import { listTraces, getSummary } from '@andrii_kremlovskyi/playwright-traces-reader';

// Works for 1 test or many — automatically discovers all SHA1 trace entries (dirs and zips)
const traces = await listTraces('/path/to/playwright-report/data');

for (const ctx of traces) {
  const summary = await getSummary(ctx);
  // ... process results per test (includes passing, failing, and retries)
}
```

Each entry is either a directory (already extracted) or a `.zip` (auto-extracted). Non-trace files in `data/` (`.md`, `.png`, etc.) are ignored automatically.

## Low-Level Utilities

### `getSummary(ctx)`

Builds a `TraceSummary` for a single `TraceContext`. Use this when you already have a specific `ctx` (e.g. from `listTraces()` without filtering). For report-level failure analysis, prefer `getFailedTestSummaries()` which calls this internally only for unique failures.

```typescript
import { prepareTraceDir, getSummary } from '@andrii_kremlovskyi/playwright-traces-reader';

const ctx = await prepareTraceDir('/path/to/trace-dir');
const summary = await getSummary(ctx);
console.log(`[${summary.status.toUpperCase()}] ${summary.testTitle ?? summary.title}`);
```

### `prepareTraceDir(tracePath)`

Takes a single path (directory or `.zip`) and returns a `TraceContext`. Use this when you have a specific trace path rather than a whole `data/` directory.

```typescript
import { prepareTraceDir } from '@kremlovskyi/playwright-traces-reader';

const ctx = await prepareTraceDir('/path/to/playwright-report/data/<sha1>');
// or a zip:
const ctx = await prepareTraceDir('/path/to/playwright-report/data/<sha1>.zip');
```

### `getResourceBuffer(ctx, sha1)`

Resolves a SHA1 filename to its raw `Buffer` from the trace's `resources/` directory. Returns `null` if the blob is not found. Useful when you need the raw bytes of a request/response body or a screenshot blob.

```typescript
import { prepareTraceDir, getResourceBuffer } from '@andrii_kremlovskyi/playwright-traces-reader';

const ctx = await prepareTraceDir('/path/to/trace-dir');
const buf = await getResourceBuffer(ctx, 'a1b2c3d4...');
if (buf) {
  // e.g. write to disk, pass to an image model, etc.
  console.log(`blob size: ${buf.byteLength} bytes`);
}
```

### `readNdjson<T>(filePath)`

Async generator that streams and parses an NDJSON file line by line. Silently skips malformed lines. Useful for reading raw trace events when the built-in extractors don't cover your use case.

```typescript
import { prepareTraceDir, readNdjson } from '@andrii_kremlovskyi/playwright-traces-reader';
import * as path from 'path';

const ctx = await prepareTraceDir('/path/to/trace-dir');
const traceFile = path.join(ctx.traceDir, '0-trace.trace');

for await (const event of readNdjson<{ type: string }>(traceFile)) {
  if (event.type === 'screencast-frame') {
    console.log('screencast frame:', event);
  }
}
```

## Execution Pattern

All code snippets in this skill use ES module `import` syntax. Write them to a temporary `.mjs` file and execute with Node.js — the `.mjs` extension tells Node to treat the file as an ES module without requiring a `package.json` change.

**Recommended workflow (works on macOS, Linux, and Windows):**

1. Use the `create_file` tool to write the script to a fixed filename:
   ```
   <workspace-root>/__trace_analysis__.mjs
   ```
2. Run it:
   ```bash
   node __trace_analysis__.mjs
   ```
3. Clean up after the session:
   ```bash
   # macOS / Linux
   rm __trace_analysis__.mjs
   # Windows PowerShell
   Remove-Item __trace_analysis__.mjs
   ```

Using a fixed, recognisable filename makes it easy to spot and clean up if the agent session ends unexpectedly.

## Tips

- **Starting point for report-level failures**: Use `getFailedTestSummaries(dataDir)` — returns `TraceSummary[]` for every unique failing test with retries deduplicated and passing tests excluded. The returned `TraceSummary` already contains steps, API calls, and the DOM snapshot at failure.
- **Starting point for per-context analysis**: Use `getSummary(ctx)` on a specific `TraceContext` from `listTraces()` — it gives `testTitle`, status, error, slowest steps, API calls, and the DOM snapshot closest to the failure in one call.
- **Accurate failure count**: `getFailedTestSummaries()` deduplicates by the full Playwright title (spec path + describe + test name from `context-options`), correctly identifying 13 unique tests even when 23 traces exist (10 failed × 2 retries + 3 flaky × 1 trace). Using root step titles (`f.title`) would under-count when different tests share the same `test.step()` description.
- **Drill into failures**: Each `TestStep` in `topLevelSteps` includes `.children`. Walk them recursively to find the specific assertion or action that failed within the test.
- **Failures**: The `error.message` in a `TraceSummary` contains the full diff for assertion failures.
- **Network issues**: `summary.networkCalls` contains all HTTP calls (API and browser). Filter by `source === 'api'` for Node.js `APIRequestContext` calls or `source === 'browser'` for XHR/fetch/navigation. Check `status >= 400` for HTTP errors.
- **Slow tests**: `getSummary().slowestSteps` gives top 5 instantly. For the full picture use `getTestSteps()` and sort by `durationMs`.
- **Visual state (AI)**: Use `getDomSnapshots()` with `{ near: 'last', limit: 3 }` — returns full HTML that an AI can read and reason about. `failureDomSnapshot` on each `TraceSummary` gives the DOM closest to the failure directly.
- **Visual state (human)**: Use `extractScreenshots()` to get JPEG files for human inspection in an image viewer. AI agents cannot read image files from disk.
- **Timeline**: Use `getTimeline()` to build a chronological narrative merging steps, screenshots, DOM snapshots, and network calls — ideal for correlating what was happening at the exact moment of failure.
