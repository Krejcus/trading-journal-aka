import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  canSafelyRestartLocalCopierAgent,
  copyGroupAccountIds,
  type LocalCopierAgentCommand,
  type LocalCopierAgentCommandResult,
  type LocalCopierAgentStatus,
} from '../lib/localCopierAgentProtocol.js';
import { msUntilTradovateSessionEnd } from '../services/copierArmSession.js';
import type { CopierControllerStatus, CopierRuntimeController } from '../services/copierRuntimeController.js';
import {
  normalizeMultiplier,
  type CopyGroupConfig,
  type LiveCopyTradingCommand,
  type LiveCopyTradingCommandResult,
} from '../services/liveCopyTrading.js';

const DEFAULT_ALLOWED_ORIGINS = new Set([
  'https://alphatrade-mentor-15.vercel.app',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3011',
]);

interface LocalCopierExecutionAgentOptions {
  controller: CopierRuntimeController;
  group: CopyGroupConfig;
  port?: number;
  host?: '127.0.0.1';
  allowedOrigins?: ReadonlySet<string>;
  startedAt?: string;
  device?: NonNullable<LocalCopierAgentStatus['device']>;
  devices?: NonNullable<LocalCopierAgentStatus['devices']>;
  snapshotHealth?: () => NonNullable<LocalCopierAgentStatus['snapshotHealth']>;
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
  prepareGroupAccounts?: (accountIds: readonly number[]) => Promise<void>;
}

export interface LocalCopierExecutionAgent {
  origin: string;
  status(): LocalCopierAgentStatus;
  execute(command: LocalCopierAgentCommand): Promise<LocalCopierAgentCommandResult>;
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
  };
};

const sameAccountTopology = (left: CopyGroupConfig, right: CopyGroupConfig): boolean => {
  const leftIds = [...copyGroupAccountIds(left)].sort((a, b) => a - b);
  const rightIds = [...copyGroupAccountIds(right)].sort((a, b) => a - b);
  return leftIds.length === rightIds.length && leftIds.every((value, index) => value === rightIds[index]);
};

const SNAPSHOT_TEST_REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const accountsRequiredForRoutingChange = (
  previous: CopyGroupConfig,
  next: CopyGroupConfig,
  status: CopierControllerStatus,
): number[] => {
  const leaderIds = new Set([previous.leaderAccountId, next.leaderAccountId]);
  const ineligible = new Set(
    (status.accountEligibility ?? [])
      .filter(entry => entry.state !== 'active')
      .map(entry => entry.accountId),
  );
  return [...new Set([...copyGroupAccountIds(previous), ...copyGroupAccountIds(next)])]
    // Vyřazený follower může po BREACH/DLL zmizet z OAuth adresáře. Takový
    // účet už není routovatelný a nesmí navždy zablokovat jeho odebrání.
    // Leader zůstává vždy povinný a aktivní follower se dál ověřuje přísně.
    .filter(accountId => leaderIds.has(accountId) || !ineligible.has(accountId));
};

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
  const nonce = randomUUID();
  const startedAt = options.startedAt ?? new Date().toISOString();
  let group = structuredClone(options.group);
  const devices = (options.devices ?? (options.device ? [options.device] : [])).map(item => structuredClone(item));
  if (new Set(devices.map(item => item.deviceId)).size !== devices.length) {
    throw new Error('Lokální execution agent dostal duplicitní deviceId');
  }
  if (new Set(devices.map(item => item.connectionId)).size !== devices.length) {
    throw new Error('Lokální execution agent dostal více zařízení pro stejné OAuth připojení');
  }
  let tail = Promise.resolve();
  let shuttingDown = false;
  let serverClosePromise: Promise<void> | null = null;
  const shutdownError = () => new Error('Lokální execution agent se právě bezpečně ukončuje');

  const status = (): LocalCopierAgentStatus => ({
    version: 1,
    environment: 'demo',
    nonce,
    group: structuredClone(group),
    controller: options.controller.status(),
    startedAt,
    ...(devices[0] ? { device: structuredClone(devices[0]) } : {}),
    ...(devices.length > 0 ? { devices: structuredClone(devices) } : {}),
    ...(options.snapshotHealth ? { snapshotHealth: structuredClone(options.snapshotHealth()) } : {}),
  });

  const configurationResult = (): LiveCopyTradingCommandResult => ({
    type: 'configuration',
    group: structuredClone(group),
  });

  const applyGroup = async (
    next: CopyGroupConfig,
    mode: 'update' | 'activate' = 'update',
  ): Promise<LiveCopyTradingCommandResult> => {
    const previous = group;
    const leaderChanged = previous.leaderAccountId !== next.leaderAccountId;
    const topologyChanged = !sameAccountTopology(previous, next);
    let runtimeChanged = false;
    try {
      if (mode === 'activate' || topologyChanged) {
        // Routing se nikdy nemění za běžícího ARM. Nejdřív odzbrojit, potom
        // read-only discovery; teprve controller provede flat/no-working
        // preflight nad sjednocením staré a nové topologie.
        options.controller.disarm();
        await options.prepareGroupAccounts?.(
          accountsRequiredForRoutingChange(previous, next, options.controller.status()),
        );
      }
      if (mode === 'activate') await options.controller.activateGroup(next);
      else if (leaderChanged || topologyChanged) await options.controller.reconfigureGroup(next);
      else options.controller.updateGroup(next);
      runtimeChanged = true;
      await options.onGroupChanged?.(structuredClone(next));
      group = next;
    } catch (error) {
      // Po úspěšném runtime přepnutí, ale neúspěšném durable zápisu, vrať
      // původní epochu stejnou bezpečnou cestou. Když selhal už preflight,
      // controller původní skupinu vůbec nezměnil.
      if (runtimeChanged) {
        if (mode === 'activate') await options.controller.activateGroup(previous);
        else if (leaderChanged || topologyChanged) await options.controller.reconfigureGroup(previous);
        else options.controller.updateGroup(previous);
      }
      throw error;
    }
    return configurationResult();
  };

  const executeCopyCommand = async (command: LiveCopyTradingCommand): Promise<LiveCopyTradingCommandResult> => {
    switch (command.type) {
      case 'update-group': {
        const next = mappedGroup(group, command.group);
        return applyGroup(next);
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
      case 'set-multiplier': {
        assertMember(group, command.accountId);
        if (!group.followers.some(follower => follower.accountId === command.accountId)) {
          throw new Error('Násobek lze změnit pouze follower účtu');
        }
        return applyGroup({
          ...group,
          followers: group.followers.map(follower => follower.accountId === command.accountId
            ? { ...follower, multiplier: normalizeMultiplier(command.multiplier) }
            : follower),
        });
      }
      case 'flatten-account':
        // Autoritativní cíl: groupId z příkazu musí sedět na runtime skupinu.
        // Web adapter to kontroluje taky, ale frontend není bezpečnostní
        // hranice — přes relay smí Flatten dorazit odkudkoliv.
        assertGroupTarget(group, command.groupId);
        assertMember(group, command.accountId);
        return { type: 'flatten', ...await options.controller.flattenAccount(command.accountId, command.operationId) };
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

  const execute = async (command: LocalCopierAgentCommand): Promise<unknown> => {
    switch (command.type) {
      case 'copy-command':
        return executeCopyCommand(command.command);
      case 'activate-group': {
        const next: CopyGroupConfig = {
          ...structuredClone(command.group),
          enabled: true,
          localOnly: true,
        };
        await applyGroup(next, 'activate');
        return;
      }
      case 'arm-live': {
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
            routingPrepared = true;
          } else {
            const next = mappedGroup(group, command.group);
            routingPrepared = !sameAccountTopology(group, next);
            await applyGroup(next);
          }
        }
        options.controller.disarm();
        await options.controller.applyAccountEligibilityExclusions(
          validatedAccountEligibilityExclusions(command.accountEligibilityExclusions),
        );
        if (!routingPrepared) await options.prepareGroupAccounts?.(copyGroupAccountIds(group));
        const reconciliation = await options.controller.reconcile();
        if (reconciliation.divergentAccounts.length > 0 || reconciliation.workingOrderAccounts.length > 0) {
          throw new Error('ARM odmítnut: účty nejsou flat/synchronní nebo mají pracovní příkazy');
        }
        // Ostrý ARM končí nejpozději s broker session (17:00 CT). Zapomenutý
        // ARM tak nepřežije do dalšího dne; otevřené kopie expirace
        // risk-redukčně zavře podle `safety.armExpiryFlatten`.
        options.controller.arm({ shadowMode: false, ttlMs: msUntilTradovateSessionEnd(Date.now()) });
        return;
      }
      case 'shadow': {
        options.controller.disarm();
        await options.controller.applyAccountEligibilityExclusions(
          validatedAccountEligibilityExclusions(command.accountEligibilityExclusions),
        );
        await options.prepareGroupAccounts?.(copyGroupAccountIds(group));
        const reconciliation = await options.controller.reconcile();
        if (reconciliation.divergentAccounts.length > 0 || reconciliation.workingOrderAccounts.length > 0) {
          throw new Error('SHADOW odmítnut: účty nejsou flat/synchronní nebo mají pracovní příkazy');
        }
        options.controller.arm({ shadowMode: true });
        return;
      }
      case 'disarm':
        options.controller.disarm();
        return;
      case 'kill-switch':
        options.controller.engageKillSwitch('Kill switch z AlphaTrade LIVE UI');
        return;
      case 'reconcile':
        // Samostatná read-only kontrola musí obnovit stejné multi-OAuth
        // routování jako ARM/SHADOW. Jinak účet z druhého připojení zůstane
        // po nové session navždy `unverifiable`, i když je u brokera zdravý.
        await options.prepareGroupAccounts?.(copyGroupAccountIds(group));
        return options.controller.reconcile();
      case 'verify-account-eligibility':
        // Cílené ověření nesmí kvůli účtu z jiné uložené skupiny měnit
        // execution skupinu. Připraví jen jeho OAuth route a provede read-only
        // capability + positions + orders kontrolu.
        await options.prepareGroupAccounts?.([command.accountId]);
        return options.controller.verifyAccountEligibility(command.accountId);
      case 'snapshot-test':
        if (!command.requestId || !SNAPSHOT_TEST_REQUEST_ID.test(command.requestId)) {
          throw new Error('snapshot-test-invalid-request');
        }
        if (!options.onSnapshotTest) throw new Error('snapshot-test-unavailable');
        if (command.repairCamera && !canSafelyRestartLocalCopierAgent(options.controller.status())) {
          throw new Error('TradingView lze obnovit pouze při připojeném, reconciled, DISARMED a flat workeru bez pracovních příkazů.');
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
        await options.controller.lockUntil(
          Date.now() + msUntilTradovateSessionEnd(Date.now()),
          command.reason,
        );
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

  const server: Server = createServer((request, response) => {
    const origin = request.headers.origin ?? '';
    if (!allowedOrigins.has(origin)) {
      json(response, 403, { error: 'Origin nemá přístup k lokálnímu execution agentovi' });
      return;
    }
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
    response.setHeader('Access-Control-Allow-Private-Network', 'true');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-AlphaTrade-Agent-Nonce');
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
    tail = tail.then(async () => {
      try {
        if (shuttingDown) throw shutdownError();
        const command = await body(request) as LocalCopierAgentCommand;
        if (shuttingDown) throw shutdownError();
        const result = await execute(command);
        const payload: LocalCopierAgentCommandResult = {
          ok: true,
          status: status(),
          ...(result == null ? {} : { result: result as LiveCopyTradingCommandResult }),
        };
        json(response, 200, payload);
      } catch (reason) {
        json(response, 409, { error: reason instanceof Error ? reason.message : String(reason), status: status() });
      }
    });
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
    execute: async command => {
      if (shuttingDown) throw shutdownError();
      let resolveResult!: (value: LocalCopierAgentCommandResult) => void;
      let rejectResult!: (reason: unknown) => void;
      const resultPromise = new Promise<LocalCopierAgentCommandResult>((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
      });
      tail = tail.then(async () => {
        try {
          if (shuttingDown) throw shutdownError();
          const result = await execute(command);
          resolveResult({ ok: true, status: status(), ...(result == null ? {} : { result: result as LiveCopyTradingCommandResult }) });
        } catch (error) {
          rejectResult(error);
        }
      });
      return resultPromise;
    },
    beginShutdown,
    async close() {
      beginShutdown();
      await tail;
      await serverClosePromise;
    },
  };
}
