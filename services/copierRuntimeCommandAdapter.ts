import type { CopierRuntimeController } from './copierRuntimeController';
import {
  normalizeMultiplier,
  type CopyGroupConfig,
  type LiveCopyTradingAdapter,
} from './liveCopyTrading';

export interface CopierRuntimeCommandAdapterOptions {
  controller: CopierRuntimeController;
  getGroup: () => CopyGroupConfig;
  setGroup: (group: CopyGroupConfig) => void;
}

/**
 * Překládá explicitní UI příkazy do jednoho běžícího lokálního runtime.
 * Samotná existence adaptéru nic nearmuje a nikdy nespouští Flatten bez
 * konkrétního uživatelského commandu s operationId.
 */
export function createCopierRuntimeCommandAdapter(
  options: CopierRuntimeCommandAdapterOptions,
): LiveCopyTradingAdapter {
  const update = (mutate: (group: CopyGroupConfig) => CopyGroupConfig) => {
    const next = mutate(options.getGroup());
    options.controller.updateGroup(next);
    options.setGroup(next);
  };

  return {
    async execute(command) {
      const current = options.getGroup();
      if ('groupId' in command && command.groupId !== current.id) {
        throw new Error('UI příkaz míří na jinou copy group než běžící runtime');
      }
      switch (command.type) {
        case 'update-group':
          options.controller.updateGroup(command.group);
          options.setGroup(command.group);
          return { type: 'configuration', group: command.group };
        case 'set-group-enabled':
          update(group => ({ ...group, enabled: command.enabled }));
          return { type: 'configuration', group: options.getGroup() };
        case 'set-replication':
          update(group => ({
            ...group,
            followers: group.followers.map(follower => follower.accountId === command.accountId
              ? { ...follower, mode: command.mode }
              : follower),
          }));
          return { type: 'configuration', group: options.getGroup() };
        case 'set-multiplier':
          update(group => ({
            ...group,
            followers: group.followers.map(follower => follower.accountId === command.accountId
              ? { ...follower, multiplier: normalizeMultiplier(command.multiplier) }
              : follower),
          }));
          return { type: 'configuration', group: options.getGroup() };
        case 'flatten-account':
          return { type: 'flatten', ...await options.controller.flattenAccount(command.accountId, command.operationId) };
        case 'flatten-group':
          return { type: 'flatten', ...await options.controller.flattenGroup(command.operationId) };
        case 'create-group':
        case 'delete-group':
          throw new Error('Běžící runtime podporuje právě jednu už vytvořenou skupinu');
        case 'cancel-order':
          throw new Error('Ruční cancel z UI zatím není napojen na durable runtime');
      }
    },
  };
}
