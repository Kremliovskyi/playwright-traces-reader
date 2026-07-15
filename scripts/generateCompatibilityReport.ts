import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import AdmZip from 'adm-zip';

interface Arguments {
  playwrightVersion: string;
  outputRoot: string;
  archivePath: string | null;
  installBrowser: boolean;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function parseArguments(argv: string[]): Arguments {
  let playwrightVersion = '';
  let outputRoot = '';
  let archivePath: string | null = null;
  let installBrowser = true;

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--playwright-version')
      playwrightVersion = argv[++index] ?? '';
    else if (argument === '--output')
      outputRoot = argv[++index] ?? '';
    else if (argument === '--archive')
      archivePath = path.resolve(argv[++index] ?? '');
    else if (argument === '--skip-browser-install')
      installBrowser = false;
    else
      throw new Error(`Unknown argument: ${argument}`);
  }

  if (!playwrightVersion)
    throw new Error('--playwright-version is required.');
  if (!outputRoot)
    throw new Error('--output is required.');
  return {
    playwrightVersion,
    outputRoot: path.resolve(outputRoot),
    archivePath,
    installBrowser,
  };
}

async function run(command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => {
      const text = chunk.toString();
      stdout += text;
      process.stderr.write(text);
    });
    child.stderr.on('data', chunk => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });
    child.on('error', reject);
    child.on('close', exitCode => resolve({ exitCode: exitCode ?? 1, stdout, stderr }));
  });
}

function collectStatuses(report: unknown): Map<string, string[]> {
  const statuses = new Map<string, string[]>();
  const visitSuite = (suite: Record<string, unknown>): void => {
    const specs = Array.isArray(suite.specs) ? suite.specs : [];
    for (const specValue of specs) {
      const spec = specValue as Record<string, unknown>;
      const title = String(spec.title ?? '');
      const tests = Array.isArray(spec.tests) ? spec.tests : [];
      const resultStatuses: string[] = [];
      for (const testValue of tests) {
        const test = testValue as Record<string, unknown>;
        const results = Array.isArray(test.results) ? test.results : [];
        for (const resultValue of results) {
          const result = resultValue as Record<string, unknown>;
          if (typeof result.status === 'string')
            resultStatuses.push(result.status);
        }
      }
      statuses.set(title, resultStatuses);
    }
    const suites = Array.isArray(suite.suites) ? suite.suites : [];
    for (const child of suites)
      visitSuite(child as Record<string, unknown>);
  };

  const root = report as Record<string, unknown>;
  for (const suite of Array.isArray(root.suites) ? root.suites : [])
    visitSuite(suite as Record<string, unknown>);
  return statuses;
}

function verifyOutcomes(report: unknown): void {
  const statuses = collectStatuses(report);
  const expected = new Map<string, string[]>([
    ['PWTR rich passing trace', ['passed']],
    ['PWTR deterministic failure', ['failed', 'failed']],
    ['PWTR deterministic flaky', ['failed', 'passed']],
    ['PWTR API-only trace', ['passed']],
  ]);

  for (const [title, expectedStatuses] of expected) {
    const actual = statuses.get(title);
    if (JSON.stringify(actual) !== JSON.stringify(expectedStatuses))
      throw new Error(`Unexpected results for ${title}: expected ${JSON.stringify(expectedStatuses)}, received ${JSON.stringify(actual)}.`);
  }
}

function sha256(value: Buffer | string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function fileChecksums(rootDir: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const visit = async (directory: string): Promise<void> => {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory())
        await visit(absolutePath);
      else if (entry.isFile())
        result[path.relative(rootDir, absolutePath).split(path.sep).join('/')] = sha256(await fs.promises.readFile(absolutePath));
    }
  };
  await visit(rootDir);
  return result;
}

async function parserInputChecksums(reportDir: string): Promise<Record<string, string>> {
  const checksums: Record<string, string> = {
    'index.html': sha256(await fs.promises.readFile(path.join(reportDir, 'index.html'))),
  };
  const dataChecksums = await fileChecksums(path.join(reportDir, 'data'));
  for (const [file, checksum] of Object.entries(dataChecksums))
    checksums[`data/${file}`] = checksum;
  return checksums;
}

async function producerRevision(producerDir: string): Promise<string> {
  const files = (await fs.promises.readdir(producerDir)).sort();
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(file);
    hash.update(await fs.promises.readFile(path.join(producerDir, file)));
  }
  return hash.digest('hex');
}

function traceMetadata(reportDir: string): { traceVersions: number[]; playwrightVersions: string[] } {
  const dataDir = path.join(reportDir, 'data');
  const traceVersions = new Set<number>();
  const playwrightVersions = new Set<string>();
  for (const file of fs.readdirSync(dataDir).filter(name => name.endsWith('.zip')).sort()) {
    const zip = new AdmZip(path.join(dataDir, file));
    for (const entry of zip.getEntries().filter(candidate => candidate.entryName.endsWith('.trace'))) {
      for (const line of entry.getData().toString('utf8').split('\n')) {
        if (!line)
          continue;
        const event = JSON.parse(line) as { type?: string; version?: number; playwrightVersion?: string };
        if (event.type !== 'context-options')
          continue;
        if (typeof event.version === 'number')
          traceVersions.add(event.version);
        if (typeof event.playwrightVersion === 'string')
          playwrightVersions.add(event.playwrightVersion);
      }
    }
  }
  return {
    traceVersions: [...traceVersions].sort((left, right) => left - right),
    playwrightVersions: [...playwrightVersions].sort(),
  };
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const repositoryRoot = path.resolve(__dirname, '..');
  const producerDir = path.join(repositoryRoot, 'tests', 'compatibility', 'producer');
  const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pwtr-producer-'));

  try {
    await fs.promises.rm(args.outputRoot, { recursive: true, force: true });
    await fs.promises.mkdir(args.outputRoot, { recursive: true });
    await fs.promises.cp(producerDir, workDir, { recursive: true });
    await fs.promises.writeFile(path.join(workDir, 'package.json'), `${JSON.stringify({
      private: true,
      dependencies: { '@playwright/test': args.playwrightVersion },
    }, null, 2)}\n`);

    const install = await run('npm', ['install', '--no-package-lock', '--no-audit', '--no-fund'], workDir);
    if (install.exitCode !== 0)
      throw new Error(`Could not install @playwright/test@${args.playwrightVersion}.`);

    if (args.installBrowser) {
      const browserInstall = await run('npx', ['playwright', 'install', '--with-deps', 'chromium'], workDir);
      if (browserInstall.exitCode !== 0)
        throw new Error('Could not install the compatibility Chromium browser.');
    }

    const testRun = await run(
      'npx',
      ['playwright', 'test', '--config', path.join(workDir, 'playwright.config.cjs')],
      workDir,
      { PWTR_COMPAT_OUTPUT: args.outputRoot },
    );
    const resultsPath = path.join(args.outputRoot, 'results.json');
    if (!fs.existsSync(resultsPath))
      throw new Error(`Playwright did not create ${resultsPath}.`);
    const results = JSON.parse(await fs.promises.readFile(resultsPath, 'utf8')) as unknown;
    verifyOutcomes(results);
    if (testRun.exitCode !== 1)
      throw new Error(`Expected the controlled failing suite to exit with 1, received ${testRun.exitCode}.`);

    const installedPackage = JSON.parse(await fs.promises.readFile(path.join(workDir, 'node_modules', '@playwright', 'test', 'package.json'), 'utf8')) as { version: string };
    const reportDir = path.join(args.outputRoot, 'playwright-report');
    const provenance = {
      schemaVersion: 1,
      requestedPlaywrightVersion: args.playwrightVersion,
      resolvedPlaywrightVersion: installedPackage.version,
      ...traceMetadata(reportDir),
      producerRevision: await producerRevision(producerDir),
      scenarios: {
        passed: 'PWTR rich passing trace',
        failed: 'PWTR deterministic failure',
        flaky: 'PWTR deterministic flaky',
        apiOnly: 'PWTR API-only trace',
      },
      reportChecksums: await parserInputChecksums(reportDir),
    };
    const provenancePath = path.join(args.outputRoot, 'provenance.json');
    await fs.promises.writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);

    if (args.archivePath) {
      await fs.promises.mkdir(path.dirname(args.archivePath), { recursive: true });
      const archive = new AdmZip();
      archive.addLocalFile(path.join(reportDir, 'index.html'));
      archive.addLocalFolder(path.join(reportDir, 'data'), 'data');
      archive.addLocalFile(provenancePath);
      archive.writeZip(args.archivePath);
    }

    process.stdout.write(`${JSON.stringify({
      reportDir,
      resultsPath,
      provenancePath,
      archivePath: args.archivePath,
      resolvedPlaywrightVersion: installedPackage.version,
      traceVersions: provenance.traceVersions,
    }, null, 2)}\n`);
  } finally {
    if (!process.env.PWTR_KEEP_PRODUCER)
      await fs.promises.rm(workDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});