import type { SupabaseClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { journalObservation, type JournalEvidence } from '../lib/tradovateJournalEvidence.js';
import type { AuthorizedTradovateCopierDevice } from './tradovateCopierDevice.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function validateJournalBatch(input: unknown, connectionId: string, environment: 'demo' | 'live'): JournalEvidence[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 100 || Buffer.byteLength(JSON.stringify(input)) > 250_000) throw new Error('invalid-journal-batch');
  return input.map(value => {
    if (!value || typeof value !== 'object') throw new Error('invalid-journal-event');
    const event = value as JournalEvidence;
    if (event.connectionId !== connectionId || event.environment !== environment) throw new Error('invalid-journal-connection');
    if (!/^[0-9a-f]{64}$/.test(event.id) || !UUID.test(event.sessionId)
      || !Number.isSafeInteger(event.sequence) || event.sequence <= 0
      || !['stream', 'snapshot', 'transport'].includes(event.source)
      || typeof event.entityType !== 'string' || typeof event.eventType !== 'string'
      || !Number.isFinite(event.receivedAt) || event.receivedAt < 0 || event.receivedAt > Date.now() + 300_000) throw new Error('invalid-journal-event');
    const safe = journalObservation(event.entityType, event.entity, event.source, event.eventType, event.receivedAt);
    if (!safe || safe.eventType !== event.eventType || safe.entityType !== event.entityType
      || JSON.stringify(safe.entity) !== JSON.stringify(event.entity)) throw new Error('invalid-journal-entity');
    const { id, ...payload } = event;
    if (Object.keys(payload).length !== 9 || createHash('sha256').update(JSON.stringify(payload)).digest('hex') !== id) {
      throw new Error('invalid-journal-integrity');
    }
    return { ...safe, id: event.id, connectionId, environment, sessionId: event.sessionId, sequence: event.sequence };
  });
}

export async function storeJournalBatch(db: SupabaseClient, device: AuthorizedTradovateCopierDevice, input: unknown) {
  // Existing device authentication is DEMO-only. Do not trust an environment from the payload.
  const events = validateJournalBatch(input, device.connectionId, 'demo');
  const { data, error } = await db.rpc('append_tradovate_journal_evidence', {
    p_user_id: device.userId, p_connection_id: device.connectionId, p_device_id: device.id, p_events: events,
  });
  if (error) throw new Error(`journal-evidence-write-failed: ${error.message}`);
  if (data?.accepted !== true || !Array.isArray(data.ids) || data.ids.length !== events.length
    || new Set(data.ids).size !== events.length || events.some(event => !data.ids.includes(event.id))) {
    throw new Error('journal-evidence-write-not-confirmed');
  }
  return { accepted: true, ids: events.map(event => event.id) };
}
