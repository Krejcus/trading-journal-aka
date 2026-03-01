import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '../.env.local' });

const SUPABASE_URL = "https://kopinlpdvjfgmvxydohk.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtvcGlubHBkdmpmZ212eHlkb2hrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjczNzgxMzksImV4cCI6MjA4Mjk1NDEzOX0.qW_Gi9AkZSBAubuYsv3ITor8fGEqEl56d-oJcUtxW8M";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function check() {
  // Find a trade created by the web app (signal: "Manuální obchod")
  const { data, error } = await supabase.from('trades')
    .select('*')
    .eq('signal', 'Manuální obchod')
    .order('created_at', { ascending: false })
    .limit(1);
    
  console.log("WORKING WEB APP TRADE:");
  console.log(error ? error : JSON.stringify(data, null, 2));

  // Find a trade created by the extension (signal: "Alpha Bridge v2")
  const { data: extData, error: extError } = await supabase.from('trades')
    .select('*')
    .eq('signal', 'Alpha Bridge v2')
    .order('created_at', { ascending: false })
    .limit(1);

  console.log("\nEXTENSION TRADE:");
  console.log(extError ? extError : JSON.stringify(extData, null, 2));
}
check();
