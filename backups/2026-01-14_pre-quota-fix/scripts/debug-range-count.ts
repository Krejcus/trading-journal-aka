
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

const envPath = path.resolve(process.cwd(), '.env.local');
let envContent = fs.readFileSync(envPath, 'utf-8');
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

async function check() {
    const from = '2024-12-01T00:00:00Z';
    const to = '2024-12-30T23:59:59Z';

    // Check total count in range
    const { count, error } = await supabase
        .from('candle_cache')
        .select('*', { count: 'exact', head: true })
        .eq('instrument', 'usatechidxusd')
        .gte('time', from)
        .lte('time', to);

    console.log(`NQ Candles in range Dec 1-30, 2024: ${count}`);
    if (error) console.error('Error:', error.message);

    // Check how many we get without limit
    const { data } = await supabase
        .from('candle_cache')
        .select('time')
        .eq('instrument', 'usatechidxusd')
        .gte('time', from)
        .lte('time', to)
        .limit(50000);

    console.log(`Data rows returned with limit 50000: ${data?.length}`);
}

check();
