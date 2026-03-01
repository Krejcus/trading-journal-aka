import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

async function verify() {
  const supabase = createClient(process.env.VITE_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data, error } = await supabase.from('trades').select('*').limit(10);
  console.log("Error:", error);
  console.log("Trades Array Length:", data?.length);
  if (data?.length) {
     console.log("Sample:", data[0]);
  }
}
verify();
