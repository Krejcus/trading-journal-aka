import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

// Load environment variables
const envPath = path.join(process.cwd(), '.env.local');
if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
}

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
    console.error('❌ Missing Supabase credentials in .env.local');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseAnonKey);

async function checkBusinessData() {
    console.log('\n🔍 Checking Business Hub Data in Supabase...\n');

    // Get user ID from command line or session
    let userId: string | undefined;

    if (process.argv[2]) {
        userId = process.argv[2];
        console.log(`👤 User ID (from argument): ${userId}\n`);
    } else {
        // Get current session (if any)
        const { data: { session } } = await supabase.auth.getSession();

        if (!session) {
            console.log('⚠️  No active session and no user ID provided.');
            console.log('   Usage: npx tsx scripts/check-business-data.ts [USER_ID]');
            console.log('   Or check manually in Supabase Dashboard → profiles table\n');

            // List all users to help
            console.log('💡 Fetching all users from profiles...\n');
            const { data: profiles } = await supabase
                .from('profiles')
                .select('id, email, full_name')
                .limit(10);

            if (profiles && profiles.length > 0) {
                console.log('Available users:');
                profiles.forEach(p => {
                    console.log(`   ${p.id} - ${p.email || p.full_name || 'No name'}`);
                });
                console.log('\nRe-run with: npx tsx scripts/check-business-data.ts [USER_ID]');
            }
            return;
        }

        userId = session.user.id;
        console.log(`👤 User ID: ${userId}`);
        console.log(`📧 Email: ${session.user.email}\n`);
    }

    // Fetch preferences from profiles
    const { data, error } = await supabase
        .from('profiles')
        .select('preferences')
        .eq('id', userId)
        .single();

    if (error) {
        console.error('❌ Error fetching preferences:', error.message);
        return;
    }

    if (!data || !data.preferences) {
        console.log('⚠️  No preferences found in database');
        return;
    }

    const prefs = data.preferences;

    console.log('📊 BUSINESS HUB DATA STATUS:\n');

    // Check each business data type
    const businessExpenses = prefs.businessExpenses || [];
    const businessPayouts = prefs.businessPayouts || [];
    const businessGoals = prefs.businessGoals || [];
    const businessResources = prefs.businessResources || [];

    console.log(`💰 Business Expenses: ${businessExpenses.length} items`);
    if (businessExpenses.length > 0) {
        console.log('   Sample:', JSON.stringify(businessExpenses[0], null, 2));
    }

    console.log(`\n💵 Business Payouts: ${businessPayouts.length} items`);
    if (businessPayouts.length > 0) {
        console.log('   Sample:', JSON.stringify(businessPayouts[0], null, 2));
    }

    console.log(`\n🎯 Business Goals: ${businessGoals.length} items`);
    if (businessGoals.length > 0) {
        console.log('   Sample:', JSON.stringify(businessGoals[0], null, 2));
    }

    console.log(`\n📚 Business Resources: ${businessResources.length} items`);
    if (businessResources.length > 0) {
        console.log('   Sample:', JSON.stringify(businessResources[0], null, 2));
    }

    console.log('\n' + '='.repeat(60));

    const totalItems = businessExpenses.length + businessPayouts.length +
        businessGoals.length + businessResources.length;

    if (totalItems === 0) {
        console.log('❌ RESULT: No Business Hub data found in Supabase');
        console.log('   → Data was likely lost during localStorage.clear()');
        console.log('   → User will need to re-enter this data');
    } else {
        console.log(`✅ RESULT: Found ${totalItems} total Business Hub items`);
        console.log('   → Data exists in database');
        console.log('   → Issue is likely in frontend loading logic');
    }

    console.log('='.repeat(60) + '\n');

    // Write full preferences to file for inspection
    const outputPath = path.join(process.cwd(), 'business-hub-diagnostic.json');
    fs.writeFileSync(outputPath, JSON.stringify(prefs, null, 2));
    console.log(`📄 Full preferences written to: ${outputPath}\n`);
}

checkBusinessData().catch(console.error);
