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
  // ARM vychází z vypnuté kopírky: násobek se smí změnit libovolně (1. 10.).
  const multiplierOptions = { allowMultiplierIncrease: !runtime.controller.armed };
  const weaker = isWeakerRiskConfig(runtime.group, group, multiplierOptions);
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
    ...isWeakerRiskConfig(runtime.group, group, multiplierOptions),
    ...isWeakerRiskConfig(requested, group, multiplierOptions),
  ])];
  if (unresolved.length) {
    throw new CopierArmBlockedError(`Skupina má neslučitelná pravidla: ${[...new Set(unresolved.map(copierRiskRuleName))].join(', ')}. Zkontroluj Risk; dnešní potvrzená omezení se při zapnutí nesnižují.`);
  }
  return { group, preservedRules: [...new Set(weaker.map(copierRiskRuleName))] };
}

/** OAuth-visible accounts alone are not evidence of an installed execution route. */
export function assertCopierArmConnections(
  group: CopyGroupConfig,
  runtime: Pick<LocalCopierAgentStatus, 'device' | 'devices' | 'connectionDiscovery'>,
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
    const discovered = runtime.connectionDiscovery?.loadedConnectionIds.includes(owners[0][0]) === true;
    if (!discovered && (!device || device.state !== 'paired')) {
      const pending = runtime.connectionDiscovery?.pendingConnectionIds.includes(owners[0][0]) === true;
      throw new CopierArmBlockedError(pending
        ? `Připojení účtu ${id} si Mac worker načte sám, jakmile bude kopírka vypnutá a bez otevřených pozic (do minuty).`
        : runtime.connectionDiscovery?.scope === 'owner'
          ? `Připojení účtu ${id} Mac worker zatím nenačetl. Zkontroluj připojení v záložce Připojení; worker ho zkusí znovu sám.`
          : `Připojení účtu ${id} ještě není v Mac workeru. V záložce Připojení povol Macu načítat tvoje propfirmy; worker ho pak načte sám.`);
    }
  }
}

/** Značka workeru `[retire-missing:<groupId>:<ids>]` → co nabídnout k potvrzení. */
export function retireMissingFromError(reason: unknown): { groupId: string; accountIds: number[] } | null {
  const message = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : '';
  const match = /\[retire-missing:([^:\]]+):([0-9,]+)\]/.exec(message);
  if (!match) return null;
  const accountIds = match[2].split(',').map(Number).filter(id => Number.isSafeInteger(id) && id > 0);
  if (accountIds.length === 0) return null;
  try {
    return { groupId: decodeURIComponent(match[1]), accountIds };
  } catch {
    return null;
  }
}

export function copierArmRejection(reason: unknown): string | null {
  if (reason instanceof CopierArmBlockedError) return reason.message;
  if (!(reason instanceof Error)) return null;
  const message = reason.message.replace(/\s+/g, ' ').trim();
  if (/\[ack-incident:[^\]]+\]/.test(message)) {
    // Worker hlásí incident, který UI ještě nevidělo (nebo nový): žádné
    // automatické opakování, uživatel ho potvrdí dalším Zapnout.
    return `${message
      .replace(/\s*\[ack-incident:[^\]]+\]/, '')
      .replace(/\s*\(starší appka[^)]*\)/, '')
      .replace(/^Zapnutí po incidentu vyžaduje tvoje potvrzení: /, 'Mezitím vznikl incident: ')} Dej znovu Zapnout a potvrď ho.`;
  }
  if (message === 'Incident se mezitím změnil; potvrď ho znovu.') {
    return 'Mezitím vznikl nový incident. Dej znovu Zapnout a potvrď ho.';
  }
  if (message === 'tighten-only') {
    return 'Zapnutí bylo odmítnuto, protože požadovaná pravidla jsou mírnější než dnešní potvrzené nastavení. Obnov stav a zkontroluj Risk.';
  }
  if (message === 'copier-relay-arm-config-conflict') {
    return 'Jiné zapnutí už čeká ve frontě. Nejdřív kopírku vypni a potom zapni požadovanou konfiguraci.';
  }
  if (/kopírka je zapnutá s jinou konfigurací.*nejdřív vypni/i.test(message)) {
    return 'Kopírka je zapnutá s jinou konfigurací — nejdřív ji vypni.';
  }
  if (message === 'copier-relay-worker-disconnected'
    || /ARM odmítnut: worker není připojen k brokeru/i.test(message)) {
    return 'Zapnutí bylo odmítnuto: Mac worker není připojený k brokeru. Nic se nezapnulo; obnov spojení a potom ARM zopakuj.';
  }
  if (/ARM odmítnut: vypršel deadline potvrzení/i.test(message)
    || message === 'command-expired-before-execution'
    || message === 'command-expired-or-predates-worker-session') {
    return 'Zapnutí nestihlo proběhnout včas — nic se nezapnulo. Obnov stav a potom ARM zopakuj.';
  }
  if (message === 'superseded-by-brake'
    || /ARM odmítnut: během přípravy přišl[ao].*(?:DISARM|kill switch|denní lock|bezpečnostní brzda)/i.test(message)) {
    return 'Zapnutí zrušila novější brzda (DISARM, kill switch nebo denní zámek) — nic se nezapnulo.';
  }
  if (/ARM odmítnut: příkaz je starší než poslední bezpečnostní brzda/i.test(message)) {
    return 'Zapnutí bylo odmítnuto: ARM je starší než poslední brzda — nic se nezapnulo.';
  }
  const match = /^Pravidla jdou dnes jen zpřísnit: (.+) \(reset po konci session\)$/.exec(message);
  return match
    ? `Zapnutí bylo odmítnuto pravidly dne: ${[...new Set(match[1].split(', ').map(copierRiskRuleName))].join(', ')}. Obnov stav a zkontroluj Risk.`
    : null;
}
