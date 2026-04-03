import * as fs from 'fs';
import * as path from 'path';
import { InvalidArgumentError } from 'commander';
import { getReportMetadata, type TraceContext } from '../index';

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