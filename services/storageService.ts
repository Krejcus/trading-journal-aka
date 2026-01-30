
import { Trade, Account, UserPreferences, DailyPrep, DailyReview, WeeklyReview, MonthlyReview, User, SocialConnection, UserSearch, BusinessExpense, BusinessPayout, PlaybookItem, BusinessGoal, BusinessResource, BusinessSettings, WeeklyFocus, DrawingTemplate } from '../types';
import { supabase } from './supabase';
import { get, set, del } from 'idb-keyval';

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
  async getTradesCheckCacheFirst(userId?: string): Promise<Trade[]> {
    const id = userId || await getUserId();
    if (!id) return [];

    // Crucial: Use user-specific key exclusively if ID is available
    const localKey = `alphatrade_trades_${id}`;
    const cached = await get(localKey);

    // If user key is empty but we have a legacy global key, we will migrate it in repairStorage()
    return (cached as Trade[]) || [];
  },

  /**
   * Repairs and simplifies storage by migrating legacy data to user-specific keys
   * and clearing old global keys that cause stale data issues.
   */
  async repairStorage(userId: string): Promise<void> {
    if (!userId) return;

    const globalKey = 'alphatrade_trades';
    const userKey = `alphatrade_trades_${userId}`;

    try {
      const globalTrades = await get(globalKey);
      if (globalTrades && Array.isArray(globalTrades) && globalTrades.length > 0) {
        console.log(`[Repair] Migrating ${globalTrades.length} legacy trades to user cache...`);
        const userTrades = (await get(userKey)) || [];

        // Merge - unique by ID
        const tradeMap = new Map();
        userTrades.forEach((t: any) => tradeMap.set(t.id, t));
        globalTrades.forEach((t: any) => tradeMap.set(t.id, t));

        const merged = Array.from(tradeMap.values()).sort((a, b) => {
          const tA = a.timestamp || new Date(a.date).getTime() || 0;
          const tB = b.timestamp || new Date(b.date).getTime() || 0;
          return tB - tA;
        });

        await set(userKey, merged);
        await del(globalKey);
        console.log("[Repair] Legacy trades migrated and global key deleted.");
      }
    } catch (e) {
      console.warn("[Repair] Failed to migrate trades:", e);
    }
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
        screenshot:data->>screenshot,
        screenshots:data->screenshots,
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
      screenshot: t.screenshot,
      screenshots: t.screenshots,
      miniViewRange: t.miniViewRange,
      miniViewLayout: t.miniViewLayout,
      miniViewSecondaryRange: t.miniViewSecondaryRange,
      miniViewSecondaryTimeframe: t.miniViewSecondaryTimeframe,

      // We don't carry the full blob anymore to save memory
      data: {}
    })) as Trade[];

    // Cache only a limited number of most recent trades (e.g. 300) to respect LocalStorage quota
    // Save to IndexedDB (unlimited size mostly) instead of LocalStorage
    // Fire and forget
    await set(localKey, trades);
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

    // Update the trade record
    // List of known columns in 'trades' table (to avoid sending unknown keys which causes Supabase error 400)
    const knownColumns = ['id', 'user_id', 'account_id', 'instrument', 'pnl', 'direction', 'date', 'timestamp', 'drawings', 'data', 'is_public', 'created_at', 'setup', 'mistake', 'run_up', 'drawdown', 'risk_amount', 'entry_price', 'exit_price', 'quantity', 'notes', 'tags', 'screenshots', 'signal'];

    // Filter updates to only include known columns for the root level update
    const rootUpdates: any = {};
    Object.keys(updates).forEach(key => {
      // Simple heuristic: camelCase keys usually belong to JSON 'data', snake_case to columns.
      // But our Trade type mixes them. Let's explicitly check or just save everything to 'data' and only specific ones to root.
      // Actually, safer approach: ONLY update 'data' with everything, and root with minimal set if needed.
      // But existing code does sync some fields.
      if (knownColumns.includes(key) || knownColumns.includes(key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`))) {
        // Try to map or just pass if matches exact column name.
        // Since we don't have exact schema introspection here, let's be conservative.
        // miniViewRange is definitely NOT a column.
        // So we should NOT include ...updates in the root update if it contains miniViewRange.
      }
    });

    // Better strategy: explicitly exclude known non-columns from root spread
    const { miniViewRange, miniViewLayout, miniViewSecondaryRange, miniViewSecondaryTimeframe, ...safeRootUpdates } = updates as any;

    // Be even safer: 'data' is the source of truth for these new UI fields.
    // So we update 'data' column with ALL updates merged.
    // And for the root row update, we only include the 'data' field itself (and maybe essential columns if they changed like pnl/instrument).
    // The previous code `...updates` was dangerous.

    const { error } = await supabase
      .from('trades')
      .update({
        // We only spread safe known columns or exclude the new UI ones.
        ...safeRootUpdates,
        data: updatedData
      })
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

    // --- OPUS-LEVEL CACHE MERGE ---
    // Nenačítáme slepě, ale mergujeme nové obchody s existující cache.
    // To řeší "Race Condition", kdy se při refreshi nenačetl nejnovější obchod.
    try {
      const cacheKey = `alphatrade_trades_${userId}`;
      const currentCache = (await get<Trade[]>(cacheKey)) || [];

      // Vytvoříme Mapu pro unifikaci podle ID (přepíše staré verze novými)
      const tradeMap = new Map<string | number, Trade>();
      currentCache.forEach(t => tradeMap.set(t.id, t));
      trades.forEach(t => tradeMap.set(t.id, t));

      // Seřadíme sestupně podle času (nejnovější nahoře)
      const mergedCache = Array.from(tradeMap.values()).sort((a, b) => {
        const timeA = a.timestamp || new Date(a.date).getTime();
        const timeB = b.timestamp || new Date(b.date).getTime();
        return timeB - timeA;
      });

      // Uložíme sloučenou verzi zpět do IndexedDB
      await set(cacheKey, mergedCache);
    } catch (err) {
      console.error("[Storage] Cache merge failed:", err);
      // Fallback: Pokud selže merge, uložíme alespoň to co máme (better than nothing)
      await set(`alphatrade_trades_${userId}`, trades);
    }

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

    const tradesToUpsert = trades.map(t => {
      const realAccId = isUUID(t.accountId) ? t.accountId : (dbAccounts?.[0]?.id);
      if (!realAccId) return null;

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
        data: { ...t, accountId: realAccId, drawings: t.drawings || [] }
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

    return results;
  },

  async deleteTrade(id: string): Promise<void> {
    if (!isUUID(id)) return;

    // 1. Delete from Supabase
    const { error } = await supabase.from('trades').delete().eq('id', id);
    if (error) throw error;

    // 2. Update IndexedDB cache
    const userId = await getUserId();
    if (userId) {
      const localKey = `alphatrade_trades_${userId}`;
      const cachedTrades: Trade[] = await get(localKey) || [];
      const updatedTrades = cachedTrades.filter(t => t.id !== id);
      await set(localKey, updatedTrades);
      console.log(`[DeleteTrade] Removed trade ${id} from cache`);
    }
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
    await supabase.from('trades').update({ is_public: true }).eq('id', id);
  },

  async getTradeById(id: string): Promise<Trade | null> {
    const { data, error } = await supabase.from('trades').select('*').eq('id', id).single();
    if (error || !data) return null;
    return {
      ...data.data,
      id: data.id,
      accountId: data.account_id,
      instrument: data.instrument,
      pnl: data.pnl,
      direction: data.direction,
      date: data.date,
      timestamp: data.timestamp
    };
  },

  // Accounts
  getCachedAccounts(targetUserId?: string): Account[] {
    const localKey = targetUserId ? `alphatrade_accounts_${targetUserId}` : 'alphatrade_accounts';
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

    // Fast local storage fallback
    const localKey = targetUserId ? `alphatrade_accounts_${targetUserId}` : 'alphatrade_accounts';
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
    // Save to local storage immediately
    safeSetItem('alphatrade_accounts', accounts);

    const userId = await getUserId();
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
      safeSetItem('alphatrade_accounts', finalResults);
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
    const { error } = await supabase.from('accounts').delete().eq('id', id);
    if (error) {
      console.error("Supabase deleteAccount error:", error);
      throw error;
    }
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
    await supabase.from('profiles').update({ preferences: prefs }).eq('id', userId);
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

    // 2. Cache to IndexedDB (can handle large base64 screenshots)
    if (userId) await set(`alphatrade_daily_preps_${userId}`, dbPreps);

    return dbPreps;
  },

  async saveDailyPreps(preps: DailyPrep[]): Promise<void> {
    const userId = await getUserId();
    if (!userId) return;

    // Save to IndexedDB immediately (can handle large screenshots)
    await set(`alphatrade_daily_preps_${userId}`, preps);

    // Sync to Supabase
    const prepsToUpsert = preps.map(p => ({ user_id: userId, date: p.date, data: p }));
    const { error } = await supabase.from('daily_preps').upsert(prepsToUpsert, { onConflict: 'user_id,date' });
    if (error) {
      console.error("Failed to sync preps to Supabase:", error);
      throw error;
    }
  },

  async deleteDailyPrep(date: string): Promise<void> {
    const userId = await getUserId();
    if (!userId) return;
    await supabase.from('daily_preps').delete().eq('user_id', userId).eq('date', date);
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

    // 2. Cache to IndexedDB
    if (userId) await set(`alphatrade_daily_reviews_${userId}`, dbReviews);

    return dbReviews;
  },

  async saveDailyReviews(reviews: DailyReview[]): Promise<void> {
    const userId = await getUserId();
    if (!userId) return;

    // Save to IndexedDB immediately
    await set(`alphatrade_daily_reviews_${userId}`, reviews);

    // Sync to Supabase
    const reviewsToUpsert = reviews.map(r => ({ user_id: userId, date: r.date, data: r }));
    const { error } = await supabase.from('daily_reviews').upsert(reviewsToUpsert, { onConflict: 'user_id,date' });
    if (error) {
      console.error("Failed to sync reviews to Supabase:", error);
      throw error;
    }
  },

  async deleteDailyReview(date: string): Promise<void> {
    const userId = await getUserId();
    if (!userId) return;
    await supabase.from('daily_reviews').delete().eq('user_id', userId).eq('date', date);
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
    const prefs = await this.getPreferences();
    return prefs?.businessExpenses || [];
  },

  async getBusinessPayouts(): Promise<BusinessPayout[]> {
    const prefs = await this.getPreferences();
    return prefs?.businessPayouts || [];
  },

  async getPlaybookItems(): Promise<PlaybookItem[]> {
    const prefs = await this.getPreferences();
    return prefs?.playbookItems || [];
  },

  async getBusinessGoals(): Promise<BusinessGoal[]> {
    const prefs = await this.getPreferences();
    return prefs?.businessGoals || [];
  },

  async getBusinessResources(): Promise<BusinessResource[]> {
    const prefs = await this.getPreferences();
    return prefs?.businessResources || [];
  },

  async getBusinessSettings(): Promise<BusinessSettings> {
    const prefs = await this.getPreferences();
    return prefs?.businessSettings || { taxRatePct: 15, defaultPropThreshold: 150 };
  },

  // Active State
  getActiveAccountId(): string | null { return localStorage.getItem('alphatrade_active_account'); },
  setActiveAccountId(id: string): void { localStorage.setItem('alphatrade_active_account', id); },

  async clearAll(): Promise<void> {
    localStorage.clear();
    await supabase.auth.signOut();
  },

  // Network / Social
  async searchUsers(query: string): Promise<UserSearch[]> {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, email, full_name')
      .or(`email.ilike.% ${query}%, full_name.ilike.% ${query}% `)
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
      .or(`sender_id.eq.${userId}, receiver_id.eq.${userId} `);

    if (error) return [];
    return (data || []).map(c => ({
      ...c,
      sender: c.sender ? { id: c.sender.id, email: c.sender.email, name: c.sender.full_name } : undefined,
      receiver: c.receiver ? { id: c.receiver.id, email: c.receiver.email, name: c.receiver.full_name } : undefined
    }));
  },

  async updateConnectionStatus(connectionId: string, status: 'accepted' | 'rejected'): Promise<void> {
    if (status === 'rejected') {
      await supabase.from('connections').delete().eq('id', connectionId);
    } else {
      await supabase.from('connections').update({ status }).eq('id', connectionId);
    }
  },

  async updateConnectionPermissions(connectionId: string, permissions: any): Promise<void> {
    await supabase.from('connections').update({ permissions }).eq('id', connectionId);
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

    // 1. Fetch data
    const [trades, accounts, preps, reviews, prefs] = await Promise.all([
      this.getTrades(targetUserId),
      this.getAccounts(targetUserId),
      this.getDailyPreps(targetUserId),
      this.getDailyReviews(targetUserId),
      this.getPreferences(targetUserId)
    ]);

    // 2. Check permissions
    const { data: connection } = await supabase
      .from('connections')
      .select('permissions')
      .or(`and(sender_id.eq.${currentUserId}, receiver_id.eq.${targetUserId}), and(sender_id.eq.${targetUserId}, receiver_id.eq.${currentUserId})`)
      .eq('status', 'accepted')
      .maybeSingle();

    const isSelf = currentUserId === targetUserId;
    const rawPerms = isSelf ? null : (connection?.permissions as any);

    const perms = {
      pnlFormat: isSelf ? (prefs?.pnlFormat || 'usd') : (rawPerms?.pnlFormat || (rawPerms?.canSeePnl ? 'usd' : 'hidden')),
      canSeePrep: isSelf || (rawPerms?.canSeePrep ?? false),
      canSeeReviewStats: isSelf || (rawPerms?.canSeeReviewStats ?? false),
      canSeeReviewNotes: isSelf || (rawPerms?.canSeeReviewNotes ?? false),
      canSeeScreenshots: isSelf || (rawPerms?.canSeeScreenshots ?? false)
    };

    // 3. Sanitize TRADES
    const sanitizedTrades = trades.map(t => {
      let displayPnl = 0;

      if (perms.pnlFormat === 'usd') {
        displayPnl = t.pnl;
      } else if (perms.pnlFormat === 'rr') {
        // If R:R, we hide the PnL $ but technically we return 0 in 'pnl' field to ensure stats don't leak total $.
        // The UI will look for a calculated RR or we can abuse the 'pnl' field? 
        // Better: return 0 pnl, but add a 'displayRR' field? 
        // Types don't support displayRR, so we might need to rely on UI calculating it?
        // But UI needs riskAmount to calculate RR. If we send riskAmount + pnl=0, RR is 0.
        // We must send RR pre-calculated in a field the UI can read.
        // Or we update Trade type? For now, let's keep it simple: 
        // If RR mode: set PnL to 0. The UI "Spectator Detail" needs to know to show RR.
        // We can't easily push a string "2.5R" into a number 'pnl' field.
        // Strategy: The UI will check pnlFormat. If 'rr', it will try to calc RR. 
        // To calc RR, it needs PnL and Risk. If we hide PnL (set to 0), it can't calc RR.
        // So we must spoof the PnL to be effectively "Risk * RR" but wait, that's just the PnL! 
        // If we send the real PnL, they can see the $, unless UI hides it.
        // But SpectatorData is "Sanitized". If we send real PnL, we leak it.
        // Solution: We need to normalize the trade to 1R = 1 unit? No.
        // We just send the RR value as the PnL! e.g. 2.5 (meaning 2.5R). 
        // And we set riskAmount to 1. Then PnL / Risk = 2.5 / 1 = 2.5R.
        // This way, the $ amount is effectively hidden (it looks like $2.50), but the R value is preserved.

        const risk = t.riskAmount || 0;
        const rr = risk > 0 ? t.pnl / risk : 0;
        displayPnl = parseFloat(rr.toFixed(2));
      } else {
        displayPnl = 0; // Hidden
      }

      return {
        ...t,
        pnl: displayPnl,
        // If RR mode, force risk to 1 so UI calc works out to exactly the RR value
        riskAmount: perms.pnlFormat === 'rr' ? 1 : t.riskAmount,

        notes: perms.canSeeReviewNotes ? t.notes : null, // Re-using ReviewNotes perm for Trade Notes for simplicity? Or add explicit 'canSeeTradeNotes'? User said "vecerni review rozdelit", implies trade notes might be same or default. Let's use canSeeReviewNotes as "canSeeText".
        screenshot: perms.canSeeScreenshots ? t.screenshot : null,
        screenshots: perms.canSeeScreenshots ? t.screenshots : [],
        entryPrice: perms.pnlFormat !== 'hidden' ? t.entryPrice : null, // If they can see metric, maybe entry is ok? Or strictly USD? Let's hide entry if hidden.
        exitPrice: perms.pnlFormat !== 'hidden' ? t.exitPrice : null,
      };
    });

    // 4. Sanitize REVIEWS
    const sanitizedReviews = reviews.map(r => ({
      ...r,
      // Stats
      rating: perms.canSeeReviewStats ? r.rating : 0, // 0 stars
      ruleAdherence: perms.canSeeReviewStats ? r.ruleAdherence : [],
      mistakes: perms.canSeeReviewStats ? r.mistakes : [],

      // Notes
      mainTakeaway: perms.canSeeReviewNotes ? r.mainTakeaway : null,
      notes: perms.canSeeReviewNotes ? r.notes : null,
      lessons: perms.canSeeReviewNotes ? r.lessons : null,
      psycho: r.psycho ? {
        ...r.psycho,
        notes: perms.canSeeReviewNotes ? r.psycho.notes : ''
      } : undefined
    }));

    // 5. Sanitize PREPS
    // Strict toggle: if !canSeePrep, return totally empty shell
    const sanitizedPreps = preps.map(p => {
      if (!perms.canSeePrep) {
        return {
          ...p,
          mindsetState: null,
          notes: null,
          scenarios: { bullish: null as any, bearish: null as any, bullishImage: null, bearishImage: null }
        };
      }
      return {
        ...p,
        // Even if allowed, still check screenshot perm for images
        scenarios: {
          ...p.scenarios,
          bullishImage: perms.canSeeScreenshots ? p.scenarios.bullishImage : null,
          bearishImage: perms.canSeeScreenshots ? p.scenarios.bearishImage : null,
        }
      };
    });

    // 6. Filter Accounts
    const sanitizedAccounts = accounts.map(a => ({
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
        pnlFormat: perms.pnlFormat
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

  // Smart refresh - načte nové obchody ze serveru pokud cache obsahuje starší data
  async getTradesWithSmartRefresh(targetUserId?: string): Promise<Trade[]> {
    const userId = targetUserId || await getUserId();
    if (!userId) return [];

    const localKey = userId ? `alphatrade_trades_${userId}` : 'alphatrade_trades';
    let localTrades: Trade[] = await get(localKey) || [];

    // Pokud nemáme žádná cached data, načti vše ze serveru
    if (localTrades.length === 0) {
      console.log("[SmartRefresh] No cache, fetching all from server");
      return await this.getTrades(targetUserId);
    }

    // Reliable detection of newest trade using timestamp first, then createdAt
    const newestCachedTrade = localTrades.reduce((newest, trade) => {
      const tradeTime = trade.timestamp || (trade.createdAt ? new Date(trade.createdAt).getTime() : 0) || new Date(trade.date).getTime() || 0;
      const newestTime = newest.timestamp || (newest.createdAt ? new Date(newest.createdAt).getTime() : 0) || new Date(newest.date).getTime() || 0;
      return tradeTime > newestTime ? trade : newest;
    }, localTrades[0]);

    // Use ISO string of the newest createdAt or derive from timestamp
    const newestCacheDate = newestCachedTrade.createdAt ||
      (newestCachedTrade.timestamp ? new Date(newestCachedTrade.timestamp).toISOString() : new Date(newestCachedTrade.date).toISOString());

    console.log(`[SmartRefresh] Newest cached trade: ${newestCachedTrade.date}, seeking trades since: ${newestCacheDate}`);

    // Načti pouze novější obchody ze serveru
    const { data: recentTrades, error } = await supabase
      .from('trades')
      .select('*')
      .eq('user_id', userId)
      .gt('created_at', newestCacheDate)
      .order('created_at', { ascending: false });

    if (error) {
      console.error("[SmartRefresh] Failed to fetch recent trades:", error);
      return localTrades; // Vrať cache při chybě
    }

    // Pokud nejsou nové obchody, vrať cache
    if (!recentTrades || recentTrades.length === 0) {
      console.log("[SmartRefresh] No newer trades found, using cache");
      return localTrades;
    }

    console.log(`[SmartRefresh] Found ${recentTrades.length} newer trades, merging with cache`);
    console.log(`[SmartRefresh] Cache had ${localTrades.length} trades, merging with ${recentTrades.length} new trades`);

    // Převeď nová data na Trade objekty - použij stejnou transformaci jako getTrades()
    const newTrades = recentTrades.map((t: any) => ({
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

      // Mapped JSON fields from data blob
      setup: t.data?.setup,
      mistake: t.data?.mistake,
      notes: t.data?.notes,
      tags: t.data?.tags,
      runUp: t.data?.runUp ? Number(t.data.runUp) : undefined,
      drawdown: t.data?.drawdown ? Number(t.data.drawdown) : undefined,
      riskAmount: t.data?.riskAmount ? Number(t.data.riskAmount) : undefined,
      targetAmount: t.data?.targetAmount ? Number(t.data.targetAmount) : undefined,
      entryPrice: t.data?.entryPrice ? Number(t.data.entryPrice) : undefined,
      exitPrice: t.data?.exitPrice ? Number(t.data.exitPrice) : undefined,
      stopLoss: t.data?.stopLoss ? Number(t.data.stopLoss) : undefined,
      takeProfit: t.data?.takeProfit ? Number(t.data.takeProfit) : undefined,
      quantity: t.data?.quantity ? Number(t.data.quantity) : undefined,
      signal: t.data?.signal,
      session: t.data?.session,
      confidence: t.data?.confidence ? Number(t.data.confidence) : undefined,
      rr: t.data?.rr ? Number(t.data.rr) : undefined,
      duration: t.data?.duration,
      durationMinutes: t.data?.durationMinutes ? Number(t.data.durationMinutes) : 0,
      isValid: t.data?.isValid === 'true' || t.data?.isValid === true,
      groupId: t.data?.groupId,
      htfConfluence: t.data?.htfConfluence,
      ltfConfluence: t.data?.ltfConfluence,
      mistakes: t.data?.mistakes,
      emotions: t.data?.emotions,
      planAdherence: t.data?.planAdherence,
      executionStatus: t.data?.executionStatus,
      screenshot: t.data?.screenshot,
      screenshots: t.data?.screenshots,
      miniViewRange: t.data?.miniViewRange,
      miniViewLayout: t.data?.miniViewLayout,
      miniViewSecondaryRange: t.data?.miniViewSecondaryRange,
      miniViewSecondaryTimeframe: t.data?.miniViewSecondaryTimeframe,
      data: t.data || {}
    })) as Trade[];

    // Merge s cache pomocí Map pro unikátní ID
    const tradeMap = new Map<string | number, Trade>();
    localTrades.forEach(t => tradeMap.set(t.id, t));
    newTrades.forEach(t => tradeMap.set(t.id, t));

    // Seřaď podle času (nejnovější nahoře)
    const mergedTrades = Array.from(tradeMap.values()).sort((a, b) => {
      const timeA = a.timestamp || new Date(a.date).getTime();
      const timeB = b.timestamp || new Date(b.date).getTime();
      return timeB - timeA;
    });

    // Ulož mergované obchody zpět do cache
    await set(localKey, mergedTrades);
    console.log(`[SmartRefresh] Updated cache with ${mergedTrades.length} total trades`);

    return mergedTrades;
  }
};
