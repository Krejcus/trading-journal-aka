import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isWeakerRiskConfig } from '../lib/copierRiskConfig.js';
import type { LocalCopierAgentCommand, LocalCopierAgentStatus } from '../lib/localCopierAgentProtocol.js';
import type { CopyGroupConfig } from '../services/liveCopyTrading.js';
import { sanitizeCopyGroups } from '../services/liveCopyTrading.js';

export interface CopierRelayCommand {
  id: string;
  command: LocalCopierAgentCommand;
  createdAt?: string;
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
  created_at?: string;
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
  /** Leader entry broker order IDs; null from workers older than the copylink screenshot link. */
  leaderEntryOrderIds: string[] | null;
}

const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** Broker order IDs are numeric strings; anything else is not a usable link key. */
const leaderEntryOrderIds = (value: unknown): string[] | null => {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) return null;
  if (!value.every((id): id is string => typeof id === 'string' && /^[0-9]{1,32}$/.test(id))) return null;
  return [...new Set(value)];
};

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
      leaderEntryOrderIds: leaderEntryOrderIds(candidate.leaderEntryOrderIds),
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
  // 8. 10. 2026: samostatná Kontrola pozic z UI zmizela — kontrolu si dělá
  // ON (arm-live), incident maže jen s výslovným potvrzením. Produkční DB
  // check `reconcile` stejně nikdy nepustil, takže se nic neztrácí.
]);

const BRAKE_COMMAND_TYPES = ['disarm', 'kill-switch', 'lock-until-session-end'] as const;
const BRAKE_COMMAND_TTL_MS = 10 * 60_000;
const STANDARD_COMMAND_TTL_MS = 30_000;
const WORKER_CONNECTED_MAX_AGE_MS = 10_000;

const isTradovateCopierBrakeCommand = (command: LocalCopierAgentCommand): boolean =>
  BRAKE_COMMAND_TYPES.includes(command.type as (typeof BRAKE_COMMAND_TYPES)[number]);

/** Sdílené HTTP mapování validačních chyb relay vrstvy. */
export const copierRelayValidationErrorStatus = (message: string): 400 | 409 | null => {
  if (message === 'tighten-only') return 409;
  if (message === 'copier-relay-worker-disconnected'
    || message === 'copier-relay-runtime-not-found'
    || message === 'copier-relay-arm-config-conflict') return 409;
  if (message === 'unsupported-command'
    || message === 'unsupported-relay-command'
    || message === 'unsupported-remote-copy-command'
    || message === 'invalid-relay-command-payload') return 400;
  return null;
};

interface RelayDeviceTarget {
  id: string;
  status?: LocalCopierAgentStatus;
  lastSeenAt?: string;
}

/**
 * Mac patří uživateli, ne propfirmě (5. 10. 2026). UI adresuje worker přes
 * libovolné připojení, které zrovna vidí; runtime i příkazy owner-scope
 * zařízení ale zůstávají vedené pod připojením, přes které byl Mac spárován
 * (i když je dnes odpojené). Vrátí připojení, pod kterým worker opravdu
 * hlásí stav: mezi přímými zařízeními připojení a owner-scope zařízeními
 * uživatele vyhraje nejčerstvější runtime. Cizí připojení se nepřesměruje.
 */
export async function resolveCopierRelayConnectionId(options: {
  db: SupabaseClient;
  userId: string;
  connectionId: string;
}): Promise<string> {
  const { data: owned, error: ownedError } = await options.db.from('tradovate_oauth_connections')
    .select('id')
    .eq('id', options.connectionId)
    .eq('user_id', options.userId)
    .maybeSingle<{ id: string }>();
  if (ownedError) throw new Error(`copier-relay-connection-lookup-failed: ${ownedError.message}`);
  if (!owned) return options.connectionId;
  // Kandidáti: neodvolaná zařízení uživatele přímo pro toto připojení a
  // owner-scope zařízení (Mac pro všechny propfirmy). Před migrací scope
  // dotaz na `scope` selže — pak zůstávají jen přímá zařízení.
  const { data: direct, error: directError } = await options.db.from('tradovate_copier_devices')
    .select('id,connection_id')
    .eq('user_id', options.userId)
    .eq('connection_id', options.connectionId)
    .is('revoked_at', null);
  if (directError) throw new Error(`copier-relay-device-lookup-failed: ${directError.message}`);
  const { data: ownerDevices, error: ownerError } = await options.db.from('tradovate_copier_devices')
    .select('id,connection_id')
    .eq('user_id', options.userId)
    .eq('scope', 'owner')
    .is('revoked_at', null);
  const candidates = [...(direct ?? []), ...(ownerError ? [] : ownerDevices ?? [])] as Array<{ id: string; connection_id: string | null }>;
  if (candidates.length === 0) return options.connectionId;
  const { data: runtimes, error: runtimeError } = await options.db.from('tradovate_copier_device_runtime')
    .select('device_id,connection_id,last_seen_at')
    .eq('user_id', options.userId)
    .in('device_id', [...new Set(candidates.map(device => device.id))])
    .order('last_seen_at', { ascending: false });
  if (runtimeError) throw new Error(`copier-relay-runtime-status-failed: ${runtimeError.message}`);
  const rows = (runtimes ?? []) as Array<{ device_id: string; connection_id: string | null; last_seen_at: string }>;
  // Přednost má živé zařízení přímo tohoto připojení (beze změny proti
  // dřívějšku); owner-scope Mac jen tehdy, když přímé neběží. Mrtvý starý
  // device řádek tak Mac nepřebije, ale živý přímý worker ani není obejit.
  const directIds = new Set((direct ?? []).map((device: { id: string }) => device.id));
  const fresh = (row: { last_seen_at: string }) => Date.now() - Date.parse(row.last_seen_at) < 60_000;
  const liveDirect = rows.find(row => directIds.has(row.device_id) && fresh(row));
  if (liveDirect) return liveDirect.connection_id ?? options.connectionId;
  return rows[0]?.connection_id ?? options.connectionId;
}

/** Selects the freshest runtime only among non-revoked devices. */
const selectRelayDeviceTarget = async (options: {
  db: SupabaseClient;
  userId: string;
  connectionId: string;
  deviceId?: string;
}): Promise<RelayDeviceTarget> => {
  let deviceQuery = options.db.from('tradovate_copier_devices')
    .select('id')
    .eq('user_id', options.userId)
    .eq('connection_id', options.connectionId)
    .is('revoked_at', null);
  if (options.deviceId) deviceQuery = deviceQuery.eq('id', options.deviceId);
  const { data: devices, error: deviceError } = await deviceQuery;
  if (deviceError) throw new Error(`copier-relay-device-lookup-failed: ${deviceError.message}`);
  const activeDeviceIds = (devices ?? []).map(device => device.id);
  if (activeDeviceIds.length === 0) throw new Error('copier-relay-device-not-found');

  const runtimeQuery = options.db.from('tradovate_copier_device_runtime')
    .select('device_id,status,last_seen_at')
    .eq('user_id', options.userId)
    .eq('connection_id', options.connectionId)
    .in('device_id', activeDeviceIds);
  const { data: runtime, error: runtimeError } = await runtimeQuery
    .order('last_seen_at', { ascending: false })
    .limit(1)
    .maybeSingle<{ device_id: string; status: LocalCopierAgentStatus; last_seen_at: string }>();
  if (runtimeError) throw new Error(`copier-relay-runtime-status-failed: ${runtimeError.message}`);
  if (!runtime) throw new Error('copier-relay-runtime-not-found');

  return { id: runtime.device_id, status: runtime.status, lastSeenAt: runtime.last_seen_at };
};

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
  'update-group', 'set-group-enabled', 'set-replication', 'set-follower-enabled', 'set-multiplier',
  'flatten-account', 'flatten-follower-trade', 'flatten-group',
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
    enabled?: unknown;
    mode?: unknown;
    multiplier?: unknown;
    waiveUnverifiableFollowerOwnership?: unknown;
  };
  if (typeof command.type !== 'string' || !remoteCopyCommands.has(command.type)) {
    throw new Error('unsupported-remote-copy-command');
  }
  if (command.type === 'flatten-account' || command.type === 'flatten-follower-trade' || command.type === 'flatten-group') {
    if (typeof command.groupId !== 'string' || command.groupId.trim() === '') {
      throw new Error('invalid-relay-command-payload');
    }
    if (typeof command.operationId !== 'string' || !OPERATION_ID_PATTERN.test(command.operationId.trim())) {
      throw new Error('invalid-relay-command-payload');
    }
    if ((command.type === 'flatten-account' || command.type === 'flatten-follower-trade')
      && (typeof command.accountId !== 'number' || !Number.isSafeInteger(command.accountId) || command.accountId <= 0)) {
      throw new Error('invalid-relay-command-payload');
    }
  }
  if (command.type === 'set-follower-enabled' && (
    typeof command.groupId !== 'string' || command.groupId.trim() === ''
    || typeof command.accountId !== 'number' || !Number.isSafeInteger(command.accountId) || command.accountId <= 0
    || typeof command.enabled !== 'boolean'
  )) throw new Error('invalid-relay-command-payload');
  if (command.type === 'set-multiplier' && (
    typeof command.groupId !== 'string' || command.groupId.trim() === ''
    || typeof command.accountId !== 'number' || !Number.isSafeInteger(command.accountId) || command.accountId <= 0
    || typeof command.multiplier !== 'number' || !Number.isFinite(command.multiplier)
    || command.multiplier <= 0 || command.multiplier > 100
  )) throw new Error('invalid-relay-command-payload');
  if (command.type === 'set-replication' && (
    typeof command.groupId !== 'string' || command.groupId.trim() === ''
    || typeof command.accountId !== 'number' || !Number.isSafeInteger(command.accountId) || command.accountId <= 0
    || (command.mode !== 'off' && command.mode !== 'on-submit' && command.mode !== 'on-fill')
  )) throw new Error('invalid-relay-command-payload');
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

/** Potvrzení incidentu z dialogu ON: čas `manualRecovery.at` (8. 10. 2026). */
const validatedIncidentAck = (value: unknown): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error('invalid-relay-command-payload');
  }
  return value;
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
  // Risk tab v1 ruší odemčení dne bez náhrady. Držíme pro něj
  // samostatný stabilní token, aby HTTP vrstva mohla vrátit přesný
  // `400 unsupported-command`; ostatní legacy typy zachovávají svůj token.
  if (command.type === 'unlock-day') throw new Error('unsupported-command');
  if (!allowed.has(command.type) || command.type === 'device-paired') throw new Error('unsupported-relay-command');
  if (command.type === 'copy-command') {
    return { command: validatedRemoteCopyCommand((command as { command?: unknown }).command) };
  }
  if (command.type === 'arm-live') {
    // ARM bez skupiny se dřív tiše převedl na {} a worker se ozbrojil se
    // svou zastaralou konfigurací — 24. 8. s enabled:false, takže se první
    // obchod nezkopíroval. UI skupinu posílá vždy; její absence je chyba
    // volajícího a musí selhat nahlas, ne potichu změnit význam příkazu.
    const acknowledgeIncidentAt = validatedIncidentAck((command as { acknowledgeIncidentAt?: unknown }).acknowledgeIncidentAt);
    return {
      group: validatedRelayGroup((command as { group?: unknown }).group),
      accountEligibilityExclusions: validatedEligibilityExclusions(
        (command as { accountEligibilityExclusions?: unknown }).accountEligibilityExclusions,
      ),
      ...(acknowledgeIncidentAt != null ? { acknowledgeIncidentAt } : {}),
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
  if (command.type === 'lock-until-session-end') {
    return { reason: validatedDayLockReason((command as { reason?: unknown }).reason) };
  }
  return {};
};

const canonicalJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonicalJson(entry)]));
};

const sameRelayPayload = (left: unknown, right: unknown): boolean =>
  JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));

const rowCommand = (row: CommandRow): LocalCopierAgentCommand => {
  if (row.command_type === 'unlock-day') throw new Error('unsupported-command');
  if (!allowed.has(row.command_type) || row.command_type === 'device-paired') throw new Error('unsupported-relay-command');
  if (row.command_type === 'copy-command') {
    return { type: 'copy-command', command: validatedRemoteCopyCommand(row.payload?.command) as never };
  }
  if (row.command_type === 'arm-live') {
    const acknowledgeIncidentAt = validatedIncidentAck(row.payload?.acknowledgeIncidentAt);
    return {
      type: 'arm-live',
      group: validatedRelayGroup(row.payload?.group),
      accountEligibilityExclusions: validatedEligibilityExclusions(row.payload?.accountEligibilityExclusions),
      ...(acknowledgeIncidentAt != null ? { acknowledgeIncidentAt } : {}),
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
  if (row.command_type === 'lock-until-session-end') {
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

/**
 * Vrátí sanitizovanou konfiguraci pouze pro tři cesty, které mohou
 * změnit denní risk. Flatten/brzdy ani ostatní příkazy touto bránou
 * neprocházejí. Worker tutéž kontrolu provádí autoritativně z durable
 * stavu; relay jen odmítne známé oslabení dřív, než ho zařadí do fronty.
 */
const relayRiskGroup = (
  command: LocalCopierAgentCommand,
  payload: Record<string, unknown>,
  previousGroup: CopyGroupConfig,
): CopyGroupConfig | null => {
  const mapRuntimeParticipation = (incoming: CopyGroupConfig): CopyGroupConfig => (
    incoming.id !== previousGroup.id
      ? incoming
      : {
          ...incoming,
          followers: incoming.followers.map(follower => ({
            ...follower,
            enabled: previousGroup.followers.find(item => item.accountId === follower.accountId)?.enabled !== false,
          })),
        }
  );
  if (command.type === 'arm-live' || command.type === 'activate-group') {
    if (payload.group == null && command.type === 'arm-live') return null;
    return mapRuntimeParticipation(validatedRelayGroup(payload.group));
  }
  if (command.type !== 'copy-command') return null;
  const nested = payload.command as {
    type?: unknown;
    group?: unknown;
    groupId?: unknown;
    accountId?: unknown;
    multiplier?: unknown;
    mode?: unknown;
    enabled?: unknown;
  } | undefined;
  if (nested?.type === 'update-group') {
    return mapRuntimeParticipation(validatedRelayGroup(nested.group));
  }
  if (nested?.type !== 'set-multiplier' && nested?.type !== 'set-replication'
    && nested?.type !== 'set-follower-enabled') return null;
  if (nested.groupId !== previousGroup.id || typeof nested.accountId !== 'number') {
    throw new Error('invalid-relay-command-payload');
  }
  let found = false;
  const followers = previousGroup.followers.map(follower => {
    if (follower.accountId !== nested.accountId) return follower;
    found = true;
    if (nested.type === 'set-multiplier') return { ...follower, multiplier: nested.multiplier as number };
    if (nested.type === 'set-replication') return { ...follower, mode: nested.mode as CopyGroupConfig['followers'][number]['mode'] };
    return { ...follower, enabled: nested.enabled as boolean };
  });
  if (!found) throw new Error('invalid-relay-command-payload');
  return validatedRelayGroup({ ...previousGroup, followers });
};

const relayCommandReducesRiskWithoutBaseline = (payload: Record<string, unknown>): boolean => {
  const nested = payload.command as { type?: unknown; enabled?: unknown; mode?: unknown } | undefined;
  return (nested?.type === 'set-follower-enabled' && nested.enabled === false)
    || (nested?.type === 'set-replication' && nested.mode === 'off');
};

const relayNeedsTightenOnly = (
  command: LocalCopierAgentCommand,
  payload: Record<string, unknown>,
): boolean => {
  if (command.type === 'arm-live' || command.type === 'activate-group') return true;
  if (command.type !== 'copy-command') return false;
  const type = (payload.command as { type?: unknown } | undefined)?.type;
  return type === 'update-group' || type === 'set-multiplier'
    || type === 'set-replication' || type === 'set-follower-enabled';
};

const enforceRelayTightenOnly = async (options: {
  db: SupabaseClient;
  deviceId: string;
  userId: string;
  connectionId: string;
  command: LocalCopierAgentCommand;
  payload: Record<string, unknown>;
}): Promise<void> => {
  const { data, error } = await options.db.from('tradovate_copier_device_runtime')
    .select('status')
    .eq('device_id', options.deviceId)
    .eq('user_id', options.userId)
    .eq('connection_id', options.connectionId)
    .maybeSingle<{ status: LocalCopierAgentStatus }>();
  if (error) throw new Error(`copier-relay-runtime-risk-lookup-failed: ${error.message}`);
  if (!data) return;

  const sessionArmedAt = data.status?.controller?.sessionArmedAt;
  if (typeof sessionArmedAt !== 'number' || !Number.isFinite(sessionArmedAt) || sessionArmedAt <= 0) return;

  // Jakmile worker oznámí tighten-only session, nečitelná poslední
  // konfigurace není důvod povolit změnu. Worker by ji sice znovu hlídal,
  // ale relay nesmí tvrdit, že oslabení bezpečně vyloučil.
  let previousGroup: CopyGroupConfig;
  try {
    previousGroup = validatedRelayGroup(data.status.group);
  } catch {
    if (relayCommandReducesRiskWithoutBaseline(options.payload)) return;
    throw new Error('tighten-only');
  }
  let nextGroup: CopyGroupConfig | null;
  try {
    nextGroup = relayRiskGroup(options.command, options.payload, previousGroup);
  } catch (reason) {
    if (relayCommandReducesRiskWithoutBaseline(options.payload)) return;
    throw reason;
  }
  if (!nextGroup) return;
  // Násobek smí za vypnuté kopírky i růst (1. 10.); autoritativně to
  // hlídá worker podle svého skutečného ARM stavu.
  if (isWeakerRiskConfig(previousGroup, nextGroup, {
    allowMultiplierIncrease: data.status?.controller?.armed === false,
  }).length > 0) {
    throw new Error('tighten-only');
  }
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
  const payload = commandPayload(options.command);
  const device = await selectRelayDeviceTarget({
    db: options.db,
    userId: options.userId,
    connectionId: options.connectionId,
    ...(options.deviceId ? { deviceId: options.deviceId } : {}),
  });
  if (options.command.type === 'arm-live' && (
    !device.status?.controller?.connected
    || !device.lastSeenAt
    || now - Date.parse(device.lastSeenAt) >= WORKER_CONNECTED_MAX_AGE_MS
  )) throw new Error('copier-relay-worker-disconnected');

  if (relayNeedsTightenOnly(options.command, payload)) {
    await enforceRelayTightenOnly({
      db: options.db,
      deviceId: device.id,
      userId: options.userId,
      connectionId: options.connectionId,
      command: options.command,
      payload,
    });
  }

  // 17. 9. 2026: druhý Flatten All (15:58Z) vypršel ve frontě, protože worker
  // 265 s vykonával ten první a příkazy zpracovává sériově. Risk-redukční
  // Flatten se proto přichytí k už běžícímu/čekajícímu Flattenu stejného
  // cíle místo nového záznamu: UI čeká na jeho výsledek a nikdy nevznikne
  // druhá likvidace „na slepo" po tom, co se stav mezitím změnil.
  const inFlight = await findInFlightFlatten({
    db: options.db, userId: options.userId, deviceId: device.id, command: options.command, now,
  });
  if (inFlight) return { ...inFlight, deviceId: device.id };

  const inFlightArm = await findInFlightArm({
    db: options.db, userId: options.userId, deviceId: device.id,
    command: options.command, payload, now,
  });
  if (inFlightArm) return { ...inFlightArm, deviceId: device.id };

  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + (isTradovateCopierBrakeCommand(options.command)
    ? BRAKE_COMMAND_TTL_MS
    : STANDARD_COMMAND_TTL_MS)).toISOString();
  const { data, error } = await options.db.from('tradovate_copier_commands').upsert({
    user_id: options.userId,
    device_id: device.id,
    connection_id: options.connectionId,
    command_type: options.command.type,
    payload,
    idempotency_key: idempotencyKey,
    status: 'pending',
    created_at: createdAt,
    expires_at: expiresAt,
  }, { onConflict: 'user_id,device_id,idempotency_key', ignoreDuplicates: true })
    .select('id,status,expires_at')
    .maybeSingle<{ id: string; status: string; expires_at: string }>();
  if (error) throw new Error(`copier-relay-enqueue-failed: ${error.message}`);
  if (data) {
    if (options.command.type === 'arm-live') {
      const canonical = await coalesceInsertedArm({
        db: options.db,
        userId: options.userId,
        deviceId: device.id,
        inserted: data,
        payload,
        now,
      });
      return { ...canonical, deviceId: device.id };
    }
    if (isTradovateCopierBrakeCommand(options.command)) {
      try {
        await expirePendingArmsSupersededByBrake({
          db: options.db,
          deviceId: device.id,
          brakeCreatedAt: createdAt,
        });
      } catch (error) {
        // Brzda už je durable ve FIFO. Vrátit 502 by klientovi tvrdilo opak
        // a svádělo k dalšímu příkazu; workerový lastBrakeCreatedAt zůstává
        // druhá pojistka proti staršímu ARMu.
        console.error(`COPIER RELAY brake supersede failed after enqueue: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { id: data.id, status: data.status, expiresAt: data.expires_at, deviceId: device.id };
  }
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

const expirePendingArmsSupersededByBrake = async (options: {
  db: SupabaseClient;
  deviceId: string;
  brakeCreatedAt: string;
}): Promise<void> => {
  const { error } = await options.db.from('tradovate_copier_commands')
    .update({
      status: 'expired',
      completed_at: options.brakeCreatedAt,
      error: 'superseded-by-brake',
    })
    .eq('device_id', options.deviceId)
    .eq('status', 'pending')
    .in('command_type', ['arm-live', 'shadow'])
    .lte('created_at', options.brakeCreatedAt);
  if (error) throw new Error(`copier-relay-brake-supersede-failed: ${error.message}`);
};

/**
 * Closes the concurrent-enqueue race left by the pre-insert lookup. Identical
 * contenders deterministically keep the oldest live ARM and expire their
 * duplicate. A different payload is expired and reported as a conflict.
 */
async function coalesceInsertedArm(options: {
  db: SupabaseClient;
  userId: string;
  deviceId: string;
  inserted: { id: string; status: string; expires_at: string };
  payload: Record<string, unknown>;
  now: number;
}): Promise<{ id: string; status: string; expiresAt: string }> {
  const nowIso = new Date(options.now).toISOString();
  const lastBrakeCreatedAt = await newestBrakeCreatedAt(options.db, options.deviceId);
  let canonicalQuery = options.db.from('tradovate_copier_commands')
    .select('id,status,expires_at,payload')
    .eq('user_id', options.userId)
    .eq('device_id', options.deviceId)
    .eq('command_type', 'arm-live')
    .or('status.eq.claimed,status.eq.pending')
    .gt('expires_at', nowIso);
  if (lastBrakeCreatedAt) canonicalQuery = canonicalQuery.gt('created_at', lastBrakeCreatedAt);
  const { data: canonical, error } = await canonicalQuery
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(1)
    .maybeSingle<{ id: string; status: string; expires_at: string; payload: unknown }>();
  if (error) throw new Error(`copier-relay-arm-coalesce-lookup-failed: ${error.message}`);
  if (!canonical || canonical.id === options.inserted.id) {
    return { id: options.inserted.id, status: options.inserted.status, expiresAt: options.inserted.expires_at };
  }
  const samePayload = sameRelayPayload(canonical.payload, options.payload);
  const { error: expireError } = await options.db.from('tradovate_copier_commands')
    .update({
      status: 'expired',
      completed_at: nowIso,
      error: samePayload ? 'duplicate-arm-superseded' : 'conflicting-arm-payload',
    })
    .eq('id', options.inserted.id)
    .eq('device_id', options.deviceId)
    .eq('status', 'pending');
  if (expireError) throw new Error(`copier-relay-arm-coalesce-failed: ${expireError.message}`);
  if (!samePayload) throw new Error('copier-relay-arm-config-conflict');
  return { id: canonical.id, status: canonical.status, expiresAt: canonical.expires_at };
}

/** Identical repeated clicks coalesce; a different active ARM payload is rejected. */
async function findInFlightArm(options: {
  db: SupabaseClient;
  userId: string;
  deviceId: string;
  command: LocalCopierAgentCommand;
  payload: Record<string, unknown>;
  now: number;
}): Promise<{ id: string; status: string; expiresAt: string } | null> {
  if (options.command.type !== 'arm-live') return null;
  const nowIso = new Date(options.now).toISOString();
  const lastBrakeCreatedAt = await newestBrakeCreatedAt(options.db, options.deviceId);
  let inFlightQuery = options.db.from('tradovate_copier_commands')
    .select('id,status,expires_at,payload')
    .eq('user_id', options.userId)
    .eq('device_id', options.deviceId)
    .eq('command_type', 'arm-live')
    .or('status.eq.claimed,status.eq.pending')
    .gt('expires_at', nowIso);
  if (lastBrakeCreatedAt) inFlightQuery = inFlightQuery.gt('created_at', lastBrakeCreatedAt);
  const { data, error } = await inFlightQuery
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string; status: string; expires_at: string; payload: unknown }>();
  if (error) throw new Error(`copier-relay-inflight-arm-lookup-failed: ${error.message}`);
  if (!data) return null;
  if (!sameRelayPayload(data.payload, options.payload)) {
    throw new Error('copier-relay-arm-config-conflict');
  }
  return { id: data.id, status: data.status, expiresAt: data.expires_at };
}

const newestBrakeCreatedAt = async (db: SupabaseClient, deviceId: string): Promise<string | null> => {
  const { data, error } = await db.from('tradovate_copier_commands')
    .select('created_at')
    .eq('device_id', deviceId)
    .in('command_type', [...BRAKE_COMMAND_TYPES])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<{ created_at: string }>();
  if (error) throw new Error(`copier-relay-brake-epoch-lookup-failed: ${error.message}`);
  return typeof data?.created_at === 'string' ? data.created_at : null;
};

const IN_FLIGHT_FLATTEN_WINDOW_MS = 5 * 60_000;

/** Čekající (neexpirovaný) nebo právě vykonávaný Flatten stejného cíle, k němuž se nový požadavek přichytí. */
async function findInFlightFlatten(options: {
  db: SupabaseClient; userId: string; deviceId: string; command: LocalCopierAgentCommand; now: number;
}): Promise<{ id: string; status: string; expiresAt: string } | null> {
  if (options.command.type !== 'copy-command') return null;
  const inner = (options.command as { command?: { type?: unknown; groupId?: unknown; accountId?: unknown } }).command;
  if (!inner || (inner.type !== 'flatten-group'
    && inner.type !== 'flatten-account'
    && inner.type !== 'flatten-follower-trade')) return null;
  if (typeof inner.groupId !== 'string' || !inner.groupId) return null;
  // Přichytit se smí jen ke stejnému cíli: stejná skupina a u účtového
  // Flattenu i stejný účet. Flatten skupiny B nikdy nečeká na skupinu A.
  const target = inner.type === 'flatten-account' || inner.type === 'flatten-follower-trade'
    ? { type: inner.type, groupId: inner.groupId, accountId: inner.accountId }
    : { type: inner.type, groupId: inner.groupId };
  const nowIso = new Date(options.now).toISOString();
  const { data, error } = await options.db.from('tradovate_copier_commands')
    .select('id,status,expires_at')
    .eq('user_id', options.userId)
    .eq('device_id', options.deviceId)
    .eq('command_type', 'copy-command')
    .contains('payload', { command: target })
    .gte('created_at', new Date(options.now - IN_FLIGHT_FLATTEN_WINDOW_MS).toISOString())
    .or(`status.eq.claimed,and(status.eq.pending,expires_at.gt.${nowIso})`)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string; status: string; expires_at: string }>();
  if (error) throw new Error(`copier-relay-inflight-lookup-failed: ${error.message}`);
  return data ? { id: data.id, status: data.status, expiresAt: data.expires_at } : null;
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
  return row ? {
    id: row.id,
    command: rowCommand(row),
    ...(row.created_at ? { createdAt: row.created_at } : {}),
    expiresAt: row.expires_at,
  } : null;
}

export async function claimTradovateCopierCommandV2(options: { db: SupabaseClient; deviceId: string; deliveryId: string }) {
  const { data, error } = await options.db.rpc('claim_tradovate_copier_command_v2', {
    target_device_id: options.deviceId, target_delivery_id: options.deliveryId,
  });
  if (error) throw new Error(`copier-relay-claim-failed: ${error.message}`);
  if (!Array.isArray(data) || data.length > 1) throw new Error('copier-relay-claim-invalid-response');
  const row = data[0] as (CommandRow & { created_at: string }) | undefined;
  return row ? { id: row.id, command: row.status === 'claimed' ? rowCommand(row) : null,
    createdAt: row.created_at, expiresAt: row.expires_at, status: row.status } : null;
}

export async function completeTradovateCopierCommandV2(options: {
  db: SupabaseClient; deviceId: string; deliveryId: string; commandId: string;
  result?: unknown; error?: string; status: LocalCopierAgentStatus; revision: number;
}): Promise<boolean> {
  const { data, error } = await options.db.rpc('complete_tradovate_copier_command_v2', {
    target_device_id: options.deviceId, target_delivery_id: options.deliveryId, target_command_id: options.commandId,
    command_result: options.result ?? null, command_error: options.error?.slice(0, 500) || null,
    snapshot: { ...options.status, nonce: '' }, revision: options.revision,
  });
  if (error) throw new Error(`copier-relay-complete-failed: ${error.message}`);
  return data === true;
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
  db: SupabaseClient; deviceId: string; userId: string; connectionId: string; status: LocalCopierAgentStatus; revision?: number; runtimeOnly?: boolean;
}): Promise<void> {
  const safeStatus = { ...options.status, nonce: '' };
  const { error } = options.revision !== undefined
    ? await options.db.rpc('heartbeat_tradovate_copier_v2', { target_device_id: options.deviceId, snapshot: safeStatus, revision: options.revision })
    : await options.db.from('tradovate_copier_device_runtime').upsert({
    device_id: options.deviceId, user_id: options.userId, connection_id: options.connectionId,
    status: safeStatus, last_seen_at: new Date().toISOString(), started_at: options.status.startedAt,
  }, { onConflict: 'device_id' });
  if (error) throw new Error(`copier-relay-heartbeat-failed: ${error.message}`);
  if (options.runtimeOnly) return;
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
        // Older workers omit the link key; never erase one already backfilled from evidence.
        ...(trade.leaderEntryOrderIds ? { leader_entry_order_ids: trade.leaderEntryOrderIds } : {}),
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
  const parsedLastSeenAt = Date.parse(data.last_seen_at);
  const ageMs = Number.isFinite(parsedLastSeenAt)
    ? Math.max(0, Date.now() - parsedLastSeenAt)
    : 10_000;
  return { status: data.status, lastSeenAt: data.last_seen_at, ageMs, connected: ageMs < 10_000 };
}

/** Jak čerstvý musí být stav workeru, aby jeho ARM blokoval odpojení propfirmy. */
export const COPIER_DISCONNECT_GUARD_STALE_MS = 10 * 60_000;

/**
 * Propfirmu nejde odpojit, když její účty právě kopíruje zapnutá kopírka
 * (5. 10. 2026). Fail-closed: zapnutá kopírka, která připojení načetla, ale
 * jeho účty nehlásí, odpojení také blokuje. Stav starší než 10 min neblokuje
 * (worker neběží); worker sám za ARM odpojení zjistí a kopírku vypne.
 */
export async function assertConnectionNotInArmedCopy(options: {
  db: SupabaseClient;
  userId: string;
  connectionId: string;
  now?: number;
}): Promise<void> {
  const { data, error } = await options.db.from('tradovate_copier_device_runtime')
    .select('status,last_seen_at')
    .eq('user_id', options.userId);
  if (error) throw new Error(`copier-disconnect-guard-lookup-failed: ${error.message}`);
  const now = options.now ?? Date.now();
  for (const row of (data ?? []) as Array<{ status: LocalCopierAgentStatus | null; last_seen_at: string }>) {
    const seenAt = Date.parse(row.last_seen_at);
    if (!Number.isFinite(seenAt) || now - seenAt > COPIER_DISCONNECT_GUARD_STALE_MS) continue;
    const status = row.status;
    if (!status?.controller?.armed) continue;
    const group = status.group;
    const groupAccounts = new Set([group?.leaderAccountId, ...(group?.followers ?? [])
      .filter(follower => follower.mode !== 'off' && follower.enabled !== false)
      .map(follower => follower.accountId)].filter((id): id is number => typeof id === 'number'));
    const display = status.accountDisplay?.find(item => item.connectionId === options.connectionId);
    const reported = status.connectionDiscovery?.connectionAccounts
      ?.find(item => item.connectionId === options.connectionId);
    const loadedByWorker = display != null || reported != null
      || status.devices?.some(device => device.connectionId === options.connectionId) === true
      || status.device?.connectionId === options.connectionId
      || status.connectionDiscovery?.loadedConnectionIds.includes(options.connectionId) === true;
    if (!loadedByWorker) continue;
    const connectionAccounts = [...new Set([
      ...(reported?.accountIds ?? []),
      ...(display?.snapshots.map(snapshot => snapshot.accountId) ?? []),
      ...(display?.pendingAccountIds ?? []),
    ])];
    // Prázdný seznam (feed ještě nic nenačetl) není důkaz, že firma nemá účty
    // skupiny: za ARM fail-closed blokuje.
    if (connectionAccounts.length === 0 || connectionAccounts.some(accountId => groupAccounts.has(accountId))) {
      throw new Error('copier-armed-connection-in-use');
    }
  }
}
