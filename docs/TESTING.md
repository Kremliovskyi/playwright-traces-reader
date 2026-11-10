# Testing

The trace compatibility suite is deterministic and does not use AI. It has three layers with different jobs.

Use Node.js 20 or newer for development tests; the pinned Playwright 1.63.0 producer requires it. CI uses Node.js 22.

## Fast tests

```bash
npm test
```

The test command builds the package first so CLI and worker tests exercise the
same compiled entry points shipped to consumers. These tests generate synthetic
reports with fixed timestamps and identifiers. They cover parser edge cases, all
CLI argument and filter behavior, report-hub HTTP contracts, malformed NDJSON,
future trace versions, missing resources, and ZIP extraction freshness.

`tests/failureDigest.test.ts` exercises early passed-attempt filtering against
real synthetic ZIPs, including a 500-passing-archive case. It verifies exact
archive read counts and unchanged failure manifests/evidence-file hashes, plus
failed retries before and after a passing attempt, expected failures,
timeouts/interruption, child-only errors, skipped attempts, missing metadata,
multiple projects, and explicit errors for ambiguous or conflicting metadata.
Known-passing corrupt archives are deliberately not opened; failed and unknown
archives still surface extraction errors. To run this focused suite:

```bash
npm run build && npx jest --runInBand tests/failureDigest.test.ts tests/failureWorkers.test.ts
```

`tests/failureWorkers.test.ts` runs real processes at worker counts 3, 4, and 5
against the sequential reference. It checks evidence-file hashes, manifest order,
duplicate-title suffixes, bounded concurrent jobs and worker reuse, forced
out-of-order completion, zero/one-candidate reports, 500 passing ZIPs, retries,
shared-cache concurrent runs, invalid settings, extraction failures, and unexpected
worker exits. Workers must close before a run resolves or rejects; failed runs
must not leave partially published output or remove an existing run. The CLI
default of four workers and its JSON/stdout contract are tested directly.

## Committed real report

```bash
npm run test:real-fixture
```

This builds the package and runs every report/trace CLI command twice against `tests/fixtures/real-reports/playwright-1.63.0.zip` (trace schema 9). The archive contains only `index.html`, `data/`, and `provenance.json`; it does not contain browser binaries or trace-viewer UI assets. Synthetic tests retain coverage for older trace schemas and resource representations.

The matrix discovers trace, request, attachment, call, and output identifiers from command responses. It asserts stable semantic markers and cross-file integrity instead of complete JSON snapshots or generated timings. It also hashes the copied report before and after both runs.

Covered commands:

- `find-traces`, `failures`, and `digest`
- `summary`, `slow-steps`, and `steps`
- `network` and dependent `request`
- `console` and `errors`
- `attachments` and dependent `attachment`
- `dom`, `timeline`, and `screenshots`

The suite also generates fresh, browser-free reports using the pinned Playwright
development dependency. A four-test serial group fails in case 4 on the initial
attempt, then fails in case 2 on retry after that test initially passed. The
regression checks actual attempt statuses, selects only the two failed attempts,
and verifies that each has its own `error.md`. Both `on` and `retain-on-failure`
trace modes are covered. Run only this regression with:

```bash
npm run test:real-fixture -- -t "serial retries"
```

## Fresh reports

Generate a report with any published Playwright version:

```bash
npm run compatibility:generate -- \
  --playwright-version 1.63.0 \
  --output ./tmp/compatibility-1.63.0
```

Use an already installed browser cache when regenerating locally:

```bash
npm run compatibility:generate -- \
  --playwright-version 1.63.0 \
  --output ./tmp/compatibility-1.63.0 \
  --skip-browser-install
```

Run the same matrix against the generated report:

```bash
PWTR_COMPAT_REPORT=./tmp/compatibility-1.63.0/playwright-report \
  npm run compatibility:run
```

The compatibility producer uses public `@playwright/test` APIs in an isolated temporary npm project. Its selected version does not change this package's runtime dependencies or the pinned development dependency used by the serial regression.

## Upgrading the production baseline

The production baseline is the exact Playwright version in `tests/compatibility/versions.json` and the matching committed report in `tests/fixtures/real-reports/`. It is a deterministic PR fixture, not the maximum Playwright version the reader supports. The scheduled `latest` and `next` lanes test newer versions independently.

Use an exact published version, not a moving tag such as `latest`. For example, the upgrade from 1.59.0 to the current 1.63.0 baseline starts by generating the candidate report and fixture:

```bash
npm run compatibility:generate -- \
  --playwright-version 1.63.0 \
  --output ./tmp/compatibility-1.63.0 \
  --archive ./tests/fixtures/real-reports/playwright-1.63.0.zip
```

Validate the generated report before changing any baseline references:

```bash
PWTR_COMPAT_REPORT=./tmp/compatibility-1.63.0/playwright-report \
  npm run compatibility:run
```

When the candidate passes, update these baseline references together:

1. Set `production` to `1.63.0` in `tests/compatibility/versions.json`.
2. Pin the `@playwright/test` development dependency to the same exact version and update the lockfile with `npm install --save-dev --save-exact @playwright/test@1.63.0`. This keeps the browser-free serial retry regression on the production baseline.
3. Change the fixture filename, expected `resolvedPlaywrightVersion`, and expected `traceVersions` in `tests/realReportCompatibility.test.ts` to match the generated provenance.
4. Replace the baseline version and fixture filename in `docs/TESTING.md` and `docs/COMPATIBILITY.md`.

The fresh-report workflow uses `ubuntu-latest`. When its operating system changes, verify that every producer in the matrix supports the new runner; an unsupported runner can fail browser installation before compatibility is tested. Playwright 1.63.0 supports Ubuntu 26.04.

Then run the complete suite:

```bash
npm run test:all
```

After it passes, delete the old fixture and commit the new fixture with the code and documentation changes:

```bash
rm ./tests/fixtures/real-reports/playwright-1.59.0.zip
```

Review `provenance.json` inside the new archive. It records the resolved Playwright version, trace schema, producer revision, scenario names, and SHA-256 checksums for every parser input.

Do not raise `MAX_SUPPORTED_TRACE_VERSION` merely because the Playwright package version changed. Change that limit only after a newer trace schema has been investigated, supported by the parser, and covered by compatibility tests. For example, Playwright 1.63.0-alpha-2026-08-24 introduced schema 9 by replacing `_apiRequest` with `_apiRequestRef`; the schema limit was raised only after the full command matrix passed against that producer's report.

Do not automatically commit weekly canary reports. They are uploaded only when a compatibility lane fails.
