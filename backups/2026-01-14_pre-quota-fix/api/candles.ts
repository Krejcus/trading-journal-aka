import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getHistoricRates, Config } from 'dukascopy-node';
import { createClient } from '@supabase/supabase-js';

// Initialize Supabase client for server-side use
const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY;

const supabase = createClient(supabaseUrl || '', supabaseKey || '');

export default async function handler(
    request: VercelRequest,
    response: VercelResponse
) {
    try {
        const { instrument, date, from, to, timeframe = 'm1' } = request.query;

        if (!instrument) {
            return response.status(400).json({ error: 'Missing instrument' });
        }

        let fromDate: Date;
        let toDate: Date;

        if (from && to) {
            fromDate = new Date(String(from));
            toDate = new Date(String(to));
        } else if (date) {
            const tradeDate = new Date(String(date));
            if (isNaN(tradeDate.getTime())) {
                return response.status(400).json({ error: 'Invalid date format' });
            }
            // Standard window for single trade view
            fromDate = new Date(tradeDate.getTime() - 2 * 60 * 60 * 1000);
            toDate = new Date(tradeDate.getTime() + 4 * 60 * 60 * 1000);
        } else {
            return response.status(400).json({ error: 'Missing date or from/to range' });
        }

        if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
            return response.status(400).json({ error: 'Invalid from/to date format' });
        }

        // Map instrument to Dukascopy format
        // Handle names like "NQ 12-25" or "EUR/USD" by taking the lead part
        const raw = String(instrument).toLowerCase();
        let basePart = raw.split(/[ \/\-_]/)[0];

        const map: Record<string, string> = {
            'nq': 'usatechidxusd',
            'mnq': 'usatechidxusd',
            'nasdaq': 'usatechidxusd',
            'es': 'usa500idxusd',
            'mes': 'usa500idxusd',
            'sp500': 'usa500idxusd',
            'eurusd': 'eurusd',
            'gbpusd': 'gbpusd',
            'xauusd': 'xauusd',
            'gold': 'xauusd',
            'btc': 'btcusd',
            'btcusd': 'btcusd',
        };

        let dukaInstrument = map[basePart] || basePart;

        // Final cleanup for symbols not in map (e.g. eurusd becomes eurusd anyway)
        if (!map[basePart]) {
            dukaInstrument = raw.replace(/[\/\-_ ]/g, '');
            if (map[dukaInstrument]) dukaInstrument = map[dukaInstrument];
        }

        const rawTf = String(timeframe || 'm1').toLowerCase();
        const tfMap: Record<string, string> = {
            '1m': 'm1', '5m': 'm5', '15m': 'm15', '1h': 'h1', '4h': 'h4', 'd': 'd1', 'w': 'w1'
        };
        const tf = tfMap[rawTf] || rawTf;
        const cacheKey = tf === 'm1' ? dukaInstrument : `${dukaInstrument}:${tf}`;

        // 1. Check Cache First
        // Increased PAGE_SIZE to 5000 to reduce CPU-heavy loop iterations
        let cachedData: any[] = [];
        let rangeFrom = fromDate.toISOString();
        let hasMore = true;
        const PAGE_SIZE = 5000;

        while (hasMore && cachedData.length < 50000) {
            const { data: page, error: pageError } = await supabase
                .from('candle_cache')
                .select('time, open, high, low, close, volume')
                .eq('instrument', cacheKey)
                .gte('time', rangeFrom)
                .lte('time', toDate.toISOString())
                .order('time', { ascending: true })
                .limit(PAGE_SIZE);

            if (pageError) {
                console.error(`[Cache] Page fetch error for ${cacheKey}:`, pageError);
                break;
            }

            if (!page || page.length === 0) {
                hasMore = false;
            } else {
                const prevCount = cachedData.length;
                if (cachedData.length > 0 && page[0].time === rangeFrom) {
                    cachedData.push(...page.slice(1));
                } else {
                    cachedData.push(...page);
                }

                if (page.length < PAGE_SIZE) {
                    hasMore = false;
                } else {
                    rangeFrom = page[page.length - 1].time;
                    // Safety: if we didn't add any new data but page was full, something is wrong (duplicate timestamps)
                    // Move the cursor slightly forward to break potential infinite loop
                    if (cachedData.length === prevCount) {
                        const nextDt = new Date(rangeFrom);
                        nextDt.setSeconds(nextDt.getSeconds() + 1);
                        rangeFrom = nextDt.toISOString();
                    }
                }
            }
        }

        // Calculate expected count based on timeframe
        const diffMs = (toDate.getTime() - fromDate.getTime());
        let frameMs = 60000; // m1
        if (tf === 'm5') frameMs = 5 * 60000;
        if (tf === 'm15') frameMs = 15 * 60000;
        if (tf === 'h1') frameMs = 60 * 60000;
        if (tf === 'h4') frameMs = 4 * 60 * 60000;
        if (tf === 'd1' || tf === 'd') frameMs = 24 * 60 * 60000;
        if (tf === 'w1' || tf === 'w') frameMs = 7 * 24 * 60 * 60000;

        const expectedCount = Math.floor(diffMs / frameMs);

        // Heuristic:
        // 1. Force Sync (Repair Tool): Skip cache, go to Dukascopy.
        // 2. Normal Usage (Speed): If we have > 90% of data (or substantial amount for large range), trust cache.
        const isForce = request.query.force === 'true';
        const isCacheOnly = request.query.cacheOnly === 'true';

        const coverage = (cachedData && expectedCount > 0) ? (cachedData.length / expectedCount) : 0;

        // Weekend Detection: Only trigger for short ranges (e.g. < 4 days) and very few candles
        const isShortRange = diffMs < 4 * 24 * 60 * 60 * 1000;
        const isLikelyWeekend = isShortRange && expectedCount > 100 && cachedData && (cachedData.length < 20);

        // Final decision:
        // - Force: always fetch.
        // - CacheOnly: always HIT (never fetch).
        // - Middle of Gap: If it's a huge request (> 1 day) and we have < 10%, it's a real gap.
        const isLargeGap = expectedCount > 1000 && coverage < 0.1;

        // isFastHit is TRUE if:
        // - We have > 90% coverage
        // - OR we have > 1000 candles (substantial block) AND coverage is decent (>70%)
        const isFastHit = cachedData && (coverage > 0.9 || (cachedData.length > 1000 && coverage > 0.7));

        if (isCacheOnly || (!isForce && (isFastHit || isLikelyWeekend))) {
            console.log(`[Cache] HIT for ${cacheKey} (${cachedData.length}/${expectedCount}) ${isCacheOnly ? '[Cache-Only]' : ''}`);
            const transformed = cachedData.map(d => ({
                time: new Date(d.time).getTime() / 1000,
                open: d.open,
                high: d.high,
                low: d.low,
                close: d.close,
                volume: d.volume
            }));

            // CDN CACHING STRATEGY:
            // If the data is older than 1 day, it's immutable (Historical). Cache for 1 year in CDN.
            // If it's fresh data, cache for 1 minute to allow updates.
            const isHistorical = toDate.getTime() < Date.now() - 24 * 60 * 60 * 1000;
            if (isHistorical) {
                response.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=31536000, immutable');
            } else {
                response.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60, stale-while-revalidate=30');
            }

            response.setHeader('X-Cache-Status', 'HIT');
            return response.status(200).json(transformed);
        }

        // 2. Fetch from Dukascopy
        const startFetch = Date.now();
        console.log(`[Cache] MISS for ${cacheKey} (Expected ${expectedCount}, got ${cachedData?.length || 0}). Fetching from Dukascopy...`);
        response.setHeader('X-Cache-Status', 'MISS');

        const config: Config = {
            instrument: dukaInstrument as any,
            dates: {
                from: fromDate,
                to: toDate,
            },
            timeframe: (tf === 'd' ? 'd1' : tf) as any,
            format: 'json',
            useCache: false
        };

        const data = await getHistoricRates(config);
        const fetchTime = Date.now() - startFetch;

        if (!data || !Array.isArray(data) || data.length === 0) {
            console.log(`[Dukascopy] Empty result for ${cacheKey} after ${fetchTime}ms`);
            if (cachedData && cachedData.length > 0) {
                const transformed = cachedData.map(d => ({
                    time: new Date(d.time).getTime() / 1000,
                    open: d.open,
                    high: d.high,
                    low: d.low,
                    close: d.close,
                    volume: d.volume
                }));
                return response.status(200).json(transformed);
            }
            return response.status(200).json([]);
        }

        // 3. Save to Cache
        const startDb = Date.now();
        const candlesToCache = data.map((d: any) => ({
            instrument: cacheKey,
            time: new Date(d.timestamp).toISOString(),
            open: d.open,
            high: d.high,
            low: d.low,
            close: d.close,
            volume: d.volume || d.tickVolume || 0
        }));

        // Single bulk upsert is faster for m1 (1 day = 1440 rows max)
        const { error: upsertError } = await supabase
            .from('candle_cache')
            .upsert(candlesToCache, { onConflict: 'instrument,time' });

        const dbTime = Date.now() - startDb;

        response.setHeader('X-Debug-Fetch-Time', `${fetchTime}ms`);
        response.setHeader('X-Debug-DB-Time', `${dbTime}ms`);

        if (upsertError) {
            console.error(`[Cache] DB Sync error for ${dukaInstrument}:`, upsertError);
            response.setHeader('X-DB-Error', upsertError.message);
        }

        console.log(`[Dukascopy] Success: ${Array.isArray(data) ? data.length : 0} candles for ${tf}. (Fetch: ${fetchTime}ms, DB: ${dbTime}ms)`);

        const candles = Array.isArray(data) ? data.map((d: any) => ({
            time: d.timestamp / 1000,
            open: d.open,
            high: d.high,
            low: d.low,
            close: d.close,
            volume: d.tickVolume || 0
        })) : [];

        return response.status(200).json(candles);

    } catch (error: any) {
        console.error('Dukascopy fetch error:', error);
        return response.status(500).json({ error: 'Failed to fetch data', details: error.message });
    }
}
