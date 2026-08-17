import type {
  CopyGroupConfig,
  LiveCopyTradingCommand,
  LiveCopyTradingCommandResult,
} from '../services/liveCopyTrading';
import type { CopierControllerStatus } from '../services/copierRuntimeController';

export const LOCAL_COPIER_AGENT_PORT = 3211;
export const LOCAL_COPIER_AGENT_BASE_URL = `http://127.0.0.1:${LOCAL_COPIER_AGENT_PORT}`;

export interface LocalCopierAgentStatus {
  version: 1;
  environment: 'demo';
  nonce: string;
  group: CopyGroupConfig;
  controller: CopierControllerStatus;
  startedAt: string;
}

export type LocalCopierAgentCommand =
  | { type: 'copy-command'; command: LiveCopyTradingCommand }
  | { type: 'arm-live' }
  | { type: 'shadow' }
  | { type: 'disarm' }
  | { type: 'kill-switch' };

export interface LocalCopierAgentCommandResult {
  ok: true;
  status: LocalCopierAgentStatus;
  result?: LiveCopyTradingCommandResult;
}

export const copyGroupAccountIds = (group: CopyGroupConfig): number[] => {
  const leaderId = group.leaderAccountId;
  if (!Number.isSafeInteger(leaderId) || Number(leaderId) <= 0) return [];
  return [Number(leaderId), ...group.followers.map(follower => follower.accountId)].sort((a, b) => a - b);
};

export const sameCopyGroupAccounts = (left: CopyGroupConfig, right: CopyGroupConfig): boolean => {
  if (
    !Number.isSafeInteger(left.leaderAccountId)
    || !Number.isSafeInteger(right.leaderAccountId)
    || left.leaderAccountId !== right.leaderAccountId
  ) return false;
  const leftFollowers = left.followers.map(item => item.accountId).sort((a, b) => a - b);
  const rightFollowers = right.followers.map(item => item.accountId).sort((a, b) => a - b);
  return leftFollowers.length > 0
    && leftFollowers.length === rightFollowers.length
    && leftFollowers.every((accountId, index) => accountId === rightFollowers[index]);
};
