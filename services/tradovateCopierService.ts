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

export interface StartTradovateCopierOptions {
  supabase: SupabaseClient;
  runtimeId: string;
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

/** Jediný composition root, který se po OAuth napojí na aplikační session. */
export async function startTradovateCopier(
  options: StartTradovateCopierOptions,
): Promise<CopierRuntimeController> {
  if (!options.runtimeId) throw new Error('Copier runtimeId is required');
  const accountSpec = options.accountSpec.trim();
  if (!accountSpec) throw new Error('Tradovate accountSpec is required');
  const store = createSupabaseCopierStore(options.supabase, options.runtimeId);
  const broker = createTradovateBroker({
    environment: options.environment,
    accountSpec,
    getAccessToken: options.getAccessToken,
    ...options.transport,
  });
  return bootstrapCopierRuntime({
    broker,
    store,
    group: options.group,
    ...options.runtime,
  });
}
