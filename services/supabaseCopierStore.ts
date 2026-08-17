import type { SupabaseClient } from '@supabase/supabase-js';
import {
  CopierStoreConflictError,
  emptySnapshot,
  type CopierSnapshot,
  type CopierStore,
} from './copierStore';

interface RuntimeRow {
  revision: number;
  snapshot: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value);
const string = (value: unknown): value is string => typeof value === 'string';
const optionalString = (value: unknown) => value == null || string(value);
const orderTypes = new Set(['Market', 'Limit', 'Stop', 'StopLimit']);
const sides = new Set(['Buy', 'Sell']);
const outboxStatuses = new Set(['planned', 'sending', 'unknown', 'acknowledged', 'rejected', 'abandoned', 'waived']);
const cancelStatuses = new Set(['planned', 'sending', 'unknown', 'confirmed', 'abandoned', 'waived']);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validRequest(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return string(value.tag) && integer(value.accountId) && string(value.symbol)
    && sides.has(String(value.side)) && integer(value.quantity) && Number(value.quantity) > 0
    && orderTypes.has(String(value.orderType))
    && (value.limitPrice == null || finite(value.limitPrice))
    && (value.stopPrice == null || finite(value.stopPrice));
}

function validOutbox(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return string(value.key) && string(value.tag) && string(value.leaderOrderId)
    && (value.leaderEventId == null || string(value.leaderEventId))
    && (value.leaderSequence == null || (integer(value.leaderSequence) && Number(value.leaderSequence) >= 0))
    && validRequest(value.request) && outboxStatuses.has(String(value.status))
    && integer(value.attempts) && Number(value.attempts) >= 0
    && optionalString(value.brokerOrderId) && optionalString(value.reason) && finite(value.updatedAt);
}

function validOcoLeg(value: unknown): boolean {
  return isRecord(value) && sides.has(String(value.side))
    && (value.orderType === 'Limit' || value.orderType === 'Stop' || value.orderType === 'StopLimit')
    && (value.limitPrice == null || finite(value.limitPrice))
    && (value.stopPrice == null || finite(value.stopPrice));
}

function validBracketOutbox(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.request)) return false;
  const request = value.request;
  return string(value.key) && string(value.tag)
    && string(value.leaderEntryOrderId) && string(value.leaderStopOrderId)
    && string(value.leaderTargetOrderId) && string(value.leaderEventId)
    && integer(value.leaderSequence) && Number(value.leaderSequence) >= 0
    && string(request.tag) && integer(request.accountId) && string(request.symbol)
    && integer(request.quantity) && Number(request.quantity) > 0
    && validOcoLeg(request.first) && validOcoLeg(request.second)
    && outboxStatuses.has(String(value.status))
    && integer(value.attempts) && Number(value.attempts) >= 0
    && optionalString(value.firstBrokerOrderId) && optionalString(value.secondBrokerOrderId)
    && optionalString(value.reason) && finite(value.updatedAt);
}

function validOsoOutbox(value: unknown): boolean {
  if (!validBracketOutbox(value) || !isRecord(value) || !isRecord(value.request)) return false;
  return validRequest(value.request)
    && optionalString(value.entryBrokerOrderId)
    && optionalString(value.firstBrokerOrderId)
    && optionalString(value.secondBrokerOrderId);
}

function validCancelOutbox(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const changes = value.changes;
  const validChanges = changes == null || (isRecord(changes)
    && integer(changes.quantity) && Number(changes.quantity) > 0
    && orderTypes.has(String(changes.orderType))
    && (changes.limitPrice == null || finite(changes.limitPrice))
    && (changes.stopPrice == null || finite(changes.stopPrice)));
  return (value.operation === 'cancel' || value.operation === 'modify')
    && string(value.key) && string(value.leaderEventId) && integer(value.leaderSequence)
    && Number(value.leaderSequence) >= 0 && integer(value.accountId) && string(value.brokerOrderId)
    && validChanges && cancelStatuses.has(String(value.status))
    && integer(value.attempts) && Number(value.attempts) >= 0
    && optionalString(value.reason) && finite(value.updatedAt);
}

function validLinkTuple(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== 2 || !string(value[0]) || !Array.isArray(value[1])) return false;
  return value[1].every(link => isRecord(link) && string(link.key) && integer(link.accountId)
    && string(link.brokerOrderId) && integer(link.quantity) && Number(link.quantity) > 0
    && (link.limitPrice == null || finite(link.limitPrice))
    && (link.stopPrice == null || finite(link.stopPrice)));
}

function validNumberTuple(value: unknown): boolean {
  return Array.isArray(value) && value.length === 2 && string(value[0]) && finite(value[1]) && value[1] >= 0;
}

const unique = (values: readonly string[]) => new Set(values).size === values.length;

function asSnapshot(value: unknown, revision: number): CopierSnapshot {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid copier snapshot: expected an object');
  }
  const candidate = value as Partial<CopierSnapshot>;
  const bracketOutbox = candidate.bracketOutbox ?? [];
  const osoOutbox = candidate.osoOutbox ?? [];
  if (
    !Number.isSafeInteger(candidate.lastSequence) || Number(candidate.lastSequence) < 0
    || !Array.isArray(candidate.replicated)
    || !candidate.replicated.every(item => typeof item === 'string')
    || !unique(candidate.replicated)
    || !Array.isArray(candidate.outbox) || !candidate.outbox.every(validOutbox)
    || !unique(candidate.outbox.map(item => (item as { key: string }).key))
    || !Array.isArray(bracketOutbox) || !bracketOutbox.every(validBracketOutbox)
    || !unique(bracketOutbox.map(item => item.key))
    || !Array.isArray(osoOutbox) || !osoOutbox.every(validOsoOutbox)
    || !unique(osoOutbox.map(item => item.key))
    || !Array.isArray(candidate.cancelOutbox) || !candidate.cancelOutbox.every(validCancelOutbox)
    || !unique(candidate.cancelOutbox.map(item => (item as { key: string }).key))
    || !Array.isArray(candidate.links) || !candidate.links.every(validLinkTuple)
    || !unique(candidate.links.map(item => String((item as unknown[])[0])))
    || !Array.isArray(candidate.leaderCumQty) || !candidate.leaderCumQty.every(validNumberTuple)
    || !unique(candidate.leaderCumQty.map(item => String((item as unknown[])[0])))
    || !Array.isArray(candidate.followerFillTargets) || !candidate.followerFillTargets.every(validNumberTuple)
    || !unique(candidate.followerFillTargets.map(item => String((item as unknown[])[0])))
  ) {
    throw new Error('Invalid copier snapshot: required fields are missing or malformed');
  }
  return {
    revision,
    replicated: candidate.replicated,
    lastSequence: candidate.lastSequence as number,
    outbox: candidate.outbox,
    bracketOutbox,
    osoOutbox,
    cancelOutbox: candidate.cancelOutbox,
    links: candidate.links,
    leaderCumQty: candidate.leaderCumQty,
    followerFillTargets: candidate.followerFillTargets,
  };
}

/**
 * Durable store přes uživatelskou Supabase session. Nepoužívá service-role
 * klíč; vlastnictví řádku vynucuje RLS a CAS provádí jediná DB funkce.
 */
export function createSupabaseCopierStore(
  client: SupabaseClient,
  runtimeId: string,
): CopierStore {
  if (!uuidPattern.test(runtimeId)) throw new Error('Copier runtimeId must be a UUID');
  return {
    async load() {
      const { data, error } = await client
        .from('copier_runtime_state')
        .select('revision,snapshot')
        .eq('runtime_id', runtimeId)
        .maybeSingle<RuntimeRow>();
      if (error) throw new Error(`Copier state load failed: ${error.message}`);
      return data ? asSnapshot(data.snapshot, Number(data.revision)) : emptySnapshot();
    },

    async commit(snapshot, expectedRevision) {
      const payload = { ...snapshot };
      delete (payload as Partial<CopierSnapshot>).revision;
      const { data, error } = await client.rpc('commit_copier_runtime_state', {
        p_runtime_id: runtimeId,
        p_expected_revision: expectedRevision,
        p_snapshot: payload,
      });
      if (error) {
        if (error.message.includes('COPIER_REVISION_CONFLICT')) {
          const actual = Number(error.message.match(/actual=([0-9]+)/)?.[1] ?? -1);
          throw new CopierStoreConflictError(expectedRevision, actual);
        }
        throw new Error(`Copier state commit failed: ${error.message}`);
      }
      const revision = Number(data);
      if (!Number.isSafeInteger(revision) || revision <= expectedRevision) {
        throw new Error('Copier state commit returned an invalid revision');
      }
      return asSnapshot(payload, revision);
    },
  };
}
