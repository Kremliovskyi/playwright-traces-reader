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

// ---------- Report metadata ----------

/** A single test's summary as stored in the HTML report's `report.json`. */
export interface ReportTestSummary {
  testId: string;
  title: string;
  path: string[];
  projectName: string;
  location: { file: string; line: number; column: number };
  outcome: 'expected' | 'unexpected' | 'flaky' | 'skipped';
  duration: number;
  ok: boolean;
  annotations: Array<{ type: string; description?: string }>;
  tags: string[];
  results: Array<{
    attachments: Array<{ name: string; path?: string; contentType: string }>;
  }>;
}

/** The top-level structure of a Playwright HTML report's `report.json`. */
export interface ReportMetadata {
  stats: { total: number; expected: number; unexpected: number; flaky: number; skipped: number; ok: boolean };
  files: Array<{ fileId: string; fileName: string; tests: ReportTestSummary[] }>;
  projectNames: string[];
  startTime: number;
  duration: number;
}

/**
 * Parses the `report.json` embedded inside a Playwright HTML report.
 *
 * The HTML reporter embeds all test metadata as a base64-encoded ZIP inside a
 * `<template id="playwrightReportBase64">` tag in `index.html`. This function
 * extracts that ZIP and returns the parsed `report.json`.
 *
 * @param reportDir  Path to the report root directory (the folder containing
 *                   `index.html` and `data/`). If a `data/` directory path is
 *                   provided instead, the function looks one level up.
 * @returns Parsed report metadata, or `null` if `index.html` is not found or
 *          does not contain the expected template tag.
 */
export async function getReportMetadata(reportDir: string): Promise<ReportMetadata | null> {
  // Accept both the report root and the data/ subdirectory.
  let htmlPath = path.join(reportDir, 'index.html');
  if (!fs.existsSync(htmlPath)) {
    // Caller may have passed `/path/to/report/data` — try parent.
    const parent = path.dirname(reportDir);
    htmlPath = path.join(parent, 'index.html');
    if (!fs.existsSync(htmlPath)) return null;
  }

  const html = await fs.promises.readFile(htmlPath, 'utf-8');
  const match = html.match(/id="playwrightReportBase64"[^>]*>([^<]+)</);
  if (!match?.[1]) return null;

  const dataUri = match[1].trim();
  const base64 = dataUri.replace(/^data:application\/zip;base64,/, '');
  const buf = Buffer.from(base64, 'base64');
  const zip = new AdmZip(buf);
  const reportEntry = zip.getEntry('report.json');
  if (!reportEntry) return null;

  return JSON.parse(zip.readAsText(reportEntry)) as ReportMetadata;
}

// ---------- Report trace maps ----------

/** Pre-built lookup maps from report metadata, keyed by trace SHA1. */
export interface ReportTraceMaps {
  outcomeByTraceSha1: Map<string, string>;
  testIdByTraceSha1: Map<string, string>;
}

/**
 * Builds SHA1-keyed lookup maps from parsed report metadata.
 *
 * Iterates over all test results and their trace attachments to create
 * two maps:
 * - `outcomeByTraceSha1` — maps a trace's SHA1 to the test's outcome
 * - `testIdByTraceSha1`  — maps a trace's SHA1 to the test's unique ID
 *
 * @param meta  Parsed report metadata from `getReportMetadata()`.
 */
export function buildReportTraceMaps(meta: ReportMetadata): ReportTraceMaps {
  const outcomeByTraceSha1 = new Map<string, string>();
  const testIdByTraceSha1 = new Map<string, string>();
  for (const file of meta.files) {
    for (const t of file.tests) {
      for (const result of t.results) {
        for (const att of result.attachments) {
          if (att.name === 'trace' && att.path) {
            // att.path is like "data/<sha1>.zip"
            const sha1 = path.basename(att.path, '.zip');
            outcomeByTraceSha1.set(sha1, t.outcome);
            testIdByTraceSha1.set(sha1, t.testId);
          }
        }
      }
    }
  }
  return { outcomeByTraceSha1, testIdByTraceSha1 };
}

