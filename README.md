# playwright-traces-reader

Parse [Playwright](https://playwright.dev) trace files into structured data — useful for AI agents, custom reporters, and post-run analysis tooling.

## Features

- Find all unique failed tests across a report in one call — retries deduplicated, passing tests excluded, last retry selected automatically (`getFailedTestSummaries`)
- One-call failure summary: title, error, step tree, slowest steps, API calls, and DOM snapshot at failure (`getSummary`)
- Extract test steps with timings and errors (`getTestSteps`, `getTopLevelFailures`)
- Extract API and browser network traffic with resolved request/response bodies (`getNetworkTraffic`)
- Save screenshots from screencasts for human visual inspection (`extractScreenshots`)
- Extract full DOM snapshots (before / during / after each action) with back-reference resolution and filtering options (`getDomSnapshots`)
- Merged chronological timeline of steps, screenshots, DOM snapshots, and network calls (`getTimeline`)
- Reliable unique test title for deduplication across retries (`getTestTitle`)
- Support for multi-test reports (many SHA1 trace entries in one `data/` directory)
- GitHub Copilot skill scaffold via `init-skills` CLI command

## Installation

```bash
npm install @andrii_kremlovskyi/playwright-traces-reader
```

## GitHub Copilot Skill

Install a ready-made GitHub Copilot skill scaffold into your project:

```bash
npx @andrii_kremlovskyi/playwright-traces-reader init-skills
# or into a custom target directory:
npx @andrii_kremlovskyi/playwright-traces-reader init-skills ./my-project
```

This copies a `SKILL.md` template to `.github/skills/analyze-playwright-traces/SKILL.md` with code examples for all extractor functions. Once in place, GitHub Copilot will use the skill automatically when answering questions about your Playwright test runs.

## Trace Format

Playwright HTML reports store traces in `playwright-report/data/<sha1>/`:

```
<sha1>/
├── test.trace          ← step tree (getTestSteps / getTopLevelFailures / getSummary)
├── 0-trace.trace       ← browser actions, screenshots, DOM snapshots, context-options
├── 0-trace.network     ← network HAR entries
└── resources/          ← binary blobs (bodies, images) addressed by SHA1
```

All trace files use **Newline-Delimited JSON (NDJSON)**.

## Quick Start

```typescript
import {
  getFailedTestSummaries,
} from '@andrii_kremlovskyi/playwright-traces-reader';

// One call — returns one TraceSummary per unique failing test.
// Retries deduplicated; passing tests excluded; last retry selected.
const failures = await getFailedTestSummaries('/path/to/playwright-report/data');

for (const f of failures) {
  console.log(`[FAILED] ${f.testTitle ?? f.title}`);
  console.log(`Error: ${f.error?.message}`);
  console.log(`Duration: ${f.durationMs}ms`);

  for (const call of f.apiCalls) {
    console.log(`  ${call.method} ${call.url} → ${call.status}`);
  }

  if (f.failureDomSnapshot?.after) {
    console.log('DOM at failure:', f.failureDomSnapshot.after.html.slice(0, 500));
  }
}
```

### Single trace

```typescript
import {
  prepareTraceDir,
  getSummary,
} from '@andrii_kremlovskyi/playwright-traces-reader';

// Point at a single extracted trace directory (or a .zip)
const ctx = await prepareTraceDir('/path/to/playwright-report/data/<sha1>');
const summary = await getSummary(ctx);
console.log(`[${summary.status.toUpperCase()}] ${summary.testTitle ?? summary.title}`);
console.log(`Error: ${summary.error?.message}`);
```

## API

### `getFailedTestSummaries(reportDataDir, options?)`

Report-level helper. Returns `TraceSummary[]` — one entry per **unique** failing test:
- Passing tests are skipped cheaply (no `getSummary` call).
- Retries are deduplicated by the full test title from `context-options`. The **last retry** (highest root step `endTime`) is used so the summary reflects the most recent execution.
- Pure API traces (no browser context) are deduplicated by `ctx.traceDir`.

**`GetFailedTestSummariesOptions`** (optional second argument):

| Option | Type | Default | Description |
|---|---|---|---|
| `excludeSkipped` | `boolean` | `false` | Omit tests that called `test.skip()` inside the test body. Detected via `{ type: 'skip' }` annotations on the trace step events. Pre-annotated skips (suite-level annotations or conditional `test.skip(condition)`) are already excluded automatically because they produce no root step failures. |

This is the recommended entry point for failure analysis. See [`TraceSummary`](#tracesummary) for the full field list.

### `getSummary(ctx)`

Builds a `TraceSummary` for a single `TraceContext`. Use this when you already have a specific `ctx` from `listTraces()` and want a full snapshot without routing through `getFailedTestSummaries`.

### `listTraces(reportDataDir)`

Discovers all trace contexts inside a `data/` directory, including both passing and failing tests. Returns `TraceContext[]`. Each entry is either a directory (already extracted) or a `.zip` (auto-extracted). Non-trace files are ignored.

### `prepareTraceDir(tracePath)`

Takes a single path (extracted directory or `.zip`) and returns a `TraceContext`.

### `getTopLevelFailures(ctx)`

Returns the root-level failed steps as `TestStep[]` (only those with `error !== null`). Cheap — reads only `test.trace`. Each returned step contains the full `.children` tree for drilling down.

### `getTestTitle(ctx)`

Reads numbered trace files (`0-trace.trace`, …) for a `context-options` event and returns the full canonical test title: `"tests/auth.spec.ts:42 › describe › test name"`. Returns `null` for pure API traces with no browser context.

### `getTestSteps(ctx)`

Returns the full step tree from `test.trace` as `TestStep[]`. Each step has:

| Field | Type | Description |
|---|---|---|
| `callId` | `string` | Unique step identifier |
| `title` | `string` | Human-readable step name |
| `method` | `string` | API method if applicable |
| `startTime` | `number` | Unix ms timestamp |
| `endTime` | `number \| null` | Unix ms timestamp |
| `durationMs` | `number \| null` | Wall-clock duration |
| `error` | `TraceError \| null` | Error details if the step failed |
| `annotations` | `StepAnnotation[]` | Step annotations (e.g. `{ type: 'skip' }` for skipped tests) |
| `children` | `TestStep[]` | Nested child steps |

### `getNetworkTraffic(ctx)`

Returns `NetworkEntry[]` from all `*.network` trace files. Each entry includes:

| Field | Type | Description |
|---|---|---|
| `source` | `'api' \| 'browser'` | `'api'` = Playwright `APIRequestContext`; `'browser'` = XHR / navigation |
| `method` | `string` | HTTP method |
| `url` | `string` | Request URL |
| `status` | `number` | HTTP response status |
| `statusText` | `string` | HTTP status text |
| `requestHeaders` | `Array<{name,value}>` | Request headers |
| `responseHeaders` | `Array<{name,value}>` | Response headers |
| `requestBody` | `string \| null` | Resolved request body |
| `responseBody` | `string \| null` | Resolved response body (binary → `[binary: ...]` placeholder) |
| `mimeType` | `string` | Response content MIME type |
| `startedDateTime` | `string` | ISO 8601 request start time |
| `durationMs` | `number` | Total request duration |

### `extractScreenshots(ctx, outDir)`

Writes screencast frames from all `[N]-trace.trace` files to `outDir` as numbered `.jpeg` files. Returns `Screenshot[]` with `savedPath`, `sha1`, `timestamp`, `pageId`, `width`, and `height`.

> **Note**: AI agents cannot read JPEG/PNG image files from disk. `extractScreenshots` is for human visual inspection only. Use `getDomSnapshots()` for AI-readable UI state.

### `getDomSnapshots(ctx, options?)`

Returns `ActionDomSnapshots[]` — one entry per browser action that has DOM snapshots. Each entry groups three phases:

| Field | Type | Description |
|---|---|---|
| `callId` | `string` | Action identifier |
| `before` | `DomSnapshot \| null` | DOM before the action |
| `action` | `DomSnapshot \| null` | DOM during the action (mid-interaction) |
| `after` | `DomSnapshot \| null` | DOM after the action completed |

Each `DomSnapshot` contains:

| Field | Type | Description |
|---|---|---|
| `html` | `string` | Full serialized HTML (back-references resolved, `<script>` stripped) |
| `phase` | `'before' \| 'action' \| 'after'` | Snapshot phase |
| `frameUrl` | `string` | URL of the frame at snapshot time |
| `targetElement` | `string \| null` | `callId` of the action that targeted an element, or `null` |
| `viewport` | `{ width: number; height: number }` | Viewport dimensions |
| `timestamp` | `number` | Unix ms timestamp |

**`DomSnapshotOptions`** (optional second argument):

| Option | Type | Description |
|---|---|---|
| `near` | `'last' \| string` | `'last'` = last `limit` entries; any other string = window centred on that callId |
| `phase` | `'before' \| 'action' \| 'after'` | Keep only entries where this phase is populated |
| `limit` | `number` | Max entries to return (default 5 with `near: 'last'`; caps from beginning otherwise) |

### `getTimeline(ctx)`

Merges all event types into a single chronologically sorted `TimelineEntry[]`:

| Field | Type | Description |
|---|---|---|
| `timestamp` | `number` | Wall-clock ms since epoch |
| `type` | `'step' \| 'screenshot' \| 'dom' \| 'network'` | Event category |
| `data` | (typed union) | Payload — cast based on `type` |

Steps are flattened (all nesting levels). Screenshots are `ScreenshotMetadata` (no `savedPath` — no disk writes).

### `TraceSummary`

The bundle returned by `getSummary()` and `getFailedTestSummaries()`:

| Field | Type | Description |
|---|---|---|
| `testTitle` | `string \| null` | Full unique title from `context-options` (spec path + describe + test name). Use for display. `null` for pure API traces. |
| `title` | `string` | Root `test.step()` title (failing step or longest non-hook step) |
| `status` | `'passed' \| 'failed'` | Test outcome |
| `durationMs` | `number \| null` | Duration of the main root step |
| `error` | `TraceError \| null` | Top-level error, or `null` if passed |
| `topLevelSteps` | `TestStep[]` | Non-hook root steps (the visible `test.step()` blocks), each with `.children` |
| `slowestSteps` | `TestStep[]` | Top 5 slowest steps across the full step tree |
| `networkCalls` | `NetworkEntry[]` | All HTTP calls (`source: 'api'` = Node.js `APIRequestContext`; `source: 'browser'` = XHR / fetch / navigation) |
| `failureDomSnapshot` | `ActionDomSnapshots \| null` | DOM snapshot closest in time to the failure, or `null` |

### `getResourceBuffer(ctx, sha1)`

Low-level helper. Resolves a SHA1 filename to a raw `Buffer` from `resources/`. Returns `null` if not found.

### `readNdjson<T>(filePath)`

Low-level async generator that streams and parses an NDJSON file line by line. Silently skips malformed lines.

## License

MIT
