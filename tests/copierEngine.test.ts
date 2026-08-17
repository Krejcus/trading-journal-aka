import { describe, expect, it } from 'vitest';
import {
  applyResolved,
  applyLeaderProgress,
  applyFollowerFillResolution,
  classifySequence,
  createCopierState,
  followerQuantity,
  planFlatten,
  planModify,
  planReconciliation,
  planReplication,
  type LeaderEvent,
} from '../services/copierEngine';
import { BROKER_TAG_MAX_LENGTH, brokerTag, stableHash } from '../services/copierKeys';
import type { CopyGroupConfig } from '../services/liveCopyTrading';

const group = (partial: Partial<CopyGroupConfig> = {}): CopyGroupConfig => ({
  id: 'g1',
  name: 'Skupina',
  enabled: true,
  leaderAccountId: 100,
  followers: [
    { accountId: 200, mode: 'on-submit', multiplier: 1 },
    { accountId: 300, mode: 'on-submit', multiplier: 2 },
  ],
  ...partial,
});

const event = (partial: Partial<LeaderEvent> = {}): LeaderEvent => ({
  id: 'e1',
  orderId: 'o1',
  kind: 'submitted',
  accountId: 100,
  symbol: 'MNQU6',
  side: 'Buy',
  quantity: 1,
  orderType: 'Market',
  sequence: 1,
  receivedAt: 0,
  ...partial,
});

describe('followerQuantity', () => {
  it('zaokrouhluje dolů, aby multiplier nikdy nezvětšil riziko', () => {
    expect(followerQuantity(1, 0.3)).toBe(0);
    expect(followerQuantity(3, 0.5)).toBe(1);
    expect(followerQuantity(2, 2)).toBe(4);
  });

  it('vrací nulu pro nesmyslné vstupy', () => {
    expect(followerQuantity(Number.NaN, 1)).toBe(0);
    expect(followerQuantity(1, Number.NaN)).toBe(0);
  });

  it('maxContracts řeže výsledek po multiplieru', () => {
    expect(followerQuantity(10, 2, 5)).toBe(5);
    expect(followerQuantity(2, 1, 5)).toBe(2);
    expect(followerQuantity(10, 0.5, 3)).toBe(3);
  });

  it('nesmyslný strop se ignoruje', () => {
    expect(followerQuantity(10, 1, 0)).toBe(10);
    expect(followerQuantity(10, 1, Number.NaN)).toBe(10);
  });
});

describe('brokerTag', () => {
  it('je deterministický', () => {
    expect(brokerTag('cp', 'g1', 'e1', 200)).toBe(brokerTag('cp', 'g1', 'e1', 200));
    // Snapshot chrání kompatibilitu tagů i po nahrazení řídicích bajtů
    // čitelnými unicode escape sekvencemi ve zdrojáku.
    expect(brokerTag('cp', 'g1', 'e1', 200)).toBe('cp17fs9vr0s93zok');
  });

  it('se vejde do limitu i pro dlouhá UUID', () => {
    const tag = brokerTag(
      'cp',
      '6f3c1f1e-8f2a-4a1b-9c3d-2b7e5a9d1c44',
      'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      1234567,
    );
    expect(tag.length).toBeLessThanOrEqual(BROKER_TAG_MAX_LENGTH);
  });

  it('rozlišuje účty i typy operace', () => {
    expect(brokerTag('cp', 'g1', 'e1', 200)).not.toBe(brokerTag('cp', 'g1', 'e1', 300));
    expect(brokerTag('cp', 'g1', 'e1', 200)).not.toBe(brokerTag('fl', 'g1', 'e1', 200));
  });

  it('stableHash je stabilní napříč voláními', () => {
    expect(stableHash('abc')).toBe(stableHash('abc'));
    expect(stableHash('abc')).not.toBe(stableHash('abd'));
  });
});

describe('classifySequence', () => {
  it('rozpozná očekávané pořadí', () => {
    expect(classifySequence(5, 4)).toBe('expected');
  });

  it('rozpozná duplicitu', () => {
    expect(classifySequence(4, 4)).toBe('duplicate');
  });

  it('rozpozná mezeru', () => {
    expect(classifySequence(7, 4)).toBe('gap');
  });

  it('rozpozná událost mimo pořadí', () => {
    expect(classifySequence(2, 4)).toBe('out-of-order');
  });
});

describe('planReplication', () => {
  it('vytvoří objednávku pro každého followera s vlastním multiplierem', () => {
    const plan = planReplication(event({ quantity: 2 }), group(), createCopierState());
    expect(plan.orders.map(order => [order.request.accountId, order.request.quantity]))
      .toEqual([[200, 2], [300, 4]]);
  });

  it('klíč replikace je deterministický a nezávislý na čase', () => {
    const first = planReplication(event(), group(), createCopierState());
    const second = planReplication(event(), group(), createCopierState());
    expect(first.orders.map(order => order.key)).toEqual(second.orders.map(order => order.key));
    expect(first.orders[0].key).toBe('cp:g1:e1:200');
  });

  it('podruhé už stejnou událost nereplikuje', () => {
    const state = createCopierState(['cp:g1:e1:200', 'cp:g1:e1:300']);
    const plan = planReplication(event(), group(), state);
    expect(plan.orders).toHaveLength(0);
    expect(plan.skipped.map(skip => skip.reason)).toEqual(['already-replicated', 'already-replicated']);
  });

  it('vypnutá skupina neposílá nic', () => {
    const plan = planReplication(event(), group({ enabled: false }), createCopierState());
    expect(plan.orders).toHaveLength(0);
    expect(plan.skipped.every(skip => skip.reason === 'group-disabled')).toBe(true);
  });

  it('ignoruje událost z jiného než leader účtu', () => {
    const plan = planReplication(event({ accountId: 999 }), group(), createCopierState());
    expect(plan.orders).toHaveLength(0);
    expect(plan.skipped.every(skip => skip.reason === 'not-leader-account')).toBe(true);
  });

  it('on-fill follower nereaguje na submitted', () => {
    const config = group({ followers: [{ accountId: 200, mode: 'on-fill', multiplier: 1 }] });
    expect(planReplication(event({ kind: 'submitted' }), config, createCopierState()).orders)
      .toHaveLength(0);
    expect(planReplication(event({ kind: 'filled' }), config, createCopierState()).orders)
      .toHaveLength(1);
  });

  it('follower shodný s leaderem se přeskočí', () => {
    const config = group({ followers: [{ accountId: 100, mode: 'on-submit', multiplier: 1 }] });
    const plan = planReplication(event(), config, createCopierState());
    expect(plan.skipped).toEqual([{ followerAccountId: 100, reason: 'follower-is-leader' }]);
  });

  it('nulové množství po zaokrouhlení neodešle objednávku', () => {
    const config = group({ followers: [{ accountId: 200, mode: 'on-submit', multiplier: 0.4 }] });
    const plan = planReplication(event({ quantity: 1 }), config, createCopierState());
    expect(plan.orders).toHaveLength(0);
    expect(plan.skipped).toEqual([{ followerAccountId: 200, reason: 'zero-quantity' }]);
  });

  it('přenese limitní a stop cenu', () => {
    const plan = planReplication(
      event({ orderType: 'Limit', limitPrice: 29_500, stopPrice: 29_400 }),
      group({ followers: [{ accountId: 200, mode: 'on-submit', multiplier: 1 }] }),
      createCopierState(),
    );
    expect(plan.orders[0].request).toMatchObject({
      orderType: 'Limit',
      limitPrice: 29_500,
      stopPrice: 29_400,
    });
  });

  it('maxContracts omezí vstupní objednávku', () => {
    const config = group({
      followers: [{ accountId: 200, mode: 'on-submit', multiplier: 2, maxContracts: 3 }],
    });
    const plan = planReplication(event({ quantity: 4 }), config, createCopierState());
    expect(plan.orders[0].request.quantity).toBe(3);
  });

  it('on-fill přestane replikovat po dosažení maxContracts cíle', () => {
    const config = group({
      followers: [{ accountId: 200, mode: 'on-fill', multiplier: 1, maxContracts: 2 }],
    });
    let state = createCopierState();
    const first = event({ id: 'f1', kind: 'filled', cumulativeQuantity: 2, quantity: 2 });
    expect(planReplication(first, config, state).orders[0].request.quantity).toBe(2);
    state = applyLeaderProgress(state, first, config);
    state = applyFollowerFillResolution(state, 'o1', 200, 2);
    // Leader pokračuje na 3 kontrakty, follower cíl je ustřižený na 2.
    const second = event({ id: 'f2', kind: 'filled', cumulativeQuantity: 3, quantity: 3, sequence: 2 });
    const plan = planReplication(second, config, state);
    expect(plan.orders).toHaveLength(0);
    expect(plan.skipped).toEqual([{ followerAccountId: 200, reason: 'zero-quantity' }]);
  });

  it('on-fill replikuje přírůstek kumulativního fillu bez dvojího započtení', () => {
    const config = group({ followers: [{ accountId: 200, mode: 'on-fill', multiplier: 0.5 }] });
    let state = createCopierState();
    const first = event({ id: 'f1', kind: 'filled', cumulativeQuantity: 1, quantity: 1 });
    expect(planReplication(first, config, state).orders).toHaveLength(0);
    state = applyLeaderProgress(state, first, config);
    const second = event({ id: 'f2', kind: 'filled', cumulativeQuantity: 2, quantity: 2, sequence: 2 });
    expect(planReplication(second, config, state).orders[0].request.quantity).toBe(1);
    state = applyLeaderProgress(state, second, config);
    state = applyFollowerFillResolution(state, 'o1', 200, 1);
    const third = event({ id: 'f3', kind: 'filled', cumulativeQuantity: 3, quantity: 3, sequence: 3 });
    expect(planReplication(third, config, state).orders).toHaveLength(0);
    state = applyLeaderProgress(state, third, config);
    const fourth = event({ id: 'f4', kind: 'filled', cumulativeQuantity: 4, quantity: 4, sequence: 4 });
    expect(planReplication(fourth, config, state).orders[0].request.quantity).toBe(1);
  });
});

describe('planModify', () => {
  it('přenese změnu množství a ceny na známou follower objednávku', () => {
    const state = createCopierState([], 1, [[
      'o1',
      [{ key: 'cp:g1:e1:200', accountId: 200, brokerOrderId: 'mo-1', quantity: 1 }],
    ]]);
    const commands = planModify(
      event({ id: 'e2', kind: 'replaced', quantity: 3, limitPrice: 29_600, sequence: 2 }),
      state,
      group({ followers: [{ accountId: 200, mode: 'on-submit', multiplier: 0.5 }] }),
    );
    expect(commands[0]).toMatchObject({ brokerOrderId: 'mo-1', quantity: 1, limitPrice: 29_600 });
  });
});

describe('applyResolved', () => {
  it('zapíše vyřízené klíče a posune sekvenci', () => {
    const next = applyResolved(createCopierState(), ['cp:g1:e1:200'], 7);
    expect(next.replicated.has('cp:g1:e1:200')).toBe(true);
    expect(next.lastSequence).toBe(7);
  });

  it('sekvenci nikdy nesnižuje', () => {
    expect(applyResolved(createCopierState([], 10), [], 3).lastSequence).toBe(10);
  });
});

describe('planReconciliation', () => {
  it('dopočítá rozdíl proti leaderovi', () => {
    const planned = planReconciliation(
      'g1',
      { accountId: 100, symbol: 'MNQU6', netQuantity: 3 },
      { accountId: 200, symbol: 'MNQU6', netQuantity: 1 },
      1,
      'r1',
    );
    expect(planned?.request).toMatchObject({ side: 'Buy', quantity: 2, accountId: 200 });
  });

  it('při shodě nevrací nic', () => {
    const planned = planReconciliation(
      'g1',
      { accountId: 100, symbol: 'MNQU6', netQuantity: 2 },
      { accountId: 200, symbol: 'MNQU6', netQuantity: 4 },
      2,
      'r1',
    );
    expect(planned).toBeNull();
  });

  it('přebytek na followerovi prodá', () => {
    const planned = planReconciliation(
      'g1',
      { accountId: 100, symbol: 'MNQU6', netQuantity: 1 },
      { accountId: 200, symbol: 'MNQU6', netQuantity: 3 },
      1,
      'r1',
    );
    expect(planned?.request).toMatchObject({ side: 'Sell', quantity: 2 });
  });
});

describe('planFlatten', () => {
  it('zavírá long prodejem a short nákupem', () => {
    expect(planFlatten('g1', { accountId: 200, symbol: 'MNQU6', netQuantity: 2 }, 'f1')?.request)
      .toMatchObject({ side: 'Sell', quantity: 2 });
    expect(planFlatten('g1', { accountId: 200, symbol: 'MNQU6', netQuantity: -3 }, 'f1')?.request)
      .toMatchObject({ side: 'Buy', quantity: 3 });
  });

  it('plochou pozici neřeší', () => {
    expect(planFlatten('g1', { accountId: 200, symbol: 'MNQU6', netQuantity: 0 }, 'f1')).toBeNull();
  });
});
