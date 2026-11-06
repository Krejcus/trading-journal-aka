import { describe, expect, it } from 'vitest';
import type { BrokerFill } from '../services/brokerPort';
import { createLeaderDisplayFills } from '../services/copierLeaderDisplayFills';

let n = 0;
const fill = (side: 'Buy' | 'Sell', quantity: number, price: number, patch: Partial<BrokerFill> = {}): BrokerFill => {
  n += 1;
  return { fillId: `f${n}`, tag: '', brokerOrderId: `o${n}`, accountId: 1, symbol: 'MNQZ6', side, quantity, price, filledAt: 1_000 + n, ...patch };
};

describe('plnění leadera pro šipky (jen zobrazení)', () => {
  it('vstup z flat a výstup: jedna epizoda fromFlat, role podle rozdělení kopírky', () => {
    const ring = createLeaderDisplayFills();
    ring.observe(fill('Buy', 2, 100), 0, 0);
    ring.observe(fill('Sell', 2, 110), 2, 2);
    expect(ring.snapshot()).toMatchObject({ symbol: 'MNQZ6', fromFlat: true, netAfter: 0,
      fills: [{ role: 'entry', side: 'Buy', quantity: 2 }, { role: 'exit', side: 'Sell', quantity: 2 }] });
  });

  it('dílčí plnění jednoho příkazu a přikoupení zůstávají v epizodě; duplicitní fillId se ignoruje', () => {
    const ring = createLeaderDisplayFills();
    const a = fill('Buy', 1, 100, { brokerOrderId: 'oA' });
    ring.observe(a, 0, 0);
    ring.observe(fill('Buy', 1, 100.25, { brokerOrderId: 'oA' }), 1, 0);
    ring.observe(a, 2, 0);
    ring.observe(fill('Buy', 2, 101), 2, 0);
    const snap = ring.snapshot()!;
    expect(snap.fills.map(f => f.quantity)).toEqual([1, 1, 2]);
    expect(snap.netAfter).toBe(4);
  });

  it('flip: výstup uzavře starou epizodu, nová začíná z flat jen vstupní částí', () => {
    const ring = createLeaderDisplayFills();
    ring.observe(fill('Buy', 1, 100), 0, 0);
    ring.observe(fill('Sell', 3, 99), 1, 1);
    expect(ring.snapshot()).toMatchObject({ fromFlat: true, netAfter: -2, fills: [{ role: 'entry', side: 'Sell', quantity: 2 }] });
  });

  it('neznámá pozice před fillem = gap (nehádá); start uprostřed obchodu není fromFlat', () => {
    const ring = createLeaderDisplayFills();
    ring.observe(fill('Buy', 1, 100), undefined, 0);
    expect(ring.snapshot()).toMatchObject({ gap: true, fromFlat: false });
    const mid = createLeaderDisplayFills();
    mid.observe(fill('Sell', 1, 100), 2, 1);
    expect(mid.snapshot()).toMatchObject({ fromFlat: false, netAfter: 1 });
  });

  it('strop řádků: oříznutá epizoda už není fromFlat; markGap a reset', () => {
    const ring = createLeaderDisplayFills(3);
    ring.observe(fill('Buy', 1, 100), 0, 0);
    for (let i = 1; i <= 3; i += 1) ring.observe(fill('Buy', 1, 100), i, 0);
    expect(ring.snapshot()).toMatchObject({ fromFlat: false });
    expect(ring.snapshot()!.fills).toHaveLength(3);
    ring.markGap();
    expect(ring.snapshot()!.gap).toBe(true);
    ring.reset();
    expect(ring.snapshot()).toBeNull();
  });

  it('Position před Fillem: vstup z flat s pozicí už po fillu = nová epizoda z flat; jiný nesoulad = mezera', () => {
    const ring = createLeaderDisplayFills();
    ring.observe(fill('Buy', 1, 100), 0, 0);
    ring.observe(fill('Sell', 1, 110), 1, 1);
    // Ledger ještě bez lotu → rozdělení kopírky vrátí pozici po fillu (+1), ne 0.
    ring.observe(fill('Buy', 1, 105), 1, 0);
    expect(ring.snapshot()).toMatchObject({ fromFlat: true, netAfter: 1, fills: [{ role: 'entry', price: 105 }] });
    expect(ring.snapshot()!.fills).toHaveLength(1);
    // Pozice před fillem nesedí s epizodou (+1 → hlášeno +3): nepřilepit, mezera.
    ring.observe(fill('Buy', 1, 106), 3, 0);
    expect(ring.snapshot()).toMatchObject({ gap: true });
    expect(ring.snapshot()!.fills).toHaveLength(1);
  });

  it('snapshot je kopie (status nesmí měnit vnitřní stav)', () => {
    const ring = createLeaderDisplayFills();
    ring.observe(fill('Buy', 1, 100), 0, 0);
    const snap = ring.snapshot()!;
    snap.fills[0].price = 1;
    expect(ring.snapshot()!.fills[0].price).toBe(100);
  });

  it('pozice před fillem 0 s redukující částí (Position=0 před Fillem) a neplatný čas = mezera, žádná šipka', () => {
    const ring = createLeaderDisplayFills();
    ring.observe(fill('Sell', 1, 100), 0, 1);
    expect(ring.snapshot()).toMatchObject({ gap: true, fills: [] });
    const timeless = createLeaderDisplayFills();
    timeless.observe(fill('Buy', 1, 100, { filledAt: Number.NaN }), 0, 0);
    expect(timeless.snapshot()).toMatchObject({ gap: true, fills: [] });
  });
});
