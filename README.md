# playwright-traces-reader

Parse [Playwright](https://playwright.dev) trace files into structured data — useful for AI agents, custom reporters, and post-run analysis tooling.

See [CLI_ARCHITECTURE.md](CLI_ARCHITECTURE.md) for the future CLI and report-hub architecture overview.
See [CLI_REFERENCE.md](CLI_REFERENCE.md) for the detailed CLI command reference.
See [CLI_JSON_CONTRACTS.md](CLI_JSON_CONTRACTS.md) for the versioned JSON output contracts used by the CLI.
See [LIBRARY_INTEGRATION.md](LIBRARY_INTEGRATION.md) for in-process library usage guidance.

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

## CLI

The package exposes a local CLI. In a repository that has the package installed, use it with `npx`:

```bash
npx playwright-traces-reader failures ./playwright-report
npx playwright-traces-reader summary ./playwright-report/data/<sha1>
npx playwright-traces-reader network ./playwright-report/data/<sha1> --format json
```

Phase 1 commands:

- `init-skills [targetDir]` — scaffold the GitHub Copilot skill into a repository
- `failures <reportPath>` — report-level unique failing test analysis
- `summary <tracePath>` — one-call trace summary
- `slow-steps <tracePath>` — slowest steps from a single trace
- `steps <tracePath>` — step tree reconstruction
- `network <tracePath>` — API and browser network traffic
- `dom <tracePath>` — DOM snapshots before, during, and after actions
- `timeline <tracePath>` — merged chronological trace timeline
- `screenshots <tracePath> --out-dir <path>` — extract screenshots for human inspection

Supported output modes in Phase 1:

- `--format text` — human-readable terminal output
- `--format json` — structured output for agents and automation

JSON responses are versioned envelopes documented in [CLI_JSON_CONTRACTS.md](CLI_JSON_CONTRACTS.md).

## GitHub Copilot Skill

Install a ready-made GitHub Copilot skill scaffold into your project:

```bash
npx @andrii_kremlovskyi/playwright-traces-reader init-skills
# or into a custom target directory:
npx @andrii_kremlovskyi/playwright-traces-reader init-skills ./my-project
```

This copies a `SKILL.md` template to `.github/skills/analyze-playwright-traces/SKILL.md`. The skill is CLI-first and points Copilot to supported `npx playwright-traces-reader ...` commands instead of temporary script generation.

## Library Integration

The preferred interface for agents and test repositories is the CLI.

For in-process integrations such as future `playwright-reports` usage, see [LIBRARY_INTEGRATION.md](LIBRARY_INTEGRATION.md).

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

  for (const call of f.networkCalls) {
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
  getReportMetadata,
  getSummary,
} from '@andrii_kremlovskyi/playwright-traces-reader';

// Point at a single extracted trace directory (or a .zip)
const ctx = await prepareTraceDir('/path/to/playwright-report/data/<sha1>');

// Load report metadata for outcome info (pass null if unavailable)
const meta = await getReportMetadata('/path/to/playwright-report');

// For a single trace, pass reportMetadata directly:
const summary = await getSummary(ctx, { reportMetadata: meta });

// For many traces, pre-build maps to avoid redundant work:
// const maps = meta ? buildReportTraceMaps(meta) : null;
// const summary = await getSummary(ctx, { reportMetadata: meta, reportTraceMaps: maps });
console.log(`[${summary.status.toUpperCase()}] ${summary.testTitle ?? summary.title}`);
console.log(`Error: ${summary.error?.message}`);
```

## API

### `getFailedTestSummaries(reportDataDir, options?)`

Report-level helper. Returns `TraceSummary[]` — one entry per **unique** failing test:
- Passing tests are skipped cheaply (no `getSummary` call).
- Retries are deduplicated by `testId` from `report.json` when `index.html` is available, falling back to `getTestTitle()` or `ctx.traceDir`. The **last retry** (highest root step `endTime`) is used so the summary reflects the most recent execution.
- Each returned summary has an `outcome` field (`'unexpected'` | `'skipped'` | `'flaky'` | `null`) from `report.json`, so callers can filter or group by outcome.

**`GetFailedTestSummariesOptions`** (optional second argument):

| Option | Type | Default | Description |
|---|---|---|---|
| `excludeSkipped` | `boolean` | `false` | Omit tests that were skipped via `test.skip()`. When `index.html` is found next to the `data/` directory, maps trace directories to test outcomes via `report.json` (each test result's trace attachment path contains the SHA1 directory name). Falls back to checking trace step annotations and error messages when `index.html` is not available. Pre-annotated skips (suite-level annotations or conditional `test.skip(condition)`) are already excluded automatically because they produce no root step failures. |

This is the recommended entry point for failure analysis. See [`TraceSummary`](#tracesummary) for the full field list.

### `getSummary(ctx, options)`

Builds a `TraceSummary` for a single `TraceContext`. Requires an `options: GetSummaryOptions` object:

| Option | Type | Required | Description |
|---|---|---|---|
| `reportMetadata` | `ReportMetadata \| null` | Yes | Parsed report metadata from `getReportMetadata()`. When provided, `outcome` is populated from `report.json`. Pass `null` when unavailable. |
| `reportTraceMaps` | `ReportTraceMaps \| null` | No | Pre-built lookup maps from `buildReportTraceMaps()`. Avoids rebuilding maps on every call when invoking `getSummary` in a loop. If omitted, maps are built on-the-fly. |

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
| `status` | `'passed' \| 'failed'` | Test pass/fail from trace data |
| `outcome` | `'expected' \| 'unexpected' \| 'flaky' \| 'skipped' \| null` | Authoritative outcome from `report.json`. Populated when `reportMetadata` is passed to `getSummary()` or automatically by `getFailedTestSummaries()`. `null` when `reportMetadata` is `null` or trace SHA1 not found. |
| `durationMs` | `number \| null` | Duration of the main root step |
| `error` | `TraceError \| null` | Top-level error, or `null` if passed |
| `topLevelSteps` | `TestStep[]` | Non-hook root steps (the visible `test.step()` blocks), each with `.children` |
| `slowestSteps` | `TestStep[]` | Top 5 slowest steps across the full step tree |
| `networkCalls` | `NetworkEntry[]` | All HTTP calls (`source: 'api'` = Node.js `APIRequestContext`; `source: 'browser'` = XHR / fetch / navigation) |
| `failureDomSnapshot` | `ActionDomSnapshots \| null` | DOM snapshot closest in time to the failure, or `null` |

### `getResourceBuffer(ctx, sha1)`

Low-level helper. Resolves a SHA1 filename to a raw `Buffer` from `resources/`. Returns `null` if not found.

### `buildReportTraceMaps(meta)`

Builds SHA1-keyed lookup maps from parsed `ReportMetadata`. Returns `ReportTraceMaps` with:
- `outcomeByTraceSha1` — maps trace SHA1 to test outcome (`'expected'` | `'unexpected'` | `'flaky'` | `'skipped'`)
- `testIdByTraceSha1` — maps trace SHA1 to test ID

Pre-build the maps and pass them to `getSummary()` via `reportTraceMaps` when calling it in a loop to avoid redundant work.

### `getReportMetadata(reportDir)`

Parses the `report.json` embedded inside a Playwright HTML report's `index.html`. Returns `ReportMetadata` with test outcomes, stats, and file summaries — or `null` if `index.html` is not found. Accepts either the report root directory or the `data/` subdirectory.

### `readNdjson<T>(filePath)`

Low-level async generator that streams and parses an NDJSON file line by line. Silently skips malformed lines.

## License

MIT
