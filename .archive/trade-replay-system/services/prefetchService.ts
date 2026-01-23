
import { Trade } from '../types';

export const prefetchService = {
    /**
     * Prefetches candle data for a trade to warm up the cache.
     * Fetches both m1 and m5 (if supported by API) for the trade's time window.
     */
    async prefetchCandles(trade: Trade) {
        // Disabled to save Vercel Usage (Quota limit reached)
        // if (!trade.instrument || !trade.date) return;
        // console.log(`[Prefetch] Warming cache for ${trade.instrument} on ${trade.date}`);
        return;
    },

    async prefetchMultiple(trades: Trade[]) {
        // Disabled to save Vercel Usage
        return;
    }
};
