import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

async function test() {
  const supabase = createClient(process.env.VITE_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  
  const { data: profiles } = await supabase.from('profiles').select('id, full_name, username');
  console.log("Profiles in DB:", profiles?.length);
  
  for (const p of (profiles || [])) {
      const { data: trades } = await supabase.from('trades').select('id').eq('user_id', p.id);
      console.log(`User ${p.id} (${p.full_name}) has ${trades?.length || 0} trades`);
  }
}
test();
