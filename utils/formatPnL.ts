
import { PnLDisplayMode, Trade } from '../types';
export { calculateTotalRR } from './tradeRisk';

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
    rr?: number | null,
    showSign: boolean = true,
    currency: 'USD' | 'CZK' | 'EUR' = 'USD',
    rates?: any,
    decimals: 0 | 2 = 0
): string {
    const sign = showSign ? (value > 0 ? '+' : value < 0 ? '-' : '') : (value < 0 ? '-' : '');

    switch (mode) {
        case 'percent':
            if (!Number.isFinite(value)) return '—';
            if (!accountBalance || accountBalance === 0) return formatCurrency(value, currency, rates, showSign, decimals);
            const percent = (value / accountBalance) * 100;
            return `${sign}${Math.abs(percent).toFixed(2)}%`;

        case 'rr':
            if (rr === undefined || rr === null || !Number.isFinite(rr)) return '—';
            // Použij skutečné znaménko RR — USD a RR se mohou rozcházet (např. malé risky na ztrátách vs. velké na výhrách)
            return `${rr < 0 ? '-' : showSign && rr > 0 ? '+' : ''}${formatRMultiple(Math.abs(rr), 2)}R`;

        case 'usd':
        default:
            return formatCurrency(value, currency, rates, showSign, decimals);
    }
}

/**
 * Core currency formatter with optional conversion
 */
export function formatCurrency(
    usdAmount: number,
    to: 'USD' | 'CZK' | 'EUR' = 'USD',
    rates?: any,
    showSign: boolean = false,
    decimals: 0 | 2 = 0
): string {
    if (typeof usdAmount !== 'number' || !Number.isFinite(usdAmount)) return '—';
    const sign = showSign ? (usdAmount > 0 ? '+' : usdAmount < 0 ? '-' : '') : (usdAmount < 0 ? '-' : '');
    const absUsd = Math.abs(usdAmount);

    let converted = absUsd;
    let effectiveTo: 'USD' | 'CZK' | 'EUR' = to;
    if (to !== 'USD') {
        if (rates && typeof rates[to] === 'number' && Number.isFinite(rates[to]) && rates[to] > 0 && Number.isFinite(absUsd * rates[to])) {
            converted = absUsd * rates[to];
        } else {
            // Kurzy ještě nenačtené nebo chybí pro cílovou měnu → NEukazuj surovou USD částku
            // s cizím symbolem (např. "1234 Kč" kde 1234 jsou dolary). Spadni zpět na USD,
            // dokud kurzy nedorazí — radši správné dolary než zfalšovaná koruna.
            effectiveTo = 'USD';
        }
    }

    const symbols = { USD: '$', CZK: 'Kč', EUR: '€' };

    const formatted = converted.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    if (effectiveTo === 'CZK') return `${sign}${formatted} Kč`;
    return `${sign}${symbols[effectiveTo]}${formatted}`;
}


/** Journal imports contain net PnL, but do not yet carry a verified original
 * monetary risk. A later SL / legacy riskAmount must not manufacture an R value. */
export function formatTradePnL(
    trade: Pick<Trade, 'pnl' | 'copierTradeId'>,
    mode: PnLDisplayMode,
    accountBalance?: number,
    rr?: number | null,
    showSign: boolean = true,
    currency: 'USD' | 'CZK' | 'EUR' = 'USD',
    rates?: any,
): string {
    if (!Number.isFinite(trade.pnl)) return '—';
    const journal = trade.copierTradeId?.startsWith('journal:') === true;
    if (journal && (mode === 'rr' || (mode === 'percent' && (!Number.isFinite(accountBalance) || accountBalance! <= 0)))) return '—';
    return formatPnL(trade.pnl, mode, accountBalance, journal ? undefined : rr, showSign, currency, rates, journal ? 2 : 0);
}

export function getPnLUnit(mode: PnLDisplayMode, currency: 'USD' | 'CZK' | 'EUR' = 'USD'): string {
    switch (mode) {
        case 'percent': return '%';
        case 'rr': return 'R';
        default: return currency === 'CZK' ? 'Kč' : (currency === 'EUR' ? '€' : '$');
    }
}

/** Connection sharing has already converted R-only results on its read path.
 * Do not convert them a second time or label them as money. */
export function formatSharedPnL(value: number | null | undefined, unit: 'usd' | 'rr' | 'hidden' = 'usd',
    currency: 'USD' | 'CZK' | 'EUR' = 'USD', rates?: any): string {
    if (unit === 'hidden' || typeof value !== 'number' || !Number.isFinite(value)) return '—';
    return formatPnL(value, unit, undefined, unit === 'rr' ? value : undefined, true, currency, rates, 2);
}
