
import { Trade } from '../types';

export const prefetchService = {
    /**
     * Prefetches candle data for a trade to warm up the cache.
     * Fetches both m1 and m5 (if supported by API) for the trade's time window.
     */
    async prefetchCandles(trade: Trade) {
        if (!trade.instrument || !trade.date) return;

        console.log(`[Prefetch] Warming cache for ${trade.instrument} on ${trade.date}`);

        try {
            // Trigger prefetch for the trade window (2h before, 4h after is standard)
            // We call the API which will handle the fetching and caching
            const instrument = trade.instrument.toLowerCase().replace(/[\/\-_]/g, '');
            const date = trade.date;

            // Fetch m1 data
            await fetch(`/api/candles?instrument=${instrument}&date=${date}&timeframe=m1`);

            // Optionally fetch a larger range or other timeframes if needed
            // await fetch(`/api/candles?instrument=${instrument}&date=${date}&timeframe=m5`);

            console.log(`[Prefetch] Success for ${trade.instrument}`);
        } catch (error) {
            console.warn(`[Prefetch] Failed for ${trade.instrument}:`, error);
        }
    },

    /**
     * Prefetches multiple trades sequentially to avoid overwhelming the server.
     */
    async prefetchMultiple(trades: Trade[]) {
        for (const trade of trades) {
            await this.prefetchCandles(trade);
            // Small delay to be polite
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }
};
