import {
  createHash,
  createPublicKey,
  timingSafeEqual,
} from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEVICE_SECRET = /^[A-Za-z0-9_-]{43,128}$/;

interface CopierDeviceRow {
  id: string;
  user_id: string;
  connection_id: string;
  environment: 'demo';
  device_name: string;
  secret_hash: string;
  public_key: string;
  revoked_at: string | null;
}

export interface AuthorizedTradovateCopierDevice {
  id: string;
  userId: string;
  connectionId: string;
  publicKey: string;
  deviceName: string;
}

export const hashTradovateCopierDeviceSecret = (secret: string): string =>
  createHash('sha256').update(secret, 'utf8').digest('hex');

export function validateTradovateCopierDevicePublicKey(publicKey: string): void {
  const key = createPublicKey(publicKey);
  if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 3072) {
    throw new Error('copier-device-public-key-must-be-rsa-3072');
  }
}

export async function registerTradovateCopierDevice(options: {
  db: SupabaseClient;
  userId: string;
  connectionId: string;
  deviceId: string;
  deviceSecret: string;
  publicKey: string;
  deviceName: string;
  now?: number;
}): Promise<void> {
  if (!UUID.test(options.deviceId) || !UUID.test(options.connectionId)) throw new Error('invalid-copier-device-id');
  if (!DEVICE_SECRET.test(options.deviceSecret)) throw new Error('invalid-copier-device-secret');
  const deviceName = options.deviceName.trim();
  if (deviceName.length < 1 || deviceName.length > 120) throw new Error('invalid-copier-device-name');
  validateTradovateCopierDevicePublicKey(options.publicKey);

  const { data: connection, error: connectionError } = await options.db
    .from('tradovate_oauth_connections')
    .select('id')
    .eq('id', options.connectionId)
    .eq('user_id', options.userId)
    .eq('environment', 'demo')
    .eq('connection_status', 'connected')
    .maybeSingle<{ id: string }>();
  if (connectionError) throw new Error(`copier-device-connection-lookup-failed: ${connectionError.message}`);
  if (!connection) throw new Error('tradovate-connection-not-found');

  const { data: existing, error: existingError } = await options.db
    .from('tradovate_copier_devices')
    .select('user_id')
    .eq('id', options.deviceId)
    .maybeSingle<{ user_id: string }>();
  if (existingError) throw new Error(`copier-device-lookup-failed: ${existingError.message}`);
  if (existing && existing.user_id !== options.userId) throw new Error('copier-device-id-conflict');

  const { error } = await options.db.from('tradovate_copier_devices').upsert({
    id: options.deviceId,
    user_id: options.userId,
    connection_id: options.connectionId,
    environment: 'demo',
    device_name: deviceName,
    secret_hash: hashTradovateCopierDeviceSecret(options.deviceSecret),
    public_key: options.publicKey,
    created_at: new Date(options.now ?? Date.now()).toISOString(),
    last_used_at: null,
    revoked_at: null,
  }, { onConflict: 'id' });
  if (error) throw new Error(`copier-device-save-failed: ${error.message}`);
}

export async function authorizeTradovateCopierDevice(options: {
  db: SupabaseClient;
  authorization: string | undefined;
  now?: number;
}): Promise<AuthorizedTradovateCopierDevice> {
  const match = /^Device ([0-9a-f-]{36})\.([A-Za-z0-9_-]{43,128})$/i.exec(options.authorization ?? '');
  if (!match || !UUID.test(match[1])) throw new Error('invalid-copier-device-auth');
  const [, deviceId, secret] = match;
  const { data, error } = await options.db
    .from('tradovate_copier_devices')
    .select('id,user_id,connection_id,environment,device_name,secret_hash,public_key,revoked_at')
    .eq('id', deviceId)
    .maybeSingle<CopierDeviceRow>();
  if (error) throw new Error(`copier-device-auth-lookup-failed: ${error.message}`);
  if (!data || data.revoked_at || data.environment !== 'demo') throw new Error('invalid-copier-device-auth');
  const actual = Buffer.from(hashTradovateCopierDeviceSecret(secret), 'hex');
  const expected = Buffer.from(data.secret_hash, 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error('invalid-copier-device-auth');
  }
  const { error: touchError } = await options.db
    .from('tradovate_copier_devices')
    .update({ last_used_at: new Date(options.now ?? Date.now()).toISOString() })
    .eq('id', deviceId)
    .is('revoked_at', null);
  if (touchError) throw new Error(`copier-device-touch-failed: ${touchError.message}`);
  return {
    id: data.id,
    userId: data.user_id,
    connectionId: data.connection_id,
    publicKey: data.public_key,
    deviceName: data.device_name,
  };
}

export async function revokeTradovateCopierDevice(options: {
  db: SupabaseClient;
  userId: string;
  deviceId: string;
  now?: number;
}): Promise<boolean> {
  if (!UUID.test(options.deviceId)) throw new Error('invalid-copier-device-id');
  const { data, error } = await options.db
    .from('tradovate_copier_devices')
    .update({ revoked_at: new Date(options.now ?? Date.now()).toISOString() })
    .eq('id', options.deviceId)
    .eq('user_id', options.userId)
    .is('revoked_at', null)
    .select('id')
    .maybeSingle<{ id: string }>();
  if (error) throw new Error(`copier-device-revoke-failed: ${error.message}`);
  return Boolean(data);
}
