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

It does not own report inventory, report search, remote storage access, or historical report catalog behavior. Those concerns belong outside this package.

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
- `[N]-trace.trace` contains browser context events such as `context-options`, `frame-snapshot`, and `screencast-frame`.
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
    helpers.ts          CLI path resolution and shared helpers
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
- `getNetworkTraffic(ctx)` parses all `*.network` files and resolves bodies from `resources/`.
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
- `getFailedTestSummaries(reportDataDir, options?)` performs report-level failure analysis and retry deduplication.

Important current behavior:

- `getSummary()` runs step extraction, network extraction, DOM extraction, and title extraction in parallel.
- `getSummary()` works for both passed and failed traces.
- `getSummary()` filters hook roots out of `topLevelSteps`.
- `getSummary()` uses report metadata when available to populate `outcome`.
- `getFailedTestSummaries()` uses `getTopLevelFailures()` as a cheap pre-filter before building full summaries.
- `getFailedTestSummaries()` deduplicates retries by `testId` when report metadata exists, then falls back to `getTestTitle()`, then `traceDir`.
- `getFailedTestSummaries()` keeps the last retry by comparing the latest root-step end time.

This is the main library interface for consumers that need analysis rather than raw events.

### 4. CLI Layer

Implemented across `src/cli.ts`, `src/cli/helpers.ts`, `src/cli/formatters.ts`, and `src/cli/json.ts`.

The CLI is now a real analysis interface, not just a scaffolding helper.

Command surface:

- `init-skills [targetDir]`
- `failures <reportPath>`
- `summary <tracePath>`
- `slow-steps <tracePath>`
- `steps <tracePath>`
- `network <tracePath>`
- `dom <tracePath>`
- `timeline <tracePath>`
- `screenshots <tracePath> --out-dir <path>`

Output modes:

- `--format text` for terminal-oriented output
- `--format json` for machine-readable output

Supporting pieces:

- `helpers.ts` resolves report/data paths, loads report metadata for trace commands, validates integers, and scaffolds the skill.
- `formatters.ts` contains the text renderers so command handlers remain thin.
- `json.ts` defines stable versioned JSON envelopes for each command.

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
- passing, failing, skipped, and retry scenarios

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
  -> listTraces
  -> getTopLevelFailures per trace
  -> retry grouping and skip filtering
  -> getSummary for winning traces only
  -> TraceSummary[]
  -> optional CLI formatter or JSON envelope
```

## Design Constraints

The current architecture follows these constraints:

1. Keep parsing and extraction logic independent from command-line formatting.
2. Keep CLI commands independent from external services and remote storage.
3. Keep report metadata handling optional so single-trace analysis still works without `index.html`.
4. Keep test coverage self-contained so the package does not rely on external fixture repositories.
5. Keep the public library usable independently of the CLI.

## Relationship To Future Hub Work

Today, `playwright-traces-reader` is a local parser and analysis tool.

The future role described in [CLI_ARCHITECTURE.md](CLI_ARCHITECTURE.md) stays the same:

- this package remains the parsing and CLI engine
- `playwright-reports` can import it in-process for historical workflows
- remote resolution and materialization stay outside this package

That means the current implementation already matches the intended boundary: local artifacts in, structured analysis out.

## Summary

The current architecture is:

- a low-level artifact access layer
- a high-level extraction and summary layer
- a real local CLI with text and JSON outputs
- a CLI-first skill scaffold for agents
- a self-contained synthetic test harness

This keeps the package small, local, and reusable while still providing a stable automation surface for agents and future higher-level consumers.