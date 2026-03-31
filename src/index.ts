export { prepareTraceDir, readNdjson, getResourceBuffer, listTraces, getReportMetadata, buildReportTraceMaps } from './parseTrace';
export type { TraceContext, ReportTestSummary, ReportMetadata, ReportTraceMaps } from './parseTrace';

export {
  getTestSteps,
  getTopLevelFailures,
  getTestTitle,
  getNetworkTraffic,
  extractScreenshots,
  getDomSnapshots,
  getTimeline,
  getSummary,
  getFailedTestSummaries,
} from './extractors';

export type {
  StepAnnotation,
  TestStep,
  TraceError,
  NetworkEntry,
  Screenshot,
  ScreenshotMetadata,
  DomSnapshot,
  ActionDomSnapshots,
  DomSnapshotOptions,
  TimelineEntry,
  TraceSummary,
  GetSummaryOptions,
  GetFailedTestSummariesOptions,
} from './extractors';
