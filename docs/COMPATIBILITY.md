# Compatibility

## Supported input

The guaranteed input is a Playwright Test HTML report containing trace attachments. The report may contain trace ZIPs or extracted trace directories.

Raw library traces created directly by `browserContext.tracing.stop()` are not yet part of the compatibility guarantee because report metadata and `test.trace` are absent. Some single-trace commands may work with them, but there is no tested command-subset contract yet.

## Version policy

Compatibility is tracked at two levels:

1. The trace schema version from the `context-options.version` event.
2. The producing package version from `context-options.playwrightVersion` and fixture provenance.

The parser currently validates trace schema versions through 10. A trace with a newer schema is rejected with `UnsupportedTraceVersionError` instead of being partially parsed. Multiple schema versions inside one trace are rejected with `InconsistentTraceVersionError`.

Schema 8 has two resource-reference representations. Older producers use bare `sha1` / `_sha1` values whose blobs live under `resources/`; newer producers use `file` / `_file` paths relative to the trace root. Both representations are accepted and normalized to trace-relative paths. Resource paths are constrained to the trace root before they are read.

Schema 9 replaces the `_apiRequest` boolean on API resource snapshots with an `_apiRequestRef` string. Network source classification remains backward compatible: snapshots with `pageref` are browser requests, while snapshots without it are API requests. Newer schema 9 producers also identify DOM snapshots with separate `callId` and `phase` fields instead of the legacy `snapshotName`; both representations are accepted and normalized to the same action-phase key.

Schema 10 unifies library and test runner action IDs in `callId` and removes the separate `stepId` mapping. The reader already preserves action IDs directly, so no conversion is needed; older trace representations remain supported. The full command matrix was validated against Playwright `1.64.0-alpha-2026-09-14` (schema 10).

The scheduled matrix validates:

- Production baseline: Playwright 1.59.0.
- npm `latest`: current stable Playwright.
- npm `next`: early warning for the next release.

The exact versions resolved from moving tags are recorded in each generated `provenance.json`. A failing `next` lane is intentional and visible; it is not treated as an allowed failure.

## Drift detection

`inspectTraceCompatibility()` reports:

- Trace schema and Playwright package versions.
- Event counts by file and event type.
- Every legacy SHA-backed or trace-relative resource reference.
- References whose resource files are missing.

Unknown additive event types are reported but not rejected. Malformed NDJSON always fails with its file and line number. ZIPs are extracted into an atomic content-addressed cache under `<os.tmpdir>/playwright-traces-reader/trace-cache`, so changed archive bytes cannot reuse a stale extraction and input reports are never modified. Concurrent readers share completed entries: same-process requests are deduplicated, cross-process publication verifies the winning destination, and transient Windows `EPERM` rename failures are retried. Live process leases suppress maintenance. By default, completed entries expire after 24 hours without access and staging entries after 1 hour; the two age policies are configurable or independently disabled. There is no size cap, and the entire cache may be deleted while no reader command or library consumer is running.

## CI cadence

Pull requests run synthetic tests and the committed real fixture without installing a browser. A weekly and manually dispatchable workflow generates fresh Chromium reports in parallel for production, `latest`, and `next`, then runs the same command matrix.

When a scheduled lane fails, download its `trace-compatibility-*` artifact. The artifact includes the exact report, JSON reporter output, and provenance. Reproduce with the resolved package version from provenance rather than the moving tag.
