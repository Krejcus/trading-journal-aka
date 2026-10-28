import { useEffect, useRef, useState } from 'react';
import { LIVE_CANDLES_STALE_MS, loadLiveCandles, type LiveCandles } from '../services/liveCandles';

export const LIVE_CANDLES_POLL_MS = 60_000;
/**
 * Sekunda minuty, kdy se soubor načítá: worker ho posílá 10 s po začátku minuty
 * (`TV_LIVE_BARS_PHASE_MS`), takže nese uzavřenou předchozí svíčku. Načtení
 * v náhodnou chvíli by předposlední svíčku přepsalo stavem z poloviny minuty.
 */
export const LIVE_CANDLES_POLL_PHASE_MS = 20_000;
/**
 * Načtení mimo fázi (otevření, návrat do appky) v :00–:14 vidí soubor z minulé
 * minuty, kde je předchozí svíčka ještě rozpracovaná. Hned po nahrání nového
 * souboru (:10 + rezerva na hodiny zařízení) se proto načte ještě jednou — ne až ve :20.
 */
export const LIVE_CANDLES_CATCH_UP_MS = 14_000;

/** Prodleva do doháněcího načtení po načtení mimo fázi; `null` = není potřeba. */
export function liveCandlesCatchUpDelay(nowMs: number): number | null {
  const second = nowMs % 60_000;
  return second < LIVE_CANDLES_CATCH_UP_MS ? LIVE_CANDLES_CATCH_UP_MS - second : null;
}

/** Prodleva do dalšího načtení: při minutovém intervalu zarovnaná na `LIVE_CANDLES_POLL_PHASE_MS`. */
export function nextLiveCandlesPollDelay(nowMs: number, pollMs: number): number {
  if (pollMs !== 60_000) return pollMs;
  const delay = (60_000 + LIVE_CANDLES_POLL_PHASE_MS - (nowMs % 60_000)) % 60_000;
  return delay < 5_000 ? delay + 60_000 : delay;
}

export type LiveCandlesStatus = 'loading' | 'live' | 'stale' | 'unavailable';

/**
 * Živé svíčky pro přípravu a pohled dne: načte poslední čtení workeru a
 * dokud je stránka viditelná, obnovuje ho 1×/min. `stale` = worker nebo
 * TradingView neběží (poslední čtení je starší než 3 min); `unavailable` =
 * žádné čtení zatím neexistuje. Jen zobrazení.
 */
export function useLiveCandles(symbol: string | null, options: { enabled?: boolean; pollMs?: number } = {}) {
  const enabled = options.enabled !== false && !!symbol;
  const pollMs = Math.max(15_000, options.pollMs ?? LIVE_CANDLES_POLL_MS);
  const [live, setLive] = useState<LiveCandles | null>(null);
  const [status, setStatus] = useState<LiveCandlesStatus>(enabled ? 'loading' : 'unavailable');
  const generation = useRef(0);

  useEffect(() => {
    if (!enabled || !symbol) { setLive(null); setStatus('unavailable'); return; }
    const current = ++generation.current;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let catchUpTimer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;
    // Jiný symbol: data předchozího instrumentu se nesmí ukázat ani chvíli.
    setLive(null);
    setStatus('loading');
    const refresh = async () => {
      if (inFlight || document.visibilityState === 'hidden') return;
      inFlight = true;
      try {
        const next = await loadLiveCandles(symbol);
        if (generation.current !== current) return;
        if (next) { setLive(next); setStatus(next.stale ? 'stale' : 'live'); }
        else setStatus(previous => (previous === 'loading' ? 'unavailable' : previous));
      } catch {
        if (generation.current === current) setStatus(previous => (previous === 'loading' ? 'unavailable' : previous));
      } finally {
        inFlight = false;
      }
    };
    const schedule = () => {
      timer = setTimeout(async () => { await refresh(); if (generation.current === current) schedule(); }, nextLiveCandlesPollDelay(Date.now(), pollMs));
    };
    // Načtení mimo fázi (otevření, návrat do appky): v :00–:12 ještě jedno hned po nahrání souboru.
    const refreshOffPhase = () => {
      void refresh();
      const delay = liveCandlesCatchUpDelay(Date.now());
      if (delay === null || pollMs !== 60_000) return;
      if (catchUpTimer) clearTimeout(catchUpTimer);
      catchUpTimer = setTimeout(() => { catchUpTimer = null; if (generation.current === current) void refresh(); }, delay);
    };
    const onVisible = () => { if (document.visibilityState === 'visible') refreshOffPhase(); };
    refreshOffPhase();
    schedule();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      generation.current += 1;
      if (timer) clearTimeout(timer);
      if (catchUpTimer) clearTimeout(catchUpTimer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, symbol, pollMs]);

  // Čtení, které mezi obnovami zestárne, přepne stav i bez nového stažení.
  useEffect(() => {
    if (!live || live.stale) return;
    const left = live.capturedAt + LIVE_CANDLES_STALE_MS - Date.now();
    const timer = setTimeout(() => setStatus('stale'), Math.max(0, left));
    return () => clearTimeout(timer);
  }, [live]);

  return { live, status };
}
