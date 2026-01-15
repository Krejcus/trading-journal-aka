
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY;

const supabase = createClient(supabaseUrl || '', supabaseKey || '');

async function checkOldTrades() {
    try {
        const { data: trades, error } = await supabase
            .from('trades')
            .select('id, date, data')
            .order('date', { ascending: false }) // Newest first
            .limit(5);

        if (error) {
            console.error("Error fetching trades:", error);
            return;
        }

        if (trades && trades.length > 0) {
            console.log(`Found ${trades.length} old trades.`);
            trades.forEach((t, i) => {
                console.log(`\n--- Trade ${i + 1} (${t.date}) ---`);
                console.log("Root screenshot:", t.screenshot ? (t.screenshot.substring(0, 50) + "...") : "NULL");
                console.log("Root screenshots length:", t.screenshots ? t.screenshots.length : 0);
                console.log("JSON Keys:", t.data ? Object.keys(t.data).join(", ") : "NO DATA");

                if (t.data) {
                    const potentialImage = Object.entries(t.data).find(([k, v]) =>
                        typeof v === 'string' && (v.startsWith('data:image') || v.startsWith('http'))
                    );
                    if (potentialImage) {
                        console.log(`!!! FOUND POTENTIAL IMAGE key=${potentialImage[0]} value=${potentialImage[1].substring(0, 30)}...`);
                    }
                }

                if (t.data && t.data.data) {
                    console.log("!!! FOUND NESTED DATA.DATA !!!");
                    console.log("Nested Keys:", Object.keys(t.data.data).join(", "));
                    console.log("Nested Screenshot:", t.data.data.screenshot ? "EXISTS" : "NULL");
                }
            });
        } else {
            console.log("No trades found.");
        }

    } catch (e) {
        console.error("Script crash:", e);
    }
}

checkOldTrades();
