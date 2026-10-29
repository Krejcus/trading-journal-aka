import { stableHash64 } from '../services/copierKeys.js';

/**
 * Fáze 2a obchodování z grafu (docs/CHART_ORDER_ENTRY_PLAN.md §10.1): správa
 * VLASTNÍHO ručního vstupu z grafu — posun SL/TP dál od trhu a zrušení
 * čekajícího vstupu. Id příkazů zná worker z durable záznamu vstupu
 * (`entryOperationId`); UI je nezná. Kopírka followerům provede totéž
 * běžnou cestou (zrcadlení modify, lifecycle cancel).
 */

export type LeaderOrderManageAction = 'move-stop' | 'move-target' | 'cancel-entry';

export interface LeaderOrderManageCommand {
  type: 'manage-leader-order';
  groupId: string;
  operationId: string;
  leaderAccountId: number;
  /** Vlastní ruční vstup (`entry:…`), jehož příkaz se spravuje. */
  entryOperationId: string;
  symbol: string;
  action: LeaderOrderManageAction;
  /** Co uživatel viděl: cena dotčeného příkazu (u cancel-entry cena vstupu) a počet kontraktů. */
  expect: { price: number; quantity: number };
  /** Jen `move-*`. */
  newPrice?: number;
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
const ACTIONS: readonly LeaderOrderManageAction[] = ['move-stop', 'move-target', 'cancel-entry'];
const KEYS = ['type', 'groupId', 'operationId', 'leaderAccountId', 'entryOperationId', 'symbol', 'action', 'expect', 'newPrice', 'payloadHash'];
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
  if (typeof command.entryOperationId !== 'string' || !ENTRY_OPERATION_ID_PATTERN.test(command.entryOperationId)) fail();
  if (typeof command.symbol !== 'string' || !SYMBOL_PATTERN.test(command.symbol)) fail();
  if (!ACTIONS.includes(command.action as LeaderOrderManageAction)) fail();
  const expect = command.expect as Record<string, unknown> | null;
  if (!expect || typeof expect !== 'object' || Object.keys(expect).some(key => key !== 'price' && key !== 'quantity')) fail();
  if (!price(expect!.price)) fail();
  if (typeof expect!.quantity !== 'number' || !Number.isSafeInteger(expect!.quantity) || expect!.quantity < 1 || expect!.quantity > 50) fail();
  const moves = command.action === 'move-stop' || command.action === 'move-target';
  if (moves ? !price(command.newPrice) : command.newPrice !== undefined) fail();
  if (typeof command.payloadHash !== 'string' || !/^[a-z0-9]{8,64}$/.test(command.payloadHash)) fail();
  const typed = command as unknown as LeaderOrderManageCommand;
  if (leaderOrderManagePayloadHash(typed) !== typed.payloadHash) fail();
  return typed;
}

export function buildLeaderOrderManageCommand(fields: Omit<LeaderOrderManageCommand, 'type' | 'payloadHash'>): LeaderOrderManageCommand {
  const base = { type: 'manage-leader-order' as const, ...fields };
  return { ...base, payloadHash: leaderOrderManagePayloadHash(base) };
}

export function isLeaderOrderManageCommand(command: unknown): boolean {
  const outer = command as { type?: unknown; command?: { type?: unknown } } | null;
  return outer?.type === 'copy-command' && outer.command?.type === 'manage-leader-order';
}
