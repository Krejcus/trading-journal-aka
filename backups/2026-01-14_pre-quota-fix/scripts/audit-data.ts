
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

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

const supabase = createClient(supabaseUrl, supabaseKey);

async function audit() {
    console.log('--- NQ DATA AUDIT ---');

    // 1. Exact Count
    const { count, error: countErr } = await supabase
        .from('candle_cache')
        .select('*', { count: 'exact', head: true })
        .eq('instrument', 'usatechidxusd');

    if (countErr) {
        console.error('Count Error:', countErr.message);
        return;
    }

    // 2. Sample Start and End
    const { data: startRows } = await supabase
        .from('candle_cache')
        .select('time')
        .eq('instrument', 'usatechidxusd')
        .order('time', { ascending: true })
        .limit(1);

    const { data: endRows } = await supabase
        .from('candle_cache')
        .select('time')
        .eq('instrument', 'usatechidxusd')
        .order('time', { ascending: false })
        .limit(1);

    console.log(`Summary:`);
    console.log(`- Total Candles (Exact): ${count}`);
    console.log(`- First Candle: ${startRows?.[0]?.time}`);
    console.log(`- Last Candle:  ${endRows?.[0]?.time}`);

    if (count === 0) return;

    // 3. Check for specific gaps in the LAST 2 DAYS specifically
    console.log('\nChecking for consistency in the last 48 hours...');
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const { data: recentData } = await supabase
        .from('candle_cache')
        .select('time')
        .eq('instrument', 'usatechidxusd')
        .gte('time', twoDaysAgo)
        .order('time', { ascending: true })
        .limit(5000); // Try to get more than 1000

    // 2. Check for gaps in the last 30 days
    console.log('\nChecking for gaps in last 30 days (excluding weekends)...');
    let gaps_found = 0;
    for (let i = 1; i < stats.length; i++) {
        const t1 = new Date(stats[i - 1].time).getTime();
        const t2 = new Date(stats[i].time).getTime();
        const diffMin = (t2 - t1) / (1000 * 60);

        // Limit to last 30 days for this check
        const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
        if (t1 < thirtyDaysAgo) continue;

        if (diffMin > 15) {
            const d1 = new Date(t1);
            const day = d1.getDay();
            // Skip weekend gaps (Fri 22:00 to Sun 22:00 UTC approx)
            const isWeekend = (day === 5 && d1.getHours() >= 21) || day === 6 || (day === 0 && d1.getHours() < 21);

            if (!isWeekend) {
                console.log(`  [GAP] ${diffMin.toFixed(0)}m gap at ${d1.toISOString()}`);
                gaps_found++;
                if (gaps_found > 10) {
                    console.log('  ... and many more.');
                    break;
                }
            }
        }
    }

    if (gaps_found === 0) console.log('✅ No significant gaps found in the last 30 days!');
}

audit();
