import { execFile } from 'node:child_process';
import { hostname } from 'node:os';
import { promisify } from 'node:util';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  createTradovatePilotKeyPair,
  openTradovatePilotLease,
  type TradovatePilotLeaseEnvelope,
  type TradovatePilotLeasePayload,
} from './tradovatePilotLease';

const execFileAsync = promisify(execFile);
const KEYCHAIN_SERVICE = 'com.alphatrade.copier-device';

export interface MacCopierDeviceConfig {
  version: 1;
  deviceId: string;
  connectionId: string;
  deviceName: string;
  apiOrigin: string;
  publicKeyPath: string;
  privateKeyPath: string;
  paired: boolean;
  createdAt: string;
}

export interface MacCopierDevicePairing {
  deviceId: string;
  connectionId: string;
  deviceName: string;
  deviceSecret: string;
  publicKey: string;
}

export interface MacCopierSecretStore {
  read(deviceId: string): Promise<string>;
  write(deviceId: string, secret: string): Promise<void>;
}

export const macOsKeychainCopierSecretStore: MacCopierSecretStore = {
  async read(deviceId) {
    const { stdout } = await execFileAsync('/usr/bin/security', [
      'find-generic-password', '-a', deviceId, '-s', KEYCHAIN_SERVICE, '-w',
    ]);
    const value = stdout.trim();
    if (!value) throw new Error('mac-copier-device-secret-missing');
    return value;
  },
  async write(deviceId, secret) {
    await execFileAsync('/usr/bin/security', [
      'add-generic-password', '-U', '-a', deviceId, '-s', KEYCHAIN_SERVICE, '-w', secret,
    ]);
  },
};

const safeApiOrigin = (value: string): string => {
  const url = new URL(value);
  const loopback = url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
  if (url.protocol !== 'https:' && !loopback) throw new Error('mac-copier-api-origin-must-be-https');
  return url.origin;
};

export async function createMacCopierDevice(options: {
  configPath: string;
  connectionId: string;
  apiOrigin: string;
  deviceName?: string;
  secretStore?: MacCopierSecretStore;
  now?: number;
}): Promise<MacCopierDeviceConfig> {
  const configPath = resolve(options.configPath);
  const root = dirname(configPath);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const publicKeyPath = resolve(root, 'mac-device-public.pem');
  const privateKeyPath = resolve(root, 'mac-device-private.pem');
  const pair = createTradovatePilotKeyPair();
  const deviceId = randomUUID();
  const secret = randomBytes(32).toString('base64url');
  const config: MacCopierDeviceConfig = {
    version: 1,
    deviceId,
    connectionId: options.connectionId,
    deviceName: (options.deviceName?.trim() || `AlphaTrade Mac · ${hostname()}`).slice(0, 120),
    apiOrigin: safeApiOrigin(options.apiOrigin),
    publicKeyPath,
    privateKeyPath,
    paired: false,
    createdAt: new Date(options.now ?? Date.now()).toISOString(),
  };
  await writeFile(publicKeyPath, pair.publicKey, { mode: 0o600 });
  await writeFile(privateKeyPath, pair.privateKey, { mode: 0o600 });
  await (options.secretStore ?? macOsKeychainCopierSecretStore).write(deviceId, secret);
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await Promise.all([chmod(configPath, 0o600), chmod(publicKeyPath, 0o600), chmod(privateKeyPath, 0o600)]);
  return config;
}

export async function loadMacCopierDevice(configPath: string): Promise<MacCopierDeviceConfig> {
  const config = JSON.parse(await readFile(resolve(configPath), 'utf8')) as MacCopierDeviceConfig;
  if (
    config.version !== 1
    || !config.deviceId
    || !config.connectionId
    || !config.deviceName
    || !config.publicKeyPath
    || !config.privateKeyPath
  ) throw new Error('invalid-mac-copier-device-config');
  return { ...config, apiOrigin: safeApiOrigin(config.apiOrigin) };
}

export async function macCopierDevicePairing(options: {
  config: MacCopierDeviceConfig;
  secretStore?: MacCopierSecretStore;
}): Promise<MacCopierDevicePairing> {
  const deviceSecret = await (options.secretStore ?? macOsKeychainCopierSecretStore).read(options.config.deviceId);
  const publicKey = await readFile(resolve(options.config.publicKeyPath), 'utf8');
  return {
    deviceId: options.config.deviceId,
    connectionId: options.config.connectionId,
    deviceName: options.config.deviceName,
    deviceSecret,
    publicKey,
  };
}

export async function markMacCopierDevicePaired(configPath: string): Promise<MacCopierDeviceConfig> {
  const config = await loadMacCopierDevice(configPath);
  const next = { ...config, paired: true };
  await writeFile(resolve(configPath), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await chmod(resolve(configPath), 0o600);
  return next;
}

export function createMacCopierDeviceTokenProvider(options: {
  config: MacCopierDeviceConfig;
  secretStore?: MacCopierSecretStore;
  fetchImpl?: typeof fetch;
  clock?: () => number;
  minimumValidityMs?: number;
}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const clock = options.clock ?? Date.now;
  const minimumValidityMs = Math.max(5 * 60_000, options.minimumValidityMs ?? 10 * 60_000);
  let payload: TradovatePilotLeasePayload | null = null;
  let renewal: Promise<TradovatePilotLeasePayload> | null = null;

  const refresh = async (): Promise<TradovatePilotLeasePayload> => {
    if (renewal) return renewal;
    renewal = (async () => {
      if (!fetchImpl) throw new Error('mac-copier-fetch-unavailable');
      const secret = await (options.secretStore ?? macOsKeychainCopierSecretStore).read(options.config.deviceId);
      const response = await fetchImpl(`${options.config.apiOrigin}/api/tradovate/oauth/pilot-lease`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Device ${options.config.deviceId}.${secret}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
      });
      const body = await response.json().catch(() => ({})) as { envelope?: TradovatePilotLeaseEnvelope; error?: string };
      if (!response.ok || !body.envelope) throw new Error(body.error || `mac-copier-lease-http-${response.status}`);
      const privateKey = await readFile(resolve(options.config.privateKeyPath), 'utf8');
      const opened = openTradovatePilotLease(body.envelope, privateKey, clock());
      if (opened.connectionId !== options.config.connectionId) throw new Error('mac-copier-lease-connection-mismatch');
      payload = opened;
      return opened;
    })().finally(() => { renewal = null; });
    return renewal;
  };

  return {
    refresh,
    async getAccessToken(): Promise<string> {
      if (!payload || Date.parse(payload.expiresAt) - clock() <= minimumValidityMs) await refresh();
      if (!payload) throw new Error('mac-copier-lease-unavailable');
      return payload.accessToken;
    },
    current: () => payload,
  };
}
