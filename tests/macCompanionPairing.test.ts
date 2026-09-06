import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { hashMacCompanionSecret, type MacCompanionDeviceRow } from '../server/macCompanionAuth';
import {
  confirmMacCompanionPairing,
  hashMacCompanionPairingCode,
  macCompanionPairingStatus,
  normalizeMacCompanionPairingCode,
  startMacCompanionPairing,
} from '../server/macCompanionPairing';

const NOW = Date.parse('2026-09-01T10:00:00.000Z');
const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const SECRET = 'A'.repeat(43);
const CODE = '7K2DP9HX4M6R';

describe('mac companion pairing', () => {
  it('normalizes a human code without accepting ambiguous or short inputs', () => {
    expect(normalizeMacCompanionPairingCode('7k2d-p9hx-4m6r')).toBe(CODE);
    expect(normalizeMacCompanionPairingCode('7K2D-O9HX-4M6R')).toBeNull();
    expect(normalizeMacCompanionPairingCode('7K2D-P9HX')).toBeNull();
  });

  it('starts pairing with hashes only and a server-owned expiry', async () => {
    let inserted: Record<string, unknown> | null = null;
    const db = {
      from: () => ({
        insert: async (value: Record<string, unknown>) => {
          inserted = value;
          return { error: null };
        },
      }),
    } as unknown as SupabaseClient;
    const result = await startMacCompanionPairing({
      db,
      contractVersion: 1,
      deviceId: DEVICE_ID,
      deviceName: ' Filipův Mac ',
      deviceSecretHash: hashMacCompanionSecret(SECRET),
      pairingCodeHash: hashMacCompanionPairingCode(CODE),
      now: NOW,
    });

    expect(result).toEqual({
      contractVersion: 1,
      pairingId: DEVICE_ID,
      expiresAt: new Date(NOW + 10 * 60_000).toISOString(),
      pollAfterSeconds: 2,
      created: true,
    });
    expect(inserted).toMatchObject({
      id: DEVICE_ID,
      device_name: 'Filipův Mac',
      platform: 'macos',
      audience: 'mac-companion',
      scope: 'copier.status.read',
      secret_hash: hashMacCompanionSecret(SECRET),
      pairing_code_hash: hashMacCompanionPairingCode(CODE),
    });
    expect(JSON.stringify(inserted)).not.toContain(SECRET);
    expect(JSON.stringify(inserted)).not.toContain(CODE);
  });

  it('expires pairing status at the same exact boundary used by confirmation', () => {
    const expiresAt = new Date(NOW + 1_000).toISOString();
    expect(macCompanionPairingStatus({
      deviceId: DEVICE_ID,
      userId: null,
      scope: 'copier.status.read',
      pairingExpiresAt: expiresAt,
      now: NOW + 999,
    })).toMatchObject({ paired: false, expiresAt });
    expect(() => macCompanionPairingStatus({
      deviceId: DEVICE_ID,
      userId: null,
      scope: 'copier.status.read',
      pairingExpiresAt: expiresAt,
      now: NOW + 1_000,
    })).toThrow('pairing-expired');
  });

  it('claims an unexpired code once and returns only allowlisted device metadata', async () => {
    let update: Record<string, unknown> | null = null;
    const pairedRow: MacCompanionDeviceRow = {
      id: DEVICE_ID,
      user_id: USER_ID,
      device_name: 'Filipův Mac',
      platform: 'macos',
      secret_hash: hashMacCompanionSecret(SECRET),
      pairing_code_hash: null,
      pairing_expires_at: null,
      audience: 'mac-companion',
      scope: 'copier.status.read',
      created_at: new Date(NOW - 1_000).toISOString(),
      paired_at: new Date(NOW).toISOString(),
      last_used_at: null,
      revoked_at: null,
      updated_at: new Date(NOW).toISOString(),
    };
    const query = {
      eq: () => query,
      is: () => query,
      gt: () => query,
      select: () => query,
      maybeSingle: async () => ({ data: pairedRow, error: null }),
    };
    const db = {
      from: () => ({
        update: (value: Record<string, unknown>) => {
          update = value;
          return query;
        },
      }),
    } as unknown as SupabaseClient;

    const result = await confirmMacCompanionPairing({
      db,
      userId: USER_ID,
      pairingCode: '7k2d-p9hx-4m6r',
      now: NOW,
    });
    expect(update).toMatchObject({
      user_id: USER_ID,
      pairing_code_hash: null,
      pairing_expires_at: null,
    });
    expect(result).toEqual({
      id: DEVICE_ID,
      deviceName: 'Filipův Mac',
      createdAt: new Date(NOW - 1_000).toISOString(),
      pairedAt: new Date(NOW).toISOString(),
      lastSeenAt: null,
      revokedAt: null,
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain('secret_hash');
  });
});
