// Dokupování do pozice (3. 11. 2026, návrh v4): čistá logika modelu pozice, brány
// přikoupení, rizika, stavové podmínky čekajícího přikoupení a tvaru správy po pozici.
import { describe, expect, it } from 'vitest';
import {
  leaderPositionModel,
  pendingAddViolation,
  positionOverCovered,
  scaleInPositionLossPoints,
  positionManageBlockers,
  scaleInAddBlockers,
  scaleInEnabled,
  scaleInExistingRiskPoints,
  type ScaleInOrder,
  type ScaleInRecord,
} from '../services/manualScaleIn';

const LEADER = 61038658;
const SYM = 'MNQZ6';
const record = (id: string, patch: Partial<ScaleInRecord> = {}): ScaleInRecord => ({
  operationId: `entry:${id}`, status: 'acknowledged', createdAt: Number(id.replace(/\D/g, '')) || 1, accountId: LEADER, symbol: SYM,
  side: 'Buy', quantity: 1, orderType: 'Market', bare: false, entryId: `${id}e`, stopId: `${id}s`, targetId: `${id}t`, scaleIn: false, ...patch,
});
const order = (id: string, patch: Partial<ScaleInOrder>): ScaleInOrder => ({
  brokerOrderId: id, symbol: SYM, side: 'Sell', orderType: 'Stop', status: 'working', quantity: 1, filledQuantity: 0,
  sourceVersion: '2:Working', ...patch,
});
const legs = (id: string, stop = 27_936.5, target = 28_538.5, patch: Partial<ScaleInOrder> = {}) => [
  order(`${id}s`, { orderType: 'Stop', stopPrice: stop, ...patch }),
  order(`${id}t`, { orderType: 'Limit', limitPrice: target, ...patch }),
];
const model = (records: ScaleInRecord[], orders: ScaleInOrder[], net: number | null, filled: string[] = records.map(item => item.entryId!),
  avg: Record<string, number> = {}) => leaderPositionModel({
  symbol: SYM, leaderAccountId: LEADER, net, records,
  liveOrders: new Map(orders.map(item => [item.brokerOrderId, item])),
  observedStatus: id => (filled.includes(id) ? 'filled' : undefined),
  fills: id => {
    const owner = records.find(item => item.entryId === id);
    return owner && filled.includes(id) ? { quantity: owner.quantity, avg: avg[id] ?? 28_000 } : null;
  },
});
const intent = (m: ReturnType<typeof model>, quantity = Math.abs(m.net ?? 0)) => ({
  mode: 'add' as const, side: 'Buy' as const, quantity, ticketEntryIds: m.tickets.map(ticket => ticket.entryId),
});
const gate = (m: ReturnType<typeof model>, patch: Partial<Parameters<typeof scaleInAddBlockers>[0]> = {}) => scaleInAddBlockers({
  enabled: true,
  command: { symbol: SYM, side: 'Buy', quantity: 1, orderType: 'Market', stopLoss: 27_936.5, takeProfit: 28_538.5, position: intent(m) },
  model: m, otherSymbolExposure: false, lotNet: m.net, epochMatches: true, manageBusy: false, cap: 5, ...patch,
}).map(issue => issue.code);

describe('scale-in: zapnutí', () => {
  it('jen manual-only local-only DEMO bez followerů s opt-inem', () => {
    const group = { manualOnly: true, localOnly: true, followers: [] };
    expect(scaleInEnabled({ optIn: true, group, brokerEnvironment: 'demo' })).toBe(true);
    expect(scaleInEnabled({ optIn: false, group, brokerEnvironment: 'demo' })).toBe(false);
    expect(scaleInEnabled({ optIn: true, group, brokerEnvironment: 'live' })).toBe(false);
    expect(scaleInEnabled({ optIn: true, group: { ...group, followers: [{}] }, brokerEnvironment: 'demo' })).toBe(false);
    expect(scaleInEnabled({ optIn: true, group: { ...group, manualOnly: false }, brokerEnvironment: 'demo' })).toBe(false);
  });
});

describe('scale-in: model pozice', () => {
  it('dva vyplněné lístky = krytí 2/2, jedna cena SL i TP', () => {
    const m = model([record('a1'), record('a2', { scaleIn: true })], [...legs('a1'), ...legs('a2')], 2);
    expect(m).toMatchObject({ side: 'Buy', stopCovered: 2, targetCovered: 2, stopPrice: 27_936.5, targetPrice: 28_538.5,
      stopUniform: true, targetUniform: true, unconfirmedLegs: false, ownFilled: 2, foreignOrders: [], pendingAdds: [] });
    expect(m.tickets.map(ticket => ticket.operationId)).toEqual(['entry:a1', 'entry:a2']);
  });

  it('starý lístek bez živých nohou do pozice nepatří', () => {
    const m = model([record('a1'), record('a2')], legs('a2'), 1);
    expect(m.tickets.map(ticket => ticket.operationId)).toEqual(['entry:a2']);
  });

  it('syntetické nohy z ACK a Suspended nohy nejsou krytí (mutace: kdyby se počítaly, brána by pustila)', () => {
    const synthetic = model([record('a1')], legs('a1', 27_936.5, 28_538.5, { sourceVersion: 'manual-entry-ack' }), 1);
    expect(synthetic.unconfirmedLegs).toBe(true);
    expect(synthetic.stopCovered).toBe(0);
    expect(gate(synthetic)).toContain('scale-in-uncovered');
    const suspended = model([record('a1')], legs('a1', 27_936.5, 28_538.5, { status: 'pending' }), 1);
    expect(gate(suspended)).toContain('scale-in-uncovered');
  });

  it('čekající přikoupení: vstup otevřený, nohy Suspended; cizí příkaz se pozná', () => {
    const pendingEntry = order('a2e', { side: 'Buy', orderType: 'Limit', limitPrice: 28_027.5 });
    const foreign = order('x1', { side: 'Buy', orderType: 'Limit', limitPrice: 27_000 });
    const m = model([record('a1'), record('a2', { scaleIn: true, orderType: 'Limit' })],
      [...legs('a1'), pendingEntry, ...legs('a2', 27_936.5, 28_538.5, { status: 'pending' }), foreign], 1, ['a1e']);
    expect(m.pendingAdds.map(ticket => ticket.operationId)).toEqual(['entry:a2']);
    expect(m.foreignOrders.map(item => item.brokerOrderId)).toEqual(['x1']);
  });

  it('nejochrannější SL a nejbližší TP u short pozice', () => {
    const shortLegs = (id: string, stop: number, target: number) => [
      order(`${id}s`, { side: 'Buy', orderType: 'Stop', stopPrice: stop }), order(`${id}t`, { side: 'Buy', orderType: 'Limit', limitPrice: target }),
    ];
    const m = model([record('a1', { side: 'Sell' }), record('a2', { side: 'Sell' })], [...shortLegs('a1', 100, 50), ...shortLegs('a2', 90, 60)], -2);
    expect(m).toMatchObject({ side: 'Sell', stopPrice: 90, targetPrice: 60, stopUniform: false, targetUniform: false });
  });
});

describe('scale-in: brána přikoupení', () => {
  const base = () => model([record('a1')], legs('a1'), 1);

  it('čistá pozice projde', () => {
    expect(gate(base())).toEqual([]);
  });

  it('vypnuto / flat / opačná strana / neověřená pozice', () => {
    expect(gate(base(), { enabled: false })).toEqual(['scale-in-off']);
    expect(gate(model([record('a1')], legs('a1'), 0))).toEqual(['scale-in-flat']);
    expect(gate(model([record('a1')], legs('a1'), null))).toEqual(['scale-in-position-unverified']);
    const m = base();
    expect(gate(m, { command: { symbol: SYM, side: 'Sell', quantity: 1, orderType: 'Market', stopLoss: 27_936.5, takeProfit: 28_538.5, position: { ...intent(m), side: 'Sell' } } }))
      .toContain('scale-in-opposite');
  });

  it('záměr: jiný počet nebo jiné lístky = intent-position-changed (dvojklik, druhé zařízení)', () => {
    const m = base();
    expect(gate(m, { command: { symbol: SYM, side: 'Buy', quantity: 1, orderType: 'Market', stopLoss: 27_936.5, takeProfit: 28_538.5, position: intent(m, 2) } }))
      .toContain('intent-position-changed');
    const two = model([record('a1'), record('a2', { scaleIn: true })], [...legs('a1'), ...legs('a2')], 2);
    expect(gate(two, { command: { symbol: SYM, side: 'Buy', quantity: 1, orderType: 'Market', stopLoss: 27_936.5, takeProfit: 28_538.5, position: { ...intent(two), ticketEntryIds: ['a1e'] } } }))
      .toContain('intent-position-changed');
  });

  it('SL/TP přikoupení musí sedět se společným SL/TP; holé přikoupení ne', () => {
    const m = base();
    expect(gate(m, { command: { symbol: SYM, side: 'Buy', quantity: 1, orderType: 'Market', stopLoss: 27_900, takeProfit: 28_538.5, position: intent(m) } }))
      .toContain('scale-in-brackets-mismatch');
    expect(gate(m, { command: { symbol: SYM, side: 'Buy', quantity: 1, orderType: 'Market', position: intent(m) } })).toContain('scale-in-bare');
  });

  it('rozjeté nohy, cizí příkaz, jiný symbol, deník, epocha, běžící správa', () => {
    const diverged = model([record('a1'), record('a2')], [...legs('a1'), ...legs('a2', 27_900)], 2);
    expect(gate(diverged)).toContain('scale-in-legs-diverged');
    const foreign = model([record('a1')], [...legs('a1'), order('x1', { side: 'Buy', orderType: 'Limit', limitPrice: 1 })], 1);
    expect(gate(foreign)).toContain('scale-in-foreign-orders');
    expect(gate(base(), { otherSymbolExposure: true })).toContain('account-not-flat');
    expect(gate(base(), { lotNet: 2 })).toContain('scale-in-journal');
    expect(gate(base(), { lotNet: null })).toContain('scale-in-journal');
    expect(gate(base(), { epochMatches: false })).toContain('scale-in-epoch');
    expect(gate(base(), { manageBusy: true })).toContain('scale-in-manage-busy');
  });

  it('pozice s kontrakty mimo lístky (např. přikoupeno v Tradovate) = blokace', () => {
    expect(gate(model([record('a1')], legs('a1'), 2))).toContain('scale-in-foreign-position');
  });

  it('strop na celou pozici: |net| + čekající + nové ≤ strop', () => {
    const three = model([record('a1', { quantity: 3 })], legs('a1', 27_936.5, 28_538.5, { quantity: 3 }), 3);
    expect(gate(three, { command: { symbol: SYM, side: 'Buy', quantity: 2, orderType: 'Market', stopLoss: 27_936.5, takeProfit: 28_538.5, position: intent(three) } })).toEqual([]);
    expect(gate(three, { command: { symbol: SYM, side: 'Buy', quantity: 3, orderType: 'Market', stopLoss: 27_936.5, takeProfit: 28_538.5, position: intent(three) } }))
      .toEqual(['manual-cap']);
  });

  it('čekající přikoupení blokuje další (jeden příkaz najednou)', () => {
    const pendingEntry = order('a2e', { side: 'Buy', orderType: 'Limit', limitPrice: 28_027.5 });
    const m = model([record('a1'), record('a2', { scaleIn: true, orderType: 'Limit' })],
      [...legs('a1'), pendingEntry, ...legs('a2', 27_936.5, 28_538.5, { status: 'pending' })], 1, ['a1e']);
    expect(gate(m)).toContain('scale-in-pending');
  });
});

describe('scale-in: riziko stávající pozice', () => {
  it('SL za BE = 0, jinak vzdálenost × qty (long i short)', () => {
    expect(scaleInExistingRiskPoints({ side: 'Buy', avgPrice: 100, stopLoss: 90, quantity: 2 })).toBe(20);
    expect(scaleInExistingRiskPoints({ side: 'Buy', avgPrice: 100, stopLoss: 110, quantity: 2 })).toBe(0);
    expect(scaleInExistingRiskPoints({ side: 'Sell', avgPrice: 100, stopLoss: 110, quantity: 1 })).toBe(10);
    expect(scaleInExistingRiskPoints({ side: 'Sell', avgPrice: 100, stopLoss: 95, quantity: 1 })).toBe(0);
  });
});

describe('scale-in: stavová podmínka čekajícího přikoupení', () => {
  const ok = {
    armed: true, shadowMode: false, killSwitch: false, dayLockPending: false, dayLocked: false, pauseActive: false, managementOnly: false,
    leaderIneligible: false, windowNow: 'off' as const, windowAfterReserve: 'off' as const, now: 1_000_000, sessionEndAt: 10_000_000,
    armExpiresAt: null, reserveMs: 300_000, net: 1, side: 'Buy' as const, episodeMismatch: false,
  };
  it('vše platí = nic', () => expect(pendingAddViolation(ok)).toBeNull());
  it('každá tvrdá podmínka zruší', () => {
    expect(pendingAddViolation({ ...ok, armed: false })).toBe('kopírka je vypnutá');
    expect(pendingAddViolation({ ...ok, killSwitch: true })).toBe('kill switch');
    expect(pendingAddViolation({ ...ok, dayLockPending: true })).toBe('denní zámek');
    expect(pendingAddViolation({ ...ok, pauseActive: true })).toBe('pauza pravidlem dne');
    expect(pendingAddViolation({ ...ok, managementOnly: true })).toBe('kopírka jen spravuje');
    expect(pendingAddViolation({ ...ok, leaderIneligible: true })).toBe('leader nesmí nové vstupy');
    expect(pendingAddViolation({ ...ok, windowNow: 'inside', windowAfterReserve: 'outside' })).toBe('konec obchodního okna');
    expect(pendingAddViolation({ ...ok, sessionEndAt: ok.now + 60_000 })).toBe('konec broker session (17:00 CT)');
    expect(pendingAddViolation({ ...ok, armExpiresAt: ok.now + 60_000 })).toBe('vyprší zapnutí kopírky');
    expect(pendingAddViolation({ ...ok, net: 0 })).toBe('pozice je zavřená');
    expect(pendingAddViolation({ ...ok, net: -1 })).toBe('pozice je na druhé straně');
    expect(pendingAddViolation({ ...ok, episodeMismatch: true })).toBe('přikoupení otevřelo nový obchod');
  });
  it('neznámá pozice (chybějící cache) není flat — nic se neruší', () => {
    expect(pendingAddViolation({ ...ok, net: null })).toBeNull();
  });
});

describe('scale-in: správa po pozici', () => {
  const two = () => model([record('a1'), record('a2', { scaleIn: true })], [...legs('a1'), ...legs('a2')], 2);
  const blockers = (m: ReturnType<typeof model>, action: 'move-stop' | 'move-target' | 'close-position', price: number, quantity = 2, unresolvedEntry = false) =>
    positionManageBlockers({ action, model: m, expect: { price, quantity }, unresolvedEntry }).map(issue => issue.code);

  it('čistá pozice: posun SL i TP i zavření', () => {
    expect(blockers(two(), 'move-stop', 27_936.5)).toEqual([]);
    expect(blockers(two(), 'move-target', 28_538.5)).toEqual([]);
    expect(blockers(two(), 'close-position', 27_936.5)).toEqual([]);
  });

  it('čekající přikoupení: posun ne, zavření ano', () => {
    const pendingEntry = order('a3e', { side: 'Buy', orderType: 'Limit', limitPrice: 28_027.5 });
    const m = model([record('a1'), record('a2', { scaleIn: true }), record('a3', { scaleIn: true, orderType: 'Limit' })],
      [...legs('a1'), ...legs('a2'), pendingEntry, ...legs('a3', 27_936.5, 28_538.5, { status: 'pending' })], 2, ['a1e', 'a2e']);
    expect(blockers(m, 'move-stop', 27_936.5)).toContain('scale-in-pending');
    expect(blockers(m, 'close-position', 27_936.5)).toEqual([]);
  });

  it('nevyřešený vstup: posun ne; jiný počet / cena = order-changed; nekrytá pozice = shape', () => {
    expect(blockers(two(), 'move-stop', 27_936.5, 2, true)).toContain('manual-entry-unresolved');
    expect(blockers(two(), 'move-stop', 27_936.5, 1)).toContain('order-changed');
    expect(blockers(two(), 'move-stop', 27_900)).toContain('order-changed');
    const uncovered = model([record('a1'), record('a2', { scaleIn: true })], [...legs('a1'), order('a2s', { orderType: 'Stop', stopPrice: 27_936.5 })], 2);
    expect(blockers(uncovered, 'move-stop', 27_936.5)).toContain('shape');
  });
});

describe('scale-in: oprava po oponentuře v4 (P1-2, P1-3, P1-6, P2-6, P2-8)', () => {
  it('riziko po lístcích z VWAP: zamčený zisk základu nesnižuje riziko přikoupení (P1-2)', () => {
    // Základ 1 @100 se SL 105 (za BE), přikoupení 1 @110: riziko jen přikoupení 5 b — ne 0 ze smíšeného průměru 105.
    const m = model([record('a1'), record('a2', { scaleIn: true })], [...legs('a1', 105, 200), ...legs('a2', 105, 200)], 2,
      ['a1e', 'a2e'], { a1e: 100, a2e: 110 });
    expect(scaleInPositionLossPoints(m, 105)).toBe(5);
    expect(scaleInPositionLossPoints(m, 90)).toBe(10 + 20);
  });

  it('neznámý VWAP lístku (po restartu) = riziko nejde spočítat', () => {
    const m = leaderPositionModel({ symbol: SYM, leaderAccountId: LEADER, net: 1, records: [record('a1')],
      liveOrders: new Map(legs('a1').map(item => [item.brokerOrderId, item])), observedStatus: () => 'filled', fills: () => null });
    expect(m.tickets[0].entry).toBe('unknown');
    expect(scaleInPositionLossPoints(m, 27_900)).toBeNull();
    expect(gate(m)).toContain('scale-in-entry-open');
  });

  it('„Filled“ se zbytkem zrušeným (cumQty < qty) není plně vyplněný vstup (P1-3)', () => {
    const m = leaderPositionModel({ symbol: SYM, leaderAccountId: LEADER, net: 1, records: [record('a1', { quantity: 2 })],
      liveOrders: new Map(legs('a1').map(item => [item.brokerOrderId, item])), observedStatus: () => 'filled',
      fills: () => ({ quantity: 1, avg: 28_000 }) });
    expect(m.tickets[0]).toMatchObject({ entry: 'unknown', entryFilled: 1 });
  });

  it('čekající Limit/Stop přikoupení jen po 1 kontraktu, Market i víc (P1-3 var. A)', () => {
    const m = model([record('a1')], legs('a1'), 1);
    const command = (orderType: string, quantity: number) => ({ symbol: SYM, side: 'Buy' as const, quantity, orderType, stopLoss: 27_936.5, takeProfit: 28_538.5, position: intent(m) });
    expect(gate(m, { command: command('Limit', 2) })).toContain('scale-in-limit-qty');
    expect(gate(m, { command: command('Stop', 2) })).toContain('scale-in-limit-qty');
    expect(gate(m, { command: command('Limit', 1) })).toEqual([]);
    expect(gate(m, { command: command('Market', 3) })).toEqual([]);
  });

  it('noha s dílčím fillem: přikoupení i posun blokované, zavření ne (P1-6)', () => {
    const partial = [order('a1s', { orderType: 'Stop', stopPrice: 27_936.5, quantity: 3 }), order('a1t', { orderType: 'Limit', limitPrice: 28_538.5, quantity: 3, filledQuantity: 1 })];
    const m = model([record('a1', { quantity: 3 })], partial, 2);
    expect(m.legsPartiallyFilled).toBe(true);
    expect(gate(m)).toContain('scale-in-uncovered');
    expect(positionManageBlockers({ action: 'move-stop', model: m, expect: { price: 27_936.5, quantity: 2 }, unresolvedEntry: false }).map(issue => issue.code)).toContain('shape');
    expect(positionManageBlockers({ action: 'close-position', model: m, expect: { price: 27_936.5, quantity: 2 }, unresolvedEntry: false })).toEqual([]);
  });

  it('rozjeté ceny: běžný posun blokovaný, žádné tiché sjednocení (P2-6)', () => {
    const m = model([record('a1'), record('a2')], [...legs('a1'), ...legs('a2', 27_900)], 2);
    expect(positionManageBlockers({ action: 'move-stop', model: m, expect: { price: 27_936.5, quantity: 2 }, unresolvedEntry: false }).map(issue => issue.code)).toContain('legs-diverged');
  });

  it('nadkrytí: nohy na víc kontraktů, než je pozice (P2-8)', () => {
    expect(positionOverCovered(model([record('a1'), record('a2')], [...legs('a1'), ...legs('a2')], 1))).toBe(true);
    expect(positionOverCovered(model([record('a1'), record('a2')], [...legs('a1'), ...legs('a2')], 2))).toBe(false);
  });
});

describe('scale-in: oprava po oponentuře diffu (P1-A, P2-3)', () => {
  it('Suspended nohy nevyplněného čekajícího přikoupení nejsou nadkrytí (P1-A)', () => {
    const pendingEntry = order('a3e', { side: 'Buy', orderType: 'Limit', limitPrice: 28_027.5 });
    const m = model([record('a1'), record('a2', { scaleIn: true }), record('a3', { scaleIn: true, orderType: 'Limit' })],
      [...legs('a1'), ...legs('a2'), pendingEntry, ...legs('a3', 27_936.5, 28_538.5, { status: 'pending' })], 2, ['a1e', 'a2e']);
    expect(m).toMatchObject({ stopOpenQuantity: 2, targetOpenQuantity: 2 });
    expect(positionOverCovered(m)).toBe(false);
    expect(m.tickets.find(ticket => ticket.operationId === 'entry:a3')?.entryPrice).toBe(28_027.5);
  });

  it('čekající Limit z flat (net 0, nohy Suspended) není nadkrytí (P1-A)', () => {
    const pendingEntry = order('a1e', { side: 'Buy', orderType: 'Limit', limitPrice: 28_000 });
    const m = model([record('a1', { orderType: 'Limit' })], [pendingEntry, ...legs('a1', 27_900, 28_500, { status: 'pending' })], 0, []);
    expect(positionOverCovered(m)).toBe(false);
  });

  it('dílčí TP fill: otevřená expozice lístku = fill vstupu − fill nohou', () => {
    const partial = [order('a1s', { orderType: 'Stop', stopPrice: 27_936.5, quantity: 3 }), order('a1t', { orderType: 'Limit', limitPrice: 28_538.5, quantity: 3, filledQuantity: 1 })];
    expect(model([record('a1', { quantity: 3 })], partial, 2)).toMatchObject({ ownOpen: 2, ownFilled: 3 });
  });

  it('zavření celé pozice s kontrakty mimo lístky = jen Flatten (P2-3)', () => {
    const m = model([record('a1'), record('a2', { scaleIn: true })], [...legs('a1'), ...legs('a2')], 3);
    expect(positionManageBlockers({ action: 'close-position', model: m, expect: { price: 27_936.5, quantity: 3 }, unresolvedEntry: false }).map(issue => issue.code)).toContain('shape');
  });
});

describe('rezerva s otevřenou pozicí bez otevřeného P&L (oponentura v4 P1-1, diff P2-4)', () => {
  it('otevřený zisk nesmaže realizovanou ztrátu; DD z equity bez otevřeného P&L', async () => {
    const { realizedLossHeadroom, remainingLossHeadroom } = await import('../services/manualEntryPreview');
    const risk = { verifiedAt: 1, sameSession: true, error: null, realizedPnlUsd: -200, openPnlUsd: 160, netLiq: 49_960, cashBalanceUsd: 49_800,
      minNetLiq: 49_500, dailyLossAutoLiq: null, effectiveDailyLossCutUsd: null };
    // Scénář oponentury: strop 250, realizováno −200, otevřeno +160 → správně zbývá 50 (stará rezerva 210).
    expect(remainingLossHeadroom(risk, 250).cutUsd).toBe(210);
    expect(realizedLossHeadroom(risk, 250).cutUsd).toBe(50);
    // DD: equity bez otevřeného P&L = 49 960 − 160 = 49 800 → 300 nad floorem (ne 460).
    expect(realizedLossHeadroom(risk, 250).drawdownUsd).toBe(300);
    // Otevřená ztráta se nepočítá dvakrát (riziko pozice ke SL se přičte zvlášť).
    expect(realizedLossHeadroom({ ...risk, openPnlUsd: -100, netLiq: 49_700 }, 250).cutUsd).toBe(50);
  });
});

describe('scale-in: doplněné testy po nezávislé kontrole (3. 11.)', () => {
  it('long s rozjetými nohami: SL = nejvyšší (nejochrannější), TP = nejnižší (nejbližší)', () => {
    const m = model([record('a1'), record('a2')], [...legs('a1', 27_900, 28_600), ...legs('a2', 27_950, 28_500)], 2);
    expect(m).toMatchObject({ stopPrice: 27_950, targetPrice: 28_500, stopUniform: false, targetUniform: false });
  });

  it('short pozice: brána, správa, riziko i stavová podmínka', () => {
    const shortLegs = (id: string, stop = 28_100, target = 27_800) => [
      order(`${id}s`, { side: 'Buy', orderType: 'Stop', stopPrice: stop }), order(`${id}t`, { side: 'Buy', orderType: 'Limit', limitPrice: target }),
    ];
    const m = model([record('a1', { side: 'Sell' })], shortLegs('a1'), -1, ['a1e'], { a1e: 28_000 });
    const shortIntent = { mode: 'add' as const, side: 'Sell' as const, quantity: 1, ticketEntryIds: ['a1e'] };
    expect(scaleInAddBlockers({ enabled: true, command: { symbol: SYM, side: 'Sell', quantity: 1, orderType: 'Market', stopLoss: 28_100, takeProfit: 27_800, position: shortIntent },
      model: m, otherSymbolExposure: false, lotNet: -1, epochMatches: true, manageBusy: false, cap: 5 })).toEqual([]);
    expect(scaleInAddBlockers({ enabled: true, command: { symbol: SYM, side: 'Buy', quantity: 1, orderType: 'Market', stopLoss: 28_100, takeProfit: 27_800, position: { ...shortIntent, side: 'Buy' } },
      model: m, otherSymbolExposure: false, lotNet: -1, epochMatches: true, manageBusy: false, cap: 5 }).map(issue => issue.code)).toContain('scale-in-opposite');
    expect(positionManageBlockers({ action: 'move-stop', model: m, expect: { price: 28_100, quantity: 1 }, unresolvedEntry: false })).toEqual([]);
    expect(scaleInPositionLossPoints(m, 28_100)).toBe(100);
    expect(scaleInPositionLossPoints(m, 27_950)).toBe(0);
    const ok = { armed: true, shadowMode: false, killSwitch: false, dayLockPending: false, dayLocked: false, pauseActive: false, managementOnly: false,
      leaderIneligible: false, windowNow: 'off' as const, windowAfterReserve: 'off' as const, now: 1, sessionEndAt: 10_000_000, armExpiresAt: null,
      reserveMs: 300_000, net: -1, side: 'Sell' as const, episodeMismatch: false };
    expect(pendingAddViolation(ok)).toBeNull();
    expect(pendingAddViolation({ ...ok, net: 1 })).toBe('pozice je na druhé straně');
  });

  it('filtry lístků: holý Market, jiný symbol, jiný účet, nepřijatý záznam do pozice nepatří', () => {
    const records = [
      record('b1', { bare: true }), record('b2', { symbol: 'MNQH7' }), record('b3', { accountId: 1 }), record('b4', { status: 'unknown' }),
      record('b5', { entryId: undefined }),
    ];
    const orders = records.flatMap(item => legs(item.operationId.slice('entry:'.length)));
    const m = model(records, orders, 1);
    expect(m.tickets).toEqual([]);
    // Nohy cizích lístků jsou pro tuto pozici „cizí příkazy“ (b2 má jiný symbol jen v záznamu).
    expect(m.foreignOrders.length).toBeGreaterThan(0);
  });

  it('nadkrytí po restartu: neznámý fill vyplněného vstupu se počítá qty lístku (fail-safe)', () => {
    const m = leaderPositionModel({ symbol: SYM, leaderAccountId: LEADER, net: 1, records: [record('a1'), record('a2')],
      liveOrders: new Map([...legs('a1'), ...legs('a2')].map(item => [item.brokerOrderId, item])), observedStatus: () => 'filled', fills: () => null });
    expect(positionOverCovered(m)).toBe(true);
    const ok = leaderPositionModel({ symbol: SYM, leaderAccountId: LEADER, net: 2, records: [record('a1'), record('a2')],
      liveOrders: new Map([...legs('a1'), ...legs('a2')].map(item => [item.brokerOrderId, item])), observedStatus: () => 'filled', fills: () => null });
    expect(positionOverCovered(ok)).toBe(false);
  });

  it('ořez záznamů nikdy neodstraní chráněný (živý lístek / nevyřešený) záznam (P2-7)', async () => {
    const { trimManualEntryRecords } = await import('../services/manualScaleIn');
    const records = Array.from({ length: 55 }, (_, index) => ({ id: index, live: index === 0 || index === 3 }));
    const kept = trimManualEntryRecords(records, 50, item => item.live);
    expect(kept).toHaveLength(50);
    expect(kept.map(item => item.id)).toEqual(expect.arrayContaining([0, 3]));
    expect(kept.some(item => item.id === 1)).toBe(false);
    // Chráněných víc než strop: nic chráněného nezmizí ani za cenu delšího seznamu.
    expect(trimManualEntryRecords(records.map(item => ({ ...item, live: true })), 50, item => item.live)).toHaveLength(55);
  });
});

describe('hlídání nadkrytí: incident jen za zapnuté kopírky (Filip 3. 11., oponentura kola 3)', () => {
  it('za ARMED po ustálení incident jednou; za DISARMED upozornění; přechod nic nevyhlásí', async () => {
    const { overCoverStep } = await import('../services/manualScaleIn');
    const base = { overCovered: true, transient: false, armed: true, now: 0, settleMs: 5_000 };
    expect(overCoverStep(undefined, base)).toEqual({ next: 0, action: 'none' });
    expect(overCoverStep(0, { ...base, now: 5_000 })).toEqual({ next: 'incident', action: 'incident' });
    expect(overCoverStep('incident', { ...base, now: 9_000 })).toEqual({ next: 'incident', action: 'none' });
    expect(overCoverStep(0, { ...base, now: 5_000, armed: false })).toEqual({ next: 'warned', action: 'warn' });
    expect(overCoverStep('warned', { ...base, now: 9_000, armed: false })).toEqual({ next: 'warned', action: 'none' });
    expect(overCoverStep(0, { ...base, now: 5_000, transient: true })).toEqual({ next: undefined, action: 'none' });
    expect(overCoverStep('incident', { ...base, transient: true })).toEqual({ next: 'incident', action: 'none' });
    expect(overCoverStep('incident', { ...base, overCovered: false })).toEqual({ next: undefined, action: 'none' });
  });

  it('nadkrytí z DISARMED přetrvá do ARMED (automatické pokračování) → incident hned, upozornění ho neschová', async () => {
    const { overCoverStep } = await import('../services/manualScaleIn');
    const base = { overCovered: true, transient: false, armed: true, now: 20_000, settleMs: 5_000 };
    expect(overCoverStep('warned', base)).toEqual({ next: 'incident', action: 'incident' });
    // Během rozpracovaných eventů počká na klid, ale stav `warned` nezahodí.
    expect(overCoverStep('warned', { ...base, transient: true })).toEqual({ next: 'warned', action: 'none' });
  });
});
