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

```json
{
  "schemaVersion": 1,
  "command": "failures",
  "count": 2,
  "failures": [
    {
      "tracePath": "/absolute/path/to/report/data/trace-fail-latest",
      "traceSha1": "trace-fail-latest",
      "testTitle": "tests/example.spec.ts:10 › suite › test",
      "title": "main step",
      "status": "failed",
      "outcome": "unexpected",
      "durationMs": 800,
      "errorMessage": "Synthetic failure for trace-fail-latest",
      "networkCallCount": 2,
      "networkErrorCount": 2,
      "issueCount": 3,
      "correlatedActionCount": 1,
      "primaryRelatedAction": {
        "action": {
          "callId": "call@trace-fail-latest",
          "title": "Click failing submit button"
        },
        "networkCallCount": 2,
        "failingNetworkCallCount": 2,
        "issueCount": 2
      },
      "hasFailureDomSnapshot": true
    }
  ],
  "patterns": {
    "repeatedFailingRequests": [
      {
        "signature": "POST /:id/api-call",
        "count": 2
      }
    ],
    "repeatedIssues": [
      {
        "signature": "page | PageError | page error :trace",
        "count": 2
      }
    ]
  }
}
```

Payload field:

- `failures` — array of compact failure records for report-level triage
- `patterns` — repeated failing-request and repeated correlated-issue groups across unique non-skipped failures

Each failure item includes:

- `testTitle` — full canonical Playwright test title when available
- `title` — main failing root-step title
- `status` — trace status
- `outcome` — report outcome when metadata is available
- `durationMs` — main root-step duration
- `errorMessage` — compact top error message
- `tracePath` — direct input path for `summary <tracePath>`
- `traceSha1` — trace directory identifier
- `networkCallCount` — number of network entries in the trace summary
- `networkErrorCount` — number of network entries with status >= 400
- `issueCount` — number of issues in the trace summary
- `correlatedActionCount` — number of related browser actions with aggregated diagnostics
- `primaryRelatedAction` — top action diagnostic for the failure when available
- `hasFailureDomSnapshot` — whether summary identified a nearest failure DOM snapshot

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
- `failureDomSnapshot`

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
- `stack`
- `timestamp`
- `callId`
- `title`
- `location`

### `dom`

```json
{
  "schemaVersion": 1,
  "command": "dom",
  "count": 2,
  "snapshots": [
    {
      "callId": "call@123",
      "before": null,
      "after": null
    }
  ]
}
```

Payload field:

- `snapshots` — array of `ActionDomSnapshots` objects

Each snapshot item includes:

- `callId`
- `before`
- `action`
- `after`

Each populated phase contains a `DomSnapshot` with fields such as:

- `html`
- `phase`
- `frameUrl`
- `targetElement`
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

## Stability Notes

- Phase 1 locks the command envelope shape and payload field names.
- `summary`, `slow-steps`, `steps`, `network`, `dom`, `timeline`, and `screenshots` currently mirror the exported parser data structures used by the CLI.
- `failures` is intentionally different: it is a compact CLI-specific triage contract, not a direct `TraceSummary[]` mirror.
- If a future change needs to break one of these contracts, bump `schemaVersion` and document the migration.