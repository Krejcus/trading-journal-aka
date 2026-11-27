import { describe, expect, it } from 'vitest';
import { OrderFlowLink } from '../lib/orderFlowLink';
import { mergeCells, OrderFlowStore, parseOrderFlowCapability } from '../lib/orderFlowStore';
import { orderFlowBubbleRadius, orderFlowSizeLabel, selectOrderFlowBubbles } from '../services/orderFlowBubbles';
import { autoRowTicks, buildOrderFlowProfile, orderFlowProfileSegments, valueAreaBounds, zoneHour } from '../services/orderFlowProfile';

const M0 = Date.UTC(2026, 10, 27, 14, 30, 0) / 1000;
const snapshot = (extra: Record<string, unknown> = {}) => ({
  type: 'of-snapshot', sub: 1, source: 'NQ', symbol: 'NQZ6', part: 0, last: true, reset: true, tickSize: 0.25, floor: 5, from: M0 - 86_400,
  minutes: [[M0, [100000, 9, 1, 0, 100004, 0, 3, 0]]], trades: [['A', M0 * 1000 + 1_000, 1, 9, 2, 100000, 100000, 100000]],
  coverage: [[M0, M0 + 60]], liveSince: M0 * 1000 - 120_000, ...extra,
});

describe('OrderFlowStore', () => {
  it('přijme snímek, změny buněk s celkovými hodnotami a opravu obchodu se stejným id', () => {
    const store = new OrderFlowStore();
    let changes = 0;
    store.subscribe(() => { changes += 1; });
    expect(store.apply(snapshot())).toBe(true);
    expect(store.complete).toBe(true);
    expect([...store.minuteCells(M0)!]).toEqual([100000, 9, 1, 0, 100004, 0, 3, 0]);
    store.apply({ type: 'of', sub: 1, seq: 1, cells: [[M0, [100002, 4, 0, 0, 100000, 12, 1, 0]], [M0 + 60, [100001, 1, 0, 0]]] });
    expect([...store.minuteCells(M0)!]).toEqual([100000, 12, 1, 0, 100002, 4, 0, 0, 100004, 0, 3, 0]);
    expect(store.minutes()).toEqual([M0, M0 + 60]);
    store.apply({ type: 'of-trade', sub: 1, seq: 2, trades: [['A', M0 * 1000 + 1_000, 1, 15, 3, 100000, 100002, 100001], ['B', M0 * 1000 + 5_000, -1, 7, 1, 100004, 100004, 100004]] });
    expect(store.trades().map((trade) => [trade.id, trade.size])).toEqual([['A', 15], ['B', 7]]);
    expect(changes).toBe(3);
  });

  it('mezera v pořadí zpráv nic nedomýšlí a vyžádá nový snímek', () => {
    const store = new OrderFlowStore();
    store.apply(snapshot());
    store.apply({ type: 'of', sub: 1, seq: 3, cells: [[M0, [100000, 99, 0, 0]]] });
    expect(store.needsResync).toBe(true);
    expect([...store.minuteCells(M0)!].slice(0, 4)).toEqual([100000, 9, 1, 0]);
  });

  it('zprávy starého odběru zahodí; cizí zprávy nepřijímá', () => {
    const store = new OrderFlowStore();
    store.apply(snapshot());
    expect(store.apply({ type: 'of', sub: 7, seq: 1, cells: [[M0, [100000, 99, 0, 0]]] })).toBe(true);
    expect(store.needsResync).toBe(false);
    expect(store.apply({ type: 'tick', price: 1 })).toBe(false);
    expect([...store.minuteCells(M0)!].slice(0, 4)).toEqual([100000, 9, 1, 0]);
  });

  it('poškozené řádky přeskočí', () => {
    const store = new OrderFlowStore();
    store.apply(snapshot({ minutes: [[M0, [100000, 9, 1]], ['x', []], [M0 + 60, [100000, 1, 0, 0]]], trades: [['A', 'kdy', 1, 9, 2, 1, 1, 1], ['B']] }));
    expect(store.minutes()).toEqual([M0 + 60]);
    expect(store.trades()).toEqual([]);
  });

  it('ví, které minuty se od posledně změnily', () => {
    const store = new OrderFlowStore();
    store.apply(snapshot());
    const rev = store.rev;
    expect(store.changedSince(rev, M0, M0 + 60)).toBe(false);
    store.apply({ type: 'of', sub: 1, seq: 1, cells: [[M0 + 60, [100001, 1, 0, 0]]] });
    expect(store.changedSince(rev, M0, M0 + 60)).toBe(false);
    expect(store.changedSince(rev, M0 + 60, M0 + 120)).toBe(true);
  });

  it('pokrytí: díra před živým tokem znamená neúplný úsek', () => {
    const store = new OrderFlowStore();
    store.apply(snapshot({ coverage: [[M0, M0 + 120]], liveSince: (M0 + 600) * 1000 }));
    expect(store.covered(M0, M0 + 120)).toBe(true);
    expect(store.covered(M0, M0 + 300)).toBe(false);
    expect(store.covered(M0 - 60, M0 + 60)).toBe(false);
    store.apply(snapshot({ coverage: [[M0, M0 + 120]], liveSince: (M0 + 90) * 1000 }));
    expect(store.covered(M0, M0 + 3_600)).toBe(true);
  });

  it('reset smaže vše', () => {
    const store = new OrderFlowStore();
    store.apply(snapshot());
    store.reset();
    expect(store.minutes()).toEqual([]);
    expect(store.trades()).toEqual([]);
    expect(store.complete).toBe(false);
  });

  it('mergeCells drží řazení podle ceny', () => {
    expect([...mergeCells(Int32Array.from([5, 1, 1, 0, 9, 2, 2, 0]), [7, 3, 3, 0, 5, 4, 4, 1])]).toEqual([5, 4, 4, 1, 7, 3, 3, 0, 9, 2, 2, 0]);
  });

  it('capability bere jen platný tvar', () => {
    expect(parseOrderFlowCapability({ sources: { NQ: 'NQZ6' }, tickSize: 0.25, floors: { NQ: 5 }, keepDays: 7 })).toEqual({ sources: { NQ: 'NQZ6' }, tickSize: 0.25, floors: { NQ: 5 }, keepDays: 7 });
    expect(parseOrderFlowCapability({ sources: {}, tickSize: 0.25 })).toBeNull();
    expect(parseOrderFlowCapability(undefined)).toBeNull();
  });
});

describe('OrderFlowLink', () => {
  const capability = { sources: { NQ: 'NQZ6', MNQ: 'MNQZ6' }, tickSize: 0.25, floors: { NQ: 5, MNQ: 20 }, keepDays: 7 };

  it('přihlásí odběr, až když data někdo chce a služba je umí', () => {
    const sent: unknown[] = [];
    const link = new OrderFlowLink();
    link.attach((request) => { sent.push(request); return true; });
    const release = link.demand({ source: 'NQ', days: 7 });
    expect(sent).toEqual([]);
    link.hello(capability);
    expect(sent).toEqual([{ subscribe: true, source: 'NQ', days: 7 }]);
    const releaseSecond = link.demand({ source: 'NQ', days: 1 });
    expect(sent).toHaveLength(1);
    release(); releaseSecond();
    expect(sent[1]).toEqual({ subscribe: false });
  });

  it('požadovaný zdroj, který služba nemá, nahradí dostupným a dny omezí', () => {
    const sent: unknown[] = [];
    const link = new OrderFlowLink();
    link.attach((request) => { sent.push(request); return true; });
    link.hello({ sources: { ES: 'ESZ6' }, tickSize: 0.25, keepDays: 3 });
    link.demand({ source: 'NQ', days: 30 });
    expect(sent).toEqual([{ subscribe: true, source: 'ES', days: 3 }]);
  });

  it('po konci relace data smaže a po novém hello odběr přihlásí znovu', () => {
    const sent: unknown[] = [];
    const link = new OrderFlowLink();
    link.attach((request) => { sent.push(request); return true; });
    link.hello(capability);
    link.demand({ source: 'NQ', days: 1 });
    link.message(snapshot());
    expect(link.store.minutes()).toHaveLength(1);
    link.sessionReset();
    expect(link.store.minutes()).toEqual([]);
    link.hello(capability);
    expect(sent).toEqual([{ subscribe: true, source: 'NQ', days: 1 }, { subscribe: true, source: 'NQ', days: 1 }]);
  });

  it('služba bez order flow: nic neposílá; chybu služby jen zobrazí', () => {
    const sent: unknown[] = [];
    const link = new OrderFlowLink();
    link.attach((request) => { sent.push(request); return true; });
    link.hello(undefined);
    link.demand({ source: 'NQ', days: 1 });
    expect(sent).toEqual([]);
    expect(link.message({ type: 'of-error', message: 'order flow není ve službě zapnutý' })).toBe(true);
    expect(link.error).toContain('není');
  });

  it('po mezeře ve zprávách požádá o nový snímek nejvýš jednou za 2 s', () => {
    const sent: unknown[] = [];
    let now = 10_000;
    const link = new OrderFlowLink(() => now);
    link.attach((request) => { sent.push(request); return true; });
    link.hello(capability);
    link.demand({ source: 'NQ', days: 1 });
    link.message(snapshot());
    link.message({ type: 'of', sub: 1, seq: 5, cells: [] });
    link.message({ type: 'of', sub: 1, seq: 6, cells: [] });
    expect(sent).toHaveLength(2);
    now += 2_500;
    link.message({ type: 'of', sub: 1, seq: 9, cells: [] });
    expect(sent).toHaveLength(2); // needsResync už je nastavené, další žádost až po novém snímku
  });
});

describe('volume profil', () => {
  it('sečte buňky do řádků, najde POC, deltu a value area', () => {
    const profile = buildOrderFlowProfile([
      Int32Array.from([100, 5, 1, 0, 101, 2, 2, 0, 104, 1, 0, 0]),
      Int32Array.from([101, 10, 3, 1, 105, 0, 4, 0]),
      undefined,
    ], 2, 70)!;
    expect(profile.rowMin).toBe(50);
    expect([...profile.buy]).toEqual([17, 0, 1]);
    expect([...profile.sell]).toEqual([6, 0, 4]);
    expect([...profile.other]).toEqual([1, 0, 0]);
    expect(profile.total).toBe(29);
    expect(profile.delta).toBe(8);
    expect(profile.poc).toBe(0);
    expect(profile.maxVolume).toBe(24);
    expect([profile.val, profile.vah]).toEqual([0, 0]);
  });

  it('prázdný vstup nedá profil', () => {
    expect(buildOrderFlowProfile([], 1)).toBeNull();
    expect(buildOrderFlowProfile([Int32Array.from([100, 0, 0, 0])], 1)).toBeNull();
  });

  it('value area roste směrem k většímu sousedovi', () => {
    expect(valueAreaBounds([1, 5, 10, 4, 1], 2, 21, 70)).toEqual([1, 2]);
    expect(valueAreaBounds([1, 5, 10, 4, 1], 2, 21, 100)).toEqual([0, 4]);
  });

  it('dělí minuty po seancích v pražském čase a po obchodních dnech', () => {
    const sessions = [{ name: 'Asie', start: 1, end: 9 }, { name: 'Londýn', start: 9, end: 15 }, { name: 'New York', start: 15, end: 22 }];
    const at = (hour: number, minute = 0) => Date.UTC(2026, 10, 27, hour - 1, minute) / 1000; // zima: Praha = UTC+1
    expect(zoneHour(at(15, 30), 'Europe/Prague')).toBe(15);
    const minutes = [at(8, 58), at(8, 59), at(9, 0), at(14, 59), at(15, 0), at(21, 59), at(22, 0), at(23, 30)];
    expect(orderFlowProfileSegments(minutes, 'session', sessions, 'Europe/Prague').map((segment) => [segment.label, segment.from, segment.to])).toEqual([
      ['Asie', at(8, 58), at(9, 0)], ['Londýn', at(9, 0), at(15, 0)], ['New York', at(15, 0), at(22, 0)],
    ]);
    // první data NY až v 15:40, ale seance podle hodin začíná v 15:00
    expect(orderFlowProfileSegments([at(15, 40), at(15, 41)], 'session', sessions, 'Europe/Prague')[0]).toMatchObject({ from: at(15, 40), nominalFrom: at(15, 0) });
    const days = orderFlowProfileSegments([at(20, 0), at(23, 59), at(24, 0), at(25, 0)], 'day', sessions, 'Europe/Prague');
    expect(days[0].nominalFrom).toBe(at(0, 0));
    // obchodní den se láme v 18:00 New Yorku = 00:00 Prahy (zima)
    expect(days.map((segment) => segment.key)).toEqual(['2026-11-27', '2026-11-28']);
  });

  it('automatický řádek má aspoň tři pixely', () => {
    expect(autoRowTicks(4)).toBe(1);
    expect(autoRowTicks(0.5)).toBe(8);
    expect(autoRowTicks(0)).toBe(4);
  });
});

describe('bubliny', () => {
  const trade = (id: string, size: number, at = 0) => ({ id, at, side: 1 as const, size, fills: 1, lo: 1, hi: 1, price: 1 });

  it('vybere obchody od prahu, nejvýš N největších, od největšího', () => {
    const picked = selectOrderFlowBubbles([trade('a', 5), trade('b', 50), trade('c', 20), trade('d', 19), trade('e', 30)], 20, 2);
    expect(picked.map((item) => item.id)).toEqual(['b', 'e']);
    expect(selectOrderFlowBubbles([trade('a', 5)], 20, 10)).toEqual([]);
  });

  it('poloměr roste s velikostí a má strop; velikost se zapisuje krátce', () => {
    expect(orderFlowBubbleRadius(20, 20, 1)).toBe(7);
    expect(orderFlowBubbleRadius(80, 20, 1)).toBe(11);
    expect(orderFlowBubbleRadius(1_000_000, 20, 1)).toBe(34);
    expect(orderFlowSizeLabel(950)).toBe('950');
    expect(orderFlowSizeLabel(1_240)).toBe('1,2k');
  });
});
