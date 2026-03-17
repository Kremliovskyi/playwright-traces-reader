import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import AdmZip from 'adm-zip';

export interface TraceContext {
  traceDir: string;
}

/**
 * Ensures the trace is available as a directory.
 * If a .zip file is provided, it extracts it to a temporary directory.
 */
export async function prepareTraceDir(tracePath: string): Promise<TraceContext> {
  const stat = await fs.promises.stat(tracePath);
  if (stat.isDirectory()) {
    return { traceDir: tracePath };
  }
  
  if (tracePath.endsWith('.zip')) {
    const outDir = tracePath.replace(/\.zip$/, '');
    if (!fs.existsSync(outDir)) {
      const zip = new AdmZip(tracePath);
      zip.extractAllTo(outDir, true);
    }
    return { traceDir: outDir };
  }

  throw new Error(`Invalid trace path: ${tracePath}. Must be a directory or .zip file.`);
}

/**
 * Reads a Newline Delimited JSON (NDJSON) file line by line and yields parsed objects.
 */
export async function* readNdjson<T = any>(filePath: string): AsyncGenerator<T> {
  if (!fs.existsSync(filePath)) {
    return;
  }
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  for await (const line of rl) {
    if (line.trim()) {
      try {
        yield JSON.parse(line) as T;
      } catch (e) {
        // Ignore malformed lines
      }
    }
  }
}

/**
 * Returns raw file buffer from the resources/ directory of a trace
 */
export async function getResourceBuffer(traceContext: TraceContext, sha1: string): Promise<Buffer | null> {
  const resourcePath = path.join(traceContext.traceDir, 'resources', sha1);
  if (fs.existsSync(resourcePath)) {
    return fs.promises.readFile(resourcePath);
  }
  return null;
}

/**
 * Discovers all individual test traces inside a Playwright report data directory.
 *
 * A report's `data/` directory can contain many SHA1-named entries — one per test
 * execution. Each entry is either a directory or a `.zip` archive. Non-trace files
 * (`.md`, `.png`, `.json`, etc.) are ignored.
 *
 * Returns a `TraceContext` for every trace found, with `.zip` archives extracted
 * in-place (same directory, no suffix).
 *
 * @param reportDataDir  Path to the `playwright-report/data/` directory.
 */
export async function listTraces(reportDataDir: string): Promise<TraceContext[]> {
  const entries = await fs.promises.readdir(reportDataDir, { withFileTypes: true });

  const tracePaths: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(reportDataDir, entry.name);

    // Resolve symlinks so we can reliably check if it's a directory
    const isDir = entry.isDirectory() ||
      (entry.isSymbolicLink() && (await fs.promises.stat(fullPath)).isDirectory());

    if (isDir) {
      // A directory is a trace if it contains a test.trace file
      const testTracePath = path.join(fullPath, 'test.trace');
      if (fs.existsSync(testTracePath)) {
        tracePaths.push(fullPath);
      }
    } else if (entry.isFile() && entry.name.endsWith('.zip')) {
      const extractedDir = fullPath.replace(/\.zip$/, '');
      // Only include if the extracted form is not already represented as a directory entry
      if (!fs.existsSync(extractedDir)) {
        tracePaths.push(fullPath);
      }
      // If the directory already exists (previously extracted), it was already added above
    }
  }

  return Promise.all(tracePaths.map(p => prepareTraceDir(p)));
}

