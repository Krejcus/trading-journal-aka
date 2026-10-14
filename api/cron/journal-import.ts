import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createTradovateAdminClient, readTradovateServerConfig } from '../../server/tradovateOAuthStore.js';
import { importJournalPositions } from '../../server/journalPositionImport.js';
import { journalCheckpointsEnabled } from '../../server/journalCheckpointStore.js';
import { verifyJournalConnection } from '../../server/journalVerification.js';

/** Denní plná kontrola v klidu: denní pauza CME (21–22 UTC) nebo víkend. */
const quietForVerification = (at: Date) => at.getUTCHours() === 21 || at.getUTCDay() === 6 || (at.getUTCDay() === 0 && at.getUTCHours() < 21);
const VERIFY_EVERY_MS = 20 * 60 * 60_000;

/**
 * Živý deník ze serveru (14. 10. 2026): každou minutu zpracuje připojení,
 * kde přibyla evidence od workeru — obchod se do deníku dostane i se
 * zavřenou appkou. Jeden importér na připojení hlídá lease v DB; souběh s
 * klientem nebo předchozím během jen vrátí „processing“.
 */
const RUN_BUDGET_MS = 270_000;
const MAX_CONNECTIONS = 20;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const started = Date.now();
  // Bez kontrolních bodů by každý běh četl celou historii (desítky MB) —
  // serverový import běží jen se zapnutým živým deníkem.
  if (!journalCheckpointsEnabled()) return res.status(200).json({ skipped: 'checkpoints-off' });
  try {
    const settings = readTradovateServerConfig();
    if (settings.environment !== 'demo') return res.status(200).json({ skipped: 'demo-only' });
    const db = createTradovateAdminClient(settings);
    const { data, error } = await db.from('tradovate_oauth_connections').select('id,user_id')
      .eq('environment', 'demo').order('updated_at', { ascending: false }).limit(MAX_CONNECTIONS);
    if (error || !Array.isArray(data)) throw new Error('journal-connections-unavailable');
    const results: Array<{ connectionId: string; state: string }> = [];
    for (const row of data) {
      if (Date.now() - started > RUN_BUDGET_MS) break;
      const scope = { ownerId: String(row.user_id), connectionId: String(row.id), environment: 'demo' as const };
      try {
        // Rozpracovaná příprava vstupu pokračuje v rámci jednoho běhu.
        let state = 'processing';
        for (let step = 0; step < 20 && state === 'processing' && Date.now() - started < RUN_BUDGET_MS; step++) {
          const result = await importJournalPositions(db, scope, { budgetMs: RUN_BUDGET_MS - (Date.now() - started) });
          state = result.processing ? 'processing' : result.unchanged ? 'unchanged' : result.accepted ? 'accepted' : 'stale';
          // Jiný importér drží lease: počkat na příští běh, neblokovat ostatní připojení.
          if (result.processing && result.through === 0 && result.targetThrough === 0) break;
        }
        results.push({ connectionId: scope.connectionId, state });
        if (journalCheckpointsEnabled() && quietForVerification(new Date()) && Date.now() - started < RUN_BUDGET_MS / 2) {
          const { data: head } = await db.from('tradovate_journal_input_heads').select('verified_at,checkpoint_epoch')
            .eq('user_id', scope.ownerId).eq('connection_id', scope.connectionId).maybeSingle();
          if (head && Number(head.checkpoint_epoch) > 0 && (!head.verified_at || Date.now() - Date.parse(head.verified_at) > VERIFY_EVERY_MS)) {
            const verification = await verifyJournalConnection(db, scope, started + RUN_BUDGET_MS);
            results.push({ connectionId: scope.connectionId, state: `verify:${verification.state}` });
          }
        }
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        const code = /^[a-z0-9-]{1,80}$/.test(message) ? message : 'unexpected';
        if (code !== 'journal-connection-not-found') console.warn('[cron/journal-import] import failed', code);
        results.push({ connectionId: scope.connectionId, state: `failed:${code}` });
      }
    }
    return res.status(200).json({ ms: Date.now() - started, results });
  } catch (reason) {
    console.warn('[cron/journal-import] run failed', reason instanceof Error ? reason.message : String(reason));
    return res.status(500).json({ error: 'journal-cron-failed' });
  }
}
