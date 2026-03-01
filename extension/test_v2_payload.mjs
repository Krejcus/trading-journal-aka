import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import crypto from 'crypto';
dotenv.config({ path: '../.env.local' });

const supabase = createClient("https://kopinlpdvjfgmvxydohk.supabase.co", process.env.SUPABASE_SERVICE_ROLE_KEY);

async function testV2Payload() {
  const tradeId = crypto.randomUUID();
  const accId = '8d0db5c3-b12c-44a9-8310-44e56cbf48a6'; // valid acc id from test_test.js
  const finalInstrument = 'MNQ';
  const entry = 12000;
  const tp = 12100;
  const sl = 11950;
  const risk = 100;
  const outcome = 'WIN';
  const publicUrl = null;
  const commonGroupId = crypto.randomUUID();
  const phase = 'Challenge';
  
  const tradeData = {
      id: tradeId,
      accountId: accId,
      instrument: finalInstrument,
      entryPrice: entry,
      exitPrice: tp,
      stopLoss: sl,
      takeProfit: tp,
      riskAmount: risk,
      notes: "Imported via Bridge v2",
      screenshot: publicUrl,
      screenshots: publicUrl ? [publicUrl] : [],
      exitDate: null,
      status: 'CLOSED',
      outcome: outcome,
      groupId: commonGroupId,
      isMaster: true,
      masterTradeId: tradeId,
      session: "NY",
      phase,
      executionStatus: "Valid"
  };

  const payload = {
      id: tradeId,
      user_id: '6fd09385-2400-4643-b6dc-9ab3b4a827cd',
      account_id: accId,
      instrument: finalInstrument,
      direction: 'Long', // Testing exactly 'Long'
      pnl: 200,
      date: new Date().toISOString(),
      timestamp: Date.now(),
      signal: "Alpha Bridge v2",
      is_public: false,
      data: tradeData
  };

  console.log("Attempting insert...");
  // Use anon key to see if RLS fails
  const anonSupabase = createClient("https://kopinlpdvjfgmvxydohk.supabase.co", process.env.VITE_SUPABASE_ANON_KEY);
  // Wait, I would need a JWT for anon checking! Without JWT it's unauthenticated.
  // Instead, let's just test Service Role to see if Schema is rejecting it.
  
  const { data, error } = await supabase.from('trades').insert([payload]).select();
  console.log("Service Role Insert Result:");
  console.log("Error:", error);
  console.log("Data length:", data?.length);
}

testV2Payload();
