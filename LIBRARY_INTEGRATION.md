# Library Integration Guide

This document is for in-process consumers of `playwright-traces-reader`, such as future integration inside `playwright-reports`.

Agents working on test repositories should prefer the CLI instead of these APIs.

## Intended Audience

- `playwright-reports`
- internal tooling that imports the package directly
- maintainers extending parser behavior

## Main Integration Rule

Keep the integration artifact-centric.

The library should receive local resolved artifacts such as:

- report root directory
- report `data/` directory
- extracted trace directory
- trace zip

Remote storage lookup, metadata search, and materialization should stay outside the library.

## Recommended Entry Points

### Report-level failure analysis

Use `getFailedTestSummaries(reportDataDir, options?)` when the consumer needs one summary per unique failing test.

What it handles:

- passing tests excluded
- retries deduplicated
- skipped tests optionally excluded
- `outcome` populated from report metadata when available

### Single-trace analysis

Use `getSummary(traceContext, options)` when the consumer already has one trace and wants the main analysis bundle.

What it includes:

- `status`
- `outcome`
- `durationMs`
- `error`
- `topLevelSteps`
- `slowestSteps`
- `networkCalls`
- `failureDomSnapshot`

Important behavior:

- works for passed and failed traces
- passed traces return `failureDomSnapshot: null`

### Trace preparation

Use `prepareTraceDir(tracePath)` when the consumer has one extracted trace directory or trace zip.

### Multi-trace discovery

Use `listTraces(reportDataDir)` when iterating through every trace in a report.

### Report metadata

Use `getReportMetadata(reportDir)` and `buildReportTraceMaps(meta)` when the consumer needs outcome mapping or retry-aware trace identity.

## Lower-Level Extractors

These are useful when the integration needs more control than `getSummary()` provides:

- `getTestSteps()`
- `getTopLevelFailures()`
- `getNetworkTraffic()`
- `extractScreenshots()`
- `getDomSnapshots()`
- `getTimeline()`
- `getTestTitle()`

## Suggested Integration Shape For `playwright-reports`

1. Resolve a report from the catalog or source provider.
2. Materialize it locally if needed.
3. Call the library in process.
4. Convert the library result to report-hub-specific view models or API responses.

## When Not To Use The Library Directly

Do not prefer direct library calls when:

- the workflow is already covered by the CLI and the user is working in a test repository
- the task is agent-driven and can be completed through a supported command

In those cases, the CLI is the preferred interface.