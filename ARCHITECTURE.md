# Playwright Traces Reader Architecture

For the future hub boundary and long-term positioning with `playwright-reports`, see [CLI_ARCHITECTURE.md](CLI_ARCHITECTURE.md).

For command-by-command CLI usage, see [CLI_REFERENCE.md](CLI_REFERENCE.md).

For versioned JSON outputs, see [CLI_JSON_CONTRACTS.md](CLI_JSON_CONTRACTS.md).

For in-process consumption guidance, see [LIBRARY_INTEGRATION.md](LIBRARY_INTEGRATION.md).

This document describes the current architecture of `playwright-traces-reader` as it exists today: a parser and extractor library with a real local CLI, stable JSON output envelopes, and a CLI-first GitHub Copilot skill scaffold.

## Current Role

`playwright-traces-reader` owns three things:

- local artifact parsing for Playwright traces and reports
- high-level extraction and summarization APIs over those artifacts
- a local CLI for humans, agents, and automation

It does not own report inventory, metadata persistence, remote storage access, or historical report catalog behavior. Those concerns belong outside this package.

It can, however, query an external local `playwright-reports` hub for thin discovery and preparation steps before parsing begins. That does not make this package the source of truth for report search; it remains a consumer of that external catalog.

## Supported Inputs

The package is artifact-centric. It operates on local filesystem inputs only:

- a Playwright report root containing `index.html` and `data/`
- a report `data/` directory
- a single extracted trace directory
- a single trace zip

This same input model is used by both the library APIs and the CLI.

## Trace Layout

Playwright HTML reports store one trace per test execution under `data/`.

Each SHA1 trace entry may exist either as an extracted directory or as a `.zip` file.

Typical contents of one extracted trace directory:

```text
<sha1>/
├── test.trace          step tree and root test flow
├── 0-trace.trace       browser context events, snapshots, screenshots, context-options
├── 0.network           request and response metadata
└── resources/          blobs referenced by sha1
```

Important file roles:

- `test.trace` contains `before` and `after` events used to reconstruct step trees, durations, and failures.
- `[N]-trace.trace` contains browser context events such as `context-options`, `frame-snapshot`, `screencast-frame`, console entries, page errors, stdout/stderr, and action-level attachments.
- `*.network` contains HAR-like `resource-snapshot` events for network traffic.
- `resources/` stores request bodies, response bodies, and screenshot blobs.

All trace files are newline-delimited JSON.

## Package Structure

```text
src/
  parseTrace.ts         low-level artifact discovery and file access
  extractors.ts         high-level parsing and summarization APIs
  index.ts              public exports
  cli.ts                command-line entry point
  cli/
    helpers.ts          CLI path resolution, report-hub helpers, and shared utilities
    formatters.ts       human-readable text output formatters
    json.ts             versioned JSON command envelopes
templates/
  skills/
    analyze-playwright-traces/
      SKILL.md          CLI-first GitHub Copilot skill template
tests/
  syntheticReport.ts    synthetic Playwright report and trace generator
  cli.test.ts           CLI integration tests using generated artifacts
  sanity.test.ts        library integration tests using generated artifacts
```

## Architecture Layers

The package is intentionally split into four layers.

### 1. Artifact Access Layer

Implemented in `parseTrace.ts`.

This layer is responsible for:

- resolving a trace directory from either a directory or a `.zip`
- scanning a report `data/` directory for valid traces
- reading NDJSON files as async streams
- loading raw resource blobs by SHA1
- loading report metadata from `index.html`
- building lookup maps from report metadata

Primary APIs:

- `prepareTraceDir(tracePath)`
- `listTraces(reportDataDir)`
- `readNdjson(filePath)`
- `getResourceBuffer(traceContext, sha1)`
- `getReportMetadata(reportDir)`
- `buildReportTraceMaps(meta)`

This layer has no formatting logic and no agent-specific behavior.

### 2. Extraction Layer

Implemented in `extractors.ts`.

This layer converts low-level trace events into structured domain objects.

Core extractors:

- `getTestSteps(ctx)` reconstructs the nested step tree from `test.trace`.
- `getTopLevelFailures(ctx)` returns only root steps with errors.
- `getNetworkTraffic(ctx, options?)` parses all `*.network` files, resolves bodies from `resources/`, assigns per-trace request IDs, and correlates requests to nearby browser actions.
- `getNetworkRequest(ctx, requestId)` returns one detailed request by the per-trace ID returned from `getNetworkTraffic()`.
- `getConsoleEntries(ctx)` extracts browser console, page-error, stdout, and stderr signals.
- `getTraceIssues(ctx)` combines step failures, page errors, and trace-level issues into one correlated issue stream.
- `getAttachments(ctx)` lists trace attachments with per-trace attachment IDs.
- `extractAttachment(ctx, attachmentId, outputPath?)` resolves and writes one attachment by its per-trace ID.
- `extractScreenshots(ctx, outDir)` writes screencast frames to disk and returns metadata.
- `getDomSnapshots(ctx, options?)` groups `before`, `action`, and `after` snapshots by `callId`.
- `getTimeline(ctx)` merges step, screenshot, DOM, and network events into one chronological stream.
- `getTestTitle(ctx)` reads `context-options` and returns the canonical full test title.

The extractors stay artifact-focused. They do not know about report catalogs, databases, or remote providers.

### 3. Summary Layer

Also implemented in `extractors.ts`.

This layer composes several extractors into higher-level workflows.

Main APIs:

- `getSummary(ctx, options)` builds one `TraceSummary` for a single trace.
- `getFailedTraceSelections(reportDataDir, options?)` selects the winning failed traces and pairs them with trace identity metadata.
- `getFailedTestSummaries(reportDataDir, options?)` performs report-level failure analysis and retry deduplication.
- `getReportFailurePatterns(reportDataDir, options?)` groups repeated failing requests and repeated correlated issues across unique failed traces.
- `summarizeReportFailurePatterns(selections)` computes the same cross-trace pattern summary from already selected failures.

Important current behavior:

- `getSummary()` runs step extraction, network extraction, DOM extraction, title extraction, and issue extraction in parallel.
- `getSummary()` works for both passed and failed traces.
- `getSummary()` filters hook roots out of `topLevelSteps`.
- `getSummary()` includes `issues` and aggregated `actionDiagnostics` alongside step, network, and DOM data.
- `getSummary()` uses report metadata when available to populate `outcome`.
- `getFailedTestSummaries()` uses `getTopLevelFailures()` as a cheap pre-filter before building full summaries.
- `getFailedTestSummaries()` deduplicates retries by `testId` when report metadata exists, then falls back to `getTestTitle()`, then `traceDir`.
- `getFailedTestSummaries()` keeps the last retry by comparing the latest root-step end time.
- `getFailedTraceSelections()` reuses the same retry-selection logic but returns both the selected trace identity (`tracePath`, `traceSha1`) and the rich `TraceSummary`.
- `getReportFailurePatterns()` normalizes request URLs and issue messages so repeated failure signatures can be grouped across distinct traces.

This is the main library interface for consumers that need analysis rather than raw events.

### 4. CLI Layer

Implemented across `src/cli.ts`, `src/cli/helpers.ts`, `src/cli/formatters.ts`, and `src/cli/json.ts`.

The CLI is now a real analysis interface, not just a scaffolding helper.

Command surface:

- `search-reports [query]`
- `prepare-report <reportRef>`
- `init-skills [targetDir]`
- `failures <reportPath>`
- `summary <tracePath>`
- `slow-steps <tracePath>`
- `steps <tracePath>`
- `network <tracePath>`
- `request <tracePath> <requestId>`
- `console <tracePath>`
- `errors <tracePath>`
- `dom <tracePath>`
- `timeline <tracePath>`
- `attachments <tracePath>`
- `attachment <tracePath> <attachmentId>`
- `screenshots <tracePath> --out-dir <path>`

Output modes:

- JSON is the default output mode for CLI commands
- `--format text` remains available for terminal-oriented output

Supporting pieces:

- `helpers.ts` resolves report/data paths, loads report metadata for trace commands, validates integers, talks to the local report hub for `search-reports` and `prepare-report`, and scaffolds the skill.
- `formatters.ts` contains the text renderers so command handlers remain thin.
- `json.ts` defines stable versioned JSON envelopes for each command.

Current CLI contract choices:

- JSON is the default output mode for all commands.
- `search-reports` and `prepare-report` are discovery commands that stop at local path resolution.
- `failures` is intentionally compact and returns CLI-specific triage records plus report-level repeated failure patterns.
- `summary` remains the full deep-inspection payload for one trace, including issues and action diagnostics.
- `network` is the listing surface for discovering per-trace `requestId` values later consumed by `request`.
- `attachments` is the listing surface for discovering per-trace `attachmentId` values later consumed by `attachment`.

### Report-hub discovery flow

The new discovery commands create a thin integration layer with `playwright-reports`:

```text
metadata/date/recency query
  -> search-reports
  -> local playwright-reports hub
  -> reportRef
  -> prepare-report
  -> reportRootPath/reportDataPath
  -> failures/summary/network/dom/timeline
```

Important boundary rules:

- The hub owns search semantics such as metadata matching and date filtering.
- This package treats `reportRef` as opaque.
- After `prepare-report`, all subsequent analysis goes back to purely local artifact parsing.
- If the hub is unavailable, the CLI fails fast with an explicit unreachable-hub message.

## Current Command Flow

Each CLI command follows the same pattern:

1. Resolve the input path into the correct local artifact shape.
2. Call library APIs from `index.ts`.
3. Convert the result into either text output or a versioned JSON envelope.
4. Emit the final output through a small I/O abstraction so the CLI can be tested without a real process.

This is why `runCli(argv, io)` exists: tests can execute the CLI in-process and assert on stdout and stderr deterministically.

## JSON Contract Layer

The CLI JSON output is intentionally explicit and versioned.

All command JSON payloads currently include:

- `schemaVersion`
- `command`
- a command-specific payload such as `summary`, `failures`, `entries`, `steps`, `snapshots`, or `screenshots`

The `failures` command is intentionally compact at the CLI layer. It no longer returns full `TraceSummary` objects. Instead, it returns triage records with enough data to select one failure and call `summary <tracePath>` for full detail.

The `failures` payload also includes grouped repeated failing-request and repeated correlated-issue patterns across unique non-skipped failures.

The `summary` payload is richer than the initial implementation and now includes:

- `issues`
- `actionDiagnostics`

The `network` and `attachments` payloads expose per-trace numeric IDs that drive the `request` and `attachment` drilldown commands.

This contract is documented separately in [CLI_JSON_CONTRACTS.md](CLI_JSON_CONTRACTS.md), but architecturally it matters because it creates a stable boundary for:

- agents
- shell automation
- future integrations
- tests that assert on command shape rather than terminal formatting

## Skill Architecture

The bundled GitHub Copilot skill scaffold is now CLI-first.

`init-skills` copies `templates/skills/analyze-playwright-traces/SKILL.md` into the target repository. That skill is intentionally thin:

- it tells agents to use supported CLI commands
- it avoids temporary script generation
- it points users to `CLI_REFERENCE.md` and `CLI_JSON_CONTRACTS.md`
- it leaves direct library integration guidance to `LIBRARY_INTEGRATION.md`

That split is deliberate. The skill is the agent-facing command surface; the library docs are for in-process consumers.

## Testing Architecture

The test suite no longer depends on stored real reports from another repository.

Instead, the package now uses generated synthetic artifacts created at test runtime.

`tests/syntheticReport.ts` builds a temporary Playwright-like report structure with:

- report `index.html` containing embedded base64 ZIP metadata
- a `data/` directory with multiple trace entries
- both extracted and zip-only traces
- network resources and screenshot blobs
- console, page-error, stdout/stderr, and attachment signals
- passing, failing, skipped, and retry scenarios
- repeated cross-trace failure patterns for aggregation tests

This gives the test suite three benefits:

- no dependency on external repositories or checked-in report artifacts
- deterministic coverage of retry, skip, zip extraction, and metadata mapping behavior
- automatic cleanup after each suite run

Current test split:

- `tests/sanity.test.ts` validates library behavior directly
- `tests/cli.test.ts` validates CLI behavior through `runCli()`

## Data Flow

### Single-trace analysis

```text
trace dir or trace zip
  -> prepareTraceDir
  -> getSummary / getTestSteps / getNetworkTraffic / getDomSnapshots / getTimeline
  -> structured result
  -> optional CLI formatter or JSON envelope
```

### Report-level failure analysis

```text
report root or report data dir
  -> resolveReportDataDir
  -> getFailedTraceSelections
  -> listTraces
  -> getTopLevelFailures per trace
  -> retry grouping and skip filtering
  -> getSummary for winning traces only
  -> summarizeReportFailurePatterns
  -> compact failure records with tracePath, traceSha1, and primary action context
  -> repeated request and issue pattern groups
  -> optional CLI formatter or JSON envelope
```

### Request and attachment drilldown

```text
trace dir or trace zip
  -> prepareTraceDir
  -> network / attachments
  -> choose per-trace requestId / attachmentId
  -> request / attachment
  -> detailed single-item payload or extracted artifact
```

### Hub-assisted report analysis

```text
search-reports
  -> external report hub search
  -> prepare-report
  -> local report root/data path
  -> standard local parser commands
```

## Design Constraints

The current architecture follows these constraints:

1. Keep parsing and extraction logic independent from command-line formatting.
2. Keep parsing and extraction logic independent from report inventory and search ownership.
3. Keep report metadata handling optional so single-trace analysis still works without `index.html`.
4. Keep test coverage self-contained so the package does not rely on external fixture repositories.
5. Keep the public library usable independently of the CLI.

The CLI may depend on an external local hub for discovery, but the parser and library layers do not.

## Relationship To Future Hub Work

Today, `playwright-traces-reader` is a local parser and analysis tool.

The future role described in [CLI_ARCHITECTURE.md](CLI_ARCHITECTURE.md) stays the same:

- this package remains the parsing and CLI engine
- `playwright-reports` remains the report hub for search and resolution
- remote resolution and materialization stay outside this package

That means the current implementation already matches the intended boundary: local artifacts in, structured analysis out.

## Summary

The current architecture is:

- a low-level artifact access layer
- a high-level extraction and summary layer
- a real local CLI with JSON-default output and optional text mode
- a CLI-first skill scaffold for agents
- a self-contained synthetic test harness

This keeps the package small, local, and reusable while still providing a stable automation surface for agents and future higher-level consumers.