import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import AdmZip from 'adm-zip';

type Outcome = 'expected' | 'unexpected' | 'flaky' | 'skipped';

interface TraceSpec {
  sha1: string;
  testId: string;
  fullTitle: string;
  rootTitle: string;
  outcome: Outcome;
  startTime: number;
  endTime: number;
  zippedOnly?: boolean;
  skipped?: boolean;
}

export interface SyntheticTraceRef {
  sha1: string;
  testId: string;
  fullTitle: string;
  rootTitle: string;
  tracePath: string;
  rootCallId: string;
}

export interface SyntheticReportFixture {
  rootDir: string;
  dataDir: string;
  traces: {
    failedEarlierZip: SyntheticTraceRef;
    failedLatest: SyntheticTraceRef;
    failedPeer: SyntheticTraceRef;
    passed: SyntheticTraceRef;
    skipped: SyntheticTraceRef;
  };
}

const BASE_TIME = Date.UTC(2026, 0, 15, 10, 0, 0);

function toNdjson(events: unknown[]): string {
  return `${events.map(event => JSON.stringify(event)).join('\n')}\n`;
}

function snapshotTree(label: string, targetCallId?: string): unknown[] {
  return [
    'html',
    {},
    [
      'body',
      {},
      ['div', { id: 'app' }, label],
      ['button', targetCallId ? { id: 'submit', __playwright_target__: targetCallId } : { id: 'submit' }, 'Submit'],
    ],
  ];
}

async function writeTrace(dataDir: string, spec: TraceSpec): Promise<SyntheticTraceRef> {
  const traceDir = path.join(dataDir, spec.sha1);
  const resourcesDir = path.join(traceDir, 'resources');
  const rootCallId = `call@${spec.sha1}`;
  const childCallId = `assert@${spec.sha1}`;
  const screenshotSha1 = `${spec.sha1}-screen.jpeg`;
  const responseSha1 = `${spec.sha1}-response.json`;
  const attachmentSha1 = `${spec.sha1}-attachment.txt`;
  const browserUrl = `https://synthetic.example/${spec.sha1}`;
  const errorMessage = spec.skipped ? 'Test is skipped: synthetic skip' : `Synthetic failure for ${spec.sha1}`;
  const error = spec.outcome === 'expected'
    ? undefined
    : { name: spec.skipped ? 'SkipError' : 'AssertionError', message: errorMessage };

  await fs.promises.mkdir(resourcesDir, { recursive: true });
  await fs.promises.writeFile(path.join(resourcesDir, screenshotSha1), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  await fs.promises.writeFile(path.join(resourcesDir, responseSha1), JSON.stringify({ ok: spec.outcome === 'expected', trace: spec.sha1 }));
  await fs.promises.writeFile(path.join(resourcesDir, attachmentSha1), `attachment for ${spec.sha1}\n`);

  const testTraceEvents = [
    {
      type: 'before',
      callId: `hook@${spec.sha1}`,
      startTime: spec.startTime - 50,
      class: 'Test',
      method: 'hook',
      title: 'Before Hooks',
      params: {},
      stack: [],
    },
    {
      type: 'after',
      callId: `hook@${spec.sha1}`,
      endTime: spec.startTime - 25,
    },
    {
      type: 'before',
      callId: rootCallId,
      startTime: spec.startTime,
      class: 'Test',
      method: 'step',
      title: spec.rootTitle,
      params: {},
      stack: [],
    },
    {
      type: 'before',
      callId: childCallId,
      parentId: rootCallId,
      startTime: spec.startTime + 100,
      class: 'Expect',
      method: 'toEqual',
      title: spec.outcome === 'expected' ? 'Verify success state' : 'Verify failure state',
      params: {},
      stack: [],
    },
    {
      type: 'after',
      callId: childCallId,
      endTime: spec.startTime + 250,
      error,
    },
    {
      type: 'after',
      callId: rootCallId,
      endTime: spec.endTime,
      error,
      annotations: spec.skipped ? [{ type: 'skip', description: 'synthetic skip' }] : [],
      attachments: [
        {
          name: `artifact-${spec.sha1}.txt`,
          contentType: 'text/plain',
          sha1: attachmentSha1,
        },
      ],
    },
  ];

  const traceEvents = [
    { type: 'context-options', title: spec.fullTitle },
    {
      type: 'before',
      callId: rootCallId,
      startTime: spec.startTime + 90,
      class: 'Locator',
      method: 'click',
      title: spec.outcome === 'expected' ? 'Click submit button' : 'Click failing submit button',
      pageId: 'page@1',
      params: {},
      stack: [],
    },
    {
      type: 'frame-snapshot',
      snapshot: {
        callId: rootCallId,
        snapshotName: `before@${rootCallId}`,
        pageId: 'page@1',
        frameId: 'frame@1',
        frameUrl: browserUrl,
        html: snapshotTree('Before submit', rootCallId),
        viewport: { width: 1280, height: 720 },
        timestamp: spec.startTime + 110,
        wallTime: spec.startTime + 110,
        resourceOverrides: [],
        isMainFrame: true,
      },
    },
    {
      type: 'frame-snapshot',
      snapshot: {
        callId: rootCallId,
        snapshotName: `input@${rootCallId}`,
        pageId: 'page@1',
        frameId: 'frame@1',
        frameUrl: browserUrl,
        html: snapshotTree('Submitting', rootCallId),
        viewport: { width: 1280, height: 720 },
        timestamp: spec.startTime + 140,
        wallTime: spec.startTime + 140,
        resourceOverrides: [],
        isMainFrame: true,
      },
    },
    {
      type: 'frame-snapshot',
      snapshot: {
        callId: rootCallId,
        snapshotName: `after@${rootCallId}`,
        pageId: 'page@1',
        frameId: 'frame@1',
        frameUrl: browserUrl,
        html: snapshotTree(spec.outcome === 'expected' ? 'Submission complete' : 'Submission failed'),
        viewport: { width: 1280, height: 720 },
        timestamp: spec.endTime - 10,
        wallTime: spec.endTime - 10,
        resourceOverrides: [],
        isMainFrame: true,
      },
    },
    {
      type: 'screencast-frame',
      pageId: 'page@1',
      sha1: screenshotSha1,
      width: 1280,
      height: 720,
      timestamp: spec.startTime + 150,
      frameSwapWallTime: spec.startTime + 150,
    },
    {
      type: 'console',
      time: spec.startTime + 160,
      pageId: 'page@1',
      messageType: 'info',
      text: `info message ${spec.sha1}`,
      location: {
        url: `${browserUrl}/app.js`,
        lineNumber: 12,
        columnNumber: 4,
      },
    },
    {
      type: 'console',
      time: spec.startTime + 165,
      pageId: 'page@1',
      messageType: 'warning',
      text: `warning message ${spec.sha1}`,
      location: {
        url: `${browserUrl}/app.js`,
        lineNumber: 14,
        columnNumber: 2,
      },
    },
    {
      type: 'console',
      time: spec.startTime + 170,
      pageId: 'page@1',
      messageType: 'error',
      text: `error message ${spec.sha1}`,
      location: {
        url: `${browserUrl}/app.js`,
        lineNumber: 20,
        columnNumber: 1,
      },
    },
    {
      type: 'event',
      time: spec.startTime + 175,
      class: 'BrowserContext',
      method: 'pageError',
      params: {
        error: {
          error: {
            name: 'PageError',
            message: `page error ${spec.sha1}`,
            stack: `Error: page error ${spec.sha1}`,
          },
        },
      },
      pageId: 'page@1',
    },
    {
      type: 'stdout',
      timestamp: spec.startTime + 180,
      text: `stdout ${spec.sha1}`,
    },
    {
      type: 'stderr',
      timestamp: spec.startTime + 185,
      text: `stderr ${spec.sha1}`,
    },
    {
      type: 'error',
      message: `trace error ${spec.sha1}`,
      stack: [
        {
          file: 'tests/synthetic.spec.ts',
          line: 99,
          column: 5,
        },
      ],
    },
    {
      type: 'after',
      callId: rootCallId,
      endTime: spec.startTime + 240,
    },
  ];

  const networkEvents = [
    {
      type: 'resource-snapshot',
      snapshot: {
        pageref: 'page@1',
        startedDateTime: new Date(spec.startTime + 120).toISOString(),
        time: 45,
        request: {
          method: 'GET',
          url: `${browserUrl}/browser-call`,
          headers: [{ name: 'accept', value: 'application/json' }],
        },
        response: {
          status: spec.outcome === 'expected' ? 200 : 500,
          statusText: spec.outcome === 'expected' ? 'OK' : 'Server Error',
          headers: [{ name: 'content-type', value: 'application/json' }],
          content: {
            size: 17,
            mimeType: 'application/json',
            text: JSON.stringify({ source: 'browser', trace: spec.sha1 }),
          },
        },
      },
    },
    {
      type: 'resource-snapshot',
      snapshot: {
        _apiRequest: true,
        startedDateTime: new Date(spec.startTime + 180).toISOString(),
        time: 30,
        request: {
          method: 'POST',
          url: `${browserUrl}/api-call`,
          headers: [{ name: 'content-type', value: 'application/json' }],
          postData: {
            mimeType: 'application/json',
            text: JSON.stringify({ action: 'submit', trace: spec.sha1 }),
          },
        },
        response: {
          status: spec.outcome === 'expected' ? 200 : 422,
          statusText: spec.outcome === 'expected' ? 'OK' : 'Unprocessable Entity',
          headers: [{ name: 'content-type', value: 'application/json' }],
          content: {
            size: 24,
            mimeType: 'application/json',
            _sha1: responseSha1,
          },
        },
      },
    },
  ];

  await fs.promises.writeFile(path.join(traceDir, 'test.trace'), toNdjson(testTraceEvents));
  await fs.promises.writeFile(path.join(traceDir, '0-trace.trace'), toNdjson(traceEvents));
  await fs.promises.writeFile(path.join(traceDir, '0.network'), toNdjson(networkEvents));

  const zipPath = `${traceDir}.zip`;
  const zip = new AdmZip();
  zip.addLocalFolder(traceDir);
  zip.writeZip(zipPath);

  let tracePath = traceDir;
  if (spec.zippedOnly) {
    await fs.promises.rm(traceDir, { recursive: true, force: true });
    tracePath = zipPath;
  }

  return {
    sha1: spec.sha1,
    testId: spec.testId,
    fullTitle: spec.fullTitle,
    rootTitle: spec.rootTitle,
    tracePath,
    rootCallId,
  };
}

function buildReportHtml(base64Zip: string): string {
  return `<!doctype html><html><body><template id="playwrightReportBase64">data:application/zip;base64,${base64Zip}</template></body></html>`;
}

export async function createSyntheticReportFixture(): Promise<SyntheticReportFixture> {
  const rootDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pw-traces-reader-fixture-'));
  const dataDir = path.join(rootDir, 'data');
  await fs.promises.mkdir(dataDir, { recursive: true });

  const specs: TraceSpec[] = [
    {
      sha1: 'trace-fail-earlier',
      testId: 'retry-test',
      fullTitle: 'tests/synthetic.spec.ts:10 › Checkout › retries keep latest failure',
      rootTitle: 'Earlier synthetic failure',
      outcome: 'unexpected',
      startTime: BASE_TIME,
      endTime: BASE_TIME + 600,
      zippedOnly: true,
    },
    {
      sha1: 'trace-fail-latest',
      testId: 'retry-test',
      fullTitle: 'tests/synthetic.spec.ts:10 › Checkout › retries keep latest failure',
      rootTitle: 'Latest synthetic failure',
      outcome: 'unexpected',
      startTime: BASE_TIME + 1000,
      endTime: BASE_TIME + 1800,
    },
    {
      sha1: 'trace-fail-peer',
      testId: 'peer-failure-test',
      fullTitle: 'tests/synthetic.spec.ts:16 › Checkout › exposes repeated failure pattern',
      rootTitle: 'Peer synthetic failure',
      outcome: 'unexpected',
      startTime: BASE_TIME + 1900,
      endTime: BASE_TIME + 2500,
    },
    {
      sha1: 'trace-pass',
      testId: 'passing-test',
      fullTitle: 'tests/synthetic.spec.ts:20 › Checkout › allows successful completion',
      rootTitle: 'Synthetic passing flow',
      outcome: 'expected',
      startTime: BASE_TIME + 2600,
      endTime: BASE_TIME + 3200,
    },
    {
      sha1: 'trace-skip',
      testId: 'skipped-test',
      fullTitle: 'tests/synthetic.spec.ts:30 › Checkout › handles skipped flow',
      rootTitle: 'Synthetic skipped flow',
      outcome: 'skipped',
      startTime: BASE_TIME + 3400,
      endTime: BASE_TIME + 3700,
      skipped: true,
    },
  ];

  const traceRefs = await Promise.all(specs.map(spec => writeTrace(dataDir, spec)));
  const failedEarlierZip = traceRefs[0]!;
  const failedLatest = traceRefs[1]!;
  const failedPeer = traceRefs[2]!;
  const passed = traceRefs[3]!;
  const skipped = traceRefs[4]!;

  await fs.promises.writeFile(path.join(dataDir, 'notes.md'), 'ignore me\n');
  await fs.promises.writeFile(path.join(dataDir, 'preview.png'), 'not-a-trace\n');

  const reportJson = {
    stats: { total: 5, expected: 1, unexpected: 3, flaky: 0, skipped: 1, ok: false },
    files: [
      {
        fileId: 'synthetic.spec.ts',
        fileName: 'tests/synthetic.spec.ts',
        tests: specs.map(spec => {
          const titleParts = spec.fullTitle.split(' › ');
          const shortTitle = titleParts[titleParts.length - 1] ?? spec.fullTitle;
          return {
          testId: spec.testId,
          title: shortTitle,
          path: spec.fullTitle.split(' › '),
          projectName: 'synthetic',
          location: { file: 'tests/synthetic.spec.ts', line: 1, column: 1 },
          outcome: spec.outcome,
          duration: spec.endTime - spec.startTime,
          ok: spec.outcome === 'expected' || spec.outcome === 'flaky',
          annotations: spec.skipped ? [{ type: 'skip', description: 'synthetic skip' }] : [],
          tags: [],
          results: [
            {
              attachments: [
                {
                  name: 'trace',
                  path: `data/${spec.sha1}.zip`,
                  contentType: 'application/zip',
                },
              ],
            },
          ],
        };
        }),
      },
    ],
    projectNames: ['synthetic'],
    startTime: BASE_TIME,
    duration: 3700,
  };

  const reportZip = new AdmZip();
  reportZip.addFile('report.json', Buffer.from(JSON.stringify(reportJson), 'utf8'));
  const base64Zip = reportZip.toBuffer().toString('base64');
  await fs.promises.writeFile(path.join(rootDir, 'index.html'), buildReportHtml(base64Zip));

  return {
    rootDir,
    dataDir,
    traces: {
      failedEarlierZip,
      failedLatest,
      failedPeer,
      passed,
      skipped,
    },
  };
}

export async function cleanupSyntheticReportFixture(fixture: SyntheticReportFixture): Promise<void> {
  await fs.promises.rm(fixture.rootDir, { recursive: true, force: true });
}