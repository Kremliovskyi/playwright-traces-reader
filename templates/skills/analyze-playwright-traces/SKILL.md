---
name: analyze-playwright-traces
description: Analyze Playwright reports and traces using the playwright-traces-reader CLI, including searching a local playwright-reports hub for runs like latest UAT EU before inspecting failures, single-test summaries, network traffic, DOM snapshots, screenshots, and timelines.
---

# Analyze Playwright Traces

Use this skill when the user asks to analyze Playwright reports or traces, including when the report first needs to be found through a local playwright-reports hub.

## Rules

- Use only supported `npx playwright-traces-reader ...` CLI commands.
- Do not generate temporary `.mjs`, `.js`, or `.ts` analysis scripts.
- Do not import parser methods directly when a CLI command covers the workflow.
- JSON is the default output mode. Use `--format text` only when a human-readable terminal summary is preferable.
- Use screenshots only for human visual inspection. For agent-readable UI state, prefer `dom` and `summary`.
- If the user does not specify a report by path, `reportRef`, metadata, date, or recency hint, default to the local `playwright-report/` directory.
- If the report path is not already known, use the hub-assisted `search-reports` and `prepare-report` commands first.

## Output Handling

- Do not truncate `npx playwright-traces-reader failures ...` output on the first attempt with `Select-Object`, `head`, or similar shell filtering.
- `failures` is the compact triage command and should normally be consumed in full.
- After reading `failures`, choose one item and use `summary <tracePath>` for full details.
- For potentially larger commands such as `network`, `dom`, or `timeline`, narrowing output is acceptable when needed.

## Prerequisites

Install the package locally in the repository:

```bash
npm install @andrii_kremlovskyi/playwright-traces-reader
```

If the workflow needs report discovery through `playwright-reports`, the local hub should be running and reachable, by default at `http://127.0.0.1:9333`.

Supported local inputs:

- a Playwright report root containing `index.html` and `data/`
- a `playwright-report/data/` directory
- a single extracted trace directory
- a single trace zip

## Command Selection

### Report discovery through playwright-reports

If the user gave no report identifier at all, do not start with hub discovery. Use the local default `playwright-report/` directory first.

```bash
npx playwright-traces-reader failures playwright-report/
```

Use `search-reports` when the user describes a report by metadata or recency instead of giving a filesystem path.

```bash
npx playwright-traces-reader search-reports "UAT EU" --latest
```

This returns report references plus local report paths when available.

Discovery flag meanings:

- `--base-url <url>` points to the local `playwright-reports` hub. Default: `http://127.0.0.1:9333`.
- `--latest` asks the hub for the newest matching report.
- `--limit <count>` limits how many matching reports are returned.
- `--range-start <YYYY-MM-DD>` filters reports created on or after that date.
- `--range-end <YYYY-MM-DD>` filters reports created on or before that date.
- `--selected-dates <YYYY-MM-DD,YYYY-MM-DD>` filters to one or more exact calendar dates.

If the default hub URL is not correct, either pass `--base-url` or set `PLAYWRIGHT_REPORTS_BASE_URL` in the caller environment.

If the hub is unreachable, `search-reports` and `prepare-report` fail with a direct message that the report hub is not reachable at the requested URL.

Useful examples:

```bash
npx playwright-traces-reader search-reports "UAT EU" --latest --limit 1
npx playwright-traces-reader search-reports "UAT EU" --range-start 2026-04-01 --range-end 2026-04-03
npx playwright-traces-reader search-reports "checkout" --selected-dates 2026-04-02,2026-04-03
npx playwright-traces-reader search-reports "smoke" --base-url http://127.0.0.1:9333
```

Use `prepare-report` to resolve one returned `reportRef` into a local analysis-ready path before running parser commands.

```bash
npx playwright-traces-reader prepare-report <reportRef>
```

After preparation, run the traditional parser commands with the returned `reportRootPath` or `reportDataPath`.

Use `prepare-report` when the question changes from "which report matches?" to "where is that report on disk so parsing can start?"

Example handoff flow:

```bash
npx playwright-traces-reader search-reports "UAT EU" --latest --limit 1
npx playwright-traces-reader prepare-report <reportRef>
npx playwright-traces-reader failures <reportRootPath>
npx playwright-traces-reader summary <tracePath>
```

### Report-level analysis

Use `failures` when the user wants all unique failing tests in a report.

```bash
npx playwright-traces-reader failures /path/to/playwright-report
```

Use `--exclude-skipped` to omit skipped tests:

```bash
npx playwright-traces-reader failures /path/to/playwright-report/data --exclude-skipped
```

What it returns:

- unique failing tests only
- retries already deduplicated
- compact triage records with `tracePath` and `traceSha1`
- enough information to follow up with `summary <tracePath>` for one selected failure

### Single-trace summary

Use `summary` when the user wants one complete summary for a specific trace.

```bash
npx playwright-traces-reader summary /path/to/playwright-report/data/<sha1>
```

If report metadata should be loaded explicitly, pass `--report`:

```bash
npx playwright-traces-reader summary /path/to/playwright-report/data/<sha1> --report /path/to/playwright-report
```

Important behavior:

- `summary` works for both passed and failed traces
- failed traces may include `failureDomSnapshot`
- passed traces return `status: "passed"` and `failureDomSnapshot: null`

### Slow steps

Use `slow-steps` to inspect the slowest steps in one trace.

```bash
npx playwright-traces-reader slow-steps /path/to/playwright-report/data/<sha1> --limit 5
```

### Step tree

Use `steps` to inspect the reconstructed test step hierarchy.

```bash
npx playwright-traces-reader steps /path/to/playwright-report/data/<sha1>
```

### Network traffic

Use `network` to inspect API and browser traffic for one trace.

```bash
npx playwright-traces-reader network /path/to/playwright-report/data/<sha1> --source all
```

Source filters:

- `all`
- `api`
- `browser`

### DOM snapshots

Use `dom` to inspect UI state before, during, or after actions.

```bash
npx playwright-traces-reader dom /path/to/playwright-report/data/<sha1> --near last --limit 3
```

Useful filters:

- `--near last`
- `--near <callId>`
- `--phase before|action|after`
- `--limit <count>`

### Timeline

Use `timeline` to build a merged chronological trace narrative.

```bash
npx playwright-traces-reader timeline /path/to/playwright-report/data/<sha1>
```

### Screenshots

Use `screenshots` only when a human needs extracted image files.

```bash
npx playwright-traces-reader screenshots /path/to/playwright-report/data/<sha1> --out-dir /tmp/pw-screenshots
```

### Skill scaffold

Use `init-skills` to install this skill into another repository.

```bash
npx playwright-traces-reader init-skills
```

## Recommended Workflow

1. If the user gave no report identifier at all, start with the local `playwright-report/` directory.
2. If the report path is unknown but the user did provide metadata, date, or recency hints, use `search-reports` and then `prepare-report` first.
3. Identify whether the task is report-level or single-trace.
4. Choose the narrowest parser command that answers the question.
5. Use the default JSON output for agent reasoning or follow-up processing.
6. Use `--format text` when the user wants a direct terminal-style summary.
7. Do not fall back to library APIs unless the requested workflow is not covered by a supported command.

## Output Guidance

- All CLI JSON outputs use versioned envelopes.
- See `CLI_JSON_CONTRACTS.md` in the package for payload structure.
- For screenshots, the JSON output contains file metadata, not image understanding.

## Example Prompts This Skill Covers

- Analyze the default local Playwright report and list failures.
- Find the latest UAT EU report and list failing tests.
- Find checkout reports from `2026-04-01` through `2026-04-03` and prepare the newest one.
- Resolve this `reportRef` and summarize the failing trace.
- Use the reports hub at `http://127.0.0.1:9333` to find the most recent smoke run.

## More Documentation

- Use the CLI reference for detailed command docs: `CLI_REFERENCE.md`
- Use the library integration guide only for in-process integrations such as `playwright-reports`: `LIBRARY_INTEGRATION.md`
