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
  extractors.ts    — High-level extractors and report-level helpers
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

#### `getTopLevelFailures(ctx) → TestStep[]`
Filters the root-level steps returned by `getTestSteps` to only those where `error !== null`. Returns the full `TestStep` objects (including `.children`), so callers can drill into nested steps to find the specific assertion or action that failed.

This is a **cheap check** — it reads only `test.trace` and does no DOM/network I/O. `getFailedTestSummaries` uses it as a fast pre-filter to skip passing tests before building a full `TraceSummary`.

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

`Screenshot` is a superset of `ScreenshotMetadata` (same fields plus `savedPath`). `ScreenshotMetadata` (without `savedPath`) is what `getTimeline()` embeds in its entries to avoid unexpected disk writes.

#### `getDomSnapshots(ctx, options?) → ActionDomSnapshots[]`
Reads every `[N]-trace.trace` file (except `test.trace`) for `frame-snapshot` events.

**Snapshot phases**: Each browser action emits up to three named snapshots in the trace:
- `before@callId` — DOM state immediately _before_ the action starts  
- `input@callId` — DOM state _during_ the action (shown as the "Action" tab in Trace Viewer)  
- `after@callId` — DOM state immediately _after_ the action completes  

Results are aggregated per `callId` into `ActionDomSnapshots { callId, before, action, after }`.

**`DomSnapshotOptions`** (optional second argument) filters the result set before returning:
- `near: 'last'` — return the last `limit` entries (default 5). Best for "what was the page doing just before it failed?"
- `near: 'call@N'` / any callId string — return a window of `limit` entries centred on that callId.
- `phase: 'before' | 'action' | 'after'` — keep only entries where that phase is populated.
- `limit: number` — max entries to return; caps from the beginning when `near` is omitted.

Filtering is applied **after** the full snapshot set is resolved so back-reference chains are never broken.

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

#### `getTimeline(ctx) → TimelineEntry[]`
Merges all four event types — steps, screenshots, DOM snapshots, network calls — into a single chronologically sorted array (`TimelineEntry[]`). Each entry has:
- `timestamp` — wall-clock ms since epoch
- `type` — `'step' | 'screenshot' | 'dom' | 'network'`
- `data` — typed payload (cast based on `type`)

Steps are **flattened** (all nesting levels). Screenshots are `ScreenshotMetadata` (no disk writes). The chronological interleaving lets callers build a narrative without manual timestamp correlation across four separate API calls.

---

#### `getTestTitle(ctx) → string | null`
Reads numbered trace files (`0-trace.trace`, `1-trace.trace`, …) in order, looking for a `context-options` event that carries a `title` field. Returns the first match as the **full canonical test title** — a string like `"tests/auth.spec.ts:42 › describe › test name"` that includes the spec file path, describe block, and test name.

This title is globally unique within a report run and is the correct deduplication key for retries. Returns `null` for pure API traces that have no browser context.

---

#### `getSummary(ctx) → TraceSummary`
Builds a `TraceSummary` for a single `TraceContext` by running four sub-calls in parallel: `getTestSteps`, `getNetworkTraffic`, `getDomSnapshots`, `getTestTitle`. Then derives:
- `title` — root `test.step()` title (failing step takes priority over longest non-hook step)
- `status` — `'passed'` | `'failed'` based on whether any root step has an error
- `durationMs` — duration of the main root step
- `error` — top-level error from the main root step
- `topLevelSteps` — non-hook root steps (filters out `Before Hooks`, `After Hooks`, `Worker Cleanup`, etc.)
- `slowestSteps` — top 5 steps by duration across the full flattened tree
- `networkCalls` — all network entries (both `source === 'api'` and `source === 'browser'`)
- `failureDomSnapshot` — the `ActionDomSnapshots` whose timestamp is closest to the failure's `endTime`

---

#### `getFailedTestSummaries(reportDataDir) → TraceSummary[]`
Report-level helper. Encapsulates the full "find unique failing tests" flow internally so callers never need to manage `listTraces`, retry deduplication, or the cheap/expensive call split.

**Two-pass algorithm:**

*Pass 1 — group and select last retry per unique test:*
- `listTraces(reportDataDir)` — all trace contexts including retries and passing tests
- For each ctx: `getTopLevelFailures(ctx)` (cheap — reads only `test.trace`)
  - Empty → skip (passing test)
  - Non-empty → `getTestTitle(ctx)` as dedup key (fallback: `ctx.traceDir` for pure API traces)
  - Compute `latestEndTime` = max `endTime` (or `startTime`) across the top-level failures
  - If key already in map and this ctx's `latestEndTime` is not greater → skip (earlier retry)
  - Otherwise → store/replace `{ ctx, latestEndTime }` for this key

*Pass 2 — build summaries only for winning (last) retry:*
- For each entry in the map: `getSummary(ctx)` — the expensive call is made at most once per unique failing test, and always on the most recent execution.

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
import { getFailedTestSummaries } from 'playwright-traces-reader';

// Returns one TraceSummary per unique failing test — retries deduplicated,
// passing tests excluded, last retry selected automatically.
const failures = await getFailedTestSummaries('/path/to/playwright-report/data');

for (const f of failures) {
  console.log(`FAILED: ${f.testTitle ?? f.title}`);
  console.log(`Error: ${f.error?.message}`);
  for (const call of f.networkCalls) {
    console.log(`  ${call.method} ${call.url} → ${call.status}`);
  }
  if (f.failureDomSnapshot?.after) {
    console.log('DOM at failure:', f.failureDomSnapshot.after.html.slice(0, 500));
  }
}
```

## Data Flow Diagram

```
playwright-report/data/
├── <sha1-a>/           ← TraceContext A
│   ├── test.trace      ← getTestSteps / getTopLevelFailures / getSummary
│   ├── 0-trace.trace   ← extractScreenshots / getDomSnapshots / getTimeline / getTestTitle
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

- All extractor functions are stateless and `async`/awaitable — safe to run in parallel across many traces.
- `getSummary` runs its four sub-calls (`getTestSteps`, `getNetworkTraffic`, `getDomSnapshots`, `getTestTitle`) in parallel via `Promise.all`.
- `getFailedTestSummaries` calls `getSummary` only for unique failing tests (not for passing tests or earlier retries), keeping its cost proportional to the number of distinct failures.
- The skill template targets GitHub Copilot today but its Markdown/CLI-first design makes it straightforward to adapt for other agents (Claude, OpenAI Assistants, etc.).

