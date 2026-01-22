
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = "https://kopinlpdvjfgmvxydohk.supabase.co";
const SERVICE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtvcGlubHBkdmpmZ212eHlkb2hrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NzM3ODEzOSwiZXhwIjoyMDgyOTU0MTM5fQ.DjTRBdF9hjUqd-1zFksa_zBbV6n_oN_8qdqkp8lDWx0";

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

async function main() {
    const userId = "6fd09385-2400-4643-b6dc-9ab3b4a827cd";
    console.log(`Summary of trades for user: ${userId}`);

    const { data, error } = await supabase
        .from('trades')
        .select('id, instrument, date, account_id, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

    if (error) {
        console.error("Error:", error);
        return;
    }

    console.log(`Total trades found: ${data.length}`);
    console.log("Recent Trades:", JSON.stringify(data.slice(0, 10), null, 2));
}

main();
