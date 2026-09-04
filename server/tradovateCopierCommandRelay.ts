import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { LocalCopierAgentCommand, LocalCopierAgentStatus } from '../lib/localCopierAgentProtocol.js';
import type { CopyGroupConfig } from '../services/liveCopyTrading.js';
import { sanitizeCopyGroups } from '../services/liveCopyTrading.js';

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

export interface PersistedCopierTradeInput {
  tradeId: string;
  episodeId: string | null;
  symbol: string;
  side: 'Long' | 'Short';
  quantity: number;
  realizedPnlUsd: number | null;
  followerCount: number;
  openedAt: string | null;
  closedAt: string;
  exitReason: 'sl' | 'tp' | 'manual' | null;
  entryPrice: number | null;
  exitPrice: number | null;
}

const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** Redukuje heartbeat na malý, validovaný a idempotentní ledger close událostí. */
export function closedTradesFromStatus(status: LocalCopierAgentStatus): PersistedCopierTradeInput[] {
  const candidates = status.controller.dailyStats?.recentClosedTrades;
  if (!Array.isArray(candidates)) return [];
  const unique = new Map<string, PersistedCopierTradeInput>();
  for (const candidate of candidates.slice(0, 20)) {
    const tradeId = typeof candidate?.id === 'string' ? candidate.id.trim().slice(0, 160) : '';
    const episodeId = typeof candidate?.episodeId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate.episodeId)
      ? candidate.episodeId
      : null;
    const symbol = typeof candidate?.symbol === 'string' ? candidate.symbol.trim().slice(0, 32) : '';
    const quantity = finite(candidate?.quantity);
    const closedAt = finite(candidate?.closedAt);
    const openedAt = finite(candidate?.openedAt);
    const exitReason = candidate?.exitReason === 'sl' || candidate?.exitReason === 'tp' || candidate?.exitReason === 'manual'
      ? candidate.exitReason
      : null;
    if (!tradeId || !symbol || !quantity || quantity <= 0 || !closedAt || closedAt <= 0
      || (candidate?.side !== 'Long' && candidate?.side !== 'Short')) continue;
    unique.set(tradeId, {
      tradeId,
      episodeId,
      symbol,
      side: candidate.side,
      quantity,
      realizedPnlUsd: finite(candidate.realizedPnlUsd),
      followerCount: Math.max(0, Math.floor(finite(candidate.followerCount) ?? 0)),
      openedAt: openedAt && openedAt > 0 ? new Date(openedAt).toISOString() : null,
      closedAt: new Date(closedAt).toISOString(),
      exitReason,
      entryPrice: finite(candidate.avgEntryPrice),
      exitPrice: finite(candidate.avgExitPrice),
    });
  }
  return [...unique.values()];
}

const allowed = new Set<LocalCopierAgentCommand['type']>([
  'copy-command', 'arm-live', 'activate-group', 'shadow', 'disarm', 'kill-switch',
  'verify-account-eligibility', 'snapshot-test',
  // Denní lock je čistě riziko snižující: worker DISARMuje a zakáže ARM do
  // konce broker session. Patří do stejné vzdálené třídy jako disarm a
  // kill-switch — bez něj „Zamknout den" z produkční PWA nikdy nedorazil.
  'lock-until-session-end',
  'unlock-day',
]);

/**
 * Důvod denního locku přichází z nevalidovaného JSON. Přenáší se do
 * `dayLockReason` a zobrazuje v UI, proto jen krátký čistý text.
 */
const validatedDayLockReason = (value: unknown): string => {
  if (typeof value !== 'string') throw new Error('invalid-relay-command-payload');
  const reason = value.trim();
  if (reason.length < 3 || reason.length > 200 || /[\u0000-\u001f\u007f]/.test(reason)) {
    throw new Error('invalid-relay-command-payload');
  }
  return reason;
};

// The browser relay exists to synchronize the already configured group before
// an explicit ARM — plus the risk-reducing emergency brakes. Flatten only
// cancels working orders and closes positions to zero (planFlatten never
// increases |exposure| nor flips direction), so it belongs to the same remote
// class as disarm/kill-switch: the panic button must work from Safari and the
// iPhone app, where the direct loopback agent is unreachable. Every other
// broker-write command (cancel-order, replication changes mid-flight, …)
// stays deliberately rejected on this remote path.
const remoteCopyCommands = new Set([
  'update-group', 'set-group-enabled', 'set-replication', 'set-multiplier',
  'flatten-account', 'flatten-group',
]);

// Stejný formát vynucuje controller (operationToken); validace už na ingressu
// brání tomu, aby vadný Flatten doputoval k workerovi — ten před validací
// příkazu DISARMuje a vadný payload by tak vyrobil zbytečný fail-closed.
const OPERATION_ID_PATTERN = /^[a-zA-Z0-9:_-]{8,120}$/;

/**
 * Tělo copy-commandu přichází z nevalidovaného JSON (request body / DB řádek)
 * — typová anotace nic nezaručuje. Whitelist + strukturální kontrola musí být
 * na enqueue i claim straně identická (obrana do hloubky proti ručně
 * vloženému řádku).
 */
const validatedRemoteCopyCommand = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object') throw new Error('invalid-relay-command-payload');
  const command = value as {
    type?: unknown;
    groupId?: unknown;
    accountId?: unknown;
    operationId?: unknown;
    waiveUnverifiableFollowerOwnership?: unknown;
  };
  if (typeof command.type !== 'string' || !remoteCopyCommands.has(command.type)) {
    throw new Error('unsupported-remote-copy-command');
  }
  if (command.type === 'flatten-account' || command.type === 'flatten-group') {
    if (typeof command.groupId !== 'string' || command.groupId.trim() === '') {
      throw new Error('invalid-relay-command-payload');
    }
    if (typeof command.operationId !== 'string' || !OPERATION_ID_PATTERN.test(command.operationId.trim())) {
      throw new Error('invalid-relay-command-payload');
    }
    if (command.type === 'flatten-account'
      && (typeof command.accountId !== 'number' || !Number.isSafeInteger(command.accountId) || command.accountId <= 0)) {
      throw new Error('invalid-relay-command-payload');
    }
  }
  if (
    command.type === 'update-group'
    && command.waiveUnverifiableFollowerOwnership !== undefined
    && command.waiveUnverifiableFollowerOwnership !== true
  ) throw new Error('invalid-relay-command-payload');
  return command as Record<string, unknown>;
};

/**
 * ARM nese konfiguraci skupiny, protože UI je autoritativní pro násobky,
 * režimy a `safety` (denní ztrátový limit, cooldown, chování při expiraci).
 * Relay ji dřív tiše zahazoval a worker se ozbrojil se svojí starou
 * konfigurací — z telefonu se tak dal ARM provést bez denního limitu.
 * Skupina je nedůvěryhodný vstup, proto prochází stejnou strukturální
 * sanitizací na obou koncích.
 */
const validatedRelayGroup = (value: unknown): CopyGroupConfig => {
  const groups = sanitizeCopyGroups([value]);
  if (!groups || groups.length !== 1) throw new Error('invalid-relay-command');
  return groups[0];
};

const validatedEligibilityExclusions = (value: unknown) => {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 100) throw new Error('invalid-relay-command-payload');
  const unique = new Map<number, { accountId: number; state: 'dll-locked' | 'breached'; reason: string }>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') throw new Error('invalid-relay-command-payload');
    const entry = candidate as { accountId?: unknown; state?: unknown; reason?: unknown };
    if (typeof entry.accountId !== 'number' || !Number.isSafeInteger(entry.accountId) || entry.accountId <= 0) {
      throw new Error('invalid-relay-command-payload');
    }
    if (entry.state !== 'dll-locked' && entry.state !== 'breached') {
      throw new Error('invalid-relay-command-payload');
    }
    if (typeof entry.reason !== 'string' || entry.reason.trim().length < 3 || entry.reason.trim().length > 500) {
      throw new Error('invalid-relay-command-payload');
    }
    unique.set(entry.accountId, {
      accountId: entry.accountId,
      state: entry.state,
      reason: entry.reason.trim(),
    });
  }
  return [...unique.values()];
};

const commandPayload = (command: LocalCopierAgentCommand): Record<string, unknown> => {
  if (!allowed.has(command.type) || command.type === 'device-paired') throw new Error('unsupported-relay-command');
  if (command.type === 'copy-command') {
    return { command: validatedRemoteCopyCommand((command as { command?: unknown }).command) };
  }
  if (command.type === 'arm-live') {
    // ARM bez skupiny se dřív tiše převedl na {} a worker se ozbrojil se
    // svou zastaralou konfigurací — 24. 8. s enabled:false, takže se první
    // obchod nezkopíroval. UI skupinu posílá vždy; její absence je chyba
    // volajícího a musí selhat nahlas, ne potichu změnit význam příkazu.
    return {
      group: validatedRelayGroup((command as { group?: unknown }).group),
      accountEligibilityExclusions: validatedEligibilityExclusions(
        (command as { accountEligibilityExclusions?: unknown }).accountEligibilityExclusions,
      ),
    };
  }
  if (command.type === 'activate-group') {
    const waiver = (command as { waiveUnverifiableFollowerOwnership?: unknown })
      .waiveUnverifiableFollowerOwnership;
    if (waiver !== undefined && waiver !== true) throw new Error('invalid-relay-command-payload');
    return {
      group: validatedRelayGroup((command as { group?: unknown }).group),
      ...(waiver === true ? { waiveUnverifiableFollowerOwnership: true } : {}),
    };
  }
  if (command.type === 'shadow') {
    return {
      accountEligibilityExclusions: validatedEligibilityExclusions(
        (command as { accountEligibilityExclusions?: unknown }).accountEligibilityExclusions,
      ),
    };
  }
  if (command.type === 'verify-account-eligibility') {
    if (!Number.isSafeInteger(command.accountId) || command.accountId <= 0) {
      throw new Error('invalid-relay-command-payload');
    }
    return { accountId: command.accountId };
  }
  if (command.type === 'snapshot-test') {
    return command.repairCamera === true ? { repairCamera: true } : {};
  }
  if (command.type === 'lock-until-session-end' || command.type === 'unlock-day') {
    return { reason: validatedDayLockReason((command as { reason?: unknown }).reason) };
  }
  return {};
};

const rowCommand = (row: CommandRow): LocalCopierAgentCommand => {
  if (!allowed.has(row.command_type) || row.command_type === 'device-paired') throw new Error('unsupported-relay-command');
  if (row.command_type === 'copy-command') {
    return { type: 'copy-command', command: validatedRemoteCopyCommand(row.payload?.command) as never };
  }
  if (row.command_type === 'arm-live') {
    return {
      type: 'arm-live',
      group: validatedRelayGroup(row.payload?.group),
      accountEligibilityExclusions: validatedEligibilityExclusions(row.payload?.accountEligibilityExclusions),
    };
  }
  if (row.command_type === 'activate-group') {
    const waiver = row.payload?.waiveUnverifiableFollowerOwnership;
    if (waiver !== undefined && waiver !== true) throw new Error('invalid-relay-command-payload');
    return {
      type: 'activate-group',
      group: validatedRelayGroup(row.payload?.group),
      ...(waiver === true ? { waiveUnverifiableFollowerOwnership: true } : {}),
    };
  }
  if (row.command_type === 'shadow') {
    return {
      type: 'shadow',
      accountEligibilityExclusions: validatedEligibilityExclusions(row.payload?.accountEligibilityExclusions),
    };
  }
  if (row.command_type === 'verify-account-eligibility') {
    const accountId = row.payload?.accountId;
    if (typeof accountId !== 'number' || !Number.isSafeInteger(accountId) || accountId <= 0) {
      throw new Error('invalid-relay-command-payload');
    }
    return { type: 'verify-account-eligibility', accountId };
  }
  if (row.command_type === 'lock-until-session-end' || row.command_type === 'unlock-day') {
    return { type: row.command_type, reason: validatedDayLockReason(row.payload?.reason) };
  }
  if (row.command_type === 'snapshot-test') {
    return {
      type: 'snapshot-test',
      requestId: row.id,
      ...(row.payload?.repairCamera === true ? { repairCamera: true } : {}),
    };
  }
  return { type: row.command_type } as LocalCopierAgentCommand;
};

export async function enqueueTradovateCopierCommand(options: {
  db: SupabaseClient;
  userId: string;
  connectionId: string;
  command: LocalCopierAgentCommand;
  /** Volitelně připne neobchodní požadavek na už ověřený aktivní worker. */
  deviceId?: string;
  idempotencyKey?: string;
  now?: number;
}): Promise<{ id: string; status: string; expiresAt: string; deviceId: string }> {
  const now = options.now ?? Date.now();
  const idempotencyKey = options.idempotencyKey?.trim() || randomUUID();
  let deviceQuery = options.db
    .from('tradovate_copier_devices')
    .select('id')
    .eq('user_id', options.userId)
    .eq('connection_id', options.connectionId)
    .is('revoked_at', null);
  if (options.deviceId) deviceQuery = deviceQuery.eq('id', options.deviceId);
  const { data: device, error: deviceError } = await deviceQuery
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
  if (data) return { id: data.id, status: data.status, expiresAt: data.expires_at, deviceId: device.id };
  const { data: existing, error: existingError } = await options.db
    .from('tradovate_copier_commands')
    .select('id,status,expires_at')
    .eq('user_id', options.userId)
    .eq('device_id', device.id)
    .eq('idempotency_key', idempotencyKey)
    .single<{ id: string; status: string; expires_at: string }>();
  if (existingError || !existing) throw new Error(`copier-relay-idempotency-lookup-failed: ${existingError?.message ?? 'missing'}`);
  return { id: existing.id, status: existing.status, expiresAt: existing.expires_at, deviceId: device.id };
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
  db: SupabaseClient; deviceId: string; commandId: string; result?: unknown; error?: string;
}): Promise<boolean> {
  const succeeded = !options.error;
  const { data, error } = await options.db.from('tradovate_copier_commands').update({
    status: succeeded ? 'succeeded' : 'rejected', completed_at: new Date().toISOString(),
    result: succeeded ? (options.result ?? { ok: true }) : (options.result ?? null),
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
  const trades = closedTradesFromStatus(options.status);
  if (trades.length > 0) {
    const { error: tradeError } = await options.db.from('tradovate_copier_trades').upsert(
      trades.map(trade => ({
        user_id: options.userId,
        device_id: options.deviceId,
        connection_id: options.connectionId,
        trade_id: trade.tradeId,
        episode_id: trade.episodeId,
        symbol: trade.symbol,
        side: trade.side,
        quantity: trade.quantity,
        realized_pnl_usd: trade.realizedPnlUsd,
        follower_count: trade.followerCount,
        opened_at: trade.openedAt,
        closed_at: trade.closedAt,
        exit_reason: trade.exitReason,
        entry_price: trade.entryPrice,
        exit_price: trade.exitPrice,
        updated_at: new Date().toISOString(),
      })),
      { onConflict: 'device_id,trade_id' },
    );
    if (tradeError) throw new Error(`copier-trade-ledger-upsert-failed: ${tradeError.message}`);
  }
}

export async function readTradovateCopierDeviceRuntime(options: { db: SupabaseClient; userId: string; connectionId: string }) {
  const { data, error } = await options.db.from('tradovate_copier_device_runtime')
    .select('status,last_seen_at').eq('user_id', options.userId).eq('connection_id', options.connectionId)
    .order('last_seen_at', { ascending: false }).limit(1).maybeSingle<{ status: LocalCopierAgentStatus; last_seen_at: string }>();
  if (error) throw new Error(`copier-relay-runtime-status-failed: ${error.message}`);
  if (!data) return null;
  return { status: data.status, lastSeenAt: data.last_seen_at, connected: Date.now() - Date.parse(data.last_seen_at) < 10_000 };
}
