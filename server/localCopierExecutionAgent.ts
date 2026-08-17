import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  copyGroupAccountIds,
  sameCopyGroupAccounts,
  type LocalCopierAgentCommand,
  type LocalCopierAgentCommandResult,
  type LocalCopierAgentStatus,
} from '../lib/localCopierAgentProtocol';
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
  onDevicePaired?: (deviceId: string) => Promise<void>;
}

export interface LocalCopierExecutionAgent {
  origin: string;
  status(): LocalCopierAgentStatus;
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

const mappedGroup = (runtimeGroup: CopyGroupConfig, incoming: CopyGroupConfig): CopyGroupConfig => {
  if (!sameCopyGroupAccounts(runtimeGroup, incoming)) {
    throw new Error('UI skupina neodpovídá leader/follower topologii lokálního execution agenta');
  }
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
  let device = options.device ? structuredClone(options.device) : undefined;
  let tail = Promise.resolve();

  const status = (): LocalCopierAgentStatus => ({
    version: 1,
    environment: 'demo',
    nonce,
    group: structuredClone(group),
    controller: options.controller.status(),
    startedAt,
    ...(device ? { device: structuredClone(device) } : {}),
  });

  const configurationResult = (): LiveCopyTradingCommandResult => ({
    type: 'configuration',
    group: structuredClone(group),
  });

  const executeCopyCommand = async (command: LiveCopyTradingCommand): Promise<LiveCopyTradingCommandResult> => {
    switch (command.type) {
      case 'update-group': {
        const next = mappedGroup(group, command.group);
        options.controller.updateGroup(next);
        group = next;
        return configurationResult();
      }
      case 'set-group-enabled': {
        group = { ...group, enabled: command.enabled };
        options.controller.updateGroup(group);
        return configurationResult();
      }
      case 'set-replication': {
        assertMember(group, command.accountId);
        group = {
          ...group,
          followers: group.followers.map(follower => follower.accountId === command.accountId
            ? { ...follower, mode: command.mode }
            : follower),
        };
        options.controller.updateGroup(group);
        return configurationResult();
      }
      case 'set-multiplier': {
        assertMember(group, command.accountId);
        if (!group.followers.some(follower => follower.accountId === command.accountId)) {
          throw new Error('Násobek lze změnit pouze follower účtu');
        }
        group = {
          ...group,
          followers: group.followers.map(follower => follower.accountId === command.accountId
            ? { ...follower, multiplier: normalizeMultiplier(command.multiplier) }
            : follower),
        };
        options.controller.updateGroup(group);
        return configurationResult();
      }
      case 'flatten-account':
        assertMember(group, command.accountId);
        return { type: 'flatten', ...await options.controller.flattenAccount(command.accountId, command.operationId) };
      case 'flatten-group':
        return { type: 'flatten', ...await options.controller.flattenGroup(command.operationId) };
      case 'create-group':
        throw new Error('Lokální agent už má jednu aktivní skupinu');
      case 'delete-group':
        throw new Error('Skupinu nejdřív DISARM a ukonči lokální agent');
      case 'cancel-order':
        throw new Error('Ruční cancel z UI zatím není napojen na durable runtime');
    }
  };

  const execute = async (command: LocalCopierAgentCommand): Promise<unknown> => {
    switch (command.type) {
      case 'copy-command':
        return executeCopyCommand(command.command);
      case 'arm-live': {
        const reconciliation = await options.controller.reconcile();
        if (reconciliation.divergentAccounts.length > 0 || reconciliation.workingOrderAccounts.length > 0) {
          throw new Error('ARM odmítnut: účty nejsou flat/synchronní nebo mají pracovní příkazy');
        }
        options.controller.arm({ shadowMode: false });
        return;
      }
      case 'shadow':
        options.controller.arm({ shadowMode: true });
        return;
      case 'disarm':
        options.controller.disarm();
        return;
      case 'kill-switch':
        options.controller.engageKillSwitch('Kill switch z AlphaTrade LIVE UI');
        return;
      case 'device-paired': {
        if (!device || device.state !== 'pairing-required' || command.deviceId !== device.deviceId) {
          throw new Error('Lokální Mac zařízení nečeká na toto párování');
        }
        await options.onDevicePaired?.(command.deviceId);
        device = {
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
    async close() {
      await tail;
      await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
    },
  };
}
