// Import service — čtení Tradecopia auto-importu (staging tabulky imported_trades /
// imported_orders) a správa mapování externích účtů na účty v AlphaTrade.
//
// Data plní lokální sync agent (scripts/tradecopia-sync) přes edge fn import-trades.
// Tady je jen čtecí/párovací strana pro UI.

import { supabase } from './supabase';
import {
  pairExecutions,
  type ImportedExecution,
  type JournalTrade,
  type PairingResult,
} from './importPairing';
import type { DailyReview } from '../types';

export interface ImportedAccountOverview {
  account_ext_id: number;
  account_name: string | null;
  entity_id: string | null;
  platform: string | null;
  trade_count: number;
  total_pnl: number;
  first_trade: string | null;
  last_trade: string | null;
  is_demo: boolean;
}

export interface AccountMapRow {
  id: string;
  account_ext_id: number;
  account_name: string | null;
  entity_id: string | null;
  mapped_account_id: string | null;
  status: 'new' | 'mapped' | 'ignored';
  is_connected: boolean;
  /** Od kdy se import propisuje do deníku (YYYY-MM-DD). Starší se ignoruje. */
  import_from_date: string | null;
}

export interface AppAccountOption {
  id: string;
  name: string;
  status?: string | null;
  type?: string | null;
}

const isDemoEntity = (entityId: string | null | undefined) =>
  typeof entityId === 'string' && entityId.toLowerCase().endsWith('-demo');

/**
 * Agregovaný přehled importovaných účtů (počty, PnL, rozsah dat).
 * Agregace běží na serveru (RPC get_import_overview) — klientská agregace
 * narážela na PostgREST limit 1000 řádků a ukazovala jen nejstarší obchody.
 */
export async function getImportedAccountsOverview(): Promise<ImportedAccountOverview[]> {
  const { data, error } = await supabase.rpc('get_import_overview');
  if (error) {
    console.warn('[import] overview error:', error);
    return [];
  }
  return ((data || []) as any[]).map(row => ({
    account_ext_id: Number(row.account_ext_id),
    account_name: row.account_name || null,
    entity_id: row.entity_id || null,
    platform: row.platform || null,
    trade_count: Number(row.trade_count) || 0,
    total_pnl: Number(row.total_pnl) || 0,
    first_trade: row.first_trade || null,
    last_trade: row.last_trade || null,
    is_demo: isDemoEntity(row.entity_id),
  }));
}

export async function listAccountMap(): Promise<AccountMapRow[]> {
  const { data, error } = await supabase
    .from('import_account_map')
    .select('id, account_ext_id, account_name, entity_id, mapped_account_id, status, is_connected, import_from_date')
    .eq('source', 'tradecopia');
  if (error) {
    console.warn('[import] listAccountMap error:', error);
    return [];
  }
  return (data || []) as AccountMapRow[];
}

/**
 * Zajistí, že pro každý importovaný účet existuje řádek v mapě.
 * Všechny nové účty dostanou status 'new' — POZOR: prop firm účty (Tradeify apod.)
 * běží na Tradovate v sim/demo prostředí, takže '-demo' entity NEZNAMENÁ
 * irelevantní účet. Ignorování je vždy ruční rozhodnutí uživatele.
 * Vrací počet nově založených řádků (= nově detekované účty).
 */
export async function ensureAccountMapRows(overview: ImportedAccountOverview[]): Promise<number> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return 0;
  const existing = await listAccountMap();
  const known = new Set(existing.map(m => m.account_ext_id));
  const missing = overview.filter(o => !known.has(o.account_ext_id));
  if (missing.length === 0) return 0;
  const rows = missing.map(o => ({
    user_id: user.id,
    source: 'tradecopia',
    account_ext_id: o.account_ext_id,
    account_name: o.account_name,
    entity_id: o.entity_id,
    status: 'new',
  }));
  const { error } = await supabase
    .from('import_account_map')
    .upsert(rows, { onConflict: 'user_id,source,account_ext_id', ignoreDuplicates: true });
  if (error) {
    console.warn('[import] ensureAccountMapRows error:', error);
    return 0;
  }
  return missing.length;
}

export async function setAccountMapping(
  mapRowId: string,
  update: { mapped_account_id?: string | null; status?: 'new' | 'mapped' | 'ignored' },
): Promise<boolean> {
  const { error } = await supabase
    .from('import_account_map')
    .update({ ...update, updated_at: new Date().toISOString() })
    .eq('id', mapRowId);
  if (error) {
    console.warn('[import] setAccountMapping error:', error);
    return false;
  }
  return true;
}

export async function listAppAccounts(): Promise<AppAccountOption[]> {
  // POZOR: RLS na accounts pouští i účty friends ("Friends can view accounts")
  // → musíme filtrovat na vlastní. A pro mapování dávají smysl jen živé live
  // účty — žádný backtest, žádné archivované/spálené.
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];
  const { data, error } = await supabase
    .from('accounts')
    .select('id, name, status, type, meta')
    .eq('user_id', user.id)
    .order('name');
  if (error) {
    console.warn('[import] listAppAccounts error:', error);
    return [];
  }
  return ((data || []) as any[])
    .filter(a => {
      // Jen skutečně aktivní live účty — Inactive (i nearchivované) do mapování nepatří.
      if (a.type === 'Backtest' || a.status !== 'Active') return false;
      const meta = a.meta || {};
      if (meta.archivedAt || meta.result === 'Failed' || meta.result === 'Passed') return false;
      return true;
    })
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'cs'))
    .map(a => ({ id: a.id, name: a.name, status: a.status, type: a.type }));
}

// ─── Párovací vrstva ─────────────────────────────────────────────────────────

export interface ImportAccountInfo {
  accountId: string;
  name: string;
  /** 'Funded' = reálné peníze, 'Challenge' = riziko poplatku. Rozlišení má
   *  význam u incidentů — ztráta na funded a na challenge nejsou totéž. */
  phase: 'Funded' | 'Challenge' | null;
}

export type PairingRunResult = PairingResult & {
  /** Externí účet → účet v appce, pro rozpad podle typu účtu v UI. */
  accountInfo: Map<number, ImportAccountInfo>;
  /** Volné validní deníkové obchody pro ruční 1:1 propojení, podle app účtu. */
  availableTradesByAccount: Map<string, JournalTrade[]>;
};

const IMPORT_PAGE_SIZE = 1000;
const IMPORT_MAX_ROWS = 20_000;

async function loadPendingExecutions(userId: string, accountIds: number[], sinceDate: string): Promise<any[]> {
  const rows: any[] = [];
  for (let from = 0; from < IMPORT_MAX_ROWS; from += IMPORT_PAGE_SIZE) {
    const { data, error } = await supabase.from('imported_trades')
      .select('id, account_ext_id, account_name, symbol, direction, buy_price, sell_price, qty, pnl, entry_at, exit_at, status, group_key')
      .eq('user_id', userId)
      .eq('status', 'pending')
      .in('account_ext_id', accountIds)
      .gte('entry_at', sinceDate)
      .order('entry_at', { ascending: false })
      .range(from, from + IMPORT_PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if ((data || []).length < IMPORT_PAGE_SIZE) return rows;
  }
  console.warn(`[import] pending execution query reached safety cap ${IMPORT_MAX_ROWS}`);
  return rows;
}

async function loadJournalTrades(userId: string, accountIds: string[], sinceDate: string): Promise<any[]> {
  const rows: any[] = [];
  for (let from = 0; from < IMPORT_MAX_ROWS; from += IMPORT_PAGE_SIZE) {
    const { data, error } = await supabase.from('trades')
      .select('id, account_id, date, timestamp, data, pnl')
      .eq('user_id', userId)
      .in('account_id', accountIds)
      .gte('date', sinceDate)
      .order('date', { ascending: false })
      .order('timestamp', { ascending: false })
      .range(from, from + IMPORT_PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if ((data || []).length < IMPORT_PAGE_SIZE) return rows;
  }
  console.warn(`[import] journal trade query reached safety cap ${IMPORT_MAX_ROWS}`);
  return rows;
}

async function loadLinkedTradeIds(userId: string): Promise<Set<string>> {
  const ids = new Set<string>();
  for (let from = 0; from < IMPORT_MAX_ROWS; from += IMPORT_PAGE_SIZE) {
    const { data, error } = await supabase.from('imported_trades')
      .select('linked_trade_id')
      .eq('user_id', userId)
      .eq('status', 'matched')
      .not('linked_trade_id', 'is', null)
      .order('linked_trade_id', { ascending: true })
      .range(from, from + IMPORT_PAGE_SIZE - 1);
    if (error) throw error;
    for (const row of data || []) if (row.linked_trade_id) ids.add(String(row.linked_trade_id));
    if ((data || []).length < IMPORT_PAGE_SIZE) return ids;
  }
  console.warn(`[import] linked trade query reached safety cap ${IMPORT_MAX_ROWS}`);
  return ids;
}

/**
 * Načte podklady a spáruje nevyřešené exekuce s obchody v deníku.
 * Vrací výsledek k zobrazení; nic sám neukládá — zápis dělá až applyMatch/…,
 * aby uživatel viděl, co se stane, dřív než se to stane.
 */
export async function runPairing(opts?: { sinceDays?: number }): Promise<PairingRunResult> {
  const { data: { user } } = await supabase.auth.getUser();
  const empty: PairingRunResult = {
    matched: [], ambiguous: [], unmatched: [], skipped: [],
    accountInfo: new Map(), availableTradesByAccount: new Map(),
  };
  if (!user) return empty;

  // Mapu načti první: bez ní neznáme cutoff ani relevantní účty a dotaz na
  // exekuce by narazil na strop 1000 řádků ještě před dnešními obchody.
  const { data: mapData, error: mapErr } = await supabase
    .from('import_account_map')
    .select('account_ext_id, mapped_account_id, import_from_date, status')
    .eq('user_id', user.id);
  if (mapErr) { console.warn('[import] runPairing map error:', mapErr); return empty; }

  const accountMap = new Map<number, string>();
  const cutoffByAccount = new Map<string, string>();
  for (const row of (mapData || []) as any[]) {
    if (row.status === 'ignored' || !row.mapped_account_id) continue;
    accountMap.set(Number(row.account_ext_id), row.mapped_account_id);
    if (row.import_from_date) cutoffByAccount.set(row.mapped_account_id, row.import_from_date);
  }
  if (accountMap.size === 0) return empty;

  // Dolní hranice = nejstarší cutoff napříč namapovanými účty, omezená na
  // rozumné okno. Bez ní bychom tahali celou historii jen proto, aby ji
  // párování vzápětí zahodilo.
  const windowStart = new Date(Date.now() - (opts?.sinceDays ?? 14) * 86400000)
    .toISOString().slice(0, 10);
  const cutoffs = [...cutoffByAccount.values()];
  const earliestCutoff = cutoffs.length > 0
    ? cutoffs.reduce((min, c) => (c < min ? c : min))
    : windowStart;
  // Cutoff nikdy nesmí obejít bezpečnostní okno. Starší historii lze načíst jen
  // explicitním zvýšením sinceDays, ne jedním dávno nastaveným účtem.
  const sinceDate = earliestCutoff > windowStart ? earliestCutoff : windowStart;

  let executionRows: any[];
  let tradeRows: any[];
  let linkedTradeIds: Set<string>;
  let accountRes: any;
  try {
    [executionRows, tradeRows, linkedTradeIds, accountRes] = await Promise.all([
      loadPendingExecutions(user.id, [...accountMap.keys()], sinceDate),
      loadJournalTrades(user.id, [...new Set(accountMap.values())], sinceDate),
      loadLinkedTradeIds(user.id),
      supabase.from('accounts')
        .select('id, name, meta')
        .eq('user_id', user.id)
        .in('id', [...new Set(accountMap.values())]),
    ]);
  } catch (error) {
    console.warn('[import] runPairing load error:', error);
    return empty;
  }

  // Externí účet → jméno a fáze účtu v appce (Funded vs. Challenge).
  const byAppId = new Map<string, { name: string; phase: 'Funded' | 'Challenge' | null }>();
  for (const row of (accountRes.data || []) as any[]) {
    const phase = (row.meta || {}).phase;
    byAppId.set(row.id, {
      name: row.name,
      phase: phase === 'Funded' || phase === 'Challenge' ? phase : null,
    });
  }
  const accountInfo = new Map<number, ImportAccountInfo>();
  for (const [extId, appId] of accountMap) {
    const info = byAppId.get(appId);
    accountInfo.set(extId, { accountId: appId, name: info?.name || String(extId), phase: info?.phase ?? null });
  }

  const tradesByAccount = new Map<string, JournalTrade[]>();
  for (const row of tradeRows) {
    if (linkedTradeIds.has(String(row.id))) continue;
    const d = row.data || {};
    const list = tradesByAccount.get(row.account_id) || [];
    list.push({
      id: row.id,
      accountId: row.account_id,
      date: row.date,
      instrument: d.instrument,
      entryPrice: typeof d.entryPrice === 'number' ? d.entryPrice : undefined,
      exitPrice: typeof d.exitPrice === 'number' ? d.exitPrice : undefined,
      entryTime: d.entryTime ? Number(d.entryTime) : undefined,
      timestamp: Number(d.timestamp) || 0,
      direction: d.direction,
      groupId: d.groupId,
      pnl: Number(row.pnl) || 0,
      executionStatus: d.executionStatus,
      isValid: d.isValid,
    });
    tradesByAccount.set(row.account_id, list);
  }

  const paired = pairExecutions({
      executions: executionRows as ImportedExecution[],
      tradesByAccount,
      accountMap,
      cutoffByAccount,
    });

  // Ruční výběr nesmí nabízet obchod rezervovaný aktuálním automatickým ani
  // nejednoznačným návrhem. Po každé akci se fronta načte znovu.
  const reserved = new Set<string>([
    ...paired.matched.map(match => String(match.trade.id)),
    ...paired.ambiguous.flatMap(item => item.candidates.map(trade => String(trade.id))),
  ]);
  const availableTradesByAccount = new Map<string, JournalTrade[]>();
  for (const [accountId, trades] of tradesByAccount) {
    availableTradesByAccount.set(accountId, trades.filter(trade => {
      if (reserved.has(String(trade.id))) return false;
      const status = trade.executionStatus || (trade.isValid === false ? 'Invalid' : 'Valid');
      return status === 'Valid';
    }));
  }

  return {
    ...paired,
    accountInfo,
    availableTradesByAccount,
  };
}

/** "5min 50sec" / "1min 21sec" / "57sec" → minuty (zaokrouhleno nahoru od 30 s). */
export function parseDurationMinutes(duration?: string | null): number | undefined {
  if (!duration) return undefined;
  const min = /(\d+)\s*min/.exec(duration);
  const sec = /(\d+)\s*sec/.exec(duration);
  if (!min && !sec) return undefined;
  const total = (min ? Number(min[1]) : 0) + (sec ? Number(sec[1]) / 60 : 0);
  return Math.round(total);
}

/**
 * Potvrdí spárování A obohatí obchod v deníku o skutečná exekuční data.
 *
 * Deník nese odhad (AlphaBridge počítá PnL z bodů × size × point value), import
 * nese realitu od brokera včetně poplatků a slippage — u jednoho obchodu to byl
 * rozdíl −124 $ odhad vs −83,50 $ skutečnost. Původní hodnoty se zachovají
 * v `estimatedPnl` / `estimatedExitPrice`, aby šel rozdíl analyzovat (a případně
 * vrátit zpět).
 */
export async function applyMatch(executionId: string, tradeId: string, score?: number): Promise<boolean> {
  const { data: exec, error: loadError } = await supabase.from('imported_trades')
    .select('duration')
    .eq('id', executionId)
    .maybeSingle();
  if (loadError || !exec) {
    console.warn('[import] applyMatch load error:', loadError);
    return false;
  }
  const { data, error } = await supabase.rpc('apply_import_match', {
    p_execution_id: executionId,
    p_trade_id: tradeId,
    p_match_score: score ?? null,
    p_duration_minutes: parseDurationMinutes((exec as any).duration) ?? null,
  });
  if (error) { console.warn('[import] applyMatch RPC error:', error); return false; }
  return data === true;
}

/**
 * Doplní skutečná data k obchodům, které byly spárované dřív, než obohacení
 * existovalo. Vrací počet opravených obchodů.
 */
export async function backfillMatchedTrades(): Promise<number> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return 0;
  const { data, error } = await supabase.from('imported_trades')
    .select('id, linked_trade_id, match_score')
    .eq('user_id', user.id)
    .eq('status', 'matched')
    .not('linked_trade_id', 'is', null);
  if (error || !data) return 0;
  let fixed = 0;
  for (const row of data as any[]) {
    if (await applyMatch(row.id, row.linked_trade_id, row.match_score ?? undefined)) fixed++;
  }
  return fixed;
}

/**
 * Přiřadí exekuce k incidentu. Nepočítají se do WR/RR/trade count, ale zůstávají
 * dohledatelné — právě z nich jde spočítat průběh tilt session.
 */
export async function assignToIncident(executionIds: string[], incidentRef: string): Promise<DailyReview | null> {
  if (executionIds.length === 0) return null;
  const { data, error } = await supabase.rpc('assign_import_incident', {
    p_execution_ids: [...new Set(executionIds)],
    p_title: incidentRef.trim() || null,
  });
  if (error) { console.warn('[import] assignToIncident RPC error:', error); return null; }
  return data as DailyReview;
}

export async function ignoreExecutions(executionIds: string[]): Promise<boolean> {
  if (executionIds.length === 0) return true;
  const ids = [...new Set(executionIds)];
  const { data, error } = await supabase.rpc('ignore_import_executions', { p_execution_ids: ids });
  if (error) { console.warn('[import] ignoreExecutions RPC error:', error); return false; }
  return Number(data) === ids.length;
}

/** Nastaví cutoff — od kdy se import u daného účtu propisuje do deníku. */
export async function setImportCutoff(mapRowId: string, date: string | null): Promise<boolean> {
  const { error } = await supabase.from('import_account_map')
    .update({ import_from_date: date, updated_at: new Date().toISOString() })
    .eq('id', mapRowId);
  if (error) { console.warn('[import] setImportCutoff error:', error); return false; }
  return true;
}

/**
 * Zapíše účet do DB pod jeho vlastním ID. Používá se při zakládání účtu z importu:
 * mapování má FK na accounts(id), takže účet MUSÍ být v DB dřív než mapping —
 * App state se ukládá asynchronně a FK by selhal. Tvar řádku kopíruje
 * storageService.saveAccounts (meta = celý Account), takže pozdější autosave
 * z App state je idempotentní upsert nad stejným ID.
 */
export async function persistAccount(account: { id: string; name: string; initialBalance: number; currency?: string; type?: string; status?: string; createdAt?: number }): Promise<boolean> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;
  const { error } = await supabase.from('accounts').insert({
    id: account.id,
    user_id: user.id,
    name: account.name,
    initial_balance: account.initialBalance,
    currency: account.currency || 'USD',
    type: account.type || 'Funded',
    status: account.status || 'Active',
    created_at: account.createdAt || Date.now(),
    meta: { ...account },
  });
  if (error) {
    console.warn('[import] persistAccount error:', error);
    return false;
  }
  return true;
}

/**
 * Odhad prop firmy z názvu/entity importovaného účtu — předvolba ve formuláři
 * nového účtu. Prefixy pozorované v Tradecopii: FTDFY nebo TDFY = Tradeify,
 * FNFT = FundedNext, LFE/LFF/LTT = Lucid. Uživatel může přepsat.
 */
export function guessFirm(accountName?: string | null, entityId?: string | null): string | undefined {
  const hay = `${accountName || ''} ${entityId || ''}`.toUpperCase();
  if (hay.includes('FNFT')) return 'FundedNext';
  if (hay.includes('TDFY')) return 'Tradeify';
  if (/\b(LFE|LFF|LTT)/.test(hay) || hay.includes('LUCID')) return 'Lucid';
  if (hay.includes('TOPSTEP') || hay.includes('TSX')) return 'Topstep';
  if (hay.includes('MFF') || hay.includes('MYFUNDED')) return 'MyFundedFutures';
  return undefined;
}

/**
 * Stav syncu pro UI: lastData = kdy naposledy dorazil nový obchod,
 * lastHeartbeat = kdy se sync agent naposledy ohlásil (i bez nových dat).
 */
export async function getSyncStatus(): Promise<{ lastData: string | null; lastHeartbeat: string | null }> {
  const [dataRes, tokenRes] = await Promise.all([
    supabase.from('imported_trades')
      .select('created_at')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase.from('import_tokens')
      .select('last_used_at')
      .limit(1)
      .maybeSingle(),
  ]);
  return {
    lastData: (dataRes.data as any)?.created_at || null,
    lastHeartbeat: (tokenRes.data as any)?.last_used_at || null,
  };
}
