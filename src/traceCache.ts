import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const DEFAULT_MAX_AGE_HOURS = 24;
const DEFAULT_STAGING_MAX_AGE_HOURS = 1;
const LOCK_RETRY_DELAY_MS = 50;
const ORPHANED_LOCK_MAX_AGE_MS = 60_000;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const STAGING_PATTERN = /^[0-9a-f]{64}-.+$/;
const activeSessionsByRoot = new Map<string, number>();
let processSessionPromise: Promise<TraceCacheSession> | undefined;

export interface TraceCacheSession {
  close(): Promise<void>;
}

interface TraceCacheSessionOptions {
  cacheRoot?: string;
  maxAgeMs?: number;
  stagingMaxAgeMs?: number;
  now?: () => number;
  pid?: number;
  isProcessRunning?: (pid: number) => boolean;
}

export function getTraceCacheRoot(): string {
  return path.join(os.tmpdir(), 'playwright-traces-reader', 'trace-cache');
}

function maxAgeFromEnvironment(name: string, defaultHours: number): number {
  const rawValue = process.env[name];
  if (rawValue === undefined)
    return defaultHours * 60 * 60 * 1000;
  const hours = Number(rawValue);
  return Number.isFinite(hours) && hours >= 0 ? hours * 60 * 60 * 1000 : defaultHours * 60 * 60 * 1000;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function removeDirectory(directory: string): Promise<void> {
  await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

async function acquireMaintenanceLock(
  cacheRoot: string,
  pid: number,
  processRunning: (pid: number) => boolean,
  now: () => number,
): Promise<() => Promise<void>> {
  const lockDir = path.join(cacheRoot, '.maintenance-lock');
  const ownerPath = path.join(lockDir, 'owner.json');
  const lockToken = crypto.randomUUID();

  for (;;) {
    try {
      await fs.promises.mkdir(lockDir);
      try {
        await fs.promises.writeFile(ownerPath, JSON.stringify({ pid, lockToken, createdAt: now(), released: false }), 'utf8');
      } catch (error) {
        await removeDirectory(lockDir);
        throw error;
      }
      return async () => {
        try {
          await fs.promises.writeFile(ownerPath, JSON.stringify({ pid, lockToken, createdAt: now(), released: true }), 'utf8');
        } catch {
          // Removing the canonical lock directory below is still sufficient.
        }
        try {
          await removeDirectory(lockDir);
        } catch {
          // A released owner marker lets the next process reclaim the lock.
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
        throw error;

      let stale = false;
      try {
        const owner = JSON.parse(await fs.promises.readFile(ownerPath, 'utf8')) as { pid?: number; released?: boolean };
        stale = owner.released === true || typeof owner.pid !== 'number' || !processRunning(owner.pid);
      } catch {
        try {
          const stat = await fs.promises.stat(lockDir);
          stale = now() - stat.mtimeMs > ORPHANED_LOCK_MAX_AGE_MS;
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code === 'ENOENT')
            continue;
          throw statError;
        }
      }

      if (stale) {
        const staleLockDir = path.join(cacheRoot, `.maintenance-lock-stale-${crypto.randomUUID()}`);
        try {
          await fs.promises.rename(lockDir, staleLockDir);
          await removeDirectory(staleLockDir);
        } catch (renameError) {
          const code = (renameError as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT' && code !== 'EEXIST' && code !== 'EPERM')
            throw renameError;
          if (code === 'EPERM')
            await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_DELAY_MS));
        }
        continue;
      }
      await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_DELAY_MS));
    }
  }
}

async function removeDeadLeases(leasesDir: string, processRunning: (pid: number) => boolean): Promise<string[]> {
  const entries = await fs.promises.readdir(leasesDir, { withFileTypes: true });
  const liveLeases: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile())
      continue;
    const pid = Number.parseInt(entry.name.split('-', 1)[0]!, 10);
    const leasePath = path.join(leasesDir, entry.name);
    if (Number.isInteger(pid) && pid > 0 && processRunning(pid)) {
      liveLeases.push(leasePath);
    } else {
      await fs.promises.rm(leasePath, { force: true });
    }
  }
  return liveLeases;
}

async function entryLastAccess(entryPath: string): Promise<number> {
  try {
    return (await fs.promises.stat(path.join(entryPath, '.last-access'))).mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw error;
    return (await fs.promises.stat(entryPath)).mtimeMs;
  }
}

async function pruneTraceCache(cacheRoot: string, maxAgeMs: number, stagingMaxAgeMs: number, now: number): Promise<void> {
  const entries = await fs.promises.readdir(cacheRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory())
      continue;
    const entryPath = path.join(cacheRoot, entry.name);
    try {
      if (maxAgeMs > 0 && DIGEST_PATTERN.test(entry.name) && now - await entryLastAccess(entryPath) > maxAgeMs) {
        await removeDirectory(entryPath);
      } else if (stagingMaxAgeMs > 0 && STAGING_PATTERN.test(entry.name)) {
        const stat = await fs.promises.stat(entryPath);
        if (now - stat.mtimeMs > stagingMaxAgeMs)
          await removeDirectory(entryPath);
      }
    } catch {
      // Cache maintenance is best-effort and must not block trace analysis.
    }
  }
}

export async function startTraceCacheSession(options: TraceCacheSessionOptions = {}): Promise<TraceCacheSession> {
  const cacheRoot = options.cacheRoot ?? getTraceCacheRoot();
  const leasesDir = path.join(cacheRoot, '.leases');
  const pid = options.pid ?? process.pid;
  const now = options.now ?? Date.now;
  const processRunning = options.isProcessRunning ?? isProcessRunning;
  const maxAgeMs = options.maxAgeMs ?? maxAgeFromEnvironment('PWTR_CACHE_MAX_AGE_HOURS', DEFAULT_MAX_AGE_HOURS);
  const stagingMaxAgeMs = options.stagingMaxAgeMs ?? maxAgeFromEnvironment('PWTR_CACHE_STAGING_MAX_AGE_HOURS', DEFAULT_STAGING_MAX_AGE_HOURS);
  const leasePath = path.join(leasesDir, `${pid}-${crypto.randomUUID()}.json`);

  try {
    await fs.promises.mkdir(leasesDir, { recursive: true });
    await fs.promises.writeFile(leasePath, JSON.stringify({ pid, createdAt: now() }), { encoding: 'utf8', flag: 'wx' });
    const releaseLock = await acquireMaintenanceLock(cacheRoot, pid, processRunning, now);
    try {
      const liveLeases = await removeDeadLeases(leasesDir, processRunning);
      if (!liveLeases.some(candidate => candidate !== leasePath))
        await pruneTraceCache(cacheRoot, maxAgeMs, stagingMaxAgeMs, now());
    } finally {
      await releaseLock();
    }
  } catch {
    // Cache maintenance is best-effort. Extraction will report an actionable
    // filesystem error later if the cache itself is unavailable.
  }

  activeSessionsByRoot.set(cacheRoot, (activeSessionsByRoot.get(cacheRoot) ?? 0) + 1);
  let closed = false;
  return {
    async close() {
      if (closed)
        return;
      closed = true;
      const activeSessions = (activeSessionsByRoot.get(cacheRoot) ?? 1) - 1;
      if (activeSessions > 0)
        activeSessionsByRoot.set(cacheRoot, activeSessions);
      else
        activeSessionsByRoot.delete(cacheRoot);
      try {
        await fs.promises.rm(leasePath, { force: true });
      } catch {
        // Dead leases are removed by the next maintenance pass.
      }
    },
  };
}

export async function ensureTraceCacheSession(): Promise<void> {
  const cacheRoot = getTraceCacheRoot();
  if ((activeSessionsByRoot.get(cacheRoot) ?? 0) > 0)
    return;
  processSessionPromise ??= startTraceCacheSession({ cacheRoot });
  await processSessionPromise;
}

export async function touchTraceCacheEntry(entryRoot: string): Promise<void> {
  try {
    const marker = path.join(entryRoot, '.last-access');
    await fs.promises.writeFile(marker, '');
  } catch {
    // Access tracking is best-effort and must not block trace analysis.
  }
}
