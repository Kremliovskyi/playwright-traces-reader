import * as fs from 'fs';
import * as readline from 'readline';

export class NdjsonParseError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly lineNumber: number,
    public readonly cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Malformed NDJSON in ${filePath} at line ${lineNumber}: ${detail}`);
    this.name = 'NdjsonParseError';
  }
}

export async function* readNdjson<T = unknown>(filePath: string): AsyncGenerator<T> {
  if (!fs.existsSync(filePath))
    return;

  const fileStream = fs.createReadStream(filePath);
  const lines = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (!line.trim())
      continue;

    try {
      yield JSON.parse(line) as T;
    } catch (error) {
      throw new NdjsonParseError(filePath, lineNumber, error);
    }
  }
}