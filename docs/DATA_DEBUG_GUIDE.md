# 🔍 DATA PERSISTENCE DEBUG GUIDE
*Quick reference pro debugging datových problémů*

---

## 🚨 SYMPTOM: "Data zmizela po reload"

### 1️⃣ Check Console Logs

**Hledej tyto zprávy:**
```
[Sync] Skipping preferences sync (dirty state)  ← BAD! Means dirty flag stuck
[Cross-tab] Detected preferences change         ← GOOD! Cross-tab working
[Preferences] Save failed: <error>              ← BAD! Save error
[Load] Cache HIT! Displaying local data        ← GOOD! Cache working
```

### 2️⃣ Check localStorage

**V DevTools Console:**
```javascript
// Check preferences cache
const userId = (await supabase.auth.getSession()).data.session.user.id;
const prefs = JSON.parse(localStorage.getItem(`alphatrade_preferences_${userId}`));
console.log('Business Payouts:', prefs.businessPayouts);
console.log('Business Expenses:', prefs.businessExpenses);
```

### 3️⃣ Check IndexedDB

**V DevTools → Application → IndexedDB:**
```
keyval-store
  ├── alphatrade_trades_{userId}        ← Trades cache
  ├── alphatrade_daily_preps_{userId}   ← Daily preps cache
  └── alphatrade_daily_reviews_{userId} ← Daily reviews cache
```

### 4️⃣ Check Supabase

**V Supabase Dashboard → Table Editor:**
```sql
-- Check preferences
SELECT preferences FROM profiles WHERE id = '<your_user_id>';

-- Check trades
SELECT * FROM trades WHERE user_id = '<your_user_id>' ORDER BY timestamp DESC LIMIT 10;

-- Check daily preps
SELECT * FROM daily_preps WHERE user_id = '<your_user_id>' ORDER BY date DESC;
```

---

## 🛠️ COMMON FIXES

### FIX #1: Dirty flag stuck
**Symptom:** Console shows "Skipping sync (dirty state)" repeatedly

**Solution:**
```javascript
// Reset dirty flags manually
isPreferencesDirty.current = false;
isJournalDirty.current = false;
```

### FIX #2: Cache out of sync
**Symptom:** localStorage has old data, Supabase has new data

**Solution:**
```javascript
// Force cache refresh
localStorage.removeItem(`alphatrade_preferences_${userId}`);
window.location.reload();
```

### FIX #3: Cross-tab not syncing
**Symptom:** Changes in Tab A don't appear in Tab B

**Check:**
```javascript
// Verify storage event listener is registered
getEventListeners(window).storage // Should show 1 listener
```

### FIX #4: Background sync stuck
**Symptom:** Data saves locally but not to Supabase

**Solution:**
```javascript
// Check network status
console.log('Online:', navigator.onLine);

// Force manual sync
const prefs = await storageService.getPreferences();
await storageService.savePreferences(prefs);
```

---

## 📊 DATA FLOW REFERENCE

### Preferences Flow:
```
User edits → setState() → isPreferencesDirty = true
  ↓ (2s debounce)
isPreferencesDirty = false (BEFORE save!)
  ↓
savePreferences() → Supabase UPDATE
  ↓ (success)
localStorage cache updated
  ↓ (storage event fires)
Other tabs sync via event listener
```

### Trades Flow:
```
User adds trade → setTrades()
  ↓ (2s debounce)
saveTrades() → MERGE with IndexedDB cache
  ↓
Upsert to Supabase
  ↓ (success)
Update IndexedDB with UUIDs
  ↓ (background sync)
Smart refresh loads newer trades
```

### Daily Preps/Reviews Flow:
```
User creates prep → handleSavePrep() → isJournalDirty = true
  ↓ (2s debounce)
isJournalDirty = false (BEFORE save!)
  ↓
saveDailyPreps() → IndexedDB cache
  ↓
Upsert to Supabase (onConflict: date)
  ↓ (background sync checks dirty flag)
If clean → apply fresh data
```

---

## 🎯 TESTING COMMANDS

### Test Preferences Save:
```javascript
// In DevTools Console
const testPayout = { id: Date.now(), date: '2026-02-04', amount: 1000 };
setBusinessPayouts(prev => [...prev, testPayout]);

// Wait 3 seconds, then check:
const prefs = await storageService.getPreferences();
console.log('Saved?', prefs.businessPayouts.some(p => p.id === testPayout.id));
```

### Test Cross-Tab Sync:
```javascript
// In Tab A Console
localStorage.setItem('alphatrade_preferences_test', Date.now().toString());

// In Tab B Console (should trigger within 1s)
// Check if storage event fired
```

### Test Network Error Handling:
```javascript
// In DevTools → Network → Throttling → Offline
// Try to save data
// Switch back to Online
// Verify background sync recovers
```

---

## 🔒 CASCADE VERIFICATION

**Run in Supabase SQL Editor:**
```sql
-- Check if CASCADE constraints exist
SELECT
  tc.table_name,
  kcu.column_name,
  ccu.table_name AS foreign_table_name,
  rc.delete_rule
FROM information_schema.table_constraints AS tc
JOIN information_schema.key_column_usage AS kcu
  ON tc.constraint_name = kcu.constraint_name
JOIN information_schema.constraint_column_usage AS ccu
  ON ccu.constraint_name = tc.constraint_name
JOIN information_schema.referential_constraints AS rc
  ON rc.constraint_name = tc.constraint_name
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND tc.table_name IN ('trades', 'accounts', 'daily_preps', 'daily_reviews')
ORDER BY tc.table_name, kcu.column_name;
```

**Expected Output:**
```
trades      | user_id    | users    | CASCADE
trades      | account_id | accounts | CASCADE
accounts    | user_id    | users    | CASCADE
daily_preps | user_id    | users    | CASCADE
...
```

---

## 📞 EMERGENCY RECOVERY

### If All Else Fails:

**1. Full Cache Clear:**
```javascript
// WARNING: This will clear all local data
localStorage.clear();
indexedDB.deleteDatabase('keyval-store');
window.location.reload();
```

**2. Force Re-sync from Supabase:**
```javascript
// This will fetch fresh data from server
const freshTrades = await storageService.getTrades();
const freshPrefs = await storageService.getPreferences();
const freshPreps = await storageService.getDailyPreps();
const freshReviews = await storageService.getDailyReviews();

// Manually update state
setTrades(freshTrades);
applyPreferences(freshPrefs);
setDailyPreps(freshPreps);
setDailyReviews(freshReviews);
```

**3. Database Backup:**
```sql
-- Export all user data (run in Supabase SQL Editor)
SELECT * FROM trades WHERE user_id = '<your_user_id>';
SELECT * FROM accounts WHERE user_id = '<your_user_id>';
SELECT preferences FROM profiles WHERE id = '<your_user_id>';
SELECT * FROM daily_preps WHERE user_id = '<your_user_id>';
SELECT * FROM daily_reviews WHERE user_id = '<your_user_id>';
```

---

**Last Updated:** 2026-02-04  
**Version:** 1.0 (Post-Audit)
