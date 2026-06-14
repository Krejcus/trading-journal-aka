import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

// Load env from .env.local
const envPath = path.resolve(process.cwd(), '.env.local');
const envContent = fs.readFileSync(envPath, 'utf-8');
const supabaseUrl = envContent.match(/VITE_SUPABASE_URL=(.+)/)?.[1].trim() || '';
const supabaseKey = envContent.match(/VITE_SUPABASE_ANON_KEY=(.+)/)?.[1].trim() || '';

const supabase = createClient(supabaseUrl, supabaseKey);

async function run() {
  const { data: { session } } = await supabase.auth.getSession();
  
  // Fetch trades
  const { data: trades } = await supabase.from('trades').select('*');
  const { data: accounts } = await supabase.from('accounts').select('*');
  const { data: rules } = await supabase.from('iron_rules').select('*');
  const { data: playbook } = await supabase.from('playbook').select('*');
  const { data: preps } = await supabase.from('daily_preps').select('*');
  const { data: reviews } = await supabase.from('daily_reviews').select('*');

  console.log('--- Database counts ---');
  console.log('Trades:', trades?.length || 0);
  console.log('Accounts:', accounts?.length || 0);
  console.log('Rules:', rules?.length || 0);
  console.log('Playbook:', playbook?.length || 0);
  console.log('Daily Preps:', preps?.length || 0);
  console.log('Daily Reviews:', reviews?.length || 0);
}

run().catch(console.error);
