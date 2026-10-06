import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import TradeShareCard from '../components/TradeShareCard';
import {
  contractsLabel, shareMoney, shareR, tradePricePath, tradeShareHold, tradeShareOwnerName, tradeShareR,
} from '../lib/tradeShareCard';
import type { Trade } from '../types';

const trade = (patch: Partial<Trade> = {}): Trade => ({
  id: '6f0e9b9c-0000-4000-8000-000000000001', accountId: 'a', signal: '', runUp: 0, drawdown: 0,
  date: '2026-10-02', timestamp: Date.UTC(2026, 9, 2, 13, 47), entryTime: Date.UTC(2026, 9, 2, 13, 47),
  duration: '12m', durationMinutes: 12, instrument: 'MNQ', direction: 'Long', pnl: 291,
  entryPrice: 31018.25, exitPrice: 31042.5, positionSize: 6, riskAmount: 147, ...patch,
} as Trade);

const card = (t: Trade, props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(React.createElement(TradeShareCard, { trade: t, owner: { name: 'Filip' }, captureMode: true, ...props }));

describe('sdílecí karta obchodu', () => {
  it('ztráta má mínus — dřív se psala jen červeně bez znaménka', () => {
    expect(shareMoney(-1726.8)).toBe('−$1\u00a0727');
    expect(shareMoney(291)).toBe('+$291');
    expect(shareMoney(0)).toBe('$0');
    expect(card(trade({ pnl: -1726.8 }))).toContain('−$1\u00a0727');
  });

  it('R jen ze zadaného rizika', () => {
    expect(tradeShareR(trade())).toBeCloseTo(1.98, 2);
    expect(tradeShareR(trade({ riskAmount: undefined }))).toBeNull();
    expect(shareR(-1)).toBe('−1,00R');
  });

  it('skrytá částka ukáže R a dolary nikde', () => {
    const markup = card(trade(), { hideAmount: true });
    expect(markup).toContain('+1,98R');
    expect(markup).not.toContain('$291');
  });

  it('skrytá částka bez rizika neprozradí dolary ani přes R', () => {
    const markup = card(trade({ riskAmount: undefined }), { hideAmount: true });
    expect(markup).toContain('Zisk');
    expect(markup).not.toContain('$');
  });

  it('poznámka jen na výslovné přání', () => {
    const t = trade({ notes: 'Vstup po sweepu' });
    expect(card(t)).not.toContain('Vstup po sweepu');
    expect(card(t, { showNotes: true })).toContain('Vstup po sweepu');
  });

  it('kontrakty česky', () => {
    expect(contractsLabel(1)).toBe('1 kontrakt');
    expect(contractsLabel(3)).toBe('3 kontrakty');
    expect(contractsLabel(16)).toBe('16 kontraktů');
  });

  it('cenová dráha: plánované SL/TP mají přednost a výstup na SL se nekreslí dvakrát', () => {
    const path = tradePricePath(trade({ exitPrice: 31006, stopLoss: 31000, plannedStopLoss: 31006, plannedTakeProfit: 31048 }));
    expect(path?.levels.map(level => level.kind)).toEqual(['tp', 'sl', 'entry']);
    expect(path?.levels.find(level => level.kind === 'sl')?.price).toBe(31006);
    expect(path!.low).toBeLessThan(31006);
    expect(path!.high).toBeGreaterThan(31048);
  });

  it('bez vstupu nebo výstupu dráha není', () => {
    expect(tradePricePath(trade({ exitPrice: undefined }))).toBeNull();
  });

  it('screenshot má přednost před dráhou', () => {
    const markup = card(trade({ screenshot: 'https://example.com/chart.png' }));
    expect(markup).toContain('trade-card-shot');
    expect(markup).not.toContain('Cenová dráha');
  });

  it('jméno bez zavináče a domény, držení z minut', () => {
    expect(tradeShareOwnerName({ name: ' Filip ' })).toBe('Filip');
    expect(tradeShareOwnerName({ email: 'filip@example.com' })).toBe('filip');
    expect(tradeShareOwnerName(null)).toBe('Trader');
    expect(tradeShareHold(trade({ durationMinutes: 75 }))).toBe('1h 15m');
  });
});
