import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import BacktestTradeReviewDialog from '../components/BacktestTradeReviewDialog';
import type { Trade } from '../types';

const reviewedTrade: Trade = {
  id: 'trade-1',
  accountId: 'account-1',
  backtestRunId: 'run-1',
  instrument: 'MNQ',
  signal: 'Silver Bullet',
  pnl: 128.5,
  riskAmount: 75,
  runUp: 160,
  drawdown: -24,
  date: '2026-08-14T08:00:00.000Z',
  direction: 'Long',
  timestamp: Date.parse('2026-08-14T08:00:00.000Z'),
  duration: '12m',
  durationMinutes: 12,
  entryPrice: 22000,
  exitPrice: 22010,
  stopLoss: 21995,
  takeProfit: 22012,
  targetLevel: 'PDH',
  session: 'New York AM',
  mfeR: 2.4,
  maeR: 0.35,
  htfConfluence: ['PDH'],
  ltfConfluence: ['MSS'],
  slPlacement: 'fvg',
  entryMap: {
    odrazLevels: ['PDL'], odrazPrice: 21990, odrazLevelPrice: 21990,
    reaction: {
      status: 'confirmed', level: 'PDL', levelPrice: 21990, extremePrice: 21990,
      touchTime: 1, confirmationTime: 2, reason: 'confirmed-hold',
      candidates: [{
        label: 'PDL', price: 21990, status: 'confirmed',
        reason: 'held-until-structure-break', invalidatedAt: null,
      }],
    },
    entryModel: 'fvg_edge',
    entryFvgValid: true, entryFvgTimeframe: '1m', entryFvgDistanceTicks: 0,
    entryFvgSpan: { bottom: 21998, top: 22000 },
    entryFvg: true, entryFvgParentType: 'CHoCH', entryFvgParentOrder: 1,
    entryFvgIndexInImpulse: 2, entryFvgCountInImpulse: 3,
  },
  entryContext: {
    placement: {
      slPlacement: 'fvg',
      slCandidates: {
        ote: { price: 21994, distanceTicks: 4, offsetTicks: 4, matched: false },
        swing: { price: 21992, distanceTicks: 12, offsetTicks: 12, matched: false },
        fvg: { price: 21995, distanceTicks: 0, offsetTicks: 0, matched: true },
      },
      targetMatch: {
        matched: true, level: 'PDH', type: 'liquidity', levelPrice: 22012,
        actualPrice: 22012, offsetTicks: 0, toleranceTicks: 12,
      },
      targetPolicy: {
        expected: 'nearest_level', nearestLevel: 'PDH', nearestPrice: 22012,
        actualPrice: 22012, distanceTicks: 0, valid: true,
      },
    },
  },
  screenshot: 'https://example.test/snapshot.jpg',
};

describe('BacktestTradeReviewDialog render', () => {
  it('shows actual collected values and the existing saved snapshot', () => {
    const markup = renderToStaticMarkup(React.createElement(BacktestTradeReviewDialog, {
      trade: reviewedTrade,
      isDark: false,
      onClose: vi.fn(),
      onCaptureSnapshot: () => 'data:image/png;base64,new',
      onSave: vi.fn(async () => undefined),
    }));

    expect(markup).toContain('Exekuce obchodu');
    expect(markup).toContain('Entry Confluence');
    expect(markup).toContain('HTF Confluence');
    expect(markup).toContain('Přidat Entry Confluence');
    expect(markup).toContain('Přidat HTF Confluence');
    expect(markup).toContain('data-backtest-entry-audit');
    expect(markup).toContain('1m FVG · proximální hrana');
    expect(markup).toContain('FVG · 21995.00');
    expect(markup).toContain('Skutečný cíl PDH');
    expect(markup).toContain('Pravidlo nejbližšího levelu: PDH');
    expect(markup).toContain('extrém 21990.00');
    expect(markup).toContain('Level vydržel do potvrzení struktury');
    expect(markup).toContain('vstup na proximální hraně 1m FVG');
    expect(markup).toContain('CHoCH #1');
    expect(markup).toContain('FVG 2/3 v impulsu');
    expect(markup).toContain('Typ setupu — ručně');
    expect(markup).toContain('Odraz');
    expect(markup).toContain('Průraz');
    expect(markup).toContain('Nejasné');
    expect(markup).toContain('Levely');
    expect(markup).toContain('Entry');
    expect(markup).toContain('SL');
    expect(markup).toContain('MSS');
    expect(markup).toContain('PDH');
    expect(markup).toContain('New York AM');
    expect(markup).toContain('2.40R');
    expect(markup).toContain('0.35R');
    expect(markup).toContain('Uložený snapshot');
    expect(markup).toContain('https://example.test/snapshot.jpg');
    expect(markup).toContain('Zvětšit náhled snapshotu');
    expect(markup).toContain('Vyfotit nový snapshot všech grafů');
  });

  it('neprezentuje vzdálený level jako potvrzený cíl', () => {
    const invalidTrade: Trade = {
      ...reviewedTrade,
      targetType: 'other',
      targetLevel: undefined,
      entryContext: {
        ...(reviewedTrade.entryContext as object),
        placement: {
          ...(reviewedTrade.entryContext as any).placement,
          targetPolicy: {
            expected: 'nearest_level', nearestLevel: 'WO', nearestPrice: 22028,
            actualPrice: 22012, distanceTicks: 64, valid: false,
          },
          targetMatch: {
            matched: false, level: null, type: 'other', levelPrice: 22028,
            actualPrice: 22012, offsetTicks: -64, toleranceTicks: 12,
          },
        },
      },
    };
    const markup = renderToStaticMarkup(React.createElement(BacktestTradeReviewDialog, {
      trade: invalidTrade,
      isDark: false,
      onClose: vi.fn(),
      onCaptureSnapshot: () => 'data:image/png;base64,new',
      onSave: vi.fn(async () => undefined),
    }));

    expect(markup).toContain('Bez potvrzené shody');
    expect(markup).toContain('Pravidlo nejbližšího levelu: WO');
    expect(markup).not.toContain('Nejbližší WO</div>');
  });
});
