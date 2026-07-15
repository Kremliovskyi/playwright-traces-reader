import * as fs from 'fs';
import * as path from 'path';
import { readNdjson } from './ndjson';
import type { TraceContext } from './parseTrace';

export const MAX_SUPPORTED_TRACE_VERSION = 8;

interface ContextOptionsEvent {
  type: 'context-options';
  version?: number;
  playwrightVersion?: string;
}

export interface TraceFileCompatibility {
  file: string;
  eventCount: number;
  eventTypes: Record<string, number>;
}

export interface TraceCompatibilityReport {
  traceDir: string;
  traceVersion: number | null;
  playwrightVersions: string[];
  files: TraceFileCompatibility[];
  eventTypes: Record<string, number>;
  referencedResources: string[];
  missingResources: string[];
}

export class UnsupportedTraceVersionError extends Error {
  constructor(
    public readonly traceVersion: number,
    public readonly maxSupportedVersion: number,
  ) {
    super(`Trace schema version ${traceVersion} is newer than the maximum supported version ${maxSupportedVersion}. Update playwright-traces-reader before parsing this trace.`);
    this.name = 'UnsupportedTraceVersionError';
  }
}

export class InconsistentTraceVersionError extends Error {
  constructor(public readonly traceVersions: number[]) {
    super(`Trace contains inconsistent schema versions: ${traceVersions.join(', ')}.`);
    this.name = 'InconsistentTraceVersionError';
  }
}

function increment(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function sortedRecord(counts: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
}

function collectResourceReferences(value: unknown, key: string | null, result: Set<string>): void {
  if (typeof value === 'string') {
    if ((key === 'sha1' || key === '_sha1') && value)
      result.add(value);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value)
      collectResourceReferences(item, null, result);
    return;
  }

  if (!value || typeof value !== 'object')
    return;

  for (const [childKey, childValue] of Object.entries(value))
    collectResourceReferences(childValue, childKey, result);
}

function assertVersions(traceVersions: Set<number>): void {
  const versions = [...traceVersions].sort((left, right) => left - right);
  if (versions.length > 1)
    throw new InconsistentTraceVersionError(versions);
  if (versions[0] !== undefined && versions[0] > MAX_SUPPORTED_TRACE_VERSION)
    throw new UnsupportedTraceVersionError(versions[0], MAX_SUPPORTED_TRACE_VERSION);
}

export async function assertSupportedTraceVersion(traceDir: string): Promise<void> {
  const entries = await fs.promises.readdir(traceDir, { withFileTypes: true });
  const traceFiles = entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.trace') && entry.name !== 'test.trace')
    .map(entry => entry.name)
    .sort();
  const traceVersions = new Set<number>();

  for (const traceFile of traceFiles) {
    for await (const event of readNdjson<ContextOptionsEvent>(path.join(traceDir, traceFile))) {
      if (event.type !== 'context-options')
        continue;
      if (typeof event.version === 'number')
        traceVersions.add(event.version);
      break;
    }
  }

  assertVersions(traceVersions);
}

export async function inspectTraceCompatibility(traceContext: TraceContext): Promise<TraceCompatibilityReport> {
  const entries = await fs.promises.readdir(traceContext.traceDir, { withFileTypes: true });
  const eventFiles = entries
    .filter(entry => entry.isFile() && (entry.name.endsWith('.trace') || entry.name.endsWith('.network')))
    .map(entry => entry.name)
    .sort();
  const traceVersions = new Set<number>();
  const playwrightVersions = new Set<string>();
  const referencedResources = new Set<string>();
  const allEventTypes = new Map<string, number>();
  const files: TraceFileCompatibility[] = [];

  for (const eventFile of eventFiles) {
    const eventTypes = new Map<string, number>();
    let eventCount = 0;
    for await (const event of readNdjson<Record<string, unknown>>(path.join(traceContext.traceDir, eventFile))) {
      eventCount += 1;
      const eventType = typeof event.type === 'string' ? event.type : '<missing>';
      increment(eventTypes, eventType);
      increment(allEventTypes, eventType);
      collectResourceReferences(event, null, referencedResources);

      if (event.type === 'context-options') {
        if (typeof event.version === 'number')
          traceVersions.add(event.version);
        if (typeof event.playwrightVersion === 'string')
          playwrightVersions.add(event.playwrightVersion);
      }
    }
    files.push({ file: eventFile, eventCount, eventTypes: sortedRecord(eventTypes) });
  }

  assertVersions(traceVersions);

  const resourcesDir = path.join(traceContext.traceDir, 'resources');
  const resourceNames = fs.existsSync(resourcesDir)
    ? new Set(await fs.promises.readdir(resourcesDir))
    : new Set<string>();
  const references = [...referencedResources].sort();
  const missingResources = references.filter(reference => {
    if (resourceNames.has(reference))
      return false;
    if (reference.endsWith('.bin') && resourceNames.has(reference.slice(0, -4)))
      return false;
    return true;
  });
  const versions = [...traceVersions];

  return {
    traceDir: traceContext.traceDir,
    traceVersion: versions[0] ?? null,
    playwrightVersions: [...playwrightVersions].sort(),
    files,
    eventTypes: sortedRecord(allEventTypes),
    referencedResources: references,
    missingResources,
  };
}