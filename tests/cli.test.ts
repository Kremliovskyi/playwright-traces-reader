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

  test('failures command returns deduplicated report-level JSON summaries', async () => {
    const result = await execCli(['failures', fixture.rootDir]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');

    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload.schemaVersion).toBe(1);
    expect(payload.command).toBe('failures');
    expect(payload.count).toBe(3);
    const failures = payload.failures as Array<Record<string, unknown>>;
    expect(failures.some(entry => entry.outcome === 'unexpected')).toBe(true);
    expect(failures.some(entry => entry.outcome === 'skipped')).toBe(true);
    expect(failures.some(entry => entry.title === fixture.traces.failedLatest.rootTitle)).toBe(true);
    expect(failures.some(entry => entry.title === fixture.traces.failedPeer.rootTitle)).toBe(true);
    expect(failures[0]).toHaveProperty('tracePath');
    expect(failures[0]).toHaveProperty('traceSha1');
    expect(failures[0]).toHaveProperty('issueCount');
    expect(failures[0]).toHaveProperty('primaryRelatedAction');
    expect(failures[0]).not.toHaveProperty('topLevelSteps');
    const patterns = payload.patterns as { repeatedFailingRequests: Array<{ signature: string; count: number }>; repeatedIssues: Array<{ source: string; count: number }> };
    expect(patterns.repeatedFailingRequests.some(pattern => pattern.signature === 'POST /:id/api-call' && pattern.count === 2)).toBe(true);
    expect(patterns.repeatedIssues.some(pattern => pattern.source === 'page' && pattern.count === 2)).toBe(true);
  });

  test('failures command respects exclude-skipped', async () => {
    const result = await execCli(['failures', fixture.rootDir, '--exclude-skipped']);

    expect(result.exitCode).toBe(0);

    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload.schemaVersion).toBe(1);
    expect(payload.command).toBe('failures');
    expect(payload.count).toBe(2);
    const failures = payload.failures as Array<{ outcome: string | null; title: string }>;
    expect(failures.every(entry => entry.outcome !== 'skipped')).toBe(true);
    expect(failures.some(entry => entry.title === fixture.traces.failedLatest.rootTitle)).toBe(true);
    expect(failures.some(entry => entry.title === fixture.traces.failedPeer.rootTitle)).toBe(true);
  });

  test('failures output can be chained into summary using tracePath', async () => {
    const failuresResult = await execCli(['failures', fixture.rootDir, '--exclude-skipped']);

    expect(failuresResult.exitCode).toBe(0);

    const failuresPayload = JSON.parse(failuresResult.stdout) as {
      failures: Array<{ tracePath: string; traceSha1: string; title: string }>;
    };
    const selectedFailure = failuresPayload.failures[0]!;

    expect(selectedFailure.traceSha1).toBe(fixture.traces.failedLatest.sha1);

    const summaryResult = await execCli(['summary', selectedFailure.tracePath, '--report', fixture.rootDir]);

    expect(summaryResult.exitCode).toBe(0);

    const summaryPayload = JSON.parse(summaryResult.stdout) as { summary: { title: string; status: string } };
    expect(summaryPayload.summary.title).toBe(selectedFailure.title);
    expect(summaryPayload.summary.status).toBe('failed');
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

  test('dom command returns filtered JSON snapshots', async () => {
    const result = await execCli(['dom', fixture.traces.failedLatest.tracePath, '--near', 'last', '--limit', '2']);

    expect(result.exitCode).toBe(0);

    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload.schemaVersion).toBe(1);
    expect(payload.command).toBe('dom');
    const snapshots = payload.snapshots as Array<Record<string, unknown>>;
    expect(snapshots.length).toBe(1);
    expect(snapshots[0]).toHaveProperty('callId');
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