import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  copyGroupAccountIds,
  type LocalCopierAgentCommand,
  type LocalCopierAgentCommandResult,
  type LocalCopierAgentStatus,
} from '../lib/localCopierAgentProtocol';
import { msUntilTradovateSessionEnd } from '../services/copierArmSession';
import type { CopierRuntimeController } from '../services/copierRuntimeController';
import {
  normalizeMultiplier,
  type CopyGroupConfig,
  type LiveCopyTradingCommand,
  type LiveCopyTradingCommandResult,
} from '../services/liveCopyTrading';

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
  onDevicePaired?: (deviceId: string) => Promise<void>;
  /** Crash-safe persistence hook. A failed save rolls the runtime back DISARMED. */
  onGroupChanged?: (group: CopyGroupConfig) => Promise<void>;
}

export interface LocalCopierExecutionAgent {
  origin: string;
  status(): LocalCopierAgentStatus;
  execute(command: LocalCopierAgentCommand): Promise<LocalCopierAgentCommandResult>;
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

  const status = (): LocalCopierAgentStatus => ({
    version: 1,
    environment: 'demo',
    nonce,
    group: structuredClone(group),
    controller: options.controller.status(),
    startedAt,
    ...(devices[0] ? { device: structuredClone(devices[0]) } : {}),
    ...(devices.length > 0 ? { devices: structuredClone(devices) } : {}),
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
    let runtimeChanged = false;
    try {
      if (mode === 'activate') await options.controller.activateGroup(next);
      else if (leaderChanged) await options.controller.reconfigureGroup(next);
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
        else if (leaderChanged) await options.controller.reconfigureGroup(previous);
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
        if (command.group) {
          if (command.group.id !== group.id) {
            throw new Error('ARM míří na jinou skupinu. Nejdřív ji bezpečně aktivuj.');
          }
          await applyGroup(mappedGroup(group, command.group));
        }
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
        return options.controller.reconcile();
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
        await options.onDevicePaired?.(command.deviceId);
        devices[index] = {
          state: 'paired',
          deviceId: device.deviceId,
          connectionId: device.connectionId,
          deviceName: device.deviceName,
        };
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
    if (request.headers['x-alphatrade-agent-nonce'] !== nonce) {
      json(response, 401, { error: 'Neplatný session nonce lokálního execution agenta' });
      return;
    }
    tail = tail.then(async () => {
      try {
        const result = await execute(await body(request) as LocalCopierAgentCommand);
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
  return {
    origin: `http://${host}:${address.port}`,
    status,
    execute: async command => {
      let resolveResult!: (value: LocalCopierAgentCommandResult) => void;
      let rejectResult!: (reason: unknown) => void;
      const resultPromise = new Promise<LocalCopierAgentCommandResult>((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
      });
      tail = tail.then(async () => {
        try {
          const result = await execute(command);
          resolveResult({ ok: true, status: status(), ...(result == null ? {} : { result: result as LiveCopyTradingCommandResult }) });
        } catch (error) {
          rejectResult(error);
        }
      });
      return resultPromise;
    },
    async close() {
      await tail;
      await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
    },
  };
}
