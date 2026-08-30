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

  it('bounds a stalled device lease request for persistent workers', async () => {
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal as AbortSignal;
      const abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }));
    const provider = createMacCopierDeviceTokenProvider({
      config: {
        version: 1,
        deviceId: crypto.randomUUID(),
        connectionId: crypto.randomUUID(),
        deviceName: 'Timeout test',
        apiOrigin: 'https://alpha.example',
        publicKeyPath: '/does-not-matter-before-fetch',
        privateKeyPath: '/does-not-matter-before-fetch',
        paired: true,
        createdAt: new Date().toISOString(),
      },
      secretStore: { read: async () => 'secret', write: async () => undefined },
      fetchImpl: fetchImpl as typeof fetch,
      requestTimeoutMs: 10,
    });

    await expect(provider.getAccessToken()).rejects.toThrow('mac-copier-lease-timeout');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps the device lease deadline active while the response body is stalled', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal;
      return {
        ok: true,
        status: 200,
        json: () => new Promise((_resolve, reject) => {
          const abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
        }),
      } as Response;
    });
    const provider = createMacCopierDeviceTokenProvider({
      config: {
        version: 1,
        deviceId: crypto.randomUUID(),
        connectionId: crypto.randomUUID(),
        deviceName: 'Body timeout test',
        apiOrigin: 'https://alpha.example',
        publicKeyPath: '/does-not-matter-before-body',
        privateKeyPath: '/does-not-matter-before-body',
        paired: true,
        createdAt: new Date().toISOString(),
      },
      secretStore: { read: async () => 'secret', write: async () => undefined },
      fetchImpl: fetchImpl as typeof fetch,
      requestTimeoutMs: 10,
    });

    await expect(provider.getAccessToken()).rejects.toThrow('mac-copier-lease-timeout');
  });

  it('renews near expiry once for concurrent callers during a persistent run', async () => {
    root = await mkdtemp(resolve(tmpdir(), 'alphatrade-mac-device-'));
    const secrets = new Map<string, string>();
    const secretStore: MacCopierSecretStore = {
      read: async id => secrets.get(id) ?? Promise.reject(new Error('missing')),
      write: async (id, value) => { secrets.set(id, value); },
    };
    const connectionId = crypto.randomUUID();
    let now = Date.parse('2026-08-17T08:00:00.000Z');
    const config = await createMacCopierDevice({
      configPath: resolve(root, 'device.json'),
      connectionId,
      apiOrigin: 'https://alpha.example',
      secretStore,
      now,
    });
    const publicKey = await readFile(config.publicKeyPath, 'utf8');
    let tokenNumber = 0;
    const fetchImpl = vi.fn(async () => {
      tokenNumber += 1;
      const envelope = sealTradovatePilotLease({
        version: 1,
        environment: 'demo',
        connectionId,
        accountSpec: 'demo-user',
        accessToken: `access-token-${tokenNumber}`,
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 60 * 60_000).toISOString(),
      }, publicKey, now);
      return Response.json({ envelope });
    });
    const provider = createMacCopierDeviceTokenProvider({
      config,
      secretStore,
      fetchImpl: fetchImpl as typeof fetch,
      clock: () => now,
    });

    expect(await provider.getAccessToken()).toBe('access-token-1');
    now += 51 * 60_000;
    await expect(Promise.all([
      provider.getAccessToken(),
      provider.getAccessToken(),
      provider.getAccessToken(),
    ])).resolves.toEqual(['access-token-2', 'access-token-2', 'access-token-2']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
