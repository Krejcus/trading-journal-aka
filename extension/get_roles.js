import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '../.env.local' });
const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
async function check() {
  const { data, error } = await supabase.from('trades').select('*').order('created_at', { ascending: false }).limit(5);
  console.log(error || data.map(d => ({id:d.id, date:d.date})));
}
check();
