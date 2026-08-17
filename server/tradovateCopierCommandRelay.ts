import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { LocalCopierAgentCommand, LocalCopierAgentCommandResult, LocalCopierAgentStatus } from '../lib/localCopierAgentProtocol.js';

export interface CopierRelayCommand {
  id: string;
  command: LocalCopierAgentCommand;
  expiresAt: string;
}

interface CommandRow {
  id: string;
  command_type: LocalCopierAgentCommand['type'];
  payload: Record<string, unknown>;
  expires_at: string;
  status: string;
  result: unknown;
  error: string | null;
}

const allowed = new Set<LocalCopierAgentCommand['type']>([
  'copy-command', 'arm-live', 'shadow', 'disarm', 'kill-switch',
]);

const commandPayload = (command: LocalCopierAgentCommand): Record<string, unknown> => {
  if (!allowed.has(command.type) || command.type === 'device-paired') throw new Error('unsupported-relay-command');
  if (command.type === 'copy-command') {
    // The browser relay exists only to synchronize the already configured group
    // before an explicit ARM. Broker-write commands (Flatten, cancel, etc.) are
    // deliberately not accepted through this remote path.
    if (!['update-group', 'set-group-enabled', 'set-replication', 'set-multiplier'].includes(command.command.type)) {
      throw new Error('unsupported-remote-copy-command');
    }
    return { command: command.command };
  }
  return {};
};

const rowCommand = (row: CommandRow): LocalCopierAgentCommand => {
  if (!allowed.has(row.command_type) || row.command_type === 'device-paired') throw new Error('unsupported-relay-command');
  if (row.command_type === 'copy-command') {
    if (!row.payload?.command || typeof row.payload.command !== 'object') throw new Error('invalid-relay-command-payload');
    const command = row.payload.command as { type?: string };
    if (!['update-group', 'set-group-enabled', 'set-replication', 'set-multiplier'].includes(String(command.type))) {
      throw new Error('unsupported-remote-copy-command');
    }
    return { type: 'copy-command', command: command as never };
  }
  return { type: row.command_type } as LocalCopierAgentCommand;
};

export async function enqueueTradovateCopierCommand(options: {
  db: SupabaseClient;
  userId: string;
  connectionId: string;
  command: LocalCopierAgentCommand;
  idempotencyKey?: string;
  now?: number;
}): Promise<{ id: string; status: string; expiresAt: string }> {
  const now = options.now ?? Date.now();
  const idempotencyKey = options.idempotencyKey?.trim() || randomUUID();
  const { data: device, error: deviceError } = await options.db
    .from('tradovate_copier_devices')
    .select('id')
    .eq('user_id', options.userId)
    .eq('connection_id', options.connectionId)
    .is('revoked_at', null)
    .order('last_used_at', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle<{ id: string }>();
  if (deviceError) throw new Error(`copier-relay-device-lookup-failed: ${deviceError.message}`);
  if (!device) throw new Error('copier-relay-device-not-found');

  const expiresAt = new Date(now + 30_000).toISOString();
  const { data, error } = await options.db.from('tradovate_copier_commands').upsert({
    user_id: options.userId,
    device_id: device.id,
    connection_id: options.connectionId,
    command_type: options.command.type,
    payload: commandPayload(options.command),
    idempotency_key: idempotencyKey,
    status: 'pending',
    created_at: new Date(now).toISOString(),
    expires_at: expiresAt,
  }, { onConflict: 'user_id,device_id,idempotency_key', ignoreDuplicates: true })
    .select('id,status,expires_at')
    .maybeSingle<{ id: string; status: string; expires_at: string }>();
  if (error) throw new Error(`copier-relay-enqueue-failed: ${error.message}`);
  if (data) return { id: data.id, status: data.status, expiresAt: data.expires_at };
  const { data: existing, error: existingError } = await options.db
    .from('tradovate_copier_commands')
    .select('id,status,expires_at')
    .eq('user_id', options.userId)
    .eq('device_id', device.id)
    .eq('idempotency_key', idempotencyKey)
    .single<{ id: string; status: string; expires_at: string }>();
  if (existingError || !existing) throw new Error(`copier-relay-idempotency-lookup-failed: ${existingError?.message ?? 'missing'}`);
  return { id: existing.id, status: existing.status, expiresAt: existing.expires_at };
}

export async function readTradovateCopierCommand(options: { db: SupabaseClient; userId: string; commandId: string }) {
  const { data, error } = await options.db.from('tradovate_copier_commands')
    .select('id,status,expires_at,result,error')
    .eq('id', options.commandId).eq('user_id', options.userId).maybeSingle<CommandRow>();
  if (error) throw new Error(`copier-relay-status-failed: ${error.message}`);
  if (!data) throw new Error('copier-relay-command-not-found');
  return { id: data.id, status: data.status, expiresAt: data.expires_at, result: data.result, error: data.error };
}

export async function claimTradovateCopierCommand(options: { db: SupabaseClient; deviceId: string }): Promise<CopierRelayCommand | null> {
  const { data, error } = await options.db.rpc('claim_tradovate_copier_command', { target_device_id: options.deviceId });
  if (error) throw new Error(`copier-relay-claim-failed: ${error.message}`);
  const row = (Array.isArray(data) ? data[0] : null) as CommandRow | undefined;
  return row ? { id: row.id, command: rowCommand(row), expiresAt: row.expires_at } : null;
}

export async function completeTradovateCopierCommand(options: {
  db: SupabaseClient; deviceId: string; commandId: string; result?: LocalCopierAgentCommandResult; error?: string;
}): Promise<boolean> {
  const succeeded = !options.error;
  const { data, error } = await options.db.from('tradovate_copier_commands').update({
    status: succeeded ? 'succeeded' : 'rejected', completed_at: new Date().toISOString(),
    result: succeeded ? (options.result ?? { ok: true }) : null,
    error: options.error?.slice(0, 500) ?? null,
  }).eq('id', options.commandId).eq('device_id', options.deviceId).eq('status', 'claimed').select('id').maybeSingle<{ id: string }>();
  if (error) throw new Error(`copier-relay-complete-failed: ${error.message}`);
  return Boolean(data);
}

export async function heartbeatTradovateCopierDevice(options: {
  db: SupabaseClient; deviceId: string; userId: string; connectionId: string; status: LocalCopierAgentStatus;
}): Promise<void> {
  const safeStatus = { ...options.status, nonce: '' };
  const { error } = await options.db.from('tradovate_copier_device_runtime').upsert({
    device_id: options.deviceId, user_id: options.userId, connection_id: options.connectionId,
    status: safeStatus, last_seen_at: new Date().toISOString(), started_at: options.status.startedAt,
  }, { onConflict: 'device_id' });
  if (error) throw new Error(`copier-relay-heartbeat-failed: ${error.message}`);
}

export async function readTradovateCopierDeviceRuntime(options: { db: SupabaseClient; userId: string; connectionId: string }) {
  const { data, error } = await options.db.from('tradovate_copier_device_runtime')
    .select('status,last_seen_at').eq('user_id', options.userId).eq('connection_id', options.connectionId)
    .order('last_seen_at', { ascending: false }).limit(1).maybeSingle<{ status: LocalCopierAgentStatus; last_seen_at: string }>();
  if (error) throw new Error(`copier-relay-runtime-status-failed: ${error.message}`);
  if (!data) return null;
  return { status: data.status, lastSeenAt: data.last_seen_at, connected: Date.now() - Date.parse(data.last_seen_at) < 10_000 };
}
