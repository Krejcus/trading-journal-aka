// ============================================================================
// Tradovate import parser
// ----------------------------------------------------------------------------
// Tradovate (a tím i prop firmy Apex / Tradeify / Lucid) exportuje JEDNOTLIVÉ
// fills/ordery — NE hotové round-trip obchody. Tenhle modul:
//   1. rozpozná Tradovate export podle sloupců (flexibilní alias resolver),
//   2. spáruje fills do obchodů metodou flat→flat position accounting
//      (zvládá i partial fills a flip přes nulu),
//   3. dopočítá GROSS P&L podle point value kontraktu.
//
// POZN. KE KALIBRACI (až přijde reálný export):
//   - Pokud Tradovate použije jiné názvy sloupců, stačí přidat alias do COLS.
//   - Pokud obchoduješ kontrakt, který není v CONTRACT_SPECS, přidej ho tam
//     (jinak se P&L spočítá s fallback point value a obchod se označí v notes).
//   - Orders export NEobsahuje komise — P&L je proto GROSS. Pokud export má
//     sloupec s fees/commission, automaticky se odečte (čistý P&L).
// ============================================================================

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

function num(v: any): number {
  if (v === undefined || v === null) return NaN;
  if (typeof v === 'number') return v;
  let s = String(v).trim().replace(/[$,\s]/g, '');
  if (s.startsWith('(') && s.endsWith(')')) s = '-' + s.replace(/[()]/g, ''); // (123) → -123
  return parseFloat(s);
}

/** Rozpozná, jestli řádky vypadají jako Tradovate fills/orders export. */
export function isTradovateFills(rows: any[]): boolean {
  if (!Array.isArray(rows) || rows.length === 0) return false;
  const sample = rows.find(r => r && typeof r === 'object');
  if (!sample) return false;

  // TradingView/strategy-tester round-trip export má "Trade #" + Type Entry/Exit —
  // ten řeší normalizeTrades, sem nepatří.
  const hasTradeNumber = Object.keys(sample).some(k => ['trade#', 'tradeid', 'ticket'].includes(norm(k)));
  if (hasTradeNumber) return false;

  // Cash History není fills export — řeší applyCashHistory.
  if (isCashHistory(rows)) return false;

  // Sloupce mají hlavičku, ale hodnoty jsou často prázdné (canceled bracket řádky).
  // Detekuj podle EXISTENCE sloupců v hlavičce, ne podle hodnot v prvním řádku.
  const keys = Object.keys(sample).map(norm);
  const hasCol = (aliases: readonly string[]) => keys.some(k => aliases.includes(k));
  const hasSide = hasCol(COLS.side);
  const hasSymbol = hasCol(COLS.symbol);
  const hasPrice = hasCol(COLS.price);
  const hasQty = hasCol(COLS.qty);
  return hasSide && hasSymbol && hasPrice && hasQty;
}

function isBuy(sideRaw: any): boolean | null {
  const s = String(sideRaw).trim().toLowerCase();
  if (s === 'buy' || s === 'b' || s === '1' || s === 'bot' || s === 'long') return true;
  if (s === 'sell' || s === 's' || s === '-1' || s === 'sld' || s === 'short') return false;
  return null;
}

function isFilledStatus(statusRaw: any): boolean {
  if (statusRaw === undefined) return true; // sloupec chybí → ber jako fill
  const s = String(statusRaw).trim().toLowerCase();
  // skip jen jednoznačně neprovedené
  if (s.includes('cancel') || s.includes('reject') || s.includes('expired') || s.includes('pending') || s.includes('working')) return false;
  return true;
}

interface ParsedFill {
  buy: boolean;
  qty: number;
  price: number;
  time: number;
  contract: string;
  orderId: string;
  fees: number;
  pnl?: number;      // pokud export má realizovaný P&L
  notional?: number; // Notional Value — pro odvození point value
  text?: string;     // Text (multibracket / Chart / AutoLiq …)
}

/**
 * Bracket order (Stop = SL, Limit = TP) z Orders exportu — sbírá se i ze
 * zrušených/vyplněných řádků, protože cena plánovaného SL/TP tam zůstává.
 */
interface BracketOrder {
  contract: string;
  buy: boolean;            // strana orderu (opačná než vstup u bracketu)
  type: 'stop' | 'limit';  // stop = SL, limit = TP
  price: number;
  time: number;
}

/** Z Type sloupce rozpozná, jestli jde o stop/limit bracket leg. */
function bracketType(typeRaw: any): 'stop' | 'limit' | null {
  if (typeRaw === undefined || typeRaw === null) return null;
  const s = String(typeRaw).trim().toLowerCase();
  if (s.includes('stop')) return 'stop';   // Stop, StopLimit → SL
  if (s.includes('limit')) return 'limit'; // Limit → TP
  return null; // Market apod.
}

/** Odvodí point value z Notional Value: notional / (cena × qty), se snapem na „hezkou" hodnotu. */
function pointValueFromNotional(notional: number, price: number, qty: number): number | null {
  if (!notional || !price || !qty) return null;
  const raw = Math.abs(notional) / (Math.abs(price) * Math.abs(qty));
  if (!isFinite(raw) || raw <= 0) return null;
  const rounded = Math.round(raw);
  // snap na celé číslo, pokud je raw blízko (řeší float šum: 19.9998 → 20)
  if (rounded > 0 && Math.abs(raw - rounded) < 0.01 * raw) return rounded;
  return Math.round(raw * 100) / 100; // jinak na 2 desetinná (0.5, 0.1 …)
}

/** Detail jednoho přeskočeného řádku — pro kontrolu, že nešlo o nic důležitého. */
export interface SkippedRow {
  contract: string;
  side: string;
  qty: string;
  status: string;
  time: string;
  reason: string;
}

export interface TradovateImportResult {
  trades: Trade[];
  summary: {
    totalFills: number;
    skippedFills: number;
    pairedTrades: number;
    openPositions: number;        // kolik kontraktů zůstalo neuzavřených (nedopárováno)
    totalPnL: number;
    unknownContracts: string[];   // kontrakty bez point value v tabulce
    usedExportPnL: boolean;       // true = P&L vzat přímo z exportu, ne dopočítán
    skippedRows: SkippedRow[];    // co a proč se přeskočilo
    withSLTP: number;             // kolik obchodů má vytažený SL nebo TP z bracketů
    autoLiqCount: number;         // kolik obchodů skončilo nucenou likvidací (AutoLiq)
    feesApplied: boolean;         // true = poplatky odečteny (z Cash History nebo z uložených sazeb)
    feesEstimated: boolean;       // true = poplatky dopočítané z ULOŽENÝCH sazeb (ne z Cash History)
    totalFees: number;            // součet poplatků, kladné číslo
    feeRates?: FeeRates;          // odvozené sazby poplatku za stranu (per root) — k uložení pro účet
  };
}

/** Sazba poplatku za 1 stranu (1 kontrakt) podle root symbolu, např. { NQ: 2.88, MNQ: 0.95 }. */
export type FeeRates = Record<string, number>;

/**
 * Hlavní funkce: fills → round-trip obchody (flat→flat) s dopočtem P&L.
 */
export function parseTradovateFills(rows: any[], accountId: string): TradovateImportResult {
  const unknownContracts = new Set<string>();
  let skipped = 0;
  const skippedRows: SkippedRow[] = [];

  const recordSkip = (r: any, reason: string) => {
    skipped++;
    const rec = (r && typeof r === 'object') ? r : {};
    skippedRows.push({
      contract: String(pick(rec, COLS.symbol) ?? '—').trim() || '—',
      side: String(pick(rec, COLS.side) ?? '—').trim() || '—',
      qty: String(pick(rec, COLS.qty) ?? '—').trim() || '—',
      status: String(pick(rec, COLS.status) ?? '—').trim() || '—',
      time: String(pick(rec, COLS.time) ?? '—').trim() || '—',
      reason,
    });
  };

  // 0) Sběr bracket orderů (SL=Stop / TP=Limit) ze VŠECH řádků — i zrušených,
  //    protože plánovaná cena SL/TP v nich zůstává (OCO zruší protistranu).
  const bracketsByContract = new Map<string, BracketOrder[]>();
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const bt = bracketType(pick(r, COLS.type));
    if (!bt) continue;
    const buy = isBuy(pick(r, COLS.side));
    if (buy === null) continue;
    const contract = String(pick(r, COLS.symbol) ?? '').trim();
    if (!contract) continue;
    const priceRaw = bt === 'stop' ? num(pick(r, COLS.stopPrice)) : num(pick(r, COLS.limitPrice));
    if (isNaN(priceRaw)) continue;
    const timeRaw = pick(r, COLS.time);
    const t = timeRaw !== undefined ? new Date(timeRaw).getTime() : NaN;
    if (isNaN(t)) continue;
    if (!bracketsByContract.has(contract)) bracketsByContract.set(contract, []);
    bracketsByContract.get(contract)!.push({ contract, buy, type: bt, price: priceRaw, time: t });
  }

  // 1) Parse + filtr na reálné fills
  const fills: ParsedFill[] = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') { recordSkip(r, 'prázdný/neplatný řádek'); continue; }
    if (!isFilledStatus(pick(r, COLS.status))) { recordSkip(r, 'order neproveden (cancel/reject/expired/pending)'); continue; }

    const buy = isBuy(pick(r, COLS.side));
    const qty = Math.abs(num(pick(r, COLS.qty)));
    const price = num(pick(r, COLS.price));
    const contract = String(pick(r, COLS.symbol) ?? '').trim();
    const timeRaw = pick(r, COLS.time);
    const t = timeRaw !== undefined ? new Date(timeRaw).getTime() : NaN;

    if (buy === null || !qty || isNaN(price) || !contract || isNaN(t)) {
      const missing: string[] = [];
      if (buy === null) missing.push('směr');
      if (!qty) missing.push('množství');
      if (isNaN(price)) missing.push('cena');
      if (!contract) missing.push('kontrakt');
      if (isNaN(t)) missing.push('čas');
      recordSkip(r, `chybí/nečitelné: ${missing.join(', ')}`);
      continue;
    }

    const feesVal = num(pick(r, COLS.fees));
    const pnlVal = num(pick(r, COLS.pnl));
    const notionalVal = num(pick(r, COLS.notional));
    fills.push({
      buy, qty, price, time: t, contract,
      orderId: String(pick(r, COLS.orderId) ?? ''),
      fees: isNaN(feesVal) ? 0 : Math.abs(feesVal),
      pnl: isNaN(pnlVal) ? undefined : pnlVal,
      notional: isNaN(notionalVal) ? undefined : notionalVal,
      text: String(pick(r, COLS.text) ?? '').trim() || undefined,
    });
  }

  // 2) Seskup podle kontraktu, seřaď chronologicky
  const byContract = new Map<string, ParsedFill[]>();
  for (const f of fills) {
    if (!byContract.has(f.contract)) byContract.set(f.contract, []);
    byContract.get(f.contract)!.push(f);
  }

  const trades: Trade[] = [];
  let openPositions = 0;
  let totalPnL = 0;
  let usedExportPnL = false;
  let withSLTP = 0;
  let autoLiqCount = 0;

  for (const [contract, list] of byContract) {
    list.sort((a, b) => a.time - b.time);
    const spec = specFor(contract);
    // Point value primárně z Notional Value (přesné, per kontrakt), jinak z tabulky.
    const fillWithNotional = list.find(f => f.notional !== undefined);
    const pvFromNotional = fillWithNotional
      ? pointValueFromNotional(fillWithNotional.notional!, fillWithNotional.price, fillWithNotional.qty)
      : null;
    const pointValue = pvFromNotional ?? spec.pointValue;
    const known = spec.known || pvFromNotional !== null;
    if (!known) unknownContracts.add(contract);
    const contractBrackets = bracketsByContract.get(contract) || [];

    let pos = 0;            // signed position (+long / -short)
    let acc: null | {
      dirSign: 1 | -1;
      entryQty: number; entryNotional: number;
      exitQty: number; exitNotional: number;
      firstTime: number; lastTime: number;
      fees: number; exportPnL: number; hasExportPnL: boolean;
      orderIds: Set<string>;
      autoLiq: boolean;
    } = null;

    const finalize = () => {
      if (!acc) return;
      const entryVWAP = acc.entryNotional / acc.entryQty;
      const exitVWAP = acc.exitNotional / acc.exitQty;
      const qty = acc.entryQty;
      const grossPnL = acc.dirSign * (exitVWAP - entryVWAP) * qty * pointValue;
      const computedPnL = grossPnL - acc.fees;
      const pnl = acc.hasExportPnL ? acc.exportPnL : computedPnL;
      if (acc.hasExportPnL) usedExportPnL = true;
      totalPnL += pnl;

      const root = parseContractRoot(contract);
      const durMin = Math.max(0, Math.round((acc.lastTime - acc.firstTime) / 60000));
      const notesParts: string[] = ['Import z Tradovate'];
      if (!known) notesParts.push(`⚠️ neznámý kontrakt "${contract}" — P&L orientační, nastav point value`);

      // --- SL/TP z bracket orderů ---------------------------------------------
      // Bracket leg má OPAČNOU stranu než vstup (long → exit Sell, short → exit Buy)
      // a je položen v časovém okně obchodu. Z více kandidátů ber ten nejblíž vstupu.
      const exitBuy = acc.dirSign === 1 ? false : true;
      const lo = acc.firstTime - 2000;
      const hi = acc.lastTime + 2000;
      const cands = contractBrackets.filter(b => b.buy === exitBuy && b.time >= lo && b.time <= hi);
      const nearestEntry = (a: BracketOrder, b: BracketOrder) =>
        Math.abs(a.time - acc!.firstTime) - Math.abs(b.time - acc!.firstTime);
      const stopCand = cands.filter(b => b.type === 'stop').sort(nearestEntry)[0];
      const limitCand = cands.filter(b => b.type === 'limit').sort(nearestEntry)[0];
      const stopLoss = stopCand?.price;
      const takeProfit = limitCand?.price;
      if (stopLoss !== undefined || takeProfit !== undefined) withSLTP++;

      // riskAmount → pohání RR zobrazení (pnl / riskAmount)
      const riskAmount = stopLoss !== undefined
        ? Math.abs(entryVWAP - stopLoss) * qty * pointValue
        : undefined;
      const targetAmount = takeProfit !== undefined
        ? Math.abs(takeProfit - entryVWAP) * qty * pointValue
        : undefined;

      // „Urval X % cíle" — když máme TP i skutečný exit (např. ruční Exit All před TP)
      if (takeProfit !== undefined && pnl > 0) {
        const plannedMove = Math.abs(takeProfit - entryVWAP);
        const realizedMove = Math.abs(exitVWAP - entryVWAP);
        if (plannedMove > 0) {
          const pct = Math.round((realizedMove / plannedMove) * 100);
          if (pct < 98) notesParts.push(`📊 urval ${pct} % cíle (exit před TP)`);
        }
      }

      const tags = [IMPORT_TAG];
      if (acc.autoLiq) { autoLiqCount++; tags.push('autoliq'); notesParts.push('⚠️ Nucená likvidace (AutoLiq)'); }

      trades.push({
        id: `tradovate-${contract}-${acc.firstTime}-${acc.lastTime}`,
        accountId,
        instrument: root || contract,
        symbol: contract,
        signal: 'Tradovate Import',
        pnl,
        riskAmount,
        targetAmount,
        runUp: 0,
        drawdown: 0,
        date: new Date(acc.lastTime).toISOString(),
        time: new Date(acc.lastTime).toTimeString().slice(0, 5),
        timestamp: acc.lastTime,
        entryTime: acc.firstTime,
        entryDate: new Date(acc.firstTime).toISOString(),
        durationMinutes: durMin,
        duration: durMin >= 60 ? `${Math.floor(durMin / 60)}h ${durMin % 60}m` : `${durMin}m`,
        direction: acc.dirSign === 1 ? 'Long' : 'Short',
        outcome: pnl > 0 ? 'Win' : pnl < 0 ? 'Loss' : 'BE',
        entryPrice: entryVWAP,
        exitPrice: exitVWAP,
        stopLoss,
        takeProfit,
        positionSize: qty,
        isValid: true,
        executionStatus: 'Valid',
        tags,
        notes: notesParts.join(' · '),
      });
      acc = null;
    };

    for (const f of list) {
      let remaining = f.qty;
      const fillSign = f.buy ? 1 : -1;

      while (remaining > 0) {
        if (pos === 0 && !acc) {
          // otevři nový obchod
          acc = {
            dirSign: fillSign === 1 ? 1 : -1,
            entryQty: 0, entryNotional: 0, exitQty: 0, exitNotional: 0,
            firstTime: f.time, lastTime: f.time,
            fees: 0, exportPnL: 0, hasExportPnL: false,
            orderIds: new Set(),
            autoLiq: false,
          };
        }
        if (!acc) break; // pojistka

        acc.lastTime = f.time;
        if (f.orderId) acc.orderIds.add(f.orderId);
        if (f.pnl !== undefined) { acc.hasExportPnL = true; acc.exportPnL += f.pnl; }
        if (f.text && /autoliq|liquidat/i.test(f.text)) acc.autoLiq = true;

        const adding = fillSign === acc.dirSign;
        if (adding) {
          // přidání do pozice — nikdy nekříží nulu
          acc.entryQty += remaining;
          acc.entryNotional += remaining * f.price;
          acc.fees += apportionFees(f, remaining);
          pos += fillSign * remaining;
          remaining = 0;
        } else {
          // ubírání/zavírání pozice
          const reduce = Math.min(remaining, Math.abs(pos));
          acc.exitQty += reduce;
          acc.exitNotional += reduce * f.price;
          acc.fees += apportionFees(f, reduce);
          pos += fillSign * reduce;
          remaining -= reduce;
          if (pos === 0) finalize();
        }
      }
    }

    if (pos !== 0) openPositions += Math.abs(pos); // neuzavřená pozice (chybí protistrana ve fillech)
    acc = null;
  }

  trades.sort((a, b) => a.timestamp - b.timestamp);

  return {
    trades,
    summary: {
      totalFills: fills.length,
      skippedFills: skipped,
      pairedTrades: trades.length,
      openPositions,
      totalPnL,
      unknownContracts: Array.from(unknownContracts),
      usedExportPnL,
      skippedRows,
      withSLTP,
      autoLiqCount,
      feesApplied: false,
      feesEstimated: false,
      totalFees: 0,
    },
  };
}

// ============================================================================
// Cash History merge — přesné poplatky + realizovaný P&L (Trade Paired)
// ----------------------------------------------------------------------------
// Cash History report (Account reports → Cash history) obsahuje řádky typu
// Exchange/Clearing/Nfa Fee + Commission (poplatky) a Trade Paired (přesné P&L
// na spárovaný kontrakt). Tady je napárujeme na obchody přes Contract + čas,
// aby P&L v deníku sedělo s Tradovate na cent (gross → net).
// ============================================================================

const CASH_COLS = {
  type: ['cashchangetype', 'changetype', 'type', 'transactiontype'],
  delta: ['delta', 'amount', 'change'],
  time: ['timestamp', 'time', 'date', 'datetime'],
  contract: ['contract', 'symbol', 'instrument'],
} as const;

/** Rozpozná Cash History export (má sloupec Cash Change Type). */
export function isCashHistory(rows: any[]): boolean {
  if (!Array.isArray(rows) || rows.length === 0) return false;
  const sample = rows[0];
  if (!sample || typeof sample !== 'object') return false;
  return Object.keys(sample).some(k => ['cashchangetype', 'changetype'].includes(norm(k)));
}

interface CashRow { kind: 'fee' | 'paired' | 'other'; contract: string; time: number; delta: number; }

function parseCashRows(rows: any[]): CashRow[] {
  const out: CashRow[] = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const typeRaw = String(pick(r, CASH_COLS.type) ?? '').trim().toLowerCase();
    const delta = num(pick(r, CASH_COLS.delta));
    if (isNaN(delta)) continue;
    const contract = String(pick(r, CASH_COLS.contract) ?? '').trim();
    const timeRaw = pick(r, CASH_COLS.time);
    const time = timeRaw !== undefined ? new Date(timeRaw).getTime() : NaN;
    if (isNaN(time)) continue;
    let kind: CashRow['kind'] = 'other';
    if (/fee|commission/.test(typeRaw)) kind = 'fee';
    else if (/paired/.test(typeRaw)) kind = 'paired';
    out.push({ kind, contract, time, delta });
  }
  return out;
}

/**
 * Dopáruje poplatky + Trade Paired P&L z Cash History na již spárované obchody.
 * Vrací NOVÉ pole obchodů (net P&L) + souhrn. Matchuje přes Contract + časové okno
 * obchodu [entryTime, timestamp]. Trade Paired (přesné gross P&L) má přednost před
 * dopočtem z ceny; poplatky se vždy odečtou.
 */
export function applyCashHistory(
  result: TradovateImportResult,
  cashRows: any[],
): TradovateImportResult {
  const cash = parseCashRows(cashRows);
  if (cash.length === 0) return result;

  const SLACK = 1500; // ms tolerance kolem hranic okna
  let totalFees = 0;
  let totalPnL = 0;
  // Akumulace pro odvození sazby za stranu (per root): suma poplatků / suma stran.
  const rateAccum = new Map<string, { fees: number; sides: number }>();

  const trades = result.trades.map(t => {
    const contract = t.symbol || t.instrument || '';
    const entryT = t.entryTime ?? t.timestamp;
    const exitT = t.timestamp;
    const lo = Math.min(entryT, exitT) - SLACK;
    const hi = Math.max(entryT, exitT) + SLACK;

    const inWindow = cash.filter(c =>
      c.contract === contract && c.time >= lo && c.time <= hi
    );
    const fees = inWindow.filter(c => c.kind === 'fee').reduce((s, c) => s + Math.abs(c.delta), 0);
    const pairedRows = inWindow.filter(c => c.kind === 'paired');
    const pairedPnL = pairedRows.reduce((s, c) => s + c.delta, 0);

    const gross = pairedRows.length > 0 ? pairedPnL : t.pnl;
    const net = gross - fees;
    totalFees += fees;
    totalPnL += net;

    // sazba: 1 obchod = 2 strany na kontrakt (vstup + výstup)
    const root = parseContractRoot(contract);
    const sides = 2 * (t.positionSize || 0);
    if (root && sides > 0 && fees > 0) {
      const a = rateAccum.get(root) ?? { fees: 0, sides: 0 };
      a.fees += fees; a.sides += sides;
      rateAccum.set(root, a);
    }

    return {
      ...t,
      pnl: net,
      outcome: net > 0 ? 'Win' : net < 0 ? 'Loss' : 'BE',
    } as Trade;
  });

  const feeRates: FeeRates = {};
  for (const [root, a] of rateAccum) feeRates[root] = Math.round((a.fees / a.sides) * 100) / 100;

  return {
    trades,
    summary: {
      ...result.summary,
      totalPnL,
      usedExportPnL: true,
      feesApplied: true,
      feesEstimated: false,
      totalFees,
      feeRates,
    },
  };
}

/**
 * Dopočítá poplatky z ULOŽENÝCH sazeb (per root × 2 strany × qty) — pro import,
 * kde Cash History není, ale sazby účtu už známe z dřívějška. P&L zůstává gross
 * dopočet z cen mínus odhad poplatků (u konstantních sazeb = přesné).
 */
export function applyEstimatedFees(
  result: TradovateImportResult,
  rates: FeeRates,
): TradovateImportResult {
  if (!rates || Object.keys(rates).length === 0) return result;
  let totalFees = 0;
  let totalPnL = 0;

  const trades = result.trades.map(t => {
    const root = parseContractRoot(t.symbol || t.instrument || '');
    const rate = rates[root];
    const sides = 2 * (t.positionSize || 0);
    if (rate === undefined) { totalPnL += t.pnl; return t; } // root bez uložené sazby → gross
    const fees = rate * sides;
    const net = t.pnl - fees;
    totalFees += fees;
    totalPnL += net;
    return { ...t, pnl: net, outcome: net > 0 ? 'Win' : net < 0 ? 'Loss' : 'BE' } as Trade;
  });

  return {
    trades,
    summary: {
      ...result.summary,
      totalPnL,
      feesApplied: true,
      feesEstimated: true,
      totalFees,
    },
  };
}

/** Rozpočítá fees fillu na poměrnou část qty (fees jsou per fill, ne per kontrakt). */
function apportionFees(f: ParsedFill, qtyPart: number): number {
  if (!f.fees || !f.qty) return 0;
  return (f.fees * qtyPart) / f.qty;
}
