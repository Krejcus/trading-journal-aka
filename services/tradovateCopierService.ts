import type { SupabaseClient } from '@supabase/supabase-js';
import type { BrokerEnvironment } from './brokerPort';
import {
  bootstrapCopierRuntime,
  type BootstrapCopierOptions,
  type CopierRuntimeController,
} from './copierRuntimeController';
import { createSupabaseCopierStore } from './supabaseCopierStore';
import { createTradovateBroker, type TradovateBrokerConfig } from './tradovateBroker';
import type { CopyGroupConfig } from './liveCopyTrading';
import { createBrokerRouter } from './brokerRouter';

export interface StartTradovateCopierOptions {
  supabase: SupabaseClient;
  runtimeId: string;
  /** Aktuální fencing token drženého worker lease; bez něj se nesmí zapisovat. */
  fence: () => number;
  environment: BrokerEnvironment;
  accountSpec: string;
  group: CopyGroupConfig;
  /**
   * Token se získává těsně před každým requestem/WS autorizací. Tato vrstva
   * ho neukládá do localStorage, Supabase snapshotu ani konfigurace skupiny.
   */
  getAccessToken: () => Promise<string>;
  transport?: Omit<TradovateBrokerConfig,
    'environment' | 'accountSpec' | 'accessToken' | 'getAccessToken'>;
  runtime?: Omit<BootstrapCopierOptions, 'broker' | 'store' | 'group'>;
}

export interface TradovateCopierConnection {
  id: string;
  accountIds: readonly number[];
  accountSpec?: string;
  accountSpecsByAccountId?: Readonly<Record<number, string>>;
  getAccessToken: () => Promise<string>;
  transport?: Omit<TradovateBrokerConfig,
    'environment' | 'accountSpec' | 'accountSpecsByAccountId' | 'accessToken' | 'getAccessToken'>;
}

export interface StartMultiTradovateCopierOptions {
  supabase: SupabaseClient;
  runtimeId: string;
  fence: () => number;
  environment: BrokerEnvironment;
  group: CopyGroupConfig;
  connections: readonly TradovateCopierConnection[];
  runtime?: Omit<BootstrapCopierOptions, 'broker' | 'store' | 'group'>;
}

/** Jediný composition root, který se po OAuth napojí na aplikační session. */
export async function startTradovateCopier(
  options: StartTradovateCopierOptions,
): Promise<CopierRuntimeController> {
  const accountSpec = options.accountSpec.trim();
  if (!accountSpec) throw new Error('Tradovate accountSpec is required');
  return startMultiTradovateCopier({
    supabase: options.supabase,
    runtimeId: options.runtimeId,
    fence: options.fence,
    environment: options.environment,
    group: options.group,
    connections: [{
      id: 'single-oauth-connection',
      accountIds: groupAccountIds(options.group),
      accountSpec,
      getAccessToken: options.getAccessToken,
      transport: options.transport,
    }],
    runtime: options.runtime,
  });
}

/** Composition root for one copy group spanning several OAuth logins. */
export async function startMultiTradovateCopier(
  options: StartMultiTradovateCopierOptions,
): Promise<CopierRuntimeController> {
  if (!options.runtimeId) throw new Error('Copier runtimeId is required');
  if (options.connections.length === 0) throw new Error('Copier needs at least one OAuth connection');
  const required = new Set(groupAccountIds(options.group));
  const seen = new Set<number>();
  const routes = options.connections.map(connection => {
    if (!connection.id.trim()) throw new Error('OAuth connection id is required');
    if (connection.accountIds.length === 0) throw new Error(`OAuth connection ${connection.id} has no accounts`);
    for (const accountId of connection.accountIds) {
      if (seen.has(accountId)) throw new Error(`Account ${accountId} belongs to multiple OAuth connections`);
      seen.add(accountId);
    }
    return {
      accountIds: connection.accountIds,
      broker: createTradovateBroker({
        environment: options.environment,
        accountSpec: connection.accountSpec,
        accountSpecsByAccountId: connection.accountSpecsByAccountId,
        getAccessToken: connection.getAccessToken,
        ...connection.transport,
      }),
    };
  });
  for (const accountId of required) {
    if (!seen.has(accountId)) throw new Error(`Group account ${accountId} has no OAuth connection`);
  }
  const store = createSupabaseCopierStore(options.supabase, options.runtimeId, options.fence);
  return bootstrapCopierRuntime({
    broker: createBrokerRouter(routes),
    store,
    group: options.group,
    ...options.runtime,
  });
}

function groupAccountIds(group: CopyGroupConfig): number[] {
  if (group.leaderAccountId == null) throw new Error('Copy group leader is required');
  return [group.leaderAccountId, ...group.followers.map(follower => follower.accountId)];
}
