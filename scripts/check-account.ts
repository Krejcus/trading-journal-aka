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
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY || fileEnv.VITE_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY in the environment or .env.local');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const accountId = '1fe507d1-5610-4510-85a9-39e31af84131';

async function checkAccount() {
  const { data, error } = await supabase
    .from('accounts')
    .select('*')
    .eq('id', accountId)
    .single();

  if (error) {
    console.error('Error:', error);
  } else {
    console.log('Account info:');
    console.log('  Name:', data.name);
    console.log('  Type:', data.type);
    console.log('  Phase:', data.phase);
    console.log('  Status:', data.status);
  }
}

checkAccount();
