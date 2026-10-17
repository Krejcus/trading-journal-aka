import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER = '6fd09385-2400-4643-b6dc-9ab3b4a827cd';

const memoryStorage = () => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, String(value)); },
    removeItem: (key: string) => { data.delete(key); },
    clear: () => data.clear(),
  };
};

/** Simulovaný Supabase: řádek profilu, zachycené upserty a callback přihlášení. */
const server = vi.hoisted(() => ({
  row: null as null | { profile: unknown; updated_at: string },
  selectError: null as null | Error,
  upserts: [] as unknown[],
  authCallback: null as null | ((event: string, session: { user: { id: string } } | null) => void),
}));

vi.mock('../services/supabase', () => ({
  supabase: {
    auth: {
      onAuthStateChange: (callback: typeof server.authCallback) => {
        server.authCallback = callback;
        return { data: { subscription: { unsubscribe: () => {} } } };
      },
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            if (server.selectError) throw server.selectError;
            return { data: server.row, error: null };
          },
        }),
      }),
      upsert: async (value: unknown) => { server.upserts.push(value); return { error: null }; },
    }),
  },
}));

const flush = async () => {
  for (let index = 0; index < 6; index += 1) await new Promise(resolve => setTimeout(resolve, 0));
};

const v1Profile = (fvg: boolean) => ({
  version: 1,
  indicators: { fvg, levels: true, structure: false },
  indicatorStyle: {},
  chartSettings: null,
});

describe('synchronizace profilu grafů se serverem', () => {
  let storage: ReturnType<typeof memoryStorage>;
  const listeners = new Map<string, () => void>();

  beforeEach(() => {
    vi.resetModules();
    server.row = null;
    server.selectError = null;
    server.upserts = [];
    server.authCallback = null;
    storage = memoryStorage();
    listeners.clear();
    vi.stubGlobal('window', {
      localStorage: storage,
      setTimeout,
      clearTimeout,
      setInterval: () => 0,
      clearInterval: () => {},
      dispatchEvent: () => true,
      addEventListener: (name: string, listener: () => void) => { listeners.set(name, listener); },
      removeEventListener: () => {},
    });
    vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {} });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  const start = async () => {
    const { startChartProfileSync } = await import('../services/chartProfileSync');
    const stop = startChartProfileSync();
    server.authCallback?.('SIGNED_IN', { user: { id: USER } });
    await flush();
    return stop;
  };

  it('na prázdný server nenahraje výchozí profil', async () => {
    const stop = await start();
    expect(server.upserts).toHaveLength(0);
    stop();
  });

  it('řádek neznámé (novější) verze nepřepíše ani nepřevezme', async () => {
    server.row = { profile: { version: 2, something: true }, updated_at: new Date().toISOString() };
    const stop = await start();
    expect(server.upserts).toHaveLength(0);
    expect(storage.getItem('alphatrade:detail-indicators')).toBeNull();
    stop();
  });

  it('první běh převezme profil serveru a místní schová jako zálohu', async () => {
    storage.setItem('alphatrade:detail-indicators', JSON.stringify({ fvg: false, levels: false, structure: true }));
    server.row = { profile: v1Profile(true), updated_at: new Date('2026-10-16T10:00:00Z').toISOString() };
    const stop = await start();
    expect(JSON.parse(storage.getItem('alphatrade:detail-indicators')!)).toEqual({ fvg: true, levels: true, structure: false });
    const backup = JSON.parse(storage.getItem(`alphatrade:chart-profile-backup:user:${USER}`)!);
    expect(backup.profile.indicators).toEqual({ fvg: false, levels: false, structure: true });
    expect(server.upserts).toHaveLength(0);
    stop();
  });

  it('výpadek sítě sync nevypne — další pokus proběhne', async () => {
    server.selectError = new Error('offline');
    server.row = { profile: v1Profile(true), updated_at: new Date('2026-10-16T10:00:00Z').toISOString() };
    const stop = await start();
    expect(storage.getItem('alphatrade:detail-indicators')).toBeNull();
    server.selectError = null;
    listeners.get('focus')?.();
    await flush();
    expect(JSON.parse(storage.getItem('alphatrade:detail-indicators')!).fvg).toBe(true);
    stop();
  });
});
