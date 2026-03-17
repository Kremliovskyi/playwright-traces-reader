# Playwright Traces Reader Architecture

This document describes the architectural design and data flow of the `playwright-traces-reader` module. The core goal is to parse `playwright-report/data/` trace files into a clean format suitable for LLMs (like GitHub Copilot).

## Overview

A Playwright HTML report stores one trace **per test execution** inside `playwright-report/data/`. When a test suite contains many tests, `data/` will have many entries. Each entry is either:
- A SHA1-named **directory** (already extracted), or
- A SHA1-named **`.zip` archive** (pending extraction).

Non-trace files (`.md`, `.png`, `.json`, etc.) are also present in `data/` and must be ignored.

Inside each SHA1 trace directory the files are:
- `test.trace` — high-level execution log: `before`/`after` step events, durations, errors, stdout/fixture calls. One `test.trace` = one test.
- `[N]-trace.trace` — context-level trace NDJSON: browser/API actions, `screencast-frame` entries.
- `[N]-trace.network` — network HAR-like NDJSON: request/response metadata + `_sha1` pointers to body blobs.
- `[N]-trace.stacks` — call-stack snapshots (not currently used).
- `resources/` — raw binary blobs addressed by SHA1 filename (JSON bodies, images, form data, etc.).

All trace files use **Newline-Delimited JSON (NDJSON)** encoding.

## Module Structure

```
src/
  parseTrace.ts    — Low-level I/O: prepareTraceDir, listTraces, readNdjson, getResourceBuffer
  extractors.ts    — High-level extractors: getTestSteps, getFailedTests, getNetworkTraffic, extractScreenshots, getDomSnapshots
  index.ts         — Public re-exports
  cli.ts           — CLI entry: `npx playwright-traces-reader init-skills`
templates/
  skills/analyze-playwright-traces/SKILL.md  — GitHub Copilot skill scaffold template
tests/
  sanity.test.ts   — Integration tests against real sc-tests trace data
```

## Core Modules

### 1. `parseTrace.ts` — Low-Level I/O

#### `listTraces(reportDataDir)`
Discovers all test traces inside a `data/` directory. Handles:
- Plain directories (already extracted) — included if `test.trace` exists inside
- `.zip` archives — extracted in-place (same path without the `.zip` suffix) when the directory form doesn't already exist
- Symlinks to directories — resolved via `fs.promises.stat` before checking `isDirectory()`
- Non-trace files (`.md`, `.png`, `.json`, other `.zip` noise) — silently ignored

Returns one `TraceContext` per discovered test. **This is the entry point for multi-test reports.**

#### `prepareTraceDir(tracePath)`
Takes a single path (directory _or_ `.zip`), extracts if needed, and returns a `TraceContext { traceDir }`.

#### `readNdjson<T>(filePath)`
Async generator that streams and parses lines from an NDJSON file. Silently skips malformed lines. Returns early if the file doesn't exist (robust against optional trace files).

#### `getResourceBuffer(ctx, sha1)`
Resolves a SHA1 filename to its raw `Buffer` from `resources/`. Returns `null` if not found.

---

### 2. `extractors.ts` — High-Level Extractors

#### `getTestSteps(ctx) → TestStep[]`
Parses `test.trace` by pairing `before` and `after` events via `callId`:
- Builds a nested tree using `parentId` links.
- Each `TestStep` carries `title`, `method`, `startTime`, `endTime`, `durationMs`, `error`, and `children`.
- Steps with no `parentId` (or whose parent wasn't emitted yet) become roots.

#### `getFailedTests(ctx) → FailedStep[]`
Calls `getTestSteps` then walks the full tree recursively, collecting every `TestStep` that has an `error`. Returns a flat list of `{ callId, title, error, durationMs }`.

#### `getNetworkTraffic(ctx) → NetworkEntry[]`
Reads **all** `*.network` files (sorted, so context order is preserved). For each `resource-snapshot` entry:
- Tags entries as `source: 'api'` when `_apiRequest` is present / `pageref` is absent.
- Tags entries as `source: 'browser'` when `pageref` is present (XHR/navigation traffic).
- Resolves request body: first tries inline `postData.text`, then resolves `postData._sha1` from `resources/`.
- Resolves response body: resolves `content._sha1` from `resources/`; for binary MIME types returns a `[binary: ...]` placeholder.

#### `extractScreenshots(ctx, outDir) → Screenshot[]`
Scans every `[N]-trace.trace` file (except `test.trace`) for `screencast-frame` entries:
- Resolves the frame's `sha1` blob from `resources/`.
- Writes it as `screenshot-NNNN.jpeg` (or `.png`) into `outDir`.
- Returns metadata including `savedPath` (absolute), `timestamp`, `pageId`, `width`, `height`.

#### `getDomSnapshots(ctx) → ActionDomSnapshots[]`
Reads every `[N]-trace.trace` file (except `test.trace`) for `frame-snapshot` events.

**Snapshot phases**: Each browser action emits up to three named snapshots in the trace:
- `before@callId` — DOM state immediately _before_ the action starts  
- `input@callId` — DOM state _during_ the action (shown as the "Action" tab in Trace Viewer)  
- `after@callId` — DOM state immediately _after_ the action completes  

Results are aggregated per `callId` into `ActionDomSnapshots { callId, before, action, after }`.

**Compact snapshot format**: Playwright stores DOM snapshots as nested arrays `["tagName", {attrs}, ...children]`. To reduce trace file size, repeated subtrees are replaced with **back-references**: `[[offset, nodeIdx]]` where:
- `offset` — how many positions to look back in this frame's snapshot history  
- `nodeIdx` — index into the **post-order DFS traversal** of that historical snapshot

Resolution algorithm (mirrors `snapshotNodes()` / `snapshotRenderer.ts` in `playwright-core`):
1. Maintain a per-frame ordered list of raw `html` nodes (one entry per `frame-snapshot` event, in emission order).
2. For each snapshot at index `i`, before rendering, append its `html` to the frame list.
3. When a ref `[[offset, nodeIdx]]` is encountered: `refIndex = i - offset`; build the post-order DFS list of `frameHistory[refIndex]` (memoized); look up `nodes[nodeIdx]` and recurse at `refIndex`.
4. Post-order DFS: text nodes are pushed **immediately**; element nodes are pushed **after** all their children. Subtree refs are **not** included in the DFS list.

**Memoization**: `buildSnapshotNodeList()` is memoized per `html` object reference inside a single `getDomSnapshots()` call, reducing repeated reference chains from O(n × ref_count) to O(n) per snapshot.

---

### 3. Agent Skills Scaffold

`src/cli.ts` provides:
```
npx playwright-traces-reader init-skills [targetDir]
```
Copies `templates/skills/analyze-playwright-traces/SKILL.md` into `<targetDir>/.github/skills/analyze-playwright-traces/SKILL.md`. The template contains usage examples for all extractor functions.

---

## Typical Usage Pattern (Multi-Test Report)

```typescript
import { listTraces, getFailedTests, getNetworkTraffic } from 'playwright-traces-reader';

// Point at the report's data/ directory — works for 1 test or 1000 tests
const traces = await listTraces('/path/to/playwright-report/data');

for (const ctx of traces) {
  const failures = await getFailedTests(ctx);
  const traffic  = await getNetworkTraffic(ctx);
  // ... process per-test results
}
```

## Data Flow Diagram

```
playwright-report/data/
├── <sha1-a>/           ← TraceContext A
│   ├── test.trace      ← getTestSteps / getFailedTests
│   ├── 0-trace.trace   ← extractScreenshots / getDomSnapshots
│   ├── 0-trace.network ← getNetworkTraffic (api traffic)
│   ├── 8-trace.trace   ← extractScreenshots / getDomSnapshots (browser context)
│   ├── 8-trace.network ← getNetworkTraffic (browser traffic)
│   └── resources/      ← getResourceBuffer (body blobs, jpegs)
├── <sha1-a>.zip        ← ignored (dir already extracted)
├── <sha1-b>.zip        ← listTraces auto-extracts → TraceContext B
├── screenshot.png      ← ignored (not a trace)
└── test-info.md        ← ignored (not a trace)
```

## Scalability & Extensibility

- All extractor functions are stateless and `async`/awaitable — safe to run in parallel across many traces (e.g. `Promise.all(traces.map(getFailedTests))`).
- The skill template targets GitHub Copilot today but its Markdown/CLI-first design makes it straightforward to adapt for other agents (Claude, OpenAI Assistants, etc.).

