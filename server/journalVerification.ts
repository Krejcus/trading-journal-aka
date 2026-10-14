import type { SupabaseClient } from '@supabase/supabase-js';
import type { Account } from '../types.js';
import type { JournalFeedScope } from '../lib/journalEvidenceFeed.js';
import { readStoredJournalEvidence } from '../lib/journalEvidenceFeed.js';
import { journalCompactedEvidence, journalInputKey, journalInputMode } from '../lib/journalInputCompaction.js';
import type { JournalEvidence } from '../lib/tradovateJournalEvidence.js';
import { projectJournalAccounts } from '../lib/journalAccountProjection.js';
import { journalPositionWrite } from '../lib/journalTradeFacts.js';
import { stable } from '../lib/journalCheckpoint.js';
import { randomUUID } from 'node:crypto';
import { readJournalCheckpoints, reopenJournalCheckpoint } from './journalCheckpointStore.js';

/**
 * Denní plná kontrola živého deníku (pojistka nad pravidly pozdní evidence).
 * Celý vstup včetně archivovaného se přehraje bez okna a každá zmrazená pozice
 * se porovná s uloženou. Rozdíl = kontrolní bod se vrátí před epochu, která ji
 * zmrazila; další import ji spočítá znovu. Nic se tu nezapisuje do obchodů.
 */
export type JournalVerification = { state: 'skipped' | 'verified' | 'reopened' | 'deferred'; mismatches?: number; reason?: string };

const PAGE_ROWS = 1000;
/**
 * Bez issues/complete (zobrazení) a bez časů, které nejsou od brokera: verze
 * příkazu nemá vlastní čas, takže po restartu workeru (nové pozorování) by
 * se lišil jen čas příjmu, ne obchod.
 */
const comparableHistory = (history: unknown) => {
  if (!history || typeof history !== 'object') return history;
  const { issues: _issues, complete: _complete, protection, entryOrders, ...rest } = history as Record<string, unknown>;
  const events = Array.isArray(protection) ? protection.map(event => (event as { timeSource?: string }).timeSource === 'received'
    ? { ...(event as Record<string, unknown>), at: null } : event) : protection;
  const orders = Array.isArray(entryOrders) ? entryOrders.map(order => {
    const { placedAt: _placed, legs, end, ...base } = order as Record<string, unknown>;
    return { ...base, legs: Array.isArray(legs) ? legs.map(leg => ({ price: (leg as { price: unknown }).price })) : legs,
      end: end && typeof end === 'object' ? { kind: (end as { kind: unknown }).kind } : end };
  }) : entryOrders;
  return { ...rest, protection: events, entryOrders: orders };
};

export async function verifyJournalConnection(db: SupabaseClient, scope: JournalFeedScope, deadline: number): Promise<JournalVerification> {
  const common = { p_user_id: scope.ownerId, p_connection_id: scope.connectionId };
  // Pod stejným zámkem jako import: jinak by kompaktace mezi stránkami
  // posouvala generaci a kontrola by se pořád odkládala.
  const holder = randomUUID();
  const { data: acquired, error: leaseError } = await db.rpc('claim_journal_import_lease', { ...common, p_holder: holder,
    p_ttl_ms: Math.max(1_000, Math.min(280_000, deadline - Date.now() + 10_000)) });
  if (leaseError || acquired !== true) return { state: 'deferred', reason: 'lease-busy' };
  try {
    return await verifyWithLease(db, scope, deadline);
  } finally {
    await db.rpc('release_journal_import_lease', { ...common, p_holder: holder }).then(() => undefined, () => undefined);
  }
}

async function verifyWithLease(db: SupabaseClient, scope: JournalFeedScope, deadline: number): Promise<JournalVerification> {
  const state = await readJournalCheckpoints(db, scope);
  const common = { p_user_id: scope.ownerId, p_connection_id: scope.connectionId };
  if (!state.active) return { state: 'skipped' };
  const { data: head, error: headError } = await db.from('tradovate_journal_input_heads').select('generation,through,target_through,checkpoint_epoch')
    .eq('user_id', scope.ownerId).eq('connection_id', scope.connectionId).maybeSingle();
  if (headError || !head) return { state: 'deferred', reason: 'head-unavailable' };
  if (Number(head.through) !== Number(head.target_through) || Number(head.checkpoint_epoch) !== state.epoch) return { state: 'deferred', reason: 'input-moving' };
  const generation = Number(head.generation);
  const retained: JournalEvidence[] = [], entities: Array<{ latest: JournalEvidence }> = [];
  let after = '', watermark: JournalEvidence | null = null;
  for (;;) {
    if (Date.now() > deadline) return { state: 'deferred', reason: 'deadline' };
    const { data, error } = await db.rpc('read_journal_input_all', { ...common, p_generation: generation, p_after: after, p_limit: PAGE_ROWS });
    if (error) return { state: 'deferred', reason: 'read-failed' };
    if (data?.generation !== generation || !Array.isArray(data.rows)) return { state: 'deferred', reason: 'input-changed' };
    if (data.watermark != null && watermark == null) watermark = readStoredJournalEvidence(data.watermark, scope);
    if (!data.rows.length) break;
    for (const row of data.rows) {
      after = row.key;
      if (row.entity) {
        const latest = readStoredJournalEvidence(row.entity.latest, scope);
        if (journalInputMode(latest) !== 'entity' || row.key !== `e:${journalInputKey(latest)}`) throw new Error('journal-verification-invalid');
        entities.push({ latest });
      } else retained.push(readStoredJournalEvidence(row.event, scope));
    }
  }
  const events = journalCompactedEvidence(retained, entities, watermark);
  const { data: accountRows, error: accountError } = await db.from('accounts').select('id,meta').eq('user_id', scope.ownerId)
    .contains('meta', { oauth: { provider: 'tradovate', environment: scope.environment, connectionId: scope.connectionId } }).limit(251);
  if (accountError) return { state: 'deferred', reason: 'accounts-unavailable' };
  const accounts: Pick<Account, 'id' | 'oauth'>[] = (accountRows ?? []).map(row => ({ id: row.id, oauth: row.meta?.oauth }));
  const projection = projectJournalAccounts(events, accounts);
  const full = new Map([...projection.ready.map(journalPositionWrite), ...projection.pending.map(journalPositionWrite)]
    .map(write => [write.positionId, write]));
  // API vrací nejvýš 1000 řádků na dotaz: stránkovat podle klíče.
  const stored: Array<{ position_id: string; status: string; pending_reason: string | null; facts: unknown; history: unknown; frozen_epoch: number }> = [];
  for (let last = ''; ;) {
    if (Date.now() > deadline) return { state: 'deferred', reason: 'deadline' };
    const { data: page, error: storedError } = await db.from('tradovate_journal_positions')
      .select('position_id,status,pending_reason,facts,history,frozen_epoch').eq('user_id', scope.ownerId).eq('connection_id', scope.connectionId)
      .not('frozen_epoch', 'is', null).gt('position_id', last).order('position_id', { ascending: true }).limit(500);
    if (storedError || !Array.isArray(page)) return { state: 'deferred', reason: 'positions-unavailable' };
    stored.push(...page);
    if (page.length < 500) break;
    last = page[page.length - 1].position_id;
  }
  const mismatched = stored.filter(row => {
    const write = full.get(row.position_id);
    return !write || write.status !== row.status || (write.pendingReason ?? null) !== (row.pending_reason ?? null)
      || stable(write.facts) !== stable(row.facts) || stable(comparableHistory(write.history)) !== stable(comparableHistory(row.history));
  });
  if (mismatched.length) {
    const target = Math.max(0, Math.min(...mismatched.map(row => Number(row.frozen_epoch))) - 1);
    console.warn('[journal-verify] frozen positions differ from full replay', { mismatches: mismatched.length, reopenTo: target });
    await reopenJournalCheckpoint(db, scope, target, state.epoch);
    return { state: 'reopened', mismatches: mismatched.length };
  }
  await db.rpc('mark_journal_verified', { ...common, p_checkpoint_epoch: state.epoch });
  return { state: 'verified', mismatches: 0 };
}
