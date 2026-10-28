import type { TvPricePayload } from './tvPriceMessage';

/**
 * Paměťový store ceny z TradingView pro klienta (krok 3 návrhu
 * `docs/reviews/tv-price-channel-design-20261026.md`). Jen zobrazení
 * (INV-UI-04): nic odsud nesmí do read modelu účtů, marks, display cache,
 * způsobilosti, limitů, ARM/příkazů, widgetu, sdílení ani do storage.
 * Store proto nic neukládá a drží jen poslední souvislou řadu vzorků.
 *
 * Do storu jdou jen zprávy s ověřeným podpisem (`verifyTvPriceEnvelope`).
 * Ochrana proti přehrání: `seq` ≤ poslední v rámci `runId` se odmítne, nový
 * `runId` jen s novějším `at`, zpráva mimo ±60 s místních hodin také.
 * Čerstvost (≤ 2 s od přijetí) hlídá vlastní časovač storu, takže výběr
 * hodnoty v komponentě nezávisí na `Date.now()` a je stabilní mezi změnami.
 */

/** Zpráva starší než tohle (místní hodiny přijetí) = cena „stojí“. */
export const TV_PRICE_STALE_MS = 2_000;
/** Okno vzorků pro zarovnání s kotvou brokera (kotva je stará nejvýš 10 s). */
export const TV_PRICE_BUFFER_MS = 30_000;
const TV_PRICE_BUFFER_MAX = 400;
/** Zpráva s časem mimo tohle okolí místních hodin se nepřijme (přehrání starého záznamu). */
export const TV_PRICE_CLOCK_WINDOW_MS = 60_000;
const RATE_WINDOW_MS = 10_000;

export interface TvPriceSample {
  /** Hodiny workeru v ms (`payload.at`). */
  at: number;
  /** Poslední obchod (`payload.last`). */
  price: number;
}

export interface TvPriceFeedView {
  /** Poslední přijatá zpráva je mladší než `TV_PRICE_STALE_MS`. */
  fresh: boolean;
  latest: TvPricePayload | null;
  /** Souvislá řada: stejný `runId`, bez mezery v `seq`, jen 1m `streaming`, vzestupně podle `at`. */
  samples: readonly TvPriceSample[];
  /** Ověřená cesta ceny k `latest` (skutečné ceny z dávky, končí `latest.last`) — jen přehrání v grafu. */
  trail: readonly number[] | null;
}

export type TvPriceLinkState = 'off' | 'connecting' | 'joined';
export type TvPriceFeedState = 'off' | 'connecting' | 'waiting' | 'live' | 'stale';

export interface TvPriceDiagnostics {
  state: TvPriceFeedState;
  /** Proč kanál neběží nebo stojí (krátký kód, nikdy téma ani klíč). */
  reason: string | null;
  received: number;
  verified: number;
  /** Neplatný podpis nebo tvar. */
  rejected: number;
  /** Přehrání (`seq`/`runId`/`at`). */
  replayed: number;
  /** Zahozeno přetížením fronty ověřování. */
  dropped: number;
  gaps: number;
  runChanges: number;
  lastReceivedAt: number | null;
  /** Přijetí − `at` poslední zprávy (obsahuje rozdíl hodin Mac ↔ zařízení). */
  lagMs: number | null;
  perSecond: number;
  seq: number | null;
  chart: string | null;
  interval: string | null;
  mode: string | null;
  front: string | null;
}

export type TvPriceAcceptResult = 'accepted' | 'replay';

export interface TvPriceStore {
  subscribe(listener: () => void): () => void;
  view(): TvPriceFeedView;
  diagnostics(): TvPriceDiagnostics;
  setLink(state: TvPriceLinkState, reason?: string | null): void;
  noteReceived(): void;
  noteRejected(): void;
  noteDropped(): void;
  accept(payload: TvPricePayload, receivedAt: number, trail?: readonly number[] | null): TvPriceAcceptResult;
  /** Změna tématu/klíče nebo odhlášení: zapomene běh, vzorky i čítače. */
  reset(reason?: string | null): void;
}

export interface TvPriceStoreDeps {
  now?: () => number;
  setTimeoutImpl?: (callback: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (timer: unknown) => void;
}

const EMPTY_SAMPLES: readonly TvPriceSample[] = Object.freeze([]);

const emptyCounters = () => ({ received: 0, verified: 0, rejected: 0, replayed: 0, dropped: 0, gaps: 0, runChanges: 0 });

export function createTvPriceStore(deps: TvPriceStoreDeps = {}): TvPriceStore {
  const now = deps.now ?? Date.now;
  const schedule = deps.setTimeoutImpl ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const cancel = deps.clearTimeoutImpl ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const listeners = new Set<() => void>();
  let link: TvPriceLinkState = 'off';
  let linkReason: string | null = 'no-grant';
  let fresh = false;
  let latest: TvPricePayload | null = null;
  let latestTrail: readonly number[] | null = null;
  let lastReceivedAt: number | null = null;
  let samples: readonly TvPriceSample[] = EMPTY_SAMPLES;
  let counters = emptyCounters();
  let acceptedAt: number[] = [];
  let staleTimer: unknown = null;
  let viewCache: TvPriceFeedView | null = null;
  let diagnosticsCache: TvPriceDiagnostics | null = null;

  /** `viewChanged: false` = jen čítače; view zůstane stejný objekt a listové
   * komponenty se nepřekreslí (zahlcení neplatnými zprávami). */
  const emit = (viewChanged = true) => {
    if (viewChanged) viewCache = null;
    diagnosticsCache = null;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // Posluchač zobrazení nesmí shodit příjem dalších zpráv.
      }
    }
  };

  const clearStaleTimer = () => {
    if (staleTimer !== null) cancel(staleTimer);
    staleTimer = null;
  };

  const forgetRun = () => {
    clearStaleTimer();
    fresh = false;
    latest = null;
    latestTrail = null;
    lastReceivedAt = null;
    samples = EMPTY_SAMPLES;
    acceptedAt = [];
  };

  const state = (): TvPriceFeedState => {
    if (link === 'off') return 'off';
    if (link === 'connecting') return 'connecting';
    if (!latest) return 'waiting';
    return fresh && latest.interval === '1' && latest.mode === 'streaming' && latest.last != null ? 'live' : 'stale';
  };

  const reason = (): string | null => {
    if (link !== 'joined') return linkReason;
    if (!latest) return 'no-message';
    if (!fresh) return 'tv-stale';
    if (latest.interval !== '1') return 'interval';
    if (latest.mode !== 'streaming') return 'mode';
    if (latest.last == null) return 'no-price';
    return null;
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    view() {
      viewCache ??= { fresh, latest, samples, trail: latestTrail };
      return viewCache;
    },
    diagnostics() {
      if (diagnosticsCache) return diagnosticsCache;
      const at = now();
      const recent = acceptedAt.filter(value => at - value <= RATE_WINDOW_MS).length;
      diagnosticsCache = {
        state: state(),
        reason: reason(),
        ...counters,
        lastReceivedAt,
        lagMs: latest && lastReceivedAt != null ? lastReceivedAt - latest.at : null,
        perSecond: Math.round((recent / (RATE_WINDOW_MS / 1_000)) * 10) / 10,
        seq: latest?.seq ?? null,
        chart: latest?.chart ?? null,
        interval: latest?.interval ?? null,
        mode: latest?.mode ?? null,
        front: latest?.front ?? null,
      };
      return diagnosticsCache;
    },
    setLink(next, nextReason = null) {
      if (link === next && linkReason === nextReason) return;
      link = next;
      linkReason = nextReason;
      if (next !== 'joined') {
        // Bez připojeného kanálu nic nepřichází — stará cena se nesmí tvářit
        // jako živá a průběh ceny během výpadku neznáme. Poslední `runId`/`seq`
        // zůstává kvůli ochraně proti přehrání po opětovném připojení.
        clearStaleTimer();
        fresh = false;
        samples = EMPTY_SAMPLES;
      }
      emit();
    },
    noteReceived() {
      counters.received += 1;
      diagnosticsCache = null;
    },
    noteRejected() {
      counters.rejected += 1;
      emit(false);
    },
    noteDropped() {
      counters.dropped += 1;
      diagnosticsCache = null;
    },
    accept(payload, receivedAt, trail = null) {
      if (Math.abs(payload.at - receivedAt) > TV_PRICE_CLOCK_WINDOW_MS) {
        counters.replayed += 1;
        emit(false);
        return 'replay';
      }
      let continuous = samples;
      if (latest && payload.runId === latest.runId) {
        if (payload.seq <= latest.seq) {
          counters.replayed += 1;
          emit(false);
          return 'replay';
        }
        if (payload.seq !== latest.seq + 1) {
          // Ztracené zprávy: průběh ceny mezi nimi neznáme, řada začíná znovu.
          counters.gaps += 1;
          continuous = EMPTY_SAMPLES;
        }
      } else if (latest) {
        // Nový běh streamu jen s novějším časem — jinak by přehraný záznam
        // cizího runId přepsal novější cenu.
        if (payload.at <= latest.at) {
          counters.replayed += 1;
          emit(false);
          return 'replay';
        }
        counters.runChanges += 1;
        continuous = EMPTY_SAMPLES;
      }
      const reliable = payload.interval === '1' && payload.mode === 'streaming' && payload.last != null;
      const lastSample = continuous[continuous.length - 1];
      if (!reliable || (lastSample && payload.at < lastSample.at)) continuous = EMPTY_SAMPLES;
      if (reliable) {
        const kept = continuous.filter(sample => sample.at >= payload.at - TV_PRICE_BUFFER_MS);
        kept.push({ at: payload.at, price: payload.last! });
        samples = kept.length > TV_PRICE_BUFFER_MAX ? kept.slice(kept.length - TV_PRICE_BUFFER_MAX) : kept;
      } else {
        samples = EMPTY_SAMPLES;
      }
      latest = payload;
      latestTrail = trail && trail.length >= 2 ? Object.freeze(trail.slice()) : null;
      lastReceivedAt = receivedAt;
      counters.verified += 1;
      acceptedAt.push(receivedAt);
      if (acceptedAt.length > 100) acceptedAt = acceptedAt.slice(-100);
      fresh = true;
      clearStaleTimer();
      staleTimer = schedule(() => {
        staleTimer = null;
        fresh = false;
        emit();
      }, TV_PRICE_STALE_MS);
      emit();
      return 'accepted';
    },
    reset(nextReason = null) {
      forgetRun();
      counters = emptyCounters();
      if (nextReason !== null) linkReason = nextReason;
      emit();
    },
  };
}
