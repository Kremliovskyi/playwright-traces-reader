# CLI Reference

This document is the primary command reference for `playwright-traces-reader`.

The CLI is intended to be the default interface for agents and for direct use in test repositories.

## General Rules

- Run commands with `npx playwright-traces-reader ...` from a repository where the package is installed.
- Prefer `--format json` for automation, agents, and tool-to-tool integration.
- Prefer `--format text` for direct human terminal use.
- Inputs must be local artifacts: report root, `data/` directory, trace directory, or trace zip.

## Installation

```bash
npm install @andrii_kremlovskyi/playwright-traces-reader
```

## Command Summary

| Command | Scope | Purpose |
|---|---|---|
| `init-skills` | repo | Scaffold the Copilot skill |
| `failures` | report | Return unique failing tests across a report |
| `summary` | trace | Return one complete summary for a single trace |
| `slow-steps` | trace | Return the slowest steps for a single trace |
| `steps` | trace | Reconstruct and print the step tree |
| `network` | trace | Inspect API and browser network traffic |
| `dom` | trace | Inspect DOM snapshots |
| `timeline` | trace | Build a merged chronological event stream |
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
npx playwright-traces-reader init-skills [targetDir]
```

Examples:

```bash
npx playwright-traces-reader init-skills
npx playwright-traces-reader init-skills ../my-project
```

## `failures`

Analyzes a report and returns unique failing tests only.

Usage:

```bash
npx playwright-traces-reader failures <reportPath> [--exclude-skipped] [--format text|json]
```

Accepted inputs:

- report root
- report `data/` directory

Behavior:

- passing tests are excluded
- retries are deduplicated
- results include network calls and failure DOM data when available

Examples:

```bash
npx playwright-traces-reader failures ./playwright-report
npx playwright-traces-reader failures ./playwright-report --exclude-skipped --format json
```

## `summary`

Builds one complete summary for a single trace.

Usage:

```bash
npx playwright-traces-reader summary <tracePath> [--report <reportPath>] [--format text|json]
```

Accepted inputs:

- extracted trace directory
- trace zip

Behavior:

- works for passed and failed traces
- includes status, duration, top-level steps, slowest steps, network calls, and optional failure DOM state
- `--report` improves outcome resolution by loading report metadata explicitly

Examples:

```bash
npx playwright-traces-reader summary ./playwright-report/data/<sha1>
npx playwright-traces-reader summary ./playwright-report/data/<sha1> --report ./playwright-report --format json
```

## `slow-steps`

Returns the slowest steps for one trace.

Usage:

```bash
npx playwright-traces-reader slow-steps <tracePath> [--report <reportPath>] [--limit <count>] [--format text|json]
```

Options:

- `--limit` defaults to `5`

Examples:

```bash
npx playwright-traces-reader slow-steps ./playwright-report/data/<sha1>
npx playwright-traces-reader slow-steps ./playwright-report/data/<sha1> --limit 10 --format json
```

## `steps`

Prints the step tree reconstructed from `test.trace`.

Usage:

```bash
npx playwright-traces-reader steps <tracePath> [--format text|json]
```

Examples:

```bash
npx playwright-traces-reader steps ./playwright-report/data/<sha1>
npx playwright-traces-reader steps ./playwright-report/data/<sha1> --format json
```

## `network`

Inspects network traffic for one trace.

Usage:

```bash
npx playwright-traces-reader network <tracePath> [--source all|api|browser] [--format text|json]
```

Options:

- `--source all` returns all entries
- `--source api` returns Node.js API traffic only
- `--source browser` returns browser traffic only

Examples:

```bash
npx playwright-traces-reader network ./playwright-report/data/<sha1>
npx playwright-traces-reader network ./playwright-report/data/<sha1> --source api --format json
```

## `dom`

Returns DOM snapshots for one trace.

Usage:

```bash
npx playwright-traces-reader dom <tracePath> [--near <value>] [--phase before|action|after] [--limit <count>] [--format text|json]
```

Options:

- `--near last` returns the tail of the snapshot sequence
- `--near <callId>` returns a window around a specific action
- `--phase` filters to one snapshot phase
- `--limit` bounds the number of action groups returned

Examples:

```bash
npx playwright-traces-reader dom ./playwright-report/data/<sha1> --near last --limit 3 --format json
npx playwright-traces-reader dom ./playwright-report/data/<sha1> --phase after
```

## `timeline`

Builds a merged chronological event stream for one trace.

Usage:

```bash
npx playwright-traces-reader timeline <tracePath> [--format text|json]
```

Included event types:

- steps
- screenshots metadata
- DOM snapshots
- network calls

Examples:

```bash
npx playwright-traces-reader timeline ./playwright-report/data/<sha1>
npx playwright-traces-reader timeline ./playwright-report/data/<sha1> --format json
```

## `screenshots`

Extracts screenshots from a trace into a local directory.

Usage:

```bash
npx playwright-traces-reader screenshots <tracePath> --out-dir <path> [--format text|json]
```

Important note:

- this command is for human visual inspection
- agents should prefer `summary` or `dom` for machine-readable UI state

Examples:

```bash
npx playwright-traces-reader screenshots ./playwright-report/data/<sha1> --out-dir /tmp/pw-shots
npx playwright-traces-reader screenshots ./playwright-report/data/<sha1> --out-dir /tmp/pw-shots --format json
```

## JSON Output

All JSON outputs are versioned envelopes.

See `CLI_JSON_CONTRACTS.md` for the contract details.

## Agent Guidance

- Use this CLI as the default interface.
- Do not create temporary analysis scripts when a command exists.
- Use library APIs only for integration work or for workflows the CLI does not yet cover.