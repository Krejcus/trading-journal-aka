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
  /**
   * Poslední cena zprávy se stejnými kontrolami jako `current`, pro panel objednávky.
   * Ne `close`: ten bývá mezistav přehrání a na přelomu minuty close minulé minuty.
   */
  lastPrice(root: string): number | null;
  /** Živá svíčka předběhla data grafu: ať se data dotáhnou hned. Jen zobrazení. */
  requestData?(): void;
  /** Kontrakt poslední zprávy ceny (`MNQZ2026`), nebo `null`. */
  front?(): string | null;
  /** Zpráva ceny i data grafu jsou z téhož ověřeného kontraktu. Bez důkazu `false`. */
  contractMatchesData?(): boolean;
  /**
   * Táž svíčka z poslední přijaté zprávy BEZ přehrání ticků (2. 11. 2026). Animace grafu se při netikajícím `requestAnimationFrame`
   * (karta na pozadí) zasekne a `current` by vracel starší cenu jako čerstvou.
   */
  final?(root: string): MarketCandle | null;
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
/**
 * Pásmo s potvrzeně stejným kontraktem (`contractMatchesData`): skok je trh, ne jiný měsíc. Reference je soubor
 * svíček, starý až minutu. Při Openu 6. 11. byl rozdíl 63–97 b a pásmo 0,2 % na přelomu 15:37 zastavilo novou
 * svíčku do dalšího načtení (asi 20 s). Zůstává jen pojistka proti nesmyslné hodnotě.
 */
export const LIVE_CANDLE_MATCHED_JUMP_RATIO = 0.01;

/** Zdroj souboru `IBKR:MNQZ2026` a kontrakt zprávy `MNQZ2026`; kontinuální `CME_MINI:MNQ1!` nic nepotvrdí. */
export function contractMatchesData(front: string | null | undefined, source: string | null | undefined): boolean {
  return !!front && !!source && source.slice(source.indexOf(':') + 1) === front;
}

/** Živá cena panelu proti referenci: širší pásmo jen s potvrzeným kontraktem. */
export function livePriceWithinBand(price: number, reference: number, contractMatches: boolean): boolean {
  const ratio = contractMatches ? LIVE_CANDLE_MATCHED_JUMP_RATIO : LIVE_CANDLE_MAX_JUMP_RATIO;
  return Math.abs(price - reference) <= Math.abs(reference) * ratio;
}

/** Poslední 1m svíčka dat před minutou `time` (data grafu, nikdy živý bar). */
const previousCandle = (rawCandles: readonly MarketCandle[], time: number): MarketCandle | null => {
  for (let index = rawCandles.length - 1; index >= 0; index -= 1) {
    if (rawCandles[index].time < time) return rawCandles[index];
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
  /** Kontrakt ceny a dat je potvrzený stejný: širší pojistka. */
  widenJump?: boolean;
}): MarketCandle | null {
  const { lastBar, live, timeframe, rawCandles } = input;
  if (!lastBar || !Number.isFinite(lastBar.ts)) return null;
  const minutes = timeframeMinutes(timeframe);
  if (!Number.isFinite(minutes) || minutes < 1) return null;
  const lastTime = Math.floor(lastBar.ts / 1_000);
  const prior = previousCandle(rawCandles, live.time);
  const reference = prior?.close ?? lastBar.close ?? null;
  const jumpRatio = input.widenJump ? LIVE_CANDLE_MATCHED_JUMP_RATIO : LIVE_CANDLE_MAX_JUMP_RATIO;
  if (reference == null || !Number.isFinite(reference) || Math.abs(live.open - reference) > Math.abs(reference) * jumpRatio) return null;
  const bar = minutes === 1
    ? live
    : formingReplayBar(formingReplayBase(rawCandles, live.time - 60, timeframe), live, timeframe);
  if (bar.time < lastTime) return null;
  if (bar.time > lastTime + minutes * 60 + LIVE_CANDLE_MAX_GAP_SEC) return null;
  // Objem kanál nenese — u rozpracované 1m svíčky zůstane ten, který graf má.
  if (minutes === 1 && bar.time === lastTime) return { ...bar, volume: lastBar.volume ?? 0 };
  return bar;
}
