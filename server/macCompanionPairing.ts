import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  MAC_COMPANION_AUDIENCE,
  MAC_COMPANION_CONTRACT_VERSION,
  MAC_COMPANION_SCOPE,
} from '../lib/macCompanionContract.js';
import {
  normalizeSha256Hex,
  type MacCompanionDeviceRow,
} from './macCompanionAuth.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAIRING_CODE = /^[0-9A-HJKMNP-TV-Z]{12}$/;
const PAIRING_TTL_MS = 10 * 60_000;
export const MAC_COMPANION_PAIR_POLL_SECONDS = 2 as const;

const DEVICE_COLUMNS = [
  'id', 'user_id', 'device_name', 'platform', 'secret_hash',
  'pairing_code_hash', 'pairing_expires_at', 'audience', 'scope',
  'created_at', 'paired_at', 'last_used_at', 'revoked_at', 'updated_at',
].join(',');

export interface MacCompanionDeviceDTO {
  id: string;
  deviceName: string;
  createdAt: string;
  pairedAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

const deviceDTO = (row: MacCompanionDeviceRow): MacCompanionDeviceDTO => {
  if (!row.paired_at) throw new Error('mac-companion-device-not-paired');
  return {
    id: row.id,
    deviceName: row.device_name,
    createdAt: row.created_at,
    pairedAt: row.paired_at,
    lastSeenAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
};

const deviceName = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length >= 1 && normalized.length <= 120 ? normalized : null;
};

export const normalizeMacCompanionPairingCode = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.toUpperCase().replace(/[\s-]/g, '');
  return PAIRING_CODE.test(normalized) ? normalized : null;
};

export const hashMacCompanionPairingCode = (code: string): string =>
  createHash('sha256').update(code, 'utf8').digest('hex');

export async function startMacCompanionPairing(options: {
  db: SupabaseClient;
  contractVersion: unknown;
  deviceId: unknown;
  deviceName: unknown;
  deviceSecretHash: unknown;
  pairingCodeHash: unknown;
  now?: number;
}): Promise<{
  contractVersion: typeof MAC_COMPANION_CONTRACT_VERSION;
  pairingId: string;
  expiresAt: string;
  pollAfterSeconds: typeof MAC_COMPANION_PAIR_POLL_SECONDS;
  created: boolean;
}> {
  const id = typeof options.deviceId === 'string' ? options.deviceId.trim() : '';
  const name = deviceName(options.deviceName);
  const secretHash = normalizeSha256Hex(options.deviceSecretHash);
  const codeHash = normalizeSha256Hex(options.pairingCodeHash);
  if (
    options.contractVersion !== MAC_COMPANION_CONTRACT_VERSION
    || !UUID_V4.test(id)
    || !name
    || !secretHash
    || !codeHash
  ) throw new Error('invalid-pairing-start');

  const now = options.now ?? Date.now();
  const nowIso = new Date(now).toISOString();
  const expiresAt = new Date(now + PAIRING_TTL_MS).toISOString();
  const row = {
    id,
    user_id: null,
    device_name: name,
    platform: 'macos',
    secret_hash: secretHash,
    pairing_code_hash: codeHash,
    pairing_expires_at: expiresAt,
    audience: MAC_COMPANION_AUDIENCE,
    scope: MAC_COMPANION_SCOPE,
    created_at: nowIso,
    paired_at: null,
    last_used_at: null,
    revoked_at: null,
    updated_at: nowIso,
  };
  const { error } = await options.db.from('mac_companion_devices').insert(row);
  if (!error) {
    return {
      contractVersion: MAC_COMPANION_CONTRACT_VERSION,
      pairingId: id,
      expiresAt,
      pollAfterSeconds: MAC_COMPANION_PAIR_POLL_SECONDS,
      created: true,
    };
  }
  if (error.code !== '23505') throw new Error(`mac-companion-pairing-insert-failed:${error.message}`);

  // Retrying a lost response is safe only when the caller proves continuity
  // with the same secret digest. Never overwrite a paired/revoked identity.
  const { data: existing, error: lookupError } = await options.db
    .from('mac_companion_devices')
    .select(DEVICE_COLUMNS)
    .eq('id', id)
    .maybeSingle<MacCompanionDeviceRow>();
  if (lookupError) throw new Error(`mac-companion-pairing-lookup-failed:${lookupError.message}`);
  if (
    !existing
    || existing.user_id != null
    || existing.paired_at != null
    || existing.revoked_at != null
    || existing.secret_hash !== secretHash
  ) throw new Error('pairing-device-conflict');

  const { data: refreshed, error: refreshError } = await options.db
    .from('mac_companion_devices')
    .update({
      device_name: name,
      pairing_code_hash: codeHash,
      pairing_expires_at: expiresAt,
      updated_at: nowIso,
    })
    .eq('id', id)
    .eq('secret_hash', secretHash)
    .is('user_id', null)
    .is('paired_at', null)
    .is('revoked_at', null)
    .select('id')
    .maybeSingle<{ id: string }>();
  if (refreshError?.code === '23505') throw new Error('pairing-code-conflict');
  if (refreshError) throw new Error(`mac-companion-pairing-refresh-failed:${refreshError.message}`);
  if (!refreshed) throw new Error('pairing-device-conflict');
  return {
    contractVersion: MAC_COMPANION_CONTRACT_VERSION,
    pairingId: id,
    expiresAt,
    pollAfterSeconds: MAC_COMPANION_PAIR_POLL_SECONDS,
    created: false,
  };
}

export function macCompanionPairingStatus(options: {
  deviceId: string;
  userId: string | null;
  scope: typeof MAC_COMPANION_SCOPE;
  pairingExpiresAt: string | null;
  now?: number;
}):
  | {
      contractVersion: typeof MAC_COMPANION_CONTRACT_VERSION;
      paired: false;
      expiresAt: string;
      pollAfterSeconds: typeof MAC_COMPANION_PAIR_POLL_SECONDS;
    }
  | {
      contractVersion: typeof MAC_COMPANION_CONTRACT_VERSION;
      paired: true;
      deviceId: string;
      scope: typeof MAC_COMPANION_SCOPE;
    } {
  if (options.userId) {
    return {
      contractVersion: MAC_COMPANION_CONTRACT_VERSION,
      paired: true,
      deviceId: options.deviceId,
      scope: options.scope,
    };
  }
  const expiresAt = Date.parse(options.pairingExpiresAt ?? '');
  if (!Number.isFinite(expiresAt) || (options.now ?? Date.now()) >= expiresAt) {
    throw new Error('pairing-expired');
  }
  return {
    contractVersion: MAC_COMPANION_CONTRACT_VERSION,
    paired: false,
    expiresAt: new Date(expiresAt).toISOString(),
    pollAfterSeconds: MAC_COMPANION_PAIR_POLL_SECONDS,
  };
}

export async function confirmMacCompanionPairing(options: {
  db: SupabaseClient;
  userId: string;
  pairingCode: unknown;
  now?: number;
}): Promise<MacCompanionDeviceDTO> {
  const code = normalizeMacCompanionPairingCode(options.pairingCode);
  if (!code) throw new Error('invalid-pairing-code');
  const now = options.now ?? Date.now();
  const nowIso = new Date(now).toISOString();
  const { data, error } = await options.db
    .from('mac_companion_devices')
    .update({
      user_id: options.userId,
      paired_at: nowIso,
      pairing_code_hash: null,
      pairing_expires_at: null,
      updated_at: nowIso,
    })
    .eq('pairing_code_hash', hashMacCompanionPairingCode(code))
    .is('user_id', null)
    .is('paired_at', null)
    .is('revoked_at', null)
    .gt('pairing_expires_at', nowIso)
    .select(DEVICE_COLUMNS)
    .maybeSingle<MacCompanionDeviceRow>();
  if (error) throw new Error(`mac-companion-pairing-confirm-failed:${error.message}`);
  if (!data) throw new Error('pairing-code-not-found');
  return deviceDTO(data);
}

export async function listMacCompanionDevices(options: {
  db: SupabaseClient;
  userId: string;
}): Promise<MacCompanionDeviceDTO[]> {
  const { data, error } = await options.db
    .from('mac_companion_devices')
    .select(DEVICE_COLUMNS)
    .eq('user_id', options.userId)
    .order('created_at', { ascending: false })
    .overrideTypes<MacCompanionDeviceRow[], { merge: false }>();
  if (error) throw new Error(`mac-companion-device-list-failed:${error.message}`);
  return (data ?? []).map(deviceDTO);
}

export async function renameMacCompanionDevice(options: {
  db: SupabaseClient;
  userId: string;
  deviceId: unknown;
  deviceName: unknown;
  now?: number;
}): Promise<MacCompanionDeviceDTO | null> {
  const id = typeof options.deviceId === 'string' ? options.deviceId.trim() : '';
  const name = deviceName(options.deviceName);
  if (!UUID.test(id) || !name) throw new Error('invalid-mac-companion-device');
  const { data, error } = await options.db
    .from('mac_companion_devices')
    .update({ device_name: name, updated_at: new Date(options.now ?? Date.now()).toISOString() })
    .eq('id', id)
    .eq('user_id', options.userId)
    .is('revoked_at', null)
    .select(DEVICE_COLUMNS)
    .maybeSingle<MacCompanionDeviceRow>();
  if (error) throw new Error(`mac-companion-device-rename-failed:${error.message}`);
  return data ? deviceDTO(data) : null;
}

export async function revokeMacCompanionDevice(options: {
  db: SupabaseClient;
  userId: string;
  deviceId: unknown;
  now?: number;
}): Promise<boolean> {
  const id = typeof options.deviceId === 'string' ? options.deviceId.trim() : '';
  if (!UUID.test(id)) throw new Error('invalid-mac-companion-device');
  const nowIso = new Date(options.now ?? Date.now()).toISOString();
  const { data, error } = await options.db
    .from('mac_companion_devices')
    .update({ revoked_at: nowIso, updated_at: nowIso })
    .eq('id', id)
    .eq('user_id', options.userId)
    .is('revoked_at', null)
    .select('id')
    .maybeSingle<{ id: string }>();
  if (error) throw new Error(`mac-companion-device-revoke-failed:${error.message}`);
  return Boolean(data);
}
