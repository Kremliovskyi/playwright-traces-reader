import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { startTraceCacheSession } from '../src/traceCache';

const HOUR = 60 * 60 * 1000;
const OLD_DIGEST = 'a'.repeat(64);
const FRESH_DIGEST = 'b'.repeat(64);
const OLD_STAGING = `${'c'.repeat(64)}-old`;
const FRESH_STAGING = `${'d'.repeat(64)}-fresh`;

async function setModifiedTime(targetPath: string, time: number): Promise<void> {
  const date = new Date(time);
  await fs.promises.utimes(targetPath, date, date);
}

describe('trace cache maintenance', () => {
  test('prunes expired completed and staging entries while preserving fresh entries', async () => {
    const cacheRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pwtr-cache-policy-'));
    const now = Date.now();

    try {
      for (const entry of [OLD_DIGEST, FRESH_DIGEST, OLD_STAGING, FRESH_STAGING])
        await fs.promises.mkdir(path.join(cacheRoot, entry));
      await fs.promises.writeFile(path.join(cacheRoot, OLD_DIGEST, '.last-access'), '');
      await fs.promises.writeFile(path.join(cacheRoot, FRESH_DIGEST, '.last-access'), '');
      await setModifiedTime(path.join(cacheRoot, OLD_DIGEST, '.last-access'), now - 25 * HOUR);
      await setModifiedTime(path.join(cacheRoot, FRESH_DIGEST, '.last-access'), now - 23 * HOUR);
      await setModifiedTime(path.join(cacheRoot, OLD_STAGING), now - 2 * HOUR);
      await setModifiedTime(path.join(cacheRoot, FRESH_STAGING), now - 30 * 60 * 1000);

      const session = await startTraceCacheSession({ cacheRoot, now: () => now });
      await session.close();

      expect(fs.existsSync(path.join(cacheRoot, OLD_DIGEST))).toBe(false);
      expect(fs.existsSync(path.join(cacheRoot, FRESH_DIGEST))).toBe(true);
      expect(fs.existsSync(path.join(cacheRoot, OLD_STAGING))).toBe(false);
      expect(fs.existsSync(path.join(cacheRoot, FRESH_STAGING))).toBe(true);
    } finally {
      await fs.promises.rm(cacheRoot, { recursive: true, force: true });
    }
  });

  test('skips pruning while another live reader lease exists', async () => {
    const cacheRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pwtr-cache-lease-'));
    const leasesDir = path.join(cacheRoot, '.leases');
    const expiredEntry = path.join(cacheRoot, OLD_DIGEST);
    const now = Date.now();

    try {
      await fs.promises.mkdir(leasesDir);
      await fs.promises.mkdir(expiredEntry);
      await fs.promises.writeFile(path.join(expiredEntry, '.last-access'), '');
      await setModifiedTime(path.join(expiredEntry, '.last-access'), now - 25 * HOUR);
      await fs.promises.writeFile(path.join(leasesDir, `${process.pid}-existing.json`), '{}');

      const session = await startTraceCacheSession({ cacheRoot, now: () => now });
      await session.close();

      expect(fs.existsSync(expiredEntry)).toBe(true);
    } finally {
      await fs.promises.rm(cacheRoot, { recursive: true, force: true });
    }
  });

  test('allows both completed and staging pruning to be disabled through environment variables', async () => {
    const cacheRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pwtr-cache-disabled-'));
    const completedEntry = path.join(cacheRoot, OLD_DIGEST);
    const stagingEntry = path.join(cacheRoot, OLD_STAGING);
    const now = Date.now();
    const previousMaxAge = process.env.PWTR_CACHE_MAX_AGE_HOURS;
    const previousStagingMaxAge = process.env.PWTR_CACHE_STAGING_MAX_AGE_HOURS;

    try {
      process.env.PWTR_CACHE_MAX_AGE_HOURS = '0';
      process.env.PWTR_CACHE_STAGING_MAX_AGE_HOURS = '0';
      await fs.promises.mkdir(completedEntry);
      await fs.promises.mkdir(stagingEntry);
      await setModifiedTime(completedEntry, now - 25 * HOUR);
      await setModifiedTime(stagingEntry, now - 2 * HOUR);

      const session = await startTraceCacheSession({ cacheRoot, now: () => now });
      await session.close();

      expect(fs.existsSync(completedEntry)).toBe(true);
      expect(fs.existsSync(stagingEntry)).toBe(true);
    } finally {
      if (previousMaxAge === undefined)
        delete process.env.PWTR_CACHE_MAX_AGE_HOURS;
      else
        process.env.PWTR_CACHE_MAX_AGE_HOURS = previousMaxAge;
      if (previousStagingMaxAge === undefined)
        delete process.env.PWTR_CACHE_STAGING_MAX_AGE_HOURS;
      else
        process.env.PWTR_CACHE_STAGING_MAX_AGE_HOURS = previousStagingMaxAge;
      await fs.promises.rm(cacheRoot, { recursive: true, force: true });
    }
  });

  test('reclaims a maintenance lock owned by a dead process', async () => {
    const cacheRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pwtr-cache-lock-'));
    const lockDir = path.join(cacheRoot, '.maintenance-lock');

    try {
      await fs.promises.mkdir(lockDir);
      await fs.promises.writeFile(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: 999, released: false }));

      const session = await startTraceCacheSession({
        cacheRoot,
        pid: 123,
        isProcessRunning: pid => pid === 123,
      });
      await session.close();

      expect(fs.existsSync(lockDir)).toBe(false);
    } finally {
      await fs.promises.rm(cacheRoot, { recursive: true, force: true });
    }
  });
});
