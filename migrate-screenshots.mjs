/**
 * Standalone screenshot migration script.
 * Spusť: SUPABASE_SERVICE_KEY=... node migrate-screenshots.mjs
 *
 * Migruje:
 *  - trades.data.screenshot, trades.data.screenshots[]
 *  - daily_preps.data.scenarios.bullishImage, .bearishImage
 *  - daily_preps.data.scenarios.scenarioImages[]
 *  - daily_reviews.data.sessionBreakdowns[].screenshot
 *
 * Bezpečné spustit opakovaně — přeskočí už migrované (URL).
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://kopinlpdvjfgmvxydohk.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtvcGlubHBkdmpmZ212eHlkb2hrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjczNzgxMzksImV4cCI6MjA4Mjk1NDEzOX0.qW_Gi9AkZSBAubuYsv3ITor8fGEqEl56d-oJcUtxW8M';

const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY || SUPABASE_ANON_KEY);

function isBase64(s) {
  return typeof s === 'string' && s.startsWith('data:');
}

async function uploadScreenshot(base64DataUrl, prefix, userId, bucket = 'trade-images') {
  if (!isBase64(base64DataUrl)) return base64DataUrl;
  const base64 = base64DataUrl.replace(/^data:image\/\w+;base64,/, '');
  const byteChars = atob(base64);
  const buffer = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) buffer[i] = byteChars.charCodeAt(i);
  const ext = base64DataUrl.includes('image/png') ? 'png' : 'jpg';
  const fileName = `${userId}/${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error } = await supabase.storage.from(bucket).upload(fileName, buffer, {
    contentType: `image/${ext}`, upsert: true
  });
  if (error) throw error;
  return supabase.storage.from(bucket).getPublicUrl(fileName).data.publicUrl;
}

// ========================================
// TRADES MIGRATION
// ========================================
async function migrateTrades() {
  console.log('\n📊 === TRADES ===');
  const BATCH_SIZE = 20;
  let offset = 0, migrated = 0, skipped = 0, failed = 0, hasMore = true;

  while (hasMore) {
    const { data: rows, error } = await supabase.from('trades').select('id, user_id, data').range(offset, offset + BATCH_SIZE - 1);
    if (error) { console.error('❌ DB chyba:', error.message); break; }
    if (!rows || rows.length === 0) { hasMore = false; break; }

    const toMigrate = rows.filter(r =>
      isBase64(r.data?.screenshot) ||
      (Array.isArray(r.data?.screenshots) && r.data.screenshots.some(isBase64))
    );

    console.log(`Trades dávka ${offset}–${offset + rows.length - 1}: ${toMigrate.length}/${rows.length} k migraci`);

    for (const row of toMigrate) {
      const td = { ...row.data };
      try {
        if (isBase64(td.screenshot)) {
          process.stdout.write(`  Trade ${row.id}: screenshot...`);
          td.screenshot = await uploadScreenshot(td.screenshot, `trade_${row.id}`, row.user_id);
          process.stdout.write(' ✅\n');
        }
        if (Array.isArray(td.screenshots) && td.screenshots.length) {
          const out = [];
          for (const s of td.screenshots) {
            if (isBase64(s)) {
              process.stdout.write(`  Trade ${row.id}: screenshots[]...`);
              out.push(await uploadScreenshot(s, `trade_${row.id}`, row.user_id));
              process.stdout.write(' ✅\n');
            } else out.push(s);
          }
          td.screenshots = out;
        }
        const { error: upErr } = await supabase.from('trades').update({ data: td }).eq('id', row.id);
        if (upErr) throw upErr;
        migrated++;
      } catch (e) {
        console.error(`  ❌ Trade ${row.id}:`, e.message);
        failed++;
      }
    }
    skipped += (rows.length - toMigrate.length);
    offset += BATCH_SIZE;
    if (rows.length < BATCH_SIZE) hasMore = false;
    if (hasMore) await new Promise(r => setTimeout(r, 500));
  }
  return { migrated, skipped, failed };
}

// ========================================
// DAILY PREPS MIGRATION
// ========================================
async function migratePreps() {
  console.log('\n📔 === DAILY PREPS ===');
  const BATCH_SIZE = 20;
  let offset = 0, migrated = 0, skipped = 0, failed = 0, hasMore = true;

  while (hasMore) {
    const { data: rows, error } = await supabase.from('daily_preps').select('id, user_id, date, data').range(offset, offset + BATCH_SIZE - 1);
    if (error) { console.error('❌ DB chyba:', error.message); break; }
    if (!rows || rows.length === 0) { hasMore = false; break; }

    const toMigrate = rows.filter(r => {
      const sc = r.data?.scenarios;
      if (!sc) return false;
      return isBase64(sc.bullishImage) ||
             isBase64(sc.bearishImage) ||
             (Array.isArray(sc.scenarioImages) && sc.scenarioImages.some(isBase64));
    });

    console.log(`Preps dávka ${offset}–${offset + rows.length - 1}: ${toMigrate.length}/${rows.length} k migraci`);

    for (const row of toMigrate) {
      const pd = { ...row.data, scenarios: { ...row.data.scenarios } };
      try {
        if (isBase64(pd.scenarios.bullishImage)) {
          process.stdout.write(`  Prep ${row.date}: bullishImage...`);
          pd.scenarios.bullishImage = await uploadScreenshot(pd.scenarios.bullishImage, `prep_${row.date}_bull`, row.user_id);
          process.stdout.write(' ✅\n');
        }
        if (isBase64(pd.scenarios.bearishImage)) {
          process.stdout.write(`  Prep ${row.date}: bearishImage...`);
          pd.scenarios.bearishImage = await uploadScreenshot(pd.scenarios.bearishImage, `prep_${row.date}_bear`, row.user_id);
          process.stdout.write(' ✅\n');
        }
        if (Array.isArray(pd.scenarios.scenarioImages) && pd.scenarios.scenarioImages.length) {
          const out = [];
          for (const s of pd.scenarios.scenarioImages) {
            if (isBase64(s)) {
              process.stdout.write(`  Prep ${row.date}: scenarioImages[]...`);
              out.push(await uploadScreenshot(s, `prep_${row.date}_sc`, row.user_id));
              process.stdout.write(' ✅\n');
            } else out.push(s);
          }
          pd.scenarios.scenarioImages = out;
        }
        const { error: upErr } = await supabase.from('daily_preps').update({ data: pd }).eq('id', row.id);
        if (upErr) throw upErr;
        migrated++;
      } catch (e) {
        console.error(`  ❌ Prep ${row.date}:`, e.message);
        failed++;
      }
    }
    skipped += (rows.length - toMigrate.length);
    offset += BATCH_SIZE;
    if (rows.length < BATCH_SIZE) hasMore = false;
    if (hasMore) await new Promise(r => setTimeout(r, 500));
  }
  return { migrated, skipped, failed };
}

// ========================================
// DAILY REVIEWS MIGRATION
// ========================================
async function migrateReviews() {
  console.log('\n📝 === DAILY REVIEWS ===');
  const BATCH_SIZE = 20;
  let offset = 0, migrated = 0, skipped = 0, failed = 0, hasMore = true;

  while (hasMore) {
    const { data: rows, error } = await supabase.from('daily_reviews').select('id, user_id, date, data').range(offset, offset + BATCH_SIZE - 1);
    if (error) { console.error('❌ DB chyba:', error.message); break; }
    if (!rows || rows.length === 0) { hasMore = false; break; }

    const toMigrate = rows.filter(r => {
      const sb = r.data?.sessionBreakdowns;
      return Array.isArray(sb) && sb.some(b => isBase64(b?.screenshot));
    });

    console.log(`Reviews dávka ${offset}–${offset + rows.length - 1}: ${toMigrate.length}/${rows.length} k migraci`);

    for (const row of toMigrate) {
      const rd = { ...row.data, sessionBreakdowns: [...(row.data.sessionBreakdowns || [])] };
      try {
        for (let i = 0; i < rd.sessionBreakdowns.length; i++) {
          const b = rd.sessionBreakdowns[i];
          if (isBase64(b?.screenshot)) {
            process.stdout.write(`  Review ${row.date} [sess ${i}]: screenshot...`);
            rd.sessionBreakdowns[i] = {
              ...b,
              screenshot: await uploadScreenshot(b.screenshot, `review_${row.date}_${i}`, row.user_id)
            };
            process.stdout.write(' ✅\n');
          }
        }
        const { error: upErr } = await supabase.from('daily_reviews').update({ data: rd }).eq('id', row.id);
        if (upErr) throw upErr;
        migrated++;
      } catch (e) {
        console.error(`  ❌ Review ${row.date}:`, e.message);
        failed++;
      }
    }
    skipped += (rows.length - toMigrate.length);
    offset += BATCH_SIZE;
    if (rows.length < BATCH_SIZE) hasMore = false;
    if (hasMore) await new Promise(r => setTimeout(r, 500));
  }
  return { migrated, skipped, failed };
}

// ========================================
// MAIN
// ========================================
async function main() {
  console.log('🚀 Komplexní screenshot migrace spuštěna...');

  if (!SERVICE_ROLE_KEY) {
    console.error(`
❌ Chybí SUPABASE_SERVICE_KEY!

Spusť takto:
  SUPABASE_SERVICE_KEY=<service_role_key> node migrate-screenshots.mjs

Service role key najdeš: Supabase Dashboard → Settings → API → service_role
`);
    process.exit(1);
  }

  console.log('✅ Service role key OK — přímý přístup k DB');

  const trades = await migrateTrades();
  const preps = await migratePreps();
  const reviews = await migrateReviews();

  const total = {
    migrated: trades.migrated + preps.migrated + reviews.migrated,
    skipped: trades.skipped + preps.skipped + reviews.skipped,
    failed: trades.failed + preps.failed + reviews.failed,
  };

  console.log(`
╔════════════════════════════════════════╗
║         MIGRACE DOKONČENA              ║
╠════════════════════════════════════════╣
║ Trades:   ${String(trades.migrated).padEnd(4)} migr.  ${String(trades.skipped).padEnd(4)} skip.  ${String(trades.failed).padEnd(4)} fail. ║
║ Preps:    ${String(preps.migrated).padEnd(4)} migr.  ${String(preps.skipped).padEnd(4)} skip.  ${String(preps.failed).padEnd(4)} fail. ║
║ Reviews:  ${String(reviews.migrated).padEnd(4)} migr.  ${String(reviews.skipped).padEnd(4)} skip.  ${String(reviews.failed).padEnd(4)} fail. ║
╠════════════════════════════════════════╣
║ CELKEM:   ${String(total.migrated).padEnd(4)} migr.  ${String(total.skipped).padEnd(4)} skip.  ${String(total.failed).padEnd(4)} fail. ║
╚════════════════════════════════════════╝
`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
