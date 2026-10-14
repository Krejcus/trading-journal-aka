import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createTradovateAdminClient, readTradovateServerConfig } from '../../server/tradovateOAuthStore.js';
import { importJournalPositions } from '../../server/journalPositionImport.js';

/**
 * Živý deník ze serveru (14. 10. 2026): každou minutu zpracuje připojení,
 * kde přibyla evidence od workeru — obchod se do deníku dostane i se
 * zavřenou appkou. Jeden importér na připojení hlídá lease v DB; souběh s
 * klientem nebo předchozím během jen vrátí „processing“.
 */
const RUN_BUDGET_MS = 50_000;
const MAX_CONNECTIONS = 20;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const started = Date.now();
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
          const result = await importJournalPositions(db, scope);
          state = result.processing ? 'processing' : result.unchanged ? 'unchanged' : result.accepted ? 'accepted' : 'stale';
          // Jiný importér drží lease: počkat na příští běh, neblokovat ostatní připojení.
          if (result.processing && result.through === 0 && result.targetThrough === 0) break;
        }
        results.push({ connectionId: scope.connectionId, state });
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
