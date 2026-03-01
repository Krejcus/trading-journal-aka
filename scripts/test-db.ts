import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const supabase = createClient(
  process.env.VITE_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function run() {
  const { data: users } = await supabase.from('profiles').select('*').limit(1);
  if (!users || users.length === 0) return console.log("No users found");
  
  const userId = users[0].id;
  console.log("Found user:", users[0].email);
  
  const { data: trades } = await supabase.from('trades')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(5);
    
  console.log("Recent trades count:", trades?.length);
  if (trades?.[0]) {
    console.log("Sample trade:", trades[0].instrument, trades[0].pnl, trades[0].direction);
  }
}
run();
