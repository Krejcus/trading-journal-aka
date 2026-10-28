/**
 * Předběžné 1m svíčky z TradingView Desktop pro hodnocení dnešních obchodů.
 * Databento historical je zpřístupní až ~24 h po trhu; do té doby graf
 * hodnocení kreslí svíčky, které worker přečetl z grafu TradingView po
 * uzavření obchodu. Jen pro zobrazení člověku na obrazovce (svíčky a P&L
 * zobrazené na obrazovce — rozhodnutí Filipa 26. 10. 2026); nikdy risk
 * brány, day lock, limity ztráty, kopírka ani jiná automatika (licence dat
 * TradingView je jen pro zobrazení).
 *
 * Svíčka = [čas otevření v s (UTC), open, high, low, close, volume].
 */

export type TvBar = [number, number, number, number, number, number];

export interface TvBarsCapture {
  /** Kořen kontraktu obchodu (`MNQ`, `NQ` …). */
  root: string;
  /** Epoch ms čtení (hodiny workeru). */
  at: number;
  /** Symbol grafu, ze kterého svíčky pochází (`CME_MINI:MNQ1!`, `IBKR:MNQZ2026`). */
  source: string;
  /**
   * Konkrétní kontrakt svíček (`MNQZ2026`): u IBKR přední kontrakt odběru,
   * u TV `front_contract` kontinuálního grafu; `null` = neznámý.
   */
  contract?: string | null;
  bars: TvBar[];
}

const CONTRACT_PATTERN = /^[A-Z0-9]{1,6}[FGHJKMNQUVXZ]\d{4}$/;
/** `MNQZ2026` (formát TV i kanálu ceny); cokoli jiného = `null`. */
export const normalizeBarsContract = (value: unknown): string | null =>
  typeof value === 'string' && CONTRACT_PATTERN.test(value.trim().toUpperCase()) ? value.trim().toUpperCase() : null;

/** Svíčky z IB Gateway (ne z grafu TradingView). */
export const isIbkrBarsSource = (source: string | null | undefined): boolean => !!source && source.startsWith('IBKR:');

/**
 * Svíčky prokazatelně jiného kontraktu než obchodu: kontrakt svíček je znám,
 * symbol obchodu má měsíc a rok (`MNQZ6`) a neshodují se. Neznámé = nekonflikt.
 */
export function barsContractConflicts(contract: string | null | undefined, symbol: string): boolean {
  if (!normalizeBarsContract(contract)) return false;
  if (!new RegExp(`^[A-Z0-9]+?[${MONTH_CODES}]\\d{1,2}$`).test(symbol.trim().toUpperCase())) return false;
  return !barsContractMatchesSymbol(contract, symbol);
}

/** `MNQZ2026` × `MNQZ6`/`MNQZ26`/`NQZ6` — stejný měsíc a rok expirace ve stejné cenové rodině. */
export function barsContractMatchesSymbol(contract: string | null | undefined, symbol: string): boolean {
  const normalized = normalizeBarsContract(contract);
  const front = normalized ? new RegExp(`^([A-Z0-9]+?)([${MONTH_CODES}])(\\d{4})$`).exec(normalized) : null;
  const traded = new RegExp(`^([A-Z0-9]+?)([${MONTH_CODES}])(\\d{1,2})$`).exec(symbol.trim().toUpperCase());
  if (!front || !traded) return false;
  if (tvPriceFamily(front[1]) !== tvPriceFamily(traded[1]) || front[2] !== traded[2]) return false;
  return front[3].endsWith(traded[3]);
}

// Živé svíčky dne musí sahat až za hranici Databenta (~24 h) — 27 h s rezervou
// na denní pauzu CME. Server (validace) se nasazuje před workerem.
export const TV_BARS_MAX = 1_700;
const MAX_AGE_S = 27 * 60 * 60;
const MONTH_CODES = 'FGHJKMNQUVXZ';

/** Mikro a plný kontrakt mají stejnou cenu — graf kteréhokoli z nich stačí. */
const PRICE_FAMILY: Record<string, string> = { MNQ: 'NQ', MES: 'ES', MYM: 'YM', M2K: 'RTY', MGC: 'GC', MCL: 'CL' };

/** `CME_MINI:MNQ1!` → `MNQ`, `MNQZ6` → `MNQ`, `MNQ` → `MNQ`. */
export function tvSymbolRoot(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let symbol = raw.trim().toUpperCase();
  if (symbol.includes(':')) symbol = symbol.slice(symbol.lastIndexOf(':') + 1);
  const continuous = /^([A-Z0-9]{1,6}?)\d+!$/.exec(symbol);
  if (continuous) return continuous[1];
  const dated = new RegExp(`^([A-Z0-9]{1,6}?)[${MONTH_CODES}]\\d{1,2}$`).exec(symbol);
  if (dated) return dated[1];
  return /^[A-Z0-9]{1,6}$/.test(symbol) ? symbol : null;
}

export const tvPriceFamily = (root: string) => PRICE_FAMILY[root] ?? root;

/**
 * Read-only výraz pro CDP: 1m svíčky všech grafů v okně. Nic nepřepíná,
 * nenaviguje ani nemění symbol či timeframe.
 */
export const TV_BARS_EXPRESSION = `(() => {
  try {
    const collection = window.TradingViewApi && window.TradingViewApi._chartWidgetCollection;
    if (!collection) return [];
    return collection.getAll().map(widget => {
      try {
        const series = widget.model().mainSeries();
        if (String(series.interval()) !== '1') return null;
        const bars = series.bars();
        const out = [];
        for (let i = bars.firstIndex(); i <= bars.lastIndex(); i += 1) {
          const bar = bars.valueAt(i);
          if (bar) out.push([bar[0], bar[1], bar[2], bar[3], bar[4], bar[5] || 0]);
        }
        let contract = null;
        try { const info = series.symbolInfo(); contract = info && typeof info.front_contract === 'string' ? info.front_contract : null; } catch (e) { contract = null; }
        return { symbol: series.symbol(), contract, bars: out.slice(-${TV_BARS_MAX}) };
      } catch (e) { return null; }
    }).filter(Boolean);
  } catch (e) { return []; }
})()`;

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Ponechá jen platné, seřazené, minutové svíčky; vadný řádek zahodí. */
export function sanitizeTvBars(raw: unknown, atMs: number): TvBar[] {
  if (!Array.isArray(raw)) return [];
  const atS = Math.floor(atMs / 1000);
  const out: TvBar[] = [];
  let last = -Infinity;
  for (const row of raw) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const [t, o, h, l, c] = row;
    const v = finite(row[5]) && row[5] >= 0 ? row[5] : 0;
    if (![t, o, h, l, c].every(finite)) continue;
    if (t % 60 !== 0 || t <= last || t > atS + 60 || t < atS - MAX_AGE_S) continue;
    if (!(o > 0 && l > 0 && h >= Math.max(o, c, l) && l <= Math.min(o, c))) continue;
    out.push([t, o, h, l, c, v]);
    last = t;
  }
  return out.slice(-TV_BARS_MAX);
}

/** Vybere graf se shodným kořenem (nebo cenovou rodinou) a nejvíc svíčkami. */
export function pickTvBars(readings: unknown, tradeRoot: string, atMs: number): { source: string; contract: string | null; bars: TvBar[] } | null {
  if (!Array.isArray(readings)) return null;
  const family = tvPriceFamily(tradeRoot);
  let best: { source: string; contract: string | null; bars: TvBar[]; exact: boolean } | null = null;
  for (const reading of readings) {
    const row = reading as { symbol?: unknown; contract?: unknown; bars?: unknown } | null;
    const root = tvSymbolRoot(row?.symbol);
    if (!root || tvPriceFamily(root) !== family) continue;
    const bars = sanitizeTvBars(row?.bars, atMs);
    if (!bars.length) continue;
    const exact = root === tradeRoot;
    if (!best || (exact && !best.exact) || (exact === best.exact && bars.length > best.bars.length)) {
      best = { source: String(row?.symbol), contract: normalizeBarsContract(row?.contract), bars, exact };
    }
  }
  return best ? { source: best.source, contract: best.contract, bars: best.bars } : null;
}

/** Validace na serveru: worker je autentizovaný, přesto nevěříme obsahu. */
export function validateTvBarsCapture(value: unknown, now = Date.now()): TvBarsCapture {
  const body = value as Record<string, unknown> | null;
  const root = tvSymbolRoot(body?.root);
  if (!root || root !== body?.root) throw new Error('tv-bars-invalid-root');
  const at = Number(body?.at);
  if (!Number.isFinite(at) || at > now + 5 * 60_000 || at < now - 7 * 24 * 60 * 60_000) throw new Error('tv-bars-invalid-at');
  const source = typeof body?.source === 'string' ? body.source.slice(0, 64) : '';
  if (!Array.isArray(body?.bars) || body.bars.length > TV_BARS_MAX) throw new Error('tv-bars-invalid-bars');
  const bars = sanitizeTvBars(body.bars, at);
  if (!bars.length) throw new Error('tv-bars-empty');
  return { root, at: Math.floor(at), source, contract: normalizeBarsContract(body?.contract), bars };
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** `<user>/tv-bars/<UTC den>/<kořen>-<at>.json` v soukromém bucketu snímků. */
export const tvBarsFolder = (userId: string, dayMs: number) => `${userId}/tv-bars/${utcDay(dayMs)}`;
export const tvBarsStoragePath = (userId: string, capture: Pick<TvBarsCapture, 'root' | 'at'>) =>
  `${tvBarsFolder(userId, capture.at)}/${capture.root}-${capture.at}.json`;

/**
 * Živé svíčky pro přípravu a den: jeden soubor na cenovou rodinu
 * (`<user>/tv-live/NQ.json` pro MNQ i NQ), každé čtení ho přepíše. Úložiště
 * tak zůstává omezené bez ohledu na to, jak dlouho worker běží.
 */
export const tvLiveBarsStoragePath = (userId: string, root: string) =>
  `${userId}/tv-live/${tvPriceFamily(root)}.json`;

/** `MNQ-1790798880000.json` → { root, at }. */
export function parseTvBarsFileName(name: string): { root: string; at: number } | null {
  const match = /^([A-Z0-9]{1,6})-(\d{10,16})\.json$/.exec(name);
  return match ? { root: match[1], at: Number(match[2]) } : null;
}

/**
 * Sloučí více čtení (po výstupu, později kontext po obchodu). Pozdější čtení
 * vyhrává — poslední svíčka staršího čtení mohla být ještě rozpracovaná.
 */
export function mergeTvBarCaptures(captures: readonly Pick<TvBarsCapture, 'at' | 'bars'>[]): TvBar[] {
  const byTime = new Map<number, TvBar>();
  for (const capture of [...captures].sort((a, b) => a.at - b.at)) {
    for (const bar of capture.bars) byTime.set(bar[0], bar);
  }
  return [...byTime.values()].sort((a, b) => a[0] - b[0]);
}

/**
 * Sloučení souboru živých svíček dne (`tv-live`) s novým čtením. Pravidla,
 * aby se v jedné řadě nikdy nemíchaly dva kontrakty ani přepisovaly
 * svíčky z IBKR svíčkami z grafu TV:
 * - jiný kontrakt (roll) nebo neznámý kontrakt při změně zdroje = nové čtení
 *   soubor nahradí (vědomě: při výpadku IBKR a TV bez kontraktu zmizí noc,
 *   po návratu IBKR se doplní — raději kratší řada než dva kontrakty);
 * - TV do souboru z IBKR (stejný kontrakt) jen doplní minuty, které chybí;
 * - jinak pozdější čtení vyhrává (dnešní chování TV↔TV, IBKR↔IBKR i IBKR po TV).
 */
export function mergeLiveBarsFile(
  previous: Pick<TvBarsCapture, 'at' | 'bars' | 'source' | 'contract'> | null,
  next: Pick<TvBarsCapture, 'at' | 'bars' | 'source' | 'contract'>,
): TvBar[] {
  if (!previous) return next.bars.slice(-TV_BARS_MAX);
  const previousIbkr = isIbkrBarsSource(previous.source);
  const nextIbkr = isIbkrBarsSource(next.source);
  const previousContract = normalizeBarsContract(previous.contract);
  const nextContract = normalizeBarsContract(next.contract);
  if (previousContract && nextContract && previousContract !== nextContract) return next.bars.slice(-TV_BARS_MAX);
  if (previousIbkr !== nextIbkr && (!previousContract || !nextContract)) return next.bars.slice(-TV_BARS_MAX);
  if (previousIbkr && !nextIbkr) {
    const known = new Set(previous.bars.map(bar => bar[0]));
    return [...previous.bars, ...next.bars.filter(bar => !known.has(bar[0]))].sort((a, b) => a[0] - b[0]).slice(-TV_BARS_MAX);
  }
  return mergeTvBarCaptures([previous, next]).slice(-TV_BARS_MAX);
}
