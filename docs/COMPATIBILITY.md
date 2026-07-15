# Compatibility

## Supported input

The guaranteed input is a Playwright Test HTML report containing trace attachments. The report may contain trace ZIPs or extracted trace directories.

Raw library traces created directly by `browserContext.tracing.stop()` are not yet part of the compatibility guarantee because report metadata and `test.trace` are absent. Some single-trace commands may work with them, but there is no tested command-subset contract yet.

## Version policy

Compatibility is tracked at two levels:

1. The trace schema version from the `context-options.version` event.
2. The producing package version from `context-options.playwrightVersion` and fixture provenance.

The parser currently validates trace schema version 8. A trace with a newer schema is rejected with `UnsupportedTraceVersionError` instead of being partially parsed. Multiple schema versions inside one trace are rejected with `InconsistentTraceVersionError`.

The scheduled matrix validates:

- Production baseline: Playwright 1.59.0.
- npm `latest`: current stable Playwright.
- npm `next`: early warning for the next release.

The exact versions resolved from moving tags are recorded in each generated `provenance.json`. A failing `next` lane is intentional and visible; it is not treated as an allowed failure.

## Drift detection

`inspectTraceCompatibility()` reports:

- Trace schema and Playwright package versions.
- Event counts by file and event type.
- Every SHA-backed resource reference.
- References whose resource files are missing.

Unknown additive event types are reported but not rejected. Malformed NDJSON always fails with its file and line number. ZIPs are extracted into an atomic content-addressed cache, so changed archive bytes cannot reuse a stale extraction and input reports are never modified.

## CI cadence

Pull requests run synthetic tests and the committed real fixture without installing a browser. A weekly and manually dispatchable workflow generates fresh Chromium reports in parallel for production, `latest`, and `next`, then runs the same command matrix.

When a scheduled lane fails, download its `trace-compatibility-*` artifact. The artifact includes the exact report, JSON reporter output, and provenance. Reproduce with the resolved package version from provenance rather than the moving tag.