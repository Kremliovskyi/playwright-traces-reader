#!/usr/bin/env node
import { Command, CommanderError, InvalidArgumentError } from 'commander';
import {
  extractScreenshots,
  getDomSnapshots,
  getNetworkTraffic,
  getSummary,
  getTestSteps,
  getTimeline,
  prepareTraceDir,
} from './index';
import { getFailedTraceSelections } from './extractors';
import {
  copySkillTemplate,
  DEFAULT_REPORTS_HUB_BASE_URL,
  loadReportMetadataForTrace,
  parsePositiveInteger,
  prepareReportViaHub,
  resolveReportDataDir,
  searchReportsViaHub,
} from './cli/helpers';
import {
  emitOutput,
  formatPrepareReportText,
  formatSearchReportsText,
  formatDomSnapshotsText,
  formatFailuresText,
  formatInitSkillsText,
  formatNetworkText,
  formatScreenshotsText,
  formatSlowStepsText,
  formatStepsText,
  formatSummaryText,
  formatTimelineText,
  type OutputFormat,
} from './cli/formatters';
import {
  createInitSkillsCommandJson,
  createPrepareReportCommandJson,
  createSearchReportsCommandJson,
  createDomCommandJson,
  createFailuresCommandJson,
  createNetworkCommandJson,
  createScreenshotsCommandJson,
  createSlowStepsCommandJson,
  createStepsCommandJson,
  createSummaryCommandJson,
  createTimelineCommandJson,
} from './cli/json';
import type { DomSnapshotOptions } from './index';
import type { FailureListItem } from './cli/json';

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const defaultIo: CliIo = {
  stdout: text => process.stdout.write(text),
  stderr: text => process.stderr.write(text),
};

function parseFormat(value: string): OutputFormat {
  if (value === 'text' || value === 'json') return value;
  throw new InvalidArgumentError(`Invalid format: ${value}. Expected "text" or "json".`);
}

function buildProgram(io: CliIo): Command {
  const program = new Command();
  program
    .name('playwright-traces-reader')
    .description('CLI for analyzing Playwright reports and traces')
    .showHelpAfterError()
    .configureOutput({
      writeOut: text => io.stdout(text),
      writeErr: text => io.stderr(text),
    })
    .exitOverride();

  program
    .command('init-skills [targetDir]')
    .description('Scaffold the analyze-playwright-traces skill into a target repository')
    .option('-f, --format <format>', 'Output format: json or text', parseFormat, 'json')
    .action(async (targetDir: string | undefined, options: { format: OutputFormat }) => {
      const destPath = await copySkillTemplate(targetDir ?? process.cwd());
      emitOutput(io, options.format, createInitSkillsCommandJson(destPath), formatInitSkillsText(destPath));
    });

  program
    .command('search-reports [query]')
    .description('Search Playwright reports through a local playwright-reports hub and return report references plus local artifact paths')
    .option('-f, --format <format>', 'Output format: json or text', parseFormat, 'json')
    .option('--latest', 'Prefer the newest matching report', false)
    .option('--scope <scope>', 'Filter by scope: current or archive')
    .option('--range-start <date>', 'Start date filter (YYYY-MM-DD)')
    .option('--range-end <date>', 'End date filter (YYYY-MM-DD)')
    .option('--selected-dates <dates>', 'Comma-separated specific dates (YYYY-MM-DD,YYYY-MM-DD)')
    .option('-n, --limit <count>', 'Maximum number of reports to return', parsePositiveInteger)
    .option('--base-url <url>', 'Base URL for the playwright-reports hub', DEFAULT_REPORTS_HUB_BASE_URL)
    .action(async (
      query: string | undefined,
      options: {
        format: OutputFormat;
        latest: boolean;
        scope?: 'current' | 'archive';
        rangeStart?: string;
        rangeEnd?: string;
        selectedDates?: string;
        limit?: number;
        baseUrl: string;
      },
    ) => {
      if (options.scope && !['current', 'archive'].includes(options.scope)) {
        throw new Error(`Invalid scope: ${options.scope}. Expected current or archive.`);
      }

      const selectedDates = options.selectedDates
        ? options.selectedDates.split(',').map(value => value.trim()).filter(Boolean)
        : undefined;
      const searchOptions: Parameters<typeof searchReportsViaHub>[0] = {
        baseUrl: options.baseUrl,
      };

      if (query !== undefined) searchOptions.query = query;
      if (options.latest) searchOptions.latest = true;
      if (options.scope !== undefined) searchOptions.scope = options.scope;
      if (options.rangeStart !== undefined) searchOptions.rangeStart = options.rangeStart;
      if (options.rangeEnd !== undefined) searchOptions.rangeEnd = options.rangeEnd;
      if (selectedDates !== undefined) searchOptions.selectedDates = selectedDates;
      if (options.limit !== undefined) searchOptions.limit = options.limit;

      const response = await searchReportsViaHub(searchOptions);

      emitOutput(io, options.format, createSearchReportsCommandJson(response.reports), formatSearchReportsText(response.reports));
    });

  program
    .command('prepare-report <reportRef>')
    .description('Resolve a report reference from playwright-reports into a local analysis-ready path descriptor')
    .option('-f, --format <format>', 'Output format: json or text', parseFormat, 'json')
    .option('--base-url <url>', 'Base URL for the playwright-reports hub', DEFAULT_REPORTS_HUB_BASE_URL)
    .action(async (reportRef: string, options: { format: OutputFormat; baseUrl: string }) => {
      const response = await prepareReportViaHub(options.baseUrl, reportRef);
      emitOutput(
        io,
        options.format,
        createPrepareReportCommandJson(response.report, response.mode),
        formatPrepareReportText(response.report, response.mode),
      );
    });

  program
    .command('failures <reportPath>')
    .description('Analyze unique failing tests in a Playwright report root or data directory')
    .option('-f, --format <format>', 'Output format: json or text', parseFormat, 'json')
    .option('--exclude-skipped', 'Exclude skipped tests from the result set', false)
    .action(async (reportPath: string, options: { format: OutputFormat; excludeSkipped: boolean }) => {
      const reportDataDir = await resolveReportDataDir(reportPath);
      const selections = await getFailedTraceSelections(reportDataDir, {
        excludeSkipped: options.excludeSkipped,
      });

      const failures: FailureListItem[] = selections.map(selection => {
        const errorMessage = firstLine(selection.summary.error?.message);
        const networkErrorCount = selection.summary.networkCalls.filter(entry => entry.status >= 400).length;

        return {
          testTitle: selection.summary.testTitle,
          title: selection.summary.title,
          status: selection.summary.status,
          outcome: selection.summary.outcome,
          durationMs: selection.summary.durationMs,
          errorMessage,
          tracePath: selection.tracePath,
          traceSha1: selection.traceSha1,
          networkCallCount: selection.summary.networkCalls.length,
          networkErrorCount,
          hasFailureDomSnapshot: selection.summary.failureDomSnapshot !== null,
        };
      });

      emitOutput(io, options.format, createFailuresCommandJson(failures), formatFailuresText(failures));
    });

  program
    .command('summary <tracePath>')
    .description('Summarize a single trace directory or trace zip')
    .option('-f, --format <format>', 'Output format: json or text', parseFormat, 'json')
    .option('--report <reportPath>', 'Optional report root or data directory used to load report metadata')
    .action(async (tracePath: string, options: { format: OutputFormat; report?: string }) => {
      const traceContext = await prepareTraceDir(tracePath);
      const reportMetadata = await loadReportMetadataForTrace(traceContext, options.report);
      const summary = await getSummary(traceContext, { reportMetadata });

      emitOutput(io, options.format, createSummaryCommandJson(summary), formatSummaryText(summary));
    });

  program
    .command('slow-steps <tracePath>')
    .description('Show the slowest steps for a single trace')
    .option('-f, --format <format>', 'Output format: json or text', parseFormat, 'json')
    .option('-n, --limit <count>', 'Maximum number of steps to return', parsePositiveInteger, 5)
    .option('--report <reportPath>', 'Optional report root or data directory used to load report metadata')
    .action(async (tracePath: string, options: { format: OutputFormat; limit: number; report?: string }) => {
      const traceContext = await prepareTraceDir(tracePath);
      const reportMetadata = await loadReportMetadataForTrace(traceContext, options.report);
      const summary = await getSummary(traceContext, { reportMetadata });
      const slowestSteps = summary.slowestSteps.slice(0, options.limit);

      emitOutput(io, options.format, createSlowStepsCommandJson(slowestSteps), formatSlowStepsText(slowestSteps));
    });

  program
    .command('steps <tracePath>')
    .description('Print the reconstructed test step tree for a single trace')
    .option('-f, --format <format>', 'Output format: json or text', parseFormat, 'json')
    .action(async (tracePath: string, options: { format: OutputFormat }) => {
      const traceContext = await prepareTraceDir(tracePath);
      const steps = await getTestSteps(traceContext);

      emitOutput(io, options.format, createStepsCommandJson(steps), formatStepsText(steps));
    });

  program
    .command('network <tracePath>')
    .description('Inspect network traffic for a single trace')
    .option('-f, --format <format>', 'Output format: json or text', parseFormat, 'json')
    .option('--source <source>', 'Filter by source: all, api, or browser', 'all')
    .action(async (tracePath: string, options: { format: OutputFormat; source: string }) => {
      if (!['all', 'api', 'browser'].includes(options.source)) {
        throw new Error(`Invalid source: ${options.source}. Expected all, api, or browser.`);
      }

      const traceContext = await prepareTraceDir(tracePath);
      const networkEntries = await getNetworkTraffic(traceContext);
      const filteredEntries = options.source === 'all'
        ? networkEntries
        : networkEntries.filter(entry => entry.source === options.source);

      emitOutput(io, options.format, createNetworkCommandJson(filteredEntries), formatNetworkText(filteredEntries));
    });

  program
    .command('dom <tracePath>')
    .description('Inspect DOM snapshots for a single trace')
    .option('-f, --format <format>', 'Output format: json or text', parseFormat, 'json')
    .option('--near <near>', 'Return snapshots near a callId, or use "last"')
    .option('--phase <phase>', 'Filter to before, action, or after phase')
    .option('-n, --limit <count>', 'Maximum number of action snapshots to return', parsePositiveInteger)
    .action(async (
      tracePath: string,
      options: { format: OutputFormat; near?: string; phase?: 'before' | 'action' | 'after'; limit?: number },
    ) => {
      if (options.phase && !['before', 'action', 'after'].includes(options.phase)) {
        throw new Error(`Invalid phase: ${options.phase}. Expected before, action, or after.`);
      }

      const traceContext = await prepareTraceDir(tracePath);
      const domOptions: DomSnapshotOptions = {};
      if (options.near !== undefined) domOptions.near = options.near;
      if (options.phase !== undefined) domOptions.phase = options.phase;
      if (options.limit !== undefined) domOptions.limit = options.limit;

      const domSnapshots = await getDomSnapshots(traceContext, domOptions);

      emitOutput(io, options.format, createDomCommandJson(domSnapshots), formatDomSnapshotsText(domSnapshots));
    });

  program
    .command('timeline <tracePath>')
    .description('Print a merged chronological timeline for a single trace')
    .option('-f, --format <format>', 'Output format: json or text', parseFormat, 'json')
    .action(async (tracePath: string, options: { format: OutputFormat }) => {
      const traceContext = await prepareTraceDir(tracePath);
      const timeline = await getTimeline(traceContext);

      emitOutput(io, options.format, createTimelineCommandJson(timeline), formatTimelineText(timeline));
    });

  program
    .command('screenshots <tracePath>')
    .description('Extract screenshots from a trace to a local output directory')
    .requiredOption('-o, --out-dir <path>', 'Directory to write extracted screenshots into')
    .option('-f, --format <format>', 'Output format: json or text', parseFormat, 'json')
    .action(async (tracePath: string, options: { format: OutputFormat; outDir: string }) => {
      const traceContext = await prepareTraceDir(tracePath);
      const screenshots = await extractScreenshots(traceContext, options.outDir);

      emitOutput(io, options.format, createScreenshotsCommandJson(screenshots), formatScreenshotsText(screenshots));
    });

  return program;
}

function firstLine(value?: string | null): string | null {
  if (!value) return null;
  return value.split(/\r?\n/, 1)[0] ?? null;
}

export async function runCli(argv: string[], io: CliIo = defaultIo): Promise<number> {
  const program = buildProgram(io);

  try {
    await program.parseAsync(argv, { from: 'user' });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode;
    }

    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`${message}\n`);
    return 1;
  }
}

if (require.main === module) {
  runCli(process.argv.slice(2)).then(exitCode => {
    process.exit(exitCode);
  });
}
