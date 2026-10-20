import { describe, expect, it } from 'vitest';
import { buildTradeCard, feeRateKey, tradeCardFeeRates, type TradeCardRowInput } from '../lib/liveTradeCard';
import { devLiveCopyFixtureSnapshot } from '../lib/devLiveCopyFixture';
import type { LiveAccount, LiveOrder } from '../services/tradecopiaLiveService';
import type { TradovateAccountDataAccount } from '../lib/tradovateAccountDataTypes';

const now = Date.now();
const at = new Date(now).toISOString();

// MNQ = $2 za bod. Leader vstup 21 482,25, follower o tick hůř.
const account = (id: number, quantity: number, entry: number, openPnl: number, patch: Partial<LiveAccount> = {}): LiveAccount => ({
  ...devLiveCopyFixtureSnapshot.accounts[0], id, name: `ACC${id}`,
  unrealizedPnl: openPnl, unrealizedPnlSource: 'broker', unrealizedPnlUpdatedAt: at,
  positionsAvailability: 'available', ordersAvailability: 'available', positionsUpdatedAt: at, ordersUpdatedAt: at,
  positions: quantity === 0 ? [] : [{ accountId: id, symbol: 'MNQZ6', netPosition: quantity, netPrice: entry, unrealizedPnl: openPnl, realizedPnl: 0, updatedAt: at }],
  ...patch,
});
let nextId = 1;
const order = (accountId: number, patch: Partial<LiveOrder>): LiveOrder => ({
  id: nextId++, accountId, accountName: '', symbol: 'MNQZ6', action: 'Sell', orderType: 'Stop', quantity: 2,
  price: null, stopPrice: null, status: 'Working', working: true, placedAt: at, updatedAt: at, ...patch,
});
const bracket = (accountId: number, stop: number, target: number, quantity = 2, status = 'Working', action = 'Sell') => [
  order(accountId, { orderType: 'Stop', stopPrice: stop, quantity, status, working: status === 'Working', action }),
  order(accountId, { orderType: 'Limit', price: target, quantity, status, working: status === 'Working', action }),
];
const row = (a: LiveAccount, isLeader = false): TradeCardRowInput => ({ account: a, accountId: a.id, name: a.name, isLeader });
const rates = (ids: number[], perSide = 0.52) => new Map(ids.map(id => [feeRateKey(id, 'MNQZ6'), perSide]));

describe('karta obchodu', () => {
  it('počítá každý účet s vlastním vstupem a skupinu po poplatcích', () => {
    const leader = account(1, 2, 21482.25, 49);
    const follower = account(2, 2, 21482.5, 48);
    const card = buildTradeCard([row(leader, true), row(follower)],
      [...bracket(1, 21462.25, 21522.25), ...bracket(2, 21462.25, 21522.25)], rates([1, 2]), now)!;
    expect(card.kind).toBe('position');
    expect(card.quantity).toBe(4);
    // SL: leader −20 b × 2 × $2 = −80, follower −20,25 b = −81; poplatky 2 × 2 × 0,52 = 2,08 na účet.
    expect(card.accounts[0].stop.usd).toBeCloseTo(-82.08);
    expect(card.accounts[1].stop.usd).toBeCloseTo(-83.08);
    expect(card.stop.usd).toBeCloseTo(-165.16);
    expect(card.target.usd).toBeCloseTo(160 + 159 - 4.16);
    expect(card.openPnl).toBeCloseTo(97 - 4.16);
    expect(card.feesIncluded).toBe(true);
    expect(card.stopCovered).toBe(2);
    // Cena z hrubého P&L: (cena − 21 482,375) × 4 × 2 = 97.
    expect(card.mark).toBeCloseTo(21482.375 + 97 / 8);
  });

  it('bez poplatku u jednoho účtu ukáže všechno hrubě, ne směs', () => {
    const card = buildTradeCard([row(account(1, 2, 21482.25, 0), true), row(account(2, 2, 21482.25, 0))],
      [...bracket(1, 21462.25, 21522.25), ...bracket(2, 21462.25, 21522.25)], rates([1]), now)!;
    expect(card.feesIncluded).toBe(false);
    expect(card.stop.usd).toBe(-160);
  });

  it('SL v plusu po posunu je kladný', () => {
    const card = buildTradeCard([row(account(1, 2, 21482.25, 0), true)], bracket(1, 21492.25, 21522.25), new Map(), now)!;
    expect(card.stop.usd).toBe(40);
    expect(card.stop.points).toBe(10);
  });

  it('short počítá opačně', () => {
    const card = buildTradeCard([row(account(1, -2, 21500, 0), true)], bracket(1, 21510, 21480, 2, 'Working', 'Buy'), new Map(), now)!;
    expect(card.direction).toBe(-1);
    expect(card.stop.usd).toBe(-40);
    expect(card.target.usd).toBe(80);
  });

  it('neúplná ochrana nedá součet skupiny a ukáže krytí', () => {
    const leader = account(1, 2, 21482.25, 0);
    const follower = account(2, 2, 21482.25, 0);
    const card = buildTradeCard([row(leader, true), row(follower)],
      [...bracket(1, 21462.25, 21522.25), order(2, { orderType: 'Limit', price: 21522.25 })], new Map(), now)!;
    expect(card.stop.usd).toBeNull();
    expect(card.stopCovered).toBe(1);
    expect(card.targetCovered).toBe(2);
  });

  it('otevřená pozice nebere Suspended nohu jako ochranu', () => {
    const card = buildTradeCard([row(account(1, 2, 21482.25, 0), true)], bracket(1, 21462.25, 21522.25, 2, 'Suspended'), new Map(), now)!;
    expect(card.stopCovered).toBe(0);
    expect(card.stop.usd).toBeNull();
  });

  it('neověřené čtení nedá čísla (INV-UI)', () => {
    const stale = new Date(now - 10 * 60_000).toISOString();
    const card = buildTradeCard([row(account(1, 2, 21482.25, 30, { ordersUpdatedAt: stale, positionsUpdatedAt: stale }), true)],
      bracket(1, 21462.25, 21522.25), new Map(), now)!;
    expect(card.verified).toBe(false);
    expect(card.stop.usd).toBeNull();
    expect(card.openPnl).toBeNull();
  });

  it('rozjetý směr mezi účty kartu neukáže', () => {
    expect(buildTradeCard([row(account(1, 2, 21482.25, 0), true), row(account(2, -2, 21482.25, 0))], [], new Map(), now)).toBeNull();
  });

  it('čekající limit počítá SL/TP ze Suspended bracketu', () => {
    const leader = account(1, 0, 0, 0);
    const follower = account(2, 0, 0, 0);
    const card = buildTradeCard([row(leader, true), row(follower)], [
      order(1, { action: 'Buy', orderType: 'Limit', price: 21470, quantity: 2 }),
      ...bracket(1, 21450, 21510, 2, 'Suspended'),
      order(2, { action: 'Buy', orderType: 'Limit', price: 21470, quantity: 2 }),
      ...bracket(2, 21450, 21510, 2, 'Suspended'),
    ], new Map(), now)!;
    expect(card.kind).toBe('pending');
    expect(card.entryType).toBe('Limit');
    expect(card.quantity).toBe(4);
    expect(card.stop.usd).toBe(-160);
    expect(card.target.usd).toBe(320);
    expect(card.stopCovered).toBe(2);
    expect(card.openPnl).toBeNull();
  });

  it('bez pozice a bez čekajícího vstupu leadera karta není', () => {
    expect(buildTradeCard([row(account(1, 0, 0, 0), true)], [], new Map(), now)).toBeNull();
  });
});

describe('sazba poplatků z fillů', () => {
  it('bere poplatek na kontrakt a stranu podle kořene kontraktu', () => {
    const fill = (id: number, symbol: string, quantity: number, total: number) => ({
      id, orderId: id, contractId: 1, symbol, timestamp: new Date(now - id * 1000).toISOString(), tradeDate: null,
      action: 'Buy' as const, quantity, price: 1, active: null, finallyPaired: null,
      fees: { clearing: 0, exchange: 0, nfa: 0, brokerage: 0, ip: 0, commission: total, orderRouting: 0, total },
    });
    const data = [{ id: 7, fills: [fill(1, 'MNQZ6', 2, 1.04), fill(2, 'MNQU6', 4, 2.08), fill(3, 'NQZ6', 1, 2.5)] }] as unknown as TradovateAccountDataAccount[];
    const result = tradeCardFeeRates(data);
    expect(result.get(feeRateKey(7, 'MNQZ6'))).toBeCloseTo(0.52);
    expect(result.get(feeRateKey(7, 'NQH7'))).toBeCloseTo(2.5);
    expect(result.has(feeRateKey(8, 'MNQZ6'))).toBe(false);
  });
});
