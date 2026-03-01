import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
async function test() {
  const supabaseUrl = process.env.VITE_SUPABASE_URL || 'https://placeholder.supabase.co';
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseServiceKey) return console.log("NO KEY");
  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  const { data: profiles } = await supabase.from('profiles').select('id, full_name, username').limit(1);
  console.log("Profile ID:", profiles?.[0]?.id);
}
test();
