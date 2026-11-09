import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTradovateRequestControlFileStore } from '../server/tradovateRequestControlFileStore';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const setup = async () => {
  const root = await mkdtemp('/private/tmp/at-request-control-store-test-'); roots.push(root);
  return { root, store: createTradovateRequestControlFileStore(root), file: join(root, 'request-control', 'broker-user-71000000.json') };
};
const state = () => ({ version: 1 as const, brokerUserId: 71000000, savedAt: 1_000_000, blockedUntil: 4_600_000,
  remainingMs: 3_600_000, captchaRequired: false, evidence: 'raw-429' as const, reason: 'rate limited' });

describe('durable request cooldown', () => {
  it('stores no token, preserves the stop and restricts permissions', async () => {
    const { store, file } = await setup();
    expect(await store.load(71000000)).toBeNull(); await store.save(state());
    expect(await store.load(71000000)).toEqual(state());
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, 'utf8'))).not.toHaveProperty('accessToken');
  });
  it('existing corrupt or mismatched data fail closed instead of resetting the cooldown', async () => {
    const { store, file } = await setup(); await store.save(state());
    await writeFile(file, '{invalid'); await expect(store.load(71000000)).rejects.toThrow();
    await writeFile(file, JSON.stringify({ ...state(), brokerUserId: 1 }));
    await expect(store.load(71000000)).rejects.toThrow('corrupt');
  });
});
