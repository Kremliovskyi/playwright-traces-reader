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

### 1. Find failed tests and error details

```typescript
import { prepareTraceDir, getFailedTests } from '@andrii_kremlovskyi/playwright-traces-reader';

const ctx = await prepareTraceDir('/path/to/playwright-report/data/<sha1>');
const failures = await getFailedTests(ctx);

for (const f of failures) {
  console.log(`FAILED: ${f.title}`);
  console.log(`Error: ${f.error.message}`);
  console.log(`Duration: ${f.durationMs}ms`);
}
```

### 2. Find slow steps

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

### 3. Extract API request/response bodies

```typescript
import { prepareTraceDir, getNetworkTraffic } from '@andrii_kremlovskyi/playwright-traces-reader';

const ctx = await prepareTraceDir('/path/to/trace-dir');
const traffic = await getNetworkTraffic(ctx);

// Filter only API (Node.js APIRequestContext) calls
const apiCalls = traffic.filter(e => e.source === 'api');
for (const call of apiCalls) {
  console.log(`${call.method} ${call.url} → ${call.status}`);
  if (call.responseBody) console.log('Response:', call.responseBody.slice(0, 500));
}
```

### 4. Extract screenshots for visual inspection

```typescript
import { prepareTraceDir, extractScreenshots } from '@andrii_kremlovskyi/playwright-traces-reader';
import * as os from 'os';

const ctx = await prepareTraceDir('/path/to/trace-dir');
const screenshots = await extractScreenshots(ctx, `${os.tmpdir()}/pw-screenshots`);

for (const s of screenshots) {
  console.log(`Screenshot at ${s.timestamp}ms: ${s.savedPath}`);
}
// Pass savedPath to your image viewer or AI model for visual inspection
```

### 5. Inspect DOM state before/during/after each action

```typescript
import { prepareTraceDir, getDomSnapshots } from '@andrii_kremlovskyi/playwright-traces-reader';

const ctx = await prepareTraceDir('/path/to/trace-dir');
const snapshots = await getDomSnapshots(ctx);

for (const action of snapshots) {
  // action.before — DOM before the action
  // action.action — DOM during the action (mid-interaction state)
  // action.after  — DOM after the action
  const snap = action.after ?? action.before;
  if (!snap) continue;

  console.log(`callId: ${action.callId} | url: ${snap.frameUrl}`);
  if (snap.targetElement) {
    console.log(`  targeted element (callId attr): ${snap.targetElement}`);
  }
  console.log(`  DOM snippet: ${snap.html.slice(0, 300)}`);
}

// Find the DOM snapshot for a specific action by its callId
const target = snapshots.find(s => s.callId === 'call@42');
if (target?.after) {
  console.log('DOM after action 42:', target.after.html);
}
```

Each `DomSnapshot` includes:
- `html` — full serialized HTML string (back-references resolved, `<script>` tags stripped)
- `phase` — `"before"` | `"action"` | `"after"`
- `frameUrl` — URL of the page frame at snapshot time
- `targetElement` — `callId` of the action that targeted an element (from `__playwright_target__` attr), or `null`
- `viewport` — `{ width, height }` at snapshot time

## Locating Trace Directories

A Playwright report's `data/` directory holds **one SHA1 entry per test**. A test suite run with multiple tests will have multiple entries. Use `listTraces()` to iterate all of them:

```typescript
import { listTraces, getFailedTests } from '@andrii_kremlovskyi/playwright-traces-reader';

// Works for 1 test or many — automatically discovers all SHA1 trace entries
const traces = await listTraces('/path/to/playwright-report/data');

for (const ctx of traces) {
  const failures = await getFailedTests(ctx);
  // ... process results per test
}
```

Each entry is either a directory (already extracted) or a `.zip` (auto-extracted). Non-trace files in `data/` (`.md`, `.png`, etc.) are ignored automatically.

## Low-Level Utilities

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



- **Failures**: Start with `getFailedTests()` to see the error message and which step failed. The `error.message` contains the full diff for assertion failures.
- **Network issues**: Use `getNetworkTraffic()` filtering by `source === 'api'` to see all HTTP calls made by the test. Check `status >= 400` for HTTP errors.
- **Slow tests**: Use `getTestSteps()` and sort by `durationMs` to find bottlenecks.
- **Visual state**: Use `extractScreenshots()` and look at the last screenshot before a failure to understand the UI state at the time of failure.
- **DOM inspection**: Use `getDomSnapshots()` to get the full HTML page state at each action. The `after` snapshot is the most useful for debugging — it shows exactly what the page looked like after Playwright performed an action. Combine with `targetElement` to identify which element Playwright interacted with.
