import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runCli } from '../src/cli';
import type { NetworkErrorEntryJson, NetworkLineJson } from '../src/cli/json';
import {
  cleanupSyntheticReportFixture,
  createSyntheticReportFixture,
  type SyntheticReportFixture,
} from './syntheticReport';

jest.setTimeout(20000);

interface DigestNode {
  callId: string;
  artifacts: {
    dom: string | null;
    screenshot: string | null;
    network: number[];
    consoleErrors: number;
  };
  children: DigestNode[];
}

async function execCli(args: string[]) {
  let stdout = '';
  let stderr = '';
  const exitCode = await runCli(args, {
    stdout: text => { stdout += text; },
    stderr: text => { stderr += text; },
  });

  return { exitCode, stdout, stderr };
}

describe('playwright-traces-reader CLI', () => {
  let fixture: SyntheticReportFixture;

  beforeAll(async () => {
    fixture = await createSyntheticReportFixture();
  });

  afterAll(async () => {
    await cleanupSyntheticReportFixture(fixture);
  });

  test('failures command writes one folder per failed attempt with a manifest', async () => {
    const outDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pw-failures-out-'));
    try {
      const result = await execCli(['failures', fixture.rootDir, outDir]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');

      const payload = JSON.parse(result.stdout) as {
        schemaVersion: number;
        command: string;
        outputDir: string;
        runDir: string;
        count: number;
        failures: Array<Record<string, unknown>>;
      };
      expect(payload.schemaVersion).toBe(2);
      expect(payload.command).toBe('failures');
      expect(payload).not.toHaveProperty('patterns');
      // earlier retry, latest retry, peer failure, skipped, child-only failure = 5 attempts.
      expect(payload.count).toBe(5);
      expect(payload.failures).toHaveLength(5);

      // Manifest is mirrored to runDir/index.json.
      const indexJson = JSON.parse(
        await fs.promises.readFile(path.join(payload.runDir, 'index.json'), 'utf-8'),
      ) as { count: number; failures: Array<{ folder: string }> };
      expect(indexJson.count).toBe(5);

      // Regression guard: a failure recorded only on a child step (no root-step
      // error) is still captured because inclusion is gated on the report's
      // result status, not on `getTopLevelFailures()`.
      expect(payload.failures.some(entry => entry.traceSha1 === fixture.traces.childOnlyFailure.sha1)).toBe(true);

      // Retry attempts produce retry0 and retry1 folders.
      const retryIndexes = payload.failures
        .filter(entry => (entry.traceSha1 === fixture.traces.failedLatest.sha1) || (entry.traceSha1 === fixture.traces.failedEarlierZip.sha1))
        .map(entry => entry.retryIndex)
        .sort();
      expect(retryIndexes).toEqual([0, 1]);

      // Each failure folder exists on disk with a failure.json.
      for (const entry of payload.failures) {
        const folderDir = path.join(payload.runDir, entry.folder as string);
        expect(fs.existsSync(folderDir)).toBe(true);
        const failureJson = JSON.parse(
          await fs.promises.readFile(path.join(folderDir, 'failure.json'), 'utf-8'),
        ) as Record<string, unknown>;
        expect(failureJson).not.toHaveProperty('patterns');
        expect(failureJson.traceSha1).toBe(entry.traceSha1);
      }

      // The latest retry carries screenshots, network errors and an error.md.
      const latest = payload.failures.find(entry => entry.traceSha1 === fixture.traces.failedLatest.sha1)!;
      const latestDir = path.join(payload.runDir, latest.folder as string);
      const latestJson = JSON.parse(
        await fs.promises.readFile(path.join(latestDir, 'failure.json'), 'utf-8'),
      ) as {
        files: { errorMarkdown: string | null; networkErrors: string | null; networkErrorBodies: string | null; consoleErrors: string | null };
        domCount: number;
        screenshots: Array<{ dom: string | null; action: string | null }>;
      };
      expect(latest.networkErrorCount).toBe(2);
      // Network errors are NDJSON: one complete record per line.
      expect(latestJson.files.networkErrors).toBe('network-errors.ndjson');
      expect(fs.existsSync(path.join(latestDir, 'network-errors.ndjson'))).toBe(true);
      const networkErrorLines = (await fs.promises.readFile(path.join(latestDir, 'network-errors.ndjson'), 'utf-8'))
        .trim()
        .split('\n')
        .map(line => JSON.parse(line) as NetworkErrorEntryJson);
      expect(networkErrorLines).toHaveLength(2);
      expect(networkErrorLines[0]!.seq).toBe(1);
      expect(networkErrorLines.every(line => line.status >= 400)).toBe(true);
      // Triage enrichment is preserved in NDJSON form.
      expect(Array.isArray(networkErrorLines[0]!.timingRelativeToFailures)).toBe(true);
      const apiErrorLine = networkErrorLines.find(line => line.method === 'POST')!;
      expect(apiErrorLine.requestBody).toBeNull();
      expect(apiErrorLine.requestBodyIsLarge).toBe(true);
      expect(apiErrorLine.requestBodySizeBytes).toBeGreaterThan(32 * 1024);
      expect(apiErrorLine.requestBodyRef).toBe(apiErrorLine.seq);
      expect(apiErrorLine.responseBody).toBeNull();
      expect(apiErrorLine.responseBodyIsLarge).toBe(true);
      expect(apiErrorLine.responseBodySizeBytes).toBeGreaterThan(32 * 1024);
      expect(apiErrorLine.responseBodyRef).toBe(apiErrorLine.seq);
      expect(latestJson.files.networkErrorBodies).toBe('network-error-bodies.ndjson');
      const networkErrorBodies = (await fs.promises.readFile(path.join(latestDir, 'network-error-bodies.ndjson'), 'utf-8'))
        .trim()
        .split('\n')
        .map(line => JSON.parse(line) as { seq: number; direction: 'request' | 'response'; bodySizeBytes: number; body: string });
      expect(networkErrorBodies.filter(body => body.seq === apiErrorLine.seq).map(body => body.direction).sort()).toEqual(['request', 'response']);
      expect(networkErrorBodies.every(body => body.bodySizeBytes > 32 * 1024)).toBe(true);
      // Console errors are NDJSON.
      expect(latestJson.files.consoleErrors).toBe('console-errors.ndjson');
      expect(fs.existsSync(path.join(latestDir, 'console-errors.ndjson'))).toBe(true);
      expect(latestJson.files.errorMarkdown).toBe('error.md');
      expect(fs.existsSync(path.join(latestDir, 'error.md'))).toBe(true);
      expect(Number(latest.screenshotCount)).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(latestDir, 'screenshots'))).toBe(true);
      // Failure-moment DOM is written to disk and referenced from screenshots.
      expect(latest.domCount).toBeGreaterThan(0);
      expect(latestJson.domCount).toBe(latest.domCount);
      expect(fs.existsSync(path.join(latestDir, 'dom'))).toBe(true);
      const domRef = latestJson.screenshots.find(set => set.dom)!.dom!;
      expect(fs.existsSync(path.join(latestDir, domRef))).toBe(true);
    } finally {
      await fs.promises.rm(outDir, { recursive: true, force: true });
    }
  });

  test('failures command respects exclude-skipped', async () => {
    const outDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pw-failures-out-'));
    try {
      const result = await execCli(['failures', fixture.rootDir, outDir, '--exclude-skipped']);

      expect(result.exitCode).toBe(0);

      const payload = JSON.parse(result.stdout) as {
        count: number;
        failures: Array<{ outcome: string | null; traceSha1: string }>;
      };
      expect(payload.count).toBe(4);
      expect(payload.failures.every(entry => entry.outcome !== 'skipped')).toBe(true);
      expect(payload.failures.some(entry => entry.traceSha1 === fixture.traces.failedLatest.sha1)).toBe(true);
      expect(payload.failures.some(entry => entry.traceSha1 === fixture.traces.failedPeer.sha1)).toBe(true);
    } finally {
      await fs.promises.rm(outDir, { recursive: true, force: true });
    }
  });

  test('failures command requires an output directory', async () => {
    const result = await execCli(['failures', fixture.rootDir]);
    expect(result.exitCode).not.toBe(0);
  });

  test('digest command writes a chronological step tree with linked artifacts', async () => {
    const outDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pw-digest-out-'));
    try {
      const result = await execCli([
        'digest',
        fixture.traces.failedLatest.tracePath,
        outDir,
        '--report',
        fixture.rootDir,
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');

      const manifest = JSON.parse(result.stdout) as {
        schemaVersion: number;
        command: string;
        runDir: string;
        folder: string;
        traceSha1: string;
        status: string;
        networkCallCount: number;
        domCount: number;
        screenshotCount: number;
        consoleEntryCount: number;
      };
      expect(manifest.schemaVersion).toBe(2);
      expect(manifest.command).toBe('digest');
      expect(manifest.traceSha1).toBe(fixture.traces.failedLatest.sha1);
      expect(manifest.status).toBe('failed');
      // DOM snapshots and screenshots are paired 1:1.
      expect(manifest.domCount).toBe(manifest.screenshotCount);
      expect(manifest.networkCallCount).toBeGreaterThan(0);

      const folderDir = path.join(manifest.runDir, manifest.folder);
      expect(fs.existsSync(path.join(folderDir, 'network.ndjson'))).toBe(true);
      expect(fs.existsSync(path.join(folderDir, 'console.ndjson'))).toBe(true);

      const digest = JSON.parse(
        await fs.promises.readFile(path.join(folderDir, 'digest.json'), 'utf-8'),
      ) as {
        command: string;
        traceSha1: string;
        files: { network: string; networkBodies: string | null; console: string };
        counts: { networkCalls: number; networkBodiesSpilled: number };
        steps: Array<DigestNode>;
      };
      expect(digest.command).toBe('digest');
      expect(digest.traceSha1).toBe(fixture.traces.failedLatest.sha1);

      // network.ndjson is chronological with a global seq starting at 1.
      const networkLines = (await fs.promises.readFile(path.join(folderDir, 'network.ndjson'), 'utf-8'))
        .trim()
        .split('\n')
        .map(line => JSON.parse(line) as NetworkLineJson);
      expect(networkLines.length).toBe(digest.counts.networkCalls);
      expect(networkLines[0]!.seq).toBe(1);
      const apiLine = networkLines.find(line => line.method === 'POST')!;
      expect(apiLine.requestBody).toBeNull();
      expect(apiLine.requestBodyIsLarge).toBe(true);
      expect(apiLine.requestBodyRef).toBe(apiLine.seq);
      expect(apiLine.responseBody).toBeNull();
      expect(apiLine.responseBodyIsLarge).toBe(true);
      expect(apiLine.responseBodyRef).toBe(apiLine.seq);
      expect(digest.files.networkBodies).toBe('network-bodies.ndjson');
      const networkBodies = (await fs.promises.readFile(path.join(folderDir, 'network-bodies.ndjson'), 'utf-8'))
        .trim()
        .split('\n')
        .map(line => JSON.parse(line) as { seq: number; direction: 'request' | 'response' });
      expect(networkBodies.filter(body => body.seq === apiLine.seq).map(body => body.direction).sort()).toEqual(['request', 'response']);
      expect(digest.counts.networkBodiesSpilled).toBe(networkBodies.length);

      // Every network seq referenced by a step resolves in network.ndjson, and the
      // root step's links are a superset of its descendants' (ancestor nesting).
      const seqSet = new Set(networkLines.map(l => l.seq));
      const collectLinks = (node: DigestNode, acc: Set<number>): void => {
        for (const seq of node.artifacts.network) acc.add(seq);
        for (const child of node.children) collectLinks(child, acc);
      };
      let leafWithDom: DigestNode | null = null;
      const walk = (node: DigestNode): void => {
        for (const seq of node.artifacts.network) expect(seqSet.has(seq)).toBe(true);
        if (node.children.length === 0 && node.artifacts.dom) leafWithDom = node;
        for (const child of node.children) walk(child);
      };
      for (const step of digest.steps) walk(step);

      const rootWithLinks = digest.steps.find(step => {
        const acc = new Set<number>();
        collectLinks(step, acc);
        return acc.size > 0;
      });
      expect(rootWithLinks).toBeDefined();
      const rootLinks = new Set<number>();
      collectLinks(rootWithLinks!, rootLinks);
      const findChildLinks = (node: DigestNode): void => {
        for (const child of node.children) {
          for (const seq of child.artifacts.network) expect(rootLinks.has(seq)).toBe(true);
          findChildLinks(child);
        }
      };
      findChildLinks(rootWithLinks!);

      // The leaf action with a DOM snapshot also has a paired screenshot file.
      expect(leafWithDom).not.toBeNull();
      expect(leafWithDom!.artifacts.screenshot).not.toBeNull();
      expect(fs.existsSync(path.join(folderDir, leafWithDom!.artifacts.dom!))).toBe(true);
      expect(fs.existsSync(path.join(folderDir, leafWithDom!.artifacts.screenshot!))).toBe(true);
    } finally {
      await fs.promises.rm(outDir, { recursive: true, force: true });
    }
  });

  test('find-traces returns every retry from immutable archive paths', async () => {
    const result = await execCli(['find-traces', fixture.rootDir, 'retries keep latest failure']);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');

    const payload = JSON.parse(result.stdout) as {
      schemaVersion: number;
      command: string;
      count: number;
      traces: Array<{ outcome: string; resultIndex: number; traceSha1: string; tracePath: string }>;
    };
    expect(payload.schemaVersion).toBe(2);
    expect(payload.command).toBe('find-traces');
    expect(payload.count).toBe(2);
    expect(payload.traces.map(trace => trace.resultIndex)).toEqual([0, 1]);
    expect(payload.traces.map(trace => trace.traceSha1)).toEqual([
      fixture.traces.failedEarlierZip.sha1,
      fixture.traces.failedLatest.sha1,
    ]);
    expect(payload.traces.every(trace => trace.outcome === 'unexpected')).toBe(true);
    expect(payload.traces.every(trace => trace.tracePath.endsWith('.zip'))).toBe(true);
  });

  test('find-traces treats special characters literally and filters outcomes', async () => {
    const matching = await execCli(['find-traces', fixture.rootDir, '[literal](v2)', '--outcome', 'expected']);
    const excluded = await execCli(['find-traces', fixture.rootDir, '[literal](v2)', '--outcome', 'unexpected']);

    expect(matching.exitCode).toBe(0);
    expect(excluded.exitCode).toBe(0);

    const matchingPayload = JSON.parse(matching.stdout) as { count: number; traces: Array<{ traceSha1: string }> };
    const excludedPayload = JSON.parse(excluded.stdout) as { count: number };
    expect(matchingPayload.count).toBe(1);
    expect(matchingPayload.traces[0]!.traceSha1).toBe(fixture.traces.passed.sha1);
    expect(excludedPayload.count).toBe(0);
  });

  test('summary command returns a failed trace summary as JSON', async () => {
    const result = await execCli(['summary', fixture.traces.failedLatest.tracePath, '--report', fixture.rootDir]);

    expect(result.exitCode).toBe(0);

    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload.schemaVersion).toBe(2);
    expect(payload.command).toBe('summary');
    const summary = payload.summary as Record<string, unknown>;
    expect(summary.status).toBe('failed');
    expect(summary.outcome).toBe('unexpected');
    expect(summary.title).toBe(fixture.traces.failedLatest.rootTitle);
    expect(Array.isArray(summary.slowestSteps)).toBe(true);
    expect(Array.isArray(summary.networkCalls)).toBe(true);
    expect(Array.isArray(summary.issues)).toBe(true);
    expect(Array.isArray(summary.actionDiagnostics)).toBe(true);
    const domRef = summary.failureDomSnapshot as { callId: string; phases: string[]; timestamp: number } | null;
    expect(domRef).not.toBeNull();
    expect(domRef!.callId).toBe(fixture.traces.failedLatest.rootCallId);
    expect(Array.isArray(domRef!.phases)).toBe(true);
    expect(typeof domRef!.timestamp).toBe('number');
    expect(domRef).not.toHaveProperty('html');
  });

  test('summary command works for a passed trace', async () => {
    const result = await execCli(['summary', fixture.traces.passed.tracePath, '--report', fixture.rootDir]);

    expect(result.exitCode).toBe(0);

    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload.schemaVersion).toBe(2);
    expect(payload.command).toBe('summary');
    const summary = payload.summary as Record<string, unknown>;
    expect(summary.status).toBe('passed');
    expect(summary.outcome).toBe('expected');
    expect(summary.error).toBeNull();
    expect(summary.failureDomSnapshot).toBeNull();
  });

  test('slow-steps command returns a bounded JSON payload', async () => {
    const result = await execCli(['slow-steps', fixture.traces.failedLatest.tracePath, '--report', fixture.rootDir, '--limit', '1']);

    expect(result.exitCode).toBe(0);

    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload.schemaVersion).toBe(2);
    expect(payload.command).toBe('slow-steps');
    expect(payload.count).toBe(1);
    const steps = payload.steps as Array<Record<string, unknown>>;
    expect(steps[0]).toHaveProperty('title');
  });

  test('steps command returns JSON by default', async () => {
    const result = await execCli(['steps', fixture.traces.failedLatest.tracePath]);

    expect(result.exitCode).toBe(0);

    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload.schemaVersion).toBe(2);
    expect(payload.command).toBe('steps');
    const steps = payload.steps as Array<Record<string, unknown>>;
    expect(steps.some(step => step.title === fixture.traces.failedLatest.rootTitle)).toBe(true);
  });

  test('steps command still supports text output explicitly', async () => {
    const result = await execCli(['steps', fixture.traces.failedLatest.tracePath, '--format', 'text']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(fixture.traces.failedLatest.rootTitle);
    expect(result.stdout).toContain('Verify failure state');
  });

  test('network command filters by source in JSON mode', async () => {
    const result = await execCli(['network', fixture.traces.failedLatest.tracePath, '--source', 'api']);

    expect(result.exitCode).toBe(0);

    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload.schemaVersion).toBe(2);
    expect(payload.command).toBe('network');
    const entries = payload.entries as Array<{ source: string; responseBody: string | null; relatedAction: { callId: string } | null }>;
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every(entry => entry.source === 'api')).toBe(true);
    expect(entries[0]!.responseBody).toContain('trace-fail-latest');
    expect(entries[0]!.relatedAction?.callId).toBe(fixture.traces.failedLatest.rootCallId);
  });

  test('network command supports near and status filters', async () => {
    const result = await execCli([
      'network',
      fixture.traces.failedLatest.tracePath,
      '--near',
      fixture.traces.failedLatest.rootCallId,
      '--status',
      '422',
    ]);

    expect(result.exitCode).toBe(0);

    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    const entries = payload.entries as Array<{ status: number; relatedAction: { callId: string } | null }>;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.status).toBe(422);
    expect(entries[0]!.relatedAction?.callId).toBe(fixture.traces.failedLatest.rootCallId);
  });

  test('request command returns one detailed request by id', async () => {
    const result = await execCli(['request', fixture.traces.failedLatest.tracePath, '2']);

    expect(result.exitCode).toBe(0);

    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload.schemaVersion).toBe(2);
    expect(payload.command).toBe('request');
    const request = payload.request as { method: string; url: string; relatedAction: { callId: string } | null };
    expect(request.method).toBe('POST');
    expect(request.url).toContain('/api-call');
    expect(request.relatedAction?.callId).toBe(fixture.traces.failedLatest.rootCallId);
  });

  test('console command returns structured console entries and respects filters', async () => {
    const result = await execCli(['console', fixture.traces.failedLatest.tracePath, '--errors-only']);

    expect(result.exitCode).toBe(0);

    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload.schemaVersion).toBe(2);
    expect(payload.command).toBe('console');
    const entries = payload.entries as Array<{ level: string; source: string }>;
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every(entry => entry.level === 'error')).toBe(true);
  });

  test('errors command returns step, page, and trace issues', async () => {
    const result = await execCli(['errors', fixture.traces.failedLatest.tracePath]);

    expect(result.exitCode).toBe(0);

    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload.schemaVersion).toBe(2);
    expect(payload.command).toBe('errors');
    const errors = payload.errors as Array<{ source: string; message: string }>;
    expect(errors.some(entry => entry.source === 'step')).toBe(true);
    expect(errors.some(entry => entry.source === 'page')).toBe(true);
    expect(errors.some(entry => entry.source === 'trace')).toBe(true);
  });

  test('attachments command returns attachment metadata', async () => {
    const result = await execCli(['attachments', fixture.traces.failedLatest.tracePath]);

    expect(result.exitCode).toBe(0);

    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload.schemaVersion).toBe(2);
    expect(payload.command).toBe('attachments');
    const attachments = payload.attachments as Array<{ name: string; actionTitle: string | null }>;
    expect(attachments).toHaveLength(1);
    expect(attachments[0]!.name).toContain('artifact-trace-fail-latest');
    expect(attachments[0]!.actionTitle).toBe(fixture.traces.failedLatest.rootTitle);
  });

  test('attachment command extracts an attachment to disk', async () => {
    const outPath = path.join(os.tmpdir(), 'pw-traces-reader-cli-attachment', `${Date.now()}.txt`);

    try {
      const result = await execCli(['attachment', fixture.traces.failedLatest.tracePath, '1', '--output', outPath]);

      expect(result.exitCode).toBe(0);

      const payload = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(payload.schemaVersion).toBe(2);
      expect(payload.command).toBe('attachment');
      const attachment = payload.attachment as { savedPath: string };
      expect(attachment.savedPath).toBe(outPath);
      expect(fs.existsSync(outPath)).toBe(true);
      expect(fs.readFileSync(outPath, 'utf8')).toContain('trace-fail-latest');
    } finally {
      await fs.promises.rm(path.dirname(outPath), { recursive: true, force: true });
    }
  });

  test('dom command writes snapshots to file and returns confirmation on stdout', async () => {
    const outPath = path.join(os.tmpdir(), 'pw-traces-reader-cli-dom', `${Date.now()}.json`);

    try {
      const result = await execCli(['dom', fixture.traces.failedLatest.tracePath, '--output', outPath, '--near', 'last', '--limit', '2']);

      expect(result.exitCode).toBe(0);

      // Stdout has lightweight confirmation
      const confirmation = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(confirmation.schemaVersion).toBe(2);
      expect(confirmation.command).toBe('dom');
      expect(confirmation.savedPath).toBe(outPath);
      expect(Array.isArray(confirmation.callIds)).toBe(true);
      expect(confirmation).not.toHaveProperty('snapshots');

      // File has full snapshots
      expect(fs.existsSync(outPath)).toBe(true);
      const filePayload = JSON.parse(fs.readFileSync(outPath, 'utf8')) as Record<string, unknown>;
      expect(filePayload.command).toBe('dom');
      expect(filePayload.savedPath).toBe(outPath);
      const snapshots = filePayload.snapshots as Array<Record<string, unknown>>;
      expect(snapshots.length).toBe(1);
      expect(snapshots[0]).toHaveProperty('callId');
    } finally {
      await fs.promises.rm(path.dirname(outPath), { recursive: true, force: true });
    }
  });

  test('timeline command returns merged JSON entries', async () => {
    const result = await execCli(['timeline', fixture.traces.failedLatest.tracePath]);

    expect(result.exitCode).toBe(0);

    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload.schemaVersion).toBe(2);
    expect(payload.command).toBe('timeline');
    const entries = payload.entries as Array<{ type: string }>;
    expect(entries.some(entry => entry.type === 'step')).toBe(true);
    expect(entries.some(entry => entry.type === 'network')).toBe(true);
    expect(entries.some(entry => entry.type === 'dom')).toBe(true);
    expect(entries.some(entry => entry.type === 'screenshot')).toBe(true);
  });

  test('screenshots command extracts images and returns metadata', async () => {
    const outDir = path.join(os.tmpdir(), 'pw-traces-reader-cli-shots', Date.now().toString());

    try {
      const result = await execCli([
        'screenshots',
        fixture.traces.failedLatest.tracePath,
        '--out-dir',
        outDir,
      ]);

      expect(result.exitCode).toBe(0);

      const payload = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(payload.schemaVersion).toBe(2);
      expect(payload.command).toBe('screenshots');
      const screenshots = payload.screenshots as Array<{ savedPath: string }>;
      expect(screenshots.length).toBeGreaterThan(0);
      expect(fs.existsSync(screenshots[0]!.savedPath)).toBe(true);
    } finally {
      await fs.promises.rm(outDir, { recursive: true, force: true });
    }
  });

  test('init-skills returns JSON by default and scaffolds the skill into the target repository', async () => {
    const tmpDir = path.join(os.tmpdir(), 'pw-traces-reader-cli-skill', Date.now().toString());

    try {
      const result = await execCli(['init-skills', tmpDir]);

      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(payload.schemaVersion).toBe(2);
      expect(payload.command).toBe('init-skills');
      expect(payload.skillPath).toBe(path.join(tmpDir, '.github', 'skills', 'analyze-playwright-traces', 'SKILL.md'));
      expect(fs.existsSync(path.join(tmpDir, '.github', 'skills', 'analyze-playwright-traces', 'SKILL.md'))).toBe(true);
    } finally {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  });
});