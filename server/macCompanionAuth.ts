import { createHash, timingSafeEqual } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  MAC_COMPANION_AUDIENCE,
  MAC_COMPANION_SCOPE,
} from '../lib/macCompanionContract.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEVICE_SECRET = /^[A-Za-z0-9_-]{43}$/;

export interface MacCompanionDeviceRow {
  id: string;
  user_id: string | null;
  device_name: string;
  platform: 'macos';
  secret_hash: string;
  pairing_code_hash: string | null;
  pairing_expires_at: string | null;
  audience: typeof MAC_COMPANION_AUDIENCE;
  scope: typeof MAC_COMPANION_SCOPE;
  created_at: string;
  paired_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  updated_at: string;
}

export interface AuthorizedMacCompanion {
  id: string;
  userId: string | null;
  deviceName: string;
  scope: typeof MAC_COMPANION_SCOPE;
  pairedAt: string | null;
  pairingExpiresAt: string | null;
}

export const hashMacCompanionSecret = (secret: string): string =>
  createHash('sha256').update(secret, 'utf8').digest('hex');

export const normalizeSha256Hex = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(normalized) ? normalized : null;
};

export const parseMacCompanionAuthorization = (
  authorization: string | undefined,
): { deviceId: string; secret: string } | null => {
  const match = /^AlphaTradeCompanion ([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/i.exec(
    authorization ?? '',
  );
  if (!match || !UUID.test(match[1]) || !DEVICE_SECRET.test(match[2])) return null;
  return { deviceId: match[1], secret: match[2] };
};

const sameDigest = (actualHex: string, expectedHex: string): boolean => {
  if (!/^[0-9a-f]{64}$/.test(expectedHex)) return false;
  const actual = Buffer.from(actualHex, 'hex');
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

export async function authorizeMacCompanion(options: {
  db: SupabaseClient;
  authorization: string | undefined;
  allowUnpaired?: boolean;
  now?: number;
}): Promise<AuthorizedMacCompanion> {
  const credential = parseMacCompanionAuthorization(options.authorization);
  if (!credential) throw new Error('invalid-mac-companion-auth');

  const { data, error } = await options.db
    .from('mac_companion_devices')
    .select([
      'id', 'user_id', 'device_name', 'platform', 'secret_hash',
      'pairing_code_hash', 'pairing_expires_at', 'audience', 'scope',
      'created_at', 'paired_at', 'last_used_at', 'revoked_at', 'updated_at',
    ].join(','))
    .eq('id', credential.deviceId)
    .maybeSingle<MacCompanionDeviceRow>();
  if (error) throw new Error(`mac-companion-auth-lookup-failed:${error.message}`);

  const valid = data
    && data.revoked_at == null
    && data.platform === 'macos'
    && data.audience === MAC_COMPANION_AUDIENCE
    && data.scope === MAC_COMPANION_SCOPE
    && sameDigest(hashMacCompanionSecret(credential.secret), data.secret_hash)
    && (options.allowUnpaired === true || (data.user_id != null && data.paired_at != null));
  if (!valid) throw new Error('invalid-mac-companion-auth');

  const now = options.now ?? Date.now();
  const lastUsedAt = Date.parse(data.last_used_at ?? '');
  if (data.user_id && (!Number.isFinite(lastUsedAt) || now - lastUsedAt >= 60_000)) {
    // This timestamp is device-list observability only. A failed touch must not
    // turn an otherwise valid read-only status request into an outage.
    await options.db
      .from('mac_companion_devices')
      .update({ last_used_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString() })
      .eq('id', data.id)
      .is('revoked_at', null);
  }

  return {
    id: data.id,
    userId: data.user_id,
    deviceName: data.device_name,
    scope: MAC_COMPANION_SCOPE,
    pairedAt: data.paired_at,
    pairingExpiresAt: data.pairing_expires_at,
  };
}
