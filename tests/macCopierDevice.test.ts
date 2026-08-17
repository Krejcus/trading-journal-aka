import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  createMacCopierDevice,
  createMacCopierDeviceTokenProvider,
  loadMacCopierDevice,
  macCopierDevicePairing,
  markMacCopierDevicePaired,
  type MacCopierSecretStore,
} from '../server/macCopierDevice';
import { sealTradovatePilotLease } from '../server/tradovatePilotLease';

describe('mac copier device', () => {
  let root: string | null = null;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = null;
  });

  it('keeps the clear device secret out of config and renews an encrypted short lease', async () => {
    root = await mkdtemp(resolve(tmpdir(), 'alphatrade-mac-device-'));
    const secrets = new Map<string, string>();
    const secretStore: MacCopierSecretStore = {
      read: async id => secrets.get(id) ?? Promise.reject(new Error('missing')),
      write: async (id, value) => { secrets.set(id, value); },
    };
    const configPath = resolve(root, 'device.json');
    const connectionId = crypto.randomUUID();
    const now = Date.parse('2026-08-17T08:00:00.000Z');
    const config = await createMacCopierDevice({
      configPath,
      connectionId,
      apiOrigin: 'https://alpha.example',
      deviceName: 'Test Mac',
      secretStore,
      now,
    });
    expect(await readFile(configPath, 'utf8')).not.toContain(secrets.get(config.deviceId));
    expect((await macCopierDevicePairing({ config, secretStore })).deviceSecret).toBe(secrets.get(config.deviceId));

    const publicKey = await readFile(config.publicKeyPath, 'utf8');
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        Authorization: `Device ${config.deviceId}.${secrets.get(config.deviceId)}`,
      });
      const envelope = sealTradovatePilotLease({
        version: 1,
        environment: 'demo',
        connectionId,
        accountSpec: 'demo-user',
        accessToken: 'short-lived-access-token',
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 60 * 60_000).toISOString(),
      }, publicKey, now);
      return new Response(JSON.stringify({ envelope }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const provider = createMacCopierDeviceTokenProvider({
      config,
      secretStore,
      fetchImpl: fetchImpl as typeof fetch,
      clock: () => now,
    });
    expect(await provider.authorizationHeader()).toBe(`Device ${config.deviceId}.${secrets.get(config.deviceId)}`);
    expect(await provider.getAccessToken()).toBe('short-lived-access-token');
    expect(await provider.getAccessToken()).toBe('short-lived-access-token');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((await markMacCopierDevicePaired(configPath)).paired).toBe(true);
    expect((await loadMacCopierDevice(configPath)).paired).toBe(true);
  });

  it('rejects a non-TLS remote API origin', async () => {
    root = await mkdtemp(resolve(tmpdir(), 'alphatrade-mac-device-'));
    const secretStore: MacCopierSecretStore = { read: async () => '', write: async () => undefined };
    await expect(createMacCopierDevice({
      configPath: resolve(root, 'device.json'),
      connectionId: crypto.randomUUID(),
      apiOrigin: 'http://alpha.example',
      secretStore,
    })).rejects.toThrow('https');
  });
});
