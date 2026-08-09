import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

const fileEnv: Record<string, string> = {};
const envPath = path.resolve(process.cwd(), '.env.local');
if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf-8').split('\n').forEach(line => {
        const part = line.trim();
        if (!part || part.startsWith('#')) return;
        const [key, ...rest] = part.split('=');
        if (!key || rest.length === 0) return;
        fileEnv[key.trim()] = rest.join('=').trim().replace(/^["']|["']$/g, '').replace(/\\n/g, '').trim();
    });
}

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || fileEnv.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || fileEnv.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error('Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in the environment or .env.local');
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

async function main() {
    const userId = '6fd09385-2400-4643-b6dc-9ab3b4a827cd';
    console.log(`Fetching accounts for user: ${userId}`);

    const { data, error } = await supabase
        .from('accounts')
        .select('*')
        .eq('user_id', userId);

    if (error) {
        console.error('Error:', error);
        return;
    }

    console.log('Accounts:', JSON.stringify(data, null, 2));
}

main();
