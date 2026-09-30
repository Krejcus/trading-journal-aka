import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  canSafelyRestartLocalCopierAgent,
  copyGroupAccountIds,
  localCopierAgentErrorDetails,
  localCopierAgentRestartBlockers,
  LocalCopierAgentCommandError,
  isLocalCopierEmergencyCommand,
  isLocalCopierRiskReducingCommand,
  type LocalCopierAgentCommand,
  type LocalCopierAgentExecutionContext,
  type LocalCopierAgentCommandResult,
  type LocalCopierAgentStatus,
} from '../lib/localCopierAgentProtocol.js';
import {
  isInPlaceCutTightening,
  isMetadataOnlyGroupChange,
  isWeakerRiskConfig,
} from '../lib/copierRiskConfig.js';
import { COPIER_RISK_CONFIG_CAPABILITY } from '../lib/copierWorkerCapabilities.js';
import { msUntilTradovateSessionEnd, tradovateSessionEndAt } from '../services/copierArmSession.js';
import type { CopierControllerStatus, CopierRuntimeController } from '../services/copierRuntimeController.js';
import {
  normalizeMultiplier,
  sanitizeCopyGroups,
  type CopyGroupConfig,
  type LiveCopyTradingCommand,
  type LiveCopyTradingCommandResult,
} from '../services/liveCopyTrading.js';

const DEFAULT_ALLOWED_ORIGINS = new Set([
  'https://alphatrade-mentor-15.vercel.app',
]);

const DEFAULT_DEVELOPMENT_ORIGINS = new Set([
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3011',
]);
const LOCAL_ARM_DEADLINE_MS = 30_000;
const FOLLOWER_TRADE_FLATTEN_ACK_MS = 3_000;

export const boundedLocalArmDeadline = (rawDeadline: unknown, receivedAt = Date.now()): number => {
  const parsed = typeof rawDeadline === 'string' ? Number(rawDeadline) : NaN;
  return Number.isFinite(parsed)
    ? Math.min(parsed, receivedAt + LOCAL_ARM_DEADLINE_MS)
    : receivedAt + LOCAL_ARM_DEADLINE_MS;
};

export interface PrepareGroupAccountsRequest {
  required: readonly number[];
  optional: readonly number[];
  /** Viz DynamicBrokerRoutingRequest: jen auditované vyřazení nedostupných účtů. */
  inactiveOptionalAsMissing?: boolean;
}

export interface PrepareGroupAccountsResult {
  /** Optional účty, které nevrátil žádný z právě obnovených OAuth adresářů. */
  missingOptional: readonly number[];
}

interface LocalCopierExecutionAgentOptions {
  controller: CopierRuntimeController;
  /**
   * B1: jak dlouho po durable přijetí čekat na potvrzené zavření followera,
   * než příkaz vrátí `pending`. Relay i FIFO agenta jsou sériové; dřív tu
   * DISARM, kill switch i Flatten All z telefonu čekaly až 90 s.
   */
  followerTradeFlattenAckMs?: number;
  group: CopyGroupConfig;
  port?: number;
  host?: '127.0.0.1';
  allowedOrigins?: ReadonlySet<string>;
  developmentOrigins?: ReadonlySet<string>;
  /** Explicit install-time opt-in. Otherwise dev origins are read/risk-reduction only. */
  allowFullDevelopmentAccess?: boolean;
  startedAt?: string;
  installation?: NonNullable<LocalCopierAgentStatus['installation']>;
  device?: NonNullable<LocalCopierAgentStatus['device']>;
  devices?: NonNullable<LocalCopierAgentStatus['devices']>;
  snapshotHealth?: () => NonNullable<LocalCopierAgentStatus['snapshotHealth']>;
  /** Zdraví lokálních zapisovačů evidence; read-only, prázdné pole = žádný zapisovač. */
  journalHealth?: () => NonNullable<LocalCopierAgentStatus['journalHealth']>;
  /** Ceny z TradingView jen pro zobrazení; prázdné pole = žádná čerstvá cena. */
  marketPrices?: () => NonNullable<LocalCopierAgentStatus['marketPrices']>;
  accountDisplay?: () => NonNullable<LocalCopierAgentStatus['accountDisplay']>;
  /** Využití Tradovate API a stav session po spojení; jen zobrazení. */
  connectionUsage?: () => NonNullable<LocalCopierAgentStatus['connectionUsage']>;
  /** Naplánuje observability test mimo broker dispatch a okamžitě se vrátí. */
  onSnapshotTest?: (requestId: string, options: { repairCamera: boolean }) => void;
  onDevicePaired?: (deviceId: string) => Promise<void>;
  /** Requests a restart after pairing; the pilot performs the final safe-state gate. */
  onDevicePairingRestart?: (deviceId: string) => void;
  /** Crash-safe persistence hook. A failed save rolls the runtime back DISARMED. */
  onGroupChanged?: (group: CopyGroupConfig) => Promise<void>;
  /**
   * Před změnou topologie/ARM obnoví account -> OAuth routing. Callback smí
   * pouze číst broker adresáře a atomicky přepnout lokální router; žádný
   * broker order side effect. Chyba musí nechat runtime DISARMED.
   */
  prepareGroupAccounts?: (request: PrepareGroupAccountsRequest) => Promise<PrepareGroupAccountsResult>;
  /** Stejná OAuth/routing kontrola bez router.replaceRoutes; povinná před DISARM za ARM. */
  previewGroupAccounts?: (request: PrepareGroupAccountsRequest) => Promise<PrepareGroupAccountsResult>;
}

export interface LocalCopierExecutionAgent {
  origin: string;
  status(): LocalCopierAgentStatus;
  execute(command: LocalCopierAgentCommand, context?: LocalCopierAgentExecutionContext): Promise<LocalCopierAgentCommandResult>;
  /** Synchronně odmítne nový/pending command ingress před graceful drainem. */
  beginShutdown(): void;
  close(): Promise<void>;
}

const json = (response: ServerResponse, status: number, payload: unknown): void => {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(payload));
};

const body = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > 32_768) throw new Error('Příkaz lokálního agenta je příliš velký');
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
};

const assertMember = (group: CopyGroupConfig, accountId: number): void => {
  if (!copyGroupAccountIds(group).includes(accountId)) {
    throw new Error('Účet není součástí skupiny lokálního execution agenta');
  }
};

const assertGroupTarget = (group: CopyGroupConfig, groupId: string): void => {
  if (groupId !== group.id) {
    throw new Error('Flatten míří na jinou skupinu, než jakou má lokální execution agent');
  }
};

const mappedGroup = (runtimeGroup: CopyGroupConfig, incoming: CopyGroupConfig): CopyGroupConfig => {
  // Stabilní runtime ID je instalační slot; leader i followery se smějí
  // změnit z UI pouze přes controller preflight + novou durable epochu.
  return {
    ...incoming,
    id: runtimeGroup.id,
    localOnly: true,
    // Full UI updates may be based on a status preceding a manual toggle.
    // Participation belongs to the worker's durable group, not that snapshot.
    followers: incoming.followers.map(follower => ({
      ...follower,
      enabled: runtimeGroup.followers.find(item => item.accountId === follower.accountId)?.enabled !== false,
    })),
  };
};

const sameAccountTopology = (left: CopyGroupConfig, right: CopyGroupConfig): boolean => {
  const leftIds = [...copyGroupAccountIds(left)].sort((a, b) => a - b);
  const rightIds = [...copyGroupAccountIds(right)].sort((a, b) => a - b);
  return leftIds.length === rightIds.length && leftIds.every((value, index) => value === rightIds[index]);
};

const canonicalConfig = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalConfig);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonicalConfig(entry)]));
};

const sameCopyGroupConfig = (left: CopyGroupConfig, right: CopyGroupConfig): boolean =>
  JSON.stringify(canonicalConfig(left)) === JSON.stringify(canonicalConfig(right));

const SNAPSHOT_TEST_REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const accountsForRoutingChange = (
  previous: CopyGroupConfig,
  next: CopyGroupConfig,
): PrepareGroupAccountsRequest => {
  const leaderIds = new Set([previous.leaderAccountId, next.leaderAccountId]);
  const nextAccountIds = new Set(copyGroupAccountIds(next));
  const optional = previous.followers
    .map(follower => follower.accountId)
    .filter(accountId => !nextAccountIds.has(accountId) && !leaderIds.has(accountId));
  const optionalSet = new Set(optional);
  const required = [...new Set([...copyGroupAccountIds(previous), ...copyGroupAccountIds(next)])]
    .filter(accountId => !optionalSet.has(accountId));
  return { required, optional };
};

const allAccountsRequired = (accountIds: readonly number[]): PrepareGroupAccountsRequest => ({
  required: [...new Set(accountIds)],
  optional: [],
});

const validatedAccountEligibilityExclusions = (value: unknown) => {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error('Neplatný seznam eligibility exclusions');
  }
  const unique = new Map<number, { accountId: number; state: 'dll-locked' | 'breached'; reason: string }>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') throw new Error('Neplatná eligibility exclusion');
    const entry = candidate as { accountId?: unknown; state?: unknown; reason?: unknown };
    if (typeof entry.accountId !== 'number' || !Number.isSafeInteger(entry.accountId) || entry.accountId <= 0) {
      throw new Error('Eligibility exclusion obsahuje neplatné accountId');
    }
    if (entry.state !== 'dll-locked' && entry.state !== 'breached') {
      throw new Error('Eligibility exclusion obsahuje nepovolený stav');
    }
    if (typeof entry.reason !== 'string' || entry.reason.trim().length < 3 || entry.reason.trim().length > 500) {
      throw new Error('Eligibility exclusion vyžaduje konkrétní důvod');
    }
    unique.set(entry.accountId, {
      accountId: entry.accountId,
      state: entry.state,
      reason: entry.reason.trim(),
    });
  }
  return [...unique.values()];
};

export async function startLocalCopierExecutionAgent(
  options: LocalCopierExecutionAgentOptions,
): Promise<LocalCopierExecutionAgent> {
  const host = options.host ?? '127.0.0.1';
  const allowedOrigins = options.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS;
  const developmentOrigins = options.developmentOrigins ?? DEFAULT_DEVELOPMENT_ORIGINS;
  // Instalační flag je záměrně explicitní. Bez něj localhost LIVE smí pouze
  // číst status a poslat risk-redukční brzdy/Flatten.
  const allowFullDevelopmentAccess = options.allowFullDevelopmentAccess
    ?? process.env.ALPHATRADE_COPIER_ALLOW_FULL_DEV_ORIGINS === '1';
  const nonce = randomUUID();
  const startedAt = options.startedAt ?? new Date().toISOString();
  const normalizedGroups = sanitizeCopyGroups([options.group]);
  if (!normalizedGroups || normalizedGroups.length !== 1) {
    throw new Error('Lokální execution agent dostal neplatná pravidla copy group');
  }
  let group = structuredClone(normalizedGroups[0]);
  const devices = (options.devices ?? (options.device ? [options.device] : [])).map(item => structuredClone(item));
  if (new Set(devices.map(item => item.deviceId)).size !== devices.length) {
    throw new Error('Lokální execution agent dostal duplicitní deviceId');
  }
  if (new Set(devices.map(item => item.connectionId)).size !== devices.length) {
    throw new Error('Lokální execution agent dostal více zařízení pro stejné OAuth připojení');
  }
  let tail = Promise.resolve();
  let brakeEpoch = 0;
  let lastBrakeCreatedAt = Number.NEGATIVE_INFINITY;
  let armPending = false;
  let shuttingDown = false;
  let serverClosePromise: Promise<void> | null = null;
  const shutdownError = () => new Error('Lokální execution agent se právě bezpečně ukončuje');
  const prepareAccounts = async (
    request: PrepareGroupAccountsRequest,
  ): Promise<PrepareGroupAccountsResult> => {
    const prepared = await options.prepareGroupAccounts?.(request);
    const optional = new Set(request.optional);
    const missingOptional = [...new Set(prepared?.missingOptional ?? [])];
    for (const accountId of missingOptional) {
      if (!Number.isSafeInteger(accountId) || !optional.has(accountId)) {
        throw new Error(`Routing refresh vrátil neplatný missing optional účet ${accountId}`);
      }
    }
    return { missingOptional };
  };
  const previewAccounts = async (
    request: PrepareGroupAccountsRequest,
  ): Promise<PrepareGroupAccountsResult> => {
    if (!options.previewGroupAccounts) {
      throw new Error('Routing dry-run není dostupný; execution změna zůstává beze změny');
    }
    const prepared = await options.previewGroupAccounts(request);
    const optional = new Set(request.optional);
    const missingOptional = [...new Set(prepared?.missingOptional ?? [])];
    for (const accountId of missingOptional) {
      if (!Number.isSafeInteger(accountId) || !optional.has(accountId)) {
        throw new Error(`Routing dry-run vrátil neplatný missing optional účet ${accountId}`);
      }
    }
    return { missingOptional };
  };

  const status = (): LocalCopierAgentStatus => ({
    version: 1,
    capabilities: [COPIER_RISK_CONFIG_CAPABILITY, ...(options.accountDisplay ? ['account-display-v1'] : [])],
    environment: 'demo',
    nonce,
    group: structuredClone(group),
    controller: options.controller.status(),
    startedAt,
    ...(options.installation ? { installation: structuredClone(options.installation) } : {}),
    ...(devices[0] ? { device: structuredClone(devices[0]) } : {}),
    ...(devices.length > 0 ? { devices: structuredClone(devices) } : {}),
    ...(options.accountDisplay ? { accountDisplay: structuredClone(options.accountDisplay()) } : {}),
    ...(options.connectionUsage ? { connectionUsage: structuredClone(options.connectionUsage()) } : {}),
    ...(options.snapshotHealth ? { snapshotHealth: structuredClone(options.snapshotHealth()) } : {}),
    ...(() => {
      const journalHealth = options.journalHealth?.() ?? [];
      return journalHealth.length > 0 ? { journalHealth: structuredClone(journalHealth) } : {};
    })(),
    ...(() => {
      const marketPrices = options.marketPrices?.() ?? [];
      return marketPrices.length > 0 ? { marketPrices: structuredClone(marketPrices) } : {};
    })(),
  });

  const configurationResult = (): LiveCopyTradingCommandResult => ({
    type: 'configuration',
    group: structuredClone(group),
  });

  const applyGroup = async (
    next: CopyGroupConfig,
    mode: 'update' | 'activate' = 'update',
    reconfigurationRequest: {
      waiveUnverifiableFollowerOwnership?: true;
      retireMissingOldGroup?: { groupId: string; accountIds: number[]; reason: string };
      /** Jen explicitní uložení skupiny smí provést vyřazení z režimu opravy (E6). */
      allowStartupRepair?: true;
    } = {},
  ): Promise<LiveCopyTradingCommandResult> => {
    // Režim opravy po startu: uložená skupina má účty, které nejsou v OAuth
    // (breached). Úprava stejné skupiny, která je všechny odebere, se provede
    // jako auditované vyřazení právě těchto účtů; bez jejich odebrání se
    // změna odmítne, jinak by ARM zůstal zablokovaný.
    const startupRepair = options.controller.status().startupGroupRepair;
    if (startupRepair && startupRepair.groupId === group.id && next.id === group.id
      && !reconfigurationRequest.retireMissingOldGroup
      && reconfigurationRequest.allowStartupRepair !== true) {
      // E6 (review 30. 9.): vyřazení bez broker flat důkazu nesmí proběhnout
      // implicitně v rámci ARM (jeden příkaz z telefonu = vyřazení + ARM).
      throw new Error(
        `Skupina je v režimu opravy (nedostupné účty ${startupRepair.unavailableAccountIds.join(', ')}). `
        + 'Nejdřív ulož opravenou skupinu v editoru, teprve potom kopírku zapni.',
      );
    }
    if (startupRepair && startupRepair.groupId === group.id && next.id === group.id
      && !reconfigurationRequest.retireMissingOldGroup) {
      const stillPresent = startupRepair.unavailableAccountIds
        .filter(accountId => copyGroupAccountIds(next).includes(accountId));
      if (stillPresent.length > 0) {
        // E3 (review 30. 9.): při dočasném výpadku OAuth během startu jsou
        // účty zdravé a po obnově znovu vidět; worker je ale načte až po
        // restartu. Radíme proto správný krok, ne jejich odebrání.
        let availableAgain = false;
        try {
          await previewAccounts({ required: stillPresent, optional: [] });
          availableAgain = true;
        } catch {
          availableAgain = false;
        }
        throw new Error(availableAgain
          ? `Účty ${stillPresent.join(', ')} jsou v OAuth znovu dostupné, při startu workeru ale nebyly. `
            + 'Restartuj Mac worker, aby skupinu načetl znovu; kopírka zůstává VYPNUTO.'
          : `Skupina má nedostupné účty ${stillPresent.join(', ')} (breached nebo odpojené v OAuth). `
            + 'Odeber je a vyber nového leadera z dostupných účtů.');
      }
      mode = 'activate';
      reconfigurationRequest = {
        ...reconfigurationRequest,
        retireMissingOldGroup: {
          groupId: group.id,
          accountIds: [...startupRepair.unavailableAccountIds],
          reason: `UI oprava skupiny po startu: účty ${startupRepair.unavailableAccountIds.join(', ')} nejsou v OAuth (breached/odpojené); vyřazeny bez broker flat důkazu`,
        },
      };
    }
    const requested = next;
    const normalized = sanitizeCopyGroups([next]);
    if (!normalized || normalized.length !== 1) {
      throw new Error('Copy group obsahuje neplatná pravidla dne');
    }
    next = normalized[0];
    const previous = group;
    const leaderChanged = previous.leaderAccountId !== next.leaderAccountId;
    const topologyChanged = !sameAccountTopology(previous, next);
    const weaker = [...new Set([
      ...isWeakerRiskConfig(previous, requested),
      ...isWeakerRiskConfig(previous, next),
    ])];
    const metadataOnly = weaker.length === 0 && isMetadataOnlyGroupChange(previous, next);
    const inPlaceCutTightening = weaker.length === 0 && isInPlaceCutTightening(previous, next);
    let persistedNext = false;
    const retirement = reconfigurationRequest.retireMissingOldGroup;
    const previousIds = copyGroupAccountIds(previous);
    if (retirement) {
      if (!Array.isArray(retirement.accountIds)
        || retirement.accountIds.some(accountId => !Number.isSafeInteger(accountId) || accountId <= 0)) {
        throw new Error('Vyřazení staré skupiny obsahuje neplatná ID účtů');
      }
      const assertedIds = [...new Set(retirement.accountIds)].sort((a, b) => a - b);
      const repairIds = startupRepair?.groupId === previous.id
        ? [...startupRepair.unavailableAccountIds].sort((a, b) => a - b)
        : null;
      const partialRepair = repairIds != null
        && assertedIds.length === repairIds.length
        && assertedIds.every((accountId, index) => accountId === repairIds[index]);
      if (mode !== 'activate' || (next.id === previous.id && !partialRepair)
        || retirement.groupId !== previous.id
        || assertedIds.length !== retirement.accountIds.length
        || (!partialRepair && (assertedIds.length !== previousIds.length
          || assertedIds.some((accountId, index) => accountId !== previousIds[index])))
        || assertedIds.some(accountId => !previousIds.includes(accountId))
        || copyGroupAccountIds(next).some(accountId => assertedIds.includes(accountId))
        || typeof retirement.reason !== 'string'
        || retirement.reason.trim().length < 20 || retirement.reason.length > 500) {
        throw new Error('Vyřazení staré skupiny vyžaduje přesné ID, všechny staré účty, jinou topologii a konkrétní důvod');
      }
      if (options.controller.status().armed) {
        throw new Error('Vyřazení staré skupiny je možné jen z vypnuté kopírky');
      }
    }

    // V1: všechny synchronní validace a routing dry-run musí proběhnout před
    // jakýmkoli DISARM. Odmítnutý config tak nezmění zdravý runtime.
    if ((options.controller.status().sessionArmedAt ?? 0) > 0) {
      if (weaker.length > 0) {
        throw new Error(`Pravidla jdou dnes jen zpřísnit: ${weaker.join(', ')} (reset po konci session)`);
      }
    }
    options.controller.preflightGroupChange(next, { allowGroupChange: mode === 'activate' });
    // E1 (review 30. 9.): částečná oprava ponechává část starých účtů;
    // účet nesmí být současně required (nová skupina) i optional (stará).
    const routingRequest = retirement
      ? {
        required: copyGroupAccountIds(next),
        optional: previousIds.filter(accountId => !copyGroupAccountIds(next).includes(accountId)),
        inactiveOptionalAsMissing: true,
      }
      : accountsForRoutingChange(previous, next);
    if ((mode === 'activate' || topologyChanged) && options.controller.status().armed) {
      await previewAccounts(routingRequest);
      // Broker event mohl doběhnout během OAuth discovery; před DISARM proto
      // ještě jednou ověř čistě lokální streamové blockery.
      options.controller.preflightGroupChange(next, { allowGroupChange: mode === 'activate' });
    }

    // Čistá metadata/pravidla bez změny execution konfigurace nemají důvod
    // rušit ARM ani autoritativní preflight pozic.
    if ((metadataOnly || inPlaceCutTightening) && mode === 'update') {
      if (options.onGroupChanged) {
        await options.onGroupChanged(structuredClone(next));
        persistedNext = true;
      }
      try {
        if (inPlaceCutTightening) await options.controller.updateGroupRiskInPlace(next);
        else options.controller.updateGroupMetadata(next);
        group = next;
      } catch (error) {
        if (persistedNext && options.onGroupChanged) {
          try {
            await options.onGroupChanged(structuredClone(previous));
          } catch (rollbackError) {
            // Durable konfigurace je nejistá. I metadata/risk cesta musí v
            // takovém případě zůstat fail-closed bez automatického návratu.
            options.controller.disarm('config-change');
            throw new Error(
              `Metadata změna selhala a rollback je nejistý: ${String(error)}; rollback=${String(rollbackError)}`,
            );
          }
        }
        throw error;
      }
      return configurationResult();
    }

    if (options.controller.status().armed) options.controller.disarm('config-change');

    try {
      let missingOptionalAccountIds: readonly number[] = [];
      if (mode === 'activate' || topologyChanged) {
        // Teprve po úspěšném dry-runu a DISARM se atomicky přepnou routes.
        // Controller pak provede autoritativní flat/no-working kontrolu.
        const prepared = await prepareAccounts(routingRequest);
        if (retirement) {
          const retiredIds = retirement.accountIds;
          if (retiredIds.some(accountId => !prepared.missingOptional.includes(accountId))) {
            throw new Error('Vyřazení odmítnuto: vyřazované účty nejsou nedostupné v OAuth; ověř je běžnou cestou');
          }
          missingOptionalAccountIds = previous.followers
            .map(follower => follower.accountId)
            .filter(accountId => retiredIds.includes(accountId));
        } else {
          missingOptionalAccountIds = prepared.missingOptional;
        }
      }
      const reconfigurationOptions = {
        missingOptionalAccountIds: [...missingOptionalAccountIds],
        ...(retirement ? { retireMissingOldGroup: {
          ...retirement,
          accountIds: [...retirement.accountIds],
          reason: retirement.reason.trim(),
        } } : {}),
        ...(reconfigurationRequest.waiveUnverifiableFollowerOwnership === true
          ? { waiveUnverifiableFollowerOwnership: true as const }
          : {}),
      };
      if (options.onGroupChanged) {
        await options.onGroupChanged(structuredClone(next));
        persistedNext = true;
      }
      if (mode === 'activate') await options.controller.activateGroup(next, reconfigurationOptions);
      else await options.controller.reconfigureGroup(next, reconfigurationOptions);
      group = next;
    } catch (error) {
      // Controller se mění až po durable zápisu. Selže-li jeho validace nebo
      // preflight, vrací se pouze uložená konfigurace; runtime je stále
      // DISARMED a není potřeba obcházet tighten-only návratem na mírnější stav.
      if (persistedNext && options.onGroupChanged) {
        await options.onGroupChanged(structuredClone(previous));
      }
      throw error;
    }
    return configurationResult();
  };

  const flattenFollowerTradeWithBoundedWait = async (
    accountId: number,
    operationId: string,
  ): Promise<Extract<LiveCopyTradingCommandResult, { type: 'flatten' }>> => {
    let markAdmitted!: () => void;
    const admitted = new Promise<'admitted'>(resolve => { markAdmitted = () => resolve('admitted'); });
    const completion = options.controller.flattenFollowerTrade(accountId, operationId, { onAdmitted: markAdmitted });
    // Odmítnutí před přijetím (není ARM, kill switch, visící operace…) se
    // vrací hned jako chyba; teprve přijatý cut smí doběhnout na pozadí.
    const first = await Promise.race([admitted, completion]);
    if (first !== 'admitted') return { type: 'flatten', ...first };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const quick = await Promise.race([
      completion,
      new Promise<null>(resolve => {
        timer = setTimeout(() => resolve(null), options.followerTradeFlattenAckMs ?? FOLLOWER_TRADE_FLATTEN_ACK_MS);
      }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
    if (quick) return { type: 'flatten', ...quick };
    void completion.then(
      result => console.log(`${new Date().toISOString()} FLATTEN-FOLLOWER-TRADE done accountId=${accountId} operationId=${operationId} flat=${result.flat}`),
      reason => console.error(`${new Date().toISOString()} FLATTEN-FOLLOWER-TRADE failed accountId=${accountId} operationId=${operationId}: ${reason instanceof Error ? reason.message : String(reason)}`),
    );
    return {
      type: 'flatten',
      operationId,
      accountIds: [accountId],
      canceledOrders: 0,
      submittedClosures: 0,
      flat: false,
      pending: true,
      remainingPositionAccounts: [],
      workingOrderAccounts: [],
    };
  };
  const executeCopyCommand = async (command: LiveCopyTradingCommand): Promise<LiveCopyTradingCommandResult> => {
    switch (command.type) {
      case 'update-group': {
        const next = mappedGroup(group, command.group);
        return applyGroup(next, 'update', {
          allowStartupRepair: true,
          ...(command.waiveUnverifiableFollowerOwnership === true
            ? { waiveUnverifiableFollowerOwnership: true as const }
            : {}),
        });
      }
      case 'set-group-enabled': {
        return applyGroup({ ...group, enabled: command.enabled });
      }
      case 'set-replication': {
        assertMember(group, command.accountId);
        return applyGroup({
          ...group,
          followers: group.followers.map(follower => follower.accountId === command.accountId
            ? { ...follower, mode: command.mode }
            : follower),
        });
      }
      case 'set-follower-enabled': {
        assertGroupTarget(group, command.groupId);
        if (!options.onGroupChanged) throw new Error('Trvalé uložení skupiny není dostupné');
        const next = await options.controller.setFollowerEnabled(
          command.accountId,
          command.enabled,
          async updated => {
            await options.onGroupChanged!(structuredClone(updated));
          },
        );
        group = next;
        return configurationResult();
      }
      case 'set-multiplier': {
        assertMember(group, command.accountId);
        const follower = group.followers.find(item => item.accountId === command.accountId);
        if (!follower) {
          throw new Error('Násobek lze změnit pouze follower účtu');
        }
        const nextMultiplier = normalizeMultiplier(command.multiplier);
        const result = await applyGroup({
          ...group,
          followers: group.followers.map(item => item.accountId === command.accountId
            ? { ...item, multiplier: nextMultiplier }
            : item),
        });
        // Příští incident musí být dohledatelný bez odhadování z výsledné
        // konfigurace: account i hodnota před/po jsou zapsané až po durable
        // úspěchu applyGroup.
        console.log(`${new Date().toISOString()} CONFIG SET-MULTIPLIER groupId=${group.id} accountId=${command.accountId} before=${follower.multiplier} after=${nextMultiplier}`);
        return result;
      }
      case 'flatten-account':
        // Autoritativní cíl: groupId z příkazu musí sedět na runtime skupinu.
        // Web adapter to kontroluje taky, ale frontend není bezpečnostní
        // hranice — přes relay smí Flatten dorazit odkudkoliv.
        assertGroupTarget(group, command.groupId);
        assertMember(group, command.accountId);
        return { type: 'flatten', ...await options.controller.flattenAccount(command.accountId, command.operationId) };
      case 'flatten-follower-trade':
        assertGroupTarget(group, command.groupId);
        assertMember(group, command.accountId);
        if (!group.followers.some(follower => follower.accountId === command.accountId)) {
          throw new Error('Do konce obchodu lze vyřadit pouze follower účet');
        }
        return flattenFollowerTradeWithBoundedWait(command.accountId, command.operationId);
      case 'flatten-group':
        assertGroupTarget(group, command.groupId);
        return { type: 'flatten', ...await options.controller.flattenGroup(command.operationId) };
      case 'create-group':
        throw new Error('Lokální agent už má jednu aktivní skupinu');
      case 'delete-group':
        throw new Error('Skupinu nejdřív DISARM a ukonči lokální agent');
      case 'resolve-stuck-operation':
        // Durable waive: nic neposílá brokerovi, odzbrojí a vynutí novou
        // reconciliation. Stejná cesta jako mac-install resolve-stuck.
        await options.controller.waiveStuckOperation({
          kind: command.kind,
          key: command.key,
          reason: command.reason,
        });
        return { type: 'configuration', group };
      case 'cancel-order':
        throw new Error('Ruční cancel z UI zatím není napojen na durable runtime');
    }
  };

  const armDeadlineError = () => new Error('ARM odmítnut: vypršel deadline potvrzení; kopírka zůstává DISARMED');
  const assertArmAdmissible = (
    deadlineAt: number,
    admittedBrakeEpoch: number,
    commandCreatedAt: number,
    clockSkewReserveMs = 0,
  ): void => {
    if (Date.now() >= deadlineAt) throw armDeadlineError();
    if (commandCreatedAt <= lastBrakeCreatedAt + Math.max(0, clockSkewReserveMs)) {
      throw new Error('ARM odmítnut: příkaz je starší než poslední bezpečnostní brzda (DISARM, kill switch nebo denní lock)');
    }
    if (brakeEpoch !== admittedBrakeEpoch) {
      throw new Error('ARM odmítnut: během přípravy přišel DISARM, kill switch nebo denní lock');
    }
    if (!options.controller.status().connected) {
      throw new Error('ARM odmítnut: worker není připojen k brokeru');
    }
  };
  const recordExecutedBrake = (context: LocalCopierAgentExecutionContext): void => {
    const createdAt = Number.isFinite(context.createdAt) ? context.createdAt! : Date.now();
    lastBrakeCreatedAt = Math.max(lastBrakeCreatedAt, createdAt);
  };
  const armMatchesCurrentConfiguration = (
    command: Extract<LocalCopierAgentCommand, { type: 'arm-live' }>,
    current: CopierControllerStatus,
  ): boolean => {
    let requestedGroup = group;
    if (command.group) {
      const normalized = sanitizeCopyGroups([mappedGroup(group, command.group)]);
      if (!normalized || normalized.length !== 1) return false;
      requestedGroup = normalized[0];
    }
    if (!sameCopyGroupConfig(requestedGroup, group)) return false;
    const requestedExclusions = validatedAccountEligibilityExclusions(command.accountEligibilityExclusions);
    const applied = new Map((current.accountEligibility ?? []).map(entry => [entry.accountId, entry.state]));
    const severity = (state: string | undefined): number => state === 'breached'
      ? 3
      : state === 'unverifiable'
        ? 2
        : state === 'dll-locked'
          ? 1
          : 0;
    return requestedExclusions.every(exclusion => severity(applied.get(exclusion.accountId)) >= severity(exclusion.state));
  };
  const awaitArmDeadline = async <T>(pending: Promise<T>, deadlineAt: number): Promise<T> => {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw armDeadlineError();
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(armDeadlineError()), remaining);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const execute = async (
    command: LocalCopierAgentCommand,
    context: LocalCopierAgentExecutionContext = {},
    admittedBrakeEpoch = brakeEpoch,
  ): Promise<unknown> => {
    switch (command.type) {
      case 'copy-command':
        return executeCopyCommand(command.command);
      case 'activate-group': {
        const next: CopyGroupConfig = {
          ...(command.group.id === group.id
            ? mappedGroup(group, command.group)
            : structuredClone(command.group)),
          enabled: true,
          localOnly: true,
        };
        await applyGroup(next, 'activate', {
          ...(command.waiveUnverifiableFollowerOwnership === true
            ? { waiveUnverifiableFollowerOwnership: true as const }
            : {}),
          ...(command.retireMissingOldGroup ? { retireMissingOldGroup: command.retireMissingOldGroup } : {}),
        });
        return;
      }
      case 'arm-live': {
        const deadlineAt = context.deadlineAt ?? (Date.now() + LOCAL_ARM_DEADLINE_MS);
        const commandCreatedAt = context.createdAt ?? Date.now();
        assertArmAdmissible(deadlineAt, admittedBrakeEpoch, commandCreatedAt, context.clockSkewReserveMs);
        const current = options.controller.status();
        if (current.armed && !current.shadowMode) {
          if (armMatchesCurrentConfiguration(command, current)) {
            // Idempotentní potvrzení jen shodné konfigurace. Nevolat
            // DISARM/reconcile/arm a neprodloužit existující session TTL.
            return;
          }
          // Jiná konfigurace pokračuje stejnou atomickou cestou jako base:
          // DISARM -> activate/preflight -> reconciliation -> ARM. Jakákoli
          // chyba ji nechá explicitně DISARMED, nikdy jako falešný úspěch.
        }
        // Volitelný atomický sync konfigurace: dřív UI posílalo update-group
        // + arm-live jako dva relay round-tripy (~5 s); teď jde obojí naráz.
        let routingPrepared = false;
        if (command.group) {
          if (command.group.id !== group.id) {
            // Jediná atomická cesta pro bezpečné UI přepnutí bez brokerových
            // side effectů: DISARM, read-only preflight staré i nové
            // topologie, změna durable epochy a teprve potom reconciliation
            // + ARM. Jakákoli pozice nebo working příkaz přepnutí zablokuje.
            const next: CopyGroupConfig = {
              ...structuredClone(command.group),
              enabled: true,
              localOnly: true,
            };
            await applyGroup(next, 'activate');
            assertArmAdmissible(deadlineAt, admittedBrakeEpoch, commandCreatedAt, context.clockSkewReserveMs);
            routingPrepared = true;
          } else {
            const next = mappedGroup(group, command.group);
            routingPrepared = !sameAccountTopology(group, next);
            await applyGroup(next);
            assertArmAdmissible(deadlineAt, admittedBrakeEpoch, commandCreatedAt, context.clockSkewReserveMs);
          }
        }
        if (current.armed && !current.shadowMode
          && options.controller.status().armed && !options.controller.status().shadowMode
          && armMatchesCurrentConfiguration(command, options.controller.status())) {
          // Pouze metadata/risk pravidla bez execution změny byla aplikována
          // in-place; explicitní ARM sync nesmí zdravý runtime shodit.
          return;
        }
        options.controller.disarm();
        await options.controller.applyAccountEligibilityExclusions(
          validatedAccountEligibilityExclusions(command.accountEligibilityExclusions),
        );
        assertArmAdmissible(deadlineAt, admittedBrakeEpoch, commandCreatedAt, context.clockSkewReserveMs);
        if (!routingPrepared) {
          await awaitArmDeadline(
            prepareAccounts(allAccountsRequired(copyGroupAccountIds(group))),
            deadlineAt,
          );
          assertArmAdmissible(deadlineAt, admittedBrakeEpoch, commandCreatedAt, context.clockSkewReserveMs);
        }
        const reconciliation = await awaitArmDeadline(options.controller.reconcile(), deadlineAt);
        assertArmAdmissible(deadlineAt, admittedBrakeEpoch, commandCreatedAt, context.clockSkewReserveMs);
        if (reconciliation.divergentAccounts.length > 0 || reconciliation.workingOrderAccounts.length > 0) {
          throw new Error('ARM odmítnut: účty nejsou flat/synchronní nebo mají pracovní příkazy');
        }
        // Ostrý ARM končí nejpozději s broker session (17:00 CT). Zapomenutý
        // ARM tak nepřežije do dalšího dne; otevřené kopie expirace
        // risk-redukčně zavře podle `safety.armExpiryFlatten`.
        options.controller.arm({ shadowMode: false, ttlMs: msUntilTradovateSessionEnd(Date.now()) });
        try {
          await awaitArmDeadline(options.controller.waitForIdle(), deadlineAt);
          assertArmAdmissible(deadlineAt, admittedBrakeEpoch, commandCreatedAt, context.clockSkewReserveMs);
        } catch (error) {
          // `arm()` je synchronní, durable potvrzení nikoli. Po deadline nebo
          // souběžné brzdě jej okamžitě stáhneme; pozdější tail nesmí zapnout.
          options.controller.disarm();
          throw error;
        }
        const armedStatus = options.controller.status();
        if (!armedStatus.armed || armedStatus.shadowMode || !(armedStatus.sessionArmedAt && armedStatus.sessionArmedAt > 0)) {
          throw new Error(armedStatus.lastError ?? 'ARM nebyl durable potvrzen');
        }
        return;
      }
      case 'shadow': {
        options.controller.disarm();
        await options.controller.applyAccountEligibilityExclusions(
          validatedAccountEligibilityExclusions(command.accountEligibilityExclusions),
        );
        await prepareAccounts(allAccountsRequired(copyGroupAccountIds(group)));
        const reconciliation = await options.controller.reconcile();
        if (reconciliation.divergentAccounts.length > 0 || reconciliation.workingOrderAccounts.length > 0) {
          throw new Error('SHADOW odmítnut: účty nejsou flat/synchronní nebo mají pracovní příkazy');
        }
        options.controller.arm({ shadowMode: true });
        await options.controller.waitForIdle();
        const shadowStatus = options.controller.status();
        if (!shadowStatus.armed || !shadowStatus.shadowMode) {
          throw new Error(shadowStatus.lastError ?? 'SHADOW nebyl durable potvrzen');
        }
        return;
      }
      case 'disarm':
        brakeEpoch += 1;
        options.controller.disarm();
        recordExecutedBrake(context);
        return;
      case 'kill-switch':
        brakeEpoch += 1;
        options.controller.engageKillSwitch('Kill switch z AlphaTrade LIVE UI');
        recordExecutedBrake(context);
        return;
      case 'reconcile':
        // Samostatná read-only kontrola musí obnovit stejné multi-OAuth
        // routování jako ARM/SHADOW. Jinak účet z druhého připojení zůstane
        // po nové session navždy `unverifiable`, i když je u brokera zdravý.
        {
          const prepared = await prepareAccounts({
            required: [group.leaderAccountId],
            optional: group.followers.map(follower => follower.accountId),
          });
          return options.controller.reconcile({
            missingOptionalAccountIds: [...prepared.missingOptional],
          });
        }
      case 'verify-account-eligibility':
        // Cílené ověření nesmí kvůli účtu z jiné uložené skupiny měnit
        // execution skupinu. Připraví jen jeho OAuth route a provede read-only
        // capability + positions + orders kontrolu.
        await prepareAccounts(allAccountsRequired([command.accountId]));
        return options.controller.verifyAccountEligibility(command.accountId);
      case 'snapshot-test':
        if (!command.requestId || !SNAPSHOT_TEST_REQUEST_ID.test(command.requestId)) {
          throw new Error('snapshot-test-invalid-request');
        }
        if (!options.onSnapshotTest) throw new Error('snapshot-test-unavailable');
        if (command.repairCamera) {
          const controllerStatus = options.controller.status();
          if (!canSafelyRestartLocalCopierAgent(controllerStatus)) {
            throw new LocalCopierAgentCommandError(
              'TradingView lze obnovit pouze při připojeném, reconciled, DISARMED a flat workeru bez pracovních příkazů.',
              {
                code: 'snapshot-repair-blocked',
                blockers: localCopierAgentRestartBlockers(controllerStatus),
                divergentAccounts: [...controllerStatus.divergentAccounts],
                workingOrderAccounts: [...controllerStatus.workingOrderAccounts],
                missingAccounts: [...(controllerStatus.oauthPreflight?.missingAccounts ?? [])],
                inactiveAccounts: [...(controllerStatus.oauthPreflight?.inactiveAccounts ?? [])],
                readOnlyFollowerAccounts: [...(controllerStatus.oauthPreflight?.readOnlyFollowerAccounts ?? [])],
              },
            );
          }
        }
        // Callback pouze založí fire-and-forget práci. Command relay se hned
        // uvolní pro DISARM/kill-switch a nikdy nečeká na CDP, Storage ani APNs.
        options.onSnapshotTest(command.requestId, { repairCamera: command.repairCamera === true });
        return;
      case 'resolve-stuck-operation':
        await options.controller.waiveStuckOperation({
          kind: command.kind,
          key: command.key,
          reason: command.reason,
        });
        return;
      case 'lock-until-session-end':
        {
          const commandCreatedAt = Number.isFinite(context.createdAt) ? context.createdAt! : Date.now();
          const until = tradovateSessionEndAt(commandCreatedAt);
          if (until <= Date.now()) {
            throw new Error('Denní lock nebyl proveden: session skončila');
          }
          brakeEpoch += 1;
          await options.controller.lockUntil(until, command.reason);
          recordExecutedBrake(context);
          return;
        }
      case 'unlock-day':
        await options.controller.unlockDay(command.reason);
        return;
      case 'device-paired': {
        const index = devices.findIndex(item => item.deviceId === command.deviceId);
        const device = index >= 0 ? devices[index] : undefined;
        if (!device || device.state !== 'pairing-required') {
          throw new Error('Lokální Mac zařízení nečeká na toto párování');
        }
        if (!canSafelyRestartLocalCopierAgent(options.controller.status())) {
          throw new Error('Mac worker lze po párování restartovat pouze připojený, reconciled, DISARMED, flat a bez pracovních příkazů');
        }
        await options.onDevicePaired?.(command.deviceId);
        devices[index] = {
          state: 'paired',
          deviceId: device.deviceId,
          connectionId: device.connectionId,
          deviceName: device.deviceName,
        };
        // Stav se po await mohl změnit broker eventem. Ingress zde ještě
        // nezmrazujeme: pokud mezitím vznikla pozice, DISARM/kill-switch/
        // Flatten/reconcile musí zůstat dostupné. Pilot zmrazí runtime i
        // agent synchronně až po druhé čerstvé flat kontrole.
        options.onDevicePairingRestart?.(command.deviceId);
        return;
      }
    }
  };

  const resultPayload = async (
    command: LocalCopierAgentCommand,
    context?: LocalCopierAgentExecutionContext,
    admittedBrakeEpoch?: number,
  ): Promise<LocalCopierAgentCommandResult> => {
    console.log(`${new Date().toISOString()} AGENT COMMAND source=${context?.source ?? 'internal'} type=${command.type}`);
    const result = await execute(command, context, admittedBrakeEpoch);
    return {
      ok: true,
      status: status(),
      ...(result == null ? {} : { result: result as LiveCopyTradingCommandResult }),
    };
  };

  const dispatch = (
    command: LocalCopierAgentCommand,
    context: LocalCopierAgentExecutionContext = {},
    admittedBrakeEpochAtIngress?: number,
  ): Promise<LocalCopierAgentCommandResult> => {
    if (shuttingDown) return Promise.reject(shutdownError());
    const executionContext = {
      ...context,
      createdAt: context.createdAt ?? Date.now(),
    };
    if (isLocalCopierEmergencyCommand(command)) {
      // Brzdy nesdílejí FIFO s brokerovým příkazem ani s ARM preflightem.
      return resultPayload(command, executionContext);
    }
    if (command.type === 'arm-live') {
      const current = options.controller.status();
      if (current.armed && !current.shadowMode && armMatchesCurrentConfiguration(command, current)) {
        return resultPayload(command, executionContext);
      }
      if (!current.connected) {
        return Promise.reject(new Error('ARM odmítnut: worker není připojen k brokeru'));
      }
      if (armPending) return Promise.reject(new Error('ARM odmítnut: jiný ARM už čeká na provedení'));
      armPending = true;
      const admittedBrakeEpoch = admittedBrakeEpochAtIngress ?? brakeEpoch;
      const deadlineAt = executionContext.deadlineAt ?? (Date.now() + LOCAL_ARM_DEADLINE_MS);
      const pending = tail.then(() => {
        if (shuttingDown) throw shutdownError();
        return resultPayload(command, { ...executionContext, deadlineAt }, admittedBrakeEpoch).then(result => {
          if (brakeEpoch !== admittedBrakeEpoch) throw new Error('ARM odmítnut: během přípravy přišla bezpečnostní brzda');
          return result;
        });
      });
      tail = pending.then(() => undefined, () => undefined);
      return pending.finally(() => { armPending = false; });
    }
    const pending = tail.then(() => {
      if (shuttingDown) throw shutdownError();
      return resultPayload(command, executionContext);
    });
    tail = pending.then(() => undefined, () => undefined);
    return pending;
  };

  const server: Server = createServer((request, response) => {
    const origin = request.headers.origin ?? '';
    const developmentOrigin = developmentOrigins.has(origin);
    if (!allowedOrigins.has(origin) && !developmentOrigin) {
      json(response, 403, { error: 'Origin nemá přístup k lokálnímu execution agentovi' });
      return;
    }
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
    response.setHeader('Access-Control-Allow-Private-Network', 'true');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-AlphaTrade-Agent-Nonce, X-AlphaTrade-Command-Deadline');
    if (request.method === 'OPTIONS') {
      response.statusCode = 204;
      response.end();
      return;
    }
    const url = new URL(request.url ?? '/', `http://${host}`);
    if (request.method === 'GET' && url.pathname === '/v1/status') {
      json(response, 200, status());
      return;
    }
    if (request.method !== 'POST' || url.pathname !== '/v1/command') {
      json(response, 404, { error: 'Neznámý endpoint lokálního execution agenta' });
      return;
    }
    if (shuttingDown) {
      json(response, 503, { error: shutdownError().message, status: status() });
      return;
    }
    if (request.headers['x-alphatrade-agent-nonce'] !== nonce) {
      json(response, 401, { error: 'Neplatný session nonce lokálního execution agenta' });
      return;
    }
    // Zachytí se synchronně při příchodu HTTP requestu, ještě před
    // asynchronním čtením body. Později parsovaný ARM proto nemůže
    // převzít epochu brzdy, která dorazila a dokončila body mezitím.
    const admittedBrakeEpoch = brakeEpoch;
    const requestCreatedAt = Date.now();
    void (async () => {
      try {
        if (shuttingDown) throw shutdownError();
        const command = await body(request) as LocalCopierAgentCommand;
        if (shuttingDown) throw shutdownError();
        if (developmentOrigin && !allowFullDevelopmentAccess && !isLocalCopierRiskReducingCommand(command)) {
          throw new Error('Vývojový origin smí pouze číst status nebo poslat DISARM, kill switch či Flatten');
        }
        const rawDeadline = request.headers['x-alphatrade-command-deadline'];
        const localDeadline = boundedLocalArmDeadline(rawDeadline, requestCreatedAt);
        const payload = await dispatch(command, command.type === 'arm-live'
          ? { source: 'loopback', createdAt: requestCreatedAt, deadlineAt: localDeadline }
          : { source: 'loopback', createdAt: requestCreatedAt }, admittedBrakeEpoch);
        json(response, 200, payload);
      } catch (reason) {
        json(response, 409, {
          error: reason instanceof Error ? reason.message : String(reason),
          ...(localCopierAgentErrorDetails(reason) ? { issue: localCopierAgentErrorDetails(reason) } : {}),
          status: status(),
        });
      }
    })();
  });

  await new Promise<void>((resolveStart, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => {
      server.off('error', reject);
      resolveStart();
    });
  });
  const address = server.address() as AddressInfo;
  const beginShutdown = () => {
    if (shuttingDown && serverClosePromise) return;
    shuttingDown = true;
    if (!serverClosePromise) {
      serverClosePromise = new Promise<void>((resolveClose, reject) => {
        server.close(error => error ? reject(error) : resolveClose());
      });
      server.closeIdleConnections?.();
    }
  };
  return {
    origin: `http://${host}:${address.port}`,
    status,
    execute: dispatch,
    beginShutdown,
    async close() {
      beginShutdown();
      await tail;
      await serverClosePromise;
    },
  };
}
