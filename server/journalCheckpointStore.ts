import type { SupabaseClient } from '@supabase/supabase-js';
import type { JournalFeedScope } from '../lib/journalEvidenceFeed.js';
import type { JournalEvidence } from '../lib/tradovateJournalEvidence.js';
import { buildJournalPositionEpisodes, type JournalPositionEpisode } from '../lib/journalPositionEpisodes.js';
import type { JournalUntakenOrder } from '../lib/journalEntryOrders.js';
import {
  compareJournalWindows, journalCheckpointManifest, journalFlatCaptures, journalLateEvidenceAt, journalLateEvidenceCheck,
  journalLateQueries, journalLiveAfterArchive, journalOrdersOpenSince,
} from '../lib/journalCheckpoint.js';

/**
 * Kontrolní body živého deníku v databázi (docs/JOURNAL_LIVE_PLAN.md).
 * Každý zápis je CAS na epochu bodu; souběžný importér nebo pozdní evidence
 * nikdy nevyrobí smíšený stav — v nejhorším případě se práce zopakuje.
 */
export interface JournalCheckpoint { epoch: number; at: number; flatAccounts: number[]; bindings: unknown; status: 'archiving' | 'active' }
export interface JournalCheckpointState { epoch: number; checkpoints: JournalCheckpoint[]; active: JournalCheckpoint | null }

const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Kontrolní bod se posouvá nejvýš jednou za tuto dobu. */
export const JOURNAL_CHECKPOINT_INTERVAL_MS = 6 * 60 * 60_000;
/** Bod musí být starší než tohle (dorazí opožděné filly a poplatky). */
export const JOURNAL_CHECKPOINT_SETTLE_MS = 15 * 60_000;
const ARCHIVE_CHUNK_ROWS = 5_000;
const ARCHIVE_CHUNK_REFS = 10_000;
const HIT_CHUNK = 5_000;

async function rpc(db: SupabaseClient, name: string, args: Record<string, unknown>, failure: string) {
  const { data, error } = await db.rpc(name, args);
  if (error) throw new Error(error.message.includes('journal-connection-not-found') ? 'journal-connection-not-found' : failure);
  return data;
}

export async function readJournalCheckpoints(db: SupabaseClient, scope: JournalFeedScope): Promise<JournalCheckpointState> {
  const data = await rpc(db, 'read_journal_checkpoints', { p_user_id: scope.ownerId, p_connection_id: scope.connectionId }, 'journal-checkpoint-read-failed');
  if (!data || !integer(data.epoch) || !Array.isArray(data.checkpoints)) throw new Error('journal-checkpoint-invalid');
  const checkpoints: JournalCheckpoint[] = data.checkpoints.map((row: Record<string, unknown>) => {
    if (!integer(row.epoch) || !integer(row.at) || !Array.isArray(row.flatAccounts) || !row.flatAccounts.every(integer)
      || (row.status !== 'archiving' && row.status !== 'active')) throw new Error('journal-checkpoint-invalid');
    return { epoch: row.epoch, at: row.at, flatAccounts: row.flatAccounts as number[], bindings: row.bindings, status: row.status };
  });
  const active = data.epoch === 0 ? null : checkpoints.find(row => row.epoch === data.epoch && row.status === 'active') ?? null;
  if (data.epoch !== 0 && !active) throw new Error('journal-checkpoint-invalid');
  return { epoch: data.epoch, checkpoints, active };
}

/**
 * Pozdní evidence k zmrazeným obchodům → epocha, na kterou se K vrátí
 * (poslední aktivní bod, který je ještě před ní), nebo null.
 */
export async function journalReopenTarget(db: SupabaseClient, scope: JournalFeedScope, events: readonly JournalEvidence[],
  state: JournalCheckpointState): Promise<number | null> {
  if (!state.active) return null;
  const check = journalLateEvidenceCheck(events, state.active.at);
  const queries = journalLateQueries(check);
  const hits: Array<{ kind: string; id: string; fingerprint: string | null; epoch: number }> = [];
  for (let index = 0; index < queries.length; index += HIT_CHUNK) {
    const data = await rpc(db, 'journal_archived_ref_hits', { p_user_id: scope.ownerId, p_connection_id: scope.connectionId,
      p_refs: queries.slice(index, index + HIT_CHUNK) }, 'journal-checkpoint-read-failed');
    if (!Array.isArray(data)) throw new Error('journal-checkpoint-invalid');
    for (const hit of data) {
      if (!integer(hit.epoch)) throw new Error('journal-checkpoint-invalid');
      hits.push({ kind: String(hit.kind), id: String(hit.id), fingerprint: hit.fingerprint ?? null, epoch: hit.epoch });
    }
  }
  const late = journalLateEvidenceAt(check, hits);
  if (late == null) return null;
  // Změněný zmrazený objekt: zpět před bod, který ho zmrazil. Pozdní událost
  // s časem t: zpět na poslední bod, který je ještě před t.
  const byEpoch = late.epoch == null ? Infinity : late.epoch - 1;
  const lateAt = late.at;
  const byTime = lateAt == null ? Infinity : Math.max(0, ...state.checkpoints
    .filter(point => point.status === 'active' && point.at <= lateAt).map(point => point.epoch));
  return Math.max(0, Math.min(byEpoch, byTime, state.epoch - 1));
}

export async function reopenJournalCheckpoint(db: SupabaseClient, scope: JournalFeedScope, to: number, expected: number) {
  const data = await rpc(db, 'reopen_journal_checkpoint', { p_user_id: scope.ownerId, p_connection_id: scope.connectionId,
    p_to_epoch: to, p_expected_epoch: expected }, 'journal-checkpoint-write-failed');
  return data?.accepted === true;
}

export async function markJournalEvaluated(db: SupabaseClient, scope: JournalFeedScope, revision: number, epoch: number, generation: number) {
  const data = await rpc(db, 'mark_journal_projection_evaluated', { p_user_id: scope.ownerId, p_connection_id: scope.connectionId,
    p_revision: revision, p_checkpoint_epoch: epoch, p_input_generation: generation }, 'journal-position-write-failed');
  return data?.accepted === true;
}

export interface JournalAdvanceInput {
  events: readonly JournalEvidence[];
  state: JournalCheckpointState;
  bindings: unknown;
  /** Výsledek aktuálního okna (už zapsaný v DB). */
  reference: { episodes: readonly JournalPositionEpisode[]; untakenOrders: readonly JournalUntakenOrder[] };
  deadline: number;
  now?: number;
}

/**
 * Posun kontrolního bodu: nejnovější kolo snímků s ověřeně flat účty, bez
 * příkazu zadaného dřív a ještě otevřeného, starší než 15 min. Posune se jen
 * když okno od nového bodu nad vstupem po archivaci dá pro vše po bodu totéž
 * co aktuální výpočet. Archivace po dávkách; aktivace zmrazí pozice před ním.
 */
export async function advanceJournalCheckpoint(db: SupabaseClient, scope: JournalFeedScope, input: JournalAdvanceInput)
  : Promise<'advanced' | 'not-due' | 'no-candidate' | 'deferred' | 'stale'> {
  const now = input.now ?? Date.now();
  const lastAt = input.state.active?.at ?? 0;
  if (now - lastAt < JOURNAL_CHECKPOINT_INTERVAL_MS) return 'not-due';
  const pending = input.state.checkpoints.find(point => point.epoch === input.state.epoch + 1 && point.status === 'archiving');
  const candidates = journalFlatCaptures(input.events)
    .filter(capture => capture.at > lastAt && capture.at <= now - JOURNAL_CHECKPOINT_SETTLE_MS)
    .reverse().slice(0, 20);
  // Rozpracovaný bod dokončit, pokud je pořád platným kandidátem.
  if (pending) candidates.sort((a, b) => Number(b.at === pending.at) - Number(a.at === pending.at));
  for (const capture of candidates) {
    if (Date.now() > input.deadline) return 'deferred';
    if (journalOrdersOpenSince(input.events, capture.at).length) continue;
    const before = input.reference.episodes.filter(episode => episode.entryAt < capture.at);
    if (before.some(episode => episode.history.position?.status === 'open')) continue;
    const manifest = journalCheckpointManifest(input.events, capture.at);
    const live = journalLiveAfterArchive(input.events, manifest);
    const candidate = buildJournalPositionEpisodes(live, capture.window);
    if (compareJournalWindows(input.reference, candidate, capture.at).length) continue;
    const begun = await rpc(db, 'begin_journal_checkpoint', { p_user_id: scope.ownerId, p_connection_id: scope.connectionId,
      p_expected_epoch: input.state.epoch, p_at_ms: capture.at, p_flat_accounts: [...capture.window.flatAccounts].sort((a, b) => a - b),
      p_bindings: input.bindings }, 'journal-checkpoint-write-failed');
    if (begun?.accepted !== true || !integer(begun.epoch)) return 'stale';
    const epoch = begun.epoch;
    const rows = [...manifest.entityKeys.map(key => ({ entity: key })), ...manifest.retainedIds.map(id => ({ retained: id }))];
    const chunks = Math.max(Math.ceil(rows.length / ARCHIVE_CHUNK_ROWS), Math.ceil(manifest.refs.length / ARCHIVE_CHUNK_REFS));
    for (let chunk = 0; chunk < chunks; chunk++) {
      if (Date.now() > input.deadline) return 'deferred';
      const slice = rows.slice(chunk * ARCHIVE_CHUNK_ROWS, (chunk + 1) * ARCHIVE_CHUNK_ROWS);
      const ack = await rpc(db, 'archive_journal_checkpoint_chunk', { p_user_id: scope.ownerId, p_connection_id: scope.connectionId,
        p_epoch: epoch, p_entity_keys: slice.flatMap(row => 'entity' in row ? [row.entity] : []),
        p_retained_ids: slice.flatMap(row => 'retained' in row ? [row.retained] : []),
        p_refs: manifest.refs.slice(chunk * ARCHIVE_CHUNK_REFS, (chunk + 1) * ARCHIVE_CHUNK_REFS) }, 'journal-checkpoint-write-failed');
      if (ack?.accepted !== true) return 'stale';
    }
    if (Date.now() > input.deadline) return 'deferred';
    const activated = await rpc(db, 'activate_journal_checkpoint', { p_user_id: scope.ownerId, p_connection_id: scope.connectionId,
      p_epoch: epoch, p_position_ids: before.map(episode => episode.id) }, 'journal-checkpoint-write-failed');
    return activated?.accepted === true ? 'advanced' : 'stale';
  }
  return 'no-candidate';
}
