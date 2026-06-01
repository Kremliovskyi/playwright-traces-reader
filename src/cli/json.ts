import type {
  ActionDomSnapshots,
  ActionDiagnosticSummary,
  AttachmentEntry,
  ConsoleEntry,
  FailureDomSnapshotRef,
  FoundTrace,
  NetworkEntry,
  SavedAttachment,
  Screenshot,
  TestStep,
  TraceIssue,
  TimelineEntry,
  TraceSummary,
} from '../index';
import type { HubReportDescriptor } from './helpers';

export const CLI_JSON_SCHEMA_VERSION = 1 as const;

/** Screencast frames captured around a single failure anchor. */
export interface FailureScreenshotSetJson {
  anchorCallId: string | null;
  anchorTitle: string | null;
  anchorTimestamp: number;
  /** Relative path (from the failure folder) to the frame before the failure, or null. */
  before: string | null;
  /** Relative path to the frame closest to the failure, or null. */
  action: string | null;
  /** Relative path to the frame after the failure, or null. */
  after: string | null;
}

/** When a failing network request happened relative to a failure anchor. */
export interface NetworkErrorTimingJson {
  anchorCallId: string | null;
  anchorTimestamp: number;
  relation: 'before' | 'during' | 'after' | 'unknown';
}

/** A single failing (status ≥ 400) network request enriched for triage. */
export interface NetworkErrorEntryJson {
  method: string;
  url: string;
  status: number;
  statusText: string;
  durationMs: number;
  startedDateTime: string;
  requestBody: string | null;
  responseBody: string | null;
  relatedAction: { callId: string; title: string } | null;
  timingRelativeToFailures: NetworkErrorTimingJson[];
}

/** Contents of the per-failure `network-errors.json` file. */
export interface NetworkErrorsFileJson {
  schemaVersion: typeof CLI_JSON_SCHEMA_VERSION;
  traceSha1: string;
  failureAnchors: Array<{ callId: string | null; title: string | null; timestamp: number }>;
  count: number;
  errors: NetworkErrorEntryJson[];
}

/** Contents of the per-failure `console-errors.json` file. */
export interface ConsoleErrorsFileJson {
  schemaVersion: typeof CLI_JSON_SCHEMA_VERSION;
  traceSha1: string;
  count: number;
  entries: ConsoleEntry[];
}

/** Per-failure `failure.json` written into each failure folder. */
export interface FailureFolderJson {
  schemaVersion: typeof CLI_JSON_SCHEMA_VERSION;
  testTitle: string | null;
  title: string;
  status: 'passed' | 'failed';
  outcome: 'expected' | 'unexpected' | 'flaky' | 'skipped' | null;
  durationMs: number | null;
  retryIndex: number;
  traceSha1: string;
  tracePath: string;
  topLevelSteps: TestStep[];
  issues: TraceIssue[];
  actionDiagnostics: ActionDiagnosticSummary[];
  failureDomSnapshot: FailureDomSnapshotRef | null;
  networkCallCount: number;
  networkErrorCount: number;
  consoleErrorCount: number;
  screenshots: FailureScreenshotSetJson[];
  /** Relative paths (from the failure folder) to companion artifact files, or null when absent. */
  files: {
    networkErrors: string | null;
    consoleErrors: string | null;
    errorMarkdown: string | null;
  };
}

/** One entry in the failures run manifest emitted to stdout. */
export interface FailureManifestEntry {
  folder: string;
  testTitle: string | null;
  title: string;
  retryIndex: number;
  status: 'passed' | 'failed';
  outcome: 'expected' | 'unexpected' | 'flaky' | 'skipped' | null;
  traceSha1: string;
  screenshotCount: number;
  networkErrorCount: number;
  consoleErrorCount: number;
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
  outputDir: string;
  runDir: string;
  count: number;
  failures: FailureManifestEntry[];
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

export interface RequestCommandJson {
  schemaVersion: typeof CLI_JSON_SCHEMA_VERSION;
  command: 'request';
  request: NetworkEntry;
}

export interface ConsoleCommandJson {
  schemaVersion: typeof CLI_JSON_SCHEMA_VERSION;
  command: 'console';
  count: number;
  entries: ConsoleEntry[];
}

export interface ErrorsCommandJson {
  schemaVersion: typeof CLI_JSON_SCHEMA_VERSION;
  command: 'errors';
  count: number;
  errors: TraceIssue[];
}

export interface AttachmentsCommandJson {
  schemaVersion: typeof CLI_JSON_SCHEMA_VERSION;
  command: 'attachments';
  count: number;
  attachments: AttachmentEntry[];
}

export interface AttachmentCommandJson {
  schemaVersion: typeof CLI_JSON_SCHEMA_VERSION;
  command: 'attachment';
  attachment: SavedAttachment;
}

export interface DomCommandJson {
  schemaVersion: typeof CLI_JSON_SCHEMA_VERSION;
  command: 'dom';
  count: number;
  savedPath: string;
  snapshots: ActionDomSnapshots[];
}

export interface DomConfirmationJson {
  schemaVersion: typeof CLI_JSON_SCHEMA_VERSION;
  command: 'dom';
  count: number;
  savedPath: string;
  callIds: string[];
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

export interface FindTracesCommandJson {
  schemaVersion: typeof CLI_JSON_SCHEMA_VERSION;
  command: 'find-traces';
  count: number;
  traces: FoundTrace[];
}

export interface VaultReadCommandJson {
  schemaVersion: typeof CLI_JSON_SCHEMA_VERSION;
  command: 'vault-read';
  filename: string;
  content: string;
  savedPath: string | null;
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
  | RequestCommandJson
  | ConsoleCommandJson
  | ErrorsCommandJson
  | AttachmentsCommandJson
  | AttachmentCommandJson
  | DomCommandJson
  | DomConfirmationJson
  | TimelineCommandJson
  | ScreenshotsCommandJson
  | FindTracesCommandJson
  | VaultReadCommandJson;

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

export function createFailuresCommandJson(
  outputDir: string,
  runDir: string,
  failures: FailureManifestEntry[],
): FailuresCommandJson {
  return {
    schemaVersion: CLI_JSON_SCHEMA_VERSION,
    command: 'failures',
    outputDir,
    runDir,
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

export function createRequestCommandJson(request: NetworkEntry): RequestCommandJson {
  return {
    schemaVersion: CLI_JSON_SCHEMA_VERSION,
    command: 'request',
    request,
  };
}

export function createConsoleCommandJson(entries: ConsoleEntry[]): ConsoleCommandJson {
  return {
    schemaVersion: CLI_JSON_SCHEMA_VERSION,
    command: 'console',
    count: entries.length,
    entries,
  };
}

export function createErrorsCommandJson(errors: TraceIssue[]): ErrorsCommandJson {
  return {
    schemaVersion: CLI_JSON_SCHEMA_VERSION,
    command: 'errors',
    count: errors.length,
    errors,
  };
}

export function createAttachmentsCommandJson(attachments: AttachmentEntry[]): AttachmentsCommandJson {
  return {
    schemaVersion: CLI_JSON_SCHEMA_VERSION,
    command: 'attachments',
    count: attachments.length,
    attachments,
  };
}

export function createAttachmentCommandJson(attachment: SavedAttachment): AttachmentCommandJson {
  return {
    schemaVersion: CLI_JSON_SCHEMA_VERSION,
    command: 'attachment',
    attachment,
  };
}

export function createDomCommandJson(snapshots: ActionDomSnapshots[], savedPath: string): DomCommandJson {
  return {
    schemaVersion: CLI_JSON_SCHEMA_VERSION,
    command: 'dom',
    count: snapshots.length,
    savedPath,
    snapshots,
  };
}

export function createDomConfirmationJson(snapshots: ActionDomSnapshots[], savedPath: string): DomConfirmationJson {
  return {
    schemaVersion: CLI_JSON_SCHEMA_VERSION,
    command: 'dom',
    count: snapshots.length,
    savedPath,
    callIds: snapshots.map(s => s.callId),
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

export function createFindTracesCommandJson(traces: FoundTrace[]): FindTracesCommandJson {
  return {
    schemaVersion: CLI_JSON_SCHEMA_VERSION,
    command: 'find-traces',
    count: traces.length,
    traces,
  };
}

export function createVaultReadCommandJson(filename: string, content: string, savedPath?: string): VaultReadCommandJson {
  return {
    schemaVersion: CLI_JSON_SCHEMA_VERSION,
    command: 'vault-read',
    filename,
    content,
    savedPath: savedPath ?? null,
  };
}