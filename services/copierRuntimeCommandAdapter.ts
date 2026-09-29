import type { CopierRuntimeController } from './copierRuntimeController';
import {
  normalizeMultiplier,
  type CopyGroupConfig,
  type LiveCopyTradingAdapter,
} from './liveCopyTrading';
import {
  isInPlaceCutTightening,
  isMetadataOnlyGroupChange,
  isWeakerRiskConfig,
} from '../lib/copierRiskConfig';

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
  const applyGroup = async (
    next: CopyGroupConfig,
    request: { waiveUnverifiableFollowerOwnership?: true } = {},
  ) => {
    const current = options.getGroup();
    options.controller.preflightGroupChange(next);
    const weaker = isWeakerRiskConfig(current, next);
    if (weaker.length === 0 && isMetadataOnlyGroupChange(current, next)) {
      options.controller.updateGroupMetadata(next);
    } else if (weaker.length === 0 && isInPlaceCutTightening(current, next)) {
      await options.controller.updateGroupRiskInPlace(next);
    } else {
      await options.controller.reconfigureGroup(next, {
        ...(request.waiveUnverifiableFollowerOwnership === true
          ? { waiveUnverifiableFollowerOwnership: true }
          : {}),
      });
    }
    options.setGroup(next);
  };

  const update = async (mutate: (group: CopyGroupConfig) => CopyGroupConfig) => {
    const next = mutate(options.getGroup());
    await applyGroup(next);
  };

  return {
    async execute(command) {
      const current = options.getGroup();
      if ('groupId' in command && command.groupId !== current.id) {
        throw new Error('UI příkaz míří na jinou copy group než běžící runtime');
      }
      switch (command.type) {
        case 'update-group':
          await applyGroup({
            ...command.group,
            followers: command.group.followers.map(follower => ({
              ...follower,
              ...(current.followers.find(item => item.accountId === follower.accountId)?.enabled === false
                ? { enabled: false }
                : { enabled: true }),
            })),
          }, {
            ...(command.waiveUnverifiableFollowerOwnership === true
              ? { waiveUnverifiableFollowerOwnership: true }
              : {}),
          });
          return { type: 'configuration', group: command.group };
        case 'set-group-enabled':
          await update(group => ({ ...group, enabled: command.enabled }));
          return { type: 'configuration', group: options.getGroup() };
        case 'set-replication':
          await update(group => ({
            ...group,
            followers: group.followers.map(follower => follower.accountId === command.accountId
              ? { ...follower, mode: command.mode }
              : follower),
          }));
          return { type: 'configuration', group: options.getGroup() };
        case 'set-follower-enabled': {
          const next = await options.controller.setFollowerEnabled(
            command.accountId,
            command.enabled,
            async updated => { options.setGroup(updated); },
          );
          return { type: 'configuration', group: next };
        }
        case 'set-multiplier':
          await update(group => ({
            ...group,
            followers: group.followers.map(follower => follower.accountId === command.accountId
              ? { ...follower, multiplier: normalizeMultiplier(command.multiplier) }
              : follower),
          }));
          return { type: 'configuration', group: options.getGroup() };
        case 'flatten-account':
          return { type: 'flatten', ...await options.controller.flattenAccount(command.accountId, command.operationId) };
        case 'flatten-follower-trade':
          return { type: 'flatten', ...await options.controller.flattenFollowerTrade(command.accountId, command.operationId) };
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
