
import { PnLDisplayMode, Trade, Account } from '../types';

/**
 * Formats PnL value based on the selected display mode.
 */
export function formatPnL(
    value: number,
    mode: PnLDisplayMode,
    accountBalance?: number,
    rr?: number,
    showSign: boolean = true,
    currency: 'USD' | 'CZK' | 'EUR' = 'USD',
    rates?: any
): string {
    const sign = showSign ? (value > 0 ? '+' : value < 0 ? '-' : '') : (value < 0 ? '-' : '');
    const absValue = Math.abs(value);

    switch (mode) {
        case 'percent':
            if (!accountBalance || accountBalance === 0) return formatCurrency(value, currency, rates, showSign);
            const percent = (value / accountBalance) * 100;
            return `${sign}${Math.abs(percent).toFixed(2)}%`;

        case 'rr':
            if (rr === undefined || rr === null) {
                return formatCurrency(value, currency, rates, showSign);
            }
            const rrValue = value >= 0 ? Math.abs(rr) : -Math.abs(rr);
            return `${showSign ? (rrValue > 0 ? '+' : rrValue < 0 ? '-' : '') : ''}${Math.abs(rrValue).toFixed(2)}R`;

        case 'usd':
        default:
            return formatCurrency(value, currency, rates, showSign);
    }
}

/**
 * Core currency formatter with optional conversion
 */
export function formatCurrency(
    usdAmount: number,
    to: 'USD' | 'CZK' | 'EUR' = 'USD',
    rates?: any,
    showSign: boolean = false
): string {
    const sign = showSign ? (usdAmount > 0 ? '+' : usdAmount < 0 ? '-' : '') : (usdAmount < 0 ? '-' : '');
    const absUsd = Math.abs(usdAmount);

    let converted = absUsd;
    if (rates && rates[to]) {
        converted = absUsd * rates[to];
    }

    const symbols = { USD: '$', CZK: 'Kč', EUR: '€' };

    if (to === 'CZK') {
        return `${sign}${Math.round(converted).toLocaleString()} Kč`;
    }

    const rounded = Math.round(converted);
    return `${sign}${symbols[to]}${rounded.toLocaleString()}`;
}

export function getPnLUnit(mode: PnLDisplayMode, currency: 'USD' | 'CZK' | 'EUR' = 'USD'): string {
    switch (mode) {
        case 'percent': return '%';
        case 'rr': return 'R';
        default: return currency === 'CZK' ? 'Kč' : (currency === 'EUR' ? '€' : '$');
    }
}

export function calculateTotalRR(trades: Trade[]): number {
    return trades.reduce((sum, t) => {
        if (t.riskAmount && t.riskAmount !== 0) {
            return sum + (t.pnl / t.riskAmount);
        }
        return sum;
    }, 0);
}
