/**
 * CandleCache - IndexedDB wrapper for local candle storage
 * Provides instant access to historical candle data
 */

import { get, set, keys, del } from 'idb-keyval';

export interface CachedCandle {
    time: number;  // Unix timestamp in seconds
    open: number;
    high: number;
    low: number;
    close: number;
    volume?: number;
}

export interface CandleCacheInfo {
    instrument: string;
    timeframe: string;
    fromTime: number;
    toTime: number;
    count: number;
}

// Cache key format: candles:{instrument}:{timeframe}
// Value: { data: CachedCandle[], fromTime: number, toTime: number }

const CACHE_PREFIX = 'candles:';

/**
 * Get candles from local IndexedDB cache
 */
export async function getCandlesFromLocal(
    instrument: string,
    timeframe: string,
    from: number,  // Unix seconds
    to: number     // Unix seconds
): Promise<CachedCandle[] | null> {
    const key = `${CACHE_PREFIX}${instrument}:${timeframe}`;

    try {
        const cached = await get(key) as { data: CachedCandle[], fromTime: number, toTime: number } | undefined;

        if (!cached || !cached.data || cached.data.length === 0) {
            return null;
        }

        // Check if cached range covers requested range
        // Allow 10% tolerance for edge cases
        const tolerance = (to - from) * 0.1;
        if (cached.fromTime > from + tolerance || cached.toTime < to - tolerance) {
            console.log(`[CandleCache] Partial miss: cached ${cached.fromTime}-${cached.toTime}, requested ${from}-${to}`);
            // Still return data if we have significant overlap
            const overlappingData = cached.data.filter(c => c.time >= from && c.time <= to);
            if (overlappingData.length > 10) {
                return overlappingData;
            }
            return null;
        }

        // Filter to requested range
        const filtered = cached.data.filter(c => c.time >= from && c.time <= to);
        console.log(`[CandleCache] HIT for ${instrument}:${timeframe} - ${filtered.length} candles`);
        return filtered;

    } catch (err) {
        console.error('[CandleCache] Error reading from IndexedDB:', err);
        return null;
    }
}

/**
 * Store candles to local IndexedDB cache
 */
export async function setCandlesToLocal(
    instrument: string,
    timeframe: string,
    data: CachedCandle[]
): Promise<void> {
    if (!data || data.length === 0) return;

    const key = `${CACHE_PREFIX}${instrument}:${timeframe}`;

    try {
        // Get existing data to merge
        const existing = await get(key) as { data: CachedCandle[], fromTime: number, toTime: number } | undefined;

        let mergedData: CachedCandle[];
        let fromTime: number;
        let toTime: number;

        if (existing && existing.data && existing.data.length > 0) {
            // Merge: combine existing and new, dedupe by time
            const timeMap = new Map<number, CachedCandle>();

            for (const candle of existing.data) {
                timeMap.set(candle.time, candle);
            }
            for (const candle of data) {
                timeMap.set(candle.time, candle);
            }

            mergedData = Array.from(timeMap.values()).sort((a, b) => a.time - b.time);
            fromTime = Math.min(existing.fromTime, data[0].time);
            toTime = Math.max(existing.toTime, data[data.length - 1].time);
        } else {
            mergedData = data.sort((a, b) => a.time - b.time);
            fromTime = data[0].time;
            toTime = data[data.length - 1].time;
        }

        await set(key, { data: mergedData, fromTime, toTime });
        console.log(`[CandleCache] Stored ${mergedData.length} candles for ${instrument}:${timeframe}`);

    } catch (err) {
        console.error('[CandleCache] Error writing to IndexedDB:', err);
    }
}

/**
 * Get cache coverage info for an instrument
 */
export async function getCacheInfo(): Promise<CandleCacheInfo[]> {
    try {
        const allKeys = await keys();
        const candleKeys = allKeys.filter(k => String(k).startsWith(CACHE_PREFIX));

        const infos: CandleCacheInfo[] = [];

        for (const key of candleKeys) {
            const parts = String(key).replace(CACHE_PREFIX, '').split(':');
            if (parts.length >= 2) {
                const cached = await get(key) as { data: CachedCandle[], fromTime: number, toTime: number } | undefined;
                if (cached && cached.data) {
                    infos.push({
                        instrument: parts[0],
                        timeframe: parts[1],
                        fromTime: cached.fromTime,
                        toTime: cached.toTime,
                        count: cached.data.length
                    });
                }
            }
        }

        return infos;

    } catch (err) {
        console.error('[CandleCache] Error getting cache info:', err);
        return [];
    }
}

/**
 * Clear all candle cache
 */
export async function clearCandleCache(): Promise<void> {
    try {
        const allKeys = await keys();
        const candleKeys = allKeys.filter(k => String(k).startsWith(CACHE_PREFIX));

        for (const key of candleKeys) {
            await del(key);
        }

        console.log(`[CandleCache] Cleared ${candleKeys.length} cache entries`);
    } catch (err) {
        console.error('[CandleCache] Error clearing cache:', err);
    }
}

/**
 * Get total cache size in bytes (approximate)
 */
export async function getCacheSizeBytes(): Promise<number> {
    try {
        const allKeys = await keys();
        const candleKeys = allKeys.filter(k => String(k).startsWith(CACHE_PREFIX));

        let totalSize = 0;
        for (const key of candleKeys) {
            const cached = await get(key);
            if (cached) {
                // Rough estimate: stringify and get length
                totalSize += JSON.stringify(cached).length;
            }
        }

        return totalSize;
    } catch (err) {
        console.error('[CandleCache] Error calculating cache size:', err);
        return 0;
    }
}
