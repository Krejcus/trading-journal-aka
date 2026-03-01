import fetch from 'node-fetch';

const SUPABASE_URL = "https://kopinlpdvjfgmvxydohk.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtvcGlubHBkdmpmZ212eHlkb2hrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjczNzgxMzksImV4cCI6MjA4Mjk1NDEzOX0.qW_Gi9AkZSBAubuYsv3ITor8fGEqEl56d-oJcUtxW8M";

// Try a basic GET to see if RLS blocks or what it returns
fetch(`${SUPABASE_URL}/rest/v1/trades`, {
    headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`
    }
}).then(r => r.json()).then(console.log).catch(console.error);
