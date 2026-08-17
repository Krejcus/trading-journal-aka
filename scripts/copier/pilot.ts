import { access, appendFile, chmod, mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { tradovateApiBaseUrl } from '../../server/tradovateOAuth';
import { loadTradovateAccountData } from '../../server/tradovateAccountData';
import {
  createTradovateAdminClient,
  getValidTradovateAccessToken,
  readTradovateServerConfig,
} from '../../server/tradovateOAuthStore';
import { createFileCopierStore } from '../../services/fileCopierStore';
import { createTradovateBroker } from '../../services/tradovateBroker';
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
import type { CopyGroupConfig } from '../../services/liveCopyTrading';
import type { TradovateAccountDataAccount } from '../../lib/tradovateAccountDataTypes';
import {
  createTradovatePilotKeyPair,
  openTradovatePilotLease,
  type TradovatePilotLeaseEnvelope,
} from '../../server/tradovatePilotLease';
import { startLocalCopierExecutionAgent } from '../../server/localCopierExecutionAgent';
import { LOCAL_COPIER_AGENT_PORT } from '../../lib/localCopierAgentProtocol';
import {
  createMacCopierDevice,
  createMacCopierDeviceTokenProvider,
  loadMacCopierDevice,
  macCopierDevicePairing,
  markMacCopierDevicePaired,
} from '../../server/macCopierDevice';

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
}

const flags = parseFlags(process.argv.slice(3));
const command = process.argv[2] as Command | undefined;

if (!command || !['keygen', 'mac-device-init', 'accounts', 'preflight', 'dry-run', 'shadow', 'live', 'agent'].includes(command)) {
  usage(command ? `Neznámý příkaz: ${command}` : undefined);
  process.exitCode = command ? 1 : 0;
} else {
  if (command === 'keygen') await generatePilotKeys();
  else if (command === 'mac-device-init') await generateMacDevice();
  else await main(command);
}

async function main(selected: Exclude<Command, 'keygen'>): Promise<void> {
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
    await runLocalAgent(context, leaderId, followerId, accountSpecsByAccountId);
    return;
  }

  assertFlatAndNoWorking(selectedAccounts);
  await runRuntime(selected, context, leaderId, followerId, accountSpecsByAccountId);
}

async function runLocalAgent(
  context: PilotContext,
  leaderId: number,
  followerId: number,
  accountSpecsByAccountId: Readonly<Record<number, string>>,
): Promise<void> {
  const portValue = numberFlag('port', false) ?? LOCAL_COPIER_AGENT_PORT;
  const minutesValue = numberFlag('minutes', false) ?? 480;
  const multiplierValue = numberFlag('multiplier', false) ?? 1;
  if (!Number.isSafeInteger(portValue) || Number(portValue) < 1024 || Number(portValue) > 65_535) {
    throw new Error('--port musí být celé číslo v rozsahu 1024–65535');
  }
  if (!Number.isFinite(minutesValue) || Number(minutesValue) < 1 || Number(minutesValue) > 720) {
    throw new Error('--minutes musí být v rozsahu 1–720');
  }
  if (!Number.isFinite(multiplierValue) || Number(multiplierValue) <= 0 || Number(multiplierValue) > 100) {
    throw new Error('--multiplier musí být větší než 0 a nejvýše 100');
  }
  if (!context.renewable && context.expiresAt && Date.parse(context.expiresAt) - Date.now() <= (Number(minutesValue) + 5) * 60_000) {
    throw new Error(`Pilot lease nevydrží celý ${minutesValue}min běh a 5min rezervu; stáhni nový lease`);
  }

  const root = resolve('.copier-pilot');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const key = `${context.connectionId}-${leaderId}-${followerId}`;
  const releaseLock = await acquireProcessLock(resolve(root, `${key}.lock`));
  const auditPath = resolve(root, `${key}.audit.jsonl`);
  const broker = createTradovateBroker({
    environment: 'demo',
    accountSpec: context.accountSpec,
    accountSpecsByAccountId,
    getAccessToken: context.getAccessToken,
  });
  const group: CopyGroupConfig = {
    id: `agent-${leaderId}-${followerId}`,
    name: 'Lokální DEMO agent',
    enabled: true,
    leaderAccountId: leaderId,
    followers: [{ accountId: followerId, mode: 'on-submit', multiplier: Number(multiplierValue) }],
    localOnly: true,
  };
  let auditTail = Promise.resolve();
  let controller: CopierRuntimeController | null = null;
  let agent: Awaited<ReturnType<typeof startLocalCopierExecutionAgent>> | null = null;
  let stopPromise: Promise<void> | null = null;
  const writeAudit = async (entries: readonly CopierAuditEntry[]) => {
    if (entries.length === 0) return;
    await appendFile(auditPath, entries.map(entry => `${JSON.stringify(entry)}\n`).join(''), { mode: 0o600 });
    for (const entry of entries) {
      console.log(`${new Date(entry.at).toISOString()} ${entry.kind} account=${entry.accountId ?? '-'} reason=${entry.reason ?? '-'}`);
    }
  };
  const stop = (reason: string): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      controller?.disarm();
      await controller?.waitForIdle();
      await auditTail;
      await agent?.close();
      controller?.stop();
      await releaseLock();
      console.log(`STOP ${reason}; lokální execution agent je DISARMED a ukončen.`);
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
      metrics: createCopierMetrics(),
      maxConcurrentDispatches: 1,
      onAudit: entries => {
        auditTail = auditTail.then(() => writeAudit(entries));
      },
      onError: error => console.error(`FAIL-CLOSED ${error.message}`),
    });
    await waitUntil(() => controller?.status().connected === true, 15_000, 'WebSocket sync timeout');
    agent = await startLocalCopierExecutionAgent({
      controller,
      group,
      port: Number(portValue),
      device: context.device,
      onDevicePaired: context.onDevicePaired,
    });
    console.log(`LOCAL AGENT ${agent.origin} leader=${leaderId} follower=${followerId} multiplier=${multiplierValue}`);
    console.log('Stav je DISARMED. ARM, Flatten, Flatten All a násobek vyžadují explicitní akci v AlphaTrade LIVE UI.');
    const deadline = Date.now() + Number(minutesValue) * 60_000;
    while (Date.now() < deadline && !stopPromise) await delay(1_000);
    await stop('time-limit');
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    if (!stopPromise) await stop('startup-failure');
  }
}

async function pilotContext(): Promise<PilotContext> {
  const deviceConfigPath = stringFlag('device-config', false);
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
      device: {
        state: 'paired',
        deviceId: deviceConfig.deviceId,
        connectionId: deviceConfig.connectionId,
        deviceName: deviceConfig.deviceName,
      },
    };
  }
  const leasePath = stringFlag('lease', false);
  if (leasePath) {
    const privateKeyPath = stringFlag('private-key', false) || resolve('.copier-pilot/pilot-private.pem');
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
    return {
      environment: 'demo',
      connectionId: payload.connectionId,
      accountSpec: payload.accountSpec,
      expiresAt: payload.expiresAt,
      renewable: Boolean(deviceConfig),
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
          if (deviceId !== pairing.deviceId || !deviceConfigPath || !provider) {
            throw new Error('Neplatné potvrzení Mac device párování');
          }
          await provider.refresh();
          await markMacCopierDevicePaired(deviceConfigPath);
          paired = true;
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
  const connectionId = stringFlag('connection-id', false);
  if (connectionId) query = query.eq('id', connectionId);
  const { data, error } = await query.order('connected_at', { ascending: true });
  if (error) throw new Error(`OAuth connection lookup failed: ${error.message}`);
  const rows = (data ?? []) as ConnectionRow[];
  if (rows.length === 0) throw new Error('Nenalezeno aktivní Tradovate demo OAuth připojení');
  if (rows.length > 1 && !connectionId) {
    throw new Error('Je připojeno více OAuth účtů; použij --connection-id');
  }
  const connection = rows[0];
  const accountSpec = stringFlag('account-spec', false) || connection.tradovate_email?.trim() || '';
  if (!accountSpec) throw new Error('Chybí Tradovate accountSpec; použij --account-spec');
  const getAccessToken = async () => (await getValidTradovateAccessToken({
    db,
    config,
    userId: connection.user_id,
    connectionId: connection.id,
  })).accessToken;
  return { environment: 'demo', connectionId: connection.id, accountSpec, expiresAt: null, renewable: true, getAccessToken };
}

function validatePair(
  accounts: TradovateAccountDataAccount[],
  leaderId: number,
  followerId: number,
): TradovateAccountDataAccount[] {
  if (leaderId === followerId) throw new Error('Leader a follower musí být různé účty');
  const selected = [leaderId, followerId].map(id => {
    const account = accounts.find(item => item.id === id);
    if (!account) throw new Error(`Tradovate účet ${id} nebyl nalezen`);
    if (!account.active || !account.canTrade) throw new Error(`Účet ${account.name} není aktivní pro execution`);
    return account;
  });
  return selected;
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
      if (snapshot.orders.some(item => item.status === 'working')) throw new Error(`Účet ${snapshot.accountId} má working order`);
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
          || item.orders.some(order => order.status === 'working'));
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
      onError: error => console.error(`FAIL-CLOSED ${error.message}`),
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

Volitelné: --connection-id UUID, --account-spec USERNAME
Lokální lease: --lease /cesta/k/pilot-lease.json [--private-key /cesta/pilot-private.pem]
Spárovaný Mac: --device-config /cesta/mac-device.json (další starty už --lease nepotřebují)
Live příkaz se nesmí spustit bez bezprostředního potvrzení uživatele.
Agent vždy startuje DISARMED, poslouchá pouze na 127.0.0.1 a brokerové akce přijímá až z potvrzeného LIVE UI.
`);
}
