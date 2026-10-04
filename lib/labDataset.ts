import type { Account, Trade } from '../types.js';
import type { TradeExecutionHistory } from './tradeExecutionHistory.js';
import { isEvidenceJournalTrade, isRetiredJournalTrade } from './journalTradeFacts.js';
import { reviewFacts, reviewR } from './tradeReviewFacts.js';
import { planChoiceOf } from './weeklyReview.js';
import { futuresSymbolRoot, pointValueUsd } from '../services/futuresContractSpecs.js';

/**
 * Datový základ Labu (2. 10. 2026, Filip: „Lab je k ničemu a ukazuje špatná
 * data“). Jednotka je ROZHODNUTÍ, ne řádek obchodu: kopie stejného vstupu na
 * followerech sdílí `groupId` a počítají se jednou. Peníze jsou výsledek
 * leader účtu (velikost, kterou Filip zvolil) — kopie se nesčítají, účty se
 * točí (přijdou, spálí se). R je jen tam, kde je SL (plánovaný z Hodnotit,
 * jinak první SL z brokera); bez SL se nedopočítává.
 *
 * Zdroj jsou jen obchody z deníku Tradovate (evidence). Starší data
 * z AlphaBridge a backtest mají jiný model a do živého Labu nepatří.
 */

export type LabSession = 'Asie' | 'Londýn' | 'NY open' | 'NY' | 'Mimo';
export type LabExitKind = 'sl' | 'tp' | 'manual';

export interface LabManagement {
  /** Kolikrát se po vstupu změnila cena SL (potvrzené posuny). */
  slMoves: number;
  /** SL posunut na vstup nebo do zisku (riziko ≤ 0). */
  movedToBreakEven: boolean;
  /** Za kolik sekund po vstupu stál první SL; `null` = obchod SL nikdy neměl.
   *  (2. 10.: 116 obchodů do 2 s, 42 ručně po pár sekundách, 14 nikdy.) */
  stopDelaySec: number | null;
}

export interface LabDecision {
  /** `groupId` skupiny kopírky, jinak id obchodu. */
  id: string;
  leaderTradeId: string;
  memberTradeIds: string[];
  accountIds: string[];
  leaderAccountId: string;
  /** Leader určený kopírkou (`isMaster`); jinak odhad podle nejdřívějšího vstupu. */
  leaderKnown: boolean;
  instrument: string;
  /** Kontrakt leadera (např. `MNQZ6`) — podle něj se načítají svíčky. */
  symbol: string;
  pointValue: number | null;
  direction: 'Long' | 'Short';
  entryAt: number;
  exitAt: number;
  holdMs: number;
  /** Den v Praze `YYYY-MM-DD` — Filip obchoduje z Prahy, den = kalendářní den. */
  dayKey: string;
  /** 0 = neděle … 6 = sobota (Praha). */
  weekday: number;
  /** Minuta dne vstupu v Praze (0–1439) — hodinové rozpady. */
  entryMinute: number;
  session: LabSession;
  /** Pořadí rozhodnutí v rámci dne (1 = první). */
  orderInDay: number;
  /** Minuty od výstupu předchozího rozhodnutí téhož dne (null = první). */
  minutesSincePrevExit: number | null;
  /** Předchozí rozhodnutí téhož dne skončilo ztrátou. */
  afterLoss: boolean;
  /** Opačný směr než předchozí rozhodnutí téhož dne. */
  directionFlip: boolean;
  /** Velikost na leaderovi (kontrakty). */
  size: number;
  entryPrice: number | null;
  exitPrice: number | null;
  /** Pohyb v bodech ve směru obchodu. */
  points: number | null;
  /** Čistý výsledek leader účtu v USD (po poplatcích). */
  pnlUsd: number;
  /** Poplatky leadera, když je zná historie plnění. */
  feesUsd: number | null;
  /** Součet čistého P&L všech účtů skupiny — jen pro pohled „Účty“. */
  groupPnlUsd: number;
  sl: number | null;
  slSource: 'plan' | 'broker' | null;
  tp: number | null;
  riskPoints: number | null;
  riskUsd: number | null;
  r: number | null;
  plannedRR: number | null;
  exitKind: LabExitKind;
  plan: 'yes' | 'no' | 'partial' | null;
  reviewed: boolean;
  invalidReasons: string[];
  htf: string[];
  ltf: string[];
  emotions: string[];
  mistakes: string[];
  /** `null`, když historie plnění (ochrana) zatím není načtená. */
  management: LabManagement | null;
}

export interface LabDatasetInput {
  trades: readonly Trade[];
  accounts: readonly Pick<Account, 'id' | 'type'>[];
  /** Historie plnění podle id obchodu (leaderů) — SL z brokera, výstup, posuny SL. */
  histories?: ReadonlyMap<string, TradeExecutionHistory>;
}

const PRAGUE = 'Europe/Prague';
/** Vstupy na různých účtech bez vazby kopírky do 2 s od sebe = jedno rozhodnutí. */
const SYNC_ENTRY_MS = 2_000;
const NEW_YORK = 'America/New_York';

function zonedParts(at: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
  }).formatToParts(at);
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? '';
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { date: `${get('year')}-${get('month')}-${get('day')}`, minute: Number(get('hour')) * 60 + Number(get('minute')), weekday };
}

/**
 * Seance podle newyorského času (posun letního času v USA a EU nesedí
 * o pár týdnů — Filipovo okno 15:30–17:00 Prahy je „NY open“ 9:30–11:00 ET).
 */
export function labSession(at: number): LabSession {
  const { minute } = zonedParts(at, NEW_YORK);
  if (minute < 3 * 60) return 'Asie';
  if (minute < 9 * 60 + 30) return 'Londýn';
  if (minute < 11 * 60) return 'NY open';
  if (minute < 16 * 60) return 'NY';
  return minute >= 18 * 60 ? 'Asie' : 'Mimo';
}

const tagList = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];

function managementOf(history: TradeExecutionHistory, entryAt: number, exitAt: number, entryPrice: number | null, long: boolean, tick: number): LabManagement {
  const stops = history.protection
    .filter(event => event.kind === 'sl' && event.status === 'confirmed' && event.operation !== 'cancel' && event.price != null && Number.isFinite(event.price))
    .filter(event => event.at <= exitAt + 1_000)
    .sort((a, b) => a.at - b.at);
  const atEntry = stops.filter(event => event.at <= entryAt + 2_000);
  let slMoves = 0; let last: number | null = atEntry.length ? atEntry[atEntry.length - 1].price as number : null;
  let movedToBreakEven = false;
  for (const event of stops) {
    if (event.at <= entryAt + 2_000) continue;
    const price = event.price as number;
    if (last != null && Math.abs(price - last) < 1e-9) continue;
    if (last != null) slMoves += 1;
    last = price;
    if (entryPrice != null && (long ? price >= entryPrice - tick / 2 : price <= entryPrice + tick / 2)) movedToBreakEven = true;
  }
  return { slMoves, movedToBreakEven, stopDelaySec: stops.length ? Math.max(0, (stops[0].at - entryAt) / 1000) : null };
}

const entryMsOf = (trade: Trade) => {
  const at = typeof trade.entryTime === 'number' ? trade.entryTime : Date.parse(String(trade.entryDate ?? ''));
  return Number.isFinite(at) ? at : trade.timestamp || Date.parse(trade.date);
};

/** Obchody, které do živého Labu patří: deník Tradovate, ne backtest, ne nevzaté. */
export function labEligible(trade: Trade, backtestAccounts: ReadonlySet<string>): boolean {
  return isEvidenceJournalTrade(trade) && !isRetiredJournalTrade(trade) && !trade.untaken
    && !backtestAccounts.has(String(trade.accountId)) && Number.isFinite(Number(trade.pnl));
}

export function buildLabDecisions({ trades, accounts, histories }: LabDatasetInput): LabDecision[] {
  const backtest = new Set(accounts.filter(account => account.type === 'Backtest').map(account => String(account.id)));
  const groups = new Map<string, Trade[]>();
  const loose: Trade[] = [];
  for (const trade of trades) {
    if (!labEligible(trade, backtest)) continue;
    if (!trade.groupId) { loose.push(trade); continue; }
    const key = String(trade.groupId);
    groups.set(key, [...(groups.get(key) ?? []), trade]);
  }
  // Vstup na víc účtů naráz bez vazby kopírky (Tradovate skupina účtů, shadow
  // mód): stejný kontrakt a směr, vstup do 2 s na různých účtech = jedno
  // rozhodnutí. 2. 10. v datech 5 párů Tradeify účtů ve stejné milisekundě.
  loose.sort((a, b) => entryMsOf(a) - entryMsOf(b) || String(a.id).localeCompare(String(b.id)));
  const open: { key: string; at: number; root: string; direction: unknown; accounts: Set<string> }[] = [];
  for (const trade of loose) {
    const at = entryMsOf(trade), root = futuresSymbolRoot(String(trade.instrument || trade.symbol || ''));
    const cluster = open.find(item => at - item.at <= SYNC_ENTRY_MS && item.root === root && item.direction === trade.direction
      && !item.accounts.has(String(trade.accountId)));
    if (cluster) {
      cluster.accounts.add(String(trade.accountId));
      groups.get(cluster.key)!.push(trade);
    } else {
      const key = `trade:${trade.id}`;
      open.push({ key, at, root, direction: trade.direction, accounts: new Set([String(trade.accountId)]) });
      groups.set(key, [trade]);
    }
  }

  const decisions: LabDecision[] = [];
  for (const [key, members] of groups) {
    const masters = members.filter(member => member.isMaster === true);
    // Bez leadera od kopírky: účet s nejmenší velikostí (násobky followerů
    // bývají ≥ 1), při shodě nejdřívější vstup.
    const leader = masters.length === 1 ? masters[0]
      : [...members].sort((a, b) => (Number(a.positionSize) || 0) - (Number(b.positionSize) || 0)
        || entryMsOf(a) - entryMsOf(b) || String(a.id).localeCompare(String(b.id)))[0];
    const history = histories?.get(String(leader.id)) ?? leader.executionHistory ?? null;
    const facts = reviewFacts(leader, history);
    const long = facts.long;
    const planned = leader.plannedStopLoss ?? null;
    const plannedTP = leader.plannedTakeProfit ?? null;
    const { r, rr } = reviewR(facts, planned, plannedTP);
    const sl = r != null || rr != null ? planned ?? facts.brokerSL : null;
    const symbol = String(leader.symbol || leader.instrument || '');
    const pointValue = pointValueUsd(symbol);
    const size = Number(leader.positionSize) || 0;
    const riskPoints = sl != null && facts.entryPrice != null ? Math.abs(facts.entryPrice - sl) : null;
    const entryAt = facts.entryAt;
    const exitAt = facts.exitAt;
    const prague = zonedParts(entryAt, PRAGUE);
    const plan = planChoiceOf(leader);
    decisions.push({
      id: key.startsWith('trade:') ? (members.length > 1 ? key.replace('trade:', 'sync:') : String(leader.id)) : key,
      leaderTradeId: String(leader.id),
      memberTradeIds: members.map(member => String(member.id)),
      accountIds: [...new Set(members.map(member => String(member.accountId)))],
      leaderAccountId: String(leader.accountId),
      leaderKnown: masters.length === 1 || members.length === 1,
      instrument: futuresSymbolRoot(String(leader.instrument || symbol)),
      symbol,
      pointValue,
      direction: long ? 'Long' : 'Short',
      entryAt, exitAt, holdMs: Math.max(0, exitAt - entryAt),
      dayKey: prague.date, weekday: prague.weekday, entryMinute: prague.minute,
      session: labSession(entryAt),
      orderInDay: 0, minutesSincePrevExit: null, afterLoss: false, directionFlip: false,
      size,
      entryPrice: facts.entryPrice, exitPrice: facts.exitPrice, points: facts.move,
      pnlUsd: Number(leader.pnl) || 0,
      feesUsd: history?.fees ?? null,
      groupPnlUsd: members.reduce((sum, member) => sum + (Number(member.pnl) || 0), 0),
      sl, slSource: sl == null ? null : planned != null ? 'plan' : 'broker',
      tp: plannedTP ?? facts.brokerTP,
      riskPoints,
      riskUsd: riskPoints != null && pointValue != null && size > 0 ? riskPoints * pointValue * size : null,
      r, plannedRR: rr,
      exitKind: facts.exitKind,
      plan,
      reviewed: leader.needsReview !== true && plan != null,
      invalidReasons: tagList(leader.invalidReasons),
      htf: tagList(leader.htfConfluence), ltf: tagList(leader.ltfConfluence),
      emotions: tagList(leader.emotions), mistakes: tagList(leader.mistakes),
      management: history ? managementOf(history, entryAt, exitAt, facts.entryPrice, long, 0.25) : null,
    });
  }

  // Pořadí ve dni a návaznost: po ztrátě, otočení směru, odstup od výstupu.
  decisions.sort((a, b) => a.entryAt - b.entryAt || a.id.localeCompare(b.id));
  const lastByDay = new Map<string, LabDecision>();
  for (const decision of decisions) {
    const previous = lastByDay.get(decision.dayKey);
    decision.orderInDay = previous ? previous.orderInDay + 1 : 1;
    if (previous) {
      decision.minutesSincePrevExit = Math.max(0, (decision.entryAt - previous.exitAt) / 60_000);
      decision.afterLoss = previous.pnlUsd < 0;
      decision.directionFlip = previous.direction !== decision.direction;
    }
    lastByDay.set(decision.dayKey, decision);
  }
  return decisions;
}

/** Id leaderů, kterým chybí historie plnění — Lab je dotáhne dávkou. */
export function labMissingHistoryIds(decisions: readonly LabDecision[], histories: ReadonlyMap<string, TradeExecutionHistory>): string[] {
  return decisions.filter(decision => decision.management == null && !histories.has(decision.leaderTradeId)).map(decision => decision.leaderTradeId);
}
