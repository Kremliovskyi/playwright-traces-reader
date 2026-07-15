# Testing

The trace compatibility suite is deterministic and does not use AI. It has three layers with different jobs.

## Fast tests

```bash
npm test
```

These tests generate synthetic reports with fixed timestamps and identifiers. They cover parser edge cases, all CLI argument and filter behavior, report-hub HTTP contracts, malformed NDJSON, future trace versions, missing resources, and ZIP extraction freshness.

## Committed real report

```bash
npm run test:real-fixture
```

This builds the package and runs every report/trace CLI command twice against `tests/fixtures/real-reports/playwright-1.59.0.zip`. The archive contains only `index.html`, `data/`, and `provenance.json`; it does not contain browser binaries or trace-viewer UI assets.

The matrix discovers trace, request, attachment, call, and output identifiers from command responses. It asserts stable semantic markers and cross-file integrity instead of complete JSON snapshots or generated timings. It also hashes the copied report before and after both runs.

Covered commands:

- `find-traces`, `failures`, and `digest`
- `summary`, `slow-steps`, and `steps`
- `network` and dependent `request`
- `console` and `errors`
- `attachments` and dependent `attachment`
- `dom`, `timeline`, and `screenshots`

## Fresh reports

Generate a report with any published Playwright version:

```bash
npm run compatibility:generate -- \
  --playwright-version 1.59.0 \
  --output ./tmp/compatibility-1.59.0
```

Use an already installed browser cache when regenerating locally:

```bash
npm run compatibility:generate -- \
  --playwright-version 1.59.0 \
  --output ./tmp/compatibility-1.59.0 \
  --skip-browser-install
```

Run the same matrix against the generated report:

```bash
PWTR_COMPAT_REPORT=./tmp/compatibility-1.59.0/playwright-report \
  npm run compatibility:run
```

The producer uses public `@playwright/test` APIs in an isolated temporary npm project. It does not add Playwright to this package's runtime dependencies or lockfile.

## Upgrading the production baseline

The production baseline is the exact Playwright version in `tests/compatibility/versions.json` and the matching committed report in `tests/fixtures/real-reports/`. It is a deterministic PR fixture, not the maximum Playwright version the reader supports. The scheduled `latest` and `next` lanes test newer versions independently.

Use an exact published version, not a moving tag such as `latest`. For example, to upgrade from 1.59.0 to 1.61.1, first generate the candidate report and fixture:

```bash
npm run compatibility:generate -- \
  --playwright-version 1.61.1 \
  --output ./tmp/compatibility-1.61.1 \
  --archive ./tests/fixtures/real-reports/playwright-1.61.1.zip
```

Validate the generated report before changing any baseline references:

```bash
PWTR_COMPAT_REPORT=./tmp/compatibility-1.61.1/playwright-report \
  npm run compatibility:run
```

When the candidate passes, update these baseline references together:

1. Set `production` to `1.61.1` in `tests/compatibility/versions.json`.
2. Change the fixture filename and expected `resolvedPlaywrightVersion` in `tests/realReportCompatibility.test.ts`.
3. Replace the baseline version and fixture filename in `docs/TESTING.md` and `docs/COMPATIBILITY.md`.

Then run the complete suite:

```bash
npm run test:all
```

After it passes, delete the old fixture and commit the new fixture with the code and documentation changes:

```bash
rm ./tests/fixtures/real-reports/playwright-1.59.0.zip
```

Review `provenance.json` inside the new archive. It records the resolved Playwright version, trace schema, producer revision, scenario names, and SHA-256 checksums for every parser input.

Do not raise `MAX_SUPPORTED_TRACE_VERSION` merely because the Playwright package version changed. Change that limit only after a newer trace schema has been investigated, supported by the parser, and covered by compatibility tests. Playwright 1.61.1 still produces trace schema 8, so upgrading to it does not require changing the schema limit.

Do not automatically commit weekly canary reports. They are uploaded only when a compatibility lane fails.
