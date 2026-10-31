import type { LocalCopierAgentCommandResult } from './localCopierAgentProtocol';

export type LiveSafetyAction = 'disarm' | 'kill-switch' | 'flatten-group';
export interface LiveSafetyTarget {
  id: string;
  name: string;
  accountIds: number[];
  observedAt: number | null;
  verified: boolean;
}

export interface FlattenGroupCoordinator {
  run: <T>(groupId: string, task: () => Promise<T>) => Promise<T>;
  pending: (groupId: string) => boolean;
  subscribe: (listener: () => void) => () => void;
}

/**
 * One full-group Flatten per group across every LIVE surface. A second caller
 * attaches to the real in-flight result instead of creating a second command.
 */
export function createFlattenGroupCoordinator(): FlattenGroupCoordinator {
  const inFlight = new Map<string, Promise<unknown>>();
  const listeners = new Set<() => void>();
  const publish = () => listeners.forEach(listener => listener());
  return {
    run<T>(groupId: string, task: () => Promise<T>): Promise<T> {
      const current = inFlight.get(groupId);
      if (current) return current as Promise<T>;
      const request = Promise.resolve().then(task).finally(() => {
        if (inFlight.get(groupId) !== request) return;
        inFlight.delete(groupId);
        publish();
      });
      inFlight.set(groupId, request);
      publish();
      return request;
    },
    pending: groupId => inFlight.has(groupId),
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

export function liveSafetyTargetAge(target: LiveSafetyTarget, now = Date.now()): string {
  if (target.verified) return 'stav cíle ověřený';
  if (target.observedAt == null || !Number.isFinite(target.observedAt)) return 'stav cíle neověřený · stáří neznámé';
  const ageSeconds = Math.max(0, Math.floor((now - target.observedAt) / 1_000));
  const age = ageSeconds < 60 ? `${ageSeconds} s` : `${Math.floor(ageSeconds / 60)} min`;
  return `stav cíle neověřený · poslední stav před ${age}`;
}

export function liveSafetyFailureMessage(reason: unknown): string {
  const base = reason instanceof Error ? reason.message : 'Bezpečnostní akci se nepodařilo potvrdit.';
  return /výsledek neověřen/i.test(base)
    ? base
    : `${base} Výsledek neověřen; akce se neopakuje.`;
}

export function assertSameSafetyTarget(requested: LiveSafetyTarget | undefined, current: LiveSafetyTarget | null): asserts requested is LiveSafetyTarget {
  const members = (target: LiveSafetyTarget) => [...new Set(target.accountIds)].sort((a, b) => a - b).join(',');
  if (!requested || !current || requested.id !== current.id || members(requested) !== members(current)) {
    throw new Error('Skupina workeru nebo její účty se změnily, případně je nelze určit. Flatten nebyl odeslán; znovu ověř cílovou skupinu.');
  }
}

/** Never turn an ACK, pending close or partial flatten into a confirmed flat claim. */
export function liveSafetyReceipt(action: LiveSafetyAction, payload: LocalCopierAgentCommandResult, expectedTarget?: LiveSafetyTarget): string {
  if (action === 'disarm') {
    if (payload.status.controller.armed !== false) throw new Error('Worker nepotvrdil vypnutí kopírky.');
    return 'Worker potvrdil OFF. Kopírování je vypnuté; pozice to nezavírá.';
  }
  if (action === 'kill-switch') {
    if (payload.status.controller.killSwitch !== true) throw new Error('Worker nepotvrdil Kill switch.');
    return 'Worker potvrdil Kill switch. Běžné brokerové akce kopírky jsou zablokované; pozice to samo nezavírá.';
  }
  const result = payload.result;
  if (!result || result.type !== 'flatten') throw new Error('Chybí potvrzený výsledek Flatten. Ověř účty u brokera, než příkaz zopakuješ.');
  if (result.pending) return 'Worker přijal zavírání na pozadí. Flat stav zatím není potvrzený; sleduj účty u brokera.';
  if (expectedTarget && (result.accountIds.length === 0 || [...new Set(result.accountIds)].sort((a, b) => a - b).join(',') !== [...new Set(expectedTarget.accountIds)].sort((a, b) => a - b).join(','))) {
    throw new Error('Potvrzení Flatten nepokrývá všechny potvrzené účty skupiny. Ověř je u brokera.');
  }
  if (!result.flat || result.remainingPositionAccounts.length || result.workingOrderAccounts.length || result.failedAccounts?.length) {
    throw new Error('Flatten není potvrzený jako dokončený. Některé účty mají neověřený stav, otevřené pozice nebo pracovní příkazy; zkontroluj je u brokera.');
  }
  return `Flatten potvrzen: ${result.accountIds.length} účtů je flat a bez pracovních příkazů.`;
}
