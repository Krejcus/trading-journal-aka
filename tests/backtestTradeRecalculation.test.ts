import { describe, expect, it } from 'vitest';
import type { Trade } from '../types';
import {
  buildBacktestTradeRecalculationUpdates,
  describeBacktestTradeRecalculation,
  mergeManualAndGeneratedConfluences,
} from '../services/backtestTradeRecalculation';

const trade = (partial: Partial<Trade> = {}): Trade => ({
  id: 'trade-1',
  accountId: 'account-1',
  backtestRunId: 'run-1',
  instrument: 'MNQ',
  signal: 'Replay',
  pnl: 100,
  runUp: 120,
  drawdown: -20,
  date: '2026-08-14T08:00:00.000Z',
  direction: 'Long',
  timestamp: Date.parse('2026-08-14T08:00:00.000Z'),
  duration: '5m',
  durationMinutes: 5,
  ...partial,
});

describe('backtest trade recalculation', () => {
  it('replaces generated confluences but preserves manual capsules', () => {
    expect(mergeManualAndGeneratedConfluences(
      ['1m BoS (1 bar zpět)', 'vstup ve FVG', 'Moje potvrzení'],
      ['1m CHoCH (2 bary zpět)', 'pod VWAP'],
      'ltf',
    )).toEqual(['Moje potvrzení', '1m CHoCH (2 bary zpět)', 'pod VWAP']);

    expect(mergeManualAndGeneratedConfluences(
      ['1h BoS bullish', 'u PDH', 'Ruční HTF poznámka'],
      ['1h CHoCH bearish', 'pod Day Open'],
      'htf',
    )).toEqual(['Ruční HTF poznámka', '1h CHoCH bearish', 'pod Day Open']);
  });

  it('stages only recalculable fields and never overwrites review or snapshots', () => {
    const current = trade({
      notes: 'Ruční poznámka',
      isValid: false,
      executionStatus: 'Invalid',
      screenshots: ['saved.png'],
      ltfConfluence: ['1m BoS', 'Ruční LTF'],
      htfConfluence: ['1h BoS bullish', 'Ruční HTF'],
      entryMap: { structureType: 'BoS' },
      targetLevel: 'stará chybná úroveň',
    });
    const fresh = trade({
      riskAmount: 80,
      mfeR: 2.5,
      entryMap: { structureType: 'CHoCH', entryFvg: true },
      ltfConfluence: ['1m CHoCH', 'vstup ve FVG'],
      htfConfluence: ['1h CHoCH bearish'],
      notes: 'Automatická poznámka se nesmí použít',
      isValid: true,
      screenshots: ['wrong.png'],
    });

    const updates = buildBacktestTradeRecalculationUpdates(current, fresh);

    expect(updates).toMatchObject({
      riskAmount: 80,
      mfeR: 2.5,
      entryMap: { structureType: 'CHoCH', entryFvg: true },
      ltfConfluence: ['Ruční LTF', '1m CHoCH', 'vstup ve FVG'],
      htfConfluence: ['Ruční HTF', '1h CHoCH bearish'],
      targetLevel: null,
    });
    expect(updates).not.toHaveProperty('notes');
    expect(updates).not.toHaveProperty('isValid');
    expect(updates).not.toHaveProperty('executionStatus');
    expect(updates).not.toHaveProperty('screenshots');
  });

  it('creates a readable before/after preview', () => {
    const before = trade({
      entryMap: { structureType: 'BoS', structureBarsAgo: 5, entryFvg: false },
      ltfConfluence: ['1m BoS'],
      slPlacement: 'other',
    });
    const after = trade({
      entryMap: { structureType: 'CHoCH', structureBarsAgo: 1, entryFvg: true },
      ltfConfluence: ['1m CHoCH', 'vstup ve FVG'],
      slPlacement: 'swing',
    });

    expect(describeBacktestTradeRecalculation(before, after)).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Entry struktura', before: 'BoS · 5 barů zpět', after: 'CHoCH · 1 bar zpět' }),
      expect.objectContaining({ label: 'Entry FVG', before: 'ne', after: 'ano' }),
      expect.objectContaining({ label: 'SL umístění', before: 'other', after: 'swing' }),
    ]));
  });
});

describe('přepočet doplní bracket staršímu obchodu', () => {
  const base = { id: 't', accountId: 'a', signal: 's', pnl: 1, runUp: 0, drawdown: 0,
    date: '2026-07-05', direction: 'Long', timestamp: 1, duration: '5m', durationMinutes: 5 } as unknown as Trade;

  it('prázdné SL/TP se přepíšou hodnotami z replay dat', () => {
    const updates = buildBacktestTradeRecalculationUpdates(
      { ...base },
      { ...base, stopLoss: 97.5, takeProfit: 103.5, schemaVersion: 4, outcomeAmbiguous: false },
    );
    expect(updates.stopLoss).toBe(97.5);
    expect(updates.takeProfit).toBe(103.5);
    expect(updates.schemaVersion).toBe(4);
  });

  it('změna bracketu se objeví v přehledu rozdílů', () => {
    const changes = describeBacktestTradeRecalculation(
      { ...base },
      { ...base, stopLoss: 97.5 },
    );
    expect(changes).toContainEqual({ label: 'Stop loss', before: '—', after: '97.50' });
  });
});
