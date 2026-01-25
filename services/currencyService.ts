
export interface ExchangeRates {
    USD: number;
    CZK: number;
    EUR: number;
    timestamp: number;
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
            // Using a free, no-key API (Frankfurter)
            const response = await fetch('https://api.frankfurter.app/latest?from=USD&to=CZK,EUR');
            const result = await response.json();

            const rates: ExchangeRates = {
                USD: 1,
                CZK: result.rates.CZK,
                EUR: result.rates.EUR,
                timestamp: Date.now()
            };

            localStorage.setItem(CACHE_KEY, JSON.stringify(rates));
            return rates;
        } catch (err) {
            console.error("Failed to fetch exchange rates, using fallbacks.", err);
            // Dynamic fallbacks (roughly current)
            return {
                USD: 1,
                CZK: 24.50,
                EUR: 0.92,
                timestamp: Date.now()
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
