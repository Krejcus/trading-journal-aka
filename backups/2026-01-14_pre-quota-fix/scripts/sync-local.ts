
import { createClient } from '@supabase/supabase-js';
import { getHistoricRates } from 'dukascopy-node';
import fs from 'fs';
import path from 'path';

// Manually parse .env.local because dotenv is being finicky with tool environment
const envPath = path.resolve(process.cwd(), '.env.local');
let envContent = '';
try {
    envContent = fs.readFileSync(envPath, 'utf-8');
} catch (e) {
    console.error('Could not read .env.local');
    process.exit(1);
}

const env: Record<string, string> = {};
envContent.split('\n').forEach(line => {
    const part = line.trim();
    if (!part || part.startsWith('#')) return;
    const [key, ...rest] = part.split('=');
    if (key && rest.length > 0) {
        let val = rest.join('=').trim();
        val = val.replace(/^["']|["']$/g, '').replace(/\\n/g, '').trim();
        env[key.trim()] = val;
    }
});

const supabaseUrl = env['VITE_SUPABASE_URL'];
const supabaseKey = env['SUPABASE_SERVICE_ROLE_KEY'] || env['VITE_SUPABASE_ANON_KEY'];

if (!supabaseUrl || !supabaseKey) {
    console.error('Missing Supabase credentials in .env.local');
    process.exit(1);
}

console.log(`Connecting to: ${supabaseUrl.substring(0, 30)}...`);

const supabase = createClient(supabaseUrl, supabaseKey);

const instruments = [
    { symbol: 'NQ', duka: 'usatechidxusd' }
];

// Configuration
const DAYS_BACK = 730; // 2 Years
const CHUNK_SIZE_DAYS = 2; // Reduced to 2 days to prevent stalling

async function syncInstrument(inst: { symbol: string, duka: string }) {
    console.log(`\nStarting sync for ${inst.symbol} (${inst.duka})...`);

    const now = new Date();
    const startDate = new Date(now.getTime() - DAYS_BACK * 24 * 60 * 60 * 1000);

    let currentFrom = startDate;
    let totalCandles = 0;

    while (currentFrom < now) {
        let currentTo = new Date(currentFrom.getTime() + CHUNK_SIZE_DAYS * 24 * 60 * 60 * 1000);
        if (currentTo > now) currentTo = now;

        console.log(`Fetching ${inst.symbol}: ${currentFrom.toISOString().split('T')[0]} -> ${currentTo.toISOString().split('T')[0]}`);

        try {
            const data = await getHistoricRates({
                instrument: inst.duka as any,
                dates: { from: currentFrom, to: currentTo },
                timeframe: 'm1',
                format: 'json',
                useCache: false
            });

            if (data && data.length > 0) {
                const candlesToCache = data.map((d: any) => ({
                    instrument: inst.duka,
                    time: new Date(d.timestamp).toISOString(),
                    open: d.open,
                    high: d.high,
                    low: d.low,
                    close: d.close,
                    volume: d.volume || d.tickVolume || 0
                }));

                // Bulk Upsert
                const { error } = await supabase
                    .from('candle_cache')
                    .upsert(candlesToCache, { onConflict: 'instrument,time' });

                if (error) {
                    console.error(`Error saving batch: ${error.message}`);
                } else {
                    totalCandles += candlesToCache.length;
                    console.log(`  -> Saved ${candlesToCache.length} candles. Total: ${totalCandles}`);
                }
            } else {
                console.log(`  -> No data found for this period.`);
            }

        } catch (err: any) {
            console.error(`  -> Failed to fetch chunk: ${err.message}`);
        }

        // Move to next chunk
        currentFrom = currentTo;

        // Ethical pause to be nice to Dukascopy
        await new Promise(r => setTimeout(r, 500));
    }

    console.log(`\nCompleted ${inst.symbol}. Total candles synced: ${totalCandles}`);
}

async function main() {
    console.log('--- LOCAL DATA SYNC STARTED ---');
    console.log(`Target: ${DAYS_BACK} days history`);

    for (const inst of instruments) {
        await syncInstrument(inst);
    }

    console.log('\n--- ALL SYNC COMPLETED ---');
}

main();
