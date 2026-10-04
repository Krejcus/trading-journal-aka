import type { OutcomeCandle } from './entryOrderOutcome.js';

/**
 * Pohyb ceny kolem rozhodnutí z 1m svíček: jak daleko šla cena pro (MFE)
 * a proti (MAE) během obchodu, kam došla po výstupu a jestli by po výstupu
 * dosáhla plánovaného TP dřív než SL („kdybys držel“).
 *
 * Svíčka vstupu i výstupu se počítá celá — přesnost je ±1 minuta (uvnitř
 * minuty nevíme, co bylo před vstupem a co po něm). Body jsou vždy ve směru
 * obchodu: kladné = pro tebe.
 */
export interface LabExcursion {
  /** Nejlepší cena během obchodu (body pro tebe, ≥ 0). */
  mfePoints: number;
  /** Nejhorší cena během obchodu (body proti tobě, ≥ 0). */
  maePoints: number;
  /** Nejlepší cena do `afterMinutes` po výstupu, měřeno od ceny výstupu. */
  afterExitPoints: number | null;
  /** Kdyby obchod zůstal otevřený s plánovaným SL/TP: co padne dřív po výstupu.
   *  `null` = nelze (chybí SL/TP nebo svíčky) nebo nedává smysl (výstup na původním SL). */
  heldOutcome: 'tp' | 'sl' | 'ambiguous' | 'neither' | null;
  /** Kolik svíček obchod pokryl — 0 = svíčky chybí, výsledek nepoužívat. */
  candles: number;
}

export interface LabExcursionInput {
  long: boolean;
  entryAt: number;
  exitAt: number;
  entryPrice: number;
  exitPrice: number | null;
  sl: number | null;
  tp: number | null;
  /** Jak dlouho po výstupu měřit, kam došla cena (minuty, výchozí 60). */
  afterMinutes?: number;
  /** Jak dlouho hledat SL/TP pro „kdybys držel“ (minuty, výchozí 6 h jako u nevzatých). */
  heldMinutes?: number;
}

const minuteStart = (ms: number) => Math.floor(ms / 60_000) * 60;
/** Tick NQ/MNQ — výstup do 1 ticku od SL je výstup na SL. */
const STOP_TOLERANCE = 0.25;

export function labExcursion(input: LabExcursionInput, candles: readonly OutcomeCandle[]): LabExcursion {
  const after = input.afterMinutes ?? 60;
  const from = minuteStart(input.entryAt), to = minuteStart(input.exitAt);
  const sorted = [...candles].sort((a, b) => a.time - b.time);
  const during = sorted.filter(candle => candle.time >= from && candle.time <= to);
  const favor = (price: number) => (input.long ? price - input.entryPrice : input.entryPrice - price);
  let mfe = 0, mae = 0;
  for (const candle of during) {
    mfe = Math.max(mfe, favor(input.long ? candle.high : candle.low));
    mae = Math.max(mae, -favor(input.long ? candle.low : candle.high));
  }
  // Svíčka vstupu nese i pohyb před vstupem: dokud stál SL (TP), cena za něj
  // jít nemohla — jinak by obchod skončil. Strop = SL/TP, nebo skutečný
  // výstup, když uklouzl dál.
  const exitFavor = input.exitPrice != null ? favor(input.exitPrice) : null;
  if (input.sl != null) mae = Math.min(mae, Math.max(-favor(input.sl), exitFavor != null ? -exitFavor : 0));
  if (input.tp != null) mfe = Math.min(mfe, Math.max(favor(input.tp), exitFavor ?? 0));
  // Po výstupu: od další minuty, ať se nepočítá znovu svíčka výstupu.
  const post = sorted.filter(candle => candle.time > to && candle.time <= to + after * 60);
  let afterExitPoints: number | null = null;
  if (input.exitPrice != null && post.length) {
    const base = input.exitPrice;
    afterExitPoints = Math.max(0, ...post.map(candle => input.long ? candle.high - base : base - candle.low));
  }
  let heldOutcome: LabExcursion['heldOutcome'] = null;
  // Výstup na původním SL (nebo za ním) není Filipovo rozhodnutí — „kdybys
  // držel“ dává smysl jen u ručního výstupu a posunutého SL.
  const stoppedOut = input.sl != null && exitFavor != null && exitFavor <= favor(input.sl) + STOP_TOLERANCE;
  const held = sorted.filter(candle => candle.time > to && candle.time <= to + (input.heldMinutes ?? 360) * 60);
  if (input.sl != null && input.tp != null && held.length && !stoppedOut) {
    heldOutcome = 'neither';
    for (const candle of held) {
      const hitTp = input.long ? candle.high >= input.tp : candle.low <= input.tp;
      const hitSl = input.long ? candle.low <= input.sl : candle.high >= input.sl;
      if (hitTp && hitSl) { heldOutcome = 'ambiguous'; break; }
      if (hitTp) { heldOutcome = 'tp'; break; }
      if (hitSl) { heldOutcome = 'sl'; break; }
    }
  }
  return { mfePoints: mfe, maePoints: mae, afterExitPoints, heldOutcome, candles: during.length };
}
