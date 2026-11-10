import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { breakEvenStop, type LiveChartPositionSummary } from '../lib/liveChartPosition';
import {
  MANAGE_BE_MAX_TICKS, breakEvenPlusTicks, breakEvenWithFees, liveManageBasis, liveManageBreakEvenOffers,
  manageDisplayValue, managePriceFromInput, planBreakEven, planManageMove, roundManagePrice, type LiveManageBasis,
} from '../lib/liveManagePrices';

const PV = 2;
const row = (patch: Partial<LiveChartPositionSummary['rows'][number]> = {}): LiveChartPositionSummary['rows'][number] => ({
  accountId: 11, name: 'Leader', isLeader: true, quantity: 1, entry: 25_000, openPnl: 10, stop: 24_990, target: 25_020,
  protectedFully: true, stopUsd: -20, targetUsd: 40, fees: 1.04, openPnlAsOf: null, ordersVerified: true, stopCoverage: 1, targetCoverage: 1,
  ...patch,
});
const long = (patch: Partial<LiveChartPositionSummary> = {}): LiveChartPositionSummary => ({
  kind: 'position', side: 'long', quantity: 1, entry: 25_000, entryType: 'Market', openPnl: 20, mark: 25_010,
  stop: 24_990, target: 25_020, protection: 'SL 1/1 · TP 1/1', accounts: 1, scopeLabel: null,
  leader: { accountId: 11, quantity: 1, entry: 25_000 }, rows: [row()],
  ...patch,
});
const short = (patch: Partial<LiveChartPositionSummary> = {}): LiveChartPositionSummary => long({
  side: 'short', mark: 24_990, stop: 25_010, target: 24_980, rows: [row({ stop: 25_010, target: 24_980 })], ...patch,
});
const basis = (patch: Partial<LiveManageBasis> = {}): LiveManageBasis => ({ entryAvg: 25_000, quantity: 1, feesUsd: 1.04, pointValue: PV, ...patch });

describe('BE + n ticků (U10)', () => {
  it('n = 0 dává přesně BE (breakEvenStop) na obou stranách, i se zlomkovým průměrem', () => {
    for (const avg of [25_000, 25_000.1, 25_000.125, 24_999.9]) {
      expect(breakEvenPlusTicks('long', avg, 0)).toBe(breakEvenStop('long', avg));
      expect(breakEvenPlusTicks('short', avg, 0)).toBe(breakEvenStop('short', avg));
    }
  });

  it('zaokrouhlení ve směru ochrany: long dolů, short nahoru, pak n ticků do zisku (mutace floor/ceil zčervená)', () => {
    expect(breakEvenPlusTicks('long', 25_000.1, 0)).toBe(25_000);
    expect(breakEvenPlusTicks('long', 25_000.1, 2)).toBe(25_000.5);
    expect(breakEvenPlusTicks('short', 25_000.1, 0)).toBe(25_000.25);
    expect(breakEvenPlusTicks('short', 25_000.1, 2)).toBe(24_999.75);
    expect(breakEvenPlusTicks('long', 25_000, MANAGE_BE_MAX_TICKS)).toBe(25_010);
  });

  it('neplatné n nebo neznámý průměr = null (nic se nepočítá)', () => {
    for (const n of [-1, 1.5, MANAGE_BE_MAX_TICKS + 1, Number.NaN]) expect(breakEvenPlusTicks('long', 25_000, n)).toBeNull();
    for (const avg of [null, undefined, 0, -5, Number.NaN]) expect(breakEvenPlusTicks('long', avg, 2)).toBeNull();
  });
});

describe('BE s poplatky (U10)', () => {
  it('průměr + poplatky / (qty · pv), zaokrouhleno na stranu zisku (mutace floor/ceil zčervená)', () => {
    // 1,04 USD / (1 · 2) = 0,52 b → long 25 000,52 → nahoru 25 000,75; short 24 999,48 → dolů 24 999,25.
    expect(breakEvenWithFees('long', 25_000, 1, 1.04, PV)).toBe(25_000.75);
    expect(breakEvenWithFees('short', 25_000, 1, 1.04, PV)).toBe(24_999.25);
    // Poplatky celé pozice se dělí celým qty: 2 kusy a 2,08 USD = stejný posun.
    expect(breakEvenWithFees('long', 25_000, 2, 2.08, PV)).toBe(25_000.75);
    // Poplatky přesně na tick se nepřeskočí (epsilon): 1 USD / 2 = 0,5 b.
    expect(breakEvenWithFees('long', 25_000, 1, 1, PV)).toBe(25_000.5);
    expect(breakEvenWithFees('short', 25_000, 1, 1, PV)).toBe(24_999.5);
  });

  it('nulové poplatky dávají BE (průměr na ticku)', () => {
    expect(breakEvenWithFees('long', 25_000, 1, 0, PV)).toBe(breakEvenStop('long', 25_000));
    expect(breakEvenWithFees('short', 25_000, 3, 0, PV)).toBe(breakEvenStop('short', 25_000));
    // Zlomkový průměr (přikoupení): nulové poplatky = nejbližší tick bez ztráty.
    expect(breakEvenWithFees('long', 25_000.1, 2, 0, PV)).toBe(25_000.25);
    expect(breakEvenWithFees('short', 25_000.1, 2, 0, PV)).toBe(25_000);
  });

  it('stop na té ceně pokryje poplatky a o tick blíž už ne (nejmenší taková cena)', () => {
    for (const [avg, qty, fees] of [[25_000.1, 1, 1.04], [25_000.125, 3, 3.12], [24_871.6, 2, 2.3], [25_000, 5, 0.01]] as const) {
      const up = breakEvenWithFees('long', avg, qty, fees, PV)!;
      expect((up - avg) * qty * PV).toBeGreaterThanOrEqual(fees - 1e-9);
      expect((up - 0.25 - avg) * qty * PV).toBeLessThan(fees);
      const down = breakEvenWithFees('short', avg, qty, fees, PV)!;
      expect((avg - down) * qty * PV).toBeGreaterThanOrEqual(fees - 1e-9);
      expect((avg - down - 0.25) * qty * PV).toBeLessThan(fees);
    }
  });

  it('neznámé nebo neplatné poplatky / qty / průměr = null (nenabízí se)', () => {
    expect(breakEvenWithFees('long', 25_000, 1, null, PV)).toBeNull();
    expect(breakEvenWithFees('long', 25_000, 1, -1, PV)).toBeNull();
    expect(breakEvenWithFees('long', 25_000, 0, 1, PV)).toBeNull();
    expect(breakEvenWithFees('long', 25_000, 1.5, 1, PV)).toBeNull();
    expect(breakEvenWithFees('long', null, 1, 1, PV)).toBeNull();
    expect(breakEvenWithFees('long', 25_000, 1, 1, 0)).toBeNull();
  });
});

describe('číslo z pole → cena (U10)', () => {
  const input = (patch: Partial<Parameters<typeof managePriceFromInput>[0]>) => managePriceFromInput({
    side: 'long', leg: 'stopLoss', units: 'ticks', value: 30, entryAvg: 25_000, quantity: 1, pointValue: PV, ...patch,
  });

  it('SL 30 ticků (smoke test DEMO) a TP v bodech pro long i short', () => {
    expect(input({})).toEqual({ price: 24_992.5 });
    expect(input({ side: 'short' })).toEqual({ price: 25_007.5 });
    expect(input({ leg: 'takeProfit', units: 'pts', value: 20 })).toEqual({ price: 25_020 });
    expect(input({ side: 'short', leg: 'takeProfit', units: 'pts', value: 20 })).toEqual({ price: 24_980 });
  });

  it('$ = na celou pozici leadera (qty · pv)', () => {
    expect(input({ units: 'usd', value: 60, quantity: 2 })).toEqual({ price: 24_985 });
    expect(input({ units: 'usd', value: 60, quantity: null })).toEqual({ blocked: expect.stringMatching(/kontraktů/) });
  });

  it('zaokrouhlení na stranu trhu: nikdy větší ztráta ani vzdálenější cíl, než bylo zadáno (mutace floor/ceil zčervená)', () => {
    // Zlomkový průměr: long SL 30 t → 24 992,60 → nahoru 24 992,75 (29,4 t, ne 30,4 t).
    expect(input({ entryAvg: 25_000.1 })).toEqual({ price: 24_992.75 });
    expect(input({ side: 'short', entryAvg: 25_000.1 })).toEqual({ price: 25_007.5 });
    expect(input({ leg: 'takeProfit', value: 40, entryAvg: 25_000.1 })).toEqual({ price: 25_010 });
    expect(input({ side: 'short', leg: 'takeProfit', value: 40, entryAvg: 25_000.1 })).toEqual({ price: 24_990.25 });
    for (const avg of [25_000.1, 25_000.125, 24_999.9]) {
      for (const side of ['long', 'short'] as const) {
        const sl = (input({ side, entryAvg: avg }) as { price: number }).price;
        expect(Math.abs(avg - sl)).toBeLessThanOrEqual(30 * 0.25 + 1e-9);
        const tp = (input({ side, leg: 'takeProfit', units: 'pts', value: 10, entryAvg: avg }) as { price: number }).price;
        expect(Math.abs(tp - avg)).toBeLessThanOrEqual(10 + 1e-9);
      }
    }
    expect(roundManagePrice('long', 'stopLoss', 25_012.3)).toBe(25_012.5);
    expect(roundManagePrice('short', 'stopLoss', 25_012.3)).toBe(25_012.25);
    expect(roundManagePrice('long', 'takeProfit', 25_012.3)).toBe(25_012.25);
    expect(roundManagePrice('short', 'takeProfit', 25_012.3)).toBe(25_012.5);
  });

  it('záporné SL = zamčený zisk za průměrem; TP musí být kladné', () => {
    expect(input({ value: -8 })).toEqual({ price: 25_002 });
    expect(input({ side: 'short', value: -8 })).toEqual({ price: 24_998 });
    expect(input({ leg: 'takeProfit', value: 0 })).toEqual({ blocked: expect.stringMatching(/TP musí být v zisku/) });
    expect(input({ leg: 'takeProfit', value: -4 })).toEqual({ blocked: expect.stringMatching(/TP musí být v zisku/) });
  });

  it('cena přímo jde i bez průměru; jednotky od průměru bez něj ne', () => {
    expect(input({ units: 'price', value: 24_991.1, entryAvg: null })).toEqual({ price: 24_991.25 });
    expect(input({ entryAvg: null })).toEqual({ blocked: expect.stringMatching(/Průměrný vstup/) });
    expect(input({ value: Number.NaN })).toEqual({ blocked: 'Zadej číslo.' });
    expect(input({ value: 2.5 })).toEqual({ blocked: expect.stringMatching(/celým číslem/) });
    expect(input({ units: 'price', value: -3 })).toEqual({ blocked: expect.stringMatching(/platná cena/) });
  });

  it('předvyplnění pole je opačný převod se znaménkem', () => {
    const show = (patch: Partial<Parameters<typeof manageDisplayValue>[0]>) => manageDisplayValue({
      side: 'long', leg: 'stopLoss', units: 'ticks', price: 24_992.5, entryAvg: 25_000, quantity: 2, pointValue: PV, ...patch,
    });
    expect(show({})).toBe(30);
    expect(show({ units: 'pts' })).toBe(7.5);
    expect(show({ units: 'usd' })).toBe(30);
    expect(show({ units: 'price' })).toBe(24_992.5);
    expect(show({ price: 25_002 })).toBe(-8);
    expect(show({ leg: 'takeProfit', price: 25_020, units: 'pts' })).toBe(20);
    expect(show({ side: 'short', price: 25_007.5 })).toBe(30);
    expect(show({ entryAvg: null })).toBeNull();
    for (const value of [30, -8, 1]) {
      const price = (managePriceFromInput({ side: 'short', leg: 'stopLoss', units: 'ticks', value, entryAvg: 25_000, quantity: 1, pointValue: PV }) as { price: number }).price;
      expect(manageDisplayValue({ side: 'short', leg: 'stopLoss', units: 'ticks', price, entryAvg: 25_000, quantity: 1, pointValue: PV })).toBe(value);
    }
  });
});

describe('posun zadaným číslem — předkontroly jako worker (U10)', () => {
  it('„co jsem viděl“ je cena nohy z read modelu, ne zadané číslo', () => {
    const plan = planManageMove(long(), 'stopLoss', 24_985);
    expect(plan).toMatchObject({ ok: true, intent: { action: 'move-stop', leg: 'stopLoss', expectPrice: 24_990, newPrice: 24_985, direction: 'loosen' } });
    const tp = planManageMove(long(), 'takeProfit', 25_030);
    expect(tp).toMatchObject({ ok: true, intent: { action: 'move-target', expectPrice: 25_020, newPrice: 25_030 } });
  });

  it('SL nejblíž 8 ticků od trhu: přesně 8 smí, o tick blíž ne (long i short)', () => {
    expect(planManageMove(long(), 'stopLoss', 25_008)).toMatchObject({ ok: true, intent: { direction: 'tighten' } });
    expect(planManageMove(long(), 'stopLoss', 25_008.25)).toMatchObject({ ok: false, reason: expect.stringMatching(/8 ticků/), price: 25_008.25 });
    expect(planManageMove(short(), 'stopLoss', 24_992)).toMatchObject({ ok: true });
    expect(planManageMove(short(), 'stopLoss', 24_991.75)).toMatchObject({ ok: false, reason: expect.stringMatching(/8 ticků/) });
    // SL za trhem (na špatné straně pozice).
    expect(planManageMove(long(), 'stopLoss', 25_012)).toMatchObject({ ok: false, reason: expect.stringMatching(/8 ticků/) });
  });

  it('utažení bez ceny trhu blokované; uvolnění projde (rozhodne worker)', () => {
    expect(planManageMove(long({ mark: null }), 'stopLoss', 24_995)).toMatchObject({ ok: false, reason: expect.stringMatching(/není známá/) });
    expect(planManageMove(long({ mark: null }), 'stopLoss', 24_985)).toMatchObject({ ok: true });
  });

  it('TP jen dál od trhu; SL nesmí za TP', () => {
    expect(planManageMove(long(), 'takeProfit', 25_015)).toMatchObject({ ok: false, reason: expect.stringMatching(/dál od trhu/) });
    expect(planManageMove(short(), 'takeProfit', 24_985)).toMatchObject({ ok: false, reason: expect.stringMatching(/dál od trhu/) });
    expect(planManageMove(short(), 'takeProfit', 24_970)).toMatchObject({ ok: true, intent: { expectPrice: 24_980 } });
    expect(planManageMove(long({ mark: 25_040, target: 25_020 }), 'stopLoss', 25_020)).toMatchObject({ ok: false, reason: expect.stringMatching(/pod TP/) });
  });

  it('rozjeté / neznámé nohy, čekající vstup, stejná cena a cena mimo tick = blok', () => {
    expect(planManageMove(long({ stop: null }), 'stopLoss', 24_985)).toMatchObject({ ok: false, reason: expect.stringMatching(/SL leadera není známý/) });
    expect(planManageMove(long({ target: null }), 'takeProfit', 25_030)).toMatchObject({ ok: false });
    expect(planManageMove(long({ kind: 'pending' }), 'stopLoss', 24_985)).toMatchObject({ ok: false, reason: expect.stringMatching(/vyplněné pozice/) });
    expect(planManageMove(long(), 'stopLoss', 24_990)).toMatchObject({ ok: false, reason: expect.stringMatching(/už je/) });
    expect(planManageMove(long(), 'stopLoss', 24_985.1)).toMatchObject({ ok: false, reason: expect.stringMatching(/ticku/) });
    expect(planManageMove(null, 'stopLoss', 24_985)).toMatchObject({ ok: false });
  });
});

describe('BE varianty — záměr move-stop (U10)', () => {
  it('BE, BE +2 t a BE + poplatky: cena, expect ze SL read modelu', () => {
    const summary = long({ mark: 25_010 });
    expect(planBreakEven(summary, basis(), { kind: 'be' })).toMatchObject({ ok: true, intent: { id: 'be', action: 'move-stop', expectPrice: 24_990, newPrice: 25_000, direction: 'tighten' } });
    expect(planBreakEven(summary, basis(), { kind: 'be-plus', ticks: 2 })).toMatchObject({ ok: true, intent: { newPrice: 25_000.5, label: 'SL na BE +2 t 25000.50' } });
    expect(planBreakEven(summary, basis(), { kind: 'be-fees' })).toMatchObject({ ok: true, intent: { newPrice: 25_000.75, label: 'SL na BE + odhad poplatků 25000.75' } });
  });

  it('klíč potvrzení nese variantu, akci, „co jsem viděl“ i novou cenu', () => {
    const a = planBreakEven(long(), basis(), { kind: 'be-plus', ticks: 2 });
    const b = planBreakEven(long({ stop: 24_989 }), basis(), { kind: 'be-plus', ticks: 2 });
    const c = planBreakEven(long(), basis(), { kind: 'be-plus', ticks: 3 });
    if (!a.ok || !b.ok || !c.ok) throw new Error('plán měl projít');
    expect(a.intent.confirmKey).toBe('be-plus:move-stop:24990:25000.5');
    expect(new Set([a.intent.confirmKey, b.intent.confirmKey, c.intent.confirmKey]).size).toBe(3);
  });

  it('short zrcadlově', () => {
    expect(planBreakEven(short(), basis(), { kind: 'be-plus', ticks: 2 })).toMatchObject({ ok: true, intent: { expectPrice: 25_010, newPrice: 24_999.5 } });
    expect(planBreakEven(short(), basis(), { kind: 'be-fees' })).toMatchObject({ ok: true, intent: { newPrice: 24_999.25 } });
  });

  it('blíž než 8 ticků od trhu, za TP, rozjeté SL, SL už na ceně = blok s cenou', () => {
    expect(planBreakEven(long({ mark: 25_001 }), basis(), { kind: 'be' })).toMatchObject({ ok: false, reason: expect.stringMatching(/8 ticků/), price: 25_000 });
    expect(planBreakEven(long({ mark: 25_040, target: 25_001 }), basis(), { kind: 'be-plus', ticks: 8 })).toMatchObject({ ok: false, reason: expect.stringMatching(/pod TP/), price: 25_002 });
    expect(planBreakEven(long({ stop: null }), basis(), { kind: 'be' })).toMatchObject({ ok: false, reason: expect.stringMatching(/není na jedné ceně/), price: 25_000 });
    expect(planBreakEven(long({ stop: 25_000 }), basis(), { kind: 'be' })).toMatchObject({ ok: false, reason: expect.stringMatching(/už je na BE/) });
    expect(planBreakEven(long({ kind: 'pending' }), basis(), { kind: 'be' })).toMatchObject({ ok: false, reason: expect.stringMatching(/vyplněné pozice/) });
  });

  it('neznámý průměr / poplatky = vypnuto; BE + n jen 1–40', () => {
    expect(planBreakEven(long(), basis({ entryAvg: null }), { kind: 'be' })).toMatchObject({ ok: false, reason: expect.stringMatching(/Průměrný vstup/) });
    expect(planBreakEven(long(), basis({ feesUsd: null }), { kind: 'be-fees' })).toMatchObject({ ok: false, reason: expect.stringMatching(/Poplatky/) });
    expect(planBreakEven(long(), basis({ quantity: null }), { kind: 'be-fees' })).toMatchObject({ ok: false });
    for (const ticks of [0, 41, 2.5]) expect(planBreakEven(long(), basis(), { kind: 'be-plus', ticks })).toMatchObject({ ok: false, reason: expect.stringMatching(/1–40/) });
  });

  it('nabídka tlačítek: BE + poplatky se bez poplatků nenabízí', () => {
    expect(liveManageBreakEvenOffers(long(), basis({ feesUsd: null }), 2).fees).toBeNull();
    const offers = liveManageBreakEvenOffers(long(), basis(), 2);
    expect(offers.be.ok && offers.plus.ok && offers.fees?.ok).toBe(true);
  });
});

describe('podklad správy jen z leadera skupiny workeru (INV-UI-01)', () => {
  it('qty a poplatky ze stejného řádku leadera, průměr z pollu', () => {
    expect(liveManageBasis(long(), 11, 25_000, PV)).toEqual({ entryAvg: 25_000, quantity: 1, feesUsd: 1.04, pointValue: PV, tick: 0.25 });
  });

  it('follower s přepsaným isLeader (jiné accountId) = nic neznámo', () => {
    expect(liveManageBasis(long(), 99, 25_000, PV)).toMatchObject({ quantity: null, feesUsd: null });
    expect(liveManageBasis(long(), null, 25_000, PV)).toMatchObject({ quantity: null, feesUsd: null });
  });

  it('poplatky k jinému počtu kusů, záporné nebo chybějící = neznámé; průměr z pollu chybí = null', () => {
    expect(liveManageBasis(long({ rows: [row({ quantity: 2 })] }), 11, 25_000, PV).feesUsd).toBeNull();
    expect(liveManageBasis(long({ rows: [row({ fees: -1 })] }), 11, 25_000, PV).feesUsd).toBeNull();
    expect(liveManageBasis(long({ rows: [row({ fees: null })] }), 11, 25_000, PV).feesUsd).toBeNull();
    expect(liveManageBasis(long(), 11, null, PV).entryAvg).toBeNull();
  });
});

describe('statika: modul jen počítá záměr (INV-UI-01..04)', () => {
  const source = readFileSync('lib/liveManagePrices.ts', 'utf8');
  it('importuje jen zobrazovací moduly, nic z kopírky ani relaye', () => {
    const imports = [...source.matchAll(/from '([^']+)'/g)].map(match => match[1]).sort();
    expect(imports).toEqual(['./liveChartOrderLines', './liveChartPosition', './liveChartRiskPolicy', './liveOrderTicket']);
    expect(source).not.toMatch(/fetch\(|executeTradovate|relay|services\//);
  });
});
