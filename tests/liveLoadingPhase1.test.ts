import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CopierRelayFeedSources,
  CopierRelayInFlight,
  runCopierRelayStatusRound,
} from '../lib/copierRelayPollSources';
import type { CopierRelayStatusEnvelope } from '../lib/copierRelayStatusPoll';
import { createCopierForegroundPoller, isCopierStatusFresh } from '../lib/copierForegroundPoller';
import {
  clearCopierAgentStatusStore,
  copierRelayFeedSourcesFor,
  readCopierAgentStatusSnapshot,
  writeCopierAgentStatusSnapshot,
} from '../lib/copierAgentStatusStore';
import { copierAgentCommandAllowedWhileRestored } from '../lib/copierSafetyControls';
import {
  __resetAppForegroundForTests,
  __setNativeAppActiveForTests,
  isAppForeground,
  subscribeAppForeground,
} from '../lib/appForeground';

vi.mock('../services/supabase', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: { access_token: 'mock-token' } } }) } },
}));

type Status = { worker: string };
const envelope = (worker: string, connected = true): CopierRelayStatusEnvelope<Status> => ({
  status: { worker }, lastSeenAt: new Date().toISOString(), connected, ageMs: 0,
});
const delayed = <T>(ms: number, value: T) => new Promise<T>(resolve => setTimeout(() => resolve(value), ms));

describe('relay kolo: pomalé vedlejší spojení nebrzdí worker', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('stav vybraného workeru zůstane čerstvý, i když druhé spojení odpovídá 20 s', async () => {
    const inFlight = new CopierRelayInFlight();
    const loads: string[] = [];
    let observedAt: number | null = null;
    const load = (connectionId: string) => {
      loads.push(connectionId);
      return connectionId === 'slow'
        ? delayed(20_000, envelope('slow-worker', false))
        : delayed(200, envelope('main-worker'));
    };
    const poller = createCopierForegroundPoller({
      visible: () => true,
      invalidate: () => undefined,
      read: async () => {
        await runCopierRelayStatusRound({
          connectionIds: ['slow', 'fast'],
          preferredConnectionId: 'fast',
          inFlight,
          load,
          onFirstConnected: () => { observedAt = Date.now(); },
          onSettled: () => undefined,
        });
      },
    });

    // Celých 25 s kontrolujeme čerstvost po každé sekundě.
    let staleSeconds = 0;
    for (let second = 1; second <= 25; second += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      if (!isCopierStatusFresh(observedAt, Date.now(), true)) staleSeconds += 1;
    }
    poller.stop();

    expect(staleSeconds).toBe(0);
    // Pomalé spojení se během běžícího čtení znovu nečte (žádné hromadění).
    expect(loads.filter(id => id === 'slow')).toHaveLength(2);
    expect(loads.filter(id => id === 'fast').length).toBeGreaterThan(8);
  });

  it('bez žádného živého workeru kolo počká na všechna právě čtená spojení', async () => {
    const inFlight = new CopierRelayInFlight();
    const onFirstConnected = vi.fn();
    const round = runCopierRelayStatusRound({
      connectionIds: ['a', 'b'],
      preferredConnectionId: null,
      inFlight,
      load: id => delayed(id === 'a' ? 100 : 300, envelope(id, false)),
      onFirstConnected,
      onSettled: () => undefined,
    });
    await vi.advanceTimersByTimeAsync(300);
    const result = await round;
    expect(onFirstConnected).not.toHaveBeenCalled();
    expect(result).toMatchObject({ outcome: 'settled', skippedPending: false });
    expect(result.outcome === 'settled' && result.candidates).toHaveLength(2);
  });

  it('když všechna spojení ještě čtou, kolo nic nespustí a o stavu nerozhoduje', async () => {
    const inFlight = new CopierRelayInFlight();
    const load = vi.fn((id: string) => delayed(10_000, envelope(id)));
    void runCopierRelayStatusRound({
      connectionIds: ['a'], preferredConnectionId: null, inFlight, load,
      onFirstConnected: () => undefined, onSettled: () => undefined,
    });
    const second = await runCopierRelayStatusRound({
      connectionIds: ['a'], preferredConnectionId: null, inFlight, load,
      onFirstConnected: () => undefined, onSettled: () => undefined,
    });
    expect(second).toEqual({ outcome: 'pending' });
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
  });

  it('výpadek vybraného workeru se nepřekryje posledním ON: bez živé odpovědi stav zestárne', async () => {
    const inFlight = new CopierRelayInFlight();
    let observedAt: number | null = Date.now();
    let workerAlive = true;
    const poller = createCopierForegroundPoller({
      visible: () => true,
      invalidate: () => undefined,
      read: async () => {
        await runCopierRelayStatusRound({
          connectionIds: ['fast'],
          preferredConnectionId: 'fast',
          inFlight,
          load: () => delayed(100, envelope('main', workerAlive)),
          onFirstConnected: () => { observedAt = Date.now(); },
          onSettled: () => undefined,
        });
      },
    });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(isCopierStatusFresh(observedAt, Date.now(), true)).toBe(true);
    workerAlive = false;
    await vi.advanceTimersByTimeAsync(16_000);
    poller.stop();
    expect(isCopierStatusFresh(observedAt, Date.now(), true)).toBe(false);
  });
});

describe('zobrazovací feedy z relay spojení', () => {
  it('pozdní čtení staršího kola nepřepíše novější feed a rychlé kolo nezahodí ostatní spojení', () => {
    const sources = new CopierRelayFeedSources<string>();
    expect(sources.set('fast', 2, ['fast@2'])).toBe(true);
    expect(sources.set('slow', 1, ['slow@1'])).toBe(true);
    // Kolo 1 doběhne pozdě i pro „fast“: starší data se nepoužijí.
    expect(sources.set('fast', 1, ['fast@1'])).toBe(false);
    expect(sources.feeds(['fast', 'slow'])).toEqual(['fast@2', 'slow@1']);
    // Starší kolo nesmí smazat novější feed.
    expect(sources.drop('fast', 1)).toBe(false);
    expect(sources.drop('slow', 3)).toBe(true);
    expect(sources.feeds(['fast', 'slow'])).toEqual(['fast@2']);
    // Spojení, které už uživatel nemá, se nezobrazí.
    expect(sources.feeds(['slow'])).toEqual([]);
  });
});

describe('společné úložiště stavu workeru', () => {
  beforeEach(() => { clearCopierAgentStatusStore(); });

  const snapshot = (userId: string) => ({
    userId,
    status: { armed: true },
    observedAt: 1_000,
    readHealthy: true,
    transport: 'relay' as const,
    relayConnectionId: 'conn-1',
    lastRoute: { transport: 'relay' as const, relayConnectionId: 'conn-1' },
    feedReceipt: null,
  });

  it('vrátí stav jen stejnému uživateli', () => {
    writeCopierAgentStatusSnapshot(snapshot('user-a'));
    expect(readCopierAgentStatusSnapshot('user-a')?.status).toEqual({ armed: true });
    expect(readCopierAgentStatusSnapshot('user-b')).toBeNull();
    expect(readCopierAgentStatusSnapshot('')).toBeNull();
  });

  it('odhlášení i zápis jiného uživatele okamžitě zneplatní předchozí stav i feedy', () => {
    writeCopierAgentStatusSnapshot(snapshot('user-a'));
    copierRelayFeedSourcesFor<string>('user-a').set('conn-1', 1, ['feed-a']);
    writeCopierAgentStatusSnapshot(snapshot('user-b'));
    expect(readCopierAgentStatusSnapshot('user-a')).toBeNull();
    expect(copierRelayFeedSourcesFor<string>('user-b').feeds(['conn-1'])).toEqual([]);

    copierRelayFeedSourcesFor<string>('user-b').set('conn-1', 1, ['feed-b']);
    clearCopierAgentStatusStore();
    expect(readCopierAgentStatusSnapshot('user-b')).toBeNull();
    expect(copierRelayFeedSourcesFor<string>('user-b').feeds(['conn-1'])).toEqual([]);
  });

  it('po remountu LIVE pokračuje pořadí kol, takže čerstvé feedy nejsou odmítnuté', () => {
    const first = copierRelayFeedSourcesFor<string>('user-a');
    let round = 0;
    for (let index = 0; index < 57; index += 1) round = first.beginRound();
    first.set('conn-1', round, ['stary']);
    // Nová instance LiveDesk dostane stejné úložiště a navazující pořadí.
    const remounted = copierRelayFeedSourcesFor<string>('user-a');
    const next = remounted.beginRound();
    expect(next).toBeGreaterThan(round);
    expect(remounted.set('conn-1', next, ['cerstvy'])).toBe(true);
    expect(remounted.feeds(['conn-1'])).toEqual(['cerstvy']);
  });

  it('feedy jiného uživatele se nikdy nevrátí', () => {
    copierRelayFeedSourcesFor<string>('user-a').set('conn-1', 1, ['feed-a']);
    expect(copierRelayFeedSourcesFor<string>('user-b').feeds(['conn-1'])).toEqual([]);
    expect(copierRelayFeedSourcesFor<string>('user-a').feeds(['conn-1'])).toEqual([]);
  });
});

describe('návrat z pozadí (iOS appStateChange)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetAppForegroundForTests();
  });
  afterEach(() => {
    __resetAppForegroundForTests();
    vi.useRealTimers();
  });

  it('nativní uspání appky je pozadí i bez visibilitychange a hlásí se jen při změně', () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribeAppForeground(foreground => seen.push(foreground));
    __setNativeAppActiveForTests(false);
    __setNativeAppActiveForTests(false);
    expect(isAppForeground()).toBe(false);
    __setNativeAppActiveForTests(true);
    unsubscribe();
    expect(seen).toEqual([false, true]);
  });

  it('odpověď čtení zahájeného před uspáním se po návratu zahodí', async () => {
    let release!: () => void;
    const accepted: string[] = [];
    let reads = 0;
    const poller = createCopierForegroundPoller({
      visible: isAppForeground,
      invalidate: () => undefined,
      read: async isCurrent => {
        reads += 1;
        const label = `read-${reads}`;
        if (reads === 1) await new Promise<void>(resolve => { release = resolve; });
        if (isCurrent()) accepted.push(label);
      },
    });
    const unsubscribe = subscribeAppForeground(() => poller.resume());
    await vi.advanceTimersByTimeAsync(0);
    __setNativeAppActiveForTests(false);
    __setNativeAppActiveForTests(true);
    release();
    await vi.advanceTimersByTimeAsync(2_500);
    poller.stop();
    unsubscribe();
    expect(accepted).not.toContain('read-1');
    expect(accepted.length).toBeGreaterThan(0);
  });
});

describe('deadline čtení', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  // Jako skutečný fetch: už zrušený signál odmítne hned, jinak čeká na abort.
  const hangingFetch = () => vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const abort = () => reject(new DOMException('Aborted', 'AbortError'));
    if (init?.signal?.aborted) abort();
    else init?.signal?.addEventListener('abort', abort);
  }));

  it('read-only POST (live-pnl) nezůstane viset déle než deadline', async () => {
    const fetchMock = hangingFetch();
    vi.stubGlobal('fetch', fetchMock);
    const { runTradovateLivePnlTick, TRADOVATE_READ_TIMEOUT_MS } = await import('../services/tradovateOAuthConnection');
    const pending = runTradovateLivePnlTick('conn-1');
    const outcome = pending.then(() => 'resolved', () => 'rejected');
    await vi.advanceTimersByTimeAsync(TRADOVATE_READ_TIMEOUT_MS + 1);
    expect(await outcome).toBe('rejected');
  });

  it('bootstrap preflight respektuje signál volajícího i deadline', async () => {
    const fetchMock = hangingFetch();
    vi.stubGlobal('fetch', fetchMock);
    const { runTradovateReadOnlyPreflight } = await import('../services/tradovateOAuthConnection');
    const controller = new AbortController();
    const outcome = runTradovateReadOnlyPreflight('conn-1', 'bootstrap', controller.signal)
      .then(() => 'resolved', () => 'rejected');
    controller.abort();
    expect(await outcome).toBe('rejected');
  });

  it('execution zápis přes relay deadline nedostane a nejistý výsledek se neopakuje', async () => {
    const fetchMock = vi.fn((_url: unknown, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      // Execution POST nesmí mít náš deadline signál.
      expect(init?.signal ?? null).toBeNull();
      return Promise.reject(new TypeError('network down'));
    });
    vi.stubGlobal('fetch', fetchMock);
    const { executeTradovateCopierRelayCommand } = await import('../services/tradovateOAuthConnection');
    await expect(executeTradovateCopierRelayCommand('conn-1', { type: 'disarm' })).rejects.toThrow('network down');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('obnovený stav workeru je jen zobrazení', () => {
  it('neprojde ARM, změna skupiny, reconcile ani ověření; Flatten ano', () => {
    const group = { id: 'g' } as never;
    expect(copierAgentCommandAllowedWhileRestored({ type: 'arm' })).toBe(false);
    expect(copierAgentCommandAllowedWhileRestored({ type: 'reconcile' })).toBe(false);
    expect(copierAgentCommandAllowedWhileRestored({ type: 'verify-account-eligibility' })).toBe(false);
    expect(copierAgentCommandAllowedWhileRestored({ type: 'copy-command', command: { type: 'update-group', group } })).toBe(false);
    expect(copierAgentCommandAllowedWhileRestored({ type: 'copy-command', command: { type: 'arm', groupId: 'g' } as never })).toBe(false);
    expect(copierAgentCommandAllowedWhileRestored({ type: 'copy-command', command: { type: 'flatten-group', groupId: 'g' } as never })).toBe(true);
    expect(copierAgentCommandAllowedWhileRestored({ type: 'copy-command', command: { type: 'flatten-account', groupId: 'g', accountId: 1 } as never })).toBe(true);
  });
});

describe('iOS: nativní stav appky je autoritativní', () => {
  beforeEach(() => { __resetAppForegroundForTests(); });
  afterEach(() => {
    __resetAppForegroundForTests();
    vi.unstubAllGlobals();
  });

  it('po nativním resume je appka v popředí, i když DOM zůstal „hidden“', () => {
    vi.stubGlobal('document', { visibilityState: 'hidden', addEventListener: () => undefined });
    __setNativeAppActiveForTests(false);
    expect(isAppForeground()).toBe(false);
    __setNativeAppActiveForTests(true);
    expect(isAppForeground()).toBe(true);
  });
});
