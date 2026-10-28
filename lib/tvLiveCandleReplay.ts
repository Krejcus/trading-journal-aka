import type { MarketCandle } from '../services/marketData';
import type { LiveCandleFeed } from './liveCandleFeed';
import { tvLiveCandle } from './tvLiveCandle';
import type { TvPriceFeedView } from './tvPriceStore';

/**
 * Přehrání skutečných ticků z dávky v živé svíčce grafu. **Jen zobrazení
 * (INV-UI-04)**: svíčka projde cenami, které se v dávce IBKR opravdu
 * zobchodovaly (`view.trail`, ověřená cesta ke zprávě), a za
 * `TV_TRAIL_REPLAY_MS` skončí přesně na baru zprávy. Žádná cena se
 * nedopočítává; P&L ani nic jiného z přehrání nečte — to bere `latest` přímo.
 *
 * Časování uvnitř dávky je rovnoměrné (IBKR dává čas obchodu jen na celé
 * sekundy), pořadí a ceny jsou skutečné.
 */

export const TV_TRAIL_REPLAY_MS = 100;
/** Po doběhnutí přehrání ještě tak dlouho dokreslit starou minutu, než přijde nová (~2 snímky). */
const FLUSH_AFTER_REPLAY_MS = 50;

/**
 * Svíčka v bodě přehrání `progress` (0–1). `before` = high/low svíčky z minulé
 * zprávy téže minuty (knot tak roste spolu s cenou); nikdy mimo bar zprávy.
 */
export function replayedLiveCandle(
  final: MarketCandle,
  trail: readonly number[],
  before: { high: number; low: number } | null,
  progress: number,
): MarketCandle {
  if (trail.length < 2 || !(progress < 1)) return final;
  const step = Math.max(0, Math.min(trail.length - 1, Math.floor(Math.max(0, progress) * (trail.length - 1) + 1e-9)));
  const shown = trail.slice(0, step + 1);
  const close = shown[shown.length - 1];
  const high = Math.min(final.high, Math.max(before?.high ?? final.open, final.open, ...shown));
  const low = Math.max(final.low, Math.min(before?.low ?? final.open, final.open, ...shown));
  return { ...final, high, low, close };
}

export interface ReplayingLiveCandleFeedDeps {
  view: () => TvPriceFeedView;
  subscribe: (listener: () => void) => () => void;
  /** Volba grafu „Přehrávat ticky“; čte se při každé nové zprávě. */
  enabled: () => boolean;
  dayEndMs: number;
  now?: () => number;
  requestFrame?: (callback: () => void) => unknown;
}

interface Replay {
  key: string;
  startedAt: number;
  trail: readonly number[];
  before: { minute: number; high: number; low: number } | null;
}

const messageKey = (view: TvPriceFeedView) => (view.latest ? `${view.latest.runId}:${view.latest.seq}` : null);

/**
 * `LiveCandleFeed` s přehráním: při nové zprávě s cestou ohlašuje změnu každý
 * snímek, dokud přehrání neskončí (vazba na graf kreslí nejvýš 1× za snímek).
 * Bez cesty, s vypnutou volbou nebo v pozadí = stejné jako bez přehrání.
 */
export function createReplayingLiveCandleFeed(deps: ReplayingLiveCandleFeedDeps): LiveCandleFeed {
  const now = deps.now ?? (() => performance.now());
  const requestFrame = deps.requestFrame ?? ((callback: () => void) => (typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame(callback)
    : setTimeout(callback, 16)));
  const listeners = new Set<() => void>();
  let unsubscribeStore: (() => void) | null = null;
  let seenKey: string | null = null;
  let previousBar: [number, number, number, number, number] | null = null;
  let replay: Replay | null = null;
  let framing = false;
  let lastView: TvPriceFeedView | null = null;
  /** Kdy přehrání naposled doběhlo — vazba grafu kreslí až snímek po našem ohlášení. */
  let replayEndedAt = -Infinity;
  /**
   * Přelom minuty během přehrání: stará minuta se musí nakreslit ještě celá
   * (bar zprávy), než graf přejde na novou — jinak by v ní zůstal mezistav.
   * Dva snímky: vazba grafu kreslí ve svém snímku, který může běžet až po našem.
   */
  let flush: { view: TvPriceFeedView; frames: number; next: Omit<Replay, 'startedAt'> | null } | null = null;

  const notify = () => {
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* posluchač grafu nesmí shodit ostatní */ }
    }
  };

  const schedule = () => {
    if (!framing) { framing = true; requestFrame(frame); }
  };

  function frame() {
    framing = false;
    if (!listeners.size) return;
    if (flush) {
      flush.frames -= 1;
      if (flush.frames > 0) { schedule(); return; }
      replay = flush.next ? { ...flush.next, startedAt: now() } : null;
      flush = null;
      notify();
      if (replay) schedule();
      return;
    }
    if (!replay) return;
    notify();
    if (now() - replay.startedAt < TV_TRAIL_REPLAY_MS) schedule();
    else { replay = null; replayEndedAt = now(); }
  }

  const onStore = () => {
    const view = deps.view();
    const key = messageKey(view);
    if (key !== seenKey) {
      seenKey = key;
      const bar = view.latest?.bar ?? null;
      let enabled = false;
      try { enabled = deps.enabled(); } catch { enabled = false; }
      const next = enabled && key && view.trail && view.trail.length >= 2 && bar
        ? {
          key,
          trail: view.trail,
          before: previousBar && previousBar[0] === bar[0] ? { minute: bar[0], high: previousBar[2], low: previousBar[3] } : null,
        }
        : null;
      // Rozpracované = přehrání běží, nebo doběhlo tak nedávno, že ho graf ještě nemusel nakreslit celé.
      const unfinished = replay !== null || now() - replayEndedAt < FLUSH_AFTER_REPLAY_MS;
      const previousMinute = previousBar?.[0];
      if (flush) {
        // Další zpráva během dokreslení: stará minuta se dokreslí stejně, přehraje se jen nejnovější.
        flush.next = next;
      } else if (unfinished && lastView && previousMinute !== undefined && previousMinute !== bar?.[0]) {
        // Starou minutu dokreslit celou, novou (i její přehrání) až potom.
        flush = { view: lastView, frames: 2, next };
        replay = null;
      } else {
        flush = null;
        replay = next ? { ...next, startedAt: now() } : null;
      }
      previousBar = bar;
    }
    lastView = view;
    notify();
    if (replay || flush) schedule();
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (!unsubscribeStore) {
        // Výchozí stav: aktuální zprávu nepřehrávat, jen si pamatovat její bar (knot další zprávy).
        const view = deps.view();
        seenKey = messageKey(view);
        previousBar = view.latest?.bar ?? null;
        lastView = view;
        unsubscribeStore = deps.subscribe(onStore);
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size && unsubscribeStore) {
          unsubscribeStore();
          unsubscribeStore = null;
          replay = null;
          flush = null;
        }
      };
    },
    current(root) {
      if (flush) {
        // Jen dokud kanál žije a běh je stejný — výpadek ceny vrací graf přesně na data (INV-UI-01).
        const live = deps.view();
        if (!live.fresh || !live.latest || live.latest.runId !== flush.view.latest?.runId) return null;
        return tvLiveCandle(flush.view, root, deps.dayEndMs);
      }
      const view = deps.view();
      const final = tvLiveCandle(view, root, deps.dayEndMs);
      const active = replay;
      if (!final || !active || active.key !== messageKey(view)) return final;
      const before = active.before && active.before.minute === final.time ? active.before : null;
      return replayedLiveCandle(final, active.trail, before, (now() - active.startedAt) / TV_TRAIL_REPLAY_MS);
    },
  };
}
