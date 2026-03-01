import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = "https://kopinlpdvjfgmvxydohk.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtvcGlubHBkdmpmZ212eHlkb2hrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjczNzgxMzksImV4cCI6MjA4Mjk1NDEzOX0.qW_Gi9AkZSBAubuYsv3ITor8fGEqEl56d-oJcUtxW8M";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const accountId = '1fe507d1-5610-4510-85a9-39e31af84131';

async function checkAccount() {
  const { data, error } = await supabase
    .from('accounts')
    .select('*')
    .eq('id', accountId)
    .single();

  if (error) {
    console.error('Error:', error);
  } else {
    console.log('Account info:');
    console.log('  Name:', data.name);
    console.log('  Type:', data.type);
    console.log('  Phase:', data.phase);
    console.log('  Status:', data.status);
  }
}

checkAccount();
