
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY;

const supabase = createClient(supabaseUrl || '', supabaseKey || '');

async function listTables() {
    try {
        const { data, error } = await supabase
            .from('information_schema.tables')
            .select('table_name')
            .eq('table_schema', 'public');

        // Note: Supabase JS client might not allow accessing information_schema directly depending on permissions.
        // If this fails, we'll try a different approach or assume standard tables.

        if (error) {
            // Fallback: Try to just select from known potential tables to see if they exist
            console.log("Could not list tables directly. Probing specific tables...");
            const potentialTables = ['business_expenses', 'business_goals', 'business_payouts', 'playbook', 'legacy_data'];

            for (const t of potentialTables) {
                const { count, error: tableError } = await supabase.from(t).select('*', { count: 'exact', head: true });
                if (!tableError) {
                    console.log(`Table '${t}' EXISTS. Count: ${count}`);
                } else {
                    console.log(`Table '${t}' does not exist or is not accessible.`);
                }
            }
            return;
        }

        console.log("Tables found:", data.map(t => t.table_name));

    } catch (e) {
        console.error("Script crash:", e);
    }
}

listTables();
