
import { PnLDisplayMode, Trade, Account } from '../types';

/**
 * Formats PnL value based on the selected display mode.
 */
/**
 * Formats an R-multiple, dropping the decimal when the rounded value is a whole number
 * (12.00 -> "12" instead of "12.00"). Sign is NOT added here — callers prepend it.
 */
export function formatRMultiple(value: number, decimals: number = 2): string {
    const rounded = Number(value.toFixed(decimals));
    return Number.isInteger(rounded) ? rounded.toString() : rounded.toFixed(decimals);
}

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
            // Použij skutečné znaménko RR — USD a RR se mohou rozcházet (např. malé risky na ztrátách vs. velké na výhrách)
            return `${showSign ? (rr > 0 ? '+' : rr < 0 ? '-' : '') : ''}${formatRMultiple(Math.abs(rr), 2)}R`;

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
    let effectiveTo: 'USD' | 'CZK' | 'EUR' = to;
    if (to !== 'USD') {
        if (rates && rates[to]) {
            converted = absUsd * rates[to];
        } else {
            // Kurzy ještě nenačtené nebo chybí pro cílovou měnu → NEukazuj surovou USD částku
            // s cizím symbolem (např. "1234 Kč" kde 1234 jsou dolary). Spadni zpět na USD,
            // dokud kurzy nedorazí — radši správné dolary než zfalšovaná koruna.
            effectiveTo = 'USD';
        }
    }

    const symbols = { USD: '$', CZK: 'Kč', EUR: '€' };

    if (effectiveTo === 'CZK') {
        return `${sign}${Math.round(converted).toLocaleString()} Kč`;
    }

    const rounded = Math.round(converted);
    return `${sign}${symbols[effectiveTo]}${rounded.toLocaleString()}`;
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
