export { NdjsonParseError, prepareTraceDir, readNdjson, getResourceBuffer, listTraces, getReportMetadata, buildReportTraceMaps, findTraces } from './parseTrace';
export type { TraceContext, ReportTestSummary, ReportMetadata, ReportTraceMaps, FoundTrace } from './parseTrace';

export {
  InconsistentTraceVersionError,
  MAX_SUPPORTED_TRACE_VERSION,
  UnsupportedTraceVersionError,
  assertSupportedTraceVersion,
  inspectTraceCompatibility,
} from './traceCompatibility';
export type { TraceCompatibilityReport, TraceFileCompatibility } from './traceCompatibility';

export {
  getTestSteps,
  getTopLevelFailures,
  getTestTitle,
  getNetworkTraffic,
  getNetworkRequest,
  getConsoleEntries,
  getTraceIssues,
  getAttachments,
  extractAttachment,
  extractScreenshots,
  extractFailureScreenshots,
  getDomSnapshots,
  getTimeline,
  getSummary,
  getFailedTestSummaries,
} from './extractors';

export { writeFailureDigests } from './failureDigest';
export { writeTraceDigest } from './digestTrace';

export type {
  ActionDiagnosticSummary,
  ConsoleEntry,
  StepAnnotation,
  TestStep,
  TraceError,
  TraceIssue,
  NetworkFilterOptions,
  NetworkEntry,
  RelatedActionRef,
  AttachmentEntry,
  SavedAttachment,
  Screenshot,
  ScreenshotMetadata,
  FailureAnchor,
  FailureScreenshotSet,
  DomSnapshot,
  ActionDomSnapshots,
  DomSnapshotOptions,
  FailureDomSnapshotRef,
  TimelineEntry,
  TraceSummary,
  GetSummaryOptions,
  GetFailedTestSummariesOptions,
  FailedTraceSelection,
} from './extractors';
