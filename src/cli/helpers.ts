import * as fs from 'fs';
import * as path from 'path';
import { InvalidArgumentError } from 'commander';
import { getReportMetadata, type TraceContext } from '../index';

export interface HubReportDescriptor {
  reportRef: string;
  id: string;
  name: string;
  metadata: string;
  createdAt: string;
  scope: 'current' | 'archive';
  dashboardPath: string;
  reportRootPath: string | null;
  reportDataPath: string | null;
  reportIndexPath: string | null;
  analysisFile: string | null;
  exists: {
    reportRoot: boolean;
    dataDir: boolean;
    indexHtml: boolean;
  };
}

export interface SearchReportsHubResponse {
  schemaVersion: number;
  command: 'search-reports';
  totalCount: number;
  reports: HubReportDescriptor[];
}

export interface PrepareReportHubResponse {
  schemaVersion: number;
  command: 'prepare-report-analysis';
  mode: string;
  report: HubReportDescriptor;
  analysisTarget: {
    reportRootPath: string | null;
    reportDataPath: string | null;
  };
}

export interface SearchReportsHubOptions {
  baseUrl: string;
  query?: string;
  latest?: boolean;
  scope?: 'current' | 'archive';
  rangeStart?: string;
  rangeEnd?: string;
  selectedDates?: string[];
  limit?: number;
}

export const DEFAULT_REPORTS_HUB_BASE_URL = process.env.PLAYWRIGHT_REPORTS_BASE_URL || 'http://127.0.0.1:9333';

class ReportHubUnavailableError extends Error {
  constructor(
    public readonly capability: 'search' | 'prepare' | 'vault-read',
    public readonly baseUrl: string,
  ) {
    const actionMap: Record<string, string> = {
      'search': 'Report search',
      'prepare': 'Report preparation',
      'vault-read': 'Vault file reading',
    };
    const action = actionMap[capability];
    super(`${action} is not available because the report hub is not reachable at ${baseUrl}.`);
    this.name = 'ReportHubUnavailableError';
  }
}

export async function copySkillTemplate(targetDir: string): Promise<string> {
  const skillDir = path.join(targetDir, '.github', 'skills', 'analyze-playwright-traces');
  await fs.promises.mkdir(skillDir, { recursive: true });

  const templatePath = path.resolve(__dirname, '..', '..', 'templates', 'skills', 'analyze-playwright-traces', 'SKILL.md');
  const destPath = path.join(skillDir, 'SKILL.md');

  if (!fs.existsSync(templatePath)) {
    throw new Error(`Template not found at ${templatePath}`);
  }

  await fs.promises.copyFile(templatePath, destPath);
  return destPath;
}

export async function resolveReportDataDir(inputPath: string): Promise<string> {
  const resolvedPath = path.resolve(inputPath);
  const stat = await fs.promises.stat(resolvedPath);
  if (!stat.isDirectory()) {
    throw new Error(`Invalid report path: ${resolvedPath}. Expected a report root or data directory.`);
  }

  const reportIndexPath = path.join(resolvedPath, 'index.html');
  const reportDataDir = path.join(resolvedPath, 'data');
  if (fs.existsSync(reportIndexPath) && fs.existsSync(reportDataDir)) {
    return reportDataDir;
  }

  if (path.basename(resolvedPath) === 'data') {
    return resolvedPath;
  }

  throw new Error(`Could not resolve a Playwright report data directory from ${resolvedPath}.`);
}

export async function loadReportMetadataForTrace(
  traceContext: TraceContext,
  explicitReportPath?: string,
) {
  if (explicitReportPath) {
    return getReportMetadata(path.resolve(explicitReportPath));
  }

  return getReportMetadata(path.dirname(traceContext.traceDir));
}

export function parsePositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError(`Invalid positive integer: ${value}`);
  }
  return parsed;
}

export async function requestHubJson<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;

  try {
    response = await fetch(url, init);
  } catch (error) {
    throw error;
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof (data as { error?: unknown }).error === 'string'
      ? (data as { error: string }).error
      : `Hub request failed with status ${response.status}`;
    throw new Error(message);
  }
  return data as T;
}

export function normalizeHubBaseUrl(baseUrl?: string): string {
  return (baseUrl || DEFAULT_REPORTS_HUB_BASE_URL).replace(/\/$/, '');
}

export async function searchReportsViaHub(options: SearchReportsHubOptions): Promise<SearchReportsHubResponse> {
  const params = new URLSearchParams();

  if (options.query) params.set('query', options.query);
  if (options.latest) params.set('latest', 'true');
  if (options.scope) params.set('scope', options.scope);
  if (options.rangeStart) params.set('rangeStart', options.rangeStart);
  if (options.rangeEnd) params.set('rangeEnd', options.rangeEnd);
  if (options.selectedDates && options.selectedDates.length > 0) {
    params.set('selectedDates', options.selectedDates.join(','));
  }
  if (typeof options.limit === 'number') params.set('limit', String(options.limit));

  const baseUrl = normalizeHubBaseUrl(options.baseUrl);
  const url = `${baseUrl}/api/agent/reports/search${params.toString() ? `?${params.toString()}` : ''}`;

  try {
    return await requestHubJson<SearchReportsHubResponse>(url);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new ReportHubUnavailableError('search', baseUrl);
    }
    throw error;
  }
}

export async function prepareReportViaHub(baseUrl: string, reportRef: string): Promise<PrepareReportHubResponse> {
  const normalizedBaseUrl = normalizeHubBaseUrl(baseUrl);
  const url = `${normalizedBaseUrl}/api/agent/reports/prepare?reportRef=${encodeURIComponent(reportRef)}`;

  try {
    return await requestHubJson<PrepareReportHubResponse>(url);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new ReportHubUnavailableError('prepare', normalizedBaseUrl);
    }
    throw error;
  }
}

export async function readVaultViaHub(baseUrl: string, filename: string): Promise<string> {
  const normalizedBaseUrl = normalizeHubBaseUrl(baseUrl);
  const url = `${normalizedBaseUrl}/api/agent/vault/${encodeURIComponent(filename)}`;

  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new ReportHubUnavailableError('vault-read', normalizedBaseUrl);
    }
    throw error;
  }

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`Vault file "${filename}" was not found on the report hub.`);
    }
    throw new Error(`Failed to read vault file: hub returned status ${response.status}`);
  }

  return await response.text();
}