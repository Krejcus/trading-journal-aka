import { describe, expect, it } from 'vitest';
import type { Trade } from '../types';
import { calculateRStatistics, calculateTotalRR, tradeRMultiple } from '../utils/tradeRisk';
import { formatPnL } from '../utils/formatPnL';

const trade = (pnl: number, riskAmount?: number, timestamp = 1, extra: Partial<Trade> = {}): Trade => ({
    id: String(timestamp), date: '2026-09-12', pnl, riskAmount, timestamp, ...extra,
} as Trade);

describe('R requires original monetary risk', () => {
    it.each([undefined, 0, -1, NaN, Infinity])('does not invent a risk for %s', risk => {
        expect(tradeRMultiple(trade(100, risk))).toBeNull();
        expect(calculateTotalRR([trade(100, risk)])).toBeNull();
    });
    it('rejects stale legacy journal risk, including zero PnL', () => {
        for (const pnl of [100, 0]) {
            expect(tradeRMultiple(trade(pnl, 50, 1, { copierTradeId: 'journal:episode' }))).toBeNull();
        }
    });
    it('keeps unknown members in combined totals instead of silently omitting them', () => {
        expect(calculateTotalRR([trade(100, 50), trade(-10)])).toBeNull();
        expect(calculateRStatistics([trade(100, 50), trade(-10)])).toMatchObject({
            total: null, avgWin: 2, avgLoss: null, maxLoss: null, maxDrawdown: null, knownTrades: 1, totalTrades: 2,
        });
    });
    it('uses individual risks for averages and extrema', () => {
        const trades = [trade(100, 10, 1), trade(200, 200, 2), trade(-80, 80, 3), trade(-20, 1, 4)];
        expect(calculateRStatistics(trades)).toMatchObject({ total: -10, avgWin: 5.5, avgLoss: -10.5, maxWin: 10, maxLoss: -20, maxDrawdown: -21 });
    });
    it('sorts drawdown chronologically and groups simultaneous account results', () => {
        const trades = [trade(20, 10, 3), trade(-20, 10, 2), trade(30, 10, 2), trade(10, 10, 1)];
        expect(calculateRStatistics(trades).maxDrawdown).toBe(0);
        expect(calculateRStatistics([...trades].reverse()).maxDrawdown).toBe(0);
        expect(trades.map(t => t.timestamp)).toEqual([3, 2, 2, 1]);
    });
    it('excludes missed trades, preserves real BE money and separates BE classification', () => {
        expect(calculateRStatistics([trade(100, undefined, 1, { executionStatus: 'Missed' }), trade(-5, 10, 2, { isBE: true })]))
            .toMatchObject({ total: -0.5, avgWin: 0, avgLoss: 0, maxDrawdown: -0.5, totalTrades: 1 });
        expect(calculateTotalRR([])).toBe(0);
    });
    it('keeps R drawdown unknown when chronology is missing', () => {
        expect(calculateRStatistics([trade(10, 5, undefined, { timestamp: undefined, date: 'unknown' })]))
            .toMatchObject({ total: 2, maxDrawdown: null });
    });
    it('rejects nonfinite results and overflow', () => {
        expect(tradeRMultiple(trade(Infinity, 1))).toBeNull();
        expect(tradeRMultiple(trade(1e308, 1e-308))).toBeNull();
        expect(calculateTotalRR([trade(1e308, 1), trade(1e308, 1)])).toBeNull();
    });
    it('formats missing R as unknown and retains the actual R sign', () => {
        for (const value of [undefined, null, NaN, Infinity]) expect(formatPnL(500, 'rr', undefined, value)).toBe('—');
        expect(formatPnL(500, 'rr', undefined, -2)).toBe('-2R');
        expect(formatPnL(500, 'rr', undefined, -2, false)).toBe('-2R');
        expect(formatPnL(500, 'rr', undefined, 0)).toBe('0R');
    });
});
