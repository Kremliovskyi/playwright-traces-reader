# CLI JSON Contracts

This document defines the stable Phase 1 JSON output contracts for `playwright-traces-reader` CLI commands.

Every JSON response is a versioned envelope. Future integrations such as `playwright-reports` should depend on the envelope fields first:

- `schemaVersion`
- `command`
- the named payload field for that command

Current schema version:

```text
1
```

## Envelope Rules

All commands that support `--format json` return an object, not a bare array.

Shared top-level fields:

- `schemaVersion` — integer schema version for the command contract
- `command` — the CLI command name

Some commands also expose:

- `count` — number of items in the payload collection

## Command Contracts

### `failures`

```json
{
  "schemaVersion": 1,
  "command": "failures",
  "count": 2,
  "failures": [
    {
      "testTitle": "tests/example.spec.ts:10 › suite › test",
      "title": "main step",
      "status": "failed"
    }
  ]
}
```

Payload field:

- `failures` — array of `TraceSummary` objects

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

## Stability Notes

- Phase 1 locks the command envelope shape and payload field names.
- Nested payload objects currently mirror the exported parser data structures used by the CLI.
- If a future change needs to break one of these contracts, bump `schemaVersion` and document the migration.