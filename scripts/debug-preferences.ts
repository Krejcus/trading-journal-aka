
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY;

const supabase = createClient(supabaseUrl || '', supabaseKey || '');

async function debugPreferences() {
    try {
        console.log("Fetching all profiles...");
        const { data: profiles, error } = await supabase
            .from('profiles')
            .select('*');

        if (error) {
            console.error("Error fetching profiles:", error);
            return;
        }

        console.log(`Found ${profiles.length} profiles.`);

        profiles.forEach((p, index) => {
            console.log(`\n--- Profile ${index + 1} (ID: ${p.id}) ---`);
            const prefs = p.preferences || {};
            const keys = Object.keys(prefs);
            const hasBusinessData = keys.some(k => k.startsWith('business') || k === 'playbookItems');

            console.log("Keys found:", keys.length);
            if (hasBusinessData) {
                console.log("!!! FOUND BUSINESS DATA !!!");
                console.log("Goals:", prefs.businessGoals?.length || 0);
                console.log("Expenses:", prefs.businessExpenses?.length || 0);
                console.log("Payouts:", prefs.businessPayouts?.length || 0);
                console.log("Playbook:", prefs.playbookItems?.length || 0);
            } else {
                console.log("No specific business data keys found.");
            }

            console.log("Iron Rules:", prefs.ironRules?.length || 0);
        });

    } catch (e) {
        console.error("Script crash:", e);
    }
}

debugPreferences();
