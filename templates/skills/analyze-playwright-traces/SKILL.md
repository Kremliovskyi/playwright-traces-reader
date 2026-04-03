---
name: analyze-playwright-traces
description: Analyze Playwright reports and traces using the playwright-traces-reader CLI to find failures, inspect single-test summaries, review network traffic, inspect DOM snapshots, extract screenshots, and build trace timelines.
---

# Analyze Playwright Traces

Use this skill when the user asks to analyze Playwright reports or traces.

## Rules

- Use only supported `npx playwright-traces-reader ...` CLI commands.
- Do not generate temporary `.mjs`, `.js`, or `.ts` analysis scripts.
- Do not import parser methods directly when a CLI command covers the workflow.
- Prefer `--format json` when the output needs to be consumed by the agent or follow-up tooling.
- Use screenshots only for human visual inspection. For agent-readable UI state, prefer `dom` and `summary`.

## Prerequisites

Install the package locally in the repository:

```bash
npm install @andrii_kremlovskyi/playwright-traces-reader
```

Supported local inputs:

- a Playwright report root containing `index.html` and `data/`
- a `playwright-report/data/` directory
- a single extracted trace directory
- a single trace zip

## Command Selection

### Report-level analysis

Use `failures` when the user wants all unique failing tests in a report.

```bash
npx playwright-traces-reader failures /path/to/playwright-report --format json
```

Use `--exclude-skipped` to omit skipped tests:

```bash
npx playwright-traces-reader failures /path/to/playwright-report/data --exclude-skipped --format json
```

What it returns:

- unique failing tests only
- retries already deduplicated
- structured failure summaries with steps, network calls, and failure DOM state

### Single-trace summary

Use `summary` when the user wants one complete summary for a specific trace.

```bash
npx playwright-traces-reader summary /path/to/playwright-report/data/<sha1> --format json
```

If report metadata should be loaded explicitly, pass `--report`:

```bash
npx playwright-traces-reader summary /path/to/playwright-report/data/<sha1> --report /path/to/playwright-report --format json
```

Important behavior:

- `summary` works for both passed and failed traces
- failed traces may include `failureDomSnapshot`
- passed traces return `status: "passed"` and `failureDomSnapshot: null`

### Slow steps

Use `slow-steps` to inspect the slowest steps in one trace.

```bash
npx playwright-traces-reader slow-steps /path/to/playwright-report/data/<sha1> --limit 5 --format json
```

### Step tree

Use `steps` to inspect the reconstructed test step hierarchy.

```bash
npx playwright-traces-reader steps /path/to/playwright-report/data/<sha1>
```

### Network traffic

Use `network` to inspect API and browser traffic for one trace.

```bash
npx playwright-traces-reader network /path/to/playwright-report/data/<sha1> --source all --format json
```

Source filters:

- `all`
- `api`
- `browser`

### DOM snapshots

Use `dom` to inspect UI state before, during, or after actions.

```bash
npx playwright-traces-reader dom /path/to/playwright-report/data/<sha1> --near last --limit 3 --format json
```

Useful filters:

- `--near last`
- `--near <callId>`
- `--phase before|action|after`
- `--limit <count>`

### Timeline

Use `timeline` to build a merged chronological trace narrative.

```bash
npx playwright-traces-reader timeline /path/to/playwright-report/data/<sha1> --format json
```

### Screenshots

Use `screenshots` only when a human needs extracted image files.

```bash
npx playwright-traces-reader screenshots /path/to/playwright-report/data/<sha1> --out-dir /tmp/pw-screenshots --format json
```

### Skill scaffold

Use `init-skills` to install this skill into another repository.

```bash
npx playwright-traces-reader init-skills
```

## Recommended Workflow

1. Identify whether the task is report-level or single-trace.
2. Choose the narrowest CLI command that answers the question.
3. Prefer `--format json` for agent reasoning or follow-up processing.
4. Use text output when the user wants a direct terminal-style summary.
5. Do not fall back to library APIs unless the requested workflow is not covered by a supported command.

## Output Guidance

- All CLI JSON outputs use versioned envelopes.
- See `CLI_JSON_CONTRACTS.md` in the package for payload structure.
- For screenshots, the JSON output contains file metadata, not image understanding.

## More Documentation

- Use the CLI reference for detailed command docs: `CLI_REFERENCE.md`
- Use the library integration guide only for in-process integrations such as `playwright-reports`: `LIBRARY_INTEGRATION.md`
