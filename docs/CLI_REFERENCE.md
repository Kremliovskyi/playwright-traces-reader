# CLI Reference

This document is the primary command reference for `playwright-traces-reader`.

The CLI is intended to be the default interface for agents and for direct use in test repositories.

## General Rules

- Run commands with `npx playwright-traces-reader ...` from a repository where the package is installed.
- JSON is the default response format for CLI commands.
- Use `--format text` only when a direct terminal-style summary is preferable.
- Inputs must be local artifacts: report root, `data/` directory, trace directory, or trace zip.

## Installation

```bash
npm install @andrii_kremlovskyi/playwright-traces-reader
```

## Command Summary

| Command | Scope | Purpose |
|---|---|---|
| `init-skills` | repo | Scaffold the Copilot skill |
| `search-reports` | hub | Search reports through a local playwright-reports hub |
| `prepare-report` | hub | Resolve one hub report reference into a local path |
| `vault-read` | hub | Read a vault analysis markdown file from the hub |
| `failures` | report | Return unique failing tests across a report |
| `find-traces` | report | Find trace paths for tests matching a name pattern |
| `summary` | trace | Return one complete summary for a single trace |
| `slow-steps` | trace | Return the slowest steps for a single trace |
| `steps` | trace | Reconstruct and print the step tree |
| `network` | trace | Inspect API and browser network traffic |
| `request` | trace | Inspect one network request in detail |
| `console` | trace | Inspect browser console, page errors, stdout, and stderr |
| `errors` | trace | Inspect failed steps, page errors, and trace-level issues |
| `dom` | trace | Inspect DOM snapshots |
| `timeline` | trace | Build a merged chronological event stream |
| `attachments` | trace | List trace attachments |
| `attachment` | trace | Extract one trace attachment |
| `screenshots` | trace | Extract screenshots for human inspection |

## Common Inputs

### Report root

Directory containing `index.html` and `data/`.

Example:

```bash
npx playwright-traces-reader failures ./playwright-report
```

### Report data directory

Directory containing SHA1 trace entries.

Example:

```bash
npx playwright-traces-reader failures ./playwright-report/data
```

### Trace path

One extracted trace directory or one trace zip.

Example:

```bash
npx playwright-traces-reader summary ./playwright-report/data/<sha1>
npx playwright-traces-reader summary ./playwright-report/data/<sha1>.zip
```

## `init-skills`

Scaffolds the CLI-first Copilot skill into a target repository.

Usage:

```bash
npx playwright-traces-reader init-skills [targetDir] [--format json|text]
```

Examples:

```bash
npx playwright-traces-reader init-skills
npx playwright-traces-reader init-skills ../my-project
npx playwright-traces-reader init-skills ../my-project --format text
```

## `search-reports`

Searches reports through a local `playwright-reports` hub.

Usage:

```bash
npx playwright-traces-reader search-reports [query] [--latest] [--scope current|archive] [--range-start <date>] [--range-end <date>] [--selected-dates <dates>] [--limit <count>] [--base-url <url>] [--format json|text]
```

Examples:

```bash
npx playwright-traces-reader search-reports "UAT EU" --latest
npx playwright-traces-reader search-reports smoke --scope archive --limit 5 --format text
```

Behavior:

- uses the local hub search contract
- returns a stable `reportRef` plus local artifact paths when available
- does not parse traces by itself

## `prepare-report`

Resolves one `reportRef` from the hub into a local analysis-ready path descriptor.

Usage:

```bash
npx playwright-traces-reader prepare-report <reportRef> [--base-url <url>] [--format json|text]
```

Examples:

```bash
npx playwright-traces-reader prepare-report <reportRef>
npx playwright-traces-reader prepare-report <reportRef> --format text
```

Behavior:

- resolves one selected report through the hub
- returns local `reportRootPath` and `reportDataPath` when available
- intended to be followed by traditional parser commands like `failures`, `summary`, `network`, `dom`, or `timeline`

## `vault-read`

Reads a vault analysis markdown file from the `playwright-reports` hub.

Usage:

```bash
npx playwright-traces-reader vault-read <filename> [--base-url <url>] [--format json|text] [--out <path>]
```

Examples:

```bash
npx playwright-traces-reader vault-read my-report-name
npx playwright-traces-reader vault-read my-report-name --format json
npx playwright-traces-reader vault-read my-report-name --out ./tmp/analysis.md
```

Behavior:

- retrieves the raw markdown content of a vault `.md` file through the hub
- the `filename` argument is the vault name without the `.md` extension (matches the report `id`)
- default output format is `text` (raw markdown to stdout); use `--format json` for envelope output
- `--out <path>` writes content to a file instead of stdout, useful for large files or when subsequent `read_file` access is needed
- discovery: use `search-reports` first — the `analysisFile` field in each report descriptor indicates whether a vault file exists
- agents should use this command instead of `read_file` since vault files typically live outside the IDE workspace

## `failures`

Analyzes a report and returns unique failing tests only.

Usage:

```bash
npx playwright-traces-reader failures <reportPath> [--exclude-skipped] [--format json|text]
```

Accepted inputs:

- report root
- report `data/` directory

Behavior:

- passing tests are excluded
- retries are deduplicated
- output is intentionally compact for report-level triage
- each item includes `tracePath` and `traceSha1`
- each item includes issue counts and the primary related browser action when available
- output also includes repeated failing-request and repeated correlated-issue patterns across unique non-skipped failures
- use `summary <tracePath>` to inspect one selected failure in full

Examples:

```bash
npx playwright-traces-reader failures ./playwright-report
npx playwright-traces-reader summary /absolute/path/to/trace-dir
npx playwright-traces-reader failures ./playwright-report --format text
```

## `find-traces`

Finds trace paths for tests matching a name pattern in a report. Works for any test outcome — including passed tests.

Usage:

```bash
npx playwright-traces-reader find-traces <reportPath> <grep> [--outcome <outcome>] [--format json|text]
```

Accepted inputs:

- report root (directory containing `index.html` and `data/`)

Arguments:

- `<grep>` is a case-insensitive substring matched against the full test title (file path + describe blocks + test name). Special characters in test names are handled safely — you can paste any fragment directly.

Options:

- `--outcome` filters by test-level outcome: `expected`, `unexpected`, `flaky`, or `skipped`

Behavior:

- reads report metadata from `index.html` without loading trace contents
- returns all matching tests with trace paths for every retry
- each item includes `tracePath`, `traceSha1`, `testTitle`, `outcome`, `resultIndex`, `projectName`, and `file`
- use `summary <tracePath>` to inspect one found trace in full

Examples:

```bash
npx playwright-traces-reader find-traces ./playwright-report "login"
npx playwright-traces-reader find-traces ./playwright-report "checkout" --outcome expected
npx playwright-traces-reader find-traces ./playwright-report "order" --outcome flaky --format text
```

Typical follow-up:

```bash
npx playwright-traces-reader find-traces ./playwright-report "login" --outcome expected
npx playwright-traces-reader summary <tracePath> --report ./playwright-report
```

## `summary`

Builds one complete summary for a single trace.

Usage:

```bash
npx playwright-traces-reader summary <tracePath> [--report <reportPath>] [--format json|text]
```

Accepted inputs:

- extracted trace directory
- trace zip

Behavior:

- works for passed and failed traces
- includes status, duration, top-level steps, slowest steps, network calls, issues, related-action diagnostics, and optional failure DOM state
- `--report` improves outcome resolution by loading report metadata explicitly

Examples:

```bash
npx playwright-traces-reader summary ./playwright-report/data/<sha1>
npx playwright-traces-reader summary ./playwright-report/data/<sha1> --report ./playwright-report --format text
```

## `slow-steps`

Returns the slowest steps for one trace.

Usage:

```bash
npx playwright-traces-reader slow-steps <tracePath> [--report <reportPath>] [--limit <count>] [--format json|text]
```

Options:

- `--limit` defaults to `5`

Examples:

```bash
npx playwright-traces-reader slow-steps ./playwright-report/data/<sha1>
npx playwright-traces-reader slow-steps ./playwright-report/data/<sha1> --limit 10 --format text
```

## `steps`

Prints the step tree reconstructed from `test.trace`.

Usage:

```bash
npx playwright-traces-reader steps <tracePath> [--format json|text]
```

Examples:

```bash
npx playwright-traces-reader steps ./playwright-report/data/<sha1>
npx playwright-traces-reader steps ./playwright-report/data/<sha1> --format text
```

## `network`

Inspects network traffic for one trace.

Usage:

```bash
npx playwright-traces-reader network <tracePath> [--source all|api|browser] [--grep <pattern>] [--method <method>] [--status <code>] [--failed] [--near <callId>] [--limit <count>] [--format json|text]
```

Options:

- `--source all` returns all entries
- `--source api` returns Node.js API traffic only
- `--source browser` returns browser traffic only
- `--grep` filters by URL pattern
- `--method` filters by HTTP method
- `--status` filters by HTTP status code
- `--failed` keeps only status >= 400
- `--near` keeps only requests correlated to a specific action callId
- `--limit` bounds the number of returned requests

Examples:

```bash
npx playwright-traces-reader network ./playwright-report/data/<sha1>
npx playwright-traces-reader network ./playwright-report/data/<sha1> --source api --format text
npx playwright-traces-reader network ./playwright-report/data/<sha1> --failed --near call@123
```

## `request`

Inspects one network request in detail by its request ID.

Usage:

```bash
npx playwright-traces-reader request <tracePath> <requestId> [--format json|text]
```

Examples:

```bash
npx playwright-traces-reader request ./playwright-report/data/<sha1> 12
```

## `console`

Inspects browser console entries, page errors, stdout, and stderr for one trace.

Usage:

```bash
npx playwright-traces-reader console <tracePath> [--errors-only] [--warnings] [--browser] [--stdio] [--format json|text]
```

Examples:

```bash
npx playwright-traces-reader console ./playwright-report/data/<sha1>
npx playwright-traces-reader console ./playwright-report/data/<sha1> --errors-only --format text
```

## `errors`

Inspects failed steps, page errors, and trace-level issues for one trace.

Usage:

```bash
npx playwright-traces-reader errors <tracePath> [--format json|text]
```

Examples:

```bash
npx playwright-traces-reader errors ./playwright-report/data/<sha1>
npx playwright-traces-reader errors ./playwright-report/data/<sha1> --format text
```

## `dom`

Writes DOM snapshots for one trace to a file.

Usage:

```bash
npx playwright-traces-reader dom <tracePath> --output <path> [--near <value>] [--phase before|action|after] [--limit <count>] [--format json|text]
```

Options:

- `--output <path>` (required) output file path for DOM snapshots
- `--near last` returns the tail of the snapshot sequence
- `--near <callId>` returns a window around a specific action
- `--phase` filters to one snapshot phase
- `--limit` bounds the number of action groups returned
- `--format` controls the file content format (json or text)

Stdout receives a lightweight JSON confirmation with `savedPath`, `count`, and `callIds` — never the full HTML.

Examples:

```bash
npx playwright-traces-reader dom ./playwright-report/data/<sha1> --output /tmp/dom.json --near last --limit 3
npx playwright-traces-reader dom ./playwright-report/data/<sha1> --output /tmp/dom.txt --phase after --format text

```bash
npx playwright-traces-reader dom ./playwright-report/data/<sha1> --output /tmp/dom.json --near last --limit 3
npx playwright-traces-reader dom ./playwright-report/data/<sha1> --output /tmp/dom.txt --phase after --format text
```

## `timeline`

Builds a merged chronological event stream for one trace.

Usage:

```bash
npx playwright-traces-reader timeline <tracePath> [--format json|text]
```

Included event types:

- steps
- screenshots metadata
- DOM snapshots
- network calls

Examples:

```bash
npx playwright-traces-reader timeline ./playwright-report/data/<sha1>
npx playwright-traces-reader timeline ./playwright-report/data/<sha1> --format text
```

## `attachments`

Lists attachments captured in a trace.

Usage:

```bash
npx playwright-traces-reader attachments <tracePath> [--format json|text]
```

## `attachment`

Extracts one attachment from a trace by its attachment ID.

Usage:

```bash
npx playwright-traces-reader attachment <tracePath> <attachmentId> [--output <path>] [--format json|text]
```

## `screenshots`

Extracts screenshots from a trace into a local directory.

Usage:

```bash
npx playwright-traces-reader screenshots <tracePath> --out-dir <path> [--format json|text]
```

Important note:

- this command is for human visual inspection
- agents should prefer `summary` or `dom` for machine-readable UI state

Examples:

```bash
npx playwright-traces-reader screenshots ./playwright-report/data/<sha1> --out-dir /tmp/pw-shots
npx playwright-traces-reader screenshots ./playwright-report/data/<sha1> --out-dir /tmp/pw-shots --format text
```

## JSON Output

JSON is the default output mode for CLI commands.

All JSON outputs are versioned envelopes.

See `CLI_JSON_CONTRACTS.md` for the contract details.

## Agent Guidance

- Use this CLI as the default interface.
- Do not create temporary analysis scripts when a command exists.
- Use library APIs only for integration work or for workflows the CLI does not yet cover.