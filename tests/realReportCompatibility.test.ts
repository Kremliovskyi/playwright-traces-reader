import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import AdmZip from 'adm-zip';
import { inspectTraceCompatibility, MAX_SUPPORTED_TRACE_VERSION, prepareTraceDir } from '../src';

jest.setTimeout(60000);

interface FoundTrace {
  testTitle: string;
  outcome: string;
  resultIndex: number;
  traceSha1: string;
  tracePath: string;
}

interface CommandOutput extends Record<string, unknown> {
  schemaVersion: number;
  command: string;
}

interface MatrixFingerprint {
  traces: Array<{ title: string; outcome: string; retry: number }>;
  failureRetries: number[];
  summary: { status: string; outcome: string; steps: string[] };
  network: Array<{ source: string; method: string; pathname: string; status: number }>;
  consoleMarkers: string[];
  issueMarkers: string[];
  attachmentNames: string[];
  counts: Record<string, number>;
  compatibility: Array<{ traceVersion: number | null; playwrightVersions: string[]; eventTypes: Record<string, number> }>;
}

const repositoryRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repositoryRoot, 'dist', 'cli.js');
const fixturePath = path.join(repositoryRoot, 'tests', 'fixtures', 'real-reports', 'playwright-1.59.0.zip');

let tempRoot: string;
let reportRoot: string;
let initialReportHash: string;

async function runCli(args: string[]): Promise<CommandOutput> {
  const result = await new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: repositoryRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', exitCode => resolve({ exitCode: exitCode ?? 1, stdout, stderr }));
  });

  if (result.exitCode !== 0)
    throw new Error(`CLI failed (${args.join(' ')}): ${result.stderr || result.stdout}`);
  const output = JSON.parse(result.stdout) as CommandOutput;
  expect(output.schemaVersion).toBe(2);
  expect(output.command).toBe(args[0]);
  return output;
}

async function hashDirectory(rootDir: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  const visit = async (directory: string): Promise<void> => {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(rootDir, absolutePath).split(path.sep).join('/');
      hash.update(relativePath);
      if (entry.isDirectory())
        await visit(absolutePath);
      else if (entry.isFile())
        hash.update(await fs.promises.readFile(absolutePath));
    }
  };
  await visit(rootDir);
  return hash.digest('hex');
}

async function sha256File(filePath: string): Promise<string> {
  return crypto.createHash('sha256').update(await fs.promises.readFile(filePath)).digest('hex');
}

function flattenSteps(steps: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const flattened: Array<Record<string, unknown>> = [];
  for (const step of steps) {
    flattened.push(step);
    const children = Array.isArray(step.children) ? step.children as Array<Record<string, unknown>> : [];
    flattened.push(...flattenSteps(children));
  }
  return flattened;
}

function expectReferencedFiles(rootDir: string, references: Array<string | null>): void {
  for (const reference of references.filter((value): value is string => value !== null))
    expect(fs.existsSync(path.join(rootDir, reference))).toBe(true);
}

async function runCompatibilityMatrix(runNumber: number): Promise<MatrixFingerprint> {
  const outputRoot = path.join(tempRoot, `matrix-${runNumber}`);
  await fs.promises.mkdir(outputRoot, { recursive: true });

  const foundOutput = await runCli(['find-traces', reportRoot, 'PWTR']);
  const traces = foundOutput.traces as FoundTrace[];
  expect(traces).toHaveLength(6);
  expect(traces.filter(trace => trace.testTitle === 'PWTR deterministic failure').map(trace => trace.resultIndex)).toEqual([0, 1]);
  expect(traces.filter(trace => trace.testTitle === 'PWTR deterministic flaky').map(trace => trace.resultIndex)).toEqual([0, 1]);

  const richTrace = traces.find(trace => trace.testTitle === 'PWTR rich passing trace');
  const failedTrace = traces.find(trace => trace.testTitle === 'PWTR deterministic failure' && trace.resultIndex === 1);
  if (!richTrace)
    throw new Error('Rich passing compatibility trace was not found.');
  if (!failedTrace)
    throw new Error('Failed compatibility trace was not found.');

  const failuresOutput = await runCli(['failures', reportRoot, path.join(outputRoot, 'failures')]);
  const failures = failuresOutput.failures as Array<Record<string, unknown>>;
  expect(failures).toHaveLength(3);
  for (const failure of failures) {
    const failureDir = path.join(String(failuresOutput.runDir), String(failure.folder));
    const failureJson = JSON.parse(await fs.promises.readFile(path.join(failureDir, 'failure.json'), 'utf8')) as {
      files: { networkErrors: string | null; networkErrorBodies: string | null; consoleErrors: string | null; errorMarkdown: string | null };
      screenshots: Array<{ before: string | null; action: string | null; after: string | null; dom: string | null }>;
    };
    expectReferencedFiles(failureDir, Object.values(failureJson.files));
    for (const screenshotSet of failureJson.screenshots)
      expectReferencedFiles(failureDir, [screenshotSet.before, screenshotSet.action, screenshotSet.after, screenshotSet.dom]);
  }

  const summaryOutput = await runCli(['summary', richTrace.tracePath, '--report', reportRoot]);
  const summary = summaryOutput.summary as {
    status: string;
    outcome: string;
    topLevelSteps: Array<Record<string, unknown>>;
    issues: Array<{ source: string; message: string }>;
  };
  const topLevelStepTitles = summary.topLevelSteps.map(step => String(step.title));
  expect(summary.status).toBe('passed');
  expect(summary.outcome).toBe('expected');
  expect(topLevelStepTitles).toEqual([
    'PWTR_STEP_NAVIGATE',
    'PWTR_STEP_IFRAME',
    'PWTR_STEP_BROWSER_NETWORK',
    'PWTR_STEP_API_NETWORK',
  ]);

  const slowStepsOutput = await runCli(['slow-steps', richTrace.tracePath, '--report', reportRoot, '--limit', '3']);
  expect(slowStepsOutput.count).toBe(3);

  const stepsOutput = await runCli(['steps', richTrace.tracePath]);
  const steps = flattenSteps(stepsOutput.steps as Array<Record<string, unknown>>);
  expect(steps.some(step => step.title === 'PWTR_STEP_IFRAME')).toBe(true);

  const networkOutput = await runCli(['network', richTrace.tracePath]);
  const networkEntries = networkOutput.entries as Array<{
    id: number;
    source: string;
    method: string;
    url: string;
    status: number;
    requestBody: string | null;
    responseBody: string | null;
  }>;
  expect(networkEntries.some(entry => entry.source === 'browser' && entry.status === 503 && entry.responseBody?.includes('PWTR_BROWSER_FAILURE'))).toBe(true);
  expect(networkEntries.some(entry => entry.source === 'api' && entry.status === 422 && entry.requestBody?.includes('PWTR_API_REQUEST_BODY'))).toBe(true);
  expect(networkEntries.some(entry => entry.source === 'api' && entry.responseBody?.includes('PWTR_LARGE_BODY'))).toBe(true);
  const detailedRequest = networkEntries.find(entry => entry.source === 'api' && entry.status === 422);
  if (!detailedRequest)
    throw new Error('Detailed API compatibility request was not found.');
  const requestOutput = await runCli(['request', richTrace.tracePath, String(detailedRequest.id)]);
  expect((requestOutput.request as { responseBody: string }).responseBody).toContain('PWTR_API_FAILURE');

  const consoleOutput = await runCli(['console', richTrace.tracePath]);
  const consoleEntries = consoleOutput.entries as Array<{ text: string }>;
  const consoleMarkers = consoleEntries.map(entry => entry.text).filter(text => text.includes('PWTR_')).sort();
  expect(consoleMarkers).toEqual(expect.arrayContaining([
    'PWTR_CONSOLE_ERROR',
    'PWTR_CONSOLE_WARNING',
    'PWTR_PAGE_ERROR',
    'PWTR_STDERR_MARKER',
    'PWTR_STDOUT_MARKER',
  ]));

  const errorsOutput = await runCli(['errors', richTrace.tracePath]);
  const failedErrorsOutput = await runCli(['errors', failedTrace.tracePath]);
  const failedIssues = failedErrorsOutput.errors as Array<{ source: string; title: string | null; message: string }>;
  const issueMarkers = [
    ...(errorsOutput.errors as Array<{ message: string }>),
    ...failedIssues,
  ]
    .map(issue => issue.message)
    .filter(message => message.includes('PWTR_'))
    .sort();
  expect(issueMarkers).toContain('PWTR_PAGE_ERROR');
  expect(failedIssues.some(issue => issue.source === 'step' && issue.title === 'PWTR_STEP_ALWAYS_FAILS')).toBe(true);

  const attachmentsOutput = await runCli(['attachments', richTrace.tracePath]);
  const attachments = attachmentsOutput.attachments as Array<{ id: number; name: string }>;
  const markerAttachment = attachments.find(attachment => attachment.name === 'pwtr-attachment.txt');
  if (!markerAttachment)
    throw new Error('Compatibility attachment was not found.');
  const attachmentPath = path.join(outputRoot, 'attachment.txt');
  await runCli(['attachment', richTrace.tracePath, String(markerAttachment.id), '--output', attachmentPath]);
  expect(await fs.promises.readFile(attachmentPath, 'utf8')).toContain('PWTR_ATTACHMENT_MARKER');

  const domPath = path.join(outputRoot, 'dom.json');
  const domConfirmation = await runCli(['dom', richTrace.tracePath, '--output', domPath]);
  expect(Number(domConfirmation.count)).toBeGreaterThan(0);
  const domOutput = JSON.parse(await fs.promises.readFile(domPath, 'utf8')) as {
    snapshots: Array<{ before?: { targetElement?: string | null } | null; action?: { targetElement?: string | null } | null; after?: { targetElement?: string | null } | null }>;
  };
  const serializedDom = JSON.stringify(domOutput.snapshots);
  expect(serializedDom).toContain('PWTR_REAL_DOM_MARKER');
  expect(serializedDom).toContain('PWTR_IFRAME_MARKER');
  expect(serializedDom).toContain('srcdoc');
  expect(domOutput.snapshots.some(snapshot => [snapshot.before, snapshot.action, snapshot.after].some(phase => phase?.targetElement))).toBe(true);

  const timelineOutput = await runCli(['timeline', richTrace.tracePath]);
  const timeline = timelineOutput.entries as Array<{ timestamp: number; type: string }>;
  expect(new Set(timeline.map(entry => entry.type))).toEqual(new Set(['step', 'network', 'dom', 'screenshot']));
  for (let index = 1; index < timeline.length; index++)
    expect(timeline[index]!.timestamp).toBeGreaterThanOrEqual(timeline[index - 1]!.timestamp);

  const screenshotDir = path.join(outputRoot, 'screenshots');
  const screenshotsOutput = await runCli(['screenshots', richTrace.tracePath, '--out-dir', screenshotDir]);
  const screenshots = screenshotsOutput.screenshots as Array<{ savedPath: string }>;
  expect(screenshots.length).toBeGreaterThan(0);
  for (const screenshot of screenshots) {
    const image = await fs.promises.readFile(screenshot.savedPath);
    const isJpeg = image[0] === 0xff && image[1] === 0xd8;
    const isPng = image.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(isJpeg || isPng).toBe(true);
  }

  const digestOutput = await runCli(['digest', richTrace.tracePath, path.join(outputRoot, 'digest'), '--report', reportRoot]);
  const digestDir = path.join(String(digestOutput.runDir), String(digestOutput.folder));
  const digest = JSON.parse(await fs.promises.readFile(path.join(digestDir, 'digest.json'), 'utf8')) as {
    counts: { steps: number; leafActionsWithDom: number; screenshots: number; networkCalls: number; networkBodiesSpilled: number; consoleEntries: number };
    files: { network: string; networkBodies: string | null; console: string };
    steps: Array<Record<string, unknown>>;
  };
  expectReferencedFiles(digestDir, [digest.files.network, digest.files.networkBodies, digest.files.console]);
  expect(digest.counts.networkCalls).toBe(networkEntries.length);
  expect(digest.counts.networkBodiesSpilled).toBeGreaterThan(0);
  const networkLines = (await fs.promises.readFile(path.join(digestDir, digest.files.network), 'utf8'))
    .trim().split('\n').map(line => JSON.parse(line) as {
      seq: number;
      requestBodyRef: number | null;
      responseBodyRef: number | null;
    });
  const bodyLines = (await fs.promises.readFile(path.join(digestDir, digest.files.networkBodies!), 'utf8'))
    .trim().split('\n').map(line => JSON.parse(line) as { seq: number; direction: 'request' | 'response' });
  const bodyReferences = new Set(bodyLines.map(body => `${body.seq}:${body.direction}`));
  for (const networkLine of networkLines) {
    if (networkLine.requestBodyRef !== null)
      expect(bodyReferences.has(`${networkLine.requestBodyRef}:request`)).toBe(true);
    if (networkLine.responseBodyRef !== null)
      expect(bodyReferences.has(`${networkLine.responseBodyRef}:response`)).toBe(true);
  }
  const digestSteps = flattenSteps(digest.steps);
  for (const step of digestSteps) {
    const artifacts = step.artifacts as { dom: string | null; screenshot: string | null };
    expectReferencedFiles(digestDir, [artifacts.dom, artifacts.screenshot]);
  }

  const compatibility = [];
  for (const trace of traces) {
    const traceContext = await prepareTraceDir(trace.tracePath);
    const report = await inspectTraceCompatibility(traceContext);
    expect(report.traceVersion).toBe(MAX_SUPPORTED_TRACE_VERSION);
    expect(report.playwrightVersions).not.toEqual([]);
    expect(report.missingResources).toEqual([]);
    compatibility.push({
      traceVersion: report.traceVersion,
      playwrightVersions: report.playwrightVersions,
      eventTypes: report.eventTypes,
    });
  }

  return {
    traces: traces.map(trace => ({ title: trace.testTitle, outcome: trace.outcome, retry: trace.resultIndex })),
    failureRetries: failures.map(failure => Number(failure.retryIndex)).sort((left, right) => left - right),
    summary: { status: summary.status, outcome: summary.outcome, steps: topLevelStepTitles },
    network: networkEntries.map(entry => ({
      source: entry.source,
      method: entry.method,
      pathname: new URL(entry.url).pathname,
      status: entry.status,
    })),
    consoleMarkers,
    issueMarkers,
    attachmentNames: attachments.map(attachment => attachment.name).sort(),
    counts: {
      traces: traces.length,
      failures: failures.length,
      slowSteps: Number(slowStepsOutput.count),
      steps: steps.length,
      network: networkEntries.length,
      dom: Number(domConfirmation.count),
      timeline: timeline.length,
      screenshots: screenshots.length,
      digestSteps: digest.counts.steps,
      digestDom: digest.counts.leafActionsWithDom,
      digestScreenshots: digest.counts.screenshots,
      digestConsole: digest.counts.consoleEntries,
    },
    compatibility,
  };
}

beforeAll(async () => {
  if (!fs.existsSync(cliPath))
    throw new Error('dist/cli.js is missing. Run npm run build before compatibility tests.');
  tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pwtr-real-compat-'));
  reportRoot = path.join(tempRoot, 'playwright-report');
  const externalReport = process.env.PWTR_COMPAT_REPORT;
  if (externalReport) {
    await fs.promises.cp(path.resolve(externalReport), reportRoot, { recursive: true });
  } else {
    if (!fs.existsSync(fixturePath))
      throw new Error(`Real report fixture is missing: ${fixturePath}`);
    new AdmZip(fixturePath).extractAllTo(reportRoot, true);
    const provenance = JSON.parse(await fs.promises.readFile(path.join(reportRoot, 'provenance.json'), 'utf8')) as {
      resolvedPlaywrightVersion: string;
      traceVersions: number[];
      reportChecksums: Record<string, string>;
    };
    expect(provenance.resolvedPlaywrightVersion).toBe('1.59.0');
    expect(provenance.traceVersions).toEqual([8]);
    for (const [relativePath, checksum] of Object.entries(provenance.reportChecksums))
      expect(await sha256File(path.join(reportRoot, relativePath))).toBe(checksum);
  }
  initialReportHash = await hashDirectory(reportRoot);
});

afterAll(async () => {
  await fs.promises.rm(tempRoot, { recursive: true, force: true });
});

test('all trace commands are deterministic against a real Playwright report', async () => {
  const first = await runCompatibilityMatrix(1);
  const second = await runCompatibilityMatrix(2);

  expect(second).toEqual(first);
  expect(await hashDirectory(reportRoot)).toBe(initialReportHash);
});