import { isWeakerRiskConfig } from './copierRiskConfig';
import { sanitizeCopyGroupSafety, type CopyGroupConfig } from '../services/liveCopyTrading';
import type { LocalCopierAgentStatus } from './localCopierAgentProtocol';

/** A local precheck failed before dispatch; unlike a timeout its outcome is known. */
export class CopierArmBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CopierArmBlockedError';
  }
}

const ruleNames: Record<string, string> = {
  'safety': 'pravidla skupiny',
  'safety.entryCooldownMinutes': 'pauza mezi obchody',
  'safety.dailyLossLimitUsd': 'denní limit ztráty',
  'safety.dailyMaxLosingTrades': 'počet ztrátových obchodů',
  'safety.dailyMaxTrades': 'počet obchodů za den',
  'safety.armExpiryFlatten': 'uzavření pozic při konci session',
};

export const copierRiskRuleName = (field: string): string => ruleNames[field]
  ?? (field.startsWith('safety.tradingWindow') ? 'obchodní okno'
    : field.startsWith('safety.dayRuleActions') ? 'reakce na denní limity'
      : field.startsWith('followers.') ? 'omezení follower účtu' : 'pravidla dne');

/**
 * ARM is not a risk editor. Keep the session floor when a saved group still
 * contains weaker defaults. Never weaken the requested group either. The
 * existing relay AND worker checks remain authoritative (including races).
 * Incompatible windows and account-specific conflicts require an explicit edit.
 */
export function prepareCopierArmGroup(
  requested: CopyGroupConfig,
  runtime: Pick<LocalCopierAgentStatus, 'group' | 'controller'>,
): { group: CopyGroupConfig; preservedRules: string[] } {
  const group = structuredClone(requested);
  const numericFields = ['entryCooldownMinutes', 'dailyLossLimitUsd', 'dailyMaxLosingTrades', 'dailyMaxTrades'] as const;
  for (const safety of [requested.safety, runtime.group.safety]) {
    if (numericFields.some(field => safety?.[field] != null
      && (typeof safety[field] !== 'number' || !Number.isFinite(safety[field]) || safety[field] < 0))) {
      throw new CopierArmBlockedError('Pravidla kopírky nejsou úplná. Obnov stav a zkontroluj záložku Risk.');
    }
  }
  if (!(runtime.controller.sessionArmedAt && runtime.controller.sessionArmedAt > 0)) {
    return { group, preservedRules: [] };
  }
  const previous = sanitizeCopyGroupSafety(runtime.group.safety);
  const next = sanitizeCopyGroupSafety(group.safety);
  if (!previous || !next) throw new CopierArmBlockedError('Pravidla kopírky nejsou úplná. Obnov stav a zkontroluj záložku Risk.');
  group.safety = next;
  const weaker = isWeakerRiskConfig(runtime.group, group);
  for (const field of weaker) {
    switch (field) {
      case 'safety.entryCooldownMinutes': next.entryCooldownMinutes = previous.entryCooldownMinutes; break;
      case 'safety.dailyLossLimitUsd': next.dailyLossLimitUsd = previous.dailyLossLimitUsd; break;
      case 'safety.dailyMaxLosingTrades': next.dailyMaxLosingTrades = previous.dailyMaxLosingTrades; break;
      case 'safety.dailyMaxTrades': next.dailyMaxTrades = previous.dailyMaxTrades; break;
      case 'safety.armExpiryFlatten': next.armExpiryFlatten = previous.armExpiryFlatten; break;
      default: {
        if (field.startsWith('safety.tradingWindow.')) {
          next.tradingWindow = structuredClone(previous.tradingWindow);
        }
        const actions = [
          ['losingTrades', 'beforeLimit'], ['losingTrades', 'atLimit'],
          ['dailyLoss', 'at80Percent'], ['dailyLoss', 'atLimit'],
          ['maxTrades', 'atLimit'], ['windowEnd', 'atEnd'],
        ] as const;
        for (const [rule, action] of actions) {
          if (field !== `safety.dayRuleActions.${rule}.${action}`) continue;
          // Each tuple is a valid key pair; the heterogeneous union is narrowed
          // through the shared action shape rather than changing unrelated rules.
          const source = previous.dayRuleActions[rule] as Record<string, unknown>;
          const destination = next.dayRuleActions[rule] as Record<string, unknown>;
          destination[action] = structuredClone(source[action]);
        }
      }
    }
  }
  const unresolved = [...new Set([
    ...isWeakerRiskConfig(runtime.group, group),
    ...isWeakerRiskConfig(requested, group),
  ])];
  if (unresolved.length) {
    throw new CopierArmBlockedError(`Skupina má neslučitelná pravidla: ${[...new Set(unresolved.map(copierRiskRuleName))].join(', ')}. Zkontroluj Risk; dnešní potvrzená omezení se při zapnutí nesnižují.`);
  }
  return { group, preservedRules: [...new Set(weaker.map(copierRiskRuleName))] };
}

/** OAuth-visible accounts alone are not evidence of an installed execution route. */
export function assertCopierArmConnections(
  group: CopyGroupConfig,
  runtime: Pick<LocalCopierAgentStatus, 'device' | 'devices'>,
  connections: Record<string, { accounts: readonly { id: number }[] }>,
  excludedAccountIds: readonly number[] = [],
): void {
  const devices = runtime.devices ?? (runtime.device ? [runtime.device] : []);
  const excluded = new Set(excludedAccountIds);
  const members = [group.leaderAccountId, ...group.followers
    .filter(follower => follower.mode !== 'off' && !excluded.has(follower.accountId))
    .map(follower => follower.accountId)].filter((id): id is number => id != null);
  for (const id of members) {
    const owners = Object.entries(connections).filter(([, value]) => value.accounts.some(account => account.id === id));
    if (owners.length !== 1) {
      throw new CopierArmBlockedError(`Nelze jednoznačně ověřit připojení účtu ${id}. Obnov data v Připojení.`);
    }
    const device = devices.find(candidate => candidate.connectionId === owners[0][0]);
    if (!device || device.state !== 'paired') {
      throw new CopierArmBlockedError(`Připojení účtu ${id} ještě není zapojené do běžící kopírky. Samotné přihlášení k Tradovate umožňuje načíst účty; pro kopírování je potřeba spárovat toto připojení s Mac workerem a bezpečně jej načíst do workeru.`);
    }
  }
}

export function copierArmRejection(reason: unknown): string | null {
  if (reason instanceof CopierArmBlockedError) return reason.message;
  if (!(reason instanceof Error)) return null;
  if (reason.message === 'tighten-only') {
    return 'Zapnutí bylo odmítnuto, protože požadovaná pravidla jsou mírnější než dnešní potvrzené nastavení. Obnov stav a zkontroluj Risk.';
  }
  const match = /^Pravidla jdou dnes jen zpřísnit: (.+) \(reset po konci session\)$/.exec(reason.message);
  return match
    ? `Zapnutí bylo odmítnuto pravidly dne: ${[...new Set(match[1].split(', ').map(copierRiskRuleName))].join(', ')}. Obnov stav a zkontroluj Risk.`
    : null;
}
