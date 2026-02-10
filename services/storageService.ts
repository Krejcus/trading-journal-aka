
import { Trade, Account, UserPreferences, DailyPrep, DailyReview, WeeklyReview, MonthlyReview, User, SocialConnection, UserSearch, BusinessExpense, BusinessPayout, PlaybookItem, BusinessGoal, BusinessResource, BusinessSettings, WeeklyFocus, DrawingTemplate } from '../types';
import { supabase } from './supabase';
import { get, set } from 'idb-keyval';

// Helper to validate UUID
const isUUID = (id: any) => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

// Helper to get current user ID with caching
let cachedUserId: string | null = null;
let lastSessionCheck = 0;

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
const safeSetItem = (key: string, value: any) => {
  try {
    const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
    localStorage.setItem(key, stringValue);
  } catch (e: any) {
    if (e.name === 'QuotaExceededError' || e.code === 22) {
      console.warn(`[Storage] LocalStorage quota exceeded for key: ${key}. Background data will still load from server.`);
      // Optional: Clear some specific large keys to make room for critical data
      if (key.includes('trades')) {
        // If we can't even save limited trades, maybe clear all trades cache to be safe
        // but only if it's not the current key we are trying to save
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

    const user = {
      id: data.id,
      email: data.email || '',
      name: data.full_name || '',
      avatar: data.avatar_url
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
      avatar: data.avatar_url
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
        durationMinutes:data->>durationMinutes
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
      htfConfluence: t.htfConfluence,
      ltfConfluence: t.ltfConfluence,
      mistakes: t.mistakes,
      emotions: t.emotions,
      planAdherence: t.planAdherence,
      executionStatus: t.executionStatus,
      screenshot: undefined,
      screenshots: undefined,
      miniViewRange: t.miniViewRange,
      miniViewLayout: t.miniViewLayout,
      miniViewSecondaryRange: t.miniViewSecondaryRange,
      miniViewSecondaryTimeframe: t.miniViewSecondaryTimeframe,

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

    // We update both the JSONB column AND the data jsonb column to allow migration/fallback
    // Ideally we just update the root column `drawings`

    const { error } = await supabase
      .from('trades')
      .update({
        drawings: drawings,
        // We also update the 'data' blob to keep it in sync if architecture relies on it
        // detailed update might be complex without fetching first. 
        // For now, let's just update the root column which is the source of truth for drawings.
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
    console.log(`[UpdateDrawings] Updated drawings for trade ${tradeId} in cache`);
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
      console.error("Failed to fetch trade for update:", getErr);
      return;
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
    console.log(`[UpdateTrade] Updated trade ${tradeId} in cache`);
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

    if (existingIdsWithoutScreenshots.length > 0) {
      try {
        const { data: screenshotRows } = await supabase
          .from('trades')
          .select('id, screenshot:data->>screenshot, screenshots:data->screenshots')
          .in('id', existingIdsWithoutScreenshots)
          .eq('user_id', userId);

        screenshotRows?.forEach((row: any) => {
          if (row.screenshot || (row.screenshots && row.screenshots.length > 0)) {
            screenshotMap.set(row.id, {
              screenshot: row.screenshot || undefined,
              screenshots: row.screenshots || undefined
            });
          }
        });
      } catch (err) {
        console.error('[saveTrades] Failed to fetch existing screenshots:', err);
      }
    }

    const tradesToUpsert = trades.map(t => {
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
    console.log(`[DeleteTrade] Removed trade ${id} from cache`);
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
      console.log(`[ClearTrades] Removed trades for account ${accountId} from cache`);
    } else {
      // Full clear - remove all trades
      await set(localKey, []);
      console.log(`[ClearTrades] Cleared all trades from cache`);
    }
  },

  async markTradeAsPublic(id: string): Promise<void> {
    const userId = await getUserId();
    if (!userId) return;
    await supabase.from('trades').update({ is_public: true }).eq('id', id).eq('user_id', userId);
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

  // Batch fetch screenshots for multiple trades (used by TradeHistory infinite scroll)
  async getTradeScreenshots(tradeIds: string[]): Promise<Map<string, { screenshot?: string; screenshots?: string[] }>> {
    const result = new Map<string, { screenshot?: string; screenshots?: string[] }>();
    if (tradeIds.length === 0) return result;

    const userId = await getUserId();
    if (!userId) return result;

    const { data, error } = await supabase
      .from('trades')
      .select('id, screenshot:data->>screenshot, screenshots:data->screenshots')
      .in('id', tradeIds)
      .eq('user_id', userId);

    if (error || !data) return result;

    data.forEach((row: any) => {
      result.set(row.id, {
        screenshot: row.screenshot || undefined,
        screenshots: row.screenshots || undefined
      });
    });

    return result;
  },

  // Prefetch all trade screenshots in background (returns map of id -> screenshot)
  async prefetchAllScreenshots(): Promise<Map<string, { screenshot?: string; screenshots?: string[] }>> {
    const result = new Map<string, { screenshot?: string; screenshots?: string[] }>();
    const userId = await getUserId();
    if (!userId) return result;

    const { data, error } = await supabase
      .from('trades')
      .select('id, screenshot:data->>screenshot')
      .eq('user_id', userId)
      .not('data->>screenshot', 'is', null);

    if (error || !data) return result;

    data.forEach((row: any) => {
      if (row.screenshot) {
        result.set(row.id, { screenshot: row.screenshot });
      }
    });

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

    const accounts = data.map(a => ({
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

    // Cache result
    safeSetItem(localKey, accounts);
    return accounts;
  },

  async saveAccounts(accounts: Account[]): Promise<Account[]> {
    const userId = await getUserId();

    // Save to local storage immediately with userId-scoped key
    const localKey = userId ? `alphatrade_accounts_${userId}` : 'alphatrade_accounts';
    safeSetItem(localKey, accounts);

    if (!userId || accounts.length === 0) return accounts;

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
    safeSetItem(localKey, prefs);
    const { error } = await supabase.from('profiles').update({ preferences: prefs }).eq('id', userId);
    if (error) {
      console.error("[savePreferences] DB error:", error);
      throw error;
    }
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

  async saveDailyPreps(preps: DailyPrep[]): Promise<void> {
    const userId = await getUserId();
    if (!userId) return;

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
      // Extra fields stored as JSON in description
      let extra: any = {};
      try { if (d.description?.startsWith('{')) extra = JSON.parse(d.description); } catch {}
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

    const { data, error } = await supabase
      .from('business_payouts')
      .select('*')
      .eq('user_id', userId)
      .order('date', { ascending: false });

    if (error) {
      console.error('[Storage] Error fetching payouts:', error);
      return [];
    }

    return (data || []).map((d: any) => {
      let extra: any = {};
      try { if (d.description?.startsWith('{')) extra = JSON.parse(d.description); } catch {}
      return {
        id: d.id,
        user_id: d.user_id,
        date: d.date,
        amount: d.amount,
        description: d.description,
        payout_method: d.payout_method,
        grossAmount: extra.grossAmount,
        profitSplitUsed: extra.profitSplitUsed,
        accountId: extra.accountId,
        image: extra.image,
        notes: extra.notes,
        status: extra.status || 'Received',
        created_at: d.created_at,
        updated_at: d.updated_at
      };
    });
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

    // Sanitize query: remove PostgREST filter special characters to prevent filter injection
    const sanitized = query.replace(/[%_().,\\]/g, '').trim();
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
      .or(`sender_id.eq.${userId},receiver_id.eq.${userId}`);

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
      // Both sender and receiver can delete (RLS allows both)
      await supabase.from('connections').delete().eq('id', connectionId);
    } else {
      // Only receiver can accept (RLS: auth.uid() = receiver_id for UPDATE)
      await supabase.from('connections').update({ status }).eq('id', connectionId).eq('receiver_id', userId);
    }
  },

  async updateConnectionPermissions(connectionId: string, permissions: any): Promise<void> {
    const userId = await getUserId();
    if (!userId) throw new Error('Not authenticated');

    // Only the receiver (who accepted the request) can modify permissions
    // RLS also enforces this, but defense-in-depth
    await supabase.from('connections').update({ permissions }).eq('id', connectionId).eq('receiver_id', userId);
  },

  async getNetworkActivity(followingIds: string[]): Promise<any[]> {
    if (followingIds.length === 0) return [];

    const currentUserId = await getUserId();

    // Fetch connections to check permissions (we need to know what WE are allowed to see from THEM)
    const { data: connections } = await supabase
      .from('connections')
      .select('sender_id, receiver_id, permissions')
      .or(`sender_id.eq.${currentUserId}, receiver_id.eq.${currentUserId} `)
      .eq('status', 'accepted');

    const permissionMap: Record<string, any> = {};
    connections?.forEach(c => {
      const targetId = c.sender_id === currentUserId ? c.receiver_id : c.sender_id;
      permissionMap[targetId] = c.permissions || { canSeePnl: false, canSeeNotes: false, canSeeScreenshots: false };
    });

    // Fetch recent trades
    const { data: trades } = await supabase
      .from('trades')
      .select('*, profiles!user_id(full_name, avatar_url)')
      .in('user_id', followingIds)
      .order('date', { ascending: false })
      .limit(20);

    // Fetch recent reviews
    const { data: reviews } = await supabase
      .from('daily_reviews')
      .select('*, profiles!user_id(full_name, avatar_url)')
      .in('user_id', followingIds)
      .order('date', { ascending: false })
      .limit(10);

    // Fetch recent preps
    const { data: preps } = await supabase
      .from('daily_preps')
      .select('*, profiles!user_id(full_name, avatar_url)')
      .in('user_id', followingIds)
      .order('date', { ascending: false })
      .limit(10);

    const activity = [
      ...(trades || []).map(t => {
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

        let displayPnl = 0;
        if (perms.pnlFormat === 'usd') {
          displayPnl = t.pnl;
        } else if (perms.pnlFormat === 'rr') {
          const risk = t.riskAmount || 0;
          const rr = risk > 0 ? t.pnl / risk : 0;
          displayPnl = parseFloat(rr.toFixed(2));
        }

        return {
          type: 'trade',
          id: t.id,
          date: t.date,
          user: { name: t.profiles?.full_name || 'Neznámý', avatar: t.profiles?.avatar_url },
          data: {
            ...t,
            pnl: perms.pnlFormat !== 'hidden' ? displayPnl : 0,
            riskAmount: perms.pnlFormat === 'rr' ? 1 : t.riskAmount, // Normalize risk for RR display consistency if needed
            notes: perms.canSeeReviewNotes ? t.notes : null,
            screenshot: perms.canSeeScreenshots ? t.screenshot : null,
            screenshots: perms.canSeeScreenshots ? t.screenshots : []
          },
          meta: {
            pnlFormat: perms.pnlFormat
          }
        };
      }),
      ...(reviews || []).map(r => {
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
          user: { name: r.profiles?.full_name || 'Neznámý', avatar: r.profiles?.avatar_url },
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
      ...(preps || []).map(p => {
        const isSelf = String(p.user_id) === String(currentUserId);
        const rawPerms = isSelf ? null : (permissionMap[p.user_id] as any);
        const canSeePrep = isSelf || (rawPerms?.canSeePrep ?? false);

        if (!canSeePrep) {
          // Return locked shell
          return {
            type: 'prep',
            id: p.id,
            date: p.date + 'T08:00:00',
            user: { name: p.profiles?.full_name || 'Neznámý', avatar: p.profiles?.avatar_url },
            data: { ...p.data, mindsetState: null, notes: null, scenarios: {} },
            meta: { locked: true }
          };
        }

        return {
          type: 'prep',
          id: p.id,
          date: p.date + 'T08:00:00',
          user: { name: p.profiles?.full_name || 'Neznámý', avatar: p.profiles?.avatar_url },
          data: {
            ...p.data
            // Scenarios images might need stripping if canSeeScreenshots is false, 
            // but Preps usually don't have that toggle in UI section? 
            // Ah, Prep section has strict "Allow Analysis". If allowed, usually we show it all.
            // But if we want to be super strict, we could check screenshots too.
            // For now, simple: strict Prep toggle = All or Nothing for prep content.
          }
        };
      })
    ];

    return activity.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
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
      const { data: connection, error: connErr } = await supabase
        .from('connections')
        .select('permissions, status')
        .or(`and(sender_id.eq.${currentUserId},receiver_id.eq.${targetUserId}),and(sender_id.eq.${targetUserId},receiver_id.eq.${currentUserId})`)
        .maybeSingle();

      if (connErr) {
        console.error("[Spectator] Connection query failed:", connErr);
        return null;
      }

      if (!connection) {
        console.warn("[Spectator] No connection found between users");
        return null;
      }

      if (connection.status !== 'accepted') {
        console.warn("[Spectator] Connection exists but status is:", connection.status);
        return null;
      }
      rawPerms = connection.permissions as any;
    }

    // 2. Resolve permissions
    const perms = {
      pnlFormat: isSelf ? 'usd' : (rawPerms?.pnlFormat || (rawPerms?.canSeePnl ? 'usd' : 'hidden')),
      canSeePrep: isSelf || (rawPerms?.canSeePrep ?? false),
      canSeeReviewStats: isSelf || (rawPerms?.canSeeReviewStats ?? false),
      canSeeReviewNotes: isSelf || (rawPerms?.canSeeReviewNotes ?? false),
      canSeeScreenshots: isSelf || (rawPerms?.canSeeScreenshots ?? false)
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

    // 4. Sanitize TRADES - strip sensitive fields before returning
    const sanitizedTrades = trades.map((t: Trade) => {
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
      scenarios: {
        ...p.scenarios,
        bullishImage: perms.canSeeScreenshots ? p.scenarios.bullishImage : null,
        bearishImage: perms.canSeeScreenshots ? p.scenarios.bearishImage : null,
      }
    }));

    // 7. Filter Accounts
    const sanitizedAccounts = accounts.map((a: Account) => ({
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
  }
};
