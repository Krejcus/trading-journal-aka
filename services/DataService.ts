import { supabase } from './supabase';

export interface SyncStats {
    count: number;
    minDate: string | null;
    maxDate: string | null;
}

export const DataService = {
    /**
     * Get statistics about cached data for an instrument
     */
    async getInstrumentStats(instrument: string): Promise<SyncStats> {
        // 1. Get exact total count (efficiently without fetching rows)
        const { count, error: countErr } = await supabase
            .from('candle_cache')
            .select('*', { count: 'exact', head: true })
            .eq('instrument', instrument);

        if (countErr || count === null || count === 0) {
            return { count: 0, minDate: null, maxDate: null };
        }

        // 2. Get min and max dates
        const { data: minData } = await supabase
            .from('candle_cache')
            .select('time')
            .eq('instrument', instrument)
            .order('time', { ascending: true })
            .limit(1);

        const { data: maxData } = await supabase
            .from('candle_cache')
            .select('time')
            .eq('instrument', instrument)
            .order('time', { ascending: false })
            .limit(1);

        return {
            count: count,
            minDate: minData?.[0]?.time || null,
            maxDate: maxData?.[0]?.time || null
        };
    },

    /**
     * Perform an incremental sync for an instrument
     * Bridges the gap between the last stored candle and 'now'
     */
    async syncIncremental(instrument: string, onStatus?: (msg: string) => void): Promise<void> {
        const stats = await this.getInstrumentStats(instrument);
        const now = new Date();

        let fromDate: Date;
        if (stats.maxDate) {
            fromDate = new Date(stats.maxDate);
            // Start from 1 minute after the last candle
            fromDate.setMinutes(fromDate.getMinutes() + 1);
        } else {
            // No data at all? Default to last 7 days
            fromDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        }

        if (fromDate >= now) {
            onStatus?.("Data is already up to date.");
            return;
        }

        onStatus?.(`Bridging gap: ${fromDate.toLocaleDateString()} -> Now`);
        await this.importHistory(instrument, fromDate, now, 1, onStatus);
    },

    /**
     * Import a large chunk of history
     */
    async importHistory(
        instrument: string,
        from: Date,
        to: Date,
        chunkSizeDays: number = 0.08, // Reduced to ~2 hours to survive extreme Vercel throttling
        onStatus?: (msg: string) => void,
        onProgress?: (progress: number) => void
    ): Promise<void> {
        const totalDuration = to.getTime() - from.getTime();
        let currentTo = new Date(to);
        let processedTime = 0;

        while (currentTo > from) {
            let currentFrom = new Date(currentTo.getTime() - chunkSizeDays * 24 * 60 * 60 * 1000);
            if (currentFrom < from) currentFrom = new Date(from);

            const fromIso = currentFrom.toISOString();
            const toIso = currentTo.toISOString();

            onStatus?.(`Syncing: ${currentFrom.toLocaleDateString()} - ${currentTo.toLocaleDateString()}`);

            let retries = 0;
            const maxRetries = 3;

            while (retries < maxRetries) {
                try {
                    const res = await fetch(`/api/candles?instrument=${instrument}&from=${fromIso}&to=${toIso}&timeframe=m1&force=true`);
                    const dbErr = res.headers.get('X-DB-Error');

                    if (!res.ok) {
                        const text = await res.text();
                        throw new Error(`API Error: ${res.status} - ${text.substring(0, 50)}`);
                    }
                    if (dbErr) {
                        throw new Error(`DB Error: ${dbErr}`);
                    }

                    // Success!
                    break;
                } catch (err: any) {
                    retries++;
                    console.error(`Chunk failed (Attempt ${retries}/${maxRetries}):`, err);
                    if (retries < maxRetries) {
                        onStatus?.(`Retrying chunk (${retries}/${maxRetries}): ${err.message}`);
                        await new Promise(r => setTimeout(r, 2000));
                    } else {
                        onStatus?.(`Skipping problematic day after ${maxRetries} failed attempts.`);
                    }
                }
            }

            processedTime += (currentTo.getTime() - currentFrom.getTime());
            onProgress?.(Math.min(100, Math.round((processedTime / totalDuration) * 100)));

            // Update for next iteration
            currentTo = new Date(currentFrom.getTime() - 1000);

            // Minimal pause to prevent overwhelming the browser/server
            await new Promise(r => setTimeout(r, 300));
        }

        onStatus?.("Sync complete.");
        onProgress?.(100);
    }
};
