import type {
  ActionDomSnapshots,
  NetworkEntry,
  Screenshot,
  TestStep,
  TimelineEntry,
  TraceSummary,
} from '../index';
import type { HubReportDescriptor } from './helpers';

export const CLI_JSON_SCHEMA_VERSION = 1 as const;

export interface FailureListItem {
  testTitle: string | null;
  title: string;
  status: 'passed' | 'failed';
  outcome: 'expected' | 'unexpected' | 'flaky' | 'skipped' | null;
  durationMs: number | null;
  errorMessage: string | null;
  tracePath: string;
  traceSha1: string;
  networkCallCount: number;
  networkErrorCount: number;
  hasFailureDomSnapshot: boolean;
}

export interface InitSkillsCommandJson {
  schemaVersion: typeof CLI_JSON_SCHEMA_VERSION;
  command: 'init-skills';
  skillPath: string;
}

export interface SearchReportsCommandJson {
  schemaVersion: typeof CLI_JSON_SCHEMA_VERSION;
  command: 'search-reports';
  totalCount: number;
  reports: HubReportDescriptor[];
}

export interface PrepareReportCommandJson {
  schemaVersion: typeof CLI_JSON_SCHEMA_VERSION;
  command: 'prepare-report';
  mode: string;
  report: HubReportDescriptor;
  reportRootPath: string | null;
  reportDataPath: string | null;
}

export interface FailuresCommandJson {
  schemaVersion: typeof CLI_JSON_SCHEMA_VERSION;
  command: 'failures';
  count: number;
  failures: FailureListItem[];
}

export interface SummaryCommandJson {
  schemaVersion: typeof CLI_JSON_SCHEMA_VERSION;
  command: 'summary';
  summary: TraceSummary;
}

export interface SlowStepsCommandJson {
  schemaVersion: typeof CLI_JSON_SCHEMA_VERSION;
  command: 'slow-steps';
  count: number;
  steps: TestStep[];
}

export interface StepsCommandJson {
  schemaVersion: typeof CLI_JSON_SCHEMA_VERSION;
  command: 'steps';
  count: number;
  steps: TestStep[];
}

export interface NetworkCommandJson {
  schemaVersion: typeof CLI_JSON_SCHEMA_VERSION;
  command: 'network';
  count: number;
  entries: NetworkEntry[];
}

export interface DomCommandJson {
  schemaVersion: typeof CLI_JSON_SCHEMA_VERSION;
  command: 'dom';
  count: number;
  snapshots: ActionDomSnapshots[];
}

export interface TimelineCommandJson {
  schemaVersion: typeof CLI_JSON_SCHEMA_VERSION;
  command: 'timeline';
  count: number;
  entries: TimelineEntry[];
}

export interface ScreenshotsCommandJson {
  schemaVersion: typeof CLI_JSON_SCHEMA_VERSION;
  command: 'screenshots';
  count: number;
  screenshots: Screenshot[];
}

export type CliCommandJson =
  | InitSkillsCommandJson
  | SearchReportsCommandJson
  | PrepareReportCommandJson
  | FailuresCommandJson
  | SummaryCommandJson
  | SlowStepsCommandJson
  | StepsCommandJson
  | NetworkCommandJson
  | DomCommandJson
  | TimelineCommandJson
  | ScreenshotsCommandJson;

export function createInitSkillsCommandJson(skillPath: string): InitSkillsCommandJson {
  return {
    schemaVersion: CLI_JSON_SCHEMA_VERSION,
    command: 'init-skills',
    skillPath,
  };
}

export function createSearchReportsCommandJson(reports: HubReportDescriptor[]): SearchReportsCommandJson {
  return {
    schemaVersion: CLI_JSON_SCHEMA_VERSION,
    command: 'search-reports',
    totalCount: reports.length,
    reports,
  };
}

export function createPrepareReportCommandJson(report: HubReportDescriptor, mode: string): PrepareReportCommandJson {
  return {
    schemaVersion: CLI_JSON_SCHEMA_VERSION,
    command: 'prepare-report',
    mode,
    report,
    reportRootPath: report.reportRootPath,
    reportDataPath: report.reportDataPath,
  };
}

export function createFailuresCommandJson(failures: FailureListItem[]): FailuresCommandJson {
  return {
    schemaVersion: CLI_JSON_SCHEMA_VERSION,
    command: 'failures',
    count: failures.length,
    failures,
  };
}

export function createSummaryCommandJson(summary: TraceSummary): SummaryCommandJson {
  return {
    schemaVersion: CLI_JSON_SCHEMA_VERSION,
    command: 'summary',
    summary,
  };
}

export function createSlowStepsCommandJson(steps: TestStep[]): SlowStepsCommandJson {
  return {
    schemaVersion: CLI_JSON_SCHEMA_VERSION,
    command: 'slow-steps',
    count: steps.length,
    steps,
  };
}

export function createStepsCommandJson(steps: TestStep[]): StepsCommandJson {
  return {
    schemaVersion: CLI_JSON_SCHEMA_VERSION,
    command: 'steps',
    count: steps.length,
    steps,
  };
}

export function createNetworkCommandJson(entries: NetworkEntry[]): NetworkCommandJson {
  return {
    schemaVersion: CLI_JSON_SCHEMA_VERSION,
    command: 'network',
    count: entries.length,
    entries,
  };
}

export function createDomCommandJson(snapshots: ActionDomSnapshots[]): DomCommandJson {
  return {
    schemaVersion: CLI_JSON_SCHEMA_VERSION,
    command: 'dom',
    count: snapshots.length,
    snapshots,
  };
}

export function createTimelineCommandJson(entries: TimelineEntry[]): TimelineCommandJson {
  return {
    schemaVersion: CLI_JSON_SCHEMA_VERSION,
    command: 'timeline',
    count: entries.length,
    entries,
  };
}

export function createScreenshotsCommandJson(screenshots: Screenshot[]): ScreenshotsCommandJson {
  return {
    schemaVersion: CLI_JSON_SCHEMA_VERSION,
    command: 'screenshots',
    count: screenshots.length,
    screenshots,
  };
}