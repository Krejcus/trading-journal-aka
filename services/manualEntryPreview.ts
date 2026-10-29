import { evaluateRiskGate, type RiskGateContext } from './copierRiskGate';
import { followerQuantity } from './copierEngine';
import { pointValueUsd } from './futuresContractSpecs';
import type { BrokerOrderRequest } from './brokerPort';
import {
  copyGroupConfigHash,
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

/** Strop ručního vstupu, dokud nebude nastavení s UI a perzistencí (fáze 1c = 1 kontrakt). */
export const MANUAL_ENTRY_MAX_CONTRACTS = 1;
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
}

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
  if (command.quantity > MANUAL_ENTRY_MAX_CONTRACTS) blockers.push(blocker('manual-cap', `Ruční vstup je zatím omezený na ${MANUAL_ENTRY_MAX_CONTRACTS} kontrakt.`));
  const long = command.side === 'Buy';
  if (long ? !(command.stopLoss < command.price) : !(command.stopLoss > command.price)) blockers.push(blocker('stop-side', 'SL je na špatné straně vstupu.'));
  if (long ? !(command.takeProfit > command.price) : !(command.takeProfit < command.price)) blockers.push(blocker('target-side', 'TP je na špatné straně vstupu.'));
  if (!input.frontSymbols.includes(command.symbol)) blockers.push(blocker('symbol-not-front', `Kontrakt ${command.symbol} není aktuální front (${input.frontSymbols.join(' / ')}).`));
  else if (input.frontSymbols.length > 1) notes.push(blocker('roll-window', `Týden rollu — ověř, že ${command.symbol} je kontrakt, který chceš.`));
  if (command.orderType === 'Limit') notes.push(blocker('limit-marketability', 'Jestli limit není přes trh, ověří až broker (vyplnil by se hned).'));
  notes.push(blocker('leader-can-trade', 'Oprávnění leadera obchodovat náhled nečte (žádné volání brokera) — ověří odeslání.'));

  const pointValue = pointValueUsd(command.symbol);
  if (pointValue == null) blockers.push(blocker('point-value', 'Neznámá hodnota bodu kontraktu.'));
  const fee = FEE_PER_CONTRACT_USD[command.symbol.replace(/[FGHJKMNQUVXZ]\d$/, '')] ?? 5;
  const lossPerContract = pointValue == null ? null
    : (Math.abs(command.price - command.stopLoss) + MANUAL_ENTRY_SLIPPAGE_TICKS * TICK) * pointValue + fee;
  const swingPerContract = pointValue == null ? null
    : (Math.abs(command.takeProfit - command.stopLoss) + MANUAL_ENTRY_SLIPPAGE_TICKS * TICK) * pointValue + fee;

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

  checkAccount(group.leaderAccountId, 'Leader', command.quantity);
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
      { tag: 'preview', accountId: follower.accountId, symbol: command.symbol, side: command.side, quantity, orderType: command.orderType, ...(command.orderType === 'Limit' ? { limitPrice: command.price } : { stopPrice: command.price }) },
      { tag: 'previews', accountId: follower.accountId, symbol: command.symbol, side: exit, quantity, orderType: 'Stop', stopPrice: command.stopLoss },
      { tag: 'previewt', accountId: follower.accountId, symbol: command.symbol, side: exit, quantity, orderType: 'Limit', limitPrice: command.takeProfit },
    ];
    const decision = evaluateRiskGate(gateRequests, input.riskGate);
    const reasons = [...new Set(decision.blocked.map(entry => entry.reason))];
    if (decision.haltReason) continue; // halt hlásí leader výš
    if (reasons.length) { blockers.push(blocker('follower-gate', `${label}: kopírka by odmítla (${reasons.join(', ')}).`)); continue; }
    followers.push({ accountId: follower.accountId, side: command.side, quantity, orderType: command.orderType, price: command.price, stopLoss: command.stopLoss, takeProfit: command.takeProfit });
  }
  const leaderDecision = evaluateRiskGate([{ tag: 'preview', accountId: group.leaderAccountId, symbol: command.symbol, side: command.side, quantity: command.quantity, orderType: command.orderType }], { ...input.riskGate, maxQuantityPerAccount: new Map(), ineligibleAccounts: new Map() });
  if (leaderDecision.haltReason) blockers.push(blocker('halt', `Kopírka teď nesmí posílat: ${leaderDecision.haltReason}.`));
  if (!followers.length && !blockers.some(issue => issue.code === 'halt')) blockers.push(blocker('no-follower-would-copy', 'Kopii by nedostal žádný follower — vstup jen na leadera zatím není podporovaný.'));

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
    price: command.price, stopLoss: command.stopLoss, takeProfit: command.takeProfit,
  };
  return result({ leader, followers });
}
