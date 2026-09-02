import { constants } from 'node:fs';
import { chmod, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createFileCopyGroupStore } from './fileCopyGroupStore';
import type { CopyFollowerConfig, CopyGroupConfig } from './liveCopyTrading';

export interface CopierCliGroup {
  leaderAccountId: number;
  followers: CopyFollowerConfig[];
}

export type DurableGroupInstallStrategy = 'require-match' | 'adopt' | 'replace';

export interface DurableGroupComparison {
  matches: boolean;
  durable: string;
  cli: string;
}

export interface DurableGroupReplacementStatus {
  armed?: unknown;
  groupFlat?: unknown;
  workingOrderAccounts?: unknown;
  stuckOutbox?: unknown;
  stuckOperations?: unknown;
}

export type DurableGroupInstallDecision =
  | { action: 'first-install' | 'match' | 'adopt'; group: CopyGroupConfig; comparison: DurableGroupComparison | null }
  | { action: 'replace'; group: CopyGroupConfig; comparison: DurableGroupComparison };

export const copierPilotStateKey = (connectionId: string, leaderAccountId: number): string => (
  `${connectionId}-${leaderAccountId}`
);

export const copierPilotGroupPath = (
  root: string,
  connectionId: string,
  leaderAccountId: number,
): string => resolve(root, `${copierPilotStateKey(connectionId, leaderAccountId)}.group.json`);

/** Parses the exact follower syntax shared by pilot startup and the Mac installer. */
export function parseCopierFollowersFlag(raw: string, leaderAccountId: number): CopyFollowerConfig[] {
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
    if (follower.accountId === leaderAccountId) throw new Error('Leader nemůže být zároveň follower');
    if (seen.has(follower.accountId)) throw new Error(`Follower ${follower.accountId} je uveden vícekrát`);
    seen.add(follower.accountId);
  }
  return followers;
}

const comparableFollowers = (followers: readonly CopyFollowerConfig[]) => followers
  .map(({ accountId, multiplier, maxContracts }) => ({ accountId, multiplier, maxContracts }))
  .sort((left, right) => left.accountId - right.accountId);

const formatGroup = (leaderAccountId: number | null, followers: readonly CopyFollowerConfig[]): string => (
  `leader=${leaderAccountId ?? 'null'} followers=[${comparableFollowers(followers).map(follower => (
    `${follower.accountId}@${follower.multiplier}${follower.maxContracts == null ? '' : `@${follower.maxContracts}`}`
  )).join(', ')}]`
);

export function compareDurableGroupWithCli(
  durableGroup: CopyGroupConfig,
  cliGroup: CopierCliGroup,
): DurableGroupComparison {
  const durableFollowers = comparableFollowers(durableGroup.followers);
  const cliFollowers = comparableFollowers(cliGroup.followers);
  const matches = durableGroup.leaderAccountId === cliGroup.leaderAccountId
    && durableFollowers.length === cliFollowers.length
    && durableFollowers.every((follower, index) => {
      const cliFollower = cliFollowers[index];
      return cliFollower != null
        && follower.accountId === cliFollower.accountId
        && follower.multiplier === cliFollower.multiplier
        && follower.maxContracts === cliFollower.maxContracts;
    });
  return {
    matches,
    durable: formatGroup(durableGroup.leaderAccountId, durableGroup.followers),
    cli: formatGroup(cliGroup.leaderAccountId, cliGroup.followers),
  };
}

export function durableGroupReplacementBlockers(
  status: DurableGroupReplacementStatus | null | undefined,
): string[] {
  if (!status) return ['lokální agent nevrátil controller status'];
  const blockers: string[] = [];
  if (status.armed !== false) blockers.push('worker nehlásí DISARMED');
  if (status.groupFlat !== true) blockers.push('groupFlat není true');
  if (!Array.isArray(status.workingOrderAccounts) || status.workingOrderAccounts.length > 0) {
    blockers.push('existují working orders nebo je jejich stav neznámý');
  }
  if (status.stuckOutbox !== false) blockers.push('stuck outbox není prokazatelně prázdný');
  if (!Array.isArray(status.stuckOperations) || status.stuckOperations.length > 0) {
    blockers.push('existují stuck operace nebo je jejich stav neznámý');
  }
  return blockers;
}

const replacementGroup = (durableGroup: CopyGroupConfig, cliGroup: CopierCliGroup): CopyGroupConfig => ({
  ...durableGroup,
  leaderAccountId: cliGroup.leaderAccountId,
  followers: cliGroup.followers.map(cliFollower => ({
    ...cliFollower,
    mode: durableGroup.followers.find(item => item.accountId === cliFollower.accountId)?.mode ?? cliFollower.mode,
  })),
});

export function decideDurableGroupInstall(options: {
  durableGroup: CopyGroupConfig | null;
  cliGroup: CopierCliGroup;
  fallbackGroup: CopyGroupConfig;
  strategy: DurableGroupInstallStrategy;
  replacementStatus?: DurableGroupReplacementStatus | null;
}): DurableGroupInstallDecision {
  const { durableGroup, cliGroup, fallbackGroup, strategy } = options;
  if (!durableGroup) return { action: 'first-install', group: fallbackGroup, comparison: null };
  const comparison = compareDurableGroupWithCli(durableGroup, cliGroup);
  if (comparison.matches) return { action: 'match', group: durableGroup, comparison };
  if (strategy === 'adopt') return { action: 'adopt', group: durableGroup, comparison };
  if (strategy === 'replace') {
    const blockers = durableGroupReplacementBlockers(options.replacementStatus);
    if (blockers.length > 0) {
      throw new Error(`Durable skupinu nelze bezpečně přepsat: ${blockers.join('; ')}.`);
    }
    return { action: 'replace', group: replacementGroup(durableGroup, cliGroup), comparison };
  }
  throw new Error('CLI skupina se liší od autoritativní durable skupiny.');
}

export async function replaceDurableGroupWithBackup(options: {
  path: string;
  group: CopyGroupConfig;
  timestamp?: number;
}): Promise<string> {
  const backupPath = `${resolve(options.path)}.bak-${options.timestamp ?? Date.now()}`;
  await copyFile(resolve(options.path), backupPath, constants.COPYFILE_EXCL);
  await chmod(backupPath, 0o600);
  await createFileCopyGroupStore(options.path).save(options.group);
  return backupPath;
}
