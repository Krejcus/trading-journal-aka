
import { Trade, Account, UserPreferences, DailyPrep, DailyReview, WeeklyReview, MonthlyReview, User, SocialConnection, UserSearch, BusinessExpense, BusinessPayout, PlaybookItem, BusinessGoal, BusinessResource, BusinessSettings, WeeklyFocus, DrawingTemplate, AIConversation } from '../types';
import { supabase } from './supabase';
import { get, set } from 'idb-keyval';
import { embedTrade, embedPrep, embedReview } from './embeddingService';
import { maybeDetectEpisodes } from './coachMemoryService';
import { resizeImageDataUrl, dataUrlSizeKB } from './imageResize';
import { stripAndUploadBase64Images, hasBase64Images } from './stripBase64';

// Helper to validate UUID
const isUUID = (id: any) => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

// Helper to get current user ID with caching
let cachedUserId: string | null = null;
let lastSessionCheck = 0;

// Invalidate cache on auth state changes (logout, user switch) to prevent stale userId
supabase.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_OUT' || event === 'USER_UPDATED' || !session) {
    cachedUserId = null;
    lastSessionCheck = 0;
  } else if (session?.user?.id && session.user.id !== cachedUserId) {
    // User changed — update cache immediately
    cachedUserId = session.user.id;
    lastSessionCheck = Date.now();
  }
});

export const getUserId = async () => {
  // Use cache if it's less than 30 seconds old
  if (cachedUserId && Date.now() - lastSessionCheck < 30000) {
    return cachedUserId;
  }

  const { data: { session } } = await supabase.auth.getSession();
  cachedUserId = session?.user?.id || null;
  lastSessionCheck = Date.now();
  return cachedUserId;
};

// Safe LocalStorage helper to prevent QuotaExceededError from crashing the app
// On quota exceeded: evict the largest non-essential cached key, then retry once
const safeSetItem = (key: string, value: any) => {
  try {
    const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
    localStorage.setItem(key, stringValue);
  } catch (e: any) {
    if (e.name === 'QuotaExceededError' || e.code === 22) {
      console.warn(`[Storage] LocalStorage quota exceeded for key: ${key}. Evicting largest cached entry…`);
      try {
        // Find the largest alphatrade_ cache key (excluding the one we're trying to save)
        let largestKey: string | null = null;
        let largestSize = 0;
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (!k || k === key || !k.startsWith('alphatrade_')) continue;
          const len = (localStorage.getItem(k) || '').length;
          if (len > largestSize) { largestSize = len; largestKey = k; }
        }
        if (largestKey) {
          localStorage.removeItem(largestKey);
          console.warn(`[Storage] Evicted ${largestKey} (${(largestSize / 1024).toFixed(1)} KB)`);
          // Retry once after eviction
          const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
          localStorage.setItem(key, stringValue);
        }
      } catch (retryErr) {
        console.error(`[Storage] Still failed after eviction, giving up:`, retryErr);
      }
    } else {
      console.error(`[Storage] Failed to save to LocalStorage:`, e);
    }
  }
};

// Helper to update cache timestamp after successful saves
const updateCacheTimestamp = async () => {
  const userId = await getUserId();
  if (userId) {
    const timestampKey = `alphatrade_cache_timestamp_${userId}`;
    localStorage.setItem(timestampKey, Date.now().toString());
  }
};

export const storageService = {

  // Single RPC call to load all dashboard data at once (replaces 7 parallel HTTP requests)
  async getDashboardData(): Promise<{
    trades: Trade[]; accounts: Account[]; preps: DailyPrep[];
    reviews: DailyReview[]; preferences: UserPreferences | null;
    user: User | null; weeklyFocus: WeeklyFocus[];
  }> {
    const { data, error } = await supabase.rpc('get_dashboard_data');
    if (error) { console.error('[RPC] get_dashboard_data error:', error); throw error; }
    const raw = data as any;

    const trades = (raw.trades || []).map((t: any) => {
      const d = t.data || {};
      return {
        id: t.id, userId: t.user_id, accountId: t.account_id, instrument: t.instrument,
        pnl: t.pnl, direction: t.direction, date: t.date, timestamp: t.timestamp,
        drawings: [], isPublic: t.is_public, createdAt: t.created_at,
        setup: d.setup, mistake: d.mistake, notes: d.notes, tags: d.tags,
        runUp: d.runUp ? Number(d.runUp) : undefined,
        drawdown: d.drawdown ? Number(d.drawdown) : undefined,
        riskAmount: d.riskAmount ? Number(d.riskAmount) : undefined,
        targetAmount: d.targetAmount ? Number(d.targetAmount) : undefined,
        entryPrice: d.entryPrice ? Number(d.entryPrice) : undefined,
        exitPrice: d.exitPrice ? Number(d.exitPrice) : undefined,
        stopLoss: d.stopLoss ? Number(d.stopLoss) : undefined,
        takeProfit: d.takeProfit ? Number(d.takeProfit) : undefined,
        quantity: d.quantity ? Number(d.quantity) : undefined,
        signal: d.signal, session: d.session,
        confidence: d.confidence ? Number(d.confidence) : undefined,
        rr: d.rr ? Number(d.rr) : undefined,
        duration: d.duration,
        durationMinutes: d.durationMinutes ? Number(d.durationMinutes) : 0,
        isValid: d.isValid === 'true' || d.isValid === true,
        groupId: d.groupId, phase: d.phase,
        htfConfluence: d.htfConfluence, ltfConfluence: d.ltfConfluence,
        mistakes: d.mistakes, emotions: d.emotions,
        planAdherence: d.planAdherence, executionStatus: d.executionStatus,
        screenshot: t.screenshot_url || undefined,
        screenshots: t.screenshots_urls || undefined,
        miniViewRange: d.miniViewRange, miniViewLayout: d.miniViewLayout,
        miniViewSecondaryRange: d.miniViewSecondaryRange,
        miniViewSecondaryTimeframe: d.miniViewSecondaryTimeframe,
        // AI návrhy z enrich-trade Edge Function (HTF/LTF/mistakes/emotions + reasoning)
        aiSuggestions: d.aiSuggestions || undefined,
        visionAnalysis: d.visionAnalysis || undefined,
        // KRITICKÉ: pole co se používají v TradeDetailModal a fee přepočtech.
        // Bez nich modal zobrazí POSITION=1 (fallback) i pro Tradovate trades s pos=2/4.
        positionSize: d.positionSize ? Number(d.positionSize) : undefined,
        isMaster: d.isMaster === 'true' || d.isMaster === true,
        masterTradeId: d.masterTradeId || undefined,
        entryTime: d.entryTime ? Number(d.entryTime) : undefined,
        entryDate: d.entryDate || undefined,
        // Provenance pro import dedup (Tradesyncer) — musí přežít load, jinak by re-import duplikoval.
        source: d.source || undefined,
        tsOrderIds: d.tsOrderIds || undefined,
        isBE: d.isBE === true || d.isBE === 'true',
        data: {}
      };
    }) as Trade[];

    const allAccounts = (raw.accounts || []).map((a: any) => ({
      ...a.meta, id: a.id, name: a.name, initialBalance: a.initial_balance,
      currency: a.currency, type: a.type, status: a.status, createdAt: a.created_at,
      isArchived: a.meta?.isArchived, archivedAt: a.meta?.archivedAt,
      result: a.meta?.result, phase: a.meta?.phase
    }));
    const accounts = allAccounts.filter((a: any) => !a.isArchived) as Account[];

    const preps = (raw.daily_preps || []).map((d: any) => ({ ...d.data, id: d.id, date: d.date })) as DailyPrep[];
    const reviews = (raw.daily_reviews || []).map((d: any) => ({ ...d.data, id: d.id, date: d.date })) as DailyReview[];

    const user = raw.user ? {
      id: raw.user.id, email: raw.user.email || '',
      name: raw.user.full_name || '', avatar: raw.user.avatar_url,
      role: (raw.user.role as any) || 'friend',
    } as User : null;

    const preferences = raw.preferences || null;

    const weeklyFocus = (raw.weekly_focus || []).map((d: any) => {
      const goals = (d.goals || []).map((g: any, i: number) =>
        typeof g === 'string' ? { id: `g_${i}`, text: g, emoji: storageService.predictEmoji(g) } : g
      );
      return { id: d.id, weekISO: d.week_iso, goals };
    }) as WeeklyFocus[];

    // Update caches so individual methods stay fresh
    const userId = raw.user?.id;
    if (userId) {
      set(`alphatrade_trades_${userId}`, trades);
      set(`alphatrade_daily_preps_${userId}`, preps);
      set(`alphatrade_daily_reviews_${userId}`, reviews);
      set(`alphatrade_user_profile_${userId}`, user);
      safeSetItem(`alphatrade_accounts_${userId}`, accounts);
      if (preferences) safeSetItem(`alphatrade_preferences_${userId}`, preferences);
      set(`alphatrade_weekly_focus_${userId}`, weeklyFocus);
    }

    return { trades, accounts, preps, reviews, preferences, user, weeklyFocus };
  },

  // Read all dashboard data from IndexedDB/localStorage cache (instant, no network)
  async getCachedDashboardData(userId: string): Promise<{
    trades: Trade[]; accounts: Account[]; preps: DailyPrep[];
    reviews: DailyReview[]; preferences: UserPreferences | null;
    user: User | null; weeklyFocus: WeeklyFocus[];
  } | null> {
    try {
      const [trades, preps, reviews, user, weeklyFocus] = await Promise.all([
        get(`alphatrade_trades_${userId}`),
        get(`alphatrade_daily_preps_${userId}`),
        get(`alphatrade_daily_reviews_${userId}`),
        get(`alphatrade_user_profile_${userId}`),
        get(`alphatrade_weekly_focus_${userId}`)
      ]);
      // Require user data to consider cache valid
      if (!user) return null;
      const accountsRaw = localStorage.getItem(`alphatrade_accounts_${userId}`);
      const accounts = accountsRaw ? JSON.parse(accountsRaw) : [];
      const prefsRaw = localStorage.getItem(`alphatrade_preferences_${userId}`);
      const preferences = prefsRaw ? JSON.parse(prefsRaw) : null;
      return {
        trades: (trades || []) as Trade[],
        accounts: accounts as Account[],
        preps: (preps || []) as DailyPrep[],
        reviews: (reviews || []) as DailyReview[],
        preferences,
        user: user as User,
        weeklyFocus: (weeklyFocus || []) as WeeklyFocus[]
      };
    } catch (e) {
      console.warn('[Cache] getCachedDashboardData failed:', e);
      return null;
    }
  },

  // User Profile
  async getCachedUser(): Promise<User | null> {
    const userId = await getUserId();
    if (!userId) return null;
    const cached = await get(`alphatrade_user_profile_${userId}`);
    return cached || null;
  },

  async getUser(): Promise<User | null> {
    const userId = await getUserId();
    if (!userId) return null;

    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single();

    if (error) {
      console.error("Supabase getUser error:", error);
      return null;
    }
    if (!data) return null;

    const user: User = {
      id: data.id,
      email: data.email || '',
      name: data.full_name || '',
      avatar: data.avatar_url,
      role: (data.role as any) || 'friend',
    };

    // Keep cache in sync
    set(`alphatrade_user_profile_${userId}`, user);

    return user;
  },

  async getProfile(userId: string): Promise<User | null> {
    if (!userId || !isUUID(userId)) return null;
    const { data, error } = await supabase.from('profiles').select('*').eq('id', userId).single();
    if (error || !data) return null;
    return {
      id: data.id,
      email: data.email || '',
      name: data.full_name || '',
      avatar: data.avatar_url,
      role: (data.role as any) || 'friend', // 'owner' | 'friend' | 'user'
    };
  },

  async saveUser(user: User): Promise<void> {
    const userId = await getUserId();
    if (!userId) return;

    const profileData = {
      id: userId,
      full_name: user.name,
      avatar_url: user.avatar,
      updated_at: new Date().toISOString()
    };

    const { error } = await supabase.from('profiles').upsert(profileData);
    if (error) {
      console.error("Supabase saveUser error details:", error);
      throw error;
    }

    // Sync local cache
    set(`alphatrade_user_profile_${userId}`, user);
  },

  // Trades
  // Synchronous method for initial load, returns empty array as IndexedDB is async.
  getCachedTrades(): Trade[] {
    return [];
  },

  // Async method to get cached trades from IndexedDB
  async getTradesCheckCacheFirst(): Promise<Trade[]> {
    const userId = await getUserId();
    if (!userId) return [];

    const localKey = `alphatrade_trades_${userId}`;
    const cached = await get(localKey);
    return cached || [];
  },

  async getTrades(targetUserId?: string): Promise<Trade[]> {
    const userId = targetUserId || await getUserId();

    // Fast IndexedDB fallback
    const localKey = userId ? `alphatrade_trades_${userId}` : 'alphatrade_trades';
    let localTrades: Trade[] = await get(localKey) || [];

    if (!userId) return localTrades;

    // Optimized select to avoid fetching heavy 'screenshot'/'screenshots' from 'data' JSON blob
    // We explicitly select the fields we need.
    const { data: rawData, error } = await supabase
      .from('trades')
      .select(`
        id,
        user_id,
        account_id,
        instrument,
        pnl,
        direction,
        date,
        timestamp,
        drawings,
        is_public,
        created_at,
        setup:data->>setup,
        mistake:data->>mistake,
        notes:data->>notes,
        tags:data->tags,
        runUp:data->>runUp,
        drawdown:data->>drawdown,
        riskAmount:data->>riskAmount,
        targetAmount:data->>targetAmount,
        entryPrice:data->>entryPrice,
        exitPrice:data->>exitPrice,
        stopLoss:data->>stopLoss,
        takeProfit:data->>takeProfit,
        quantity:data->>quantity,
        signal:data->>signal,
        session:data->>session,
        confidence:data->>confidence,
        rr:data->>rr,
        duration:data->>duration,
        isValid:data->>isValid,
        groupId:data->>groupId,
        phase:data->>phase,
        htfConfluence:data->htfConfluence,
        ltfConfluence:data->ltfConfluence,
        mistakes:data->mistakes,
        emotions:data->emotions,
        planAdherence:data->>planAdherence,
        executionStatus:data->>executionStatus,
        miniViewRange:data->>miniViewRange,
        miniViewLayout:data->>miniViewLayout,
        miniViewSecondaryRange:data->>miniViewSecondaryRange,
        miniViewSecondaryTimeframe:data->>miniViewSecondaryTimeframe,
        durationMinutes:data->>durationMinutes,
        positionSize:data->>positionSize,
        isMaster:data->>isMaster,
        masterTradeId:data->>masterTradeId,
        entryTime:data->>entryTime,
        screenshot:data->>screenshot,
        screenshots:data->screenshots,
        aiSuggestions:data->aiSuggestions,
        visionAnalysis:data->visionAnalysis
      `)
      .eq('user_id', userId)
      .order('timestamp', { ascending: false });

    if (error) {
      console.error("Supabase getTrades error:", error);
      return localTrades; // Fallback to local on error
    }

    const trades = rawData.map((t: any) => ({
      id: t.id,
      userId: t.user_id,
      accountId: t.account_id,
      instrument: t.instrument,
      pnl: t.pnl,
      direction: t.direction,
      date: t.date,
      timestamp: t.timestamp,
      drawings: t.drawings || [],
      isPublic: t.is_public,
      createdAt: t.created_at,

      // Mapped JSON fields
      setup: t.setup,
      mistake: t.mistake,
      notes: t.notes,
      tags: t.tags,
      runUp: t.runUp ? Number(t.runUp) : undefined,
      drawdown: t.drawdown ? Number(t.drawdown) : undefined,
      riskAmount: t.riskAmount ? Number(t.riskAmount) : undefined,
      targetAmount: t.targetAmount ? Number(t.targetAmount) : undefined,
      entryPrice: t.entryPrice ? Number(t.entryPrice) : undefined,
      exitPrice: t.exitPrice ? Number(t.exitPrice) : undefined,
      stopLoss: t.stopLoss ? Number(t.stopLoss) : undefined,
      takeProfit: t.takeProfit ? Number(t.takeProfit) : undefined,
      quantity: t.quantity ? Number(t.quantity) : undefined,
      signal: t.signal,
      session: t.session,
      confidence: t.confidence ? Number(t.confidence) : undefined,
      rr: t.rr ? Number(t.rr) : undefined,
      duration: t.duration,
      durationMinutes: t.durationMinutes ? Number(t.durationMinutes) : 0,
      isValid: t.isValid === 'true' || t.isValid === true,
      groupId: t.groupId,
      phase: t.phase,
      htfConfluence: t.htfConfluence,
      ltfConfluence: t.ltfConfluence,
      mistakes: t.mistakes,
      emotions: t.emotions,
      planAdherence: t.planAdherence,
      executionStatus: t.executionStatus,
      // Include screenshot URLs (small strings, not base64 blobs — safe to include always)
      screenshot: t.screenshot && !String(t.screenshot).startsWith('data:') ? t.screenshot : undefined,
      screenshots: t.screenshots?.filter((s: string) => s && !String(s).startsWith('data:')) || undefined,
      aiSuggestions: t.aiSuggestions || undefined,
      visionAnalysis: t.visionAnalysis || undefined,
      miniViewRange: t.miniViewRange,
      miniViewLayout: t.miniViewLayout,
      miniViewSecondaryRange: t.miniViewSecondaryRange,
      miniViewSecondaryTimeframe: t.miniViewSecondaryTimeframe,
      positionSize: t.positionSize ? Number(t.positionSize) : undefined,
      isMaster: t.isMaster === 'true' || t.isMaster === true,
      masterTradeId: t.masterTradeId || undefined,
      entryTime: t.entryTime ? Number(t.entryTime) : undefined,
      // Provenance pro import dedup (Tradesyncer) — musí přežít load, jinak by re-import duplikoval.
      source: t.source || undefined,
      tsOrderIds: t.tsOrderIds || undefined,

      // We don't carry the full blob anymore to save memory
      data: {}
    })) as Trade[];

    // Cache to IndexedDB (fire-and-forget, don't block return)
    set(localKey, trades);
    return trades;
  },

  async updateTradeDrawings(tradeId: string | number, drawings: any[]): Promise<void> {
    const userId = await getUserId();
    if (!userId) return;

    // Synchronizujeme drawings na DVOU místech:
    //   1. root sloupec `drawings` — primární source of truth
    //   2. `data.drawings` v JSONB — saveTrades() bulk save jinak může drawings přepsat stale verzí
    // Bez kroku 2 dochází k tomu, že bulk save z data blobu (kde má stale drawings) přemaže
    // čerstvé drawings v root sloupci.

    // Načti aktuální data blob ať můžeme drawings do něj merge-nout
    const { data: current, error: getErr } = await supabase
      .from('trades')
      .select('data')
      .eq('id', tradeId)
      .eq('user_id', userId)
      .single();
    if (getErr) {
      console.error("Failed to fetch trade before drawings update:", getErr);
      throw getErr;
    }

    const mergedData = { ...(current?.data || {}), drawings };

    const { error } = await supabase
      .from('trades')
      .update({
        drawings: drawings,
        data: mergedData,
      })
      .eq('id', tradeId)
      .eq('user_id', userId);

    if (error) {
      console.error("Failed to update drawings:", error);
      throw error;
    }

    // Update IndexedDB cache
    const localKey = `alphatrade_trades_${userId}`;
    const cachedTrades: Trade[] = await get(localKey) || [];
    const updatedTrades = cachedTrades.map(t =>
      t.id === tradeId ? { ...t, drawings } : t
    );
    await set(localKey, updatedTrades);
  },

  async updateTrade(tradeId: string | number, updates: Partial<Trade>): Promise<void> {
    const userId = await getUserId();
    if (!userId || !tradeId) return;

    // Fetch the current trade to merge the 'data' blob correctly
    const { data: current, error: getErr } = await supabase
      .from('trades')
      .select('*')
      .eq('id', tradeId)
      .eq('user_id', userId)
      .single();

    if (getErr || !current) {
      const msg = getErr?.message || 'Trade not found';
      console.error("Failed to fetch trade for update:", msg);
      throw new Error(`Nepodařilo se načíst obchod před uložením: ${msg}`);
    }

    const updatedData = {
      ...current.data,
      ...updates
    };

    // Only sync specific known root columns — spreading arbitrary fields causes Supabase 400 errors
    const ROOT_COLUMN_MAP: Record<string, string> = {
      instrument: 'instrument', pnl: 'pnl', direction: 'direction',
      date: 'date', timestamp: 'timestamp', signal: 'signal',
      drawings: 'drawings', isPublic: 'is_public'
    };

    const rootUpdate: any = { data: updatedData };
    Object.keys(updates).forEach(key => {
      if (ROOT_COLUMN_MAP[key]) {
        rootUpdate[ROOT_COLUMN_MAP[key]] = (updates as any)[key];
      }
    });

    const { error } = await supabase
      .from('trades')
      .update(rootUpdate)
      .eq('id', tradeId)
      .eq('user_id', userId);

    if (error) {
      console.error("Failed to update trade:", error);
      throw error;
    }

    // Update IndexedDB cache
    const localKey = `alphatrade_trades_${userId}`;
    const cachedTrades: Trade[] = await get(localKey) || [];
    const updatedTrades = cachedTrades.map(t =>
      t.id === tradeId ? { ...t, ...updates } : t
    );
    await set(localKey, updatedTrades);
  },

  async saveTrades(trades: Trade[]): Promise<Trade[]> {
    const userId = await getUserId();
    if (!userId || trades.length === 0) return [];

    // NOTE: Cache is written AFTER successful DB upsert (not before) to prevent phantom data.
    // If DB fails, cache stays consistent with what's actually persisted.

    let { data: dbAccounts } = await supabase.from('accounts').select('id, name').eq('user_id', userId);

    if (!dbAccounts || dbAccounts.length === 0) {
      const { data: newAcc, error: accErr } = await supabase.from('accounts').insert({
        user_id: userId,
        name: 'Hlavní účet',
        initial_balance: 10000,
        created_at: Date.now()
      }).select().single();

      if (accErr) return [];
      dbAccounts = [newAcc];
    }

    // CRITICAL SAFEGUARD: Preserve existing screenshots for trades loaded without them.
    // getTrades() strips screenshot/screenshots for performance (they're huge base64 blobs).
    // Without this safeguard, re-saving would overwrite the data JSONB and destroy screenshots.
    const existingIdsWithoutScreenshots = trades
      .filter(t => isUUID(t.id as string) && t.screenshot === undefined)
      .map(t => String(t.id));

    const screenshotMap = new Map<string, { screenshot?: string; screenshots?: string[] }>();
    // Track which IDs we failed to verify — these will be excluded from upsert to prevent data loss
    const screenshotFetchFailed = new Set<string>();

    if (existingIdsWithoutScreenshots.length > 0) {
      try {
        const { data: screenshotRows, error: ssErr } = await supabase
          .from('trades')
          .select('id, screenshot:data->>screenshot, screenshots:data->screenshots')
          .in('id', existingIdsWithoutScreenshots)
          .eq('user_id', userId);

        if (ssErr) throw ssErr;

        // Build a set of IDs that were returned by the DB (even with no screenshot)
        const returnedIds = new Set((screenshotRows || []).map((r: any) => String(r.id)));

        screenshotRows?.forEach((row: any) => {
          if (row.screenshot || (row.screenshots && row.screenshots.length > 0)) {
            screenshotMap.set(row.id, {
              screenshot: row.screenshot || undefined,
              screenshots: row.screenshots || undefined
            });
          }
        });

        // ID, které dotaz (userId+id) nevrátil, v DB prostě NEEXISTUJE → je to NOVÝ obchod
        // (např. import s předgenerovaným UUID). Není co zachovat → ulož normálně, NEpřeskakuj.
        // (Dřív se takové ID označilo jako „suspicious" a přeskočilo → nové obchody s UUID
        //  a bez screenshotu se ztrácely. Síťovou chybu pořád řeší catch níže.)
        void returnedIds;
      } catch (err) {
        // Network error or DB error — mark ALL existing trades as unsafe to upsert
        // (new trades with no ID are fine, they can't have screenshots yet)
        console.error('[saveTrades] Screenshot fetch failed — skipping existing trades to prevent data loss:', err);
        existingIdsWithoutScreenshots.forEach(id => screenshotFetchFailed.add(id));
      }
    }

    const tradesToUpsert = trades.map(t => {
      // Skip trades where screenshot fetch failed — safer to skip than risk wiping screenshots
      if (screenshotFetchFailed.has(String(t.id))) {
        console.warn(`[saveTrades] Skipping trade ${t.id} — could not verify screenshots`);
        return null;
      }

      const realAccId = isUUID(t.accountId) ? t.accountId : (dbAccounts?.[0]?.id);
      if (!realAccId) return null;

      const dataBlob: any = { ...t, accountId: realAccId, drawings: t.drawings || [] };

      // Merge preserved screenshots back into the data blob
      const preserved = screenshotMap.get(String(t.id));
      if (preserved?.screenshot && !dataBlob.screenshot) dataBlob.screenshot = preserved.screenshot;
      if (preserved?.screenshots && (!dataBlob.screenshots || dataBlob.screenshots.length === 0)) dataBlob.screenshots = preserved.screenshots;

      const obj: any = {
        user_id: userId,
        account_id: realAccId,
        instrument: t.instrument || '',
        signal: t.signal || '',
        pnl: t.pnl || 0,
        direction: t.direction || 'Long',
        date: t.date || new Date().toISOString(),
        timestamp: t.timestamp || Date.now(),
        drawings: t.drawings || [],
        data: dataBlob
      };

      if (isUUID(t.id)) {
        obj.id = t.id;
      }

      return obj;
    }).filter(Boolean);

    const { data, error } = await supabase.from('trades').upsert(tradesToUpsert).select();
    if (error) throw error;

    const results = (data || []).map(d => ({
      ...d.data,
      id: d.id,
      accountId: d.account_id,
      instrument: d.instrument,
      pnl: d.pnl,
      direction: d.direction,
      date: d.date,
      timestamp: d.timestamp,
      drawings: d.drawings
    }));

    // Fire-and-forget: queue saved trades for RAG embedding (debounced + batched)
    results.forEach(t => embedTrade(t as Trade));

    // Fire-and-forget: detect notable episodes (drawdowns / breakthroughs / outliers)
    // from the just-saved trades — populates Coach's episodic memory.
    maybeDetectEpisodes({
      trades: results.map((t: any) => ({
        id: t.id,
        date: t.date,
        pnl: t.pnl,
        riskAmount: t.riskAmount,
        instrument: t.instrument,
        session: t.session,
      })),
    }).catch(() => {});

    // Cache merge AFTER successful DB upsert — prevents phantom data on DB failure
    try {
      const cacheKey = `alphatrade_trades_${userId}`;
      const currentCache = (await get<Trade[]>(cacheKey)) || [];

      const tradeMap = new Map<string | number, Trade>();
      currentCache.forEach(t => tradeMap.set(t.id, t));
      // Use server-returned results (with DB-assigned UUIDs) instead of input trades
      results.forEach(t => tradeMap.set(t.id, t));

      const mergedCache = Array.from(tradeMap.values()).sort((a, b) => {
        const timeA = a.timestamp || new Date(a.date).getTime();
        const timeB = b.timestamp || new Date(b.date).getTime();
        return timeB - timeA;
      });

      await set(cacheKey, mergedCache);
    } catch (err) {
      console.error("[Storage] Post-save cache merge failed:", err);
    }

    await updateCacheTimestamp();
    return results;
  },

  async deleteTrade(id: string): Promise<void> {
    if (!isUUID(id)) return;
    const userId = await getUserId();
    if (!userId) return;

    // 1. Delete from Supabase (user_id filter for defense-in-depth)
    const { error } = await supabase.from('trades').delete().eq('id', id).eq('user_id', userId);
    if (error) throw error;

    // 2. Update IndexedDB cache
    const localKey = `alphatrade_trades_${userId}`;
    const cachedTrades: Trade[] = await get(localKey) || [];
    const updatedTrades = cachedTrades.filter(t => t.id !== id);
    await set(localKey, updatedTrades);
  },

  async clearTrades(accountId?: string): Promise<void> {
    const userId = await getUserId();
    if (!userId) return;

    // 1. Delete from Supabase
    let query = supabase.from('trades').delete().eq('user_id', userId);
    if (accountId) query = query.eq('account_id', accountId);
    const { error } = await query;
    if (error) throw error;

    // 2. Clear IndexedDB cache
    const localKey = `alphatrade_trades_${userId}`;
    if (accountId) {
      // Partial clear - remove only trades from specific account
      const cachedTrades: Trade[] = await get(localKey) || [];
      const filteredTrades = cachedTrades.filter(t => t.accountId !== accountId);
      await set(localKey, filteredTrades);
    } else {
      // Full clear - remove all trades
      await set(localKey, []);
    }
  },

  async markTradeAsPublic(id: string, shareNotes = false): Promise<void> {
    const userId = await getUserId();
    if (!userId) return;
    // share_notes řídí, jestli veřejný link smí ukázat poznámku (default false).
    await supabase.from('trades').update({ is_public: true, share_notes: shareNotes }).eq('id', id).eq('user_id', userId);
  },

  async getTradeById(id: string): Promise<Trade | null> {
    const userId = await getUserId();
    if (!userId) return null;

    // Filter by user_id to ensure user can only fetch their own trades in detail
    // RLS also protects this, but defense-in-depth is important for full data access
    const { data, error } = await supabase.from('trades').select('*').eq('id', id).eq('user_id', userId).single();
    if (error || !data) return null;
    return {
      ...data.data,
      id: data.id,
      accountId: data.account_id,
      instrument: data.instrument,
      pnl: data.pnl,
      direction: data.direction,
      date: data.date,
      timestamp: data.timestamp,
      drawings: data.drawings || data.data?.drawings || [],
      isPublic: data.is_public,
      createdAt: data.created_at
    };
  },

  /**
   * Načte shared (public) trade + jeho ownera profile.
   * Funguje i pro nepřihlášené uživatele (RLS `is_public = true` policy).
   * Vrací trade + ownerName + ownerAvatar pro SharedTradeView.
   */
  async getPublicTradeById(id: string): Promise<{ trade: Trade; ownerName?: string; ownerAvatar?: string } | null> {
    // SECURITY DEFINER RPC: vrátí veřejný trade s `data.notes` ODSTŘIŽENÝM na serveru,
    // pokud `share_notes` není true. Důležité pro soukromí — přes `select('*')` by poznámka
    // tekla v payloadu i bez zobrazení. RLS dál chrání (vrací jen is_public=true).
    const { data: tradeRow, error: tradeErr } = await supabase
      .rpc('get_public_trade', { p_id: id });
    if (tradeErr || !tradeRow) return null;

    // Owner profile fetch — paralelně by bylo lepší ale jednorázové
    let ownerName: string | undefined;
    let ownerAvatar: string | undefined;
    if (tradeRow.user_id) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('full_name, avatar_url, email')
        .eq('id', tradeRow.user_id)
        .maybeSingle();
      if (profile) {
        ownerName = profile.full_name || (profile.email ? profile.email.split('@')[0] : undefined);
        ownerAvatar = profile.avatar_url || undefined;
      }
    }

    const trade: Trade = {
      ...tradeRow.data,
      id: tradeRow.id,
      accountId: tradeRow.account_id,
      instrument: tradeRow.instrument,
      pnl: tradeRow.pnl,
      direction: tradeRow.direction,
      date: tradeRow.date,
      timestamp: tradeRow.timestamp,
      drawings: tradeRow.drawings || tradeRow.data?.drawings || [],
      isPublic: tradeRow.is_public,
      shareNotes: tradeRow.share_notes,
      createdAt: tradeRow.created_at,
    };

    return { trade, ownerName, ownerAvatar };
  },

  // Batch fetch screenshots for multiple trades.
  // Uses targeted column selectors instead of fetching the whole data blob,
  // which avoids loading megabytes of unrelated JSON per trade.
  async getTradeScreenshots(tradeIds: string[]): Promise<Map<string, { screenshot?: string; screenshots?: string[] }>> {
    const result = new Map<string, { screenshot?: string; screenshots?: string[] }>();
    if (tradeIds.length === 0) return result;

    const userId = await getUserId();
    if (!userId) {
      // Throw so caller knows auth wasn't ready and can retry (vs. "no screenshots found")
      throw new Error('AUTH_NOT_READY');
    }

    try {
      const { data, error } = await supabase
        .from('trades')
        .select('id, screenshot:data->>screenshot, screenshots:data->screenshots')
        .in('id', tradeIds)
        .eq('user_id', userId);

      if (error) {
        console.error('[Screenshots] Supabase fetch error:', error.message);
        return result;
      }
      if (!data) return result;

      data.forEach((row: any) => {
        const screenshot: string | undefined = row.screenshot || undefined;
        // screenshots stored as JSONB array — Supabase returns it already parsed
        const screenshots: string[] | undefined = Array.isArray(row.screenshots) && row.screenshots.length > 0
          ? row.screenshots
          : undefined;

        if (screenshot || screenshots) {
          result.set(row.id, { screenshot, screenshots });
        }
      });
    } catch (err) {
      console.error('[Screenshots] Unexpected error during fetch:', err);
    }

    return result;
  },

  // Globální in-memory cache screenshotů — sdílená napříč komponentami.
  // Naplněná v App.tsx po prvním DB load, čtená v TradeHistory při mountu.
  _screenshotCache: new Map<string, { screenshot?: string; screenshots?: string[] }>(),

  getCachedScreenshots(): Map<string, { screenshot?: string; screenshots?: string[] }> {
    return this._screenshotCache;
  },

  // Globální set ID obchodů jejichž screenshot už byl jednou loadnut v <img onLoad>.
  // Persisted v localStorage — přežije page reload (F5), aby flash nebyl po každém refreshi.
  // Při tab navigaci (dashboard↔history) by samotný Set v paměti stačil, ale po reload
  // se in-memory state resetuje a image musí znova trigger onLoad → 300ms fade-in flash.
  _loadedImageIds: (() => {
    try {
      const raw = localStorage.getItem('alphatrade_loaded_image_ids');
      return raw ? new Set<string>(JSON.parse(raw)) : new Set<string>();
    } catch { return new Set<string>(); }
  })(),

  _loadedImageIdsSaveTimer: null as any,

  getLoadedImageIds(): Set<string> {
    return this._loadedImageIds;
  },

  markImageLoaded(id: string): void {
    this._loadedImageIds.add(id);
    // Debounced persist — zabrání hammer localStorage při scroll načítání 50 obrázků
    if (this._loadedImageIdsSaveTimer) clearTimeout(this._loadedImageIdsSaveTimer);
    this._loadedImageIdsSaveTimer = setTimeout(() => {
      try {
        localStorage.setItem('alphatrade_loaded_image_ids', JSON.stringify([...this._loadedImageIds]));
      } catch { /* localStorage full / blocked */ }
    }, 500);
  },

  // Prefetch all trade screenshots in background (returns map of id -> screenshot)
  async prefetchAllScreenshots(): Promise<Map<string, { screenshot?: string; screenshots?: string[] }>> {
    // Pokud už máme cached, vrať instantně (žádný duplicitní DB query)
    if (this._screenshotCache.size > 0) {
      return this._screenshotCache;
    }
    const result = new Map<string, { screenshot?: string; screenshots?: string[] }>();
    const userId = await getUserId();
    if (!userId) return result;

    try {
      // Use targeted selectors — avoids loading the entire data JSONB blob per trade
      const { data, error } = await supabase
        .from('trades')
        .select('id, screenshot:data->>screenshot, screenshots:data->screenshots')
        .eq('user_id', userId);

      if (error || !data) return result;

      data.forEach((row: any) => {
        const screenshot: string | undefined = row.screenshot || undefined;
        const screenshots: string[] | undefined = Array.isArray(row.screenshots) && row.screenshots.length > 0
          ? row.screenshots
          : undefined;
        if (screenshot || screenshots) {
          result.set(row.id, { screenshot, screenshots });
        }
      });
      // Update sdílený cache pro TradeHistory mount
      result.forEach((v, k) => this._screenshotCache.set(k, v));

      // HTTP preload — stáhne všechny screenshoty do browser cache na pozadí.
      // Když pak <img src=url> render-uje, browser ho má z RAM (instant, žádný flash).
      // Throttle 5 paralelně ať nezabijeme network při 100+ obrázcích.
      const urls: string[] = [];
      result.forEach(v => {
        if (v.screenshot) urls.push(v.screenshot);
      });
      const preloadBatch = async (start: number) => {
        const batch = urls.slice(start, start + 5);
        await Promise.all(batch.map(url => new Promise<void>(resolve => {
          const img = new Image();
          img.onload = img.onerror = () => resolve();
          img.src = url;
        })));
        if (start + 5 < urls.length) preloadBatch(start + 5);
      };
      if (urls.length > 0) preloadBatch(0);
    } catch (err) {
      console.warn('[prefetchAllScreenshots] Failed:', err);
    }

    return result;
  },

  // Accounts
  getCachedAccounts(targetUserId?: string): Account[] {
    // Use userId from cache or provided targetUserId
    const keyId = targetUserId || cachedUserId;
    const localKey = keyId ? `alphatrade_accounts_${keyId}` : 'alphatrade_accounts';
    const localData = localStorage.getItem(localKey);
    if (!localData) return [];
    try {
      return JSON.parse(localData);
    } catch (e) {
      console.error("Failed to parse local accounts", e);
      return [];
    }
  },

  async getAccounts(targetUserId?: string): Promise<Account[]> {
    const userId = targetUserId || await getUserId();

    // Fast local storage fallback - always use userId-scoped key
    const localKey = userId ? `alphatrade_accounts_${userId}` : 'alphatrade_accounts';
    const localData = localStorage.getItem(localKey);
    let localAccounts: Account[] = [];
    if (localData) {
      try {
        localAccounts = JSON.parse(localData);
      } catch (e) {
        console.error("Failed to parse local accounts", e);
      }
    }

    if (!userId) return localAccounts;

    const { data, error } = await supabase
      .from('accounts')
      .select('*')
      .eq('user_id', userId);

    if (error) return localAccounts;

    const allAccounts = data.map(a => ({
      ...a.meta,
      id: a.id,
      name: a.name,
      initialBalance: a.initial_balance,
      currency: a.currency,
      type: a.type,
      status: a.status,
      createdAt: a.created_at,
      isArchived: a.meta?.isArchived,
      archivedAt: a.meta?.archivedAt,
      result: a.meta?.result,
      phase: a.meta?.phase
    }));

    // Only return active (non-archived) accounts
    const accounts = allAccounts.filter(a => !a.isArchived);

    // Cache result
    safeSetItem(localKey, accounts);
    return accounts;
  },

  // Fetch only archived accounts (lazy-loaded when needed)
  async getArchivedAccounts(targetUserId?: string): Promise<Account[]> {
    const userId = targetUserId || await getUserId();
    if (!userId) return [];

    const { data, error } = await supabase
      .from('accounts')
      .select('*')
      .eq('user_id', userId);

    if (error || !data) return [];

    return data
      .map(a => ({
        ...a.meta,
        id: a.id,
        name: a.name,
        initialBalance: a.initial_balance,
        currency: a.currency,
        type: a.type,
        status: a.status,
        createdAt: a.created_at,
        isArchived: a.meta?.isArchived,
        archivedAt: a.meta?.archivedAt,
        result: a.meta?.result,
        phase: a.meta?.phase
      }))
      // Považuj za "neaktivní/spálený" cokoliv s isArchived=true NEBO status=Inactive.
      // Bez tohoto se ztrácí staré účty (status=Inactive, isArchived=null/false), kde sedí
      // až desítky trades — v Historie/Deník/Combined dashboardu se vůbec nezobrazí.
      .filter(a => a.isArchived === true || a.status === 'Inactive');
  },

  async saveAccounts(accounts: Account[]): Promise<Account[]> {
    const userId = await getUserId();
    const localKey = userId ? `alphatrade_accounts_${userId}` : 'alphatrade_accounts';

    // If not logged in, save locally and return (no DB)
    if (!userId || accounts.length === 0) {
      safeSetItem(localKey, accounts);
      return accounts;
    }

    const existingAccounts = accounts.filter(a => isUUID(a.id));
    const newAccounts = accounts.filter(a => !isUUID(a.id));

    const results: Account[] = [];

    try {
      // 1. Process existing accounts (Upsert with ID)
      if (existingAccounts.length > 0) {
        const toUpsert = existingAccounts.map(a => ({
          id: a.id,
          user_id: userId,
          name: a.name,
          initial_balance: a.initialBalance,
          currency: a.currency || 'USD',
          type: a.type || 'Funded',
          status: a.status || 'Active',
          created_at: a.createdAt || Date.now(),
          meta: { ...a }
        }));

        const { data, error } = await supabase.from('accounts').upsert(toUpsert).select();
        if (error) throw error;
        if (data) {
          results.push(...data.map(d => ({
            ...d.meta,
            id: d.id,
            name: d.name,
            initialBalance: d.initial_balance,
            currency: d.currency,
            type: d.type,
            status: d.status,
            createdAt: d.created_at
          })));
        }
      }

      // 2. Process new accounts (Insert without ID)
      if (newAccounts.length > 0) {
        const toInsert = newAccounts.map(a => ({
          user_id: userId,
          name: a.name,
          initial_balance: a.initialBalance,
          currency: a.currency || 'USD',
          type: a.type || 'Funded',
          status: a.status || 'Active',
          created_at: a.createdAt || Date.now(),
          meta: { ...a }
        }));

        const { data, error } = await supabase.from('accounts').insert(toInsert).select();
        if (error) throw error;
        if (data) {
          results.push(...data.map(d => ({
            ...d.meta,
            id: d.id,
            name: d.name,
            initialBalance: d.initial_balance,
            currency: d.currency,
            type: d.type,
            status: d.status,
            createdAt: d.created_at
          })));
        }
      }

      const finalResults = results.length > 0 ? results : accounts;
      // Update cache with server results (which have real IDs)
      safeSetItem(localKey, finalResults);
      await updateCacheTimestamp(); // Mark cache as fresh
      return finalResults;

    } catch (err: any) {
      console.error("Critical error in saveAccounts split-sync:", {
        message: err.message,
        code: err.code,
        details: err.details
      });
      throw err;
    }
  },

  async deleteAccount(id: string): Promise<void> {
    if (!isUUID(id)) return;
    const userId = await getUserId();
    if (!userId) return;

    // Delete orphaned trades belonging to this account FIRST
    const { error: tradesErr } = await supabase.from('trades').delete().eq('account_id', id).eq('user_id', userId);
    if (tradesErr) console.error("[deleteAccount] Failed to delete orphaned trades:", tradesErr);

    // Delete the account
    const { error } = await supabase.from('accounts').delete().eq('id', id).eq('user_id', userId);
    if (error) {
      console.error("Supabase deleteAccount error:", error);
      throw error;
    }

    // Update localStorage cache
    const localKey = `alphatrade_accounts_${userId}`;
    const localData = localStorage.getItem(localKey);
    if (localData) {
      try {
        const accounts = JSON.parse(localData).filter((a: any) => a.id !== id);
        safeSetItem(localKey, accounts);
      } catch (e) { /* ignore parse error */ }
    }

    // Update IndexedDB trades cache
    const tradesKey = `alphatrade_trades_${userId}`;
    const cachedTrades: Trade[] = await get(tradesKey) || [];
    const filteredTrades = cachedTrades.filter(t => t.accountId !== id);
    await set(tradesKey, filteredTrades);
  },

  // Preferences
  async getCachedPreferences(): Promise<UserPreferences | null> {
    const userId = await getUserId();
    const localKey = userId ? `alphatrade_preferences_${userId}` : 'alphatrade_preferences';
    const stored = localStorage.getItem(localKey);
    if (!stored) return null;
    try {
      return JSON.parse(stored);
    } catch (e) {
      return null;
    }
  },

  async getPreferences(targetUserId?: string): Promise<UserPreferences | null> {
    const userId = targetUserId || await getUserId();
    if (!userId) return null;

    const { data, error } = await supabase
      .from('profiles')
      .select('preferences')
      .eq('id', userId)
      .single();

    if (error || !data) return null;

    // CRITICAL FIX: Update localStorage cache with fresh data from Supabase
    // This prevents data loss when page reloads
    const localKey = userId ? `alphatrade_preferences_${userId}` : 'alphatrade_preferences';
    if (data.preferences) {
      safeSetItem(localKey, data.preferences);
    }

    return data.preferences;
  },

  async savePreferences(prefs: UserPreferences): Promise<void> {
    const userId = await getUserId();
    const localKey = userId ? `alphatrade_preferences_${userId}` : 'alphatrade_preferences';

    if (!userId) {
      // Still save locally even if not logged in (e.g. login page theme)
      safeSetItem(localKey, prefs);
      return;
    }
    // Write to Supabase FIRST — if it fails, don't update the local cache so state stays consistent.
    // Use SELECT after UPDATE to VERIFY persistence — protects against silent failures
    // (RLS edge cases, network glitch). If verify fails, throw to trigger retry.
    const { data, error } = await supabase
      .from('profiles')
      .update({ preferences: prefs })
      .eq('id', userId)
      .select('preferences')
      .single();
    if (error) {
      console.error('[savePreferences] DB error:', error);
      throw error;
    }
    if (!data || !data.preferences) {
      const msg = '[savePreferences] Verification failed — DB returned no preferences after update';
      console.error(msg);
      throw new Error(msg);
    }
    // Persist to localStorage only after confirmed DB write
    safeSetItem(localKey, prefs);
    // Store save timestamp for staleness detection
    safeSetItem(`${localKey}_savedAt`, Date.now());
    await updateCacheTimestamp();
  },

  // Daily Journal
  async getCachedDailyPreps(): Promise<DailyPrep[]> {
    const userId = await getUserId();
    if (!userId) return [];
    // Use IndexedDB for large data (screenshots are base64 encoded)
    const cached = await get(`alphatrade_daily_preps_${userId}`);
    return cached || [];
  },

  async getCachedDailyReviews(): Promise<DailyReview[]> {
    const userId = await getUserId();
    if (!userId) return [];
    // Use IndexedDB for large data
    const cached = await get(`alphatrade_daily_reviews_${userId}`);
    return cached || [];
  },

  async getDailyPreps(targetUserId?: string): Promise<DailyPrep[]> {
    const userId = targetUserId || await getUserId();
    if (!userId) return [];

    // 1. Fetch from Supabase
    const { data, error } = await supabase.from('daily_preps').select('*').eq('user_id', userId);

    if (error) {
      console.error("Supabase getDailyPreps error:", error);
      // Fallback to IndexedDB cache
      const cached = await get(`alphatrade_daily_preps_${userId}`);
      return cached || [];
    }

    const dbPreps = data.map(d => ({ ...d.data, id: d.id, date: d.date }));

    // Cache to IndexedDB (fire-and-forget)
    if (userId) set(`alphatrade_daily_preps_${userId}`, dbPreps);

    return dbPreps;
  },

  // Backtest session pre/post poznámky (samostatná tabulka, mimo RAG/embeddings).
  // Volitelně omezené na konkrétní backtest účty.
  async getBacktestSessions(accountIds?: string[], targetUserId?: string): Promise<Array<{ id: string; accountId: string; date: string; block: string; bias?: string; preNotes?: string; postNotes?: string }>> {
    const userId = targetUserId || await getUserId();
    if (!userId) return [];
    let query = supabase.from('backtest_sessions').select('id, account_id, date, block, data').eq('user_id', userId);
    if (accountIds && accountIds.length) query = query.in('account_id', accountIds);
    const { data, error } = await query;
    if (error) { console.error('Supabase getBacktestSessions error:', error); return []; }
    return (data || []).map((r: any) => ({
      id: r.id, accountId: r.account_id, date: r.date, block: r.block,
      bias: r.data?.bias, preNotes: r.data?.preNotes, postNotes: r.data?.postNotes,
    }));
  },

  async saveSinglePrep(prep: DailyPrep): Promise<void> {
    const userId = await getUserId();
    if (!userId) return;
    const { error } = await supabase.from('daily_preps').upsert({ user_id: userId, date: prep.date, data: prep }, { onConflict: 'user_id,date' });
    if (error) throw error;
    // Update IDB cache
    const cached = await get<DailyPrep[]>(`alphatrade_daily_preps_${userId}`) || [];
    await set(`alphatrade_daily_preps_${userId}`, [...cached.filter(p => p.date !== prep.date), prep]);
    // Fire-and-forget embedding update for RAG (debounced inside embeddingService)
    embedPrep(prep);
  },

  async saveSingleReview(review: DailyReview): Promise<void> {
    const userId = await getUserId();
    if (!userId) return;
    const { error } = await supabase.from('daily_reviews').upsert({ user_id: userId, date: review.date, data: review }, { onConflict: 'user_id,date' });
    if (error) throw error;
    // Update IDB cache
    const cached = await get<DailyReview[]>(`alphatrade_daily_reviews_${userId}`) || [];
    await set(`alphatrade_daily_reviews_${userId}`, [...cached.filter(r => r.date !== review.date), review]);
    embedReview(review);
  },

  async saveDailyPreps(preps: DailyPrep[]): Promise<void> {
    const userId = await getUserId();
    if (!userId) return;

    // KRITICKÉ: stripni base64 obrázky z preps PŘED save do DB.
    // Bez tohoto se base64 ukládá inline do JSONB → enormní velikost (až 700 KB/row),
    // špatný query performance a disk IO budget overage. Šetří 90%+ velikosti tabulky.
    for (const p of preps) {
      if (hasBase64Images(p)) {
        const n = await stripAndUploadBase64Images(p, `prep_${p.date}`);
        if (n > 0) console.info(`[saveDailyPreps] uploaded ${n} base64 image(s) → URL pro ${p.date}`);
      }
    }

    // Sync to Supabase FIRST (cache written after success to prevent phantom data)
    const prepsToUpsert = preps.map(p => ({ user_id: userId, date: p.date, data: p }));
    const { error } = await supabase.from('daily_preps').upsert(prepsToUpsert, { onConflict: 'user_id,date' });
    if (error) {
      console.error("Failed to sync preps to Supabase:", error);
      throw error;
    }

    // Cache AFTER successful DB write
    await set(`alphatrade_daily_preps_${userId}`, preps);
    await updateCacheTimestamp();
  },

  /**
   * One-time migration: projde existující daily_preps + daily_reviews, najde
   * base64 image inline data v JSONB, uploadne je do Storage a v JSONB
   * nahradí URL. Šetří 90%+ velikosti tabulky a IO budget.
   * Idempotentní — po prvním běhu nemá co dělat.
   */
  async migrateBase64InJournals(
    onProgress?: (msg: string) => void
  ): Promise<{ preps: number; reviews: number; uploaded: number }> {
    const userId = await getUserId();
    if (!userId) throw new Error('Not authenticated');

    const result = { preps: 0, reviews: 0, uploaded: 0 };

    // Preps
    const { data: preps } = await supabase.from('daily_preps').select('id, date, data').eq('user_id', userId);
    for (const row of preps || []) {
      const data = row.data as any;
      if (!hasBase64Images(data)) continue;
      const n = await stripAndUploadBase64Images(data, `prep_${row.date}_migrate`);
      if (n > 0) {
        const { error } = await supabase.from('daily_preps').update({ data }).eq('id', row.id);
        if (!error) {
          result.preps++;
          result.uploaded += n;
          onProgress?.(`Prep ${row.date}: ${n} obrázek/ů`);
        } else {
          console.warn(`[migrate] update failed for prep ${row.date}:`, error);
        }
      }
    }

    // Reviews
    const { data: reviews } = await supabase.from('daily_reviews').select('id, date, data').eq('user_id', userId);
    for (const row of reviews || []) {
      const data = row.data as any;
      if (!hasBase64Images(data)) continue;
      const n = await stripAndUploadBase64Images(data, `review_${row.date}_migrate`);
      if (n > 0) {
        const { error } = await supabase.from('daily_reviews').update({ data }).eq('id', row.id);
        if (!error) {
          result.reviews++;
          result.uploaded += n;
          onProgress?.(`Review ${row.date}: ${n} obrázek/ů`);
        } else {
          console.warn(`[migrate] update failed for review ${row.date}:`, error);
        }
      }
    }

    return result;
  },

  async deleteDailyPrep(date: string): Promise<void> {
    const userId = await getUserId();
    if (!userId) return;
    const { error } = await supabase.from('daily_preps').delete().eq('user_id', userId).eq('date', date);
    if (error) { console.error("[deleteDailyPrep] DB error:", error); throw error; }

    // Update IndexedDB cache
    const cached = await get<DailyPrep[]>(`alphatrade_daily_preps_${userId}`) || [];
    await set(`alphatrade_daily_preps_${userId}`, cached.filter(p => p.date !== date));
  },

  async getDailyReviews(targetUserId?: string): Promise<DailyReview[]> {
    const userId = targetUserId || await getUserId();
    if (!userId) return [];

    // 1. Fetch from Supabase
    const { data, error } = await supabase.from('daily_reviews').select('*').eq('user_id', userId);

    if (error) {
      console.error("Supabase getDailyReviews error:", error);
      // Fallback to IndexedDB cache
      const cached = await get(`alphatrade_daily_reviews_${userId}`);
      return cached || [];
    }

    const dbReviews = data.map(d => ({ ...d.data, id: d.id, date: d.date }));

    // Cache to IndexedDB (fire-and-forget)
    if (userId) set(`alphatrade_daily_reviews_${userId}`, dbReviews);

    return dbReviews;
  },

  async saveDailyReviews(reviews: DailyReview[]): Promise<void> {
    const userId = await getUserId();
    if (!userId) return;

    // KRITICKÉ: stripni base64 obrázky z reviews PŘED save (viz saveDailyPreps)
    for (const r of reviews) {
      if (hasBase64Images(r)) {
        const n = await stripAndUploadBase64Images(r, `review_${r.date}`);
        if (n > 0) console.info(`[saveDailyReviews] uploaded ${n} base64 image(s) → URL pro ${r.date}`);
      }
    }

    // Sync to Supabase FIRST (cache written after success to prevent phantom data)
    const reviewsToUpsert = reviews.map(r => ({ user_id: userId, date: r.date, data: r }));
    const { error } = await supabase.from('daily_reviews').upsert(reviewsToUpsert, { onConflict: 'user_id,date' });
    if (error) {
      console.error("Failed to sync reviews to Supabase:", error);
      throw error;
    }

    // Cache AFTER successful DB write
    await set(`alphatrade_daily_reviews_${userId}`, reviews);
    await updateCacheTimestamp();
  },

  async deleteDailyReview(date: string): Promise<void> {
    const userId = await getUserId();
    if (!userId) return;
    const { error } = await supabase.from('daily_reviews').delete().eq('user_id', userId).eq('date', date);
    if (error) { console.error("[deleteDailyReview] DB error:", error); throw error; }

    // Update IndexedDB cache
    const cached = await get<DailyReview[]>(`alphatrade_daily_reviews_${userId}`) || [];
    await set(`alphatrade_daily_reviews_${userId}`, cached.filter(r => r.date !== date));
  },

  // Weekly & Monthly
  async getWeeklyReviews(): Promise<WeeklyReview[]> { return []; },
  async saveWeeklyReviews(_reviews: WeeklyReview[]): Promise<void> { },
  async getMonthlyReviews(): Promise<MonthlyReview[]> { return []; },
  async saveMonthlyReviews(_reviews: MonthlyReview[]): Promise<void> { },

  // Weekly Focus
  async getWeeklyFocus(weekISO: string): Promise<WeeklyFocus | null> {
    const userId = await getUserId();
    if (!userId) return null;
    const { data, error } = await supabase
      .from('weekly_focus')
      .select('*')
      .eq('user_id', userId)
      .eq('week_iso', weekISO)
      .maybeSingle();

    if (error || !data) return null;

    // Map legacy string array to WeeklyGoal objects if needed
    const goals = (data.goals || []).map((g: any, i: number) =>
      typeof g === 'string' ? { id: `g_${i}`, text: g, emoji: this.predictEmoji(g) } : g
    );

    return { id: data.id, weekISO: data.week_iso, goals };
  },

  async getWeeklyFocusList(): Promise<WeeklyFocus[]> {
    const userId = await getUserId();
    if (!userId) return [];
    const { data, error } = await supabase
      .from('weekly_focus')
      .select('*')
      .eq('user_id', userId);

    if (error) return [];
    return data.map(d => {
      const goals = (d.goals || []).map((g: any, i: number) =>
        typeof g === 'string' ? { id: `g_${i}`, text: g, emoji: this.predictEmoji(g) } : g
      );
      return { id: d.id, weekISO: d.week_iso, goals };
    });
  },

  predictEmoji(text: string): string {
    const t = text.toLowerCase();
    if (t.includes('risk') || t.includes('stop loss') || t.includes('sl')) return '🛡️';
    if (t.includes('profit') || t.includes('tp') || t.includes('target')) return '🎯';
    if (t.includes('discipline') || t.includes('discipline') || t.includes('trval') || t.includes('pravidl')) return '⚖️';
    if (t.includes('patience') || t.includes('trpělivost') || t.includes('počkej') || t.includes('wait')) return '🧘';
    if (t.includes('entry') || t.includes('vstup')) return '🚪';
    if (t.includes('exit') || t.includes('výstup')) return '🏁';
    if (t.includes('overtrading') || t.includes('míň') || t.includes('limit')) return '🛑';
    if (t.includes('analysis') || t.includes('analýza') || t.includes('příprava')) return '🔭';
    if (t.includes('news') || t.includes('zprávy')) return '📰';
    if (t.includes('journal') || t.includes('deník') || t.includes('zápis')) return '✍️';
    if (t.includes('morning') || t.includes('ráno')) return '🌅';
    if (t.includes('evening') || t.includes('večer')) return '🌃';
    if (t.includes('meditation') || t.includes('meditace')) return '🧘‍♂️';
    if (t.includes('gym') || t.includes('cvičení')) return '💪';
    if (t.includes('sleep') || t.includes('spánek')) return '😴';
    if (t.includes('money') || t.includes('peníze')) return '💰';
    if (t.includes('chart') || t.includes('graf')) return '📊';
    return '✨'; // Default magic
  },

  async saveWeeklyFocus(focus: WeeklyFocus): Promise<void> {
    const userId = await getUserId();
    if (!userId) return;
    const { error } = await supabase
      .from('weekly_focus')
      .upsert({
        user_id: userId,
        week_iso: focus.weekISO,
        goals: focus.goals
      }, { onConflict: 'user_id,week_iso' });

    if (error) throw error;

    // Update IDB cache so getCachedDashboardData stays fresh
    try {
      const cached: WeeklyFocus[] = await get(`alphatrade_weekly_focus_${userId}`) || [];
      const updated = cached.some(f => f.weekISO === focus.weekISO)
        ? cached.map(f => f.weekISO === focus.weekISO ? focus : f)
        : [...cached, focus];
      await set(`alphatrade_weekly_focus_${userId}`, updated);
    } catch (cacheErr) {
      console.warn('[saveWeeklyFocus] IDB cache update failed (non-fatal):', cacheErr);
    }
  },

  // Business Hub
  async getBusinessExpenses(): Promise<BusinessExpense[]> {
    const userId = await getUserId();
    if (!userId) return [];

    const { data, error } = await supabase
      .from('business_expenses')
      .select('*')
      .eq('user_id', userId)
      .order('date', { ascending: false });

    if (error) {
      console.error('[Storage] Error fetching expenses:', error);
      return [];
    }

    return (data || []).map((d: any) => {
      // Extra fields stored as JSON in description — try parse regardless of first char
      let extra: any = {};
      try { extra = JSON.parse(d.description); } catch { /* plain text description, extra stays {} */ }
      return {
        id: d.id,
        user_id: d.user_id,
        date: d.date,
        label: extra.label || d.description || '',
        description: d.description,
        amount: d.amount,
        category: d.category,
        recurring: extra.recurring || 'monthly',
        created_at: d.created_at,
        updated_at: d.updated_at
      };
    });
  },

  async saveBusinessExpense(expense: Omit<BusinessExpense, 'id' | 'created_at' | 'updated_at'>): Promise<void> {
    const userId = await getUserId();
    if (!userId) throw new Error('Not authenticated');

    const { error } = await supabase
      .from('business_expenses')
      .insert({
        user_id: userId,
        date: expense.date,
        description: JSON.stringify({ label: expense.label || expense.description || '', recurring: expense.recurring }),
        amount: expense.amount,
        category: expense.category
      });

    if (error) {
      console.error('[Storage] Failed to save expense:', error);
      throw new Error('Failed to save expense');
    }
  },

  async updateBusinessExpense(id: string, updates: Partial<BusinessExpense>): Promise<void> {
    const userId = await getUserId();
    if (!userId) throw new Error('Not authenticated');

    const dbUpdates: any = {};
    if (updates.date) dbUpdates.date = updates.date;
    if (updates.amount !== undefined) dbUpdates.amount = updates.amount;
    if (updates.category) dbUpdates.category = updates.category;
    dbUpdates.description = JSON.stringify({ label: updates.label || updates.description || '', recurring: updates.recurring });

    const { error } = await supabase
      .from('business_expenses')
      .update(dbUpdates)
      .eq('id', id)
      .eq('user_id', userId);

    if (error) {
      console.error('[Storage] Failed to update expense:', error);
      throw new Error('Failed to update expense');
    }
  },

  async deleteBusinessExpense(id: string): Promise<void> {
    const userId = await getUserId();
    if (!userId) throw new Error('Not authenticated');

    const { error } = await supabase
      .from('business_expenses')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);

    if (error) {
      console.error('[Storage] Failed to delete expense:', error);
      throw new Error('Failed to delete expense');
    }
  },

  async getBusinessPayouts(): Promise<BusinessPayout[]> {
    const userId = await getUserId();
    if (!userId) return [];

    // Optimized: select individual JSON fields to avoid fetching heavy base64 images from description
    const { data, error } = await supabase
      .from('business_payouts')
      .select(`
        id,
        user_id,
        date,
        amount,
        payout_method,
        created_at,
        updated_at,
        grossAmount:description->grossAmount,
        profitSplitUsed:description->profitSplitUsed,
        accountId:description->>accountId,
        notes:description->>notes,
        status:description->>status
      `)
      .eq('user_id', userId)
      .order('date', { ascending: false });

    if (error) {
      console.error('[Storage] Error fetching payouts:', error);
      return [];
    }

    return (data || []).map((d: any) => ({
      id: d.id,
      user_id: d.user_id,
      date: d.date,
      amount: d.amount,
      payout_method: d.payout_method,
      grossAmount: d.grossAmount ? Number(d.grossAmount) : undefined,
      profitSplitUsed: d.profitSplitUsed ? Number(d.profitSplitUsed) : undefined,
      accountId: d.accountId,
      notes: d.notes,
      status: d.status || 'Received',
      created_at: d.created_at,
      updated_at: d.updated_at
    }));
  },

  // Prefetch payout proof images in background (like trade screenshots)
  // description is TEXT column containing JSON with base64 image - must parse client-side
  async prefetchPayoutImages(): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const userId = await getUserId();
    if (!userId) return result;

    const { data, error } = await supabase
      .from('business_payouts')
      .select('id, description')
      .eq('user_id', userId);

    if (error || !data) return result;

    data.forEach((row: any) => {
      try {
        if (row.description?.startsWith('{')) {
          const parsed = JSON.parse(row.description);
          if (parsed.image) {
            result.set(String(row.id), parsed.image);
          }
        }
      } catch { }
    });

    return result;
  },

  async saveBusinessPayout(payout: Omit<BusinessPayout, 'id' | 'created_at' | 'updated_at'>): Promise<void> {
    const userId = await getUserId();
    if (!userId) throw new Error('Not authenticated');

    const { error } = await supabase
      .from('business_payouts')
      .insert({
        user_id: userId,
        date: payout.date,
        amount: payout.amount,
        description: JSON.stringify({
          grossAmount: payout.grossAmount,
          profitSplitUsed: payout.profitSplitUsed,
          accountId: payout.accountId,
          image: payout.image,
          notes: payout.notes,
          status: payout.status
        }),
        payout_method: payout.payout_method
      });

    if (error) {
      console.error('[Storage] Failed to save payout:', error);
      throw new Error('Failed to save payout');
    }
  },

  async updateBusinessPayout(id: string, updates: Partial<BusinessPayout>): Promise<void> {
    const userId = await getUserId();
    if (!userId) throw new Error('Not authenticated');

    const dbUpdates: any = {};
    if (updates.date) dbUpdates.date = updates.date;
    if (updates.amount !== undefined) dbUpdates.amount = updates.amount;
    if (updates.payout_method) dbUpdates.payout_method = updates.payout_method;
    dbUpdates.description = JSON.stringify({
      grossAmount: updates.grossAmount,
      profitSplitUsed: updates.profitSplitUsed,
      accountId: updates.accountId,
      image: updates.image,
      notes: updates.notes,
      status: updates.status
    });

    const { error } = await supabase
      .from('business_payouts')
      .update(dbUpdates)
      .eq('id', id)
      .eq('user_id', userId);

    if (error) {
      console.error('[Storage] Failed to update payout:', error);
      throw new Error('Failed to update payout');
    }
  },

  async deleteBusinessPayout(id: string): Promise<void> {
    const userId = await getUserId();
    if (!userId) throw new Error('Not authenticated');

    const { error } = await supabase
      .from('business_payouts')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);

    if (error) {
      console.error('[Storage] Failed to delete payout:', error);
      throw new Error('Failed to delete payout');
    }
  },

  async getPlaybookItems(): Promise<PlaybookItem[]> {
    const prefs = await this.getPreferences();
    return prefs?.playbookItems || [];
  },

  async getBusinessGoals(): Promise<BusinessGoal[]> {
    const userId = await getUserId();
    if (!userId) return [];

    const { data, error } = await supabase
      .from('business_goals')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[Storage] Error fetching goals:', error);
      return [];
    }

    return data || [];
  },

  async saveBusinessGoal(goal: Omit<BusinessGoal, 'id' | 'created_at' | 'updated_at'>): Promise<void> {
    const userId = await getUserId();
    if (!userId) throw new Error('Not authenticated');

    const { error } = await supabase
      .from('business_goals')
      .insert({
        ...goal,
        user_id: userId
      });

    if (error) {
      console.error('[Storage] Failed to save goal:', error);
      throw new Error('Failed to save goal');
    }
  },

  async updateBusinessGoal(id: string, updates: Partial<BusinessGoal>): Promise<void> {
    const userId = await getUserId();
    if (!userId) throw new Error('Not authenticated');

    const { error } = await supabase
      .from('business_goals')
      .update(updates)
      .eq('id', id)
      .eq('user_id', userId);

    if (error) {
      console.error('[Storage] Failed to update goal:', error);
      throw new Error('Failed to update goal');
    }
  },

  async deleteBusinessGoal(id: string): Promise<void> {
    const userId = await getUserId();
    if (!userId) throw new Error('Not authenticated');

    const { error } = await supabase
      .from('business_goals')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);

    if (error) {
      console.error('[Storage] Failed to delete goal:', error);
      throw new Error('Failed to delete goal');
    }
  },

  async getBusinessResources(): Promise<BusinessResource[]> {
    const userId = await getUserId();
    if (!userId) return [];

    const { data, error } = await supabase
      .from('business_resources')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[Storage] Error fetching resources:', error);
      return [];
    }

    return data || [];
  },

  async saveBusinessResource(resource: Omit<BusinessResource, 'id' | 'created_at' | 'updated_at'>): Promise<void> {
    const userId = await getUserId();
    if (!userId) throw new Error('Not authenticated');

    const { error } = await supabase
      .from('business_resources')
      .insert({
        ...resource,
        user_id: userId
      });

    if (error) {
      console.error('[Storage] Failed to save resource:', error);
      throw new Error('Failed to save resource');
    }
  },

  async updateBusinessResource(id: string, updates: Partial<BusinessResource>): Promise<void> {
    const userId = await getUserId();
    if (!userId) throw new Error('Not authenticated');

    const { error } = await supabase
      .from('business_resources')
      .update(updates)
      .eq('id', id)
      .eq('user_id', userId);

    if (error) {
      console.error('[Storage] Failed to update resource:', error);
      throw new Error('Failed to update resource');
    }
  },

  async deleteBusinessResource(id: string): Promise<void> {
    const userId = await getUserId();
    if (!userId) throw new Error('Not authenticated');

    const { error } = await supabase
      .from('business_resources')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);

    if (error) {
      console.error('[Storage] Failed to delete resource:', error);
      throw new Error('Failed to delete resource');
    }
  },

  async getBusinessSettings(): Promise<BusinessSettings> {
    const prefs = await this.getPreferences();
    return prefs?.businessSettings || { taxRatePct: 15, defaultPropThreshold: 150 };
  },

  // Active State (scoped by cached userId to prevent cross-user leaks)
  getActiveAccountId(): string | null {
    const key = cachedUserId ? `alphatrade_active_account_${cachedUserId}` : 'alphatrade_active_account';
    return localStorage.getItem(key);
  },
  setActiveAccountId(id: string): void {
    const key = cachedUserId ? `alphatrade_active_account_${cachedUserId}` : 'alphatrade_active_account';
    localStorage.setItem(key, id);
  },

  async clearAll(): Promise<void> {
    localStorage.clear();
    await supabase.auth.signOut();
  },

  // Network / Social
  async searchUsers(query: string): Promise<UserSearch[]> {
    const userId = await getUserId();
    if (!userId) return [];

    // Sanitize query: remove PostgREST filter special characters (keep . and @ for email search)
    const sanitized = query.replace(/[%_(),\\]/g, '').trim();
    if (!sanitized || sanitized.length < 2) return [];

    const { data, error } = await supabase
      .from('profiles')
      .select('id, email, full_name')
      .or(`email.ilike.%${sanitized}%,full_name.ilike.%${sanitized}%`)
      .neq('id', userId)
      .limit(10);

    if (error) return [];
    return data || [];
  },

  async sendFollowRequest(receiverId: string): Promise<void> {
    const userId = await getUserId();
    if (!userId) throw new Error("Not authenticated");
    const { error } = await supabase.from('connections').insert({
      sender_id: userId,
      receiver_id: receiverId,
      status: 'pending'
    });
    if (error) {
      if (error.code === '23505') throw new Error("Žádost již byla odeslána.");
      throw error;
    }
  },

  async getConnections(): Promise<SocialConnection[]> {
    const userId = await getUserId();
    if (!userId) return [];
    const { data, error } = await supabase
      .from('connections')
      .select(`*, sender: profiles!sender_id(id, email, full_name), receiver: profiles!receiver_id(id, email, full_name)`)
      .or(`sender_id.eq.${userId},receiver_id.eq.${userId}`)
      .in('status', ['pending', 'accepted']);

    if (error) return [];
    return (data || []).map(c => ({
      ...c,
      sender: c.sender ? { id: c.sender.id, email: c.sender.email, name: c.sender.full_name } : undefined,
      receiver: c.receiver ? { id: c.receiver.id, email: c.receiver.email, name: c.receiver.full_name } : undefined
    }));
  },

  async updateConnectionStatus(connectionId: string, status: 'accepted' | 'rejected'): Promise<void> {
    const userId = await getUserId();
    if (!userId) throw new Error('Not authenticated');

    if (status === 'rejected') {
      // First update status to 'rejected' so search filtering works even if DELETE fails
      await supabase.from('connections').update({ status: 'rejected' }).eq('id', connectionId);
      // Then try to fully delete the row
      const { error } = await supabase.from('connections').delete().eq('id', connectionId);
      if (error) {
        console.error('Connection delete failed (RLS?), but status was set to rejected:', error.message);
        // Don't throw - the status update already ensures the connection won't block search
      }
    } else {
      // Only receiver can accept
      await supabase.from('connections').update({ status }).eq('id', connectionId);
    }
  },

  async updateConnectionPermissions(connectionId: string, permissions: any): Promise<void> {
    const userId = await getUserId();
    if (!userId) throw new Error('Not authenticated');

    // Only the receiver (who accepted the request) can modify permissions
    const { data: updatedRows, error } = await supabase
      .from('connections')
      .update({ permissions })
      .eq('id', connectionId)
      .eq('receiver_id', userId)
      .select('id');

    if (error) {
      console.error('[Permissions] Update failed:', error.message);
    }
    if (!updatedRows || updatedRows.length === 0) {
      console.warn('[Permissions] No rows updated - you may not be the receiver of this connection');
    }
  },

  async updateNetworkNotifications(networkNotifications: Record<string, { newTrade: boolean; newPrep: boolean; newReview: boolean }>): Promise<void> {
    const userId = await getUserId();
    if (!userId) return;
    const { data: profile } = await supabase.from('profiles').select('preferences').eq('id', userId).single();
    const prefs = profile?.preferences || {};
    prefs.networkNotifications = networkNotifications;
    await supabase.from('profiles').update({ preferences: prefs }).eq('id', userId);
  },

  async getNetworkActivity(followingIds: string[]): Promise<any[]> {
    if (followingIds.length === 0) return [];

    const currentUserId = await getUserId();

    // Fetch connections where WE are the sender (follower) to check what permissions we have
    const { data: connections, error: connErr } = await supabase
      .from('connections')
      .select('sender_id, receiver_id, permissions')
      .eq('sender_id', currentUserId)
      .eq('status', 'accepted');

    if (connErr) {
      console.error('[Feed] Connection query failed:', connErr.message);
    }

    // Build permission map: permissions set by the receiver (data owner) control what we see
    const permissionMap: Record<string, any> = {};
    (connections || []).forEach(c => {
      permissionMap[c.receiver_id] = c.permissions || { canSeePnl: false, canSeeNotes: false, canSeeScreenshots: false };
    });

    // Fetch profile names for all followed users
    const { data: profilesData } = await supabase
      .from('profiles')
      .select('id, full_name, avatar_url, preferences')
      .in('id', followingIds);
    const profileMap: Record<string, { full_name: string; avatar_url: string | null; ironRules?: any[] }> = {};
    (profilesData || []).forEach(p => { profileMap[p.id] = { full_name: p.full_name || 'Neznámý', avatar_url: p.avatar_url, ironRules: (p.preferences as any)?.ironRules }; });

    // Fetch recent trades
    const { data: trades } = await supabase
      .from('trades')
      .select('*')
      .in('user_id', followingIds)
      .order('date', { ascending: false })
      .limit(20);

    // Fetch recent reviews
    const { data: reviews } = await supabase
      .from('daily_reviews')
      .select('*')
      .in('user_id', followingIds)
      .order('date', { ascending: false })
      .limit(10);

    // Fetch recent preps
    const { data: preps } = await supabase
      .from('daily_preps')
      .select('*')
      .in('user_id', followingIds)
      .order('date', { ascending: false })
      .limit(10);

    const activity = [
      ...(trades || []).filter(t => {
        // Filter by allowed accounts
        const rawPerms = String(t.user_id) === String(currentUserId) ? null : (permissionMap[t.user_id] as any);
        const allowed = rawPerms?.allowedAccountIds;
        if (allowed && allowed.length > 0 && t.accountId) {
          return allowed.includes(t.accountId);
        }
        return true;
      }).map(t => {
        const isSelf = String(t.user_id) === String(currentUserId);
        const rawPerms = isSelf ? null : (permissionMap[t.user_id] as any);
        const perms = isSelf ? {
          pnlFormat: (rawPerms?.pnlFormat as any) || 'usd',
          canSeeReviewNotes: true,
          canSeeScreenshots: true
        } : {
          pnlFormat: rawPerms?.pnlFormat || (rawPerms?.canSeePnl ? 'usd' : 'hidden'),
          canSeeReviewNotes: rawPerms?.canSeeReviewNotes ?? rawPerms?.canSeeNotes ?? false,
          canSeeScreenshots: rawPerms?.canSeeScreenshots ?? false
        };

        const jsonb = (typeof t.data === 'object' && t.data !== null) ? t.data : {};
        const rawPnl = t.pnl ?? jsonb.pnl ?? 0;
        const rawRisk = jsonb.riskAmount ?? t.riskAmount ?? 0;

        let displayPnl = 0;
        if (perms.pnlFormat === 'usd') {
          displayPnl = rawPnl;
        } else if (perms.pnlFormat === 'rr') {
          const rr = rawRisk > 0 ? rawPnl / rawRisk : 0;
          displayPnl = parseFloat(rr.toFixed(2));
        }

        return {
          type: 'trade',
          id: t.id,
          date: t.date,
          user: { name: profileMap[t.user_id]?.full_name || 'Neznámý', avatar: profileMap[t.user_id]?.avatar_url },
          data: {
            ...jsonb,
            ...t,
            pnl: perms.pnlFormat !== 'hidden' ? displayPnl : 0,
            riskAmount: perms.pnlFormat === 'rr' ? 1 : rawRisk,
            entryPrice: jsonb.entryPrice ?? t.entryPrice,
            exitPrice: jsonb.exitPrice ?? t.exitPrice,
            notes: perms.canSeeReviewNotes ? (jsonb.notes ?? t.notes) : null,
            screenshot: perms.canSeeScreenshots ? (jsonb.screenshot ?? t.screenshot) : null,
            screenshots: perms.canSeeScreenshots ? (jsonb.screenshots ?? t.screenshots) : []
          },
          meta: {
            pnlFormat: perms.pnlFormat
          }
        };
      }),
      ...(reviews || []).filter(r => r.data?.completed).map(r => {
        const isSelf = String(r.user_id) === String(currentUserId);
        const rawPerms = isSelf ? null : (permissionMap[r.user_id] as any);
        const perms = isSelf ? {
          canSeeReviewStats: true,
          canSeeReviewNotes: true,
        } : {
          canSeeReviewStats: rawPerms?.canSeeReviewStats ?? rawPerms?.canSeeNotes ?? false,
          canSeeReviewNotes: rawPerms?.canSeeReviewNotes ?? rawPerms?.canSeeNotes ?? false,
        };

        return {
          type: 'review',
          id: r.id,
          date: r.date + 'T20:00:00',
          user: { name: profileMap[r.user_id]?.full_name || 'Neznámý', avatar: profileMap[r.user_id]?.avatar_url, ironRules: profileMap[r.user_id]?.ironRules },
          data: {
            ...r.data,
            // Stats
            rating: perms.canSeeReviewStats ? r.data.rating : 0,
            ruleAdherence: perms.canSeeReviewStats ? r.data.ruleAdherence : [],
            mistakes: perms.canSeeReviewStats ? r.data.mistakes : [],

            // Notes
            mainTakeaway: perms.canSeeReviewNotes ? r.data.mainTakeaway : null,
            lessons: perms.canSeeReviewNotes ? r.data.lessons : null,
            notes: perms.canSeeReviewNotes ? r.data.notes : null,
            psycho: r.data.psycho ? {
              ...r.data.psycho,
              notes: perms.canSeeReviewNotes ? (r.data.psycho as any).notes : ''
            } : undefined
          },
          meta: {
            statsHidden: !perms.canSeeReviewStats,
            notesHidden: !perms.canSeeReviewNotes
          }
        };
      }),
      ...(preps || []).filter(p => p.data?.completed).map(p => {
        const isSelf = String(p.user_id) === String(currentUserId);
        const rawPerms = isSelf ? null : (permissionMap[p.user_id] as any);
        const canSeePrep = isSelf || (rawPerms?.canSeePrep ?? false);
        const canSeePrepRituals = isSelf || (rawPerms?.canSeePrepRituals ?? false);

        if (!canSeePrep) {
          // Return locked shell
          return {
            type: 'prep',
            id: p.id,
            date: p.date + 'T08:00:00',
            user: { name: profileMap[p.user_id]?.full_name || 'Neznámý', avatar: profileMap[p.user_id]?.avatar_url },
            data: { ...p.data, mindsetState: null, notes: null, scenarios: {} },
            meta: { locked: true }
          };
        }

        const prepData = { ...p.data };
        if (!canSeePrepRituals) {
          prepData.ritualCompletions = undefined;
          prepData.ruleAdherence = undefined;
        }

        return {
          type: 'prep',
          id: p.id,
          date: p.date + 'T08:00:00',
          user: { name: profileMap[p.user_id]?.full_name || 'Neznámý', avatar: profileMap[p.user_id]?.avatar_url, ironRules: canSeePrepRituals ? profileMap[p.user_id]?.ironRules : undefined },
          data: prepData,
          meta: { ritualsHidden: !canSeePrepRituals }
        };
      })
    ];

    // Deduplicate copy trades (same user, instrument, direction, date = likely copy across accounts)
    const dedupMap = new Map<string, any>();
    const nonTrades: any[] = [];
    for (const item of activity) {
      if (item.type !== 'trade') {
        nonTrades.push(item);
        continue;
      }
      const key = `${item.data.user_id}_${item.data.instrument}_${item.data.direction}_${item.date}`;
      if (dedupMap.has(key)) {
        const existing = dedupMap.get(key);
        (existing.meta as any).accountCount = ((existing.meta as any).accountCount || 1) + 1;
      } else {
        (item.meta as any).accountCount = 1;
        dedupMap.set(key, item);
      }
    }
    const deduped = [...dedupMap.values(), ...nonTrades];

    return deduped.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  },

  async getLeaderboardStats(userIds: string[]): Promise<any[]> {
    if (userIds.length === 0) return [];

    // Fetch last 50 trades per user for Win Rate
    // Note: In a real app with generic supabase, we might need a stored procedure for efficiency.
    // For now, we fetch recent trades and aggregate client-side to avoid complex SQL via JS.
    const { data: trades } = await supabase
      .from('trades')
      .select('user_id, pnl')
      .in('user_id', userIds)
      .order('date', { ascending: false })
      .limit(500); // Global limit, might need adjustment

    // Fetch last 20 reviews for Discipline
    const { data: reviews } = await supabase
      .from('daily_reviews')
      .select('user_id, data')
      .in('user_id', userIds)
      .order('date', { ascending: false })
      .limit(200);

    const statsMap: Record<string, { wins: number, totalTrades: number, totalRating: number, reviewCount: number }> = {};

    userIds.forEach(id => { statsMap[id] = { wins: 0, totalTrades: 0, totalRating: 0, reviewCount: 0 }; });

    trades?.forEach(t => {
      if (statsMap[t.user_id]) {
        statsMap[t.user_id].totalTrades++;
        if (t.pnl > 0) statsMap[t.user_id].wins++;
      }
    });

    reviews?.forEach(r => {
      if (statsMap[r.user_id]) {
        const rating = (r.data as any).rating || 0;
        if (rating > 0) {
          statsMap[r.user_id].totalRating += rating;
          statsMap[r.user_id].reviewCount++;
        }
      }
    });

    // Get profiles to return enriched data
    const { data: profiles } = await supabase.from('profiles').select('id, full_name, avatar_url').in('id', userIds);

    return profiles?.map(p => {
      const s = statsMap[p.id];
      return {
        id: p.id,
        name: p.full_name,
        avatar: p.avatar_url,
        winRate: s.totalTrades > 0 ? (s.wins / s.totalTrades) * 100 : 0,
        discipline: s.reviewCount > 0 ? (s.totalRating / s.reviewCount) : 0,
        tradeCount: s.totalTrades
      };
    }) || [];
  },

  async getSpectatorData(targetUserId: string): Promise<{
    trades: Trade[];
    accounts: Account[];
    preps: DailyPrep[];
    reviews: DailyReview[];
    preferences: UserPreferences | null;
    meta?: {
      pnlFormat: 'usd' | 'rr' | 'hidden';
    };
  } | null> {
    const currentUserId = await getUserId();
    if (!currentUserId || !targetUserId) return null;

    const isSelf = currentUserId === targetUserId;

    // 1. Check permissions FIRST - before fetching any data
    let rawPerms: any = null;
    if (!isSelf) {
      // Find connection where current user is the SENDER (follower) and target is RECEIVER (owner)
      // Permissions on this connection are set by the receiver (target) and control what we can see
      const { data: connection, error: connErr } = await supabase
        .from('connections')
        .select('permissions')
        .eq('sender_id', currentUserId)
        .eq('receiver_id', targetUserId)
        .eq('status', 'accepted')
        .maybeSingle();

      if (connErr) {
        console.error("[Spectator] Connection query failed:", connErr);
        return null;
      }

      if (!connection) {
        console.warn("[Spectator] No accepted connection found (you → target)");
        return null;
      }

      rawPerms = connection.permissions as any;
    }

    // 2. Resolve permissions
    const perms = {
      pnlFormat: isSelf ? 'usd' : (rawPerms?.pnlFormat || (rawPerms?.canSeePnl ? 'usd' : 'hidden')),
      canSeePrep: isSelf || (rawPerms?.canSeePrep ?? false),
      canSeePrepRituals: isSelf || (rawPerms?.canSeePrepRituals ?? false),
      canSeeReviewStats: isSelf || (rawPerms?.canSeeReviewStats ?? false),
      canSeeReviewNotes: isSelf || (rawPerms?.canSeeReviewNotes ?? false),
      canSeeScreenshots: isSelf || (rawPerms?.canSeeScreenshots ?? false),
      allowedAccountIds: isSelf ? [] : (rawPerms?.allowedAccountIds || []) as string[]
    };

    // 3. Fetch only data that permissions allow (minimize network transfer)
    const fetchPromises: [Promise<Trade[]>, Promise<Account[]>, Promise<DailyPrep[]>, Promise<DailyReview[]>, Promise<UserPreferences | null>] = [
      this.getTrades(targetUserId),
      this.getAccounts(targetUserId),
      perms.canSeePrep ? this.getDailyPreps(targetUserId) : Promise.resolve([]),
      (perms.canSeeReviewStats || perms.canSeeReviewNotes) ? this.getDailyReviews(targetUserId) : Promise.resolve([]),
      this.getPreferences(targetUserId)
    ];

    const [trades, accounts, preps, reviews, prefs] = await Promise.all(fetchPromises);

    // 3b. Fetch screenshots separately if permitted (getTrades() omits them for performance)
    if (perms.canSeeScreenshots && trades.length > 0) {
      const tradeIds = trades.map((t: Trade) => t.id);
      const { data: screenshotData } = await supabase
        .from('trades')
        .select('id, screenshot:data->>screenshot, screenshots:data->screenshots')
        .in('id', tradeIds);

      if (screenshotData) {
        const ssMap = new Map(screenshotData.map((s: any) => [s.id, s]));
        trades.forEach((t: any) => {
          const ss = ssMap.get(t.id);
          if (ss) {
            t.screenshot = ss.screenshot || undefined;
            t.screenshots = ss.screenshots || [];
          }
        });
      }
    }

    // 4. Filter by allowed accounts, then sanitize TRADES
    const filteredTrades = perms.allowedAccountIds.length > 0
      ? trades.filter((t: Trade) => perms.allowedAccountIds.includes(t.accountId))
      : trades;
    const sanitizedTrades = filteredTrades.map((t: Trade) => {
      let displayPnl = 0;

      if (perms.pnlFormat === 'usd') {
        displayPnl = t.pnl;
      } else if (perms.pnlFormat === 'rr') {
        const risk = t.riskAmount || 0;
        const rr = risk > 0 ? t.pnl / risk : 0;
        displayPnl = parseFloat(rr.toFixed(2));
      }

      return {
        ...t,
        pnl: displayPnl,
        riskAmount: perms.pnlFormat === 'rr' ? 1 : t.riskAmount,
        notes: perms.canSeeReviewNotes ? t.notes : null,
        screenshot: perms.canSeeScreenshots ? t.screenshot : null,
        screenshots: perms.canSeeScreenshots ? t.screenshots : [],
        entryPrice: perms.pnlFormat !== 'hidden' ? t.entryPrice : null,
        exitPrice: perms.pnlFormat !== 'hidden' ? t.exitPrice : null,
      };
    });

    // 5. Sanitize REVIEWS
    const sanitizedReviews = reviews.map((r: DailyReview) => ({
      ...r,
      rating: perms.canSeeReviewStats ? r.rating : 0,
      ruleAdherence: perms.canSeeReviewStats ? r.ruleAdherence : [],
      mistakes: perms.canSeeReviewStats ? r.mistakes : [],
      mainTakeaway: perms.canSeeReviewNotes ? r.mainTakeaway : null,
      lessons: perms.canSeeReviewNotes ? r.lessons : null,
      psycho: r.psycho ? {
        ...r.psycho,
        notes: perms.canSeeReviewNotes ? r.psycho.notes : ''
      } : undefined
    }));

    // 6. Sanitize PREPS (already empty array if not permitted)
    const sanitizedPreps = preps.map((p: DailyPrep) => ({
      ...p,
      ritualCompletions: perms.canSeePrepRituals ? p.ritualCompletions : undefined,
      scenarios: {
        ...p.scenarios,
        bullishImage: perms.canSeeScreenshots ? p.scenarios.bullishImage : null,
        bearishImage: perms.canSeeScreenshots ? p.scenarios.bearishImage : null,
      }
    }));

    // 7. Filter Accounts (by allowed + sanitize balances)
    const filteredAccounts = perms.allowedAccountIds.length > 0
      ? accounts.filter((a: Account) => perms.allowedAccountIds.includes(a.id))
      : accounts;
    const sanitizedAccounts = filteredAccounts.map((a: Account) => ({
      ...a,
      initialBalance: perms.pnlFormat === 'usd' ? a.initialBalance : 0,
      totalWithdrawals: perms.pnlFormat === 'usd' ? a.totalWithdrawals : 0
    }));

    return {
      trades: sanitizedTrades,
      accounts: sanitizedAccounts,
      preps: sanitizedPreps,
      reviews: sanitizedReviews,
      preferences: prefs,
      meta: {
        pnlFormat: perms.pnlFormat as 'usd' | 'rr' | 'hidden'
      }
    };
  },

  // Drawing Templates
  async getDrawingTemplates(): Promise<DrawingTemplate[]> {
    const prefs = await this.getPreferences();
    return (prefs as any)?.drawingTemplates || [];
  },

  async saveDrawingTemplate(template: DrawingTemplate): Promise<void> {
    const prefs = await this.getPreferences() || {} as UserPreferences;
    const templates: DrawingTemplate[] = (prefs as any).drawingTemplates || [];

    // Check if template with same ID exists (update) or add new
    const existingIndex = templates.findIndex(t => t.id === template.id);
    if (existingIndex >= 0) {
      templates[existingIndex] = template;
    } else {
      templates.push(template);
    }

    await this.savePreferences({ ...prefs, drawingTemplates: templates } as any);
  },

  async deleteDrawingTemplate(templateId: string): Promise<void> {
    const prefs = await this.getPreferences() || {} as UserPreferences;
    const templates: DrawingTemplate[] = (prefs as any).drawingTemplates || [];
    const filtered = templates.filter(t => t.id !== templateId);
    await this.savePreferences({ ...prefs, drawingTemplates: filtered } as any);
  },

  // Globální cache AI conversations — persisted v localStorage, sdílený mezi
  // AICoachPage mount/unmount cykly. Eliminuje flash prázdného seznamu po reloadu.
  _conversationsCache: (() => {
    try {
      const raw = localStorage.getItem('alphatrade_conversations_cache');
      return raw ? JSON.parse(raw) as AIConversation[] : [];
    } catch { return [] as AIConversation[]; }
  })(),

  getCachedConversations(): AIConversation[] {
    return this._conversationsCache;
  },

  async getConversations(): Promise<AIConversation[]> {
    const userId = await getUserId();
    if (!userId) return this._conversationsCache;
    const { data, error } = await supabase
      .from('ai_conversations')
      .select('*')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false });
    if (error) { console.error('[AI] getConversations:', error); return this._conversationsCache; }
    const list = data ?? [];
    // Update cache + persist
    this._conversationsCache = list;
    try {
      localStorage.setItem('alphatrade_conversations_cache', JSON.stringify(list));
    } catch { /* localStorage full */ }
    return list;
  },

  async createConversation(title = 'Nová konverzace', scope: 'live' | 'backtest' = 'live'): Promise<AIConversation | null> {
    const userId = await getUserId();
    if (!userId) {
      console.error('[AI] createConversation: no userId');
      return null;
    }

    let { data, error } = await supabase
      .from('ai_conversations')
      .insert({ user_id: userId, title, category: 'general', scope })
      .select()
      .single();

    // Fallback pro starší schéma bez sloupce `category` NEBO `scope` — vlož jen
    // minimální sadu, ať vytvoření konverzace degraduje místo throwu (42703 = undefined_column).
    if (error && (error.message.includes('category') || error.message.includes('scope') || error.code === '42703')) {
      console.warn('[AI] category/scope column missing, retrying with minimal columns');
      ({ data, error } = await supabase
        .from('ai_conversations')
        .insert({ user_id: userId, title })
        .select()
        .single());
    }

    if (error) {
      console.error('[AI] createConversation error:', error.message, error.code);
      throw new Error(error.message);
    }

    return { ...data, category: (data.category ?? 'general') as AIConversation['category'], scope: (data.scope ?? 'live') as 'live' | 'backtest' };
  },

  async updateConversation(id: string, updates: { title?: string; category?: AIConversation['category'] }): Promise<void> {
    await supabase.from('ai_conversations').update({ ...updates, updated_at: new Date().toISOString() }).eq('id', id);
  },

  async deleteConversation(id: string): Promise<void> {
    await supabase.from('ai_conversations').delete().eq('id', id);
  },

  async getMessages(conversationId: string): Promise<{ id: string; role: string; content: string; created_at: string }[]> {
    const { data, error } = await supabase
      .from('ai_messages')
      .select('id, role, content, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true });
    if (error) { console.error('[AI] getMessages:', error); return []; }
    return data ?? [];
  },

  async appendMessage(conversationId: string, role: 'user' | 'assistant', content: string): Promise<void> {
    await supabase.from('ai_messages').insert({ conversation_id: conversationId, role, content });
    await supabase.from('ai_conversations').update({ updated_at: new Date().toISOString() }).eq('id', conversationId);
  },

  /**
   * Vloží novou zprávu a vrátí její ID — používá se pro streamování,
   * kdy chceme držet pahýl v DB a postupně ho updatovat (přežije F5/odchod).
   */
  async appendMessageReturning(conversationId: string, role: 'user' | 'assistant', content: string): Promise<string | null> {
    const { data, error } = await supabase
      .from('ai_messages')
      .insert({ conversation_id: conversationId, role, content })
      .select('id')
      .single();
    if (error) {
      console.warn('[storage] appendMessageReturning error:', error);
      return null;
    }
    await supabase.from('ai_conversations').update({ updated_at: new Date().toISOString() }).eq('id', conversationId);
    return data?.id ? String(data.id) : null;
  },

  /**
   * Update obsahu existující zprávy. Používá se během streamu pro průběžné
   * ukládání rozpracované odpovědi (každé ~3s + finální flush).
   */
  async updateMessage(messageId: string, content: string): Promise<void> {
    const { error } = await supabase.from('ai_messages').update({ content }).eq('id', messageId);
    if (error) console.warn('[storage] updateMessage error:', error);
  },

  /** Smaže zprávu (např. prázdný pahýl při onError před prvním chunkem). */
  async deleteMessage(messageId: string): Promise<void> {
    const { error } = await supabase.from('ai_messages').delete().eq('id', messageId);
    if (error) console.warn('[storage] deleteMessage error:', error);
  },

  // ─── SCREENSHOT STORAGE MIGRATION ────────────────────────────────────────

  /** Upload a base64 data URL to Supabase Storage and return the public URL.
   *  Client-side resize na max 1600px wide JPEG q85 PŘED uploadem — šetří
   *  Image Transformations quotu, bandwidth a storage. Vizuálně neznatelný rozdíl. */
  async uploadScreenshot(base64DataUrl: string, tradeId: string | number): Promise<string> {
    const userId = await getUserId();
    if (!userId) throw new Error('Not authenticated');
    const isBase64 = base64DataUrl.startsWith('data:');
    if (!isBase64) return base64DataUrl; // Already a URL — return as-is

    // Resize na max 1600×1600 JPEG q92 (skip pokud origin <250 KB).
    // 1600px wide + q92 = ostré screenshoty pro 4K zoom, žádné viditelné ztráty
    // detailu pro candle bars / M1 timeframe / wicky. Origin ~300-500 KB.
    // Pro plán má 100 origin transformations zdarma + $5/100 overage — drobný náklad
    // za výrazně lepší kvalitu.
    const sizeBefore = dataUrlSizeKB(base64DataUrl);
    const resized = await resizeImageDataUrl(base64DataUrl, {
      maxWidth: 1600,
      maxHeight: 1600,
      quality: 0.92,
      outputType: 'image/jpeg',
      skipIfSmallerThanKB: 250,
    });
    const sizeAfter = dataUrlSizeKB(resized);
    if (sizeBefore !== sizeAfter) {
      console.info(`[uploadScreenshot] resize ${sizeBefore} KB → ${sizeAfter} KB (${Math.round((1 - sizeAfter / sizeBefore) * 100)}% úspora)`);
    }

    const base64 = resized.replace(/^data:image\/\w+;base64,/, '');
    const byteChars = atob(base64);
    const buffer = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) buffer[i] = byteChars.charCodeAt(i);
    // Po resize je výstup vždy JPEG (kromě skip-malé který může být PNG)
    const ext = resized.includes('image/png') ? 'png' : 'jpg';
    const fileName = `${userId}/${tradeId}_${Date.now()}.${ext}`;
    const { error } = await supabase.storage.from('trade-images').upload(fileName, buffer, {
      contentType: `image/${ext}`, upsert: true
    });
    if (error) throw error;
    return supabase.storage.from('trade-images').getPublicUrl(fileName).data.publicUrl;
  },

  /** One-time migration: upload all base64 screenshots to Storage, replace with URLs in DB */
  async migrateScreenshotsToStorage(
    onProgress?: (done: number, total: number, current: string) => void
  ): Promise<{ migrated: number; skipped: number; failed: number }> {
    const userId = await getUserId();
    if (!userId) throw new Error('Not authenticated');

    // Fetch ALL trades with full data (including screenshots)
    const { data, error } = await supabase
      .from('trades')
      .select('id, data')
      .eq('user_id', userId);
    if (error) throw error;

    const toMigrate = (data || []).filter((t: any) =>
      (t.data?.screenshot && String(t.data.screenshot).startsWith('data:')) ||
      (t.data?.screenshots && t.data.screenshots.some((s: string) => String(s).startsWith('data:')))
    );

    let migrated = 0, skipped = 0, failed = 0;

    for (let i = 0; i < toMigrate.length; i++) {
      const row = toMigrate[i];
      const tradeData = { ...row.data };
      onProgress?.(i, toMigrate.length, String(row.id));
      try {
        // Migrate primary screenshot
        if (tradeData.screenshot?.startsWith('data:')) {
          tradeData.screenshot = await storageService.uploadScreenshot(tradeData.screenshot, row.id);
        }
        // Migrate screenshots array
        if (tradeData.screenshots?.length) {
          tradeData.screenshots = await Promise.all(
            tradeData.screenshots.map((s: string) =>
              s.startsWith('data:') ? storageService.uploadScreenshot(s, row.id) : Promise.resolve(s)
            )
          );
        }
        // Update DB row with URLs instead of base64
        const { error: updateErr } = await supabase
          .from('trades')
          .update({ data: tradeData })
          .eq('id', row.id)
          .eq('user_id', userId);
        if (updateErr) throw updateErr;
        migrated++;
      } catch (e) {
        console.error(`[Migration] Failed for trade ${row.id}:`, e);
        failed++;
      }
    }

    skipped = (data?.length || 0) - toMigrate.length;
    onProgress?.(toMigrate.length, toMigrate.length, 'done');
    return { migrated, skipped, failed };
  },

  /**
   * Backfill RAG embeddings for all existing trades, preps, and reviews that don't
   * yet have an ai_embeddings row. Calls the `embed` Edge Function in batches of 50.
   */
  async backfillEmbeddings(
    onProgress?: (done: number, total: number, label: string) => void
  ): Promise<{ embedded: number; skipped: number; failed: number }> {
    const userId = await getUserId();
    if (!userId) throw new Error('Not authenticated');

    const { buildTradeContent, buildPrepContent, buildReviewContent } = await import('./embeddingService');

    // Find existing embedding keys to skip already-done items.
    const { data: existingEmbeds } = await supabase
      .from('ai_embeddings')
      .select('source_type, source_id')
      .eq('user_id', userId);
    const existingKeys = new Set((existingEmbeds || []).map((e: any) => `${e.source_type}:${e.source_id}`));

    // Fetch full content for all three sources.
    const [tradesRes, prepsRes, reviewsRes] = await Promise.all([
      supabase.from('trades').select('id, date, data, account_id, instrument, signal, pnl, direction, timestamp').eq('user_id', userId),
      supabase.from('daily_preps').select('id, date, data').eq('user_id', userId),
      supabase.from('daily_reviews').select('id, date, data').eq('user_id', userId),
    ]);

    type Item = { source_type: 'trade' | 'prep' | 'review'; source_id: string; source_date: string | null; content: string; metadata: Record<string, unknown> };
    const items: Item[] = [];

    for (const t of (tradesRes.data || []) as any[]) {
      const key = `trade:${t.id}`;
      if (existingKeys.has(key)) continue;
      const trade: Trade = { ...(t.data || {}), id: t.id, accountId: t.account_id, instrument: t.instrument, signal: t.signal, pnl: t.pnl, direction: t.direction, date: t.date, timestamp: t.timestamp };
      const { content, metadata } = buildTradeContent(trade);
      if (!content || content.length < 20) continue;
      items.push({ source_type: 'trade', source_id: String(t.id), source_date: t.date ? String(t.date).slice(0, 10) : null, content, metadata });
    }
    for (const p of (prepsRes.data || []) as any[]) {
      const prep: DailyPrep = { ...(p.data || {}), id: p.id, date: p.date };
      const key = `prep:${prep.id}`;
      if (existingKeys.has(key)) continue;
      const { content, metadata } = buildPrepContent(prep);
      if (!content || content.length < 30) continue;
      items.push({ source_type: 'prep', source_id: prep.id, source_date: prep.date, content, metadata });
    }
    for (const r of (reviewsRes.data || []) as any[]) {
      const review: DailyReview = { ...(r.data || {}), id: r.id, date: r.date };
      const key = `review:${review.id}`;
      if (existingKeys.has(key)) continue;
      const { content, metadata } = buildReviewContent(review);
      if (!content || content.length < 30) continue;
      items.push({ source_type: 'review', source_id: review.id, source_date: review.date, content, metadata });
    }

    const total = items.length;
    if (total === 0) {
      onProgress?.(0, 0, 'Nic k zaindexování');
      return { embedded: 0, skipped: existingKeys.size, failed: 0 };
    }

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error('No active session');

    const BASE = (supabase as any).supabaseUrl || (import.meta as any).env?.VITE_SUPABASE_URL;
    const url = `${BASE}/functions/v1/embed`;

    let embedded = 0;
    let failed = 0;
    const BATCH = 50;

    for (let i = 0; i < items.length; i += BATCH) {
      const slice = items.slice(i, i + BATCH);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: slice }),
        });
        const data = await res.json();
        if (res.ok) {
          embedded += data.embedded || 0;
        } else {
          failed += slice.length;
          console.warn('[backfillEmbeddings] batch failed:', data);
        }
      } catch (e) {
        failed += slice.length;
        console.warn('[backfillEmbeddings] network error:', e);
      }
      onProgress?.(Math.min(i + BATCH, total), total, `${Math.min(i + BATCH, total)} / ${total}`);
    }

    return { embedded, skipped: existingKeys.size, failed };
  },
};
