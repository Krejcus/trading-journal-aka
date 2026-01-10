
import { Trade, Account, UserPreferences, DailyPrep, DailyReview, WeeklyReview, MonthlyReview, User, SocialConnection, UserSearch } from '../types';
import { supabase } from './supabase';

// Helper to validate UUID
const isUUID = (id: any) => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

// Helper to get current user ID
export const getUserId = async () => {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.user?.id;
};

export const storageService = {
  // User Profile
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
    return {
      id: data.id,
      email: data.email || '',
      name: data.full_name || '',
      avatar: data.avatar_url
    };
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
  },

  // Trades
  async getTrades(targetUserId?: string): Promise<Trade[]> {
    const userId = targetUserId || await getUserId();
    if (!userId) return [];

    const { data, error } = await supabase
      .from('trades')
      .select('*')
      .eq('user_id', userId);

    if (error) {
      console.error("Supabase getTrades error:", error);
      return [];
    }
    return data.map(t => ({
      ...t.data,
      id: t.id,
      accountId: t.account_id,
      instrument: t.instrument,
      pnl: t.pnl,
      direction: t.direction,
      date: t.date,
      timestamp: t.timestamp
    }));
  },

  async saveTrades(trades: Trade[]): Promise<Trade[]> {
    const userId = await getUserId();
    if (!userId || trades.length === 0) return [];

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
        data: { ...t, accountId: realAccId }
      };

      if (isUUID(t.id)) {
        obj.id = t.id;
      }

      return obj;
    }).filter(Boolean);

    const { data, error } = await supabase.from('trades').upsert(tradesToUpsert).select();
    if (error) throw error;

    return data.map(d => ({
      ...d.data,
      id: d.id,
      accountId: d.account_id,
      instrument: d.instrument,
      pnl: d.pnl,
      direction: d.direction,
      date: d.date,
      timestamp: d.timestamp
    }));
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
  async getAccounts(targetUserId?: string): Promise<Account[]> {
    const userId = targetUserId || await getUserId();
    if (!userId) return [];

    const { data, error } = await supabase
      .from('accounts')
      .select('*')
      .eq('user_id', userId);

    if (error) return [];
    return data.map(a => ({
      ...a.meta,
      id: a.id,
      name: a.name,
      initialBalance: a.initial_balance,
      currency: a.currency,
      type: a.type,
      status: a.status,
      createdAt: a.created_at
    }));
  },

  async saveAccounts(accounts: Account[]): Promise<Account[]> {
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

      return results.length > 0 ? results : accounts;

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
  async getPreferences(): Promise<UserPreferences | null> {
    const userId = await getUserId();
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
    if (!userId) return;
    await supabase.from('profiles').update({ preferences: prefs }).eq('id', userId);
  },

  // Daily Journal
  async getDailyPreps(targetUserId?: string): Promise<DailyPrep[]> {
    const userId = targetUserId || await getUserId();
    if (!userId) return [];
    const { data, error } = await supabase.from('daily_preps').select('*').eq('user_id', userId);
    if (error) return [];
    return data.map(d => ({ ...d.data, id: d.id, date: d.date }));
  },

  async saveDailyPreps(preps: DailyPrep[]): Promise<void> {
    const userId = await getUserId();
    if (!userId) return;
    const prepsToUpsert = preps.map(p => ({ user_id: userId, date: p.date, data: p }));
    await supabase.from('daily_preps').upsert(prepsToUpsert, { onConflict: 'user_id,date' });
  },

  async getDailyReviews(targetUserId?: string): Promise<DailyReview[]> {
    const userId = targetUserId || await getUserId();
    if (!userId) return [];
    const { data, error } = await supabase.from('daily_reviews').select('*').eq('user_id', userId);
    if (error) return [];
    return data.map(d => ({ ...d.data, id: d.id, date: d.date }));
  },

  async saveDailyReviews(reviews: DailyReview[]): Promise<void> {
    const userId = await getUserId();
    if (!userId) return;
    const reviewsToUpsert = reviews.map(r => ({ user_id: userId, date: r.date, data: r }));
    await supabase.from('daily_reviews').upsert(reviewsToUpsert, { onConflict: 'user_id,date' });
  },

  // Weekly & Monthly
  async getWeeklyReviews(): Promise<WeeklyReview[]> { return []; },
  async saveWeeklyReviews(_reviews: WeeklyReview[]): Promise<void> { },
  async getMonthlyReviews(): Promise<MonthlyReview[]> { return []; },
  async saveMonthlyReviews(_reviews: MonthlyReview[]): Promise<void> { },

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
      .or(`email.ilike.%${query}%,full_name.ilike.%${query}%`)
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
      .select(`*, sender:profiles!sender_id(id, email, full_name), receiver:profiles!receiver_id(id, email, full_name)`)
      .or(`sender_id.eq.${userId},receiver_id.eq.${userId}`);

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
  }
};
