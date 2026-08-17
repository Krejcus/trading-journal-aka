import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  authorizeTradovateCopierDevice,
  hashTradovateCopierDeviceSecret,
  validateTradovateCopierDevicePublicKey,
} from '../server/tradovateCopierDevice';

const rsaPublicKey = (modulusLength: number): string => generateKeyPairSync('rsa', {
  modulusLength,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
}).publicKey;

const deviceId = '11111111-1111-4111-8111-111111111111';
const connectionId = '22222222-2222-4222-8222-222222222222';
const userId = '33333333-3333-4333-8333-333333333333';
const secret = 'a'.repeat(43);

function authorizationDb(options: { storedSecret?: string; revoked?: boolean } = {}): SupabaseClient {
  const row = {
    id: deviceId,
    user_id: userId,
    connection_id: connectionId,
    environment: 'demo',
    device_name: 'Test Mac',
    secret_hash: hashTradovateCopierDeviceSecret(options.storedSecret ?? secret),
    public_key: rsaPublicKey(3072),
    revoked_at: options.revoked ? new Date().toISOString() : null,
  };
  const selectQuery = {
    eq: () => selectQuery,
    maybeSingle: async () => ({ data: row, error: null }),
  };
  const updateQuery = {
    eq: () => updateQuery,
    is: async () => ({ data: null, error: null }),
  };
  return {
    from: () => ({
      select: () => selectQuery,
      update: () => updateQuery,
    }),
  } as unknown as SupabaseClient;
}

describe('Tradovate copier device credential', () => {
  it('přijme pouze RSA klíč o velikosti alespoň 3072 bitů', () => {
    expect(() => validateTradovateCopierDevicePublicKey(rsaPublicKey(3072))).not.toThrow();
    expect(() => validateTradovateCopierDevicePublicKey(rsaPublicKey(2048))).toThrow('rsa-3072');
  });

  it('autorizuje správný revokovatelný device secret bez vrácení jeho hashe', async () => {
    await expect(authorizeTradovateCopierDevice({
      db: authorizationDb(),
      authorization: `Device ${deviceId}.${secret}`,
    })).resolves.toEqual({
      id: deviceId,
      userId,
      connectionId,
      publicKey: expect.stringContaining('BEGIN PUBLIC KEY'),
      deviceName: 'Test Mac',
    });
  });

  it('odmítne chybný secret i odvolané zařízení stejnou obecnou chybou', async () => {
    await expect(authorizeTradovateCopierDevice({
      db: authorizationDb({ storedSecret: 'b'.repeat(43) }),
      authorization: `Device ${deviceId}.${secret}`,
    })).rejects.toThrow('invalid-copier-device-auth');
    await expect(authorizeTradovateCopierDevice({
      db: authorizationDb({ revoked: true }),
      authorization: `Device ${deviceId}.${secret}`,
    })).rejects.toThrow('invalid-copier-device-auth');
  });
});
