import { oppositeSide, type BrokerOrder, type BrokerPort } from './brokerPort';
import type { LeaderEvent, ModifyCommand } from './copierEngine';
import type { OsoOutboxEntry } from './copierOsoOutbox';
import type { CopyGroupConfig } from './liveCopyTrading';

export interface StagedOsoModifyCommand extends ModifyCommand {
  stage: 1 | 2;
}

export interface OsoModifyCascadePlan {
  commands: StagedOsoModifyCommand[];
  error?: string;
}

function validateLeaderChild(
  order: BrokerOrder | null,
  options: {
    role: 'stop' | 'target';
    leaderAccountId: number;
    leaderEntryOrderId: string;
    expectedOrderId: string;
    symbol: string;
    side: LeaderEvent['side'];
    quantity: number;
  },
): string | null {
  if (!order) return `${options.role} ${options.expectedOrderId} nebyl nalezen`;
  if (order.brokerOrderId !== options.expectedOrderId) return `${options.role} lookup vrátil jiné order ID`;
  if (order.accountId !== options.leaderAccountId) return `${options.role} patří jinému účtu`;
  // TradingView/Tradovate native OSO leader child entity nemusí parentId vůbec
  // publikovat. Přesná durable stop/target ID už bracket bezpečně kotví; pokud
  // ale broker parent ID poskytne, nesmí odporovat očekávanému entry orderu.
  if (order.parentOrderId != null && order.parentOrderId !== options.leaderEntryOrderId) {
    return `${options.role} není child očekávaného parentu`;
  }
  if (order.symbol !== options.symbol) return `${options.role} má jiný kontrakt`;
  if (order.side !== oppositeSide(options.side)) return `${options.role} má nesprávnou stranu`;
  if (order.status !== 'working') return `${options.role} není working (${order.status})`;
  if (order.quantity !== options.quantity || order.filledQuantity !== 0) {
    return `${options.role} množství/fill nesouhlasí (${order.filledQuantity}/${order.quantity} vs ${options.quantity})`;
  }
  if (options.role === 'stop') {
    if (order.orderType !== 'Stop' && order.orderType !== 'StopLimit') return `stop má typ ${order.orderType}`;
    if (order.stopPrice == null) return 'stop nemá stop cenu';
    if (order.orderType === 'StopLimit' && order.limitPrice == null) return 'stop-limit nemá limit cenu';
  } else if (order.orderType !== 'Limit' || order.limitPrice == null) {
    return 'target nemá platnou limit cenu';
  }
  return null;
}

/**
 * Tradovate při změně ceny nativního OSO parentu relativně posune child SL/TP.
 * Copier ale kopíruje absolutní leader ceny. Před prvním follower side effectem
 * proto načte přesné leader child objednávky a připraví dvě navazující vrstvy:
 * stop se smí odeslat až po potvrzeném parentu a target až po potvrzeném stopu.
 */
export async function planOsoModifyCascade(options: {
  event: LeaderEvent;
  group: CopyGroupConfig;
  modifications: readonly ModifyCommand[];
  osoOutbox: ReadonlyMap<string, OsoOutboxEntry>;
  broker: BrokerPort;
}): Promise<OsoModifyCascadePlan> {
  const { event, group, modifications, osoOutbox, broker } = options;
  if (event.kind !== 'replaced' || modifications.length === 0) return { commands: [] };

  const modificationAccounts = modifications.map(modification => modification.accountId);
  if (new Set(modificationAccounts).size !== modificationAccounts.length) {
    return {
      commands: [],
      error: 'oso-leader-protection-unverified: duplicitní follower modify',
    };
  }
  const explicitRoles = new Set(modifications.flatMap(modification => (
    modification.nativeOsoRole ? [modification.nativeOsoRole] : []
  )));
  if (explicitRoles.size > 1) {
    return {
      commands: [],
      error: 'oso-leader-protection-unverified: smíšené role follower OSO linků',
    };
  }
  const explicitRole = [...explicitRoles][0];
  // Přímý posun SL/TP je běžný child modify. Tradovate při něm nerebasuje
  // sourozence, takže musí pokračovat obecnou lifecycle cestou a nesmí být
  // zaměněn za změnu OSO parentu.
  if (explicitRole === 'stop' || explicitRole === 'target') return { commands: [] };

  const eventMappings = [...osoOutbox.values()].filter(entry => (
    entry.leaderEntryOrderId === event.orderId
    && modificationAccounts.includes(entry.request.accountId)
  ));
  // Zpětná kompatibilita pro snapshoty vytvořené před explicitní rolí: přesná
  // durable OSO ID bezpečně rozliší child od parentu. Neodvozujeme roli ze
  // suffixu textového klíče.
  if (!explicitRole && eventMappings.length === 0) {
    const childRoles = new Set(modifications.flatMap(modification => (
      [...osoOutbox.values()].flatMap(mapping => {
        if (
          mapping.leaderStopOrderId === event.orderId
          && mapping.request.accountId === modification.accountId
          && mapping.firstBrokerOrderId === modification.brokerOrderId
        ) return ['stop' as const];
        if (
          mapping.leaderTargetOrderId === event.orderId
          && mapping.request.accountId === modification.accountId
          && mapping.secondBrokerOrderId === modification.brokerOrderId
        ) return ['target' as const];
        return [];
      })
    )));
    if (childRoles.size === 1) return { commands: [] };
    if (childRoles.size > 1) {
      return {
        commands: [],
        error: 'oso-leader-protection-unverified: nejednoznačná legacy child role',
      };
    }
  }
  // Legacy OSO link bez durable mappingu je poškozený snapshot. Prefix zde
  // používáme jen jako důkaz OSO původu, nikdy k hádání role.
  const hasLegacyOsoOrigin = modifications.some(modification => modification.key.startsWith('mx:oso:'));
  // Bez OSO mappingu i bez OSO follower linku jde o obyčejný parent a obecná
  // lifecycle cesta níže zůstává správná. Jakmile ale existuje kterákoli OSO
  // stopa, mapping musí být úplný pro KAŽDÝ follower modify. Smíšená cesta by
  // jinak opravila ochrany jen části účtů a zbytek parentů posunula bez
  // absolutního SL/TP.
  if (eventMappings.length === 0 && explicitRole !== 'entry' && !hasLegacyOsoOrigin) {
    return { commands: [] };
  }
  const relevant = modifications.flatMap(modification => {
    // Nestačí `.find()` přes stejný leader order: durable outbox může nést
    // starou vazbu z dřívější skupiny se stejným leaderem a followerem.
    // Modify smí použít výhradně mapping aktuální skupiny. Jakákoli jen
    // částečná/stará stopa přepne celý event do fail-closed větve níže.
    const mapping = osoOutbox.get(
      `oso:${group.id}:${event.orderId}:${modification.accountId}`,
    );
    const valid = mapping && (
      mapping.status === 'acknowledged'
      && mapping.leaderEntryOrderId === event.orderId
      && mapping.request.accountId === modification.accountId
      && mapping.entryBrokerOrderId === modification.brokerOrderId
    );
    return valid ? [{ modification, mapping }] : [];
  });
  if (relevant.length !== modifications.length) {
    return {
      commands: [],
      error: 'oso-leader-protection-unverified: follower OSO mapping není úplný pro všechny modify',
    };
  }
  if (relevant.some(({ mapping }) => !mapping.firstBrokerOrderId || !mapping.secondBrokerOrderId)) {
    return { commands: [], error: 'oso-leader-protection-unverified: follower OSO mapping není úplný' };
  }

  const leaderPairs = new Set(relevant.map(({ mapping }) => (
    `${mapping.leaderStopOrderId}:${mapping.leaderTargetOrderId}`
  )));
  if (leaderPairs.size !== 1) {
    return { commands: [], error: 'oso-leader-protection-unverified: nejednoznačné leader child vazby' };
  }

  const mapping = relevant[0].mapping;
  let stopLookup;
  let targetLookup;
  try {
    [stopLookup, targetLookup] = await Promise.all([
      broker.findOrderById(group.leaderAccountId, mapping.leaderStopOrderId),
      broker.findOrderById(group.leaderAccountId, mapping.leaderTargetOrderId),
    ]);
  } catch (error) {
    return {
      commands: [],
      error: `oso-leader-protection-unverified: lookup selhal (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  if (stopLookup.completeness !== 'authoritative' || targetLookup.completeness !== 'authoritative') {
    return { commands: [], error: 'oso-leader-protection-unverified: leader child lookup není autoritativní' };
  }

  const common = {
    leaderAccountId: group.leaderAccountId,
    leaderEntryOrderId: event.orderId,
    symbol: event.symbol,
    side: event.side,
    quantity: event.quantity,
  };
  const stopProblem = validateLeaderChild(stopLookup.order, {
    ...common, role: 'stop', expectedOrderId: mapping.leaderStopOrderId,
  });
  const targetProblem = validateLeaderChild(targetLookup.order, {
    ...common, role: 'target', expectedOrderId: mapping.leaderTargetOrderId,
  });
  if (stopProblem || targetProblem || !stopLookup.order || !targetLookup.order) {
    return {
      commands: [],
      error: `oso-leader-protection-unverified: ${stopProblem ?? targetProblem ?? 'leader child chybí'}`,
    };
  }

  const leaderStop = stopLookup.order;
  const leaderTarget = targetLookup.order;
  return {
    commands: relevant.flatMap(({ modification, mapping: followerMapping }) => ([
      {
        key: `mx:${followerMapping.key}:stop-reassert:${event.id}`,
        accountId: modification.accountId,
        brokerOrderId: followerMapping.firstBrokerOrderId!,
        quantity: modification.quantity,
        orderType: leaderStop.orderType,
        ...(leaderStop.limitPrice != null ? { limitPrice: leaderStop.limitPrice } : {}),
        ...(leaderStop.stopPrice != null ? { stopPrice: leaderStop.stopPrice } : {}),
        stage: 1 as const,
      },
      {
        key: `mx:${followerMapping.key}:target-reassert:${event.id}`,
        accountId: modification.accountId,
        brokerOrderId: followerMapping.secondBrokerOrderId!,
        quantity: modification.quantity,
        orderType: leaderTarget.orderType,
        ...(leaderTarget.limitPrice != null ? { limitPrice: leaderTarget.limitPrice } : {}),
        ...(leaderTarget.stopPrice != null ? { stopPrice: leaderTarget.stopPrice } : {}),
        stage: 2 as const,
      },
    ])),
  };
}
