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
            // Fallback: 2 hours before, 4 hours after (preserve existing behavior for single trade view)
            fromDate = new Date(tradeDate.getTime() - 2 * 60 * 60 * 1000);
            toDate = new Date(tradeDate.getTime() + 4 * 60 * 60 * 1000);
        } else {
            return response.status(400).json({ error: 'Missing date or from/to range' });
        }

        if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
            return response.status(400).json({ error: 'Invalid from/to date format' });
        }

        // Map instrument to Dukascopy format
        let dukaInstrument = String(instrument).toLowerCase().replace('/', '').replace('-', '');
        const map: Record<string, string> = {
            'nq': 'usatechidxusd',
            'mnq': 'usatechidxusd',
            'es': 'usa500idxusd',
            'mes': 'usa500idxusd',
            'eurusd': 'eurusd',
            'gbpusd': 'gbpusd',
            'xauusd': 'xauusd',
            'gold': 'xauusd',
            'btc': 'btcusd',
            'btcusd': 'btcusd',
        };

        if (map[dukaInstrument]) {
            dukaInstrument = map[dukaInstrument];
        }

        // 1. Check Cache First
        const { data: cachedData, error: cacheError } = await supabase
            .from('candle_cache')
            .select('time, open, high, low, close, volume')
            .eq('instrument', dukaInstrument)
            .gte('time', fromDate.toISOString())
            .lte('time', toDate.toISOString())
            .order('time', { ascending: true });

        // Heuristic for cache completeness:
        // m1 = 60s per candle.
        // We allow some missing candles (holidays, gaps) but if we have > 75% of expected, use cache.
        // For larger ranges, this is more efficient.
        const expectedSeconds = (toDate.getTime() - fromDate.getTime()) / 1000;
        const expectedCount = Math.floor(expectedSeconds / 60);

        if (!cacheError && cachedData && cachedData.length >= expectedCount * 0.75 && expectedCount > 0) {
            // console.log(`Cache hit for ${dukaInstrument}: ${cachedData.length} / ${expectedCount} expected candles`);
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

        // 2. Fetch from Dukascopy if cache miss or too small
        const config: Config = {
            instrument: dukaInstrument as any,
            dates: {
                from: fromDate,
                to: toDate,
            },
            timeframe: 'm1',
            format: 'json',
            useCache: false
        };

        const data = await getHistoricRates(config);

        if (!data || data.length === 0) {
            return response.status(200).json([]);
        }

        // 3. Save to Cache
        const candlesToCache = data.map((d: any) => ({
            instrument: dukaInstrument,
            time: new Date(d.timestamp).toISOString(),
            open: d.open,
            high: d.high,
            low: d.low,
            close: d.close,
            volume: d.tickVolume
        }));

        // Use upsert to avoid duplicate keys error
        const { error: upsertError } = await supabase.from('candle_cache').upsert(candlesToCache, { onConflict: 'instrument,time' });
        if (upsertError) {
            console.error('Failed to update candle cache:', upsertError);
        }

        const candles = data.map((d: any) => ({
            time: d.timestamp / 1000,
            open: d.open,
            high: d.high,
            low: d.low,
            close: d.close,
            volume: d.tickVolume
        }));

        return response.status(200).json(candles);

    } catch (error: any) {
        console.error('Dukascopy range fetch error:', error);
        return response.status(500).json({
            error: 'Failed to fetch data',
            details: error.message
        });
    }
}
