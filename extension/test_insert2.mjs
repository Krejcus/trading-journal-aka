import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '../.env.local' });
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtvcGlubHBkdmpmZ212eHlkb2hrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjczNzgxMzksImV4cCI6MjA4Mjk1NDEzOX0.qW_Gi9AkZSBAubuYsv3ITor8fGEqEl56d-oJcUtxW8M";
const supabase = createClient("https://kopinlpdvjfgmvxydohk.supabase.co", process.env.SUPABASE_SERVICE_ROLE_KEY);

async function check() {
  const { data, error } = await supabase.from('trades').select('*').limit(1);
  console.log("SAMPLE ROW:");
  console.log(data?.[0]);
}
check();
