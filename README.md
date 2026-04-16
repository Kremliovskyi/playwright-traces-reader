# playwright-traces-reader

Parse [Playwright](https://playwright.dev) trace files into structured data — useful for AI agents, custom reporters, and post-run analysis tooling.

See [CLI_ARCHITECTURE.md](docs/CLI_ARCHITECTURE.md) for the future CLI and report-hub architecture overview.
See [CLI_REFERENCE.md](docs/CLI_REFERENCE.md) for the detailed CLI command reference.
See [CLI_JSON_CONTRACTS.md](docs/CLI_JSON_CONTRACTS.md) for the versioned JSON output contracts used by the CLI.

## Features

- Search a local `playwright-reports` hub for reports by metadata, date, and recency before parsing (`search-reports`, `prepare-report`)
- Read vault analysis markdown files from the hub when reports have associated analysis notes (`vault-read`)
- Find all unique failed tests across a report in one call — retries deduplicated, passing tests excluded, last retry selected automatically (`getFailedTestSummaries`)
- One-call failure summary: title, error, step tree, slowest steps, API calls, issues, related-action diagnostics, and DOM snapshot at failure (`getSummary`)
- Extract test steps with timings and errors (`getTestSteps`, `getTopLevelFailures`)
- Extract API and browser network traffic with resolved request/response bodies (`getNetworkTraffic`)
- Correlate requests and issues to nearby browser actions via related callIds
- Group repeated failing requests and correlated issues across a report (`getReportFailurePatterns`)
- Extract browser console, page errors, and stdio output (`getConsoleEntries`, `getTraceIssues`)
- List and extract trace attachments (`getAttachments`, `extractAttachment`)
- Save screenshots from screencasts for human visual inspection (`extractScreenshots`)
- Extract full DOM snapshots (before / during / after each action) with back-reference resolution and filtering options (`getDomSnapshots`)
- Merged chronological timeline of steps, screenshots, DOM snapshots, and network calls (`getTimeline`)
- Reliable unique test title for deduplication across retries (`getTestTitle`)
- Find traces for any test by name pattern, including passed tests, with outcome filtering (`findTraces`)
- Support for multi-test reports (many SHA1 trace entries in one `data/` directory)
- GitHub Copilot skill scaffold via `init-skills` CLI command

## Installation

```bash
npm install @andrii_kremlovskyi/playwright-traces-reader
```

## CLI

The package exposes a local CLI. In a repository that has the package installed, use it with `npx`:

```bash
npx playwright-traces-reader search-reports "UAT EU" --latest --limit 1
npx playwright-traces-reader prepare-report <reportRef>
npx playwright-traces-reader failures ./playwright-report
npx playwright-traces-reader find-traces ./playwright-report "test name"
npx playwright-traces-reader summary ./playwright-report/data/<sha1>
npx playwright-traces-reader network ./playwright-report/data/<sha1>
npx playwright-traces-reader vault-read <analysisFile>
```

Phase 1 commands:

- `search-reports [query]` — search a local `playwright-reports` hub by metadata/date/recency
- `prepare-report <reportRef>` — resolve a searched report into local analysis-ready paths
- `vault-read <filename>` — read a vault analysis markdown file from the hub
- `init-skills [targetDir]` — scaffold the GitHub Copilot skill into a repository
- `failures <reportPath>` — report-level unique failing test analysis
- `find-traces <reportPath> <grep>` — find trace paths for tests matching a name pattern
- `summary <tracePath>` — one-call trace summary
- `slow-steps <tracePath>` — slowest steps from a single trace
- `steps <tracePath>` — step tree reconstruction
- `network <tracePath>` — API and browser network traffic
- `request <tracePath> <requestId>` — inspect one network request in detail
- `console <tracePath>` — browser console, page errors, stdout, and stderr
- `errors <tracePath>` — failed steps, page errors, and trace-level issues
- `dom <tracePath>` — DOM snapshots before, during, and after actions
- `timeline <tracePath>` — merged chronological trace timeline
- `attachments <tracePath>` — attachment manifest for a trace
- `attachment <tracePath> <attachmentId>` — extract one attachment
- `screenshots <tracePath> --out-dir <path>` — extract screenshots for human inspection

Default output mode in Phase 1:

- JSON is the default for CLI commands

Optional output mode:

- `--format text` — human-readable terminal output when explicitly requested

JSON responses are versioned envelopes documented in [CLI_JSON_CONTRACTS.md](docs/CLI_JSON_CONTRACTS.md).

Hub-assisted discovery details:

- `search-reports` and `prepare-report` talk to a local `playwright-reports` hub.
- Report descriptors include an `analysisFile` field (non-null when a vault `.md` file exists for that report).
- `vault-read` retrieves vault analysis file content through the hub, bypassing workspace file access restrictions.
- Default hub URL: `http://127.0.0.1:9333`
- Override with `--base-url <url>` or `PLAYWRIGHT_REPORTS_BASE_URL`
- If no report is specified by path, `reportRef`, metadata, date, or recency hint, the default local analysis target should be `./playwright-report`

`failures` is a compact triage command. It returns per-failure trace pointers plus primary related-action context and repeated cross-report request or issue patterns, so the next step is usually to run `summary <tracePath>` for one selected failure.

`find-traces` is a discovery command for locating any test's trace — including passed tests. It matches a regex against full test titles and returns trace paths for all retries, with optional `--outcome` filtering.

Typical CLI workflow:

```bash
npx playwright-traces-reader failures ./playwright-report
npx playwright-traces-reader summary /absolute/path/to/playwright-report/data/<sha1>
```

Trace discovery workflow:

```bash
npx playwright-traces-reader find-traces ./playwright-report "login" --outcome expected
npx playwright-traces-reader summary <tracePath> --report ./playwright-report
```

Hub-assisted workflow:

```bash
npx playwright-traces-reader search-reports "UAT EU" --latest --limit 1
npx playwright-traces-reader prepare-report <reportRef>
npx playwright-traces-reader failures <reportRootPath>
npx playwright-traces-reader summary <tracePath>
npx playwright-traces-reader vault-read <analysisFile>
```

Use `--format text` only when you explicitly want terminal-oriented output instead of the default JSON response.

## GitHub Copilot Skill

Install a ready-made GitHub Copilot skill scaffold into your project:

```bash
npx @andrii_kremlovskyi/playwright-traces-reader init-skills
# or into a custom target directory:
npx @andrii_kremlovskyi/playwright-traces-reader init-skills ./my-project
```

This copies a `SKILL.md` template to `.github/skills/analyze-playwright-traces/SKILL.md`. The skill is CLI-first and points Copilot to supported `npx playwright-traces-reader ...` commands instead of temporary script generation.

Like the other CLI commands, `init-skills` now returns JSON by default and supports `--format text` when a human-readable confirmation message is preferred.

## Library Integration

The preferred interface for agents and test repositories is the CLI.

Important boundary:

- `playwright-traces-reader` owns parsing and analysis.
- `playwright-reports` owns report inventory, metadata/date search, and local path resolution.
- The hub-assisted commands reuse that external discovery boundary without turning this package into a report catalog.

## Trace Format

Playwright HTML reports have a report root that looks like this:

```
playwright-report/
├── index.html         ← HTML report shell; contains embedded base64 ZIP data
└── data/
  ├── <sha1>/
  ├── <sha1>.zip
  └── ...
```

The structured test results JSON does not live as a plain `report.json` file next to `index.html`.

Instead, Playwright embeds it inside `index.html` in a `<template id="playwrightReportBase64">` tag. That template contains a base64-encoded ZIP payload, and inside that ZIP there is a `report.json` file with the report-level test metadata and outcomes.

This is the data loaded by `getReportMetadata()` and used for fields such as:

- report stats
- test outcomes
- trace attachment paths like `data/<sha1>.zip`
- `testId`-based retry deduplication

Playwright HTML reports store traces in `playwright-report/data/<sha1>/`:

```
<sha1>/
├── test.trace          ← step tree (getTestSteps / getTopLevelFailures / getSummary)
├── 0-trace.trace       ← browser actions, screenshots, DOM snapshots, context-options
├── 0.network           ← network HAR entries
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

The API section below describes the exported library functions.

Important distinction:

- the CLI `failures` command now returns compact triage records
- the library `getFailedTestSummaries()` function still returns full `TraceSummary[]`

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

Returns `NetworkEntry[]` from all `*.network` trace files. Supports optional filters for `source`, `grep`, `method`, `status`, `failed`, `near`, and `limit`. Each entry includes:

| Field | Type | Description |
|---|---|---|
| `id` | `number` | Per-trace request identifier used by `getNetworkRequest()` and the CLI `request` command |
| `source` | `'api' \| 'browser'` | `'api'` = Playwright `APIRequestContext`; `'browser'` = XHR / navigation |
| `pageId` | `string \| null` | Page identifier when the request belongs to a browser page |
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
| `relatedAction` | `RelatedActionRef \| null` | Nearest correlated browser action for this request |

### `getNetworkRequest(ctx, requestId)`

Returns one `NetworkEntry` by the per-trace `id` previously returned from `getNetworkTraffic()`.

### `getConsoleEntries(ctx)`

Returns `ConsoleEntry[]` combining browser console output, page errors promoted as console-style error entries, and trace `stdout` / `stderr` streams.

### `getTraceIssues(ctx)`

Returns `TraceIssue[]` combining:

- failed test steps
- page errors
- trace-level errors

Each issue may include a correlated `relatedAction` when the failure can be tied to a nearby browser action.

### `getAttachments(ctx)`

Returns `AttachmentEntry[]` for attachments captured in the trace. Each entry includes a per-trace numeric `id` used by `extractAttachment()` and the CLI `attachment` command.

### `extractAttachment(ctx, attachmentId, outputPath?)`

Resolves one attachment by its per-trace numeric `id`, writes it to disk, and returns `SavedAttachment` metadata including the final `savedPath`.

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
| `issues` | `TraceIssue[]` | Step failures, page errors, and trace-level issues for the trace |
| `actionDiagnostics` | `ActionDiagnosticSummary[]` | Aggregated request and issue counts grouped by related browser action |
| `failureDomSnapshot` | `ActionDomSnapshots \| null` | DOM snapshot closest in time to the failure, or `null` |

### `getReportFailurePatterns(reportDataDir, options?)`

Returns `ReportFailurePatterns` for unique report-level failures, grouping:

- repeated failing requests across traces
- repeated correlated issues across traces

This uses the same retry-deduplication and optional skip-filtering rules as `getFailedTestSummaries()`.

### `summarizeReportFailurePatterns(selections)`

Returns the same `ReportFailurePatterns` shape, but starts from already prepared `FailedTraceSelection[]` values instead of rescanning a report directory. Use this when you have already called the internal selection flow and want to avoid repeating the trace scan.

### `getResourceBuffer(ctx, sha1)`

Low-level helper. Resolves a SHA1 filename to a raw `Buffer` from `resources/`. Returns `null` if not found.

### `buildReportTraceMaps(meta)`

Builds SHA1-keyed lookup maps from parsed `ReportMetadata`. Returns `ReportTraceMaps` with:
- `outcomeByTraceSha1` — maps trace SHA1 to test outcome (`'expected'` | `'unexpected'` | `'flaky'` | `'skipped'`)
- `testIdByTraceSha1` — maps trace SHA1 to test ID

Pre-build the maps and pass them to `getSummary()` via `reportTraceMaps` when calling it in a loop to avoid redundant work.

### `getReportMetadata(reportDir)`

Parses the `report.json` embedded inside a Playwright HTML report's `index.html`. Returns `ReportMetadata` with test outcomes, stats, and file summaries — or `null` if `index.html` is not found. Accepts either the report root directory or the `data/` subdirectory.

### `findTraces(reportDir, grep, options?)`

Searches a Playwright HTML report for tests matching a name pattern and returns trace paths for every matching result, including all retries.

- `grep` is a case-insensitive substring matched against the full test title (file path + describe blocks + test name). Special characters in test names (brackets, quotes, parentheses, non-Latin scripts) are handled safely.
- `options.outcome` optionally filters by test outcome: `'expected'`, `'unexpected'`, `'flaky'`, or `'skipped'`.

Returns `FoundTrace[]` where each entry includes:

| Field | Type | Description |
|---|---|---|
| `testTitle` | `string` | Full test title (path + describe + name) |
| `testId` | `string` | Unique test identifier |
| `projectName` | `string` | Playwright project name |
| `file` | `string` | Test file path |
| `outcome` | `string` | Test-level outcome from `report.json` |
| `resultIndex` | `number` | Zero-based retry index |
| `traceSha1` | `string` | Trace directory name |
| `tracePath` | `string` | Absolute path to the trace in `data/` |

### `readNdjson<T>(filePath)`

Low-level async generator that streams and parses an NDJSON file line by line. Silently skips malformed lines.

## License

MIT
