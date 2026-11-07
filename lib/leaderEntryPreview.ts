import { stableHash64 } from '../services/copierKeys.js';

/**
 * Fáze 1a obchodování z grafu (docs/CHART_ORDER_ENTRY_PLAN.md §8): NÁHLED
 * ručního vstupu na leadera. Worker vyhodnotí brány a vrátí, co by poslal
 * a proč ne — k brokerovi nic nezapíše. Stejná validace na enqueue i claim
 * straně relaye a ve workeru (payload přichází z nevalidovaného JSON).
 */

export const LEADER_ENTRY_TICK = 0.25;
export const LEADER_ENTRY_MAX_QUANTITY = 50;
/** Ruční vstup jen na MNQ (2. 11. 2026): NQ, kontinuální řada ani jiný root neprojdou. */
export const LEADER_ENTRY_SYMBOL_PATTERN = /^MNQ[HMUZ]\d$/;
const SYMBOL_PATTERN = LEADER_ENTRY_SYMBOL_PATTERN;
/**
 * Market (2. 11. 2026): nejstarší kotace, ze které smí uživatel Market poslat
 * (stáří v okamžiku vyhodnocení ve workeru, včetně cesty relayí), a tolerance
 * hodin klienta do budoucna.
 */
export const LEADER_ENTRY_MARKET_QUOTE_MAX_AGE_MS = 5_000;
export const LEADER_ENTRY_MARKET_QUOTE_MAX_SKEW_MS = 2_000;
/** Holý Limit/Stop jde jen po jednom kontraktu; platí v relayi i ve workeru. */
export const LEADER_ENTRY_BARE_PENDING_QUANTITY = 1;
/** Vlastní jmenný prostor — náhled se nikdy nesmí plést s id skutečného odeslání. */
const OPERATION_ID_PATTERN = /^preview:[a-zA-Z0-9_-]{8,100}$/;

export interface LeaderEntryPreviewCommand {
  type: 'preview-leader-entry';
  groupId: string;
  operationId: string;
  leaderAccountId: number;
  /** Tradovate kontrakt, např. `MNQZ6`. */
  symbol: string;
  side: 'Buy' | 'Sell';
  quantity: number;
  /** `Market` = skutečný Market u brokera (bez `price`), nikdy převod na Limit. */
  orderType: LeaderEntryOrderType;
  /** Cena Limit/Stop; u Marketu chybí. */
  price?: number;
  /**
   * Cena, kterou uživatel viděl (Buy = ask, Sell = bid). U Marketu povinná —
   * jen odhad rizika a zobrazení, nikdy cena příkazu.
   */
  referencePrice?: number;
  /** Kdy klient kotaci přijal (epoch ms); u Marketu povinné. */
  quoteReceivedAt?: number;
  /**
   * SL a TP; obě chybí u holého Marketu z telefonní lišty (Filip 1. 11. 2026:
   * „market ihned bez SL/TP“) a u holého Limit/Stop po jednom kontraktu (7. 11. 2026) —
   * pozice je pak vědomě bez ochrany, dokud SL/TP nedoplní uživatel.
   */
  stopLoss?: number;
  takeProfit?: number;
  /**
   * Přikoupení do otevřené pozice (3. 11. 2026, návrh v4): pozice, kterou uživatel
   * viděl. Chybí = vstup jen z flat (dnešní brána `account-not-flat`). Worker při
   * jakékoli neshodě s čerstvým stavem vrátí `intent-position-changed`.
   */
  position?: LeaderEntryPositionIntent;
  /** Co uživatel viděl v náhledu panelu; worker musí přepočtem dojít ke stejnému. */
  intent: {
    armedAt: number;
    groupConfigHash: string;
    followerQuantities: Array<{ accountId: number; quantity: number }>;
  };
}

export type LeaderEntryOrderType = 'Limit' | 'Stop' | 'Market';

export interface LeaderEntryPositionIntent {
  mode: 'add';
  /** Strana pozice (= strana přikoupení). */
  side: 'Buy' | 'Sell';
  /** |pozice| leadera, kterou uživatel viděl. */
  quantity: number;
  /** Id vstupů vlastních lístků pozice ze statusu workeru (seřazená). */
  ticketEntryIds: string[];
}

export interface LeaderEntryPreviewIssue { code: string; text: string }

export interface LeaderEntryPreviewOrder {
  accountId: number;
  side: 'Buy' | 'Sell';
  quantity: number;
  orderType: LeaderEntryOrderType;
  /** U Marketu cena, kterou uživatel viděl (odhad), ne cena příkazu. */
  price: number;
  /** null = holý Market bez nohou. */
  stopLoss: number | null;
  takeProfit: number | null;
}

export interface LeaderEntryPreviewResult {
  type: 'leader-entry-preview';
  operationId: string;
  /** Kdy worker brány vyhodnotil — náhled platí jen pro tento okamžik. */
  checkedAt: number;
  symbol: string;
  /** Co by worker poslal: leader + kopie followerů (null = nic, jsou blockery). */
  wouldPlace: { leader: LeaderEntryPreviewOrder; followers: LeaderEntryPreviewOrder[] } | null;
  blockers: LeaderEntryPreviewIssue[];
  /** Informace, které vstup neblokují (follower nedostane kopii…). */
  notes: LeaderEntryPreviewIssue[];
}

const onTick = (value: number) => Math.abs(value * 4 - Math.round(value * 4)) < 1e-9;
const price = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1_000_000 && onTick(value);
const accountId = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const quantity = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= LEADER_ENTRY_MAX_QUANTITY;
const COMMAND_KEYS = ['type', 'groupId', 'operationId', 'leaderAccountId', 'symbol', 'side', 'quantity', 'orderType', 'price', 'referencePrice', 'quoteReceivedAt', 'stopLoss', 'takeProfit', 'position', 'intent'];
const POSITION_KEYS = ['mode', 'side', 'quantity', 'ticketEntryIds'];
const BROKER_ORDER_ID_PATTERN = /^[A-Za-z0-9-]{1,40}$/;
const epochMs = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 1_500_000_000_000 && value < 4_000_000_000_000;
const INTENT_KEYS = ['armedAt', 'groupConfigHash', 'followerQuantities'];

/** Striktní validace náhledu (whitelist klíčů, typy, tick); vyhodí `invalid-relay-command-payload`. */
export function validateLeaderEntryPreview(value: unknown): LeaderEntryPreviewCommand {
  const fail = () => { throw new Error('invalid-relay-command-payload'); };
  if (!value || typeof value !== 'object') fail();
  const command = value as Record<string, unknown>;
  if (Object.keys(command).some(key => !COMMAND_KEYS.includes(key))) fail();
  if (command.type !== 'preview-leader-entry') fail();
  if (typeof command.groupId !== 'string' || command.groupId.trim() === '' || command.groupId.length > 200) fail();
  if (typeof command.operationId !== 'string' || !OPERATION_ID_PATTERN.test(command.operationId)) fail();
  if (!accountId(command.leaderAccountId)) fail();
  if (typeof command.symbol !== 'string' || !SYMBOL_PATTERN.test(command.symbol)) fail();
  if (command.side !== 'Buy' && command.side !== 'Sell') fail();
  if (!quantity(command.quantity)) fail();
  if (command.orderType !== 'Limit' && command.orderType !== 'Stop' && command.orderType !== 'Market') fail();
  if (command.orderType === 'Market') {
    // Market nemá cenu příkazu; cena, kterou uživatel viděl, a čas kotace jsou povinné.
    if (command.price !== undefined || !price(command.referencePrice) || !epochMs(command.quoteReceivedAt)) fail();
  } else {
    if (!price(command.price)) fail();
    if (command.referencePrice !== undefined && !price(command.referencePrice)) fail();
    if (command.quoteReceivedAt !== undefined && !epochMs(command.quoteReceivedAt)) fail();
  }
  // Holý Market: SL i TP chybí oba (nikdy jen jedna noha).
  const bare = command.stopLoss === undefined && command.takeProfit === undefined;
  // Holý Limit/Stop (7. 11. 2026): u brokera opravdu bez nohou, jen po 1 kontraktu (dílčí fill zbytku bez ochrany neřešíme).
  if (bare ? (command.orderType !== 'Market' && command.quantity !== LEADER_ENTRY_BARE_PENDING_QUANTITY) : (!price(command.stopLoss) || !price(command.takeProfit))) fail();
  if (command.position !== undefined) {
    // Přikoupení: vždy se SL i TP (holé přikoupení nikdy), strana = strana pozice.
    const position = command.position as Record<string, unknown> | null;
    if (!position || typeof position !== 'object' || Array.isArray(position) || Object.keys(position).some(key => !POSITION_KEYS.includes(key))) fail();
    if (position!.mode !== 'add' || position!.side !== command.side || !quantity(position!.quantity) || bare) fail();
    const ids = position!.ticketEntryIds;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > LEADER_ENTRY_MAX_QUANTITY
      || ids.some(id => typeof id !== 'string' || !BROKER_ORDER_ID_PATTERN.test(id)) || new Set(ids).size !== ids.length) fail();
  }
  const intent = command.intent as Record<string, unknown> | null;
  if (!intent || typeof intent !== 'object' || Object.keys(intent).some(key => !INTENT_KEYS.includes(key))) fail();
  if (typeof intent!.armedAt !== 'number' || !Number.isSafeInteger(intent!.armedAt) || intent!.armedAt < 0) fail();
  if (typeof intent!.groupConfigHash !== 'string' || !/^[a-z0-9]{8,64}$/.test(intent!.groupConfigHash)) fail();
  const followers = intent!.followerQuantities;
  if (!Array.isArray(followers) || followers.length > 50) fail();
  for (const entry of followers as unknown[]) {
    const row = entry as Record<string, unknown> | null;
    if (!row || typeof row !== 'object' || Object.keys(row).some(key => key !== 'accountId' && key !== 'quantity')) fail();
    if (!accountId(row!.accountId) || typeof row!.quantity !== 'number' || !Number.isSafeInteger(row!.quantity) || row!.quantity < 0) fail();
  }
  return command as unknown as LeaderEntryPreviewCommand;
}

/**
 * Otisk konfigurace skupiny, na které náhled stojí — jen z polí, která nese
 * status workeru (id, zapnutí, leader, followeři: režim, zapnutí, násobek,
 * strop). Stejná funkce v panelu (ze statusu) i ve workeru; změna mezi
 * náhledem a vyhodnocením = blocker.
 */
export interface PreviewGroupShape {
  id: string;
  enabled: boolean;
  leaderAccountId: number | null;
  followers: ReadonlyArray<{ accountId: number; mode: string; multiplier: number; enabled?: boolean; maxContracts?: number | null }>;
}

export function copyGroupConfigHash(group: PreviewGroupShape): string {
  const followers = [...group.followers]
    .sort((left, right) => left.accountId - right.accountId)
    .map(follower => [follower.accountId, follower.mode, follower.multiplier, follower.enabled !== false, follower.maxContracts ?? null]);
  return stableHash64(JSON.stringify([group.id, group.enabled, group.leaderAccountId, followers]));
}

/** Co pošle panel objednávky (zbytek doplní desk ze stavu workeru). */
export interface LiveEntryPreviewDraft {
  /** Kontrakt, ze kterého jsou ceny v grafu (`MNQZ6`) — v týdnu rollu nikdy odhadem. */
  symbol: string;
  side: 'Buy' | 'Sell';
  quantity: number;
  orderType: LeaderEntryOrderType;
  price?: number;
  referencePrice?: number;
  quoteReceivedAt?: number;
  /** Obě chybí = holý Market. */
  stopLoss?: number;
  takeProfit?: number;
  /** Přikoupení do otevřené pozice (jen s capability `manual-entry-scale-in-v1`). */
  position?: LeaderEntryPositionIntent;
}

/** Holý Market (bez SL i TP)? */
export const isBareLeaderEntry = (command: { stopLoss?: number; takeProfit?: number }): boolean => command.stopLoss === undefined && command.takeProfit === undefined;

/** Cena vstupu pro odhad rizika a strany SL/TP: Limit/Stop cena příkazu, Market cena, kterou uživatel viděl. */
export function leaderEntryRiskPrice(command: { orderType: LeaderEntryOrderType; price?: number; referencePrice?: number }): number {
  return command.orderType === 'Market' ? command.referencePrice! : command.price!;
}

/**
 * Sestaví příkaz náhledu včetně záměru (zapnutí kopírky, otisk skupiny,
 * kontrakty followerů) ze stavu workeru. Followeři stejně jako kopírka:
 * zapnutí, ne vyřazení, ne vypnutí kopírkou, režim on-submit, floor(qty × násobek).
 */
export function buildLeaderEntryPreviewCommand(draft: LiveEntryPreviewDraft, context: {
  group: PreviewGroupShape & { leaderAccountId: number };
  armedAt: number;
  excludedFollowers: ReadonlySet<number>;
  participation: ReadonlyArray<{ accountId: number; effectiveEnabled: boolean }>;
  operationId: string;
}): LeaderEntryPreviewCommand {
  const active = new Map(context.participation.map(entry => [entry.accountId, entry.effectiveEnabled]));
  const followerQuantities = context.group.followers
    .filter(follower => follower.enabled !== false && follower.mode === 'on-submit'
      && !context.excludedFollowers.has(follower.accountId) && active.get(follower.accountId) !== false)
    .map(follower => ({ accountId: follower.accountId, quantity: Math.max(0, Math.floor(draft.quantity * follower.multiplier)) }));
  return {
    type: 'preview-leader-entry',
    groupId: context.group.id,
    operationId: context.operationId,
    leaderAccountId: context.group.leaderAccountId,
    ...draft,
    intent: { armedAt: context.armedAt, groupConfigHash: copyGroupConfigHash(context.group), followerQuantities },
  };
}

/**
 * Kontrakt podle zdroje ceny grafu (`IBKR:MNQZ2026`, `MNQZ6`); kontinuální
 * řada (`MNQ1!`) nebo neznámý tvar = null — náhled pak nejde poslat.
 */
export function previewSymbolFromChartSource(source: string | null | undefined): string | null {
  // Fáze 1b (INV-UI-04): konkrétní kontrakt smí přijít jen ze zdroje IBKR
  // (nebo holý kód kontraktu); identifikátor z TradingView do příkazu nepatří.
  const trimmed = (source ?? '').trim().toUpperCase();
  const prefix = trimmed.includes(':') ? trimmed.slice(0, trimmed.indexOf(':')) : null;
  if (prefix != null && prefix !== 'IBKR') return null;
  const match = /(?:^|[:\s])(MNQ)([HMUZ])(?:20)?(\d{1,2})$/.exec((source ?? '').trim().toUpperCase());
  return match ? `${match[1]}${match[2]}${match[3].slice(-1)}` : null;
}
