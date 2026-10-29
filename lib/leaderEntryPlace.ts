import { stableHash64 } from '../services/copierKeys.js';
import {
  validateLeaderEntryPreview,
  type LeaderEntryPreviewCommand,
  type LeaderEntryPreviewIssue,
} from './leaderEntryPreview.js';

/**
 * Fáze 1b obchodování z grafu (docs/CHART_ORDER_ENTRY_PLAN.md §9): SKUTEČNÉ
 * odeslání ručního vstupu na leadera jako nativní OSO. Stejná pole jako
 * náhled, vlastní jmenný prostor `entry:` (náhled se nikdy nesmí odeslat)
 * a otisk payloadu proti tichému přepsání se stejným klíčem.
 */

const OPERATION_ID_PATTERN = /^entry:[a-zA-Z0-9_-]{8,100}$/;
const PAYLOAD_HASH_PATTERN = /^[a-z0-9]{8,64}$/;

export interface LeaderEntryPlaceCommand extends Omit<LeaderEntryPreviewCommand, 'type'> {
  type: 'place-leader-entry';
  payloadHash: string;
}

export type LeaderEntryPlaceStatus = 'blocked' | 'rejected' | 'acknowledged' | 'unknown' | 'abandoned';

export interface LeaderEntryPlaceResult {
  type: 'leader-entry-placed';
  operationId: string;
  status: LeaderEntryPlaceStatus;
  /** Kdy worker výsledek uzavřel. */
  checkedAt: number;
  blockers: LeaderEntryPreviewIssue[];
  entryBrokerOrderId?: string;
  stopBrokerOrderId?: string;
  targetBrokerOrderId?: string;
  /** Text pro uživatele u rejected / unknown / abandoned. */
  reason?: string;
}

/** Otisk všech polí příkazu kromě samotného otisku (stejně na klientovi i ve workeru). */
export function leaderEntryPayloadHash(command: Omit<LeaderEntryPlaceCommand, 'payloadHash'> | LeaderEntryPlaceCommand): string {
  const { payloadHash: _ignored, ...rest } = command as LeaderEntryPlaceCommand;
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

/**
 * Striktní validace odeslání: stejné tvary jako náhled (whitelist, tick,
 * qty, symbol), navíc prefix `entry:` a sedící `payloadHash`.
 * Vyhodí `invalid-relay-command-payload`.
 */
export function validateLeaderEntryPlace(value: unknown): LeaderEntryPlaceCommand {
  const fail = () => { throw new Error('invalid-relay-command-payload'); };
  if (!value || typeof value !== 'object') fail();
  const { type, payloadHash, operationId, ...rest } = value as Record<string, unknown>;
  if (type !== 'place-leader-entry') fail();
  if (typeof payloadHash !== 'string' || !PAYLOAD_HASH_PATTERN.test(payloadHash)) fail();
  if (typeof operationId !== 'string' || !OPERATION_ID_PATTERN.test(operationId)) fail();
  // Tvar polí ověří validace náhledu (operationId jí podstrčíme v jejím prefixu).
  validateLeaderEntryPreview({ ...rest, type: 'preview-leader-entry', operationId: `preview:${String(operationId).slice('entry:'.length)}` });
  const command = value as unknown as LeaderEntryPlaceCommand;
  if (leaderEntryPayloadHash(command) !== payloadHash) fail();
  return command;
}

/** Odeslání z ověřeného náhledu: stejný návrh i záměr, nový klíč operace. */
export function buildLeaderEntryPlaceCommand(
  preview: LeaderEntryPreviewCommand,
  operationId: string,
): LeaderEntryPlaceCommand {
  const { type: _type, operationId: _previewId, ...fields } = preview;
  const base = { ...fields, type: 'place-leader-entry' as const, operationId };
  return { ...base, payloadHash: leaderEntryPayloadHash(base) };
}

/** Náhledový tvar téhož příkazu — worker přes něj znovu vyhodnotí brány náhledu. */
export function leaderEntryPlaceAsPreview(command: LeaderEntryPlaceCommand): LeaderEntryPreviewCommand {
  const { type: _type, payloadHash: _hash, operationId, ...fields } = command;
  return { ...fields, type: 'preview-leader-entry', operationId: `preview:${operationId.slice('entry:'.length)}` };
}

/** Relay obálka nese ruční vstup (`copy-command` → `place-leader-entry`)? */
export function isLeaderEntryPlaceCommand(command: unknown): boolean {
  const outer = command as { type?: unknown; command?: { type?: unknown } } | null;
  return outer?.type === 'copy-command' && outer.command?.type === 'place-leader-entry';
}
