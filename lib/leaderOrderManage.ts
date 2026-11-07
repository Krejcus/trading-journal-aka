import { stableHash64 } from '../services/copierKeys.js';

/**
 * Fáze 2a obchodování z grafu (docs/CHART_ORDER_ENTRY_PLAN.md §10.1): správa
 * VLASTNÍHO ručního vstupu z grafu — posun SL/TP dál od trhu a zrušení
 * čekajícího vstupu. Id příkazů zná worker z durable záznamu vstupu
 * (`entryOperationId`); UI je nezná. Kopírka followerům provede totéž
 * běžnou cestou (zrcadlení modify, lifecycle cancel).
 */

/** `close-position` (fáze 2d): zavřít obchod leadera (liquidate), kopírka zavře kopie. */
/**
 * `attach-brackets` (2. 11. 2026): k holému Marketu (vlastní vstup bez nohou)
 * doplnit SL + TP jako OCO na celou pozici.
 */
/** SL i TP nevyplněného vstupu: nejmenší vzdálenost od ceny vstupu. */
export const PENDING_LEG_MIN_TICKS = 4;
/** Stop vstup se může vyplnit se skluzem: TP má rezervu navíc, jinak by se po fillu hned vyplnil. */
export const PENDING_LEG_STOP_ENTRY_TARGET_RESERVE_TICKS = 4;
const PENDING_LEG_TICK = 0.25;

/**
 * Pravidlo ceny nohy nevyplněného vstupu (stejně v grafu i ve workeru). `null` = smí.
 * Noha čeká pozastavená, takže trh ji nespustí: rozhoduje jen strana vůči ceně vstupu.
 */
export function pendingLegSideProblem(
  kind: 'stopLoss' | 'takeProfit',
  side: 'long' | 'short',
  entryPrice: number,
  entryType: string | null,
  price: number,
): string | null {
  const dir = side === 'long' ? 1 : -1;
  const stopEntry = (entryType ?? '').toLowerCase() === 'stop';
  if (kind === 'stopLoss') {
    if ((entryPrice - price) * dir < PENDING_LEG_MIN_TICKS * PENDING_LEG_TICK - 1e-9) {
      return `SL musí být aspoň ${PENDING_LEG_MIN_TICKS} ticky ${side === 'long' ? 'pod' : 'nad'} vstupem.`;
    }
    return null;
  }
  const minTicks = PENDING_LEG_MIN_TICKS + (stopEntry ? PENDING_LEG_STOP_ENTRY_TARGET_RESERVE_TICKS : 0);
  if ((price - entryPrice) * dir < minTicks * PENDING_LEG_TICK - 1e-9) {
    return `TP musí být aspoň ${minTicks} ticků ${side === 'long' ? 'nad' : 'pod'} vstupem.`;
  }
  return null;
}

export const LEADER_ORDER_MOVE_LIMIT_CONTRACT = 2;

export type LeaderOrderManageAction = 'move-stop' | 'move-target' | 'move-limit' | 'cancel-entry' | 'close-position' | 'attach-brackets' | 'add-leg' | 'remove-leg';

export interface LeaderOrderManageCommand {
  type: 'manage-leader-order';
  groupId: string;
  operationId: string;
  leaderAccountId: number;
  /** Vlastní ruční vstup (`entry:…`, fáze 2a) — nebo… */
  entryOperationId?: string;
  /** …vstup leadera, který kopírka sleduje jako OSO / bracket (fáze 2b). Právě jedno z obou. */
  leaderEntryOrderId?: string;
  symbol: string;
  action: LeaderOrderManageAction;
  /** Co uživatel viděl: cena dotčeného příkazu (u cancel-entry cena vstupu, u close-position cena SL) a počet kontraktů. */
  expect: {
    price: number; quantity: number;
    /** Jen `add-leg` a `remove-leg`: SL a TP, které uživatel viděl (null = žádná). Druhé zařízení mohlo nohu mezitím změnit. */
    stop?: number | null; target?: number | null;
    /** Jen `cancel-entry` zbytku holého Limit/Stop: kolik kontraktů uživatel viděl vyplněných. */
    filledQuantity?: number;
  };
  /** `move-*` a `add-leg` (cena nové nohy). */
  newPrice?: number;
  /** Jen `add-leg` a `remove-leg`: která noha. */
  leg?: 'stopLoss' | 'takeProfit';
  /** Jen `attach-brackets` (obě povinné): ceny nových nohou. U attach je `expect.price` cena trhu, kterou uživatel viděl. */
  stopLoss?: number;
  takeProfit?: number;
  /**
   * Správa celé pozice (přikoupení, 3. 11. 2026): `entryOperationId` je pak nejstarší
   * lístek pozice (klíč busy v relayi — PC i telefon posílají stejný), worker změní
   * všechny nohy pozice najednou. `expect` = nejochrannější SL / nejbližší TP a |pozice|.
   * Jen `move-stop` / `move-target` / `close-position`.
   */
  scope?: 'position';
  /**
   * Jen a povinně `move-limit`: klient počítá s tím, že broker posune i nohy OSO.
   * Starý klient (přibalený bundle v iPhonu) pole nepošle a relay ho odmítne; starý worker
   * neznámé pole odmítne sám. Tím je akce vypnutá do nasazení opravy všude, bez přepínače.
   */
  moveLimitContract?: typeof LEADER_ORDER_MOVE_LIMIT_CONTRACT;
  payloadHash: string;
}

export type LeaderOrderManageStatus = 'blocked' | 'acknowledged' | 'rejected' | 'unknown';

export interface LeaderOrderManageResult {
  type: 'leader-order-managed';
  operationId: string;
  action: LeaderOrderManageAction;
  status: LeaderOrderManageStatus;
  checkedAt: number;
  blockers: Array<{ code: string; text: string }>;
  brokerOrderId?: string;
  reason?: string;
}

const SYMBOL_PATTERN = /^(MNQ|NQ)[HMUZ]\d$/;
const OPERATION_ID_PATTERN = /^manage:[a-zA-Z0-9_-]{8,100}$/;
const ENTRY_OPERATION_ID_PATTERN = /^entry:[a-zA-Z0-9_-]{8,100}$/;
const ACTIONS: readonly LeaderOrderManageAction[] = ['move-stop', 'move-target', 'move-limit', 'cancel-entry', 'close-position', 'attach-brackets', 'add-leg', 'remove-leg'];
const KEYS = ['type', 'groupId', 'operationId', 'leaderAccountId', 'entryOperationId', 'leaderEntryOrderId', 'symbol', 'action', 'expect', 'newPrice', 'leg', 'stopLoss', 'takeProfit', 'scope', 'moveLimitContract', 'payloadHash'];
const LEADER_ORDER_ID_PATTERN = /^[A-Za-z0-9-]{1,40}$/;
const onTick = (value: number) => Math.abs(value * 4 - Math.round(value * 4)) < 1e-9;
const price = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1_000_000 && onTick(value);

export function leaderOrderManagePayloadHash(command: Omit<LeaderOrderManageCommand, 'payloadHash'> | LeaderOrderManageCommand): string {
  const { payloadHash: _ignored, ...rest } = command as LeaderOrderManageCommand;
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort()
        .map(key => [key, canonical((value as Record<string, unknown>)[key])]));
    }
    return value;
  };
  return stableHash64(JSON.stringify(canonical(rest)));
}

/** Striktní validace (whitelist, tick, akce); vyhodí `invalid-relay-command-payload`. */
export function validateLeaderOrderManage(value: unknown): LeaderOrderManageCommand {
  const fail = (): never => { throw new Error('invalid-relay-command-payload'); };
  if (!value || typeof value !== 'object') fail();
  const command = value as Record<string, unknown>;
  if (Object.keys(command).some(key => !KEYS.includes(key))) fail();
  if (command.type !== 'manage-leader-order') fail();
  if (typeof command.groupId !== 'string' || command.groupId.trim() === '' || command.groupId.length > 200) fail();
  if (typeof command.operationId !== 'string' || !OPERATION_ID_PATTERN.test(command.operationId)) fail();
  if (typeof command.leaderAccountId !== 'number' || !Number.isSafeInteger(command.leaderAccountId) || command.leaderAccountId <= 0) fail();
  const own = command.entryOperationId !== undefined;
  const tracked = command.leaderEntryOrderId !== undefined;
  if (own === tracked) fail();
  if (own && (typeof command.entryOperationId !== 'string' || !ENTRY_OPERATION_ID_PATTERN.test(command.entryOperationId))) fail();
  if (tracked && (typeof command.leaderEntryOrderId !== 'string' || !LEADER_ORDER_ID_PATTERN.test(command.leaderEntryOrderId))) fail();
  if (typeof command.symbol !== 'string' || !SYMBOL_PATTERN.test(command.symbol)) fail();
  if (!ACTIONS.includes(command.action as LeaderOrderManageAction)) fail();
  const expect = command.expect as Record<string, unknown> | null;
  const singleLeg = command.action === 'add-leg' || command.action === 'remove-leg';
  const legPrice = (value: unknown) => value === null || price(value);
  if (!expect || typeof expect !== 'object') fail();
  if (singleLeg ? (Object.keys(expect!).some(key => !['price', 'quantity', 'stop', 'target'].includes(key)) || !legPrice(expect!.stop) || !legPrice(expect!.target))
    : Object.keys(expect!).some(key => key !== 'price' && key !== 'quantity' && !(key === 'filledQuantity' && command.action === 'cancel-entry'))) fail();
  // Zrušení zbytku holého Limit/Stop: kolik uživatel viděl vyplněné. Bez toho by se dílčí fill nedal odlišit od závodu.
  if (expect!.filledQuantity !== undefined
    && (typeof expect!.filledQuantity !== 'number' || !Number.isSafeInteger(expect!.filledQuantity) || expect!.filledQuantity < 1 || expect!.filledQuantity > 50)) fail();
  if (!price(expect!.price)) fail();
  if (typeof expect!.quantity !== 'number' || !Number.isSafeInteger(expect!.quantity) || expect!.quantity < 1 || expect!.quantity > 50) fail();
  const moves = command.action === 'move-stop' || command.action === 'move-target' || command.action === 'move-limit';
  if (command.action === 'move-limit' && (!own || command.moveLimitContract !== LEADER_ORDER_MOVE_LIMIT_CONTRACT)) fail();
  if (command.action !== 'move-limit' && command.moveLimitContract !== undefined) fail();
  if ((moves || command.action === 'add-leg') ? !price(command.newPrice) : command.newPrice !== undefined) fail();
  // SL a TP po jedné: jen vlastní vstup, jedna noha, celá pozice.
  if (singleLeg ? (!own || (command.leg !== 'stopLoss' && command.leg !== 'takeProfit')) : command.leg !== undefined) fail();
  // Doplnění nohou: jen vlastní vstup, obě ceny; jinde nohy v příkazu být nesmí.
  const attach = command.action === 'attach-brackets';
  if (attach ? (!own || !price(command.stopLoss) || !price(command.takeProfit) || command.stopLoss === command.takeProfit)
    : (command.stopLoss !== undefined || command.takeProfit !== undefined)) fail();
  if (command.scope !== undefined && (command.scope !== 'position' || !own
    || !(command.action === 'move-stop' || command.action === 'move-target' || command.action === 'close-position'))) fail();
  if (typeof command.payloadHash !== 'string' || !/^[a-z0-9]{8,64}$/.test(command.payloadHash)) fail();
  const typed = command as unknown as LeaderOrderManageCommand;
  if (leaderOrderManagePayloadHash(typed) !== typed.payloadHash) fail();
  return typed;
}

export function buildLeaderOrderManageCommand(fields: Omit<LeaderOrderManageCommand, 'type' | 'payloadHash'>): LeaderOrderManageCommand {
  const base = { type: 'manage-leader-order' as const, ...fields };
  return { ...base, payloadHash: leaderOrderManagePayloadHash(base) };
}

/**
 * Co posun limitu udělal s nohami OSO. Broker je při Modify vstupu posouvá sám o stejnou hodnotu
 * (žurnál DEMO 6. 11. 2026, jeden vzorek); oba tvary se rozlišují až proti cenám před zápisem.
 */
export type MoveLimitLegsVerdict = 'shifted' | 'unchanged' | 'mismatch';
export function moveLimitLegsVerdict(input: {
  stopFrom: number; targetFrom: number; delta: number; stopPrice: number | null | undefined; targetPrice: number | null | undefined;
}): MoveLimitLegsVerdict {
  const near = (left: number, right: number) => Math.abs(left - right) < 1e-9;
  if (input.stopPrice == null || input.targetPrice == null) return 'mismatch';
  if (near(input.stopPrice, input.stopFrom + input.delta) && near(input.targetPrice, input.targetFrom + input.delta)) return 'shifted';
  if (near(input.stopPrice, input.stopFrom) && near(input.targetPrice, input.targetFrom)) return 'unchanged';
  return 'mismatch';
}

/**
 * Vstup pro výpočet ztráty při posunu limitu: `|vstup − SL| + |posun|`. Platí bez ohledu na to, zda
 * broker nohy posune a zda Modify vstupu přijme: kaskáda na nohy přichází dřív než přijetí vstupu.
 */
export function moveLimitRiskEntry(side: 'long' | 'short', entry: number, next: number, stop: number): number {
  const distance = Math.abs(entry - stop) + Math.abs(next - entry);
  return side === 'long' ? stop + distance : stop - distance;
}

export function isLeaderOrderManageCommand(command: unknown): boolean {
  const outer = command as { type?: unknown; command?: { type?: unknown } } | null;
  return outer?.type === 'copy-command' && outer.command?.type === 'manage-leader-order';
}

/** Klíč spravovaného obchodu: vlastní vstup `entry:…`, sledovaný obchod `leader:<id>`. */
export function leaderOrderManageKey(command: Pick<LeaderOrderManageCommand, 'entryOperationId' | 'leaderEntryOrderId'>): string {
  return command.entryOperationId ?? `leader:${command.leaderEntryOrderId}`;
}
