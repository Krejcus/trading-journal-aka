import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = "https://kopinlpdvjfgmvxydohk.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtvcGlubHBkdmpmZ212eHlkb2hrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjczNzgxMzksImV4cCI6MjA4Mjk1NDEzOX0.qW_Gi9AkZSBAubuYsv3ITor8fGEqEl56d-oJcUtxW8M";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function check() {
    const { data, error } = await supabase.from('accounts').select('id, name, "parentAccountId", parent_account_id, parent_id').limit(5);
    console.log(error ? error : JSON.stringify(data, null, 2));
}
check();
