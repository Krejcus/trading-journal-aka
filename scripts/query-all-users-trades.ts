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
  const { data: trades, error } = await supabase
    .from('trades')
    .select('id, user_id, instrument, pnl, date, timestamp, signal, created_at, data')
    .order('created_at', { ascending: false })
    .limit(5);

  if (error) {
    console.error(error);
  } else {
    console.log("Latest trades in database across all users:");
    trades.forEach(t => {
      console.log(`ID: ${t.id} | User: ${t.user_id} | CreatedAt: ${t.created_at} | Date: ${t.date} | Inst: ${t.instrument} | PnL: ${t.pnl} | Signal: ${t.signal || t.data?.signal} | Entry: ${t.data?.entryPrice} | Exit: ${t.data?.exitPrice} | SL: ${t.data?.stopLoss}`);
    });
  }
}

main();
