import { PnLDisplayMode, Trade, Account } from '../types';

/**
 * Formats PnL value based on the selected display mode.
 * 
 * @param value - The PnL value in USD
 * @param mode - The display mode ('usd' | 'percent' | 'rr')
 * @param accountBalance - The account balance for percentage calculation
 * @param rr - The risk/reward ratio (if available)
 * @param showSign - Whether to show +/- sign
 * @returns Formatted string
 */
export function formatPnL(
    value: number,
    mode: PnLDisplayMode,
    accountBalance?: number,
    rr?: number,
    showSign: boolean = true
): string {
    const sign = showSign ? (value > 0 ? '+' : value < 0 ? '-' : '') : (value < 0 ? '-' : '');
    const absValue = Math.abs(value);

    switch (mode) {
        case 'percent':
            if (!accountBalance || accountBalance === 0) return `${sign}$${absValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
            const percent = (value / accountBalance) * 100;
            return `${sign}${Math.abs(percent).toFixed(2)}%`;

        case 'rr':
            if (rr === undefined || rr === null) {
                // Fallback to USD if RR is not available
                return `${sign}$${absValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
            }
            // RR is typically already signed appropriately (positive for win, negative for loss)
            const rrValue = value >= 0 ? Math.abs(rr) : -Math.abs(rr);
            return `${showSign ? (rrValue > 0 ? '+' : rrValue < 0 ? '-' : '') : ''}${Math.abs(rrValue).toFixed(2)}R`;

        case 'usd':
        default:
            return `${sign}$${absValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
    }
}

/**
 * Gets the unit label for the current display mode
 */
export function getPnLUnit(mode: PnLDisplayMode): string {
    switch (mode) {
        case 'percent': return '%';
        case 'rr': return 'R';
        case 'usd':
        default: return '$';
    }
}

/**
 * Calculates total RR for a set of trades
 */
export function calculateTotalRR(trades: Trade[]): number {
    return trades.reduce((sum, t) => {
        // If trade has RR data, use it
        if (t.riskAmount && t.riskAmount !== 0) {
            return sum + (t.pnl / t.riskAmount);
        }
        return sum;
    }, 0);
}
