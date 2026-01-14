
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
        // Remove surrounding quotes and any literal \n strings or real newlines
        val = val.replace(/^["']|["']$/g, '').replace(/\\n/g, '').trim();
        env[key.trim()] = val;
    }
});

console.log(`Connecting to: ${env['VITE_SUPABASE_URL']?.substring(0, 30)}...`);
console.log(`Key present: ${!!(env['SUPABASE_SERVICE_ROLE_KEY'] || env['VITE_SUPABASE_ANON_KEY'])}`);

const supabaseUrl = env['VITE_SUPABASE_URL'];
const supabaseKey = env['SUPABASE_SERVICE_ROLE_KEY'] || env['VITE_SUPABASE_ANON_KEY'];

if (!supabaseUrl || !supabaseKey) {
    console.error('Missing credentials');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function check() {
    // Check NQ
    const { count: nqCount, error: nqErr } = await supabase
        .from('candle_cache')
        .select('*', { count: 'exact', head: true })
        .eq('instrument', 'usatechidxusd');

    // Check ES
    const { count: esCount, error: esErr } = await supabase
        .from('candle_cache')
        .select('*', { count: 'exact', head: true })
        .eq('instrument', 'usa500idxusd');

    // Check sample NQ
    const { data: nqSample } = await supabase
        .from('candle_cache')
        .select('*')
        .eq('instrument', 'usatechidxusd')
        .limit(1);

    if (nqErr) console.error('NQ Error:', nqErr.message);
    if (esErr) console.error('ES Error:', esErr.message);

    console.log(`NQ COUNT: ${nqCount}`);
    console.log(`ES COUNT: ${esCount}`);
    console.log('Sample NQ Row:', JSON.stringify(nqSample, null, 2));
}

check();
