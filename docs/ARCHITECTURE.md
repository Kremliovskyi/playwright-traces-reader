# Playwright Traces Reader Architecture

For the future hub boundary and long-term positioning with `playwright-reports`, see [CLI_ARCHITECTURE.md](CLI_ARCHITECTURE.md).

For command-by-command CLI usage, see [CLI_REFERENCE.md](CLI_REFERENCE.md).

For versioned JSON outputs, see [CLI_JSON_CONTRACTS.md](CLI_JSON_CONTRACTS.md).

This document describes the current architecture of `playwright-traces-reader` as it exists today: a parser and extractor library with a real local CLI, stable JSON output envelopes, and a CLI-first GitHub Copilot skill scaffold.

## Current Role

`playwright-traces-reader` owns three things:

- local artifact parsing for Playwright traces and reports
- high-level extraction and summarization APIs over those artifacts
- a local CLI for humans, agents, and automation

It does not own report inventory, metadata persistence, remote storage access, or historical report catalog behavior. Those concerns belong outside this package.

It can, however, query an external local `playwright-reports` hub for thin discovery and preparation steps before parsing begins. It can also read vault analysis markdown files from the hub when reports have associated notes. That does not make this package the source of truth for report search or vault storage; it remains a consumer of that external catalog.

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
  failureDigest.ts      per-report failure digest writer (failures command)
  digestTrace.ts        per-trace whole-test digest writer (digest command)
  index.ts              public exports
  cli.ts                command-line entry point
  cli/
    helpers.ts          CLI path resolution, report-hub helpers, and shared utilities
    formatters.ts       human-readable text output formatters
    json.ts             versioned JSON command envelopes
docs/
  ARCHITECTURE.md       this document
  CLI_ARCHITECTURE.md   future hub boundary and long-term positioning
  CLI_JSON_CONTRACTS.md versioned JSON output contracts
  CLI_REFERENCE.md      command-by-command CLI usage
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
- discovering trace paths for tests matching a name pattern from report metadata

Primary APIs:

- `prepareTraceDir(tracePath)`
- `listTraces(reportDataDir)`
- `readNdjson(filePath)`
- `getResourceBuffer(traceContext, sha1)`
- `getReportMetadata(reportDir)`
- `buildReportTraceMaps(meta)`
- `findTraces(reportDir, grep, options?)` — searches report metadata for tests matching a name pattern and returns trace paths for all matching results including retries

`findTraces()` works entirely from report metadata embedded in `index.html`. It does not open or scan trace directories. The `grep` argument is always treated as a literal case-insensitive substring (not a regex) so that arbitrary test names — including brackets, parentheses, quotes, and non-Latin scripts — can be pasted directly without escaping. Unicode case folding is enabled via the `u` flag.

#### Trace ZIP materialization cache

`prepareTraceDir()` never extracts a ZIP beside the source report. It hashes the archive bytes with SHA-256 and materializes the trace under the operating system's temporary directory:

```text
<os.tmpdir>/playwright-traces-reader/trace-cache/
|-- .leases/<pid>-<uuid>.json
|-- .maintenance-lock/
`-- <archive-digest>/
  |-- .last-access
  `-- <trace-name>/
```

The archive digest makes changed ZIP bytes select a new cache entry, while the final `trace-name` directory preserves the identity expected by report metadata. Identical in-process requests share one pending extraction promise. Across processes, each caller extracts into a unique staging directory and atomically renames the completed trace directory into the content-addressed destination.

Cache publication handles filesystem contention as follows:

- `EEXIST` and `ENOTEMPTY` are treated as another caller winning only when the final trace directory exists.
- On Windows, `EPERM` can mean either that the destination already exists or that antivirus/indexing software briefly holds a new file. A verified completed destination is accepted; otherwise the rename is retried with exponential backoff for up to five attempts.
- Staging-directory removal uses the recursive `fs.rm` retry options so transient Windows locks do not leave avoidable `<digest>-<random>` directories behind.

Age-based maintenance runs once before each trace-reading CLI command and on the first direct-library ZIP preparation in a process. A completed digest is removed after 24 hours without access; a staging directory is removed after 1 hour. Cache hits and successful publications touch `.last-access`. `PWTR_CACHE_MAX_AGE_HOURS` and `PWTR_CACHE_STAGING_MAX_AGE_HOURS` override the defaults, and `0` disables the corresponding policy. Invalid or negative values fall back to the default. There is intentionally no size cap.

Each command creates a process lease before waiting for the short-lived maintenance lock. Under that lock, dead-process leases are removed and pruning proceeds only when no other live lease exists. This ordering prevents one process from deleting entries while another starts reading. Direct library consumers acquire a conservative process-lifetime lease on first ZIP use. A crashed process may leave a lease or lock behind; the next maintenance pass removes dead leases and atomically reclaims a dead or explicitly released lock.

Maintenance and access tracking are best-effort so cleanup failures do not replace the requested analysis result. It is still safe to remove the entire cache when no reader command or library consumer is running; the next ZIP operation recreates entries from source archives.

This layer has no formatting logic and no agent-specific behavior.

### 2. Extraction Layer

Implemented in `extractors.ts`.

This layer converts low-level trace events into structured domain objects.

Core extractors:

- `getTestSteps(ctx)` reconstructs the nested step tree from `test.trace`.
- `getTopLevelFailures(ctx)` returns only root steps with errors.
- `getNetworkTraffic(ctx, options?)` parses all `*.network` files, resolves bodies from `resources/`, assigns per-trace request IDs, correlates requests to nearby browser actions, and records each request's `monotonicTime` (from the resource snapshot's `_monotonicTime`) for time-window linking against the step tree.
- `getNetworkRequest(ctx, requestId)` returns one detailed request by the per-trace ID returned from `getNetworkTraffic()`.
- `getConsoleEntries(ctx)` extracts browser console, page-error, stdout, and stderr signals.
- `getTraceIssues(ctx)` combines step failures, page errors, and trace-level issues into one correlated issue stream.
- `getAttachments(ctx)` lists trace attachments with per-trace attachment IDs.
- `extractAttachment(ctx, attachmentId, outputPath?)` resolves and writes one attachment by its per-trace ID.
- `extractScreenshots(ctx, outDir)` writes screencast frames to disk and returns metadata.
- `getDomSnapshots(ctx, options?)` groups `before`, `action`, and `after` snapshots by `callId`. It resolves Playwright's compact snapshot format (text, back-references, elements) and recursively inlines child `<iframe>`/`<frame>` snapshots into the parent as `srcdoc`, producing self-contained HTML. Frames are matched by `frameId` (from `src="/snapshot/<frameId>"`) and the action's `snapshotName`; cycles and depth are guarded. When `options.phase` is set, only that phase is rendered — the expensive back-reference DFS is skipped for the discarded phases (~3x fewer renders when only `action`/`input@` snapshots are needed).
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
- `writeFailureDigests(reportDataDir, outputDir, options?)` writes one self-contained folder per failed attempt (including each failed retry) and returns the run manifest.
- `writeTraceDigest(ctx, outputDir, options?)` writes one self-contained folder for a single trace (any status) and returns a compact manifest. Implemented in `digestTrace.ts`.

Important current behavior:

- `getSummary()` runs step extraction, network extraction, DOM extraction, title extraction, and issue extraction in parallel.
- `getSummary()` works for both passed and failed traces.
- `getSummary()` filters hook roots out of `topLevelSteps`.
- `getSummary()` includes `issues` and aggregated `actionDiagnostics` alongside step, network, and DOM data.
- `getSummary()` returns a lightweight `FailureDomSnapshotRef` (callId, phases, timestamp, frameUrl, targetElement) instead of full DOM HTML. Agents use the `dom` command with `--near <callId>` to retrieve full snapshots on demand.
- `getSummary()` uses report metadata when available to populate `outcome`.
- `getFailedTestSummaries()` uses `getTopLevelFailures()` as a cheap pre-filter before building full summaries.
- `getFailedTestSummaries()` deduplicates retries by `testId` when report metadata exists, then falls back to `getTestTitle()`, then `traceDir`.
- `getFailedTestSummaries()` keeps the last retry by comparing the latest root-step end time.
- `getFailedTraceSelections()` reuses the same retry-selection logic but returns both the selected trace identity (`tracePath`, `traceSha1`) and the rich `TraceSummary`.
- `writeFailureDigests()` walks every failed attempt (no retry dedup). Inclusion is gated on the authoritative per-result `status` from `report.json` (`failed`, `timedOut`, or `interrupted` are included; `skipped` is honored by `--exclude-skipped`; `passed` is excluded), which is the same signal the HTML report uses. This correctly captures tests that aborted mid-step — where the error lives only on a child step and the root step has no error — because such attempts are missed by `getTopLevelFailures()` (it only returns root steps with errors). When no report metadata is available, it falls back to scanning for root-step failures via `getTopLevelFailures()`. For each included attempt it writes a folder with `failure.json`, screenshots around failure anchors, the Action-phase DOM at each anchor (`dom/<callId>.html`, referenced from `screenshots[]`), `network-errors.ndjson` (failing requests with per-anchor timing and 32 KB body spill to `network-error-bodies.ndjson`), `console-errors.ndjson`, and Playwright's error markdown when present. The `failure.json` still carries the lightweight `failureDomSnapshot` pointer (callId/phases/timestamp/frameUrl/targetElement) for the in-memory summary, but the failure-moment DOM html is now on disk too — so triage needs no follow-up `dom --near <callId>` call. The NDJSON companions and body-spill rule are aligned with the `digest` command's `network.ndjson`.
- `writeTraceDigest()` digests a single trace into a folder whose spine is the chronological step tree (`digest.json`). Each leaf action with an `input@` snapshot gets one Action-phase DOM (`dom/<callId>.html`) and the nearest screencast frame (`screenshots/<callId>.png`), paired 1:1 by sanitized `callId`. Every step links the global `seq` ids of all network calls whose `monotonicTime` falls within its `[startTime, endTime]` window, so a parent's links are a superset of its descendants'. Network is written as chronological NDJSON (`network.ndjson`, one exchange per line, global `seq`); text/JSON request and response bodies over 32 KB are spilled to the shared `network-bodies.ndjson`. Spilled lines carry `direction` and are back-linked by `(seq, direction)`; network lines retain independent request/response size, binary, large, and reference metadata so consumers decide before reading. Console output is written to `console.ndjson`. Unlike `getSummary()`/`writeFailureDigests()`, it covers the whole test rather than failure points, and works for passed, failed, and flaky traces.

This is the main library interface for consumers that need analysis rather than raw events.

### 4. CLI Layer

Implemented across `src/cli.ts`, `src/cli/helpers.ts`, `src/cli/formatters.ts`, and `src/cli/json.ts`.

The CLI is now a real analysis interface, not just a scaffolding helper.

Command surface:

- `search-reports [query]`
- `prepare-report <reportRef>`
- `init-skills [targetDir]`
- `failures <reportPath> <outputDir>`
- `digest <tracePath> <outputDir>`
- `find-traces <reportPath> <grep>`
- `summary <tracePath>`
- `slow-steps <tracePath>`
- `steps <tracePath>`
- `network <tracePath>`
- `request <tracePath> <requestId>`
- `console <tracePath>`
- `errors <tracePath>`
- `dom <tracePath>` — requires `--output <path>`; writes full DOM snapshots to a file and emits a lightweight confirmation on stdout
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
- `failures` writes one self-contained folder per failed attempt into a timestamped run directory and returns a compact manifest on stdout. Each folder bundles `failure.json`, screenshots and the Action-phase DOM at each failure anchor, NDJSON network/console errors (`network-errors.ndjson` + optional `network-error-bodies.ndjson`, `console-errors.ndjson`), and Playwright's `error.md`. Request and response bodies over 32 KB share the bodies file and are keyed by `(seq, direction)`; the NDJSON formats and spill rule match the `digest` command.
- `digest` writes one self-contained folder for a single trace (any status) into a timestamped run directory and returns a compact manifest on stdout. The folder bundles `digest.json` (the chronological step tree with per-step artifact links), per-leaf-action DOM and screenshots paired 1:1, chronological `network.ndjson` (+ optional `network-bodies.ndjson` for spilled large bodies), and `console.ndjson`. Network is linked to steps by `monotonicTime` window.
- `summary` remains the full deep-inspection payload for one trace, including issues and action diagnostics. The `failureDomSnapshot` field is a lightweight metadata reference (callId, phases, timestamp, frameUrl) rather than full HTML, keeping the JSON payload small.
- `dom` always writes full DOM snapshots to a file (`--output` is required). Stdout receives a lightweight confirmation with `savedPath`, `count`, and `callIds` — never the full HTML.
- `network` is the listing surface for discovering per-trace `requestId` values later consumed by `request`.
- `attachments` is the listing surface for discovering per-trace `attachmentId` values later consumed by `attachment`.
- `find-traces` is a lightweight metadata-only discovery command. It reads report metadata from `index.html`, matches tests by literal case-insensitive substring, and returns trace paths without opening any trace files. It supports `--outcome` filtering and returns all retries for matched tests.

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

The `failures` command writes per-failure folders to disk and returns a compact manifest at the CLI layer. Each folder bundles a `failure.json` digest plus screenshots, network errors, console errors, the failure DOM, and Playwright's error markdown when available, so an agent can read everything about one failure from disk in a single pass.

The `summary` payload is richer than the initial implementation and now includes:

- `issues`
- `actionDiagnostics`

The `network` and `attachments` payloads expose per-trace numeric IDs that drive the `request` and `attachment` drilldown commands.

The `find-traces` payload is a lightweight discovery contract. It returns trace identity and path data extracted from report metadata without loading any trace contents. Each entry includes the full test title, test ID, project name, file, outcome, retry index, trace SHA1, and absolute trace path. The grep input is escaped as a literal substring to safely handle arbitrary test names with special characters and non-Latin scripts.

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

The skill is the agent-facing command surface.

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
- a failed test with multiple retries, screencast frames, failing 4xx/5xx network calls, console errors, and an error-context markdown attachment for failure-digest tests

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
  -> writeFailureDigests
  -> listTraces
  -> gate each attempt on report.json result status (fallback: getTopLevelFailures); no retry dedup
  -> getSummary for each failed attempt
  -> per-failure folder: failure.json + screenshots + network-errors + console-errors + failure-dom + error.md
  -> runDir/index.json manifest
  -> compact manifest on stdout (CLI formatter or JSON envelope)
```

### Trace discovery by test name

```text
report root
  -> getReportMetadata (report.json from index.html)
  -> literal case-insensitive substring match against full test titles
  -> optional outcome filter (expected / unexpected / flaky / skipped)
  -> map matching results to trace SHA1 paths in data/
  -> all retries included (one entry per result with a trace attachment)
  -> FoundTrace[] with testTitle, testId, projectName, file, outcome, resultIndex, tracePath, traceSha1
  -> optional CLI formatter or JSON envelope
```

Important behavior:

- The grep input is always escaped as a literal substring. Users can paste any fragment from a test name — brackets (`[UAT EU - 3/30]`), parentheses (`(mocked vendor)`), quotes (`"none of the above"`), dots, pipes, and non-Latin scripts (Cyrillic, CJK, Arabic, Korean, emoji) all match correctly without manual escaping.
- Unicode case folding is enabled so `Straße` matches `straße` and vice versa.
- Per-result pass/fail status is not available from the HTML report metadata. The test-level `outcome` field is provided instead (`expected` = all retries passed, `unexpected` = all failed, `flaky` = mixed).
- Results without a trace attachment (e.g. skipped tests with no execution) are excluded.
- `findTraces()` does not open or extract any trace directories — it operates purely on report metadata, making it lightweight even for large reports.

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