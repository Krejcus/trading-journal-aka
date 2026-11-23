// Obecné pomocníky pro importované obchody (dřív v Tradovate parseru, ten byl 23. 11. 2026 odstraněn):
// značka importu, potřeba doplnění, specifikace kontraktů a sjednocení desetinného oddělovače.

import { Trade } from '../types';

/** Tag, kterým se značí obchody přidané importem (Tradovate apod.). */
export const IMPORT_TAG = 'imported';

/** True, pokud obchod vznikl importem (a ne ručním zápisem). */
export function isImportedTrade(t: Trade): boolean {
  return !!(t.tags?.includes(IMPORT_TAG)) || t.signal === 'Tradovate Import';
}

/**
 * True, pokud importovaný obchod ještě nemá doplněný screenshot ANI konfluence
 * — tj. uživatel ho po importu zatím „neotevřel" a nevyplnil kontext.
 * Jakmile přidá aspoň screenshot nebo konfluenci, příznak zmizí (neotravuje dál).
 */
export function tradeNeedsEnrichment(t: Trade): boolean {
  if (!isImportedTrade(t)) return false;
  // Manuálně archivovaný z fronty — user řekl "víc už k tomu nemám" (bulk-tag flow).
  if (t.enrichmentSkipped) return false;
  const hasScreens = !!(t.screenshot || (t.screenshots && t.screenshots.length > 0));
  const hasConfluence = !!(
    (t.htfConfluence && t.htfConfluence.length > 0) ||
    (t.ltfConfluence && t.ltfConfluence.length > 0)
  );
  return !hasScreens && !hasConfluence;
}

/** Dolarová hodnota 1.00 bodu pohybu ceny pro běžné futures kontrakty. */
export const CONTRACT_SPECS: Record<string, { pointValue: number; tickSize: number }> = {
  // --- Akciové indexy (CME) ---
  NQ: { pointValue: 20, tickSize: 0.25 },
  MNQ: { pointValue: 2, tickSize: 0.25 },
  ES: { pointValue: 50, tickSize: 0.25 },
  MES: { pointValue: 5, tickSize: 0.25 },
  YM: { pointValue: 5, tickSize: 1 },
  MYM: { pointValue: 0.5, tickSize: 1 },
  RTY: { pointValue: 50, tickSize: 0.1 },
  M2K: { pointValue: 5, tickSize: 0.1 },
  // --- Energie (NYMEX) ---
  CL: { pointValue: 1000, tickSize: 0.01 },
  MCL: { pointValue: 100, tickSize: 0.01 },
  QM: { pointValue: 500, tickSize: 0.025 },
  NG: { pointValue: 10000, tickSize: 0.001 },
  QG: { pointValue: 2500, tickSize: 0.005 },
  // --- Kovy (COMEX) ---
  GC: { pointValue: 100, tickSize: 0.1 },
  MGC: { pointValue: 10, tickSize: 0.1 },
  SI: { pointValue: 5000, tickSize: 0.005 },
  SIL: { pointValue: 1000, tickSize: 0.005 },
  HG: { pointValue: 25000, tickSize: 0.0005 },
  PL: { pointValue: 50, tickSize: 0.1 },
  // --- Treasuries (CBOT) — pozor: kótují se v 1/32, P&L kalibruj na reálných datech ---
  ZB: { pointValue: 1000, tickSize: 1 / 32 },
  ZN: { pointValue: 1000, tickSize: 1 / 64 },
  ZF: { pointValue: 1000, tickSize: 1 / 128 },
  ZT: { pointValue: 2000, tickSize: 1 / 128 },
  // --- FX (CME) ---
  '6E': { pointValue: 125000, tickSize: 0.00005 },
  '6B': { pointValue: 62500, tickSize: 0.0001 },
  '6A': { pointValue: 100000, tickSize: 0.0001 },
  '6C': { pointValue: 100000, tickSize: 0.00005 },
  '6J': { pointValue: 12500000, tickSize: 0.0000005 },
  // --- Krypto (CME) ---
  MBT: { pointValue: 0.1, tickSize: 5 },
  MET: { pointValue: 0.1, tickSize: 0.5 },
};

/** Point value použitá, když kontrakt není v tabulce (P&L pak orientační). */
const FALLBACK_POINT_VALUE = 1;

const MONTH_CODES = 'FGHJKMNQUVXZ';

/**
 * Z plného kontraktu vytáhne root symbol.
 * Příklady: "MNQM6" → "MNQ", "ESH25" → "ES", "6EM5" → "6E", "MES" → "MES".
 */
export function parseContractRoot(contract: string): string {
  if (!contract) return '';
  let c = String(contract).trim().toUpperCase();
  c = c.replace(/^[A-Z]+:/, ''); // odstraň prefix burzy "CME:" apod.
  // root (non-greedy) + měsíční kód + rok (1-2 číslice) na konci
  const m = c.match(new RegExp(`^([A-Z0-9]+?)([${MONTH_CODES}])(\\d{1,2})$`));
  if (m) return m[1];
  return c;
}

/** Vrátí point value (USD per 1 point move) pro kontrakt. Fallback = 1 (orientační). */
export function pointValueFor(contract: string | undefined): number {
  if (!contract) return FALLBACK_POINT_VALUE;
  return specFor(contract).pointValue;
}

function specFor(contract: string): { pointValue: number; tickSize: number; known: boolean } {
  const root = parseContractRoot(contract);
  const spec = CONTRACT_SPECS[root];
  if (spec) return { ...spec, known: true };
  return { pointValue: FALLBACK_POINT_VALUE, tickSize: 0, known: false };
}

// --- Flexibilní alias resolver -------------------------------------------------
// Klíče se normalizují (lowercase, bez mezer/teček/lomítek/podtržítek) a porovnají.
const COLS = {
  side: ['bs', 'side', 'buysell', 'action', 'direction'],
  qty: ['filledqty', 'qty', 'quantity', 'size', 'filled', 'contracts', 'fillqty', 'execqty'],
  price: ['avgprice', 'price', 'fillprice', 'avg', 'averageprice', 'execprice', 'avgfillprice'],
  symbol: ['contract', 'symbol', 'instrument', 'product', 'ticker'],
  time: ['filltime', 'timestamp', 'time', 'datetime', 'executiontime', 'filledtime', 'date', 'fillts'],
  // PRO BRACKET ORDERY: čteme PLACED time (= kdy user nastavil SL/TP), NE Fill time
  // (= kdy SL/TP hit). Fill time pro stop = +X minut po vstupu → falešně vypadá
  // jako "SL přidán pozdě". Tradovate Orders export má 'Timestamp' = placed time
  // a 'Fill Time' = execution time.
  placedTime: ['timestamp', 'placedtime', 'submittedat', 'submittime', 'time'],
  orderId: ['orderid', 'order', 'id', 'lastcommandid'],
  status: ['status', 'orderstatus', 'state'],
  pnl: ['pnl', 'realizedpnl', 'netpnl', 'pl', 'plusd', 'netplusd', 'realized'],
  fees: ['commission', 'commissions', 'fees', 'fee', 'totalfees'],
  // --- pro extrakci SL/TP z bracket orderů (Orders export) ---
  type: ['type', 'ordertype'],
  limitPrice: ['limitprice'],
  stopPrice: ['stopprice'],
  notional: ['notionalvalue', 'notional'],
  text: ['text', 'tag', 'label', 'comment', 'note'],
} as const;

function norm(key: string): string {
  return String(key).trim().toLowerCase().replace(/[\s_./\-()]/g, '');
}

/** Vrátí hodnotu prvního sloupce z řádku, jehož normalizovaný název odpovídá aliasu. */
function pick(row: Record<string, any>, aliases: readonly string[]): any {
  for (const key of Object.keys(row)) {
    const n = norm(key);
    if (aliases.includes(n)) {
      const v = row[key];
      if (v !== undefined && v !== null && String(v).trim() !== '') return v;
    }
  }
  return undefined;
}

/**
 * Sjednotí desetinný oddělovač napříč locales BEZ rozbití US formátu.
 * - "1,234.56" (US) → "1234.56"   - "1.234,56" (EU) → "1234.56"
 * - "1234,56"  (EU) → "1234.56"   - "1,234" (US tis.) → "1234"
 * Pravidlo: jsou-li oba oddělovače, poslední je desetinný; je-li jen čárka,
 * bere se jako desetinná jen když ji následuje 1–2 cifry na konci (jinak tisícová).
 */
export function normalizeDecimalSeparators(s: string): string {
  const hasDot = s.includes('.');
  const hasComma = s.includes(',');
  if (hasDot && hasComma) {
    return s.lastIndexOf(',') > s.lastIndexOf('.')
      ? s.replace(/\./g, '').replace(',', '.')  // čárka je desetinná
      : s.replace(/,/g, '');                    // tečka je desetinná
  }
  if (hasComma) {
    return /^-?\d+,\d{1,2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, '');
  }
  return s;
}
