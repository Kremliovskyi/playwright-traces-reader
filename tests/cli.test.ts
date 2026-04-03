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
    const result = await execCli(['failures', fixture.rootDir, '--format', 'json']);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');

    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload.schemaVersion).toBe(1);
    expect(payload.command).toBe('failures');
    expect(payload.count).toBe(2);
    const failures = payload.failures as Array<Record<string, unknown>>;
    expect(failures.some(entry => entry.outcome === 'unexpected')).toBe(true);
    expect(failures.some(entry => entry.outcome === 'skipped')).toBe(true);
    expect(failures.some(entry => entry.title === fixture.traces.failedLatest.rootTitle)).toBe(true);
  });

  test('failures command respects exclude-skipped', async () => {
    const result = await execCli(['failures', fixture.rootDir, '--exclude-skipped', '--format', 'json']);

    expect(result.exitCode).toBe(0);

    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload.schemaVersion).toBe(1);
    expect(payload.command).toBe('failures');
    expect(payload.count).toBe(1);
    const failures = payload.failures as Array<{ outcome: string | null; title: string }>;
    expect(failures.every(entry => entry.outcome !== 'skipped')).toBe(true);
    expect(failures[0]!.title).toBe(fixture.traces.failedLatest.rootTitle);
  });

  test('summary command returns a failed trace summary as JSON', async () => {
    const result = await execCli([
      'summary',
      fixture.traces.failedLatest.tracePath,
      '--report',
      fixture.rootDir,
      '--format',
      'json',
    ]);

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
  });

  test('summary command works for a passed trace', async () => {
    const result = await execCli([
      'summary',
      fixture.traces.passed.tracePath,
      '--report',
      fixture.rootDir,
      '--format',
      'json',
    ]);

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
    const result = await execCli([
      'slow-steps',
      fixture.traces.failedLatest.tracePath,
      '--report',
      fixture.rootDir,
      '--limit',
      '1',
      '--format',
      'json',
    ]);

    expect(result.exitCode).toBe(0);

    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload.schemaVersion).toBe(1);
    expect(payload.command).toBe('slow-steps');
    expect(payload.count).toBe(1);
    const steps = payload.steps as Array<Record<string, unknown>>;
    expect(steps[0]).toHaveProperty('title');
  });

  test('steps command prints a text tree', async () => {
    const result = await execCli(['steps', fixture.traces.failedLatest.tracePath]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(fixture.traces.failedLatest.rootTitle);
    expect(result.stdout).toContain('Verify failure state');
  });

  test('network command filters by source in JSON mode', async () => {
    const result = await execCli(['network', fixture.traces.failedLatest.tracePath, '--source', 'api', '--format', 'json']);

    expect(result.exitCode).toBe(0);

    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload.schemaVersion).toBe(1);
    expect(payload.command).toBe('network');
    const entries = payload.entries as Array<{ source: string; responseBody: string | null }>;
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every(entry => entry.source === 'api')).toBe(true);
    expect(entries[0]!.responseBody).toContain('trace-fail-latest');
  });

  test('dom command returns filtered JSON snapshots', async () => {
    const result = await execCli([
      'dom',
      fixture.traces.failedLatest.tracePath,
      '--near',
      'last',
      '--limit',
      '2',
      '--format',
      'json',
    ]);

    expect(result.exitCode).toBe(0);

    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload.schemaVersion).toBe(1);
    expect(payload.command).toBe('dom');
    const snapshots = payload.snapshots as Array<Record<string, unknown>>;
    expect(snapshots.length).toBe(1);
    expect(snapshots[0]).toHaveProperty('callId');
  });

  test('timeline command returns merged JSON entries', async () => {
    const result = await execCli(['timeline', fixture.traces.failedLatest.tracePath, '--format', 'json']);

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
        '--format',
        'json',
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

  test('init-skills scaffolds the skill into the target repository', async () => {
    const tmpDir = path.join(os.tmpdir(), 'pw-traces-reader-cli-skill', Date.now().toString());

    try {
      const result = await execCli(['init-skills', tmpDir]);

      expect(result.exitCode).toBe(0);
      expect(fs.existsSync(path.join(tmpDir, '.github', 'skills', 'analyze-playwright-traces', 'SKILL.md'))).toBe(true);
    } finally {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  });
});