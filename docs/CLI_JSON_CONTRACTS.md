# CLI JSON Contracts

This document defines the stable Phase 1 JSON output contracts for `playwright-traces-reader` CLI commands.

JSON is the default output mode for CLI commands unless `--format text` is passed.

Every JSON response is a versioned envelope. Future integrations such as `playwright-reports` should depend on the envelope fields first:

- `schemaVersion`
- `command`
- the named payload field for that command

Current schema version:

```text
1
```

## Envelope Rules

All CLI commands return an object, not a bare array, when using the default JSON mode.

Shared top-level fields:

- `schemaVersion` — integer schema version for the command contract
- `command` — the CLI command name

Some commands also expose:

- `count` — number of items in the payload collection

## Command Contracts

### `init-skills`

```json
{
  "schemaVersion": 1,
  "command": "init-skills",
  "skillPath": "/absolute/path/.github/skills/analyze-playwright-traces/SKILL.md"
}
```

Payload field:

- `skillPath` — absolute path to the scaffolded skill file

Notes:

- `init-skills` does not include `count`
- use `--format text` when only a confirmation line is desired

### `failures`

`failures <reportPath> <outputDir>` writes one self-contained folder per failed
test attempt (including each failed retry) into a timestamped run directory and
prints a compact manifest to stdout. The manifest is also mirrored to
`<runDir>/index.json`.

```json
{
  "schemaVersion": 1,
  "command": "failures",
  "outputDir": "/absolute/path/to/output",
  "runDir": "/absolute/path/to/output/run-2026-06-01T09-46-23-000Z",
  "count": 2,
  "failures": [
    {
      "folder": "tests-example-spec-ts-10-suite-test__retry1",
      "testTitle": "tests/example.spec.ts:10 › suite › test",
      "title": "main step",
      "retryIndex": 1,
      "status": "failed",
      "outcome": "unexpected",
      "traceSha1": "trace-fail-latest",
      "screenshotCount": 3,
      "domCount": 1,
      "networkErrorCount": 2,
      "consoleErrorCount": 1
    }
  ]
}
```

Manifest fields:

- `outputDir` — resolved directory passed on the command line
- `runDir` — timestamped subfolder holding the per-failure folders and `index.json`
- `count` — number of failure folders written
- `failures` — one manifest entry per failed attempt

Each manifest entry includes:

- `folder` — folder name under `runDir` (sanitized test title + `__retry<index>`)
- `testTitle` — full canonical Playwright test title when available
- `title` — main failing root-step title
- `retryIndex` — 0-based retry attempt index
- `status` — trace status
- `outcome` — report outcome when metadata is available
- `traceSha1` — trace directory identifier
- `screenshotCount` — number of screenshot frames written into the folder
- `domCount` — number of failure-anchor DOM html files written into the folder
- `networkErrorCount` — number of network entries with status >= 400
- `consoleErrorCount` — number of console error entries

#### Per-failure folder layout

Each `<runDir>/<folder>/` contains:

- `failure.json` — the full per-failure digest (see below). Companion file
  references inside `files` are relative to the folder.
- `screenshots/frame-*.{png,jpeg}` — screencast frames nearest each failure
  anchor (`before`, `action`, `after`). Absent for API-only traces with no frames.
- `dom/<callId>.html` — Action-phase DOM nearest each failure anchor, named by the
  anchor's sanitized `callId` (or `anchor-<index>` when the anchor has no callId).
  Each set in `screenshots[]` references its file via the `dom` field. This makes the
  folder self-contained — no follow-up `dom --near` call is needed for triage.
- `network-errors.ndjson` — failing network requests (status >= 400), one record per
  line, chronological with a global `seq`, each carrying `timingRelativeToFailures`
  (`before` / `during` / `after` / `unknown` per failure anchor). Response bodies over
  32 KB are spilled (see below). Omitted when there are no failing requests. Aligned
  with the `digest` command's `network.ndjson` format.
- `network-error-bodies.ndjson` — spilled large response bodies (`{ seq, url, mimeType,
  encoding, bodySizeBytes, body }`), back-linked by `seq`. Omitted when none spilled.
- `console-errors.ndjson` — browser/stderr console errors, one record per line,
  chronological. Omitted when none.
- `error.md` — Playwright's human-readable error markdown, copied when present.
  The leading `# Instructions` preamble (generic "explain and fix the test"
  guidance) is stripped; the diagnostic sections (`# Test info`, `# Error
  details`, etc.) are kept verbatim.

`failure.json` fields:

- `testTitle`, `title`, `status`, `outcome`, `durationMs`, `retryIndex`
- `traceSha1`, `tracePath`
- `topLevelSteps`, `issues`, `actionDiagnostics`, `failureDomSnapshot` — ANSI
  escape codes are stripped from any step error and issue message/stack. The full
  human-readable error lives in `error.md`.
- `networkCallCount`, `networkErrorCount`, `consoleErrorCount`, `domCount`
- `screenshots` — per-anchor relative paths (`before` / `action` / `after`, plus
  `dom` for the failure-moment DOM html), each null when absent
- `files` — relative paths to companion files (`networkErrors`, `networkErrorBodies`,
  `consoleErrors`, `errorMarkdown`), each null when the file was not written

Each `network-errors.ndjson` line carries the triage fields (`method`, `url`, `status`,
`statusText`, `mimeType`, `durationMs`, `startedDateTime`, `requestBody`, `responseBody`,
`relatedAction`, `timingRelativeToFailures`) plus `seq`, `bodySizeBytes`, `isBinary`,
`isLarge`, and `bodyRef`. When `isLarge` is true, `responseBody` is null and `bodyRef`
holds the `seq` to look up the body in `network-error-bodies.ndjson`.

### `digest`

`digest <tracePath> <outputDir>` digests a single trace (any status) into one
self-contained folder under a timestamped run directory and prints a compact
manifest to stdout. Unlike `failures`, it covers the whole test — not just
failure points — and links every step to its artifacts.

```json
{
  "schemaVersion": 1,
  "command": "digest",
  "outputDir": "/absolute/path/to/output",
  "runDir": "/absolute/path/to/output/run-2026-06-08T14-03-38-855Z",
  "folder": "e2e-...-spec-ts-613-order-core__retry0",
  "testTitle": "tests/example.spec.ts:10 › suite › test",
  "title": "main step",
  "status": "passed",
  "outcome": "expected",
  "retryIndex": 0,
  "traceSha1": "2cfaf336...",
  "domCount": 436,
  "screenshotCount": 436,
  "networkCallCount": 6136,
  "consoleEntryCount": 846
}
```

Manifest fields:

- `outputDir`, `runDir`, `folder` — resolved output dir, timestamped run subfolder, and the digest folder name
- `testTitle`, `title`, `status`, `outcome`, `retryIndex`, `traceSha1`
- `domCount` / `screenshotCount` — paired 1:1 (one Action-phase DOM + nearest screenshot per leaf action that has an `input@` snapshot)
- `networkCallCount`, `consoleEntryCount`

#### Digest folder layout

Each `<runDir>/<folder>/` contains:

- `digest.json` — the full chronological step tree (see below). The pretty-printed
  entry point; companion file references are relative to the folder.
- `dom/<callId>.html` — Action-phase DOM html, one per leaf action with an `input@`
  snapshot. Absent for actions without one (e.g. assertions, waits, API calls).
- `screenshots/<callId>.png|jpeg` — the screencast frame nearest the action's input
  moment, paired 1:1 with the DOM file by sanitized `callId`.
- `network.ndjson` — every HTTP exchange, one record per line, chronological, with a
  global `seq`. Small text/JSON bodies are inlined; bodies over 32 KB are spilled.
- `network-bodies.ndjson` — spilled large response bodies (`{ seq, url, mimeType,
  encoding, bodySizeBytes, body }`), back-linked by `seq`. Omitted when none.
- `console.ndjson` — console / page-error / stdout / stderr entries, chronological.

`digest.json` fields:

- `testTitle`, `title`, `status`, `outcome`, `durationMs`, `retryIndex`, `traceSha1`, `tracePath`
- `counts` — `steps`, `leafActionsWithDom`, `screenshots`, `networkCalls`, `networkBodiesSpilled`, `consoleEntries`
- `files` — relative names of the NDJSON companions (`network`, `networkBodies`, `console`)
- `steps` — the chronological step tree. Each node has `callId`, `parentId`, `title`,
  `method`, `startTime`, `endTime`, `durationMs`, `error` (ANSI-stripped), `children`,
  and an `artifacts` object:
  - `dom` / `screenshot` — relative paths for leaf actions, else null
  - `network` — seq ids of **all** network calls whose monotonic time falls within
    the step's window. Because steps nest in time, a parent's list is a superset of
    its descendants'.
  - `consoleErrors` — count of console errors within the step's window

#### `network.ndjson` line

```json
{
  "seq": 186,
  "monotonicTime": 388751.16,
  "startedDateTime": "2026-06-01T05:14:19.807Z",
  "source": "browser",
  "method": "POST",
  "url": "https://.../api/v1/orders/v2/next-feature",
  "status": 200,
  "statusText": "OK",
  "mimeType": "application/json",
  "durationMs": 120.5,
  "requestHeaders": [],
  "responseHeaders": [],
  "requestBody": "...",
  "responseBody": "...",
  "bodySizeBytes": 1234,
  "isBinary": false,
  "isLarge": false,
  "bodyRef": null,
  "relatedActionCallId": null
}
```

When `isLarge` is true, `responseBody` is null and `bodyRef` holds the `seq` to look
up the body in `network-bodies.ndjson`. Agents should read `bodySizeBytes` before
fetching a spilled body.

### `find-traces`

```json
{
  "schemaVersion": 1,
  "command": "find-traces",
  "count": 2,
  "traces": [
    {
      "testTitle": "Order flow [DEV NA] > e2eOrderTC01 - should process order",
      "testId": "abc123-def456",
      "projectName": "e2e-falcons",
      "file": "e2e/order-processing.spec.ts",
      "outcome": "expected",
      "resultIndex": 0,
      "traceSha1": "7ef1d1fa1b378d78fb3d442492aa3a2b54de124f",
      "tracePath": "/absolute/path/to/report/data/7ef1d1fa1b378d78fb3d442492aa3a2b54de124f"
    }
  ]
}
```

Payload field:

- `traces` — array of `FoundTrace` objects matching the search pattern

Each trace item includes:

- `testTitle` — full test title (file path + describe blocks + test name)
- `testId` — unique Playwright test identifier
- `projectName` — Playwright project name
- `file` — test file path
- `outcome` — test-level outcome from `report.json` (`expected`, `unexpected`, `flaky`, `skipped`)
- `resultIndex` — zero-based retry index (0 = first attempt, 1 = first retry, etc.)
- `traceSha1` — trace directory identifier in `data/`
- `tracePath` — absolute path to the trace directory, usable as input for `summary <tracePath>`

Notes:

- a test with retries produces multiple entries with different `resultIndex` values
- `outcome` is the test-level aggregate (e.g. `flaky` means some retries passed and some failed)
- per-result pass/fail status is not available from the HTML report metadata
- the `tracePath` can be passed directly to `summary`, `steps`, `network`, etc.

### `summary`

```json
{
  "schemaVersion": 1,
  "command": "summary",
  "summary": {
    "status": "failed",
    "title": "main step"
  }
}
```

Payload field:

- `summary` — one `TraceSummary` object

Important `summary` fields:

- `testTitle`
- `title`
- `status`
- `outcome`
- `durationMs`
- `error`
- `topLevelSteps`
- `slowestSteps`
- `networkCalls`
- `issues`
- `actionDiagnostics`
- `failureDomSnapshot` — lightweight metadata reference (not the full HTML); use `dom --near <callId> --output <path>` to retrieve full snapshots

`failureDomSnapshot` fields (when non-null):

- `callId` — action callId, pass to `dom --near <callId>`
- `phases` — array of available phases (`before`, `action`, `after`)
- `timestamp` — wall-clock timestamp of the primary phase
- `frameUrl` — frame URL from the primary phase
- `targetElement` — targeted element's callId, if any — lightweight metadata reference (not the full HTML); use `dom --near <callId> --output <path>` to retrieve full snapshots

`failureDomSnapshot` fields (when non-null):

- `callId` — action callId, pass to `dom --near <callId>`
- `phases` — array of available phases (`before`, `action`, `after`)
- `timestamp` — wall-clock timestamp of the primary phase
- `frameUrl` — frame URL from the primary phase
- `targetElement` — targeted element's callId, if any

`summary` is the deep-inspection payload. Unlike `failures`, it intentionally keeps the full trace analysis shape.

### `slow-steps`

```json
{
  "schemaVersion": 1,
  "command": "slow-steps",
  "count": 5,
  "steps": [
    {
      "title": "fill field",
      "durationMs": 1234
    }
  ]
}
```

Payload field:

- `steps` — array of `TestStep` objects

Important step fields:

- `callId`
- `title`
- `method`
- `startTime`
- `endTime`
- `durationMs`
- `error`
- `annotations`
- `children`

### `steps`

```json
{
  "schemaVersion": 1,
  "command": "steps",
  "count": 3,
  "steps": [
    {
      "title": "Open page",
      "children": []
    }
  ]
}
```

Payload field:

- `steps` — array of root `TestStep` objects

Notes:

- this is the raw reconstructed root-step tree from `test.trace`
- hook roots such as `Before Hooks` may appear here
- nested data is stored in `children`

### `network`

```json
{
  "schemaVersion": 1,
  "command": "network",
  "count": 4,
  "entries": [
    {
      "source": "api",
      "method": "POST",
      "url": "https://example.test/api"
    }
  ]
}
```

Payload field:

- `entries` — array of `NetworkEntry` objects

Important network fields:

- `id`
- `source`
- `pageId`
- `method`
- `url`
- `status`
- `statusText`
- `requestHeaders`
- `responseHeaders`
- `requestBody`
- `responseBody`
- `mimeType`
- `startedDateTime`
- `durationMs`
- `relatedAction`

### `request`

```json
{
  "schemaVersion": 1,
  "command": "request",
  "request": {
    "id": 12,
    "method": "POST",
    "url": "https://example.test/api"
  }
}
```

Payload field:

- `request` — one `NetworkEntry` object

### `console`

```json
{
  "schemaVersion": 1,
  "command": "console",
  "count": 3,
  "entries": [
    {
      "source": "browser",
      "level": "error",
      "text": "Something failed"
    }
  ]
}
```

Payload field:

- `entries` — array of `ConsoleEntry` objects

Important console fields:

- `source`
- `level`
- `text`
- `timestamp`
- `pageId`
- `location`

### `errors`

```json
{
  "schemaVersion": 1,
  "command": "errors",
  "count": 2,
  "errors": [
    {
      "source": "step",
      "message": "Synthetic failure"
    }
  ]
}
```

Payload field:

- `errors` — array of `TraceIssue` objects

Important error fields:

- `source`
- `message`
- `name`

### `dom`

The `dom` command always writes full snapshots to a file (`--output` is required). Stdout receives a lightweight confirmation.

**File content** (written to `--output` path):

```json
{
  "schemaVersion": 1,
  "command": "dom",
  "count": 2,
  "savedPath": "/tmp/dom-snapshots.json",
  "snapshots": [
    {
      "callId": "call@123",
      "before": null,
      "action": { "html": "..." },
      "after": null
    }
  ]
}
```

**Stdout confirmation**:

```json
{
  "schemaVersion": 1,
  "command": "dom",
  "count": 2,
  "savedPath": "/tmp/dom-snapshots.json",
  "callIds": ["call@123", "call@456"]
}
```

Stdout confirmation fields:

- `count` — number of action snapshot groups written
- `savedPath` — absolute path to the output file
- `callIds` — list of action callIds in the file

File payload fields:

- `snapshots` — array of `ActionDomSnapshots` objects

Each snapshot item includes:

- `callId`
- `before`
- `action`
- `after`

Each populated phase contains a `DomSnapshot` with fields such as:

- `html` — fully resolved HTML for the main frame. Child `<iframe>`/`<frame>`
  content is inlined recursively as `srcdoc`, so the snapshot is self-contained
  (no `/snapshot/<frameId>` placeholders). `<script>`, inline `on*` handlers, and
  `__playwright*` attributes are stripped.
- `phase`
- `frameUrl`
- `targetElement` — callId of the targeted element when an action marks one;
  resolved even when the target lives inside a child frame
- `viewport`
- `timestamp`

### `timeline`

```json
{
  "schemaVersion": 1,
  "command": "timeline",
  "count": 8,
  "entries": [
    {
      "timestamp": 1712000000000,
      "type": "step"
    }
  ]
}
```

Payload field:

- `entries` — array of `TimelineEntry` objects

Each timeline entry includes:

- `timestamp`
- `type`
- `data`

`type` is one of:

- `step`
- `screenshot`
- `dom`
- `network`

### `attachments`

```json
{
  "schemaVersion": 1,
  "command": "attachments",
  "count": 1,
  "attachments": [
    {
      "id": 1,
      "name": "artifact.txt"
    }
  ]
}
```

Payload field:

- `attachments` — array of `AttachmentEntry` objects

Important attachment fields:

- `id`
- `callId`
- `actionTitle`
- `name`
- `contentType`
- `sha1`
- `size`

### `attachment`

```json
{
  "schemaVersion": 1,
  "command": "attachment",
  "attachment": {
    "id": 1,
    "savedPath": "/tmp/artifact.txt"
  }
}
```

Payload field:

- `attachment` — one `SavedAttachment` object

### `screenshots`

```json
{
  "schemaVersion": 1,
  "command": "screenshots",
  "count": 3,
  "screenshots": [
    {
      "savedPath": "/tmp/pw-shots/shot-001.jpeg"
    }
  ]
}
```

Payload field:

- `screenshots` — array of `Screenshot` objects

Each screenshot item includes:

- `sha1`
- `timestamp`
- `pageId`
- `width`
- `height`
- `savedPath`

### `vault-read`

```json
{
  "schemaVersion": 1,
  "command": "vault-read",
  "filename": "my-report-name",
  "content": "# Analysis\n\nMarkdown content of the vault file...",
  "savedPath": null
}
```

Payload fields:

- `filename` — vault file name without `.md` extension
- `content` — raw markdown content of the file
- `savedPath` — absolute path where the file was saved when `--out` was used, `null` otherwise

Notes:

- Default output format is `text` (raw markdown), not `json`
- Discovery: the `analysisFile` field in report descriptors from `search-reports` indicates whether a vault file exists

## Stability Notes

- Phase 1 locks the command envelope shape and payload field names.
- `summary`, `slow-steps`, `steps`, `network`, `dom`, `timeline`, and `screenshots` currently mirror the exported parser data structures used by the CLI.
- `failures` is intentionally different: it is a compact CLI-specific triage contract, not a direct `TraceSummary[]` mirror.
- `find-traces` is a lightweight discovery contract returning trace identity and path data from report metadata, without loading trace contents.
- `vault-read` is a hub-proxied read command; content is not parsed by this package.
- If a future change needs to break one of these contracts, bump `schemaVersion` and document the migration.