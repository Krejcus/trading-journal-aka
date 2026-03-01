import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '../.env.local' });
const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
async function check() {
  const { data, error } = await supabase.rpc('debug_rls_or_get_policy', {}).catch(() => ({}));
  
  // Actually let's just query the pg_policies table directly
  const { data: policies, error: pErr } = await supabase.from('pg_policies').select('*').eq('tablename', 'trades')
    .catch(() => ({ error: 'Use raw SQL via REST or PSQL' }));
  
  console.log("pg_policies query:", policies || pErr);
}
check();
