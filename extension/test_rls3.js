import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '../.env.local' });
const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
async function check() {
  const { data, error } = await supabase.from('trades').select('id').limit(1);
  const q = await fetch(`${process.env.VITE_SUPABASE_URL}/rest/v1/pg_policies?select=*`, {
     headers: {
        'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
     }
  });
  console.log("pg_policies status:", q.status);
  const policies = await q.text();
  console.log(policies);
}
check();
