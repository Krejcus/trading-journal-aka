import { stableHash64 } from '../services/copierKeys.js';

/**
 * Fáze 1a obchodování z grafu (docs/CHART_ORDER_ENTRY_PLAN.md §8): NÁHLED
 * ručního vstupu na leadera. Worker vyhodnotí brány a vrátí, co by poslal
 * a proč ne — k brokerovi nic nezapíše. Stejná validace na enqueue i claim
 * straně relaye a ve workeru (payload přichází z nevalidovaného JSON).
 */

export const LEADER_ENTRY_TICK = 0.25;
export const LEADER_ENTRY_MAX_QUANTITY = 50;
const SYMBOL_PATTERN = /^(MNQ|NQ)[HMUZ]\d$/;
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
  orderType: 'Limit' | 'Stop';
  price: number;
  stopLoss: number;
  takeProfit: number;
  /** Co uživatel viděl v náhledu panelu; worker musí přepočtem dojít ke stejnému. */
  intent: {
    armedAt: number;
    groupConfigHash: string;
    followerQuantities: Array<{ accountId: number; quantity: number }>;
  };
}

export interface LeaderEntryPreviewIssue { code: string; text: string }

export interface LeaderEntryPreviewOrder {
  accountId: number;
  side: 'Buy' | 'Sell';
  quantity: number;
  orderType: 'Limit' | 'Stop';
  price: number;
  stopLoss: number;
  takeProfit: number;
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
const COMMAND_KEYS = ['type', 'groupId', 'operationId', 'leaderAccountId', 'symbol', 'side', 'quantity', 'orderType', 'price', 'stopLoss', 'takeProfit', 'intent'];
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
  if (command.orderType !== 'Limit' && command.orderType !== 'Stop') fail();
  if (!price(command.price) || !price(command.stopLoss) || !price(command.takeProfit)) fail();
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
  orderType: 'Limit' | 'Stop';
  price: number;
  stopLoss: number;
  takeProfit: number;
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
  const match = /(?:^|[:\s])(MNQ|NQ)([HMUZ])(?:20)?(\d{1,2})$/.exec((source ?? '').trim().toUpperCase());
  return match ? `${match[1]}${match[2]}${match[3].slice(-1)}` : null;
}
