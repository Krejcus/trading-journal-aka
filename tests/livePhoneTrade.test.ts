import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIVE_PILL, LIVE_PILL_STORAGE_KEY, accountsLabel, contractRoot, livePhoneGroupLine, pressQtyKey, qtyFromBuffer, readLivePillPrefs, writeLivePillPrefs,
} from '../lib/livePhoneTrade';
import type { LiveChartPositionAccountRow, LiveChartPositionSummary } from '../lib/liveChartPosition';
import { liveChartPositionTvLegs as livePhoneTvLegs } from '../lib/tvLivePnl';

const row = (over: Partial<LiveChartPositionAccountRow> = {}): LiveChartPositionAccountRow => ({
  accountId: 1, name: 'LUCID', isLeader: true, quantity: 2, entry: 21452.25, openPnl: 120.5, stop: 21421, target: 21514.75,
  protectedFully: true, stopUsd: -127.48, targetUsd: 247.52, fees: 2.48, openPnlAsOf: '2026-11-02T14:30:00.000Z',
  ordersVerified: true, stopCoverage: 2, targetCoverage: 2, ...over,
});
const summary = (over: Partial<LiveChartPositionSummary> = {}): LiveChartPositionSummary => ({
  kind: 'position', side: 'long', quantity: 6, entry: 21452.25, entryType: null, openPnl: 361.5, mark: 21482.5, stop: 21421, target: 21514.75,
  protection: 'SL 3/3 · TP 3/3', accounts: 3, scopeLabel: null, leader: { accountId: 1, quantity: 2, entry: 21452.25 },
  rows: [row(), row({ accountId: 2, name: 'TDY-1', isLeader: false }), row({ accountId: 3, name: 'TDY-2', isLeader: false })], ...over,
});

const memory = (initial: Record<string, string> = {}) => {
  const data = { ...initial };
  return { data, getItem: (key: string) => data[key] ?? null, setItem: (key: string, value: string) => { data[key] = value; } };
};

describe('obchodní lišta na telefonu', () => {
  it('preference: výchozí vlevo dole, nesmysly se ořežou', () => {
    expect(readLivePillPrefs(memory())).toEqual(DEFAULT_LIVE_PILL);
    expect(readLivePillPrefs(memory({ [LIVE_PILL_STORAGE_KEY]: '{' }))).toEqual(DEFAULT_LIVE_PILL);
    expect(readLivePillPrefs(memory({ [LIVE_PILL_STORAGE_KEY]: JSON.stringify({ on: false, x: 4, y: -1, qty: 0 }) })))
      .toEqual({ on: false, x: 1, y: 0, qty: 1 });
    expect(readLivePillPrefs(memory({ [LIVE_PILL_STORAGE_KEY]: JSON.stringify({ qty: 5000.7 }) })).qty).toBe(999);
    const storage = memory();
    writeLivePillPrefs(storage, { on: true, x: 0.4, y: 0.6, qty: 25 });
    expect(readLivePillPrefs(storage)).toEqual({ on: true, x: 0.4, y: 0.6, qty: 25 });
  });

  it('klávesnice množství: max. 3 číslice, ⌫, úvodní nula, prázdné = 1', () => {
    expect(pressQtyKey('1', '2')).toBe('12');
    expect(pressQtyKey('0', '7')).toBe('7');
    expect(pressQtyKey('999', '1')).toBe('999');
    expect(pressQtyKey('25', '⌫')).toBe('2');
    expect(pressQtyKey('', '⌫')).toBe('');
    expect(pressQtyKey('4', 'x')).toBe('4');
    expect(qtyFromBuffer('')).toBe(1);
    expect(qtyFromBuffer('0')).toBe(1);
    expect(qtyFromBuffer('25')).toBe(25);
  });

  it('cenová a časová osa patří grafu i pod roztaženou kresbou (dotyk se pustí dřív, než ho kresba chytí)', () => {
    const source = readFileSync('components/day/DayTouchDrawLayer.tsx', 'utf8');
    const start = source.slice(source.indexOf('const onTouchStart'), source.indexOf('const onTouchMove'));
    expect(source).toMatch(/priceScale\('right'\)\.width\(\)[\s\S]*timeScale\(\)\.height\(\)/);
    expect(start.indexOf('onAxis(point)')).toBeGreaterThan(-1);
    expect(start.indexOf('onAxis(point)')).toBeLessThan(start.indexOf('drawingMode()'));
    expect(start.indexOf('onAxis(point)')).toBeLessThan(start.indexOf('startDrag(point'));
  });

  it('kresba je aktivní až po klepnutí: dotyk na nevybrané kresbě posouvá graf, táhne se až vybraná (jako TV)', () => {
    const source = readFileSync('components/day/DayTouchDrawLayer.tsx', 'utf8');
    const start = source.slice(source.indexOf('const onTouchStart'), source.indexOf('const onTouchMove'));
    expect(start).toMatch(/if \(hit && hit\.id !== engine\.getSelectedId\?\.\(\)\) \{ pendingSelect = hit\.id; captured = false; return; \}/);
    expect(start.indexOf('pendingSelect = hit.id')).toBeLessThan(start.indexOf('startDrag(point'));
    const end = source.slice(source.indexOf('const onTouchEnd'), source.indexOf('const onTouchCancel'));
    expect(end).toMatch(/if \(moved\) return;\s*engine\.select\(id\);/);
  });

  it('přepnutí intervalu jako TradingView: zoom (šířka svíček) zůstane, skok na poslední svíčku; plný reset jen při otevření', () => {
    const source = readFileSync('components/day/DayFullscreenChart.tsx', 'utf8');
    expect(source).toMatch(/carriedSpacingRef\.current = barSpacingRef\.current;/);
    expect(source).toMatch(/applyOptions\(\{ barSpacing: carried \}\);\s*chart\.timeScale\(\)\.scrollToRealTime\(\);/);
    expect(source).toMatch(/\} else \{\s*resetChartView\(target\);/);
    // Výchozí šířku nového grafu (před převzetím výřezu) si nepamatovat.
    expect(source).toMatch(/if \(!resetDoneRef\.current\.has\(api\)\) return;/);
  });

  it('P&L skupiny v hlavičce: popisek obchodu, čekající vstup, jeden účet', () => {
    expect(accountsLabel(1)).toBe('1 účet');
    expect(accountsLabel(3)).toBe('3 účty');
    expect(accountsLabel(5)).toBe('5 účtů');
    expect(contractRoot('MNQZ6')).toBe('MNQ');
    expect(contractRoot('NQH27')).toBe('NQ');
    expect(livePhoneGroupLine({ symbol: 'MNQZ6', summary: summary() })).toBe('MNQ · Long 6 · 3 účty');
    expect(livePhoneGroupLine({ symbol: 'MNQZ6', summary: summary({ kind: 'pending', side: 'short', entryType: 'Limit', quantity: 2 }) })).toBe('MNQ · Sell Limit 2 · 3 účty');
    expect(livePhoneGroupLine({ symbol: 'MNQZ6', summary: summary({ scopeLabel: 'jen T2' }) })).toBe('MNQ · Long 6 · jen T2');
    expect(livePhoneGroupLine({ symbol: null, summary: null })).toBeNull();
  });

  it('živé P&L účtů: noha na účet z kotvy brokera; chybí-li kotva u kteréhokoli, jen kotva', () => {
    const position = { symbol: 'MNQZ6', summary: summary() };
    const legs = livePhoneTvLegs(position)!;
    expect(legs).toHaveLength(3);
    expect(legs[0]).toMatchObject({ symbol: 'MNQZ6', netPosition: 2, averagePrice: 21452.25, anchorAt: Date.parse('2026-11-02T14:30:00.000Z') });
    expect(legs[0].grossPnl).toBeCloseTo(122.98, 6);
    expect(livePhoneTvLegs({ symbol: 'MNQZ6', summary: summary({ side: 'short' }) })![0].netPosition).toBe(-2);
    expect(livePhoneTvLegs(position, [row({ openPnlAsOf: null })])).toBeNull();
    expect(livePhoneTvLegs(position, [row({ openPnl: null })])).toBeNull();
    expect(livePhoneTvLegs({ symbol: 'MNQZ6', summary: summary({ kind: 'pending' }) })).toBeNull();
  });

  it('hlavička telefonu: P&L skupiny jen z read modelu LIVE pultu, bez vlastního čtení relaye', () => {
    const desk = readFileSync('components/TradovateLiveDesk.tsx', 'utf8');
    expect(desk).toMatch(/enabled: \(chartAvailable \|\| phoneChartAvailable\) && tab === 'chart'/);
    expect(desk).toMatch(/position: chartData\.position/);
    // Tempo čtení zrychluje jen PC graf, telefon ne.
    expect(desk).toMatch(/chartOpenRef\.current = chartAvailable && tab === 'chart';/);
    const accounts = readFileSync('components/day/LivePhoneAccounts.tsx', 'utf8');
    expect(accounts).not.toMatch(/useDisplayWorkerStatus|useJournalLivePosition|flatten|close-position|cancel-order|manage-leader/i);
  });

  it('fáze A: lišta ani LIVE graf na telefonu nemají cestu k brokerovi', () => {
    for (const file of ['components/day/LivePhoneTrade.tsx', 'components/day/LivePhoneChart.tsx', 'components/day/LivePhoneOrderSheet.tsx', 'components/day/LivePhoneAccounts.tsx', 'lib/livePhoneTrade.ts']) {
      const source = readFileSync(file, 'utf8');
      // liveOrderTicket je jen výpočet návrhu (sdílený s PC panelem), nic neodesílá.
      expect(source, file).not.toMatch(/from ['"][^'"]*(tradovate|copier|relay|broker|LiveDesk|liveChartOrder|chartOrderEntry)[^'"]*['"]/i);
      expect(source, file).not.toMatch(/fetch\(|supabase|invoke\(/);
    }
  });
});
