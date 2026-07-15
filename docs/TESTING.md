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

## Updating the fixture

Regenerate the committed baseline only when the production Playwright version, trace schema, or producer scenarios intentionally change:

```bash
npm run compatibility:generate -- \
  --playwright-version 1.59.0 \
  --output ./tmp/compatibility-1.59.0 \
  --archive ./tests/fixtures/real-reports/playwright-1.59.0.zip
npm run test:real-fixture
```

Review `provenance.json` inside the archive. It records the resolved Playwright version, trace schema, producer revision, scenario names, and SHA-256 checksums for every parser input.

Do not automatically commit weekly canary reports. They are uploaded only when a compatibility lane fails.