# playwright-traces-reader

Parse [Playwright](https://playwright.dev) trace files into structured data — useful for AI agents, custom reporters, and post-run analysis tooling.

## Features

- Extract test steps with timings and errors
- Extract failed steps with full error messages
- Extract API and browser network traffic (with resolved request/response bodies)
- Save screenshots from screencasts
- Extract full DOM snapshots (before / during / after each action) with back-reference resolution
- Support for multi-test reports (many SHA1 trace entries in one `data/` directory)
- GitHub Copilot skill scaffold via `init-skills` CLI command

## Installation

```bash
npm install @andrii_kremlovskyi/playwright-traces-reader
```

## Quick Start

```typescript
import {
  prepareTraceDir,
  getFailedTests,
  getNetworkTraffic,
  getTestSteps,
  extractScreenshots,
  getDomSnapshots,
} from '@andrii_kremlovskyi/playwright-traces-reader';

// Point at a single extracted trace directory (or a .zip)
const ctx = await prepareTraceDir('/path/to/playwright-report/data/<sha1>');

const failures = await getFailedTests(ctx);
const traffic  = await getNetworkTraffic(ctx);
const steps    = await getTestSteps(ctx);
```

### Multi-test reports

A Playwright HTML report stores one trace entry per test inside `playwright-report/data/`. Use `listTraces()` to iterate all of them:

```typescript
import { listTraces, getFailedTests } from '@andrii_kremlovskyi/playwright-traces-reader';

const traces = await listTraces('/path/to/playwright-report/data');

for (const ctx of traces) {
  const failures = await getFailedTests(ctx);
  // ... process per-test results
}
```

Both extracted directories and `.zip` archives are handled automatically. Non-trace files (`.md`, `.png`, etc.) are ignored.

## API

### `listTraces(reportDataDir)`

Discovers all trace contexts inside a `data/` directory. Returns `TraceContext[]`.

### `prepareTraceDir(tracePath)`

Takes a single path (extracted directory or `.zip`) and returns a `TraceContext`.

### `getTestSteps(ctx)`

Returns the full step tree from `test.trace` as `TestStep[]`. Each step has:

| Field | Type | Description |
|---|---|---|
| `callId` | `string` | Unique step identifier |
| `title` | `string` | Human-readable step name |
| `method` | `string \| undefined` | API method if applicable |
| `startTime` | `number` | Unix ms timestamp |
| `endTime` | `number \| null` | Unix ms timestamp |
| `durationMs` | `number \| null` | Wall-clock duration |
| `error` | `TraceError \| null` | Error details if the step failed |
| `children` | `TestStep[]` | Nested child steps |

### `getFailedTests(ctx)`

Walks the step tree and returns a flat `FailedStep[]` for every step that has an `error`. Useful as a quick failure summary.

### `getNetworkTraffic(ctx)`

Returns `NetworkEntry[]` from all `*.network` trace files. Each entry includes:

| Field | Type | Description |
|---|---|---|
| `url` | `string` | Request URL |
| `method` | `string` | HTTP method |
| `status` | `number` | HTTP response status |
| `source` | `'api' \| 'browser'` | `'api'` = Playwright `APIRequestContext`; `'browser'` = XHR / navigation |
| `requestBody` | `string \| null` | Resolved request body |
| `responseBody` | `string \| null` | Resolved response body (binary → `[binary: ...]` placeholder) |
| `contentType` | `string \| null` | Response content-type |
| `pageref` | `string \| undefined` | Browser page ID (browser traffic only) |

### `extractScreenshots(ctx, outDir)`

Writes screencast frames from all `[N]-trace.trace` files to `outDir` as numbered `.jpeg` files. Returns `Screenshot[]` with `savedPath`, `timestamp`, `pageId`, `width`, and `height`.

### `getDomSnapshots(ctx)`

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

### `getResourceBuffer(ctx, sha1)`

Low-level helper. Resolves a SHA1 filename to a raw `Buffer` from `resources/`. Returns `null` if not found.

### `readNdjson<T>(filePath)`

Low-level async generator that streams and parses an NDJSON file line by line. Silently skips malformed lines.

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
├── test.trace          ← step tree (getTestSteps / getFailedTests)
├── 0-trace.trace       ← browser actions, screenshots, DOM snapshots
├── 0-trace.network     ← network HAR entries
└── resources/          ← binary blobs (bodies, images) addressed by SHA1
```

All trace files use **Newline-Delimited JSON (NDJSON)**.

## License

MIT
