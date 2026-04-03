import type {
  ActionDomSnapshots,
  NetworkEntry,
  Screenshot,
  TestStep,
  TimelineEntry,
  TraceSummary,
} from '../index';

export type OutputFormat = 'text' | 'json';

export function emitOutput(io: { stdout: (text: string) => void }, format: OutputFormat, data: unknown, text: string): void {
  if (format === 'json') {
    io.stdout(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }

  io.stdout(`${text}\n`);
}

export function formatFailuresText(summaries: TraceSummary[]): string {
  if (summaries.length === 0) return 'No failing tests found.';

  return summaries.map((summary, index) => {
    const title = summary.testTitle ?? summary.title;
    const errorLine = firstLine(summary.error?.message) ?? 'No error message available';
    const failedNetworkCount = summary.networkCalls.filter(entry => entry.status >= 400).length;
    const slowSteps = summary.slowestSteps.slice(0, 3)
      .map(step => `${step.durationMs ?? 0}ms ${step.title}`)
      .join(' | ');

    return [
      `${index + 1}. [${summary.outcome ?? summary.status}] ${title}`,
      `   Duration: ${formatDuration(summary.durationMs)}`,
      `   Error: ${errorLine}`,
      `   Network: ${summary.networkCalls.length} calls (${failedNetworkCount} errors)`,
      `   Slowest: ${slowSteps || 'n/a'}`,
    ].join('\n');
  }).join('\n\n');
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

  if (summary.failureDomSnapshot) {
    lines.push('Failure DOM snapshot:');
    lines.push(indentBlock(formatDomSnapshotsText([summary.failureDomSnapshot]), 2));
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
      `${index + 1}. [${entry.source}] ${entry.method} ${entry.url} -> ${entry.status} ${entry.statusText}`,
      `   Duration: ${entry.durationMs}ms | MIME: ${entry.mimeType || 'unknown'}`,
    ];

    const requestBody = truncate(entry.requestBody, 240);
    if (requestBody) lines.push(`   Request body: ${requestBody}`);

    const responseBody = truncate(entry.responseBody, 240);
    if (responseBody) lines.push(`   Response body: ${responseBody}`);

    return lines.join('\n');
  }).join('\n\n');
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