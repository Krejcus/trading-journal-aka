import type { Trade } from '../types';

/** Journal evidence does not yet prove the original monetary risk. In particular,
 * a later SL or a riskAmount inherited from a legacy row is not that proof. */
export function tradeRMultiple(trade: Pick<Trade, 'pnl' | 'riskAmount' | 'copierTradeId' | 'executionStatus'>): number | null {
    if (trade.executionStatus === 'Missed' || trade.copierTradeId?.startsWith('journal:') ||
        !Number.isFinite(trade.pnl) || !Number.isFinite(trade.riskAmount) || trade.riskAmount! <= 0) return null;
    const value = trade.pnl / trade.riskAmount!;
    return Number.isFinite(value) ? value : null;
}

export function calculateTotalRR(trades: readonly Trade[]): number | null {
    let total = 0;
    for (const trade of trades) {
        if (trade.executionStatus === 'Missed') continue;
        const value = tradeRMultiple(trade);
        if (value === null) return null;
        total += value;
        if (!Number.isFinite(total)) return null;
    }
    return total;
}

/** Each metric is complete for its own population; no silently partial sums.
 * Simultaneous results form one equity step instead of inventing their order. */
export function calculateRStatistics(trades: readonly Trade[]) {
    const executed = trades.filter(trade => trade.executionStatus !== 'Missed');
    const winners = executed.filter(trade => trade.pnl > 0 && !trade.isBE);
    const losers = executed.filter(trade => trade.pnl < 0 && !trade.isBE);
    const groupStats = (group: Trade[]) => {
        const total = calculateTotalRR(group);
        if (total === null) return { average: null, best: null, worst: null };
        let best = 0, worst = 0;
        for (const trade of group) {
            const value = tradeRMultiple(trade)!;
            best = Math.max(best, value);
            worst = Math.min(worst, value);
        }
        return { average: group.length ? total / group.length : 0, best, worst };
    };
    const wins = groupStats(winners), losses = groupStats(losers);
    const total = calculateTotalRR(executed);
    let maxDrawdown: number | null = total === null ? null : 0;
    if (maxDrawdown !== null) {
        const steps = new Map<number, number>();
        for (const trade of executed) {
            const at = trade.timestamp ?? Date.parse(trade.date);
            if (!Number.isFinite(at)) { maxDrawdown = null; break; }
            steps.set(at, (steps.get(at) ?? 0) + tradeRMultiple(trade)!);
        }
        if (maxDrawdown !== null) {
            let equity = 0, peak = 0;
            for (const [, value] of [...steps].sort(([a], [b]) => a - b)) {
                equity += value;
                peak = Math.max(peak, equity);
                maxDrawdown = Math.min(maxDrawdown, equity - peak);
                if (!Number.isFinite(equity) || !Number.isFinite(maxDrawdown)) { maxDrawdown = null; break; }
            }
        }
    }
    return { total, avgWin: wins.average, avgLoss: losses.average, maxWin: wins.best, maxLoss: losses.worst, maxDrawdown,
        knownTrades: executed.filter(trade => tradeRMultiple(trade) !== null).length, totalTrades: executed.length };
}
