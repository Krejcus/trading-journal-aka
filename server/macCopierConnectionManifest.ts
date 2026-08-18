import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

export interface MacCopierConnectionManifestEntry {
  connectionId: string;
  accountIds: number[];
  deviceConfigPath: string;
  /** Required only until this device has been paired. */
  leasePath?: string;
  /** Defaults to the private key referenced by deviceConfigPath. */
  privateKeyPath?: string;
}

export interface MacCopierConnectionManifest {
  version: 1;
  primaryConnectionId: string;
  connections: MacCopierConnectionManifestEntry[];
}

export interface UpsertMacCopierConnectionManifestOptions {
  path: string;
  connection: MacCopierConnectionManifestEntry;
  makePrimary?: boolean;
}

const pathFrom = (root: string, value: string): string => (
  isAbsolute(value) ? resolve(value) : resolve(root, value)
);

/**
 * Public topology only: the manifest contains no token or device secret.
 * Each OAuth identity keeps its own key material in its device directory.
 */
function parseMacCopierConnectionManifest(
  raw: Partial<MacCopierConnectionManifest>,
  manifestPath: string,
): MacCopierConnectionManifest {
  const root = dirname(manifestPath);
  if (raw.version !== 1 || !raw.primaryConnectionId?.trim() || !Array.isArray(raw.connections) || raw.connections.length === 0) {
    throw new Error('Neplatný Mac copier connections manifest');
  }
  const seenConnections = new Set<string>();
  const seenAccounts = new Set<number>();
  const connections = raw.connections.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new Error(`Manifest connection ${index + 1} není objekt`);
    const connectionId = String(entry.connectionId ?? '').trim();
    const deviceConfigPath = String(entry.deviceConfigPath ?? '').trim();
    if (!connectionId || !deviceConfigPath || !Array.isArray(entry.accountIds) || entry.accountIds.length === 0) {
      throw new Error(`Manifest connection ${index + 1} nemá connectionId, deviceConfigPath nebo accountIds`);
    }
    if (seenConnections.has(connectionId)) throw new Error(`OAuth connection ${connectionId} je v manifestu vícekrát`);
    seenConnections.add(connectionId);
    const accountIds = entry.accountIds.map(Number);
    for (const accountId of accountIds) {
      if (!Number.isSafeInteger(accountId) || accountId <= 0) throw new Error(`Manifest obsahuje neplatný accountId ${accountId}`);
      if (seenAccounts.has(accountId)) throw new Error(`Účet ${accountId} patří v manifestu více OAuth připojením`);
      seenAccounts.add(accountId);
    }
    return {
      connectionId,
      accountIds,
      deviceConfigPath: pathFrom(root, deviceConfigPath),
      ...(entry.leasePath ? { leasePath: pathFrom(root, String(entry.leasePath)) } : {}),
      ...(entry.privateKeyPath ? { privateKeyPath: pathFrom(root, String(entry.privateKeyPath)) } : {}),
    };
  });
  const primaryConnectionId = raw.primaryConnectionId.trim();
  if (!seenConnections.has(primaryConnectionId)) throw new Error('Primární OAuth connection není v manifestu');
  connections.sort((left, right) => (
    left.connectionId === primaryConnectionId ? -1 : right.connectionId === primaryConnectionId ? 1 : 0
  ));
  return { version: 1, primaryConnectionId, connections };
}

export async function loadMacCopierConnectionManifest(path: string): Promise<MacCopierConnectionManifest> {
  const manifestPath = resolve(path);
  const raw = JSON.parse(await readFile(manifestPath, 'utf8')) as Partial<MacCopierConnectionManifest>;
  return parseMacCopierConnectionManifest(raw, manifestPath);
}

/**
 * Atomically adds or updates one OAuth route without ever storing tokens or
 * device secrets in the manifest. Account ownership remains one-to-one.
 */
export async function upsertMacCopierConnectionManifest(
  options: UpsertMacCopierConnectionManifestOptions,
): Promise<MacCopierConnectionManifest> {
  const manifestPath = resolve(options.path);
  let current: MacCopierConnectionManifest | null = null;
  try {
    current = await loadMacCopierConnectionManifest(manifestPath);
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const connectionId = options.connection.connectionId.trim();
  const accountIds = [...new Set(options.connection.accountIds.map(Number))];
  if (!connectionId || accountIds.length === 0 || !options.connection.deviceConfigPath.trim()) {
    throw new Error('Nové OAuth připojení nemá connectionId, deviceConfigPath nebo accountIds');
  }
  const nextConnections = [
    ...(current?.connections.filter(item => item.connectionId !== connectionId) ?? []),
    {
      ...options.connection,
      connectionId,
      accountIds,
      deviceConfigPath: resolve(options.connection.deviceConfigPath),
      ...(options.connection.leasePath ? { leasePath: resolve(options.connection.leasePath) } : {}),
      ...(options.connection.privateKeyPath ? { privateKeyPath: resolve(options.connection.privateKeyPath) } : {}),
    },
  ];
  const raw: MacCopierConnectionManifest = {
    version: 1,
    primaryConnectionId: options.makePrimary || !current ? connectionId : current.primaryConnectionId,
    connections: nextConnections,
  };
  // Reuse the same strict parser before touching the existing manifest.
  const validated = parseMacCopierConnectionManifest(raw, manifestPath);
  await mkdir(dirname(manifestPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${manifestPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, manifestPath);
  await chmod(manifestPath, 0o600);
  return validated;
}
