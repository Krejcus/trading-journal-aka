import { describe, expect, it } from 'vitest';
import type { BrokerOrderRequest } from '../services/brokerPort';
import { createCopierState, linkFollowerOrder } from '../services/copierEngine';
import { createOutboxEntry } from '../services/copierOutbox';
import {
  createMemoryCopierStore,
  CopierStoreConflictError,
  emptySnapshot,
  snapshotToState,
  toSnapshot,
} from '../services/copierStore';

const request: BrokerOrderRequest = {
  tag: 'cpabc123',
  accountId: 200,
  symbol: 'MNQU6',
  side: 'Buy',
  quantity: 1,
  orderType: 'Market',
};

describe('createMemoryCopierStore', () => {
  it('vrací uložený snapshot', async () => {
    const store = createMemoryCopierStore();
    await store.commit({ revision: 0, replicated: ['cp:g1:e1:200'], lastSequence: 4, outbox: [], cancelOutbox: [], links: [], leaderCumQty: [], followerFillTargets: [] }, 0);
    const loaded = await store.load();
    expect(loaded).toMatchObject({ replicated: ['cp:g1:e1:200'], lastSequence: 4 });
  });

  it('prázdný store vrací prázdný snapshot', async () => {
    expect(await createMemoryCopierStore().load()).toEqual(emptySnapshot());
  });

  it('uložený stav nejde změnit zvenčí', async () => {
    // Mutace načteného snapshotu nesmí prosáknout do úložiště — na Supabase
    // verzi by se taková chyba neprojevila a tady by prošla.
    const store = createMemoryCopierStore();
    await store.commit({ revision: 0, replicated: ['a'], lastSequence: 1, outbox: [], cancelOutbox: [], links: [], leaderCumQty: [], followerFillTargets: [] }, 0);

    const loaded = await store.load();
    loaded.replicated.push('b');
    loaded.lastSequence = 99;

    expect(await store.load()).toMatchObject({ replicated: ['a'], lastSequence: 1 });
  });

  it('commit nedrží referenci na předaný snapshot', async () => {
    const store = createMemoryCopierStore();
    const snapshot = { revision: 0, replicated: ['a'], lastSequence: 1, outbox: [], cancelOutbox: [], links: [], leaderCumQty: [], followerFillTargets: [] };
    await store.commit(snapshot, 0);
    snapshot.replicated.push('b');
    expect((await store.load()).replicated).toEqual(['a']);
  });

  it('hluboce kopíruje i změny v cancel/modify outboxu', async () => {
    const store = createMemoryCopierStore();
    const snapshot = emptySnapshot();
    snapshot.cancelOutbox.push({
      operation: 'modify', key: 'modify:1', leaderEventId: 'leader:1', leaderSequence: 1,
      accountId: 200, brokerOrderId: 'mo-1', status: 'planned', attempts: 0, updatedAt: 1,
      changes: { quantity: 2, orderType: 'Limit', limitPrice: 29_500 },
    });
    await store.commit(snapshot, 0);

    const loaded = await store.load();
    loaded.cancelOutbox[0].changes!.quantity = 99;
    snapshot.cancelOutbox[0].changes!.limitPrice = 1;

    expect((await store.load()).cancelOutbox[0].changes)
      .toEqual({ quantity: 2, orderType: 'Limit', limitPrice: 29_500 });
  });

  it('odmítne stale snapshot místo přepsání novějšího stavu', async () => {
    const store = createMemoryCopierStore();
    const base = emptySnapshot();
    await store.commit(base, 0);
    await expect(store.commit(base, 0)).rejects.toBeInstanceOf(CopierStoreConflictError);
  });
});

describe('toSnapshot', () => {
  it('uloží stav i nevyřešené položky outboxu', () => {
    const entry = createOutboxEntry('cp:g1:e1:200', 'cpabc123', 'o1', request, 0);
    const snapshot = toSnapshot(createCopierState(['cp:g1:e0:200'], 3), [entry]);
    expect(snapshot).toMatchObject({ replicated: ['cp:g1:e0:200'], lastSequence: 3 });
    expect(snapshot.outbox[0].key).toBe('cp:g1:e1:200');
  });

  it('uloží vazby na follower objednávky', () => {
    const state = linkFollowerOrder(createCopierState(), 'o1', {
      key: 'cp:g1:e1:200',
      accountId: 200,
      brokerOrderId: 'mo-1',
      quantity: 1,
    });
    expect(toSnapshot(state, []).links).toEqual([
      ['o1', [{ key: 'cp:g1:e1:200', accountId: 200, brokerOrderId: 'mo-1', quantity: 1 }]],
    ]);
  });
});

describe('snapshotToState', () => {
  it('obnoví stav pro běh po restartu', () => {
    const state = snapshotToState({ revision: 0, replicated: ['a', 'b'], lastSequence: 7, outbox: [], cancelOutbox: [], links: [], leaderCumQty: [], followerFillTargets: [] });
    expect(state.replicated.has('a')).toBe(true);
    expect(state.lastSequence).toBe(7);
  });

  it('obnoví i vazby, bez kterých by nešlo rušit', () => {
    const state = snapshotToState({
      replicated: [],
      revision: 0,
      lastSequence: 0,
      outbox: [],
      cancelOutbox: [],
      links: [['o1', [{ key: 'cp:g1:e1:200', accountId: 200, brokerOrderId: 'mo-1', quantity: 1 }]]],
      leaderCumQty: [],
      followerFillTargets: [],
    });
    expect(state.links.get('o1')?.[0].brokerOrderId).toBe('mo-1');
  });
});
