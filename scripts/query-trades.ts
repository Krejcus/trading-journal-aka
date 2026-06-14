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

const supabaseUrl = env.VITE_SUPABASE_URL;
const supabaseKey = env.VITE_SUPABASE_ANON_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

async function main() {
  const userId = '6fd09385-2400-4643-b6dc-9ab3b4a827cd'; // Filip

  const { data: trades, error } = await supabase
    .from('trades')
    .select('id, instrument, pnl, date, timestamp, signal, created_at, data')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error(error);
  } else {
    console.log(`Found ${trades.length} trades for Filip:`);
    trades.slice(0, 10).forEach(t => {
      console.log(`ID: ${t.id} | CreatedAt: ${t.created_at} | Date: ${t.date} | Inst: ${t.instrument} | PnL: ${t.pnl} | Signal: ${t.signal || t.data?.signal} | Entry: ${t.data?.entryPrice} | Exit: ${t.data?.exitPrice} | SL: ${t.data?.stopLoss}`);
    });
  }
}

main();
