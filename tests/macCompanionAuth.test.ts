import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import {
  authorizeMacCompanion,
  hashMacCompanionSecret,
  parseMacCompanionAuthorization,
  type MacCompanionDeviceRow,
} from '../server/macCompanionAuth';

const NOW = Date.parse('2026-09-01T10:00:00.000Z');
const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const SECRET = 'A'.repeat(43);

const row = (overrides: Partial<MacCompanionDeviceRow> = {}): MacCompanionDeviceRow => ({
  id: DEVICE_ID,
  user_id: '22222222-2222-4222-8222-222222222222',
  device_name: 'Filipův Mac',
  platform: 'macos',
  secret_hash: hashMacCompanionSecret(SECRET),
  pairing_code_hash: null,
  pairing_expires_at: null,
  audience: 'mac-companion',
  scope: 'copier.status.read',
  created_at: new Date(NOW - 60_000).toISOString(),
  paired_at: new Date(NOW - 30_000).toISOString(),
  last_used_at: new Date(NOW).toISOString(),
  revoked_at: null,
  updated_at: new Date(NOW).toISOString(),
  ...overrides,
});

const authDb = (device: MacCompanionDeviceRow | null): SupabaseClient => {
  const query = {
    eq: () => query,
    maybeSingle: async () => ({ data: device, error: null }),
  };
  return {
    from: () => ({ select: () => query }),
  } as unknown as SupabaseClient;
};

describe('mac companion credential', () => {
  it('uses a distinct exact scheme and never accepts copier relay credentials', () => {
    expect(parseMacCompanionAuthorization(
      `AlphaTradeCompanion ${DEVICE_ID}.${SECRET}`,
    )).toEqual({ deviceId: DEVICE_ID, secret: SECRET });
    expect(parseMacCompanionAuthorization(`Device ${DEVICE_ID}.${SECRET}`)).toBeNull();
    expect(parseMacCompanionAuthorization(`MacCompanion ${DEVICE_ID}.${SECRET}`)).toBeNull();
    expect(parseMacCompanionAuthorization(`AlphaTradeCompanion ${DEVICE_ID}.${'A'.repeat(42)}`)).toBeNull();
  });

  it('authorizes only the fixed read scope without returning a secret or digest', async () => {
    const result = await authorizeMacCompanion({
      db: authDb(row()),
      authorization: `AlphaTradeCompanion ${DEVICE_ID}.${SECRET}`,
      now: NOW,
    });
    expect(result).toEqual({
      id: DEVICE_ID,
      userId: '22222222-2222-4222-8222-222222222222',
      deviceName: 'Filipův Mac',
      scope: 'copier.status.read',
      pairedAt: new Date(NOW - 30_000).toISOString(),
      pairingExpiresAt: null,
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain(hashMacCompanionSecret(SECRET));
  });

  it('rejects a wrong secret, revocation, wrong scope, and unpaired rows', async () => {
    const authorization = `AlphaTradeCompanion ${DEVICE_ID}.${SECRET}`;
    await expect(authorizeMacCompanion({
      db: authDb(row({ secret_hash: hashMacCompanionSecret('B'.repeat(43)) })),
      authorization,
      now: NOW,
    })).rejects.toThrow('invalid-mac-companion-auth');
    await expect(authorizeMacCompanion({
      db: authDb(row({ revoked_at: new Date(NOW).toISOString() })),
      authorization,
      now: NOW,
    })).rejects.toThrow('invalid-mac-companion-auth');
    await expect(authorizeMacCompanion({
      db: authDb(row({ scope: 'copier.command' as 'copier.status.read' })),
      authorization,
      now: NOW,
    })).rejects.toThrow('invalid-mac-companion-auth');
    await expect(authorizeMacCompanion({
      db: authDb(row({ user_id: null, paired_at: null })),
      authorization,
      now: NOW,
    })).rejects.toThrow('invalid-mac-companion-auth');
  });
});
