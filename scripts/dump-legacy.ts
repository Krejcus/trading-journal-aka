
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY;

const supabase = createClient(supabaseUrl || '', supabaseKey || '');

async function dumpLegacyTables() {
    try {
        const tables = ['business_expenses', 'business_goals', 'business_payouts', 'playbook'];

        for (const t of tables) {
            console.log(`\n--- Dumping ${t} ---`);
            const { data, error } = await supabase.from(t).select('*');

            if (error) {
                console.error(`Error reading ${t}:`, error.message);
            } else {
                console.log(`Found ${data.length} records.`);
                if (data.length > 0) {
                    console.log("Sample:", JSON.stringify(data[0], null, 2));
                }
            }
        }

    } catch (e) {
        console.error("Script crash:", e);
    }
}

dumpLegacyTables();
