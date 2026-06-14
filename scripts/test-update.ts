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
  const userId = '6fd09385-2400-4643-b6dc-9ab3b4a827cd'; // Filip
  const tradeId = 'f2d0a42f-353b-49a9-924a-82313cf30732'; // The target trade

  console.log("Fetching current trade...");
  const { data: current, error: getErr } = await supabase
    .from('trades')
    .select('*')
    .eq('id', tradeId)
    .eq('user_id', userId)
    .single();

  if (getErr) {
    console.error("GET ERROR:", getErr);
    return;
  }

  console.log("Current trade PnL:", current.pnl);
  console.log("Current exitPrice in data:", current.data?.exitPrice);

  // Simulate update to 0.5R:
  // For MNQ short, entry=29634.25, sl=29666, size=1.
  // 0.5R should be: exit = 29634.25 - 0.5 * (29666 - 29634.25) = 29618.375
  const newExitPrice = 29618.375;
  const newPnL = 32.5; // 0.5 * 65 risk

  const updatedData = {
    ...current.data,
    exitPrice: newExitPrice,
    pnl: newPnL
  };

  const rootUpdate = {
    pnl: newPnL,
    data: updatedData
  };

  console.log("Updating trade...");
  const { data: updateRes, error: updateErr } = await supabase
    .from('trades')
    .update(rootUpdate)
    .eq('id', tradeId)
    .eq('user_id', userId)
    .select();

  if (updateErr) {
    console.error("UPDATE ERROR:", updateErr);
  } else {
    console.log("Update SUCCESS! Returned:", JSON.stringify(updateRes, null, 2));
  }
}

main();
