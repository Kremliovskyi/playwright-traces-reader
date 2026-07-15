import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { runCli } from '../src/cli';

interface CapturedRequest {
  pathname: string;
  searchParams: Record<string, string>;
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

describe('report hub CLI contracts', () => {
  const requests: CapturedRequest[] = [];
  const descriptor = {
    reportRef: 'archive:uat-eu',
    id: 'uat-eu',
    name: 'UAT EU',
    metadata: 'compatibility fixture',
    createdAt: '2026-07-15T10:00:00.000Z',
    scope: 'archive',
    dashboardPath: '/reports/uat-eu',
    reportRootPath: '/reports/uat-eu/playwright-report',
    reportDataPath: '/reports/uat-eu/playwright-report/data',
    reportIndexPath: '/reports/uat-eu/playwright-report/index.html',
    analysisFile: 'uat-eu.md',
    exists: { reportRoot: true, dataDir: true, indexHtml: true },
  } as const;
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      requests.push({ pathname: url.pathname, searchParams: Object.fromEntries(url.searchParams) });

      if (url.pathname === '/api/agent/reports/search') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ schemaVersion: 1, command: 'search-reports', totalCount: 1, reports: [descriptor] }));
        return;
      }
      if (url.pathname === '/api/agent/reports/prepare') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
          schemaVersion: 1,
          command: 'prepare-report-analysis',
          mode: 'local',
          report: descriptor,
          analysisTarget: {
            reportRootPath: descriptor.reportRootPath,
            reportDataPath: descriptor.reportDataPath,
          },
        }));
        return;
      }
      if (url.pathname === '/api/agent/vault/uat-eu.md') {
        response.setHeader('content-type', 'text/markdown');
        response.end('# UAT EU analysis\n\nDeterministic marker.\n');
        return;
      }
      if (url.pathname.startsWith('/api/agent/vault/')) {
        response.statusCode = 404;
        response.end('not found');
        return;
      }

      response.statusCode = 404;
      response.end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Could not determine test hub address.');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  beforeEach(() => requests.splice(0));

  test('search-reports encodes all filters and emits the CLI envelope', async () => {
    const result = await execCli([
      'search-reports',
      'UAT EU + smoke',
      '--scope', 'archive',
      '--range-start', '2026-07-01',
      '--range-end', '2026-07-15',
      '--selected-dates', '2026-07-02, 2026-07-09',
      '--limit', '3',
      '--base-url', `${baseUrl}/`,
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 2,
      command: 'search-reports',
      totalCount: 1,
      reports: [{ reportRef: descriptor.reportRef }],
    });
    expect(requests).toEqual([{
      pathname: '/api/agent/reports/search',
      searchParams: {
        query: 'UAT EU + smoke',
        scope: 'archive',
        rangeStart: '2026-07-01',
        rangeEnd: '2026-07-15',
        selectedDates: '2026-07-02,2026-07-09',
        limit: '3',
      },
    }]);
  });

  test('prepare-report resolves a report reference into local paths', async () => {
    const result = await execCli(['prepare-report', descriptor.reportRef, '--base-url', baseUrl]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 2,
      command: 'prepare-report',
      mode: 'local',
      reportRootPath: descriptor.reportRootPath,
      reportDataPath: descriptor.reportDataPath,
    });
    expect(requests[0]).toEqual({
      pathname: '/api/agent/reports/prepare',
      searchParams: { reportRef: descriptor.reportRef },
    });
  });

  test('vault-read supports JSON output and writing markdown to disk', async () => {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pwtr-vault-'));
    const outputPath = path.join(tempDir, 'analysis.md');

    try {
      const result = await execCli([
        'vault-read', 'uat-eu.md', '--format', 'json', '--out', outputPath, '--base-url', baseUrl,
      ]);

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        schemaVersion: 2,
        command: 'vault-read',
        filename: 'uat-eu.md',
        savedPath: outputPath,
      });
      expect(await fs.promises.readFile(outputPath, 'utf8')).toContain('Deterministic marker.');
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('vault-read reports missing files', async () => {
    const result = await execCli(['vault-read', 'missing.md', '--base-url', baseUrl]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Vault file "missing.md" was not found');
  });

  test('hub commands report an unreachable server directly', async () => {
    const result = await execCli(['search-reports', 'smoke', '--base-url', 'http://127.0.0.1:1']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Report search is not available because the report hub is not reachable');
  });
});