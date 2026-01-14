
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY;

const supabase = createClient(supabaseUrl || '', supabaseKey || '');

async function debug() {
    try {
        const { data: trades, error } = await supabase.from('trades').select('*').limit(5);

        if (error) {
            console.error("Error:", error);
            return;
        }

        console.log(`Fetched ${trades.length} trades.`);
        trades.forEach((t, i) => {
            const jsonStr = JSON.stringify(t);
            const sizeKB = jsonStr.length / 1024;
            console.log(`Trade #${i} Size: ${sizeKB.toFixed(2)} KB`);

            if (t.data) {
                const dataKeys = Object.keys(t.data);
                console.log(`  - Data keys: ${dataKeys.slice(0, 10).join(', ')}...`);
                // Check for large fields
                dataKeys.forEach(k => {
                    const valSize = JSON.stringify(t.data[k]).length / 1024;
                    if (valSize > 10) { // Log fields > 10KB
                        console.log(`  - LARGE FIELD '${k}': ${valSize.toFixed(2)} KB`);
                    }
                });
            }
        });

    } catch (e) {
        console.error("Crash:", e);
    }
}

debug();
