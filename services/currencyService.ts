
export interface ExchangeRates {
    USD: number;
    CZK: number;
    EUR: number;
    timestamp: number;
    source?: 'live' | 'fallback' | 'stale-cache';
}

const CACHE_KEY = 'trader_exchange_rates';
const CACHE_DURATION = 1000 * 60 * 60 * 6; // 6 hours

export const currencyService = {
    async getRates(): Promise<ExchangeRates> {
        const cached = localStorage.getItem(CACHE_KEY);
        if (cached) {
            const data: ExchangeRates = JSON.parse(cached);
            if (Date.now() - data.timestamp < CACHE_DURATION) {
                return data;
            }
        }

        try {
            const endpoint = import.meta.env.DEV
                ? 'https://api.frankfurter.app/latest?from=USD&to=CZK,EUR'
                : '/api/exchange-rates';
            const response = await fetch(endpoint, { signal: AbortSignal.timeout(5000) });
            if (!response.ok) throw new Error(`Exchange-rate API returned ${response.status}`);
            const result = await response.json();
            const sourceRates = result.rates ?? result;
            if (!Number.isFinite(sourceRates.CZK) || !Number.isFinite(sourceRates.EUR)) {
                throw new Error('Exchange-rate API returned invalid data');
            }

            const rates: ExchangeRates = {
                USD: 1,
                CZK: sourceRates.CZK,
                EUR: sourceRates.EUR,
                timestamp: Date.now(),
                source: result.source ?? 'live'
            };

            localStorage.setItem(CACHE_KEY, JSON.stringify(rates));
            return rates;
        } catch (err) {
            console.error("Failed to fetch exchange rates.", err);
            if (cached) {
                const stale = JSON.parse(cached) as ExchangeRates;
                return { ...stale, source: 'stale-cache' };
            }
            return {
                USD: 1,
                CZK: 24.50,
                EUR: 0.92,
                timestamp: Date.now(),
                source: 'fallback'
            };
        }
    },

    convert(amount: number, to: 'USD' | 'CZK' | 'EUR', rates: ExchangeRates): number {
        if (!rates) return amount;
        return amount * rates[to];
    },

    format(amount: number, currency: 'USD' | 'CZK' | 'EUR'): string {
        const symbols = {
            USD: '$',
            CZK: 'Kč',
            EUR: '€'
        };

        if (currency === 'CZK') {
            return `${Math.round(amount).toLocaleString()} Kč`;
        }

        return `${symbols[currency]}${Math.round(amount).toLocaleString()}`;
    }
};
