import type {
  ActionDomSnapshots,
  ActionDiagnosticSummary,
  AttachmentEntry,
  ConsoleEntry,
  FoundTrace,
  NetworkEntry,
  SavedAttachment,
  Screenshot,
  TestStep,
  TraceIssue,
  TimelineEntry,
  TraceSummary,
} from '../index';
import type { FailuresCommandJson } from './json';
import type { DigestCommandJson } from './json';
import type { HubReportDescriptor } from './helpers';

export type OutputFormat = 'text' | 'json';

export function emitOutput(io: { stdout: (text: string) => void }, format: OutputFormat, data: unknown, text: string): void {
  if (format === 'json') {
    io.stdout(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }

  io.stdout(`${text}\n`);
}

export function formatInitSkillsText(skillPath: string): string {
  return `Skill scaffolded at ${skillPath}`;
}

export function formatSearchReportsText(reports: HubReportDescriptor[]): string {
  if (reports.length === 0) return 'No reports matched the search.';

  return reports.map((report, index) => {
    const analysisTag = report.analysisFile ? ' [analysis]' : '';
    return [
      `${index + 1}. ${report.createdAt} [${report.scope}]${analysisTag} ${report.id}`,
      `   Metadata: ${report.metadata || '-'}`,
      `   Report ref: ${report.reportRef}`,
      `   Report root: ${report.reportRootPath || '-'}`,
      `   Data dir: ${report.reportDataPath || '-'}`,
    ].join('\n');
  }).join('\n\n');
}

export function formatPrepareReportText(report: HubReportDescriptor, mode: string): string {
  return [
    `Prepared ${report.id} [${report.scope}]`,
    `Mode: ${mode}`,
    `Report ref: ${report.reportRef}`,
    `Report root: ${report.reportRootPath || '-'}`,
    `Data dir: ${report.reportDataPath || '-'}`,
  ].join('\n');
}

export function formatVaultReadText(content: string): string {
  return content;
}

export function formatVaultReadSavedText(filename: string, savedPath: string): string {
  return `Vault file "${filename}" saved to ${savedPath}`;
}

export function formatFailuresText(manifest: FailuresCommandJson): string {
  if (manifest.count === 0) return 'No failing tests found.';

  const header = [
    `Wrote ${manifest.count} failure folder(s) to ${manifest.runDir}`,
    `Manifest: ${manifest.runDir}/index.json`,
  ].join('\n');

  const failureText = manifest.failures.map((failure, index) => {
    const title = failure.testTitle ?? failure.title;

    return [
      `${index + 1}. [${failure.outcome ?? failure.status}] ${title} (retry ${failure.retryIndex})`,
      `   Folder: ${failure.folder}`,
      `   Trace SHA1: ${failure.traceSha1}`,
      `   Screenshots: ${failure.screenshotCount} | DOM: ${failure.domCount} | Network errors: ${failure.networkErrorCount} | Console errors: ${failure.consoleErrorCount}`,
    ].join('\n');
  }).join('\n\n');

  return `${header}\n\n${failureText}`;
}

export function formatDigestText(manifest: DigestCommandJson): string {
  const title = manifest.testTitle ?? manifest.title;
  return [
    `Wrote digest for [${manifest.outcome ?? manifest.status}] ${title} (retry ${manifest.retryIndex})`,
    `Folder: ${manifest.runDir}/${manifest.folder}`,
    `Digest: ${manifest.runDir}/${manifest.folder}/digest.json`,
    `Trace SHA1: ${manifest.traceSha1}`,
    `DOM: ${manifest.domCount} | Screenshots: ${manifest.screenshotCount} | Network: ${manifest.networkCallCount} | Console: ${manifest.consoleEntryCount}`,
  ].join('\n');
}

export function formatSummaryText(summary: TraceSummary): string {
  const lines = [
    `${summary.status.toUpperCase()} ${summary.testTitle ?? summary.title}`,
    `Outcome: ${summary.outcome ?? 'unknown'}`,
    `Duration: ${formatDuration(summary.durationMs)}`,
  ];

  if (summary.error?.message) {
    lines.push(`Error: ${summary.error.message}`);
  }

  if (summary.topLevelSteps.length > 0) {
    lines.push('Top-level steps:');
    lines.push(indentBlock(formatStepsText(summary.topLevelSteps), 2));
  }

  if (summary.slowestSteps.length > 0) {
    lines.push('Slowest steps:');
    lines.push(indentBlock(formatSlowStepsText(summary.slowestSteps), 2));
  }

  if (summary.networkCalls.length > 0) {
    lines.push(`Network calls: ${summary.networkCalls.length}`);
  }

  if (summary.issues.length > 0) {
    lines.push(`Issues: ${summary.issues.length}`);
    lines.push(indentBlock(formatIssuePreview(summary.issues), 2));
  }

  if (summary.actionDiagnostics.length > 0) {
    lines.push('Related actions:');
    lines.push(indentBlock(formatActionDiagnosticsText(summary.actionDiagnostics), 2));
  }

  if (summary.failureDomSnapshot) {
    const ref = summary.failureDomSnapshot;
    lines.push(`Failure DOM snapshot: callId=${ref.callId} phases=[${ref.phases.join(', ')}] frameUrl=${ref.frameUrl ?? '-'}`);
    lines.push('  Use: dom <tracePath> --near ' + ref.callId + ' --output <path>');
  }

  return lines.join('\n');
}

export function formatSlowStepsText(steps: TestStep[]): string {
  if (steps.length === 0) return 'No timed steps found.';

  return steps.map((step, index) => (
    `${index + 1}. ${formatDuration(step.durationMs)} ${step.title}${step.error ? ' [failed]' : ''}`
  )).join('\n');
}

export function formatStepsText(steps: TestStep[]): string {
  if (steps.length === 0) return 'No steps found.';

  const lines: string[] = [];
  for (const step of steps) {
    appendStepLines(lines, step, 0);
  }
  return lines.join('\n');
}

export function formatNetworkText(entries: NetworkEntry[]): string {
  if (entries.length === 0) return 'No network entries found.';

  return entries.map((entry, index) => {
    const lines = [
      `${entry.id}. [${entry.source}] ${entry.method} ${entry.url} -> ${entry.status} ${entry.statusText}`,
      `   Duration: ${entry.durationMs}ms | MIME: ${entry.mimeType || 'unknown'}`,
    ];

    if (entry.relatedAction) {
      lines.push(`   Related action: ${entry.relatedAction.callId} ${entry.relatedAction.title}`);
    }

    const requestBody = truncate(entry.requestBody, 240);
    if (requestBody) lines.push(`   Request body: ${requestBody}`);

    const responseBody = truncate(entry.responseBody, 240);
    if (responseBody) lines.push(`   Response body: ${responseBody}`);

    return lines.join('\n');
  }).join('\n\n');
}

export function formatRequestText(entry: NetworkEntry): string {
  const lines = [
    `[${entry.source}] ${entry.method} ${entry.url}`,
    `Status: ${entry.status} ${entry.statusText}`,
    `Duration: ${entry.durationMs}ms`,
    `MIME: ${entry.mimeType || 'unknown'}`,
    `Started: ${entry.startedDateTime}`,
  ];

  if (entry.relatedAction)
    lines.push(`Related action: ${entry.relatedAction.callId} ${entry.relatedAction.title}`);

  if (entry.requestHeaders.length) {
    lines.push('Request headers:');
    for (const header of entry.requestHeaders)
      lines.push(`  ${header.name}: ${header.value}`);
  }

  if (entry.requestBody) {
    lines.push('Request body:');
    lines.push(indentBlock(entry.requestBody, 2));
  }

  if (entry.responseHeaders.length) {
    lines.push('Response headers:');
    for (const header of entry.responseHeaders)
      lines.push(`  ${header.name}: ${header.value}`);
  }

  if (entry.responseBody) {
    lines.push('Response body:');
    lines.push(indentBlock(entry.responseBody, 2));
  }

  return lines.join('\n');
}

export function formatConsoleText(entries: ConsoleEntry[]): string {
  if (entries.length === 0) return 'No console entries found.';

  return entries.map((entry, index) => {
    const lines = [
      `${index + 1}. [${entry.source}] ${entry.level} ${entry.text}`,
      `   Timestamp: ${entry.timestamp}`,
    ];

    if (entry.location) {
      lines.push(`   Location: ${entry.location.url}:${entry.location.lineNumber}:${entry.location.columnNumber}`);
    }

    return lines.join('\n');
  }).join('\n\n');
}

export function formatErrorsText(errors: TraceIssue[]): string {
  if (errors.length === 0) return 'No issues found.';

  return errors.map((entry, index) => {
    const lines = [
      `${index + 1}. [${entry.source}] ${entry.name ?? 'Error'}: ${firstLine(entry.message) ?? entry.message}`,
    ];

    if (entry.title)
      lines.push(`   Title: ${entry.title}`);
    if (entry.callId)
      lines.push(`   Call ID: ${entry.callId}`);
    if (entry.relatedAction)
      lines.push(`   Related action: ${entry.relatedAction.callId} ${entry.relatedAction.title}`);
    if (entry.timestamp !== null)
      lines.push(`   Timestamp: ${entry.timestamp}`);
    if (entry.location)
      lines.push(`   Location: ${entry.location.file}:${entry.location.line}:${entry.location.column}`);
    if (entry.stack)
      lines.push(`   Stack: ${truncate(singleLine(entry.stack), 240)}`);

    return lines.join('\n');
  }).join('\n\n');
}

export function formatAttachmentsText(attachments: AttachmentEntry[]): string {
  if (attachments.length === 0) return 'No attachments found.';

  return attachments.map((attachment, index) => {
    const lines = [
      `${index + 1}. ${attachment.name} (${attachment.contentType})`,
      `   Attachment ID: ${attachment.id}`,
      `   Call ID: ${attachment.callId}`,
    ];

    if (attachment.actionTitle)
      lines.push(`   Action: ${attachment.actionTitle}`);
    if (attachment.size !== null)
      lines.push(`   Size: ${attachment.size} bytes`);

    return lines.join('\n');
  }).join('\n\n');
}

export function formatAttachmentText(attachment: SavedAttachment): string {
  return [
    `Saved attachment ${attachment.name}`,
    `Content type: ${attachment.contentType}`,
    `Call ID: ${attachment.callId}`,
    `Saved path: ${attachment.savedPath}`,
  ].join('\n');
}

export function formatDomSnapshotsText(snapshots: ActionDomSnapshots[]): string {
  if (snapshots.length === 0) return 'No DOM snapshots found.';

  return snapshots.map((snapshot, index) => {
    const lines = [`${index + 1}. callId ${snapshot.callId}`];

    for (const phase of ['before', 'action', 'after'] as const) {
      const phaseSnapshot = snapshot[phase];
      if (!phaseSnapshot) continue;

      lines.push(`   ${phase}: ${phaseSnapshot.frameUrl}`);
      if (phaseSnapshot.targetElement) {
        lines.push(`   ${phase} target: ${phaseSnapshot.targetElement}`);
      }
      lines.push(`   ${phase} html: ${truncate(singleLine(phaseSnapshot.html), 220)}`);
    }

    return lines.join('\n');
  }).join('\n\n');
}

export function formatTimelineText(entries: TimelineEntry[]): string {
  if (entries.length === 0) return 'No timeline entries found.';

  return entries.map(entry => {
    const prefix = `${new Date(entry.timestamp).toISOString()} [${entry.type}]`;
    switch (entry.type) {
      case 'step': {
        const step = entry.data as TestStep;
        return `${prefix} ${step.title}`;
      }
      case 'screenshot': {
        const screenshot = entry.data as Screenshot;
        return `${prefix} ${screenshot.sha1} ${screenshot.width}x${screenshot.height}`;
      }
      case 'dom': {
        const domSnapshot = entry.data as ActionDomSnapshots;
        return `${prefix} callId ${domSnapshot.callId}`;
      }
      case 'network': {
        const networkEntry = entry.data as NetworkEntry;
        return `${prefix} ${networkEntry.method} ${networkEntry.url} -> ${networkEntry.status}`;
      }
    }
  }).join('\n');
}

export function formatScreenshotsText(screenshots: Screenshot[]): string {
  if (screenshots.length === 0) return 'No screenshots extracted.';

  return screenshots.map((screenshot, index) => (
    `${index + 1}. ${screenshot.savedPath} (${screenshot.width}x${screenshot.height}, ${screenshot.timestamp})`
  )).join('\n');
}

function appendStepLines(lines: string[], step: TestStep, depth: number): void {
  const indent = '  '.repeat(depth);
  const suffix = step.error ? ` [failed: ${firstLine(step.error.message) ?? step.error.name}]` : '';
  lines.push(`${indent}- ${step.title} (${formatDuration(step.durationMs)})${suffix}`);
  for (const child of step.children) {
    appendStepLines(lines, child, depth + 1);
  }
}

function formatIssuePreview(issues: TraceIssue[]): string {
  return issues.slice(0, 3).map((issue, index) => {
    const actionText = issue.relatedAction ? ` | ${issue.relatedAction.callId} ${issue.relatedAction.title}` : '';
    return `${index + 1}. [${issue.source}] ${firstLine(issue.message) ?? issue.name ?? 'Error'}${actionText}`;
  }).join('\n');
}

function formatActionDiagnosticsText(actions: ActionDiagnosticSummary[]): string {
  return actions.slice(0, 3).map((diagnostic, index) => {
    return `${index + 1}. ${diagnostic.action.callId} ${diagnostic.action.title} | network ${diagnostic.networkCallCount} (${diagnostic.failingNetworkCallCount} failing) | issues ${diagnostic.issueCount}`;
  }).join('\n');
}

function formatDuration(durationMs: number | null): string {
  return durationMs === null ? 'n/a' : `${durationMs}ms`;
}

function firstLine(value?: string | null): string | null {
  if (!value) return null;
  return value.split(/\r?\n/, 1)[0] ?? null;
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncate(value: string | null | undefined, maxLength: number): string | null {
  if (!value) return null;
  const compact = singleLine(value);
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 3)}...`;
}

function indentBlock(value: string, spaces: number): string {
  const indent = ' '.repeat(spaces);
  return value.split('\n').map(line => `${indent}${line}`).join('\n');
}

export function formatFindTracesText(traces: FoundTrace[]): string {
  if (traces.length === 0) return 'No matching traces found.';

  return traces.map((t, index) => {
    return [
      `${index + 1}. [${t.outcome}] ${t.testTitle}`,
      `   Project: ${t.projectName}`,
      `   File: ${t.file}`,
      `   Retry: ${t.resultIndex + 1}`,
      `   Trace SHA1: ${t.traceSha1}`,
      `   Trace path: ${t.tracePath}`,
    ].join('\n');
  }).join('\n\n');
}