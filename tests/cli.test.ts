import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runCli } from '../src/cli';
import {
  cleanupSyntheticReportFixture,
  createSyntheticReportFixture,
  type SyntheticReportFixture,
} from './syntheticReport';

jest.setTimeout(20000);

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
      expect(payload.schemaVersion).toBe(1);
      expect(payload.command).toBe('failures');
      expect(payload).not.toHaveProperty('patterns');
      // earlier retry, latest retry, peer failure, skipped = 4 attempts.
      expect(payload.count).toBe(4);
      expect(payload.failures).toHaveLength(4);

      // Manifest is mirrored to runDir/index.json.
      const indexJson = JSON.parse(
        await fs.promises.readFile(path.join(payload.runDir, 'index.json'), 'utf-8'),
      ) as { count: number; failures: Array<{ folder: string }> };
      expect(indexJson.count).toBe(4);

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
      ) as { files: { errorMarkdown: string | null; networkErrors: string | null } };
      expect(latest.networkErrorCount).toBe(2);
      expect(fs.existsSync(path.join(latestDir, 'network-errors.json'))).toBe(true);
      expect(latestJson.files.errorMarkdown).toBe('error.md');
      expect(fs.existsSync(path.join(latestDir, 'error.md'))).toBe(true);
      expect(Number(latest.screenshotCount)).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(latestDir, 'screenshots'))).toBe(true);
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
      expect(payload.count).toBe(3);
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

  test('summary command returns a failed trace summary as JSON', async () => {
    const result = await execCli(['summary', fixture.traces.failedLatest.tracePath, '--report', fixture.rootDir]);

    expect(result.exitCode).toBe(0);

    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload.schemaVersion).toBe(1);
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
    expect(payload.schemaVersion).toBe(1);
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
    expect(payload.schemaVersion).toBe(1);
    expect(payload.command).toBe('slow-steps');
    expect(payload.count).toBe(1);
    const steps = payload.steps as Array<Record<string, unknown>>;
    expect(steps[0]).toHaveProperty('title');
  });

  test('steps command returns JSON by default', async () => {
    const result = await execCli(['steps', fixture.traces.failedLatest.tracePath]);

    expect(result.exitCode).toBe(0);

    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload.schemaVersion).toBe(1);
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
    expect(payload.schemaVersion).toBe(1);
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
    expect(payload.schemaVersion).toBe(1);
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
    expect(payload.schemaVersion).toBe(1);
    expect(payload.command).toBe('console');
    const entries = payload.entries as Array<{ level: string; source: string }>;
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every(entry => entry.level === 'error')).toBe(true);
  });

  test('errors command returns step, page, and trace issues', async () => {
    const result = await execCli(['errors', fixture.traces.failedLatest.tracePath]);

    expect(result.exitCode).toBe(0);

    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload.schemaVersion).toBe(1);
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
    expect(payload.schemaVersion).toBe(1);
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
      expect(payload.schemaVersion).toBe(1);
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
      expect(confirmation.schemaVersion).toBe(1);
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
    expect(payload.schemaVersion).toBe(1);
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
      expect(payload.schemaVersion).toBe(1);
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
      expect(payload.schemaVersion).toBe(1);
      expect(payload.command).toBe('init-skills');
      expect(payload.skillPath).toBe(path.join(tmpDir, '.github', 'skills', 'analyze-playwright-traces', 'SKILL.md'));
      expect(fs.existsSync(path.join(tmpDir, '.github', 'skills', 'analyze-playwright-traces', 'SKILL.md'))).toBe(true);
    } finally {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  });
});