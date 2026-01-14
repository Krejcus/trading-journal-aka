
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import path from 'path';

// Load env vars
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

// Use ANON key to simulate real user (if we could authenticate, but we can't easily without password)
// IMPORTANT: RLS policy says "FOR SELECT USING (auth.role() = 'authenticated')"
// So using SERVICE ROLE is the only way to test via script unless we sign in.
// But we want to test parsing logic first.
const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY;

const supabase = createClient(supabaseUrl || '', supabaseKey || '');

async function debug() {
    try {
        console.log("1. Fetching first user to mimic...");
        const { data: user } = await supabase.from('profiles').select('id').limit(1).single();
        if (!user) {
            console.error("No user found.");
            return;
        }
        const userId = user.id;
        console.log("Using User ID:", userId);

        console.log("2. Running Optimized Query...");
        const { data: rawData, error } = await supabase
            .from('trades')
            .select(`
        id,
        user_id,
        account_id,
        instrument,
        pnl,
        direction,
        date,
        timestamp,
        drawings,
        is_public,
        created_at,
        setup:data->>setup,
        mistake:data->>mistake,
        notes:data->>notes,
        tags:data->tags,
        runUp:data->>runUp,
        drawdown:data->>drawdown,
        riskAmount:data->>riskAmount,
        targetAmount:data->>targetAmount,
        entryPrice:data->>entryPrice,
        exitPrice:data->>exitPrice,
        quantity:data->>quantity,
        signal:data->>signal,
        session:data->>session,
        confidence:data->>confidence,
        rr:data->>rr,
        duration:data->>duration,
        isValid:data->>isValid,
        groupId:data->>groupId,
        htfConfluence:data->htfConfluence,
        ltfConfluence:data->ltfConfluence,
        mistakes:data->mistakes
      `)
            .eq('user_id', userId)
            .limit(3);

        if (error) {
            console.error("QUERY ERROR:", error);
        } else {
            console.log(`Fetched ${rawData.length} rows.`);
            if (rawData.length > 0) {
                console.log("Sample Data:", JSON.stringify(rawData[0], null, 2));
            }
        }

    } catch (e) {
        console.error("Script crash:", e);
    }
}

debug();
