import type { OutboxEntry } from './copierOutbox';
import type { CancelOutboxEntry } from './copierCancelOutbox';
import type { BracketOutboxEntry } from './copierBracketOutbox';
import type { OsoOutboxEntry } from './copierOsoOutbox';
import { createCopierState, type CopierState, type FollowerOrderLink } from './copierEngine';

/** Poslední rejecty stačí držet podle počtu; časové TTL by starý replay znovu pustilo. */
export const COPIER_SEEN_TERMINAL_REJECT_LIMIT = 2_048;

/**
 * Trvalé uložení stavu copieru.
 *
 * Bez tohohle nemá „restart recovery" smysl — stav v paměti zmizí s
 * procesem a po startu by se všechno naplánovalo znovu. Outbox je tu
 * důležitější než množina hotových klíčů: právě v něm visí objednávky
 * s neznámým osudem, které se po restartu musí dohledat.
 *
 * `commit()` musí být atomický. In-memory implementace to má zadarmo,
 * Supabase verze bude potřebovat jednu transakci — částečně zapsaný
 * outbox je horší než žádný.
 */

export interface CopierSnapshot {
  /** Monotónní verze pro optimistic concurrency / CAS. */
  revision: number;
  replicated: string[];
  lastSequence: number;
  outbox: OutboxEntry[];
  /** Atomické OCO páry mají vlastní outbox; nesmí se obnovovat jako dva ordery. */
  bracketOutbox?: BracketOutboxEntry[];
  /** Atomické čekající entry + SL/TP. */
  osoOutbox?: OsoOutboxEntry[];
  cancelOutbox: CancelOutboxEntry[];
  /** Vazby leader objednávka → follower objednávky, aby šlo po restartu rušit. */
  links: [string, FollowerOrderLink[]][];
  leaderCumQty: [string, number][];
  followerFillTargets: [string, number][];
  safety?: CopierState['safety'];
}

export interface CopierStore {
  load(): Promise<CopierSnapshot>;
  commit(snapshot: CopierSnapshot, expectedRevision: number): Promise<CopierSnapshot>;
}

export class CopierStoreConflictError extends Error {
  constructor(expected: number, actual: number) {
    super(`Copier snapshot conflict: expected revision ${expected}, actual ${actual}`);
    this.name = 'CopierStoreConflictError';
  }
}

export function emptySnapshot(): CopierSnapshot {
  return {
    revision: 0,
    replicated: [],
    lastSequence: 0,
    outbox: [],
    bracketOutbox: [],
    osoOutbox: [],
    cancelOutbox: [],
    links: [],
    leaderCumQty: [],
    followerFillTargets: [],
    safety: { entryCooldownUntil: 0, dayLockUntil: 0, accountEligibility: [] },
  };
}

export function snapshotToState(snapshot: CopierSnapshot): CopierState {
  return createCopierState(
    snapshot.replicated,
    snapshot.lastSequence,
    snapshot.links,
    snapshot.leaderCumQty,
    snapshot.followerFillTargets,
    snapshot.safety,
  );
}

/**
 * In-memory store pro testy a shadow běh.
 *
 * Kopíruje data při zápisu i čtení, aby volající nemohl omylem měnit
 * uložený stav zvenčí — to je chyba, která by se na Supabase verzi
 * neprojevila a tady by prošla.
 */
export function createMemoryCopierStore(initial: CopierSnapshot = emptySnapshot()): CopierStore {
  let stored: CopierSnapshot = cloneSnapshot(initial);
  return {
    async load() {
      return cloneSnapshot(stored);
    },
    async commit(snapshot, expectedRevision) {
      if (stored.revision !== expectedRevision) {
        throw new CopierStoreConflictError(expectedRevision, stored.revision);
      }
      stored = cloneSnapshot({ ...snapshot, revision: expectedRevision + 1 });
      return cloneSnapshot(stored);
    },
  };
}

function cloneSnapshot(snapshot: CopierSnapshot): CopierSnapshot {
  return {
    replicated: [...snapshot.replicated],
    revision: snapshot.revision,
    lastSequence: snapshot.lastSequence,
    outbox: snapshot.outbox.map(entry => ({
      ...entry,
      request: { ...entry.request },
      ...(entry.liquidationAttempt
        ? { liquidationAttempt: { ...entry.liquidationAttempt } }
        : {}),
      ...(entry.confirmationEvidence
        ? { confirmationEvidence: { ...entry.confirmationEvidence } }
        : {}),
    })),
    bracketOutbox: (snapshot.bracketOutbox ?? []).map(entry => ({
      ...entry,
      request: {
        ...entry.request,
        first: { ...entry.request.first },
        second: { ...entry.request.second },
      },
    })),
    osoOutbox: (snapshot.osoOutbox ?? []).map(entry => ({
      ...entry,
      request: {
        ...entry.request,
        first: { ...entry.request.first },
        second: { ...entry.request.second },
      },
    })),
    cancelOutbox: snapshot.cancelOutbox.map(entry => ({
      ...entry,
      ...(entry.changes ? { changes: { ...entry.changes } } : {}),
    })),
    links: snapshot.links.map(([orderId, links]) => [orderId, links.map(link => ({ ...link }))]),
    leaderCumQty: snapshot.leaderCumQty.map(item => [...item]),
    followerFillTargets: snapshot.followerFillTargets.map(item => [...item]),
    safety: cloneSafety(snapshot.safety),
  };
}

function cloneSafety(safety: CopierSnapshot['safety']): NonNullable<CopierSnapshot['safety']> {
  const base = safety ?? { entryCooldownUntil: 0, dayLockUntil: 0 };
  const { leaderExposureEpochs, ...rest } = base;
  return {
    ...rest,
    ...(leaderExposureEpochs
      ? {
        leaderExposureEpochs: leaderExposureEpochs.map(epoch => ({
          ...epoch,
          followers: epoch.followers.map(follower => ({ ...follower })),
          leaderEntryOrderIds: [...epoch.leaderEntryOrderIds],
          leaderExitOrderIds: [...epoch.leaderExitOrderIds],
        })),
      }
      : {}),
    accountEligibility: base.accountEligibility?.map(entry => ({
      ...entry,
      ...(entry.lastExecution ? {
        lastExecution: {
          ...entry.lastExecution,
          ...(entry.lastExecution.resolution
            ? { resolution: { ...entry.lastExecution.resolution } }
            : {}),
        },
      } : {}),
    })) ?? [],
    ...(base.seenTerminalRejects
      ? { seenTerminalRejects: base.seenTerminalRejects.map(entry => ({ ...entry })) }
      : {}),
    ...(base.dailyStats
      ? {
        dailyStats: {
          ...base.dailyStats,
          openLots: base.dailyStats.openLots.map(lot => ({ ...lot })),
          recentClosedTrades: base.dailyStats.recentClosedTrades?.map(trade => ({ ...trade })) ?? [],
          unpricedSymbols: [...base.dailyStats.unpricedSymbols],
        },
      }
      : {}),
  };
}

/**
 * Sestaví snapshot ze živého stavu a outboxu.
 *
 * Do `replicated` jdou jen klíče v konečném stavu. Nejasné konce zůstávají
 * v outboxu — kdyby se zapsaly jako hotové, po restartu by se na ně
 * zapomnělo a rozdíl by zůstal navždy.
 */
export function toSnapshot(
  state: CopierState,
  outbox: Iterable<OutboxEntry>,
  cancelOutbox: Iterable<CancelOutboxEntry> = [],
  revision = 0,
  bracketOutbox: Iterable<BracketOutboxEntry> = [],
  osoOutbox: Iterable<OsoOutboxEntry> = [],
): CopierSnapshot {
  return {
    revision,
    replicated: [...state.replicated],
    lastSequence: state.lastSequence,
    outbox: [...outbox],
    bracketOutbox: [...bracketOutbox],
    osoOutbox: [...osoOutbox],
    cancelOutbox: [...cancelOutbox],
    links: [...state.links].map(([orderId, links]) => [orderId, [...links]]),
    leaderCumQty: [...state.leaderCumQty],
    followerFillTargets: [...state.followerFillTargets],
    safety: cloneSafety(state.safety),
  };
}
