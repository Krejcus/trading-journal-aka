
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY;

const supabase = createClient(supabaseUrl || '', supabaseKey || '');

async function checkJournal() {
    try {
        const { data: preps, error } = await supabase
            .from('daily_preps')
            .select('*')
            .order('date', { ascending: false })
            .limit(1);

        if (error) {
            console.error("Error fetching preps:", error);
            return;
        }

        if (preps && preps.length > 0) {
            console.log("--- Latest Prep Raw Data ---");
            console.log(JSON.stringify(preps[0].data, null, 2));

            const rawData = preps[0].data;
            console.log("\n--- Analysis ---");
            console.log("News Checked:", rawData.checklist?.newsChecked);
            console.log("Ritual Completions:", rawData.ritualCompletions);
        } else {
            console.log("No preps found.");
        }

    } catch (e) {
        console.error("Script crash:", e);
    }
}

checkJournal();
