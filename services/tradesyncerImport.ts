/**
 * Tradesyncer import — orders_history.csv (copier export) → obchody per účet.
 *
 * Tradesyncer je trade copier (leader → N follower účtů). Export je ORDERS log
 * (limit/stop/market, filled/canceled) napříč VŠEMI účty v jednom CSV.
 *
 * Postup:
 *   1. rozpoznání formátu (sloupce leaderOrderId/connectionName/accountName),
 *   2. rozdělení po účtech,
 *   3. netting filled orderů do round-tripů (flat→flat) — ověřeno na reálných datech,
 *   4. SL/TP z bracket orderů (canceled stop pod entry = init SL; limit na druhé straně = TP)
 *      — pozn.: init SL je v exportu jen občas (Tradesyncer většinou uloží jen posunutý stop),
 *      proto se spolehlivé SL/TP/R:R bere z napárovaného AlphaBridge leadera.
 *   5. link na AlphaBridge leader (cena + čas) → zdědí SL/TP/screen/tagy/session.
 *
 * Reuse: CONTRACT_SPECS / pointValueFor / parseContractRoot z tradovateImport.
 */
import Papa from 'papaparse';
import type { Trade } from '../types';
import { pointValueFor, parseContractRoot } from './tradovateImport';

export const TS_IMPORT_TAG = 'tradesyncer';

const round2 = (x: number) => Math.round(x * 100) / 100;
// UUID id — MUSÍ být UUID, jinak storageService (isUUID guard) přiřadí náhodné id
// do DB sloupce a masterTradeId odkazy přestanou sedět → seskupení se rozbije.
const uuid = (): string =>
  (typeof crypto !== 'undefined' && (crypto as any).randomUUID)
    ? (crypto as any).randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });
const t2ms = (s: string | undefined): number => s ? Date.parse(String(s).trim().replace(' ', 'T') + 'Z') : NaN;
const norm = (s: string) => String(s).trim().toLowerCase();

/** Rozpozná Tradesyncer orders export podle charakteristických sloupců. */
export function isTradesyncerOrders(rows: any[]): boolean {
  if (!Array.isArray(rows) || rows.length === 0) return false;
  const sample = rows.find(r => r && typeof r === 'object');
  if (!sample) return false;
  const keys = Object.keys(sample).map(norm);
  return keys.includes('leaderorderid') && keys.includes('connectionname')
    && keys.includes('accountname') && keys.includes('fillprice');
}

/** Jeden rekonstruovaný round-trip obchod (per účet). */
export interface TsTrade {
  entry: number;
  exit: number;
  dir: 'Long' | 'Short';
  size: number;
  pnl: number;            // GROSS (export nemá komise)
  entryTime: number;
  exitTime: number;
  instrument: string;     // root (MNQ)
  contract: string;       // MNQU6
  stopLoss?: number;      // init SL z CSV (často chybí)
  takeProfit?: number;
  orderIds: string[];     // pro dedup
}

/** Obchody jednoho Tradesyncer účtu. */
export interface TsAccount {
  account: string;        // interní id (54832865)
  accountName: string;    // FTDFYSLX… / 50KTC-… / LFF…
  connectionName: string; // Tradeify Funded / Topstep challka / Lucid Funded
  trades: TsTrade[];
}

/** Parse CSV → obchody seskupené po účtech (netting flat→flat). */
export function parseTradesyncerOrders(csvText: string): TsAccount[] {
  const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true });
  const rows = (parsed.data as any[]).filter(r => r && typeof r === 'object');

  const byAcc = new Map<string, any[]>();
  for (const r of rows) {
    const a = String(r.account ?? '').trim();
    if (!a) continue;
    if (!byAcc.has(a)) byAcc.set(a, []);
    byAcc.get(a)!.push(r);
  }

  const out: TsAccount[] = [];
  for (const [acc, list] of byAcc) {
    const filled = list
      .filter(r => norm(r.status) === 'filled' && +r.fillSize > 0 && String(r.fillPrice).trim() !== '')
      .map(r => ({ t: t2ms(r.fillTime), side: norm(r.side), qty: +r.fillSize, price: +r.fillPrice, id: String(r.id ?? ''), sym: String(r.symbol || r.contract || 'MNQ').trim() }))
      .filter(f => !isNaN(f.t) && f.qty > 0 && !isNaN(f.price))
      .sort((a, b) => a.t - b.t);

    const trades: TsTrade[] = [];
    let pos = 0, dir = 0, eSum = 0, eQty = 0, xSum = 0, xQty = 0, start = 0, sym = 'MNQ', ids: string[] = [];

    for (const f of filled) {
      const s = f.side === 'long' ? 1 : -1;
      if (pos === 0) { dir = s; start = f.t; eSum = 0; eQty = 0; xSum = 0; xQty = 0; sym = f.sym; ids = []; }
      if (f.id) ids.push(f.id);
      if (s === dir) { eSum += f.price * f.qty; eQty += f.qty; pos += s * f.qty; }
      else { xSum += f.price * f.qty; xQty += f.qty; pos += s * f.qty; }

      if (pos === 0 && eQty > 0) {
        const entry = eSum / eQty, exit = xSum / (xQty || eQty);
        const root = parseContractRoot(sym) || sym;
        const pv = pointValueFor(sym);
        const pnl = (exit - entry) * dir * eQty * pv;

        // SL/TP z bracket orderů účtu v časovém okně tradu (i canceled — plánovaná cena tam zůstává).
        const lo = start - 3000, hi = f.t + 3000;
        const opp = dir === 1 ? 'short' : 'long';
        const win = list.filter(r => {
          const tt = t2ms(r.fillTime) || t2ms(r.closingTime) || t2ms(r.openTime);
          return !isNaN(tt) && tt >= lo && tt <= hi;
        });
        const stops = win
          .filter(r => norm(r.type).includes('stop') && norm(r.side) === opp && +r.stopPrice > 0)
          .map(r => +r.stopPrice)
          .filter(p => dir === 1 ? p < entry : p > entry);
        const tps = win
          .filter(r => norm(r.type).includes('limit') && norm(r.side) === opp && +r.price > 0)
          .map(r => +r.price)
          .filter(p => dir === 1 ? p > entry : p < entry);
        const stopLoss = stops.length ? (dir === 1 ? Math.min(...stops) : Math.max(...stops)) : undefined;
        const takeProfit = tps.length ? (dir === 1 ? Math.max(...tps) : Math.min(...tps)) : undefined;

        trades.push({
          entry: round2(entry), exit: round2(exit),
          dir: dir === 1 ? 'Long' : 'Short', size: eQty, pnl: round2(pnl),
          entryTime: start, exitTime: f.t, instrument: root, contract: sym,
          stopLoss: stopLoss != null ? round2(stopLoss) : undefined,
          takeProfit: takeProfit != null ? round2(takeProfit) : undefined,
          orderIds: ids.slice(),
        });
      }
    }

    if (trades.length) {
      out.push({
        account: acc,
        accountName: String(list[0].accountName ?? acc).trim(),
        connectionName: String(list[0].connectionName ?? '').trim(),
        trades,
      });
    }
  }

  // Seřaď účty dle connectionName + accountName (stabilní pořadí v UI).
  out.sort((a, b) => (a.connectionName + a.accountName).localeCompare(b.connectionName + b.accountName));
  return out;
}

/**
 * Najde AlphaBridge leader trade pro daný Tradesyncer trade — podle ceny + času
 * (+ instrument + směr). Tolerance: cena ≤ 2 b, čas ≤ 3 min. Vrací nejbližší.
 */
export function findLeaderTrade(ts: TsTrade, existing: Trade[]): Trade | null {
  let best: Trade | null = null, bestDt = Infinity;
  for (const e of existing) {
    const ep = Number(e.entryPrice), et = Number((e as any).entryTime);
    if (!ep || !et) continue;
    if (norm(String(e.instrument || '')) !== norm(ts.instrument)) continue;
    if (norm(String(e.direction || '')) !== norm(ts.dir)) continue;
    if (Math.abs(ep - ts.entry) > 2) continue;          // ~2 b tolerance (slippage)
    const dt = Math.abs(et - ts.entryTime);
    if (dt > 3 * 60 * 1000) continue;                   // ±3 min
    if (dt < bestDt) { bestDt = dt; best = e; }
  }
  return best;
}

/** Mapování Tradesyncer účet → cílový AlphaTrade účet (existující id NEBO nový). */
export interface AccountMap {
  /** category = kategorie cílového účtu (Funded/Challenge/…) — řídí seskupení kopií v combined. */
  [tsAccountKey: string]: { accountId: string; isNew: boolean; name: string; category?: string };
}

/** Klíč Tradesyncer účtu (stabilní napříč exporty). */
export const tsAccountKey = (a: TsAccount) => a.accountName || a.account;

/** Náhled AlphaBridge leadera, na kterého se import napáruje (pro preview v modalu). */
export interface TsMatchedLeader {
  id: string;
  screenshot?: string;
  entry?: number;
  direction?: string;
  rr?: number;
  setup?: string;
  session?: string;
  count: number;           // kolik exekucí (účtů × obchodů) se na něj naváže
}

export interface TsBuildResult {
  trades: Trade[];
  linked: number;          // kolik se napárovalo na AlphaBridge leadera
  executionOnly: number;   // kolik bez leadera (jen exekuce)
  duplicates: number;      // kolik přeskočeno (už importované)
  mergedLeader: number;    // kolik splynulo s leaderem (účet leadera → nevytváří se duplicit)
  matchedLeaders: TsMatchedLeader[]; // unikátní leadeři + náhled (na co se to napáruje)
}

/**
 * Postaví app Trade objekty pro vybrané účty + dedup + link na AlphaBridge.
 *   tsAccounts  — výstup parseTradesyncerOrders
 *   map         — Tradesyncer účet → AlphaTrade accountId
 *   existing    — stávající obchody (dedup + link)
 */
export function buildTradesyncerTrades(tsAccounts: TsAccount[], map: AccountMap, existing: Trade[]): TsBuildResult {
  // Dedup proti už importovaným Tradesyncer obchodům — DVA klíče (přežijí refresh):
  //   1) order id (tsOrderIds),
  //   2) kompozit účet|entryTime|exitTime (poskládatelný z polí, co load vždy nese:
  //      accountId + entryTime + timestamp) — chytí re-import i kdyby tsOrderIds chyběly.
  // Scope: jen obchody se source='tradesyncer', ať se nepřekrývá s AlphaBridge/ručními.
  const importedOrderIds = new Set<string>();
  const importedKeys = new Set<string>();
  for (const t of existing) {
    if ((t as any).source !== 'tradesyncer') continue;
    const ids = (t as any).tsOrderIds as string[] | undefined;
    if (Array.isArray(ids)) ids.forEach(id => importedOrderIds.add(String(id)));
    const et = (t as any).entryTime, xt = (t as any).timestamp;
    if (t.accountId && et) importedKeys.add(`${t.accountId}|${et}|${xt}`);
  }

  const trades: Trade[] = [];
  // Záznamy pro seskupení kopií napříč účty (stejný logický obchod → 1 řádek v combined).
  const recs: { t: any; cat: string; leaderId?: string; entryTime: number; instrument: string; dir: string }[] = [];
  const leaderMap = new Map<string, TsMatchedLeader>(); // náhled leaderů pro preview
  let linked = 0, executionOnly = 0, duplicates = 0, mergedLeader = 0;

  for (const acc of tsAccounts) {
    const target = map[tsAccountKey(acc)];
    if (!target) continue; // nezamapovaný účet → přeskoč
    const cat = target.category || 'Funded';
    for (const tr of acc.trades) {
      const dupKey = `${target.accountId}|${tr.entryTime}|${tr.exitTime}`;
      if (tr.orderIds.some(id => importedOrderIds.has(String(id))) || importedKeys.has(dupKey)) { duplicates++; continue; }

      const leader = findLeaderTrade(tr, existing);
      // Účet, kde leader (AlphaBridge) UŽ je → exekuci nevytvářej, leader ten obchod zastupuje
      // (jinak by na účtu leadera vznikl duplikát: AlphaBridge obchod + Tradesyncer exekuce).
      if (leader && String(leader.accountId) === String(target.accountId)) { mergedLeader++; continue; }
      if (leader) {
        linked++;
        // Posbírej unikátní leadery pro preview (náhled na co se to napáruje).
        const lid = String(leader.id);
        const ex = leaderMap.get(lid);
        if (ex) { ex.count++; }
        else leaderMap.set(lid, {
          id: lid,
          screenshot: (leader as any).screenshots?.[0] || leader.screenshot || undefined,
          entry: leader.entryPrice != null ? Number(leader.entryPrice) : undefined,
          direction: leader.direction,
          rr: (leader as any).rr != null ? Number((leader as any).rr) : undefined,
          setup: (leader as any).signal || (leader as any).setup || undefined,
          session: leader.session || undefined,
          count: 1,
        });
      } else executionOnly++;

      const sl = leader && leader.stopLoss != null ? Number(leader.stopLoss) : tr.stopLoss;
      const tp = leader && leader.takeProfit != null ? Number(leader.takeProfit) : tr.takeProfit;
      const pv = pointValueFor(tr.contract);
      const riskAmount = sl != null ? round2(Math.abs(tr.entry - sl) * tr.size * pv) : undefined;
      const durMin = Math.max(0, Math.round((tr.exitTime - tr.entryTime) / 60000));

      const t: any = {
        id: uuid(), // reálné UUID → DB sloupec id == trade.id == cíl masterTradeId (viz uuid() pozn.)
        accountId: target.accountId,
        instrument: tr.instrument,
        symbol: tr.contract,
        signal: 'Tradesyncer Import',
        pnl: tr.pnl,
        riskAmount,
        runUp: 0,
        drawdown: 0,
        date: new Date(tr.exitTime).toISOString(),
        time: new Date(tr.exitTime).toTimeString().slice(0, 5),
        timestamp: tr.exitTime,
        entryTime: tr.entryTime,
        entryDate: new Date(tr.entryTime).toISOString(),
        exitDate: new Date(tr.exitTime).toISOString(),
        durationMinutes: durMin,
        duration: durMin >= 60 ? `${Math.floor(durMin / 60)}h ${durMin % 60}m` : `${durMin}m`,
        direction: tr.dir,
        outcome: tr.pnl > 0 ? 'Win' : tr.pnl < 0 ? 'Loss' : 'BE',
        entryPrice: tr.entry,
        exitPrice: tr.exit,
        positionSize: tr.size,
        stopLoss: sl,
        takeProfit: tp,
        // Bez AlphaBridge leadera = neplánovaný obchod → Invalid (vypadne z edge statistik,
        // PnL pořád počítá pro balance). Půjde přepnout zpět v detailu obchodu.
        isValid: !!leader,
        executionStatus: leader ? (leader.executionStatus || 'Valid') : 'Invalid',
        // Dedup + provenance (uloží se do data blobu).
        tsOrderIds: tr.orderIds,
        tsAccountName: acc.accountName,
        tsConnectionName: acc.connectionName,
        source: 'tradesyncer',
        tags: [TS_IMPORT_TAG, leader ? 'linked' : 'execution-only'],
      };

      // Zděděno z AlphaBridge leadera — screen, tagy, session, poznámka, bias.
      if (leader) {
        t.leaderId = leader.id;
        if (leader.screenshot) t.screenshot = leader.screenshot;
        if ((leader as any).screenshots) t.screenshots = (leader as any).screenshots;
        if ((leader as any).htfConfluence) t.htfConfluence = (leader as any).htfConfluence;
        if ((leader as any).ltfConfluence) t.ltfConfluence = (leader as any).ltfConfluence;
        if (leader.session) t.session = leader.session;
        if ((leader as any).notes) t.notes = (leader as any).notes;
      }

      trades.push(t as Trade);
      recs.push({ t, cat, leaderId: t.leaderId, entryTime: tr.entryTime, instrument: tr.instrument, dir: tr.dir });
    }
  }

  // --- Seskupení kopií napříč účty ---
  // Stejný logický obchod zkopírovaný na N účtů → v combined/seskupení 1 řádek (sečtené PnL).
  // POZOR: slučujeme JEN v rámci stejné kategorie (Funded zvlášť, Challenge zvlášť) — nikdy dohromady.
  // Klastrujeme dle (kategorie|instrument|směr) + časové okno; různí AlphaBridge leadeři klastr rozdělí.
  const GROUP_GAP_MS = 90 * 1000; // copier latence jsou sekundy; jeho reálné obchody jsou minuty od sebe
  const buckets = new Map<string, typeof recs>();
  for (const r of recs) {
    const k = `${r.cat}|${r.instrument}|${r.dir}`;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k)!.push(r);
  }
  for (const arr of buckets.values()) {
    arr.sort((a, b) => a.entryTime - b.entryTime);
    let cluster: typeof recs = [];
    const flush = () => {
      if (cluster.length > 1) {
        const master = cluster[0].t;
        master.isMaster = true;
        for (let i = 1; i < cluster.length; i++) cluster[i].t.masterTradeId = master.id;
      }
      cluster = [];
    };
    for (const r of arr) {
      if (cluster.length === 0) { cluster.push(r); continue; }
      const prev = cluster[cluster.length - 1];
      const leaderClash = !!r.leaderId && !!prev.leaderId && r.leaderId !== prev.leaderId;
      if (r.entryTime - prev.entryTime > GROUP_GAP_MS || leaderClash) flush();
      cluster.push(r);
    }
    flush();
  }

  return { trades, linked, executionOnly, duplicates, mergedLeader, matchedLeaders: Array.from(leaderMap.values()) };
}
