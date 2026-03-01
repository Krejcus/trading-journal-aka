import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '../.env.local' });

const SUPABASE_URL = "https://kopinlpdvjfgmvxydohk.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtvcGlubHBkdmpmZ212eHlkb2hrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjczNzgxMzksImV4cCI6MjA4Mjk1NDEzOX0.qW_Gi9AkZSBAubuYsv3ITor8fGEqEl56d-oJcUtxW8M";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

import crypto from 'crypto';

async function check() {
  const userId = "6fd09385-2400-4643-b6dc-9ab3b4a827cd"; // Found from the working trade output
  const accId = "8d0db5c3-b12c-44a9-8310-44e56cbf48a6";
  const tradeId = crypto.randomUUID();
  const commonGroupId = crypto.randomUUID();
  const finalDateIso = new Date().toISOString();
  
  const tradeObj = {
    id: tradeId,
    pnl: 0,
    data: {},
    date: finalDateIso,
    tags: null,
    notes: "",
    runUp: 0,
    setup: null,
    signal: "Alpha Bridge v2",
    userId: userId,
    groupId: commonGroupId,
    isValid: true,
    mistake: null,
    session: null,
    drawdown: 0,
    drawings: [],
    duration: "0 m",
    emotions: null,
    isPublic: false,
    mistakes: [],
    accountId: accId,
    createdAt: finalDateIso,
    direction: "LONG",
    exitPrice: null,
    timestamp: Date.now(),
    entryPrice: 100,
    instrument: "MNQ",
    riskAmount: 50,
    screenshot: null,
    screenshots: [],
    targetAmount: 0,
    htfConfluence: [],
    ltfConfluence: [],
    miniViewRange: null,
    planAdherence: null,
    miniViewLayout: null,
    durationMinutes: 0,
    executionStatus: "Valid",
    miniViewSecondaryRange: null,
    miniViewSecondaryTimeframe: null,
    isMaster: true,
    masterTradeId: null
  };

  const payload = {
    id: tradeId,
    user_id: userId,
    account_id: accId,
    instrument: "MNQ",
    signal: "Alpha Bridge v2",
    pnl: 0,
    direction: "LONG",
    date: finalDateIso,
    timestamp: Date.now(),
    is_public: false,
    drawings: [],
    data: tradeObj
  };

  const { data, error } = await supabase.from('trades').insert([payload]);
  console.log("INSERT RESULT:");
  console.log(error ? error : JSON.stringify(data, null, 2));
}
check();
