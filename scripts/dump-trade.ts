import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

const envPath = path.resolve(process.cwd(), '.env.local');
const envContent = fs.readFileSync(envPath, 'utf-8');
const env: Record<string, string> = {};
envContent.split('\n').forEach(line => {
  const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
  if (match) {
    env[match[1]] = (match[2] || '').trim().replace(/^['"]|['"]$/g, '');
  }
});

const supabase = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY);

async function main() {
  const tradeId = 'f2d0a42f-353b-49a9-924a-82313cf30732';

  const { data: trade, error } = await supabase
    .from('trades')
    .select('*')
    .eq('id', tradeId)
    .single();

  if (error) {
    console.error(error);
  } else {
    console.log("Raw trade record from Supabase:");
    console.log(JSON.stringify(trade, null, 2));
  }
}

main();
