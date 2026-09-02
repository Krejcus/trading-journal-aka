import { access, appendFile, chmod, copyFile, mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createClient as createSupabaseClient, type SupabaseClient } from '@supabase/supabase-js';
import { tradovateApiBaseUrl } from '../../server/tradovateOAuth';
import { loadTradovateAccountData } from '../../server/tradovateAccountData';
import {
  createTradovateAdminClient,
  getValidTradovateAccessToken,
  readTradovateServerConfig,
} from '../../server/tradovateOAuthStore';
import { createFileCopierStore } from '../../services/fileCopierStore';
import { createFileCopyGroupStore } from '../../services/fileCopyGroupStore';
import { createTradovateBroker, type TradovateBrokerPort } from '../../services/tradovateBroker';
import { createBrokerRouter } from '../../services/brokerRouter';
import { isOpenOrderStatus, type BrokerPort } from '../../services/brokerPort';
import {
  refreshDynamicBrokerRoutes,
  resolveDynamicBrokerRoutes,
  type DynamicOAuthConnection,
} from '../../services/dynamicBrokerRouting';
import { dryRunTradovateOrder } from '../../services/tradovateDryRun';
import {
  bootstrapCopierRuntime,
  type CopierRuntimeController,
} from '../../services/copierRuntimeController';
import {
  createCopierMetrics,
  percentile,
  type CopierAuditEntry,
} from '../../services/copierRunner';
import {
  DEFAULT_COPY_GROUP_SAFETY,
  validateStoredCopyGroupForStartup,
  type CopyFollowerConfig,
  type CopyGroupConfig,
} from '../../services/liveCopyTrading';
import type { TradovateAccountDataAccount } from '../../lib/tradovateAccountDataTypes';
import {
  createTradovatePilotKeyPair,
  openTradovatePilotLease,
  type TradovatePilotLeaseEnvelope,
} from '../../server/tradovatePilotLease';
import {
  startLocalCopierExecutionAgent,
  type PrepareGroupAccountsRequest,
  type PrepareGroupAccountsResult,
} from '../../server/localCopierExecutionAgent';
import {
  canSafelyRestartLocalCopierAgent,
  LOCAL_COPIER_AGENT_PORT,
  type CopierSnapshotHealth,
} from '../../lib/localCopierAgentProtocol';
import {
  createMacCopierDevice,
  createMacCopierDeviceTokenProvider,
  loadMacCopierDevice,
  macCopierDevicePairing,
  markMacCopierDevicePaired,
} from '../../server/macCopierDevice';
import { startMacCopierCommandRelay, type MacCopierCommandRelay } from '../../server/macCopierCommandRelay';
import { ensureTradingViewCdp, restartTradingViewWithCdp } from '../../server/tradingViewCdpLifecycle';
import { loadMacCopierConnectionManifest } from '../../server/macCopierConnectionManifest';
import {
  captureTradingViewAlertSnapshot,
  captureTradingViewCopierSnapshot,
  prepareTradingViewCopierSnapshot,
  probeTradingViewSnapshotTarget,
  type TradingViewDedicatedChartRef,
} from '../../services/copierChartSnapshot';
import {
  COPY_EVENT_IMAGE_GRACE_MS,
  COPY_EVENT_IMAGE_PUSH_DEADLINE_MS,
} from '../../server/copierIncidentWatchdog';
import {
  finishAgentCommand,
  flushProcessOutput,
  resolveAgentLifetime,
  scheduleAgentRestart,
  startAgentShutdownWatchdog,
} from './agentLifecycle';

type Command = 'keygen' | 'mac-device-init' | 'accounts' | 'preflight' | 'dry-run' | 'shadow' | 'live' | 'agent';

interface ConnectionRow {
  id: string;
  user_id: string;
  tradovate_email: string | null;
  environment: 'demo' | 'live';
  connection_status: string;
}

interface PilotContext {
  environment: 'demo';
  connectionId: string;
  accountSpec?: string;
  expiresAt: string | null;
  renewable: boolean;
  getAccessToken: () => Promise<string>;
  device?: NonNullable<Parameters<typeof startLocalCopierExecutionAgent>[0]['device']>;
  onDevicePaired?: (deviceId: string) => Promise<void>;
  /** Read-only probe used when pairing was approved in the cloud/QR flow. */
  refreshPairing?: () => Promise<boolean>;
  relay?: { apiOrigin: string; authorizationHeader: () => Promise<string> };
}

interface PilotContextOptions {
  deviceConfigPath?: string;
  leasePath?: string;
  privateKeyPath?: string;
  connectionId?: string;
  accountSpec?: string;
}

type ExecutionAccount = Pick<TradovateAccountDataAccount, 'id' | 'name' | 'active' | 'canTrade'>;

const dedicatedChartConfigPath = resolve(homedir(), 'Library/Application Support/AlphaTrade/copier/chart-snapshot.json');

async function loadDedicatedChartRef(): Promise<TradingViewDedicatedChartRef> {
  try {
    const parsed = JSON.parse(await readFile(dedicatedChartConfigPath, 'utf8')) as Record<string, unknown>;
    return {
      ...(typeof parsed.chart_id === 'string' ? { chartId: parsed.chart_id } : {}),
      ...(typeof parsed.target_id === 'string' ? { targetId: parsed.target_id } : {}),
    };
  } catch (error) {
    if (isCode(error, 'ENOENT') || error instanceof SyntaxError) return {};
    throw error;
  }
}

async function saveDedicatedChartRef(value: TradingViewDedicatedChartRef): Promise<void> {
  await mkdir(dirname(dedicatedChartConfigPath), { recursive: true, mode: 0o700 });
  await writeFile(dedicatedChartConfigPath, `${JSON.stringify({
    chart_id: value.chartId ?? null,
    target_id: value.targetId ?? null,
  }, null, 2)}\n`, { mode: 0o600 });
}

const flags = parseFlags(process.argv.slice(3));
const command = process.argv[2] as Command | undefined;

if (!command || !['keygen', 'mac-device-init', 'accounts', 'preflight', 'dry-run', 'shadow', 'live', 'agent'].includes(command)) {
  usage(command ? `Neznámý příkaz: ${command}` : undefined);
  process.exitCode = command ? 1 : 0;
} else {
  if (command === 'keygen') await generatePilotKeys();
  else if (command === 'mac-device-init') await generateMacDevice();
  else if (command === 'agent') {
    await finishAgentCommand({
      run: () => main(command),
      // V tomto bodě doběhl celý graceful shutdown včetně DISARM, drainu,
      // zavření loopbacku a release locku. Zbylé cizí socket handles nesmí
      // držet launchd službu v half-dead stavu.
      flush: () => flushProcessOutput(),
      exit: code => process.exit(code),
    });
  } else await main(command);
}

async function main(selected: Exclude<Command, 'keygen'>): Promise<void> {
  if (selected === 'agent' && stringFlag('connections-manifest', false)) {
    await runMultiConnectionAgent();
    return;
  }
  const context = await pilotContext();
  const accessToken = await context.getAccessToken();
  const accountResult = await loadTradovateAccountData({
    baseUrl: tradovateApiBaseUrl(context.environment),
    accessToken,
  });
  const accounts = accountResult.accounts;
  const accountSpecsByAccountId = Object.fromEntries(
    accounts.map(account => [account.id, account.name]),
  );

  if (selected === 'accounts') {
    printAccounts(accounts);
    return;
  }

  const leaderId = integerFlag('leader');
  const followerId = integerFlag('follower');
  const selectedAccounts = validatePair(accounts, leaderId, followerId);

  if (selected === 'dry-run') {
    await runDryRun(context, followerId);
    return;
  }

  if (selected === 'preflight') {
    await runPreflight(context, selectedAccounts, accountSpecsByAccountId);
    return;
  }

  if (selected === 'agent') {
    const broker = createTradovateBroker({
      environment: 'demo',
      accountSpec: context.accountSpec,
      accountSpecsByAccountId,
      getAccessToken: context.getAccessToken,
    });
    await runLocalAgent([context], leaderId, followerId, accounts, broker);
    return;
  }

  assertFlatAndNoWorking(selectedAccounts);
  await runRuntime(selected, context, leaderId, followerId, accountSpecsByAccountId);
}

async function runMultiConnectionAgent(): Promise<void> {
  const manifest = await loadMacCopierConnectionManifest(stringFlag('connections-manifest'));
  const loaded = await Promise.all(manifest.connections.map(async entry => {
    const context = await pilotContext({
      deviceConfigPath: entry.deviceConfigPath,
      leasePath: entry.leasePath,
      privateKeyPath: entry.privateKeyPath,
      connectionId: entry.connectionId,
    });
    if (context.connectionId !== entry.connectionId) {
      throw new Error(`Manifest connection ${entry.connectionId} neodpovídá device/lease ${context.connectionId}`);
    }
    const data = await loadTradovateAccountData({
      baseUrl: tradovateApiBaseUrl(context.environment),
      accessToken: await context.getAccessToken(),
    });
    const accountSpecsByAccountId = Object.fromEntries(data.accounts.map(account => [account.id, account.name]));
    const broker = createTradovateBroker({
      environment: 'demo',
      accountSpec: context.accountSpec,
      accountSpecsByAccountId,
      getAccessToken: context.getAccessToken,
      // Do chybových hlášek: bez štítku nejde z logu poznat, které OAuth
      // spojení (propfirma) vypadlo.
      connectionLabel: `conn:${entry.connectionId.slice(0, 8)}`,
    });
    return { context, accounts: data.accounts, broker };
  }));
  const leaderId = integerFlag('leader');
  const followerId = integerFlag('follower');
  const routingConnections: DynamicOAuthConnection[] = loaded.map(item => ({
    connectionId: item.context.connectionId,
    broker: item.broker,
  }));
  const initialSnapshots = new Map(loaded.map(item => [
    item.context.connectionId,
    item.accounts.map(account => ({
      accountId: account.id,
      accountSpec: account.name,
      active: account.active,
      canTrade: account.canTrade,
    })),
  ]));
  const initialRouting = resolveDynamicBrokerRoutes(routingConnections, initialSnapshots);
  const accounts = initialRouting.accounts;
  // Spojení nesoucí leader stream je kritické (výpadek = okamžitý DISARM);
  // follower-only propfirmy dostávají reconnect lhůtu, aby token cyklus
  // jedné z nich nezastavoval kopírování všech ostatních.
  const broker = createBrokerRouter(initialRouting.routes.map(route => ({
    ...route,
    critical: route.accountIds.includes(leaderId),
  })));
  for (const route of initialRouting.routes) {
    const connection = loaded.find(item => item.broker === route.broker);
    console.log(`CONNECTION conn:${connection?.context.connectionId.slice(0, 8) ?? 'unknown'} účty=${route.accountIds.join(',')}`);
  }
  await runLocalAgent(
    loaded.map(item => item.context), leaderId, followerId, accounts, broker,
    loaded.map(item => ({ broker: item.broker, label: `conn:${item.context.connectionId.slice(0, 8)}` })),
    async request => {
      const refreshed = await refreshDynamicBrokerRoutes(routingConnections, broker, request);
      for (const accountId of refreshed.missingOptional) {
        console.warn(
          `${new Date().toISOString()} ROUTING OPTIONAL SKIP účet=${accountId} důvod=účet není viditelný v žádném připojeném OAuth adresáři`,
        );
      }
      return { missingOptional: refreshed.missingOptional };
    },
  );
}

async function runLocalAgent(
  contexts: PilotContext[],
  leaderId: number,
  followerId: number,
  accounts: ExecutionAccount[],
  baseBroker: BrokerPort,
  renewableBrokers: ReadonlyArray<{ broker: TradovateBrokerPort; label: string }> = [],
  prepareGroupAccounts?: (request: PrepareGroupAccountsRequest) => Promise<PrepareGroupAccountsResult>,
): Promise<void> {
  const context = contexts[0];
  if (!context) throw new Error('Lokální agent potřebuje alespoň jedno OAuth spojení');
  const portValue = numberFlag('port', false) ?? LOCAL_COPIER_AGENT_PORT;
  const minutesValue = numberFlag('minutes', false) ?? 480;
  const multiplierValue = numberFlag('multiplier', false) ?? 1;
  if (!Number.isSafeInteger(portValue) || Number(portValue) < 1024 || Number(portValue) > 65_535) {
    throw new Error('--port musí být celé číslo v rozsahu 1024–65535');
  }
  const lifetime = resolveAgentLifetime({
    requestedMinutes: Number(minutesValue),
    serviceLifetime: stringFlag('service-lifetime', false),
    contexts: contexts.map(candidate => ({
      renewable: candidate.renewable,
      paired: candidate.device?.state === 'paired',
      relayAvailable: candidate.relay != null,
    })),
  });
  if (!Number.isFinite(multiplierValue) || Number(multiplierValue) <= 0 || Number(multiplierValue) > 100) {
    throw new Error('--multiplier musí být větší než 0 a nejvýše 100');
  }
  // `--followers` rozšiřuje agenta na víc účtů s vlastními parametry;
  // bez něj platí původní dvojice `--follower/--multiplier` (mac-install).
  const followersFlag = stringFlag('followers', false);
  const followers: CopyFollowerConfig[] = followersFlag
    ? parseFollowersFlag(followersFlag, leaderId)
    : [{ accountId: followerId, mode: 'on-submit', multiplier: Number(multiplierValue) }];
  for (const candidate of contexts) {
    if (!candidate.renewable && candidate.expiresAt) {
      // Nespárovaný device má jednorázový bootstrap token, ale po schválení
      // umí přejít na obnovitelné device tokeny bez brokerového side effectu.
      // Stačí mu bezpečné okno na dokončení párování; běžný statický lease
      // musí stále vydržet celý deklarovaný běh.
      const requiredMs = candidate.refreshPairing
        ? 10 * 60_000
        : (Number(minutesValue) + 5) * 60_000;
      if (Date.parse(candidate.expiresAt) - Date.now() <= requiredMs) {
        const requirement = candidate.refreshPairing
          ? 'alespoň 10 minut pro dokončení párování'
          : `celý ${minutesValue}min běh a 5min rezervu`;
        throw new Error(`Pilot lease spojení ${candidate.connectionId} nevydrží ${requirement}; stáhni nový lease`);
      }
    }
  }

  const root = resolve('.copier-pilot');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const followerIdsKey = followers.map(item => item.accountId).join('-');
  // Durable stav patří leaderovi/runtime, ne konkrétnímu seznamu followerů.
  // Jinak by pouhé přidání účtu založilo nový outbox a ztratilo recovery.
  const key = `${context.connectionId}-${leaderId}`;
  await migrateLegacyPilotState(root, `${key}-${followerIdsKey}`, key);
  const auditPath = resolve(root, `${key}.audit.jsonl`);
  const groupStore = createFileCopyGroupStore(resolve(root, `${key}.group.json`));
  const cooldownMinutes = numberFlag('cooldown-min', false) ?? 0;
  if (!Number.isFinite(cooldownMinutes) || cooldownMinutes < 0 || cooldownMinutes > 720) {
    throw new Error('--cooldown-min musí být v rozsahu 0–720');
  }
  const fallbackGroup: CopyGroupConfig = {
    id: `agent-${leaderId}-${followerIdsKey}`,
    name: 'Lokální DEMO agent',
    enabled: true,
    leaderAccountId: leaderId,
    followers,
    ...(cooldownMinutes > 0 ? {
      safety: { ...DEFAULT_COPY_GROUP_SAFETY, entryCooldownMinutes: Math.floor(cooldownMinutes) },
    } : {}),
    localOnly: true,
  };
  const persistedGroup = await groupStore.load();
  // CLI leader určuje jen stabilní instalační slot/soubor. Po první bezpečné
  // změně z UI je autoritativní uložená skupina, takže reinstall nepřepíše
  // leadera zpět na původní hodnotu.
  const group = persistedGroup ?? fallbackGroup;
  const broker = baseBroker;
  const runtimeStore = createFileCopierStore(resolve(root, `${key}.snapshot.json`));
  const durableSnapshot = await runtimeStore.load();
  const validation = validateStoredCopyGroupForStartup(
    group,
    accounts,
    durableSnapshot.safety?.accountEligibility ?? [],
  );
  if (!validation.valid) {
    throw new Error(`Uložená copy group není bezpečně použitelná: ${validation.errors.join(' ')}`);
  }
  const releaseLock = await acquireProcessLock(resolve(root, `${key}.lock`));
  let auditTail = Promise.resolve();
  let controller: CopierRuntimeController | null = null;
  let agent: Awaited<ReturnType<typeof startLocalCopierExecutionAgent>> | null = null;
  let relay: MacCopierCommandRelay | null = null;
  const snapshotsEnabled = process.env.ALPHATRADE_SNAPSHOTS?.trim().toLowerCase() !== 'off';
  let dedicatedChartRef: TradingViewDedicatedChartRef = {};
  if (snapshotsEnabled) {
    try {
      dedicatedChartRef = await loadDedicatedChartRef();
    } catch (error) {
      console.warn(`${new Date().toISOString()} SNAPSHOT dedicated config ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  let snapshotHealth: CopierSnapshotHealth = {
    enabled: snapshotsEnabled,
    repairSupported: true,
    state: snapshotsEnabled ? 'checking' : 'disabled',
    layoutName: 'AlphaTrade Snapshoty',
    chartIdConfigured: Boolean(dedicatedChartRef.chartId),
    cdpReachable: false,
    targetFound: false,
    lastCheckedAt: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
  };
  if (snapshotsEnabled) {
    const lifecycle = await ensureTradingViewCdp(
      process.env.ALPHATRADE_TV_AUTO_LAUNCH?.trim().toLowerCase() === 'on',
    );
    if (lifecycle === 'running-without-cdp') {
      console.warn(`${new Date().toISOString()} SNAPSHOT TradingView už běží bez CDP; je potřeba jej jednou ukončit a znovu spustit přes AlphaTrade.`);
    } else if (lifecycle === 'launched') {
      console.log(`${new Date().toISOString()} SNAPSHOT TradingView spuštěno s lokálním CDP 127.0.0.1:9222.`);
    } else if (lifecycle === 'launch-failed') {
      console.warn(`${new Date().toISOString()} SNAPSHOT TradingView se nepodařilo automaticky spustit.`);
    }
  }
  const persistResolvedChart = (resolved: TradingViewDedicatedChartRef) => {
    dedicatedChartRef = { ...dedicatedChartRef, ...resolved };
    snapshotHealth = {
      ...snapshotHealth,
      chartIdConfigured: Boolean(dedicatedChartRef.chartId),
      targetFound: true,
    };
    void saveDedicatedChartRef(dedicatedChartRef).catch(error => {
      console.warn(`${new Date().toISOString()} SNAPSHOT dedicated config ${error instanceof Error ? error.message : String(error)}`);
    });
  };
  let snapshotPreparation: Promise<boolean> | null = null;
  let snapshotCapturesInFlight = 0;
  let snapshotMaintenanceInFlight = false;
  const prepareSnapshotCamera = (): Promise<boolean> => {
    if (snapshotPreparation) return snapshotPreparation;
    const preparation = prepareTradingViewCopierSnapshot({
      dedicated: dedicatedChartRef,
      timeoutMs: 6_000,
      onDedicatedResolved: persistResolvedChart,
    });
    const tracked = preparation.finally(() => {
      if (snapshotPreparation === tracked) snapshotPreparation = null;
    });
    snapshotPreparation = tracked;
    return tracked;
  };
  const withSnapshotCamera = async <T>(capture: () => Promise<T>): Promise<T> => {
    // Flag se nastaví synchronně ještě před prvním await. Periodický health
    // refresh tak nemůže otevřít druhý CDP reset uprostřed ostrého capture.
    snapshotCapturesInFlight += 1;
    try {
      await snapshotPreparation;
      return await capture();
    } finally {
      snapshotCapturesInFlight -= 1;
    }
  };
  const refreshSnapshotHealth = async (duringMaintenance = false) => {
    if (
      !snapshotsEnabled
      || snapshotCapturesInFlight > 0
      || (snapshotMaintenanceInFlight && !duringMaintenance)
    ) return;
    const probe = await probeTradingViewSnapshotTarget({ dedicated: dedicatedChartRef, timeoutMs: 1_500 });
    if (probe.resolved) persistResolvedChart(probe.resolved);
    // Capture mohl začít během síťového probe. V tom případě přípravu tento
    // cyklus přeskočí; další health tick kameru zkontroluje za 30 sekund.
    if (snapshotCapturesInFlight > 0) return;
    const prepared = probe.targetFound ? await prepareSnapshotCamera() : false;
    snapshotHealth = {
      ...snapshotHealth,
      state: !probe.cdpReachable
        ? 'cdp-offline'
        : !probe.targetFound ? 'layout-missing' : prepared ? 'ready' : 'capture-failed',
      chartIdConfigured: Boolean(dedicatedChartRef.chartId),
      cdpReachable: probe.cdpReachable,
      targetFound: probe.targetFound,
      lastCheckedAt: Date.now(),
    };
  };
  if (snapshotsEnabled) await refreshSnapshotHealth();
  const snapshotHealthTimer = snapshotsEnabled
    ? setInterval(() => { void refreshSnapshotHealth(); }, 30_000)
    : null;
  snapshotHealthTimer?.unref();
  const tvSnapshotHandledUntil = new Map<string, number>();
  let snapshotTestInFlight = false;
  let stopPromise: Promise<void> | null = null;
  let pairingProbeTimer: ReturnType<typeof setInterval> | null = null;
  let pairingProbeInFlight = false;
  let pairingProbeTail: Promise<void> = Promise.resolve();
  let pairingRestartPending = false;
  let pairingRestartTimer: ReturnType<typeof setTimeout> | null = null;
  const writeAudit = async (entries: readonly CopierAuditEntry[]) => {
    if (entries.length === 0) return;
    await appendFile(auditPath, entries.map(entry => `${JSON.stringify(entry)}\n`).join(''), { mode: 0o600 });
    for (const entry of entries) {
      console.log(`${new Date(entry.at).toISOString()} ${entry.kind} account=${entry.accountId ?? '-'} reason=${entry.reason ?? '-'}`);
    }
  };
  const stop = (reason: string): Promise<void> => {
    if (stopPromise) return stopPromise;
    const runtimeShutdown = controller?.beginShutdown();
    agent?.beginShutdown();
    if (pairingProbeTimer) clearInterval(pairingProbeTimer);
    if (pairingRestartTimer) clearTimeout(pairingRestartTimer);
    if (snapshotHealthTimer) clearInterval(snapshotHealthTimer);
    const cancelShutdownWatchdog = startAgentShutdownWatchdog({
      timeoutMs: 20_000,
      onTimeout: () => {
        // Poslední fail-closed pojistka: žádný broker write ani Flatten.
        // Durable sending outbox zůstane po restartu k lookup recovery.
        controller?.stop();
        console.error(`STOP TIMEOUT ${reason}; vynucuji ukončení DISARMED procesu.`);
        process.exit(1);
      },
    });
    stopPromise = (async () => {
      let firstFailure: unknown;
      const attempt = async (cleanup: () => Promise<void> | void) => {
        try {
          await cleanup();
        } catch (error) {
          firstFailure ??= error;
        }
      };
      await attempt(() => relay?.close());
      await attempt(() => pairingProbeTail);
      await attempt(() => runtimeShutdown);
      // Drain broker/audit safety work before controller.stop() clears its
      // pending bracket/OSO timers and subscriptions.
      await attempt(() => controller?.waitForIdle());
      await attempt(() => auditTail);
      await attempt(() => agent?.close());
      await attempt(() => controller?.stop());
      await attempt(releaseLock);
      cancelShutdownWatchdog();
      if (firstFailure) throw firstFailure;
      console.log(`STOP ${reason}; lokální execution agent je DISARMED a ukončen.`);
    })();
    return stopPromise;
  };
  let signalExitScheduled = false;
  const onSignal = () => {
    if (signalExitScheduled) return;
    signalExitScheduled = true;
    void stop('operator-signal')
      .then(() => flushProcessOutput())
      .then(() => process.exit(0))
      .catch(async error => {
        console.error(`STOP operator-signal selhal: ${error instanceof Error ? error.message : String(error)}`);
        await flushProcessOutput();
        process.exit(1);
      });
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const abortLateStartupIfStopping = async (): Promise<boolean> => {
    if (!stopPromise) return false;
    // SIGTERM mohl přijít během await, kdy resource ještě nebyl přiřazený a
    // první stop() jej proto nemohl zavřít. Gates nastavujeme synchronně před
    // prvním dalším yieldem, aby pozdní loopback/relay nikdy nepřijal command.
    const runtimeShutdown = controller?.beginShutdown();
    agent?.beginShutdown();
    await Promise.allSettled([
      agent?.close() ?? Promise.resolve(),
      runtimeShutdown ?? Promise.resolve(),
      controller?.waitForIdle() ?? Promise.resolve(),
    ]);
    controller?.stop();
    return true;
  };
  const requestSafePairingRestart = () => {
    if (pairingRestartPending) return;
    pairingRestartPending = true;
    const check = () => {
      pairingRestartTimer = null;
      if (stopPromise) return;
      if (!canSafelyRestartLocalCopierAgent(controller?.status())) {
        pairingRestartTimer = setTimeout(check, 1_000);
        pairingRestartTimer.unref();
        return;
      }
      // Odložení nechá právě běžící pairing HTTP odpověď bezpečně doběhnout.
      scheduleAgentRestart({
        delayMs: 750,
        restart: () => {
          if (stopPromise) return;
          if (!canSafelyRestartLocalCopierAgent(controller?.status())) {
            pairingRestartTimer = setTimeout(check, 1_000);
            pairingRestartTimer.unref();
            return;
          }
          // Bez await mezi poslední flat kontrolou, nevratným runtime gate a
          // signalem: broker event ani UI command se sem nemohou vložit.
          void controller?.beginShutdown();
          agent?.beginShutdown();
          process.kill(process.pid, 'SIGTERM');
        },
      });
    };
    check();
  };
  try {
    controller = await bootstrapCopierRuntime({
      broker,
      store: runtimeStore,
      group,
      metrics: createCopierMetrics(),
      // Všichni followeři musí odejít v JEDEN okamžik. Sériový dispatch
      // (pilotní `1`) rozprostřel marketové nohy přes stovky ms — každá
      // kopie pak trefila jinou cenu a P&L kopií se rozcházela. Limitů se
      // to netýká (kniha čeká), marketů/flatten/close zásadně.
      maxConcurrentDispatches: Math.max(4, group.followers.length),
      onAudit: entries => {
        auditTail = auditTail.then(() => writeAudit(entries));
      },
      onError: error => console.error(`${new Date().toISOString()} FAIL-CLOSED ${error.message}`),
      // Trade event -> okamžitý poll s příznakem -> server pushne hned.
      onCopyEvent: event => {
        relay?.nudgeCopyEvents();
        if (!snapshotsEnabled || !relay || !event.episodeId) return;
        // Jen vstup a výstup (rozhodnutí uživatele 2026-08-22): posun SL je
        // vlastní akce — notifikace stačí textová a snímek by byl jen šum.
        if (event.kind !== 'entry' && event.kind !== 'exit') return;
        const snapshotRelay = relay;
        const notifyDeadlineAt = event.at + COPY_EVENT_IMAGE_PUSH_DEADLINE_MS;
        // Po grace worker vyvolá druhý průchod. Pokud obrázek uspěl, serverový
        // marker z něj udělá no-op; jinak tentýž event odejde jako text.
        const fallbackTimer = setTimeout(
          () => snapshotRelay.nudgeCopyEvents(),
          Math.max(0, event.at + COPY_EVENT_IMAGE_GRACE_MS + 25 - Date.now()),
        );
        fallbackTimer.unref();
        // Záměrně bez await: CDP ani síť nesmí vstoupit do dispatch/eventTail.
        snapshotHealth = { ...snapshotHealth, lastAttemptAt: Date.now() };
        void withSnapshotCamera(async () => {
          const remaining = notifyDeadlineAt - Date.now();
          if (remaining <= 0) return null;
          return captureTradingViewCopierSnapshot({
            dedicated: dedicatedChartRef,
            timeoutMs: Math.min(1_200, remaining),
            onDedicatedResolved: persistResolvedChart,
          });
        }).then(async png => {
          if (!png) {
            await refreshSnapshotHealth();
            if (snapshotHealth.state === 'ready') snapshotHealth = { ...snapshotHealth, state: 'capture-failed' };
            return;
          }
          if (png.byteLength > 2 * 1024 * 1024) {
            snapshotHealth = { ...snapshotHealth, state: 'capture-failed' };
            console.warn(`${new Date().toISOString()} SNAPSHOT PNG je větší než 2 MB; zahazuji ${event.symbol} ${event.kind}`);
            return;
          }
          try {
            await snapshotRelay.uploadSnapshot({
              episodeId: event.episodeId!,
              kind: event.kind,
              at: event.at,
              symbol: event.symbol,
              png: png.toString('base64'),
              notifyDeadlineAt,
            }, { deadlineAt: notifyDeadlineAt });
            snapshotHealth = { ...snapshotHealth, state: 'ready', lastSuccessAt: Date.now() };
          } catch (error) {
            snapshotHealth = { ...snapshotHealth, state: 'upload-failed' };
            throw error;
          }
        }).catch(error => {
          if (snapshotHealth.state !== 'upload-failed') snapshotHealth = { ...snapshotHealth, state: 'capture-failed' };
          console.warn(`${new Date().toISOString()} SNAPSHOT ${error instanceof Error ? error.message : String(error)}`);
        });
      },
    });
    if (await abortLateStartupIfStopping()) return;
    await waitUntil(
      () => stopPromise != null || controller?.status().connected === true,
      15_000,
      'WebSocket sync timeout',
    );
    if (await abortLateStartupIfStopping()) return;
    agent = await startLocalCopierExecutionAgent({
      controller,
      group,
      port: Number(portValue),
      devices: contexts.flatMap(candidate => candidate.device ? [candidate.device] : []),
      snapshotHealth: () => snapshotHealth,
      onSnapshotTest: (requestId, options) => {
        if (!snapshotsEnabled) throw new Error('snapshot-test-unavailable');
        if (snapshotTestInFlight) throw new Error('snapshot-test-already-running');
        snapshotTestInFlight = true;
        snapshotHealth = { ...snapshotHealth, lastAttemptAt: Date.now() };
        if (options.repairCamera) {
          snapshotMaintenanceInFlight = true;
          snapshotHealth = {
            ...snapshotHealth,
            state: 'checking',
            cdpReachable: false,
            targetFound: false,
          };
          void (async () => {
            const lifecycle = await restartTradingViewWithCdp();
            if (lifecycle !== 'ready' && lifecycle !== 'restarted') {
              throw new Error(`tradingview-restart-${lifecycle}`);
            }
            for (let attempt = 0; attempt < 4; attempt += 1) {
              await refreshSnapshotHealth(true);
              if (snapshotHealth.state === 'ready') break;
              await delay(500);
            }
            if (snapshotHealth.state !== 'ready') {
              throw new Error(`tradingview-restart-camera-${snapshotHealth.state}`);
            }
            console.log(`${new Date().toISOString()} SNAPSHOT TradingView bezpečně restartováno s CDP z LIVE UI.`);
          })().catch(error => {
            const cdpWasRecovered = snapshotHealth.cdpReachable;
            snapshotHealth = {
              ...snapshotHealth,
              state: cdpWasRecovered ? snapshotHealth.state : 'cdp-offline',
              ...(cdpWasRecovered ? {} : { cdpReachable: false, targetFound: false }),
              lastCheckedAt: Date.now(),
            };
            console.warn(`${new Date().toISOString()} SNAPSHOT RESTART ${error instanceof Error ? error.message : String(error)}`);
          }).finally(() => {
            snapshotMaintenanceInFlight = false;
            snapshotTestInFlight = false;
          });
          return;
        }
        if (!relay) {
          snapshotTestInFlight = false;
          throw new Error('snapshot-test-unavailable');
        }
        const snapshotRelay = relay;
        // Žádný await do command relay/broker cesty: agent command se vrátí
        // okamžitě a focení + APNs běží jako samostatný observability úkol.
        void (async () => {
          await snapshotPreparation;
          if (snapshotHealth.state !== 'ready') await refreshSnapshotHealth();
          if (snapshotHealth.state !== 'ready') {
            throw new Error(`snapshot-test-camera-${snapshotHealth.state}`);
          }
          const png = await withSnapshotCamera(() => captureTradingViewCopierSnapshot({
            dedicated: dedicatedChartRef,
            timeoutMs: 3_000,
            onDedicatedResolved: persistResolvedChart,
          }));
          if (!png) throw new Error('snapshot-test-capture-failed');
          if (png.byteLength > 2 * 1024 * 1024) throw new Error('snapshot-test-too-large');
          const push = await snapshotRelay.uploadSnapshotTest({
            requestId,
            png: png.toString('base64'),
          });
          snapshotHealth = { ...snapshotHealth, state: 'ready', lastSuccessAt: Date.now() };
          console.log(`${new Date().toISOString()} SNAPSHOT TEST ${requestId.slice(0, 8)} APNs ${push.sent}/${push.devices}`);
        })().catch(error => {
          snapshotHealth = {
            ...snapshotHealth,
            state: String(error).includes('capture') ? 'capture-failed' : 'upload-failed',
          };
          console.warn(`${new Date().toISOString()} SNAPSHOT TEST ${error instanceof Error ? error.message : String(error)}`);
        }).finally(() => {
          snapshotTestInFlight = false;
        });
      },
      onDevicePaired: async deviceId => {
        const owner = contexts.find(candidate => candidate.device?.deviceId === deviceId);
        if (!owner?.onDevicePaired) throw new Error('Párované zařízení nemá vlastní OAuth pairing callback');
        await owner.onDevicePaired(deviceId);
      },
      onDevicePairingRestart: requestSafePairingRestart,
      onGroupChanged: async changed => {
        await groupStore.save(changed);
      },
      prepareGroupAccounts,
    });
    if (await abortLateStartupIfStopping()) return;
    const pendingPairingContexts = contexts.filter(candidate => (
      candidate.device?.state === 'pairing-required' && candidate.refreshPairing
    ));
    if (pendingPairingContexts.length > 0) {
      const probePairing = (): Promise<void> => {
        if (pairingProbeInFlight || stopPromise || !agent) return pairingProbeTail;
        pairingProbeInFlight = true;
        const run = (async () => {
          for (const candidate of pendingPairingContexts) {
            if (!candidate.refreshPairing || candidate.device?.state !== 'pairing-required') continue;
            if (!await candidate.refreshPairing()) continue;
            try {
              await agent.execute({ type: 'device-paired', deviceId: candidate.device.deviceId });
              console.log(`${new Date().toISOString()} DEVICE PAIRED ${candidate.device.deviceId.slice(0, 8)}; čekám na bezpečný restart.`);
            } catch {
              // Schválení už je durable. Pokud runtime právě není bezpečně
              // flat/reconciled, další read-only probe zkusí restart později.
            }
          }
        })();
        pairingProbeTail = run.finally(() => {
          pairingProbeInFlight = false;
        });
        return pairingProbeTail;
      };
      pairingProbeTimer = setInterval(() => { void probePairing(); }, 5_000);
      pairingProbeTimer.unref();
      void probePairing();
    }
    if (context.relay) {
      relay = startMacCopierCommandRelay({
        ...context.relay,
        agent,
        // Realtime budíček: příkaz z UI dorazí za ~100–300 ms místo čekání
        // na poll interval. Kanál nese jen „kick", data jdou dál přes
        // autentizovaný REST relay; poll zůstává jako záloha.
        createKickSubscription: (config, onKick) => {
          const client = createSupabaseClient(config.url, config.anonKey, {
            auth: { persistSession: false, autoRefreshToken: false },
          });
          const channel = client.channel(config.topic);
          channel.on('broadcast', { event: 'kick' }, () => {
            console.log(`${new Date().toISOString()} RELAY KICK přijat`);
            onKick();
          }).subscribe(subscriptionState => {
            if (subscriptionState === 'SUBSCRIBED') {
              console.log(`${new Date().toISOString()} RELAY KICK aktivní (${config.topic})`);
            }
          });
          return async () => {
            try {
              await client.removeChannel(channel);
            } finally {
              await client.realtime.disconnect();
            }
          };
        },
        onSnapshotRequests: requests => {
          console.log(`${new Date().toISOString()} SNAPSHOT požadavky: ${requests.map(r => `${r.id.slice(0, 8)}/${r.symbol}`).join(', ')}`);
          if (!snapshotsEnabled || !relay) return;
          const now = Date.now();
          for (const [id, until] of tvSnapshotHandledUntil) {
            if (until <= now) tvSnapshotHandledUntil.delete(id);
          }
          for (const request of requests) {
            if (tvSnapshotHandledUntil.has(request.id)) continue;
            tvSnapshotHandledUntil.set(request.id, now + 60_000);
            const snapshotRelay = relay;
            // Poll callback pouze naplánuje práci. Navigace, render, capture i
            // upload mají společný 6s deadline a nikdy nejsou awaitované zde.
            void (async () => {
              const deadlineAt = Date.now() + 30_000;
              const png = await captureTradingViewAlertSnapshot({
                symbol: request.symbol,
                timeframe: request.timeframe,
                dedicated: dedicatedChartRef,
                timeoutMs: Math.min(11_000, deadlineAt - Date.now()),
                onDedicatedResolved: resolved => {
                  dedicatedChartRef = { ...dedicatedChartRef, ...resolved };
                  void saveDedicatedChartRef(dedicatedChartRef).catch(error => {
                    console.warn(`${new Date().toISOString()} SNAPSHOT dedicated config ${error instanceof Error ? error.message : String(error)}`);
                  });
                },
              });
              if (!png || Date.now() >= deadlineAt) {
                console.warn(`${new Date().toISOString()} SNAPSHOT TV alert capture selhal (${request.symbol}, png=${png ? 'ok' : 'null'}, po deadline=${Date.now() >= deadlineAt})`);
                return;
              }
              if (png.byteLength > 2 * 1024 * 1024) {
                console.warn(`${new Date().toISOString()} SNAPSHOT TV alert PNG je větší než 2 MB; zahazuji ${request.symbol}`);
                return;
              }
              await snapshotRelay.uploadSnapshot({
                episodeId: request.id,
                kind: 'tv-alert',
                at: Date.now(),
                symbol: request.symbol,
                png: png.toString('base64'),
              }, { deadlineAt });
            })().catch(error => {
              console.warn(`${new Date().toISOString()} SNAPSHOT TV alert ${error instanceof Error ? error.message : String(error)}`);
            });
          }
        },
      });
    }
    console.log(`LOCAL AGENT ${agent.origin} leader=${leaderId} followers=${group.followers.map(item => `${item.accountId}@${item.multiplier}${item.maxContracts != null ? `@max${item.maxContracts}` : ''}`).join(',')}`);
    console.log('Stav je DISARMED. ARM, Flatten, Flatten All a násobek vyžadují explicitní akci v AlphaTrade LIVE UI.');
    // Plynulá obměna WS před cyklem Tradovate access tokenu (~80 min):
    // po 50 min se čeká na flat/klidný moment, po 70 min se obměňuje i
    // uprostřed obchodu — řízený sub-sekundový swap je bezpečnější než
    // nechat server tvrdě zavřít socket (DISARM + povinná reconciliation).
    const RENEW_AFTER_MS = 50 * 60_000;
    const RENEW_FORCE_MS = 70 * 60_000;
    const renewalAt = new Map(renewableBrokers.map(item => [item, Date.now()]));
    const maybeRenewSockets = () => {
      const status = controller?.status();
      if (!status?.connected) return;
      const now = Date.now();
      for (const item of renewableBrokers) {
        const age = now - (renewalAt.get(item) ?? now);
        if (age < RENEW_AFTER_MS) continue;
        const inTrade = status.armed && status.groupFlat === false;
        if (inTrade && age < RENEW_FORCE_MS) continue;
        if (item.broker.renewSocket()) {
          renewalAt.set(item, now);
          console.log(`${new Date().toISOString()} SOCKET RENEWAL ${item.label} (věk ${Math.round(age / 60_000)} min${inTrade ? ', vynuceno v obchodě' : ''})`);
        }
      }
    };
    if (lifetime.kind === 'persistent') {
      console.log('SERVICE LIFETIME persistent; plánovaný časový restart je vypnutý.');
      while (!stopPromise) {
        await delay(1_000);
        maybeRenewSockets();
      }
      await stop('service-stop');
    } else {
      if (stringFlag('service-lifetime', false).trim().toLowerCase() === 'persistent') {
        console.warn(`SERVICE LIFETIME čeká na plné spárování; tento běh zůstává omezený na ${lifetime.minutes} min.`);
      }
      const deadline = Date.now() + lifetime.minutes * 60_000;
      while (Date.now() < deadline && !stopPromise) {
        await delay(1_000);
        maybeRenewSockets();
      }
      await stop('time-limit');
    }
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    if (!stopPromise) await stop('startup-failure');
  }
}

async function migrateLegacyPilotState(root: string, legacyKey: string, stableKey: string): Promise<void> {
  if (legacyKey === stableKey) return;
  for (const suffix of ['group.json', 'snapshot.json', 'audit.jsonl']) {
    const source = resolve(root, `${legacyKey}.${suffix}`);
    const target = resolve(root, `${stableKey}.${suffix}`);
    try {
      await access(target);
      continue;
    } catch (error) {
      if (!isCode(error, 'ENOENT')) throw error;
    }
    try {
      await copyFile(source, target);
      await chmod(target, 0o600);
    } catch (error) {
      if (!isCode(error, 'ENOENT')) throw error;
    }
  }
}

async function pilotContext(options: PilotContextOptions = {}): Promise<PilotContext> {
  const deviceConfigPath = options.deviceConfigPath ?? stringFlag('device-config', false);
  let deviceConfig = deviceConfigPath ? await loadMacCopierDevice(deviceConfigPath) : null;
  if (deviceConfig && !deviceConfig.paired && deviceConfigPath) {
    const pendingProvider = createMacCopierDeviceTokenProvider({ config: deviceConfig });
    try {
      await pendingProvider.refresh();
      deviceConfig = await markMacCopierDevicePaired(deviceConfigPath);
    } catch {
      // The server has not approved this device yet. Continue with the one-time
      // bootstrap lease and expose the pairing request to the operator.
    }
  }
  if (deviceConfig?.paired) {
    const provider = createMacCopierDeviceTokenProvider({ config: deviceConfig });
    const payload = await provider.refresh();
    return {
      environment: 'demo',
      connectionId: payload.connectionId,
      accountSpec: payload.accountSpec,
      expiresAt: payload.expiresAt,
      renewable: true,
      getAccessToken: provider.getAccessToken,
      relay: { apiOrigin: deviceConfig.apiOrigin, authorizationHeader: provider.authorizationHeader },
      device: {
        state: 'paired',
        deviceId: deviceConfig.deviceId,
        connectionId: deviceConfig.connectionId,
        deviceName: deviceConfig.deviceName,
      },
    };
  }
  const leasePath = options.leasePath ?? stringFlag('lease', false);
  if (leasePath) {
    const privateKeyPath = options.privateKeyPath
      ?? (stringFlag('private-key', false) || deviceConfig?.privateKeyPath || resolve('.copier-pilot/pilot-private.pem'));
    const envelope = JSON.parse(await readFile(resolve(leasePath), 'utf8')) as TradovatePilotLeaseEnvelope;
    const privateKey = await readFile(resolve(privateKeyPath), 'utf8');
    const payload = openTradovatePilotLease(envelope, privateKey);
    let paired = false;
    const provider = deviceConfig ? createMacCopierDeviceTokenProvider({ config: deviceConfig }) : null;
    if (deviceConfig && payload.connectionId !== deviceConfig.connectionId) {
      throw new Error('Mac device a pilot lease míří na rozdílné Tradovate připojení');
    }
    const getAccessToken = async () => {
      if (paired && provider) return provider.getAccessToken();
      if (Date.parse(payload.expiresAt) - Date.now() <= 120_000) throw new Error('pilot-lease-expired');
      return payload.accessToken;
    };
    const pairing = deviceConfig ? await macCopierDevicePairing({ config: deviceConfig }) : null;
    const confirmPairing = async (deviceId: string): Promise<void> => {
      if (!pairing || deviceId !== pairing.deviceId || !deviceConfigPath || !provider) {
        throw new Error('Neplatné potvrzení Mac device párování');
      }
      if (paired) return;
      await provider.refresh();
      await markMacCopierDevicePaired(deviceConfigPath);
      paired = true;
    };
    return {
      environment: 'demo',
      connectionId: payload.connectionId,
      accountSpec: payload.accountSpec,
      expiresAt: payload.expiresAt,
      renewable: false,
      getAccessToken,
      ...(pairing ? {
        device: {
          state: 'pairing-required' as const,
          deviceId: pairing.deviceId,
          connectionId: pairing.connectionId,
          deviceName: pairing.deviceName,
          deviceSecret: pairing.deviceSecret,
          publicKey: pairing.publicKey,
        },
        onDevicePaired: async (deviceId: string) => {
          await confirmPairing(deviceId);
        },
        refreshPairing: async () => {
          try {
            await confirmPairing(pairing.deviceId);
            return true;
          } catch {
            return false;
          }
        },
      } : {}),
    };
  }
  if (deviceConfig) throw new Error('Nespárovaný Mac device potřebuje při prvním startu --lease');
  const config = readTradovateServerConfig();
  if (config.environment !== 'demo') {
    throw new Error('Pilot odmítá start: TRADOVATE_ENVIRONMENT musí být demo');
  }
  const db = createTradovateAdminClient(config);
  let query = db
    .from('tradovate_oauth_connections')
    .select('id,user_id,tradovate_email,environment,connection_status')
    .eq('environment', 'demo')
    .eq('connection_status', 'connected');
  const connectionId = options.connectionId ?? stringFlag('connection-id', false);
  if (connectionId) query = query.eq('id', connectionId);
  const { data, error } = await query.order('connected_at', { ascending: true });
  if (error) throw new Error(`OAuth connection lookup failed: ${error.message}`);
  const rows = (data ?? []) as ConnectionRow[];
  if (rows.length === 0) throw new Error('Nenalezeno aktivní Tradovate demo OAuth připojení');
  if (rows.length > 1 && !connectionId) {
    throw new Error('Je připojeno více OAuth účtů; použij --connection-id');
  }
  const connection = rows[0];
  const accountSpec = options.accountSpec
    ?? (stringFlag('account-spec', false) || connection.tradovate_email?.trim() || '');
  if (!accountSpec) throw new Error('Chybí Tradovate accountSpec; použij --account-spec');
  const getAccessToken = async () => (await getValidTradovateAccessToken({
    db,
    config,
    userId: connection.user_id,
    connectionId: connection.id,
  })).accessToken;
  return { environment: 'demo', connectionId: connection.id, accountSpec, expiresAt: null, renewable: true, getAccessToken };
}

function validatePair<T extends ExecutionAccount>(
  accounts: T[],
  leaderId: number,
  followerId: number,
): T[] {
  if (leaderId === followerId) throw new Error('Leader a follower musí být různé účty');
  const selected = [leaderId, followerId].map(id => {
    const account = accounts.find(item => item.id === id);
    if (!account) throw new Error(`Tradovate účet ${id} nebyl nalezen`);
    if (!account.active || !account.canTrade) throw new Error(`Účet ${account.name} není aktivní pro execution`);
    return account;
  });
  return selected;
}

/**
 * Parsování `--followers "id@multiplier[@maxContracts],..."` pro agent mode.
 *
 * Původní `--follower/--multiplier` dvojice zůstává platná (mac-install ji
 * generuje); tenhle flag ji rozšiřuje na víc účtů s vlastními parametry.
 * Příklad: `--followers "61887493@1,61887495@0.5@3"`.
 */
function parseFollowersFlag(
  raw: string,
  leaderId: number,
): CopyFollowerConfig[] {
  const followers = raw.split(',').map(part => part.trim()).filter(Boolean).map(part => {
    const [idPart, multiplierPart, maxPart, ...rest] = part.split('@');
    if (rest.length > 0) throw new Error(`--followers: nesrozumitelný zápis „${part}"`);
    const accountId = Number(idPart);
    if (!Number.isSafeInteger(accountId) || accountId <= 0) {
      throw new Error(`--followers: „${idPart}" není platné ID účtu`);
    }
    const multiplier = multiplierPart == null ? 1 : Number(multiplierPart);
    if (!Number.isFinite(multiplier) || multiplier <= 0 || multiplier > 100) {
      throw new Error(`--followers: multiplier účtu ${accountId} musí být větší než 0 a nejvýše 100`);
    }
    const maxContracts = maxPart == null ? undefined : Number(maxPart);
    if (maxContracts != null && (!Number.isSafeInteger(maxContracts) || maxContracts < 1)) {
      throw new Error(`--followers: maxContracts účtu ${accountId} musí být celé číslo alespoň 1`);
    }
    return {
      accountId,
      mode: 'on-submit' as const,
      multiplier,
      ...(maxContracts != null ? { maxContracts } : {}),
    };
  });
  if (followers.length === 0) throw new Error('--followers je prázdný');
  const seen = new Set<number>();
  for (const follower of followers) {
    if (follower.accountId === leaderId) throw new Error('Leader nemůže být zároveň follower');
    if (seen.has(follower.accountId)) throw new Error(`Follower ${follower.accountId} je uveden vícekrát`);
    seen.add(follower.accountId);
  }
  return followers;
}

async function runPreflight(
  context: PilotContext,
  accounts: TradovateAccountDataAccount[],
  accountSpecsByAccountId: Readonly<Record<number, string>>,
): Promise<void> {
  const accountIds = accounts.map(item => item.id);
  assertFlatAndNoWorking(accounts);
  const broker = createTradovateBroker({
    environment: 'demo',
    accountSpec: context.accountSpec,
    accountSpecsByAccountId,
    getAccessToken: context.getAccessToken,
  });
  let connected = false;
  let transportError: Error | null = null;
  const unsubscribe = broker.subscribe(event => {
    if (event.type === 'connection') connected = event.connected;
    if (event.type === 'error') transportError = event.error;
  });
  try {
    await waitUntil(() => connected || transportError != null, 15_000, 'WebSocket sync timeout');
    if (transportError) throw transportError;
    const capabilities = await broker.listAccountCapabilities(accountIds);
    const snapshots = await Promise.all(accountIds.map(async accountId => ({
      accountId,
      positions: await broker.listPositions(accountId),
      orders: await broker.listOrders(accountId),
    })));
    if (capabilities.length !== accountIds.length || capabilities.some(item => !item.active || !item.canTrade)) {
      throw new Error('OAuth/account execution preflight selhal');
    }
    for (const snapshot of snapshots) {
      if (snapshot.positions.some(item => item.netQuantity !== 0)) throw new Error(`Účet ${snapshot.accountId} není flat`);
      if (snapshot.orders.some(item => isOpenOrderStatus(item.status))) {
        throw new Error(`Účet ${snapshot.accountId} má aktivní working/pending order`);
      }
    }
    console.log('PASS preflight: demo, OAuth execution permission, WS sync, flat, no working orders.');
  } finally {
    unsubscribe();
  }
}

async function runDryRun(context: PilotContext, followerId: number): Promise<void> {
  const symbol = stringFlag('symbol');
  const side = stringFlag('side');
  const orderType = stringFlag('order-type');
  const quantity = integerFlag('quantity');
  const price = numberFlag('price', orderType === 'Market' ? false : true);
  if (side !== 'Buy' && side !== 'Sell') throw new Error('--side musí být Buy nebo Sell');
  if (!['Market', 'Limit', 'Stop', 'StopLimit'].includes(orderType)) {
    throw new Error('--order-type musí být Market, Limit, Stop nebo StopLimit');
  }
  if (quantity !== 1) throw new Error('Pilot dry-run dovoluje pouze quantity 1');
  const result = await dryRunTradovateOrder({
    environment: 'demo',
    accessToken: await context.getAccessToken(),
    order: {
      tag: `at-dry-${randomUUID().replaceAll('-', '').slice(0, 24)}`,
      accountId: followerId,
      symbol,
      side,
      quantity,
      orderType: orderType as 'Market' | 'Limit' | 'Stop' | 'StopLimit',
      ...(orderType === 'Limit' || orderType === 'StopLimit' ? { limitPrice: price } : {}),
      ...(orderType === 'Stop' || orderType === 'StopLimit' ? { stopPrice: price } : {}),
    },
  });
  if (!result.accepted) throw new Error(`Dry-run REJECTED: ${result.rejectReason}`);
  console.log('PASS dry-run: Tradovate validaci přijalo; žádná objednávka nebyla odeslána.');
}

async function runRuntime(
  mode: 'shadow' | 'live',
  context: PilotContext,
  leaderId: number,
  followerId: number,
  accountSpecsByAccountId: Readonly<Record<number, string>>,
): Promise<void> {
  if (mode === 'live') {
    const approval = stringFlag('approval');
    if (approval !== 'POTVRZUJI_1_MNQ_DEMO_WRITE') {
      throw new Error('Live pilot vyžaduje --approval POTVRZUJI_1_MNQ_DEMO_WRITE');
    }
  }
  const minutes = numberFlag('minutes', false) ?? (mode === 'shadow' ? 30 : 15);
  if (minutes <= 0 || minutes > 120) throw new Error('--minutes musí být v rozsahu 1 až 120');
  if (context.expiresAt && Date.parse(context.expiresAt) - Date.now() <= (minutes + 5) * 60_000) {
    throw new Error(`Pilot lease nevydrží celý ${minutes}min test a 5min rezervu; stáhni nový lease`);
  }
  const root = resolve('.copier-pilot');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const key = `${context.connectionId}-${leaderId}-${followerId}`;
  const releaseLock = await acquireProcessLock(resolve(root, `${key}.lock`));
  const auditPath = resolve(root, `${key}.audit.jsonl`);
  const metrics = createCopierMetrics();
  const broker = createTradovateBroker({
    environment: 'demo',
    accountSpec: context.accountSpec,
    accountSpecsByAccountId,
    getAccessToken: context.getAccessToken,
  });
  const group: CopyGroupConfig = {
    id: `pilot-${leaderId}-${followerId}`,
    name: 'Ranní pilot',
    enabled: true,
    leaderAccountId: leaderId,
    followers: [{ accountId: followerId, mode: 'on-submit', multiplier: 1 }],
    localOnly: true,
  };
  let controller: CopierRuntimeController | null = null;
  let stopping = false;
  let stopPromise: Promise<void> | null = null;
  let auditTail: Promise<void> = Promise.resolve();
  const writeAudit = async (entries: readonly CopierAuditEntry[]) => {
    if (entries.length === 0) return;
    await appendFile(auditPath, entries.map(entry => `${JSON.stringify(entry)}\n`).join(''), { mode: 0o600 });
    for (const entry of entries) {
      console.log(`${new Date(entry.at).toISOString()} ${entry.kind} account=${entry.accountId ?? '-'} reason=${entry.reason ?? '-'}`);
    }
  };
  const stop = (reason: string): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopping = true;
    stopPromise = (async () => {
      controller?.disarm();
      await controller?.waitForIdle();
      await auditTail;
      controller?.stop();
      const total = metrics.samples.map(item => item.totalMs);
      console.log(`STOP ${reason}; dispatched=${metrics.dispatched} unknown=${metrics.unknown} duplicates=${metrics.duplicatesFound} p95=${percentile(total, 95)}ms`);
      try {
        const final = await Promise.all([leaderId, followerId].map(async accountId => ({
          accountId,
          positions: await broker.listPositions(accountId),
          orders: await broker.listOrders(accountId),
        })));
        const unsafe = final.filter(item =>
          item.positions.some(position => position.netQuantity !== 0)
          || item.orders.some(order => isOpenOrderStatus(order.status)));
        if (unsafe.length > 0) {
          console.error(`MANUAL ACTION REQUIRED: po STOP nejsou flat/no-working účty ${unsafe.map(item => item.accountId).join(',')}`);
        } else {
          console.log('PASS final state: leader i follower jsou flat a bez working orders.');
        }
      } catch (error) {
        console.error(`MANUAL CHECK REQUIRED: finální broker stav nešel ověřit (${error instanceof Error ? error.message : String(error)})`);
      }
      await releaseLock();
    })();
    return stopPromise;
  };
  const onSignal = () => { void stop('operator-signal'); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    controller = await bootstrapCopierRuntime({
      broker,
      store: createFileCopierStore(resolve(root, `${key}.snapshot.json`)),
      group,
      metrics,
      maxConcurrentDispatches: 1,
      maxLeaderOrders: mode === 'live' ? 1 : undefined,
      allowSingleFlatExit: mode === 'live',
      onLeaderEvent: event => {
        if (mode !== 'shadow') return;
        console.log([
          'LEADER',
          `kind=${event.kind}`,
          `order=${event.orderId}`,
          `type=${event.orderType}`,
          `side=${event.side}`,
          `qty=${event.quantity}`,
          `limit=${event.limitPrice ?? '-'}`,
          `stop=${event.stopPrice ?? '-'}`,
          `parent=${event.parentOrderId ?? '-'}`,
          `oco=${event.ocoId ?? '-'}`,
          `linked=${event.linkedOrderId ?? '-'}`,
        ].join(' '));
      },
      onBracketPair: pair => {
        if (mode !== 'shadow') return;
        console.log([
          'BRACKET',
          `entry=${pair.entryOrderId}`,
          `stop=${pair.stopOrderId}@${pair.stopPrice}`,
          `target=${pair.targetOrderId}@${pair.targetPrice}`,
          `side=${pair.side}`,
          `qty=${pair.quantity}`,
          `via=${pair.correlation}`,
        ].join(' '));
      },
      onAudit: entries => {
        auditTail = auditTail.then(() => writeAudit(entries));
      },
      onError: error => console.error(`${new Date().toISOString()} FAIL-CLOSED ${error.message}`),
    });
    await waitUntil(() => controller?.status().connected === true, 15_000, 'WebSocket sync timeout');
    const reconciliation = await controller.reconcile();
    if (reconciliation.divergentAccounts.length || reconciliation.workingOrderAccounts.length) {
      throw new Error(`Reconciliation failed: divergence=${reconciliation.divergentAccounts.join(',')} working=${reconciliation.workingOrderAccounts.join(',')}`);
    }
    controller.arm({ shadowMode: mode === 'shadow' });
    console.log(`ARMED ${mode.toUpperCase()} leader=${leaderId} follower=${followerId} multiplier=1 max=${minutes}min`);
    if (mode === 'live') console.log('Pouze jeden ručně koordinovaný entry order; jeho potvrzený OCO SL/TP lifecycle se smí bezpečně dokončit.');
    const deadline = Date.now() + minutes * 60_000;
    while (!stopping && Date.now() < deadline) {
      await delay(1_000);
      const status = controller.status();
      if (status.lastError || status.killSwitch || status.stuckOutbox || !status.connected) {
        controller.disarm();
        throw new Error(`Runtime fail-closed: ${status.lastError ?? 'connection/outbox gate'}`);
      }
    }
    await stop('time-limit');
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    if (!stopping) await stop('startup-failure');
  }
}

async function acquireProcessLock(path: string): Promise<() => Promise<void>> {
  try {
    const handle = await open(path, 'wx', 0o600);
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    await handle.sync();
    await handle.close();
  } catch (error) {
    if (!isCode(error, 'EEXIST')) throw error;
    let pid = 0;
    try {
      const raw = JSON.parse(await readFile(path, 'utf8')) as { pid?: unknown };
      pid = Number(raw.pid);
    } catch {
      throw new Error(`Pilot lock existuje a nejde ověřit: ${path}`);
    }
    if (Number.isSafeInteger(pid) && pid > 0 && processExists(pid)) {
      throw new Error(`Jiný pilot runtime už běží (pid ${pid})`);
    }
    await unlink(path);
    return acquireProcessLock(path);
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await unlink(path).catch(error => { if (!isCode(error, 'ENOENT')) throw error; });
  };
}

function assertFlatAndNoWorking(accounts: TradovateAccountDataAccount[]): void {
  for (const account of accounts) {
    if (account.netPositionCount !== 0 || account.positions.some(item => item.netPosition !== 0)) {
      throw new Error(`Účet ${account.name} není flat`);
    }
    if (account.workingOrderCount !== 0) throw new Error(`Účet ${account.name} má working order`);
  }
}

function printAccounts(accounts: TradovateAccountDataAccount[]): void {
  console.table(accounts.map(account => ({
    id: account.id,
    account: account.name,
    active: account.active,
    canTrade: account.canTrade,
    positions: account.netPositionCount,
    working: account.workingOrderCount,
    balance: account.balance.totalCashValue,
  })));
}

async function generatePilotKeys(): Promise<void> {
  const root = resolve('.copier-pilot');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const publicPath = resolve(root, 'pilot-public.pem');
  const privatePath = resolve(root, 'pilot-private.pem');
  try {
    await readFile(privatePath, 'utf8');
    throw new Error(`Privátní klíč už existuje: ${privatePath}`);
  } catch (error) {
    if (!isCode(error, 'ENOENT')) throw error;
  }
  const pair = createTradovatePilotKeyPair();
  await writeFile(privatePath, pair.privateKey, { mode: 0o600, flag: 'wx' });
  await writeFile(publicPath, pair.publicKey, { mode: 0o600, flag: 'wx' });
  await chmod(root, 0o700);
  console.log(`Pilot public key: ${publicPath}`);
  console.log(`Pilot private key: ${privatePath} (nikam neposílat)`);
}

async function generateMacDevice(): Promise<void> {
  const configPath = resolve(stringFlag('device-config', false) || '.copier-pilot/mac-device.json');
  try {
    await access(configPath);
    throw new Error(`Mac device konfigurace už existuje: ${configPath}`);
  } catch (error) {
    if (!isCode(error, 'ENOENT')) throw error;
  }
  const connectionId = stringFlag('connection-id');
  const apiOrigin = stringFlag('api-origin', false) || 'https://alphatrade-mentor-15.vercel.app';
  const deviceName = stringFlag('device-name', false) || undefined;
  const config = await createMacCopierDevice({ configPath, connectionId, apiOrigin, deviceName });
  console.log(`Mac device: ${config.deviceName}`);
  console.log(`Konfigurace: ${configPath}`);
  console.log('Secret je uložen pouze v macOS Keychainu. První agent start ještě vyžaduje krátký pilot lease; potom se zařízení spáruje jedním kliknutím v LIVE UI.');
}

function parseFlags(args: string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!key?.startsWith('--')) throw new Error(`Neplatný argument: ${key}`);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Chybí hodnota pro ${key}`);
    parsed.set(key.slice(2), value);
    index += 1;
  }
  return parsed;
}

function stringFlag(name: string, required = true): string {
  const value = flags.get(name)?.trim() ?? '';
  if (required && !value) throw new Error(`Chybí --${name}`);
  return value;
}

function numberFlag(name: string, required = true): number | null {
  const raw = stringFlag(name, required);
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${name} musí být číslo`);
  return value;
}

function integerFlag(name: string): number {
  const value = numberFlag(name);
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`--${name} musí být kladné celé číslo`);
  return Number(value);
}

async function waitUntil(predicate: () => boolean, timeoutMs: number, message: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await delay(50);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isCode(error, 'ESRCH');
  }
}

function isCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
}

function usage(error?: string): void {
  if (error) console.error(error);
  console.log(`
Ranní Tradovate copier pilot (vždy DEMO)

  npm run copier:pilot -- keygen
  npm run copier:pilot -- mac-device-init --connection-id UUID [--api-origin https://alphatrade-mentor-15.vercel.app]
  npm run copier:pilot -- accounts
  npm run copier:pilot -- preflight --leader ID --follower ID
  npm run copier:pilot -- dry-run --leader ID --follower ID --symbol MNQU6 --side Buy --quantity 1 --order-type Limit --price PRICE
  npm run copier:pilot -- shadow --leader ID --follower ID --minutes 30
  npm run copier:pilot -- live --leader ID --follower ID --minutes 15 --approval POTVRZUJI_1_MNQ_DEMO_WRITE
  npm run copier:pilot -- agent --leader ID --follower ID --lease LEASE_JSON --device-config .copier-pilot/mac-device.json --minutes 480
  npm run copier:pilot -- agent --leader ID --follower ID --followers "ID@MULT,ID@MULT@MAXKONTRAKTU" ... (vice followeru; --followers ma prednost)
  npm run copier:pilot -- agent --connections-manifest /cesta/connections.json --leader ID --follower ID --followers "ID@MULT,..."

Volitelné: --connection-id UUID, --account-spec USERNAME
Lokální lease: --lease /cesta/k/pilot-lease.json [--private-key /cesta/pilot-private.pem]
Spárovaný Mac: --device-config /cesta/mac-device.json (další starty už --lease nepotřebují)
Více OAuth: manifest přiřadí každý accountId právě jednomu device-config; primární connection obsluhuje UI relay.
LaunchAgent: --service-lifetime persistent běží bez časového limitu jen tehdy, když jsou všechna zařízení spárovaná a obnovitelná.
Live příkaz se nesmí spustit bez bezprostředního potvrzení uživatele.
Agent vždy startuje DISARMED, poslouchá pouze na 127.0.0.1 a brokerové akce přijímá až z potvrzeného LIVE UI.
`);
}
