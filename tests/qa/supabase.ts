import { QA_START_MS, qaState, notifyQa } from './state';
const closed = (time: number) => {
  const date = new Date(time * 1000);
  const day = date.getUTCDay(), hour = date.getUTCHours();
  return day === 6 || day === 5 && hour >= 21 || day === 0 && hour < 22 || hour === 21;
};
const quarter = (value: number) => Math.round(value * 4) / 4;
const price = (minute: number) => quarter(100 + Math.sin(minute / 8) * 3 + Math.sin(minute / 57) * 2);
const minuteCandle = (time: number) => {
  const index = Math.floor((time * 1000 - QA_START_MS) / 60_000);
  const open = price(index), close = price(index + 1);
  return { time, open, high: Math.max(open, close) + 0.75, low: Math.min(open, close) - 0.75, close, volume: 50 + Math.abs(index % 20) };
};
export const supabase = {
  functions: {
    async invoke(name: string, options: { body: { symbol: string; schema: string; start: string; end: string } }) {
      if (name !== 'market-candles') throw new Error(`QA blocks remote function ${name}`);
      const request = { ...options.body, result: 'pending' };
      qaState.marketRequests.push(request); notifyQa();
      await new Promise(resolve => setTimeout(resolve, qaState.marketDelayMs));
      if (qaState.failMarketRequests > 0) {
        qaState.failMarketRequests--;
        request.result = 'injected error'; notifyQa();
        return { data: null, error: { message: 'QA injected market request failure; retry is safe' } };
      }
      const duration = options.body.schema === 'ohlcv-1h' ? 3600 : 60;
      const start = Math.ceil(Date.parse(options.body.start) / 1000 / duration) * duration;
      const end = Date.parse(options.body.end) / 1000;
      const candles = [];
      for (let time = start; time < end; time += duration) {
        if (closed(time)) continue;
        const minutes = Array.from({ length: duration / 60 }, (_, i) => minuteCandle(time + i * 60));
        candles.push({ time, open: minutes[0].open, close: minutes.at(-1)!.close,
          high: Math.max(...minutes.map(c => c.high)), low: Math.min(...minutes.map(c => c.low)),
          volume: minutes.reduce((total, c) => total + c.volume, 0) });
      }
      request.result = `${candles.length} candles`; notifyQa();
      return { data: { candles, estimatedCostUsd: 0, sourceSymbol: 'QA SYNTHETIC', start: options.body.start, end: options.body.end }, error: null };
    },
  },
  from() { throw new Error('QA blocks all remote table access'); },
  auth: {
    // Chart/storage modules register this listener at import time. The harness
    // intentionally has no authenticated user or remote storage session.
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    getSession: async () => ({ data: { session: null }, error: null }),
    getUser: async () => ({ data: { user: null }, error: null }),
    signOut: async () => ({ error: null }),
  },
};

export const isSupabaseConfigured = false;
