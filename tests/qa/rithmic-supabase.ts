// Stub Supabase pro zkušební obrazovku nad Rithmic Test: žádná síť, žádný přihlášený uživatel,
// žádné smyšlené svíčky (historii dodává jen místní proces).
export const supabase = {
  functions: {
    async invoke(name: string, options: { body: { start: string; end: string } }) {
      if (name !== 'market-candles') throw new Error(`QA blocks remote function ${name}`);
      return { data: { candles: [], estimatedCostUsd: 0, sourceSymbol: 'RITHMIC TEST', start: options.body.start, end: options.body.end }, error: null };
    },
  },
  from() { throw new Error('QA blocks all remote table access'); },
  auth: {
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    getSession: async () => ({ data: { session: null }, error: null }),
    getUser: async () => ({ data: { user: null }, error: null }),
    signOut: async () => ({ error: null }),
  },
};

export const isSupabaseConfigured = false;
