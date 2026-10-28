import { formingReplayBar, formingReplayBase } from '../services/chartReplayForming';
import { timeframeMinutes, type MarketCandle, type MarketTimeframe } from '../services/marketData';

/**
 * Zdroj rozpracované (živé) 1m svíčky pro grafy — jen zobrazení. Graf o
 * původu dat nic neví: dostane jen tohle rozhraní (dnes z kanálu ceny
 * TradingView, `hooks/useTvLiveCandleFeed.ts`). Svíčka se jen překreslí
 * v grafu (`updateBar`) a nikam neukládá.
 */
export interface LiveCandleFeed {
  subscribe(listener: () => void): () => void;
  /** Rozpracovaná 1m svíčka pro kořen panelu, nebo `null` (stojí, jiný trh, mimo den). */
  current(root: string): MarketCandle | null;
}

/**
 * Nová svíčka se smí připsat jen těsně za poslední svíčku grafu — větší
 * mezeru (soubor živých svíček se zpozdil, graf ukazuje starší data) dorovná
 * až další obnovení dat; do té doby se nic nekreslí.
 */
export const LIVE_CANDLE_MAX_GAP_SEC = 180;

/**
 * Otevření rozpracované minuty smí být od posledního dokončeného close
 * v datech grafu nejvýš tolik (podíl ceny, ~58 b u NQ). Větší skok = jiný
 * kontrakt (rollover, jiný 1m panel v TradingView) — nic se nekreslí.
 */
export const LIVE_CANDLE_MAX_JUMP_RATIO = 0.002;

/** Close poslední 1m svíčky dat před minutou `time` (data grafu, nikdy živý bar). */
const previousClose = (rawCandles: readonly MarketCandle[], time: number): number | null => {
  for (let index = rawCandles.length - 1; index >= 0; index -= 1) {
    if (rawCandles[index].time < time) return rawCandles[index].close;
  }
  return null;
};

/**
 * Co překreslit v grafu: rozpracovaná minuta na 1m, na vyšším timeframu bar,
 * do kterého patří (stejná agregace jako zbytek grafu). `null` = nic — graf
 * je prázdný, svíčka je starší než poslední bar, je od něj moc daleko, nebo
 * cenou nenavazuje na data grafu (jiný kontrakt).
 */
export function planLiveCandleUpdate(input: {
  lastBar: { ts: number; close?: number; volume?: number } | undefined;
  live: MarketCandle;
  timeframe: MarketTimeframe;
  rawCandles: readonly MarketCandle[];
}): MarketCandle | null {
  const { lastBar, live, timeframe, rawCandles } = input;
  if (!lastBar || !Number.isFinite(lastBar.ts)) return null;
  const minutes = timeframeMinutes(timeframe);
  if (!Number.isFinite(minutes) || minutes < 1) return null;
  const lastTime = Math.floor(lastBar.ts / 1_000);
  const reference = previousClose(rawCandles, live.time) ?? lastBar.close ?? null;
  if (reference == null || !Number.isFinite(reference) || Math.abs(live.open - reference) > Math.abs(reference) * LIVE_CANDLE_MAX_JUMP_RATIO) return null;
  const bar = minutes === 1
    ? live
    : formingReplayBar(formingReplayBase(rawCandles, live.time - 60, timeframe), live, timeframe);
  if (bar.time < lastTime) return null;
  if (bar.time > lastTime + minutes * 60 + LIVE_CANDLE_MAX_GAP_SEC) return null;
  // Objem kanál nenese — u rozpracované 1m svíčky zůstane ten, který graf má.
  if (minutes === 1 && bar.time === lastTime) return { ...bar, volume: lastBar.volume ?? 0 };
  return bar;
}
