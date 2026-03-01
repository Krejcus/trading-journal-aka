import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '../.env.local' });

const SUPABASE_URL = "https://kopinlpdvjfgmvxydohk.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtvcGlubHBkdmpmZ212eHlkb2hrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjczNzgxMzksImV4cCI6MjA4Mjk1NDEzOX0.qW_Gi9AkZSBAubuYsv3ITor8fGEqEl56d-oJcUtxW8M";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function check() {
  const { count } = await supabase.from('trades').select('*', { count: 'exact', head: true });
  console.log("TOTAL TRADES:", count);

  const { data } = await supabase.from('trades').select('id,user_id,account_id,instrument,signal,pnl,date,created_at').order('created_at', { ascending: false }).limit(5);
  console.log("LAST 5:", JSON.stringify(data, null, 2));
}
check();
