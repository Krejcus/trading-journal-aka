import { evaluateRiskGate, type RiskGateContext } from './copierRiskGate';
import { followerQuantity } from './copierEngine';
import { pointValueUsd } from './futuresContractSpecs';
import type { BrokerOrderRequest } from './brokerPort';
import {
  copyGroupConfigHash,
  isBareLeaderEntry,
  leaderEntryRiskPrice,
  LEADER_ENTRY_MARKET_QUOTE_MAX_AGE_MS,
  LEADER_ENTRY_MARKET_QUOTE_MAX_SKEW_MS,
  type LeaderEntryPreviewCommand,
  type LeaderEntryPreviewIssue,
  type LeaderEntryPreviewOrder,
  type LeaderEntryPreviewResult,
} from '../lib/leaderEntryPreview';

/**
 * Fáze 1a obchodování z grafu (docs/CHART_ORDER_ENTRY_PLAN.md §8, §8.1):
 * ČISTÉ vyhodnocení náhledu ručního vstupu na leadera. Controller sebere
 * zmrazené vstupy (bez IO, bez auditu), tady se jen počítá — modul nemá
 * přístup k brokerovi ani ke stavu kopírky, takže nic zapsat nemůže.
 * „Náhled OK“ ≠ „kopírka by zkopírovala“ ≠ „broker přijal“: odeslání
 * (fáze 1b) musí všechno přepočítat znovu.
 */

/**
 * Výchozí strop ručního vstupu (fáze 1c = 1 kontrakt). Skupina ho smí zvýšit jen
 * instalačním `manualEntryMaxContracts` (manual-only DEMO, nejvýš
 * `MANUAL_ENTRY_GROUP_CAP_MAX`); běžné skupiny zůstávají na 1.
 */
export const MANUAL_ENTRY_MAX_CONTRACTS = 1;
export const MANUAL_ENTRY_GROUP_CAP_MAX = 5;
/** Platný strop ručního vstupu skupiny: instalační hodnota jen u manual-only, jinak 1. */
export function manualEntryContractCap(group: { manualOnly?: boolean; localOnly?: boolean; manualEntryMaxContracts?: number } | null | undefined): number {
  const raw = group?.manualEntryMaxContracts;
  if (group?.manualOnly !== true || group.localOnly !== true || raw == null) return MANUAL_ENTRY_MAX_CONTRACTS;
  return Number.isSafeInteger(raw) && raw >= 1 && raw <= MANUAL_ENTRY_GROUP_CAP_MAX ? raw : MANUAL_ENTRY_MAX_CONTRACTS;
}
/** Market: kotace workeru z IBKR nejvýš tak stará a nejvýš tolik ticků od ceny, kterou viděl uživatel. */
export const MANUAL_ENTRY_MARKET_WORKER_QUOTE_MAX_AGE_MS = 3_000;
/** Původ kontraktu (i Limit/Stop): poslední kotace IBKR nejvýš tak stará (klidná noc). */
export const MANUAL_ENTRY_CONTRACT_QUOTE_MAX_AGE_MS = 15_000;
export const MANUAL_ENTRY_MARKET_MAX_QUOTE_DRIFT_TICKS = 8;
/**
 * Market: SL i TP aspoň tolik ticků od ceny, kterou viděl uživatel, i od kotace
 * workeru (≥ drift + skluz) — skluz fillu nesmí nohu přehodit přes trh.
 */
export const MANUAL_ENTRY_MARKET_MIN_BRACKET_TICKS = 16;

/** Kotace workeru z IBKR (vlákno ceny): poslední obchod a bid/ask s časy (hodiny procesu). */
export interface ManualEntryWorkerQuote {
  contract: string;
  last: number;
  lastAt: number;
  bid: number | null;
  ask: number | null;
  quoteAt: number | null;
}

/** Nejčerstvější cena workeru pro stranu Marketu (Buy = ask, Sell = bid, jinak last), nebo null = stará. */
export function workerMarketPrice(quote: ManualEntryWorkerQuote | null, side: 'Buy' | 'Sell', now: number): number | null {
  if (!quote) return null;
  const fresh = (at: number | null) => at != null && now - at <= MANUAL_ENTRY_MARKET_WORKER_QUOTE_MAX_AGE_MS && at <= now + LEADER_ENTRY_MARKET_QUOTE_MAX_SKEW_MS;
  const sidePrice = side === 'Buy' ? quote.ask : quote.bid;
  if (sidePrice != null && sidePrice > 0 && fresh(quote.quoteAt)) return sidePrice;
  return fresh(quote.lastAt) && quote.last > 0 ? quote.last : null;
}

/**
 * Brány Marketu nad kotacemi (čisté; stejně v náhledu i synchronně těsně před POSTem):
 * stáří ceny klienta, čerstvá cena workeru z IBKR, posun trhu a vzdálenost nohou.
 */
export function manualEntryMarketQuoteBlockers(
  command: Pick<LeaderEntryPreviewCommand, 'side' | 'referencePrice' | 'quoteReceivedAt' | 'stopLoss' | 'takeProfit'>,
  quote: ManualEntryWorkerQuote | null,
  now: number,
): LeaderEntryPreviewIssue[] {
  const issues: LeaderEntryPreviewIssue[] = [];
  const reference = command.referencePrice!;
  const quoteAge = now - command.quoteReceivedAt!;
  if (command.quoteReceivedAt! > now + LEADER_ENTRY_MARKET_QUOTE_MAX_SKEW_MS || quoteAge > LEADER_ENTRY_MARKET_QUOTE_MAX_AGE_MS) {
    issues.push(blocker('market-quote-stale', `Cena, ze které jsi Market poslal, je stará ${Math.round(quoteAge / 100) / 10} s — nic se neodešle.`));
  }
  const market = workerMarketPrice(quote, command.side, now);
  if (market == null) {
    issues.push(blocker('market-worker-quote-stale', 'Worker nemá čerstvou cenu z IBKR (≤ 3 s) — Market teď nejde.'));
    return issues;
  }
  if (Math.abs(market - reference) > MANUAL_ENTRY_MARKET_MAX_QUOTE_DRIFT_TICKS * TICK + 1e-9) {
    issues.push(blocker('market-quote-drift', `Trh se od ceny, kterou jsi viděl, pohnul o víc než ${MANUAL_ENTRY_MARKET_MAX_QUOTE_DRIFT_TICKS} ticků — nic se neodešle.`));
  }
  if (isBareLeaderEntry(command)) return issues;
  const minDistance = MANUAL_ENTRY_MARKET_MIN_BRACKET_TICKS * TICK - 1e-9;
  const tooClose = [reference, market].some(price => Math.abs(price - command.stopLoss) < minDistance || Math.abs(price - command.takeProfit) < minDistance);
  const long = command.side === 'Buy';
  const wrongSide = long ? !(command.stopLoss < market && command.takeProfit > market) : !(command.stopLoss > market && command.takeProfit < market);
  if (tooClose || wrongSide) {
    issues.push(blocker('market-bracket-too-close', `U Marketu musí být SL i TP aspoň ${MANUAL_ENTRY_MARKET_MIN_BRACKET_TICKS} ticků od ceny i od trhu.`));
  }
  return issues;
}

/** Cena vstupu pro riziko Marketu: horší z ceny, kterou viděl uživatel, a ceny workeru. */
export function manualEntryMarketRiskPrice(side: 'Buy' | 'Sell', reference: number, quote: ManualEntryWorkerQuote | null, now: number): number {
  const market = workerMarketPrice(quote, side, now);
  if (market == null) return reference;
  return side === 'Buy' ? Math.max(reference, market) : Math.min(reference, market);
}
/** Market: skluz vstupu v tickách navíc k rezervě SL. */
export const MANUAL_ENTRY_MARKET_SLIPPAGE_TICKS = 4;
/** Náhled musí mít aspoň tolik času do konce okna / session / ARM. */
export const MANUAL_ENTRY_END_RESERVE_MS = 5 * 60_000;
/** Čerstvost risk snapshotu účtu (stejná jako ARM). */
export const MANUAL_ENTRY_RISK_MAX_AGE_MS = 90_000;
/** Skluz SL v tickách a poplatky za kontrakt (round turn, odhad) do rizika. */
export const MANUAL_ENTRY_SLIPPAGE_TICKS = 2;
const FEE_PER_CONTRACT_USD: Record<string, number> = { MNQ: 1.5, NQ: 5 };
const TICK = 0.25;

export interface ManualEntryAccountRisk {
  verifiedAt: number;
  sameSession: boolean;
  error: string | null;
  realizedPnlUsd: number | null;
  openPnlUsd: number | null;
  netLiq: number | null;
  cashBalanceUsd: number | null;
  minNetLiq: number | null;
  dailyLossAutoLiq: number | null;
  effectiveDailyLossCutUsd: number | null;
}

export interface ManualEntryAccountInputs {
  /** Pozice podle symbolu; null = účet nemá ověřený záznam (≠ flat). */
  positions: ReadonlyArray<{ symbol: string; net: number }> | null;
  /** Otevřené příkazy (zbytek k vyplnění); null = neověřeno. */
  liveOrders: ReadonlyArray<{ symbol: string; side: 'Buy' | 'Sell'; remaining: number }> | null;
  /** Rozpracovaný cut (zavírání kopie neskončilo) = blocker; hotový = jen nedostane. */
  cut: 'none' | 'in-progress' | 'done';
  syncPaused: boolean;
  risk: ManualEntryAccountRisk | null;
}

export interface ManualEntryPreviewInputs {
  now: number;
  command: LeaderEntryPreviewCommand;
  group: {
    id: string;
    enabled: boolean;
    manualOnly?: boolean;
    localOnly?: boolean;
    manualEntryMaxContracts?: number;
    leaderAccountId: number | null;
    followers: ReadonlyArray<{ accountId: number; mode: string; multiplier: number; enabled?: boolean; maxContracts?: number | null; dailyLossCutUsd?: number | null }>;
    safety?: { dailyLossLimitUsd?: number; dailyMaxLosingTrades?: number; dailyMaxTrades?: number } | null;
  } | null;
  /** Kontext risk gate PŘESNĚ jako dispatch (sequenceBroken a stuckOutbox už složené). */
  riskGate: RiskGateContext;
  /** Blokery bez IO sebrané controllerem: recovery, startup repair, klid skupiny… (text = důvod). */
  stateBlockers: ReadonlyArray<LeaderEntryPreviewIssue>;
  reconciliationRequired: boolean;
  positionCheckComplete: boolean;
  managementOnly: boolean;
  dayLockPending: boolean;
  dayLockUntil: number;
  pauseUntil: number;
  pauseActive: boolean;
  entryCooldownUntil: number;
  unconfirmedFlatLots: number;
  tradingWindowState: 'inside' | 'outside' | 'off';
  /** Stav obchodního okna za `MANUAL_ENTRY_END_RESERVE_MS` (okno nesmí během rezervy skončit). */
  tradingWindowStateAfterReserve: 'inside' | 'outside' | 'off';
  sessionEndAt: number;
  /** Konec zapnutí kopírky; null = není zapnutá nebo bez TTL. */
  armExpiresAt: number | null;
  transportResumePending: boolean;
  dailyStats: { realizedPnlUsd: number; losingTrades: number; tradesToday: number };
  /** Poslední fill / uzavřený obchod skupiny; risk snapshot musí být novější. */
  lastGroupFillAt: number | null;
  accounts: ReadonlyMap<number, ManualEntryAccountInputs>;
  /** Účty vyřazené z nových vstupů (eligibility + vypnutí + cut) s důvodem. */
  entryIneligible: ReadonlyMap<number, string>;
  /** Ručně vyřazení followeři s cizí expozicí. */
  excludedFollowers: ReadonlySet<number>;
  /** Kandidáti front kontraktu (aktuální; kolem rollu i příští). */
  frontSymbols: readonly string[];
  /**
   * Poslední kotace workeru z IBKR (konkrétní kontrakt, jen když je IBKR aktivní
   * zdroj); null = není. Jen odhad rizika Marketu a původ kontraktu — nikdy TV.
   */
  workerQuote: ManualEntryWorkerQuote | null;
  /**
   * Front kontrakt podle brokera (Tradovate splatnost `isFront`) a kdy se přečetl.
   * Původ kontraktu pro Limit/Stop, když kotace IBKR chybí; Market ho nikdy nestačí.
   */
  brokerFront?: { contract: string; at: number } | null;
}

/** Jak starý smí být front kontrakt od brokera (obnovuje se po 5 min). */
export const MANUAL_ENTRY_BROKER_FRONT_MAX_AGE_MS = 30 * 60_000;

const blocker = (code: string, text: string): LeaderEntryPreviewIssue => ({ code, text });

/** Zbývá do nejbližšího limitu účtu: MIN ze všech známých, zisk rezervu nezvětšuje. */
export function remainingLossHeadroom(risk: ManualEntryAccountRisk, configuredCutUsd: number | null = null): { dailyUsd: number | null; drawdownUsd: number | null; cutUsd: number | null } {
  const result = (risk.realizedPnlUsd ?? 0) + (risk.openPnlUsd ?? 0);
  const loss = Math.min(0, result);
  // DLL 0 / záporné = broker limit nenastavil (ne „nula zbývá“).
  const dailyUsd = risk.dailyLossAutoLiq != null && risk.dailyLossAutoLiq > 0 ? risk.dailyLossAutoLiq + loss : null;
  const equity = risk.netLiq ?? (risk.cashBalanceUsd != null ? risk.cashBalanceUsd + (risk.openPnlUsd ?? 0) : null);
  const drawdownUsd = equity != null && risk.minNetLiq != null ? equity - risk.minNetLiq : null;
  // Cut followera: přísnější z nastaveného a platného efektivního (prop rezerva).
  const cuts = [risk.effectiveDailyLossCutUsd, configuredCutUsd].filter((value): value is number => value != null && value > 0);
  const cutUsd = cuts.length ? Math.min(...cuts) + loss : null;
  return { dailyUsd, drawdownUsd, cutUsd };
}

/** Ztráta při SL stejným vzorcem jako náhled (skluz + poplatky); null = neznámá hodnota bodu. */
export function manualStopLossUsd(symbol: string, entry: number, stop: number, quantity: number): number | null {
  const pointValue = pointValueUsd(symbol);
  if (pointValue == null) return null;
  const fee = FEE_PER_CONTRACT_USD[symbol.replace(/[FGHJKMNQUVXZ]\d$/, '')] ?? 5;
  return ((Math.abs(entry - stop) + MANUAL_ENTRY_SLIPPAGE_TICKS * TICK) * pointValue + fee) * quantity;
}

/** Nejhorší otevřená expozice na symbolu po přidání příkazu — stejný vzorec jako `exposureCappedBroker`. */
function exceedsMaxContracts(account: ManualEntryAccountInputs, symbol: string, side: 'Buy' | 'Sell', quantity: number, cap: number): boolean {
  const current = (account.positions ?? []).filter(position => position.symbol === symbol).reduce((sum, position) => sum + position.net, 0);
  const orders = (account.liveOrders ?? []).filter(order => order.symbol === symbol);
  const pendingBuy = orders.filter(order => order.side === 'Buy').reduce((sum, order) => sum + order.remaining, 0);
  const pendingSell = orders.filter(order => order.side === 'Sell').reduce((sum, order) => sum + order.remaining, 0);
  const worstLong = current + pendingBuy + (side === 'Buy' ? quantity : 0);
  const worstShort = current - pendingSell - (side === 'Sell' ? quantity : 0);
  return worstLong > Math.floor(cap) || worstShort < -Math.floor(cap);
}

export function evaluateManualEntryPreview(input: ManualEntryPreviewInputs): LeaderEntryPreviewResult {
  const { command, group, now } = input;
  const blockers: LeaderEntryPreviewIssue[] = [];
  const notes: LeaderEntryPreviewIssue[] = [];
  const result = (wouldPlace: LeaderEntryPreviewResult['wouldPlace']): LeaderEntryPreviewResult => ({
    type: 'leader-entry-preview', operationId: command.operationId, checkedAt: now, symbol: command.symbol,
    wouldPlace: blockers.length ? null : wouldPlace, blockers, notes,
  });

  if (!group || group.leaderAccountId == null || group.id !== command.groupId) {
    blockers.push(blocker('group-missing', 'Worker nemá tuto skupinu.'));
    return result(null);
  }
  if (group.leaderAccountId !== command.leaderAccountId) blockers.push(blocker('not-leader', 'Účet není leader skupiny workeru.'));
  if (!group.enabled) blockers.push(blocker('group-disabled', 'Skupina je vypnutá.'));

  // Záměr: co uživatel viděl, musí sedět s tím, co worker teď má.
  if (copyGroupConfigHash(group) !== command.intent.groupConfigHash) blockers.push(blocker('intent-config-changed', 'Nastavení skupiny se od náhledu v panelu změnilo — obnov panel.'));
  if (input.riskGate.armedAt !== command.intent.armedAt) blockers.push(blocker('intent-arm-changed', 'Kopírka byla mezitím vypnuta nebo znovu zapnuta.'));

  // Stav kopírky jako dispatch + ARM.
  if (input.riskGate.shadowMode) blockers.push(blocker('shadow', 'Kopírka je ve stínovém režimu.'));
  for (const issue of input.stateBlockers) blockers.push(issue);
  if (input.reconciliationRequired || !input.positionCheckComplete) blockers.push(blocker('reconciliation-required', 'Worker čeká na kontrolu pozic.'));
  if (input.managementOnly) blockers.push(blocker('management-only', 'Kopírka jen spravuje otevřené kopie.'));
  if (input.dayLockPending) blockers.push(blocker('day-lock-pending', 'Denní zámek čeká na flat.'));
  if (input.dayLockUntil > now) blockers.push(blocker('day-lock', 'Den je zamčený.'));
  if (input.pauseActive && input.pauseUntil > now) blockers.push(blocker('pause', 'Kopírka je pozastavená pravidlem dne.'));
  if (input.entryCooldownUntil > now) blockers.push(blocker('cooldown', 'Běží anti-revenge cooldown.'));
  if (input.unconfirmedFlatLots > 0) blockers.push(blocker('unconfirmed-flat', 'Nepotvrzený výsledek uzavření leadera v této session.'));
  if (input.tradingWindowState === 'outside') blockers.push(blocker('outside-window', 'Mimo obchodní okno.'));
  if (input.transportResumePending) blockers.push(blocker('transport-resume', 'Běží automatické pokračování po výpadku.'));
  const reserve = (end: number | null, code: string, text: string) => {
    if (end != null && end - now < MANUAL_ENTRY_END_RESERVE_MS) blockers.push(blocker(code, text));
  };
  if (input.tradingWindowState === 'inside' && input.tradingWindowStateAfterReserve !== 'inside') blockers.push(blocker('window-ending', 'Obchodní okno končí do 5 minut.'));
  reserve(input.sessionEndAt, 'session-ending', 'Broker session končí do 5 minut (17:00 CT).');
  reserve(input.armExpiresAt, 'arm-expiring', 'Zapnutí kopírky vyprší do 5 minut.');

  // Pravidla dne čistě ze stavu dne (bez vyhodnocování s efekty).
  const safety = group.safety ?? {};
  if ((safety.dailyMaxTrades ?? 0) > 0 && input.dailyStats.tradesToday >= safety.dailyMaxTrades!) blockers.push(blocker('daily-max-trades', 'Dosažen počet obchodů dne (ruční vstup je přísnější než kopírka).'));
  if ((safety.dailyMaxLosingTrades ?? 0) > 0 && input.dailyStats.losingTrades >= safety.dailyMaxLosingTrades!) blockers.push(blocker('daily-max-losing', 'Dosažen počet ztrátových obchodů dne (ruční vstup je přísnější než kopírka).'));
  if ((safety.dailyLossLimitUsd ?? 0) > 0 && -input.dailyStats.realizedPnlUsd >= safety.dailyLossLimitUsd!) blockers.push(blocker('daily-loss-limit', 'Dosažena denní ztráta skupiny (ruční vstup je přísnější než kopírka).'));

  // Příkaz samotný.
  const cap = manualEntryContractCap(group);
  if (command.quantity > cap) blockers.push(blocker('manual-cap', `Ruční vstup je omezený na ${cap} ${cap === 1 ? 'kontrakt' : 'kontrakty'} (strop skupiny).`));
  const long = command.side === 'Buy';
  const market = command.orderType === 'Market';
  // Nativní Market jen v instalační manual-only DEMO skupině bez followerů: korelace
  // OSO kopírky Market rodiče nezná a kopie by vznikla bez nohou (oponentura 2. 11.).
  if (market && !(group.manualOnly === true && group.localOnly === true && group.followers.length === 0 && input.riskGate.brokerEnvironment === 'demo')) {
    blockers.push(blocker('market-manual-only', 'Market z appky je zatím jen pro ruční DEMO účet bez followerů.'));
  }
  const entryPrice = market
    ? manualEntryMarketRiskPrice(command.side, command.referencePrice!, input.workerQuote, now)
    : leaderEntryRiskPrice(command);
  // Holý Market (telefonní lišta, Filip 1. 11.): bez nohou, vědomě bez ochrany; SL/TP doplní attach-brackets.
  const bare = isBareLeaderEntry(command);
  if (bare) {
    notes.push(blocker('bare-unprotected', 'Market bez SL/TP — pozice je bez ochrany, dokud nohy nedoplníš.'));
  } else {
    if (long ? !(command.stopLoss! < entryPrice) : !(command.stopLoss! > entryPrice)) blockers.push(blocker('stop-side', 'SL je na špatné straně vstupu.'));
    if (long ? !(command.takeProfit! > entryPrice) : !(command.takeProfit! < entryPrice)) blockers.push(blocker('target-side', 'TP je na špatné straně vstupu.'));
  }
  if (!input.frontSymbols.includes(command.symbol)) blockers.push(blocker('symbol-not-front', `Kontrakt ${command.symbol} není aktuální front (${input.frontSymbols.join(' / ')}).`));
  else if (input.frontSymbols.length > 1) notes.push(blocker('roll-window', `Týden rollu — ověř, že ${command.symbol} je kontrakt, který chceš.`));
  // Původ kontraktu (2. 11. 2026): stejný konkrétní kontrakt musí mít čerstvou kotaci
  // workeru z IBKR. Kalendář sám nestačí, cena z TV se nepočítá.
  const workerQuote = input.workerQuote;
  const quoteSeenAt = workerQuote ? Math.max(workerQuote.lastAt, workerQuote.quoteAt ?? 0) : null;
  const lineageFresh = quoteSeenAt != null && now - quoteSeenAt <= MANUAL_ENTRY_CONTRACT_QUOTE_MAX_AGE_MS && quoteSeenAt <= now + LEADER_ENTRY_MARKET_QUOTE_MAX_SKEW_MS;
  // Původ kontraktu: kotace IBKR (≤ 15 s), u Limit/Stop jinak front od brokera (≤ 30 min).
  // Rozpor IBKR s příkazem blokuje vždy; Market potřebuje IBKR vždy (cena).
  const brokerFront = input.brokerFront ?? null;
  const brokerFrontFresh = brokerFront != null && now - brokerFront.at <= MANUAL_ENTRY_BROKER_FRONT_MAX_AGE_MS && brokerFront.at <= now + LEADER_ENTRY_MARKET_QUOTE_MAX_SKEW_MS;
  if (workerQuote && lineageFresh) {
    if (workerQuote.contract !== command.symbol) blockers.push(blocker('contract-mismatch', `Kontrakt ${command.symbol} nesedí s kotací workeru z IBKR (${workerQuote.contract}).`));
  } else if (command.orderType === 'Limit' && brokerFrontFresh) {
    // Jen Limit (Filip 1. 11.: „když IBKR spadne, pojedou jen vzdálené Limity“); Stop bez trhu ne.
    if (brokerFront!.contract !== command.symbol) blockers.push(blocker('contract-mismatch', `Kontrakt ${command.symbol} není front podle brokera (${brokerFront!.contract}).`));
    else notes.push(blocker('contract-broker-front', `Kontrakt ověřen podle brokera (${brokerFront!.contract}), IBKR teď neběží.`));
  } else {
    blockers.push(blocker('contract-unverified', market
      ? 'Worker nemá čerstvou kotaci z IBKR — Market teď nejde.'
      : command.orderType === 'Stop'
        ? 'Worker nemá čerstvou kotaci z IBKR — Stop teď nejde (bez IBKR jen Limit).'
        : 'Worker nemá čerstvou kotaci z IBKR ani front kontrakt od brokera — kontrakt teď nejde ověřit.'));
  }
  if (market) blockers.push(...manualEntryMarketQuoteBlockers(command, workerQuote, now));
  if (command.orderType === 'Limit') notes.push(blocker('limit-marketability', 'Jestli limit není přes trh, ověří až broker (vyplnil by se hned).'));
  notes.push(blocker('leader-can-trade', 'Oprávnění leadera obchodovat náhled nečte (žádné volání brokera) — ověří odeslání.'));

  const pointValue = pointValueUsd(command.symbol);
  if (pointValue == null) blockers.push(blocker('point-value', 'Neznámá hodnota bodu kontraktu.'));
  const fee = FEE_PER_CONTRACT_USD[command.symbol.replace(/[FGHJKMNQUVXZ]\d$/, '')] ?? 5;
  const slippageTicks = MANUAL_ENTRY_SLIPPAGE_TICKS + (market ? MANUAL_ENTRY_MARKET_SLIPPAGE_TICKS : 0);
  const lossPerContract = pointValue == null || bare ? null
    : (Math.abs(entryPrice - command.stopLoss!) + slippageTicks * TICK) * pointValue + fee;
  const swingPerContract = pointValue == null || bare ? null
    : (Math.abs(command.takeProfit! - command.stopLoss!) + slippageTicks * TICK) * pointValue + fee;

  const checkAccount = (accountId: number, label: string, quantity: number, configuredCutUsd: number | null = null) => {
    const account = input.accounts.get(accountId);
    if (!account || account.positions == null || account.liveOrders == null) {
      blockers.push(blocker('account-unverified', `${label}: pozice nebo příkazy nejsou ověřené.`));
      return;
    }
    if (account.positions.some(position => position.net !== 0) || account.liveOrders.length > 0) {
      blockers.push(blocker('account-not-flat', `${label}: má otevřenou pozici nebo příkaz.`));
    }
    if (account.cut === 'in-progress') blockers.push(blocker('cut-in-progress', `${label}: zavírání kopie po cutu ještě neskončilo.`));
    const risk = account.risk;
    if (!risk || risk.error || !risk.sameSession || now - risk.verifiedAt > MANUAL_ENTRY_RISK_MAX_AGE_MS
      || (input.lastGroupFillAt != null && risk.verifiedAt <= input.lastGroupFillAt)) {
      blockers.push(blocker('risk-unverified', `${label}: denní limit není čerstvě ověřený.`));
      return;
    }
    const headroom = remainingLossHeadroom(risk, configuredCutUsd);
    const known = [headroom.dailyUsd, headroom.drawdownUsd, headroom.cutUsd].filter((value): value is number => value != null);
    if (!known.length) { blockers.push(blocker('risk-unknown', `${label}: žádný limit účtu není známý.`)); return; }
    if (lossPerContract == null || swingPerContract == null) return;
    const loss = lossPerContract * quantity;
    const swing = swingPerContract * quantity;
    const daily = [headroom.dailyUsd, headroom.cutUsd].filter((value): value is number => value != null);
    if (daily.some(left => loss > left)) blockers.push(blocker('risk-daily', `${label}: ztráta při SL (~${Math.round(loss)} $) je víc, než zbývá do denního limitu (${Math.round(Math.max(0, Math.min(...daily)))} $).`));
    if (headroom.drawdownUsd != null && swing > headroom.drawdownUsd) blockers.push(blocker('risk-drawdown', `${label}: rezerva DD (${Math.round(Math.max(0, headroom.drawdownUsd))} $) nestačí na rozpětí TP–SL (~${Math.round(swing)} $).`));
  };

  // DEMO bez venue limitu má instalačně daný lokální denní strop. Jen tento
  // úzce označený režim ho smí použít jako známou rezervu leadera.
  checkAccount(
    group.leaderAccountId,
    'Leader',
    command.quantity,
    group.manualOnly === true ? safety.dailyLossLimitUsd ?? null : null,
  );
  const leaderIneligible = input.entryIneligible.get(group.leaderAccountId);
  if (leaderIneligible) blockers.push(blocker('leader-ineligible', `Leader nesmí nové vstupy: ${leaderIneligible}.`));
  if ((safety.dailyLossLimitUsd ?? 0) > 0 && lossPerContract != null) {
    const left = safety.dailyLossLimitUsd! + Math.min(0, input.dailyStats.realizedPnlUsd);
    if (lossPerContract * command.quantity > left) notes.push(blocker('group-daily-loss', `Ztráta při SL by překročila denní limit skupiny (zbývá ${Math.round(Math.max(0, left))} $).`));
  }

  // Followeři stejnou cestou jako processOsoPair: on-submit, floor(qty × násobek), risk gate.
  const exit = long ? 'Sell' : 'Buy';
  const followers: LeaderEntryPreviewOrder[] = [];
  for (const follower of group.followers) {
    const label = `Follower ${follower.accountId}`;
    if (follower.enabled === false || follower.mode === 'off' || input.excludedFollowers.has(follower.accountId)) continue;
    const ineligible = input.entryIneligible.get(follower.accountId);
    if (ineligible) { notes.push(blocker('follower-skipped', `${label} nedostane kopii: ${ineligible}.`)); continue; }
    if (follower.mode !== 'on-submit') { blockers.push(blocker('oso-on-fill-not-supported', `${label}: režim „po vyplnění“ OSO nekopíruje.`)); continue; }
    const quantity = followerQuantity(command.quantity, follower.multiplier);
    if (quantity <= 0) { blockers.push(blocker('scaled-quantity-zero', `${label}: po násobku vychází 0 kontraktů.`)); continue; }
    const account = input.accounts.get(follower.accountId);
    if (account?.syncPaused) { notes.push(blocker('follower-sync-paused', `${label} nedostane kopii: účet je mimo synchron.`)); continue; }
    if (follower.maxContracts != null && account && exceedsMaxContracts(account, command.symbol, command.side, quantity, follower.maxContracts)) {
      blockers.push(blocker('max-contracts', `${label}: překročil by strop ${follower.maxContracts} kontraktů.`));
    }
    if (follower.maxContracts != null) notes.push(blocker('max-contracts-fallback', `${label}: má strop kontraktů — při rozpadu OSO korelace by obchod vynechal.`));
    checkAccount(follower.accountId, label, quantity, follower.dailyLossCutUsd ?? null);
    const gateRequests: BrokerOrderRequest[] = [
      { tag: 'preview', accountId: follower.accountId, symbol: command.symbol, side: command.side, quantity, orderType: command.orderType, ...(command.orderType === 'Limit' ? { limitPrice: command.price } : command.orderType === 'Stop' ? { stopPrice: command.price } : {}) },
      { tag: 'previews', accountId: follower.accountId, symbol: command.symbol, side: exit, quantity, orderType: 'Stop', stopPrice: command.stopLoss },
      { tag: 'previewt', accountId: follower.accountId, symbol: command.symbol, side: exit, quantity, orderType: 'Limit', limitPrice: command.takeProfit },
    ];
    const decision = evaluateRiskGate(gateRequests, input.riskGate);
    const reasons = [...new Set(decision.blocked.map(entry => entry.reason))];
    if (decision.haltReason) continue; // halt hlásí leader výš
    if (reasons.length) { blockers.push(blocker('follower-gate', `${label}: kopírka by odmítla (${reasons.join(', ')}).`)); continue; }
    followers.push({ accountId: follower.accountId, side: command.side, quantity, orderType: command.orderType, price: entryPrice, stopLoss: command.stopLoss ?? null, takeProfit: command.takeProfit ?? null });
  }
  const leaderDecision = evaluateRiskGate([{ tag: 'preview', accountId: group.leaderAccountId, symbol: command.symbol, side: command.side, quantity: command.quantity, orderType: command.orderType }], { ...input.riskGate, maxQuantityPerAccount: new Map(), ineligibleAccounts: new Map() });
  if (leaderDecision.haltReason) blockers.push(blocker('halt', `Kopírka teď nesmí posílat: ${leaderDecision.haltReason}.`));
  if (!followers.length && group.manualOnly !== true && !blockers.some(issue => issue.code === 'halt')) {
    blockers.push(blocker('no-follower-would-copy', 'Kopii by nedostal žádný follower — vstup jen na leadera zatím není podporovaný.'));
  }

  // Množství followerů, která viděl uživatel, musí sedět s přepočtem.
  // Rozhoduje, co by worker opravdu poslal: kopie followerovi, kterého panel
  // neukázal, nebo s jiným počtem kontraktů = blocker. Follower z panelu, který
  // kopii nedostane, je v poznámkách.
  const seen = new Map(command.intent.followerQuantities.map(entry => [entry.accountId, entry.quantity]));
  if (followers.some(order => seen.get(order.accountId) !== order.quantity)) {
    blockers.push(blocker('intent-quantities-changed', 'Kontrakty followerů se od náhledu v panelu liší — obnov panel.'));
  }

  const leader: LeaderEntryPreviewOrder = {
    accountId: group.leaderAccountId, side: command.side, quantity: command.quantity, orderType: command.orderType,
    price: entryPrice, stopLoss: command.stopLoss ?? null, takeProfit: command.takeProfit ?? null,
  };
  return result({ leader, followers });
}
