export { prepareTraceDir, readNdjson, getResourceBuffer, listTraces } from './parseTrace';
export type { TraceContext } from './parseTrace';

export {
  getTestSteps,
  getFailedTests,
  getNetworkTraffic,
  extractScreenshots,
  getDomSnapshots,
} from './extractors';

export type {
  TestStep,
  TraceError,
  FailedStep,
  NetworkEntry,
  Screenshot,
  DomSnapshot,
  ActionDomSnapshots,
} from './extractors';
