import { supabase } from '../services/supabase';
async function test() {
  const { data, error } = await supabase.from('profiles').select('*').limit(1);
  console.log("Profiles:", data, error);
}
test();
