import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createTradovateAdminClient, readTradovateServerConfig, requireSupabaseUserId } from '../../../server/tradovateOAuthStore.js';
import { importJournalPositions } from '../../../server/journalPositionImport.js';
import { handleNativeCors } from '../../../server/nativeCors.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (handleNativeCors(req, res, ['POST'])) return;
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method-not-allowed' });
  try {
    const config = readTradovateServerConfig();
    if (config.environment !== 'demo') return res.status(409).json({ error: 'copier-journal-demo-only' });
    const ownerId = await requireSupabaseUserId(req.headers.authorization, config);
    // Reject extra financial fields instead of silently accepting a misleading
    // client payload. All facts are recomputed from stored broker observations.
    if (!req.body || typeof req.body.connectionId !== 'string' || Object.keys(req.body).length !== 1) {
      return res.status(400).json({ error: 'invalid-journal-import' });
    }
    return res.status(200).json(await importJournalPositions(createTradovateAdminClient(config),
      { ownerId, connectionId: req.body.connectionId, environment: config.environment }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'missing-auth-token' || message === 'invalid-auth-token') return res.status(401).json({ error: 'journal-unauthorized' });
    if (message === 'journal-connection-not-found') return res.status(404).json({ error: message });
    if (message.startsWith('invalid-journal-')) return res.status(400).json({ error: message });
    if (message === 'journal-import-partition-required') return res.status(409).json({ error: message });
    if (['journal-legacy-reference-ambiguous', 'journal-legacy-connection-unavailable'].includes(message)) return res.status(409).json({ error: message });
    console.warn('[journal-import] position persistence failed');
    return res.status(502).json({ error: 'journal-unavailable' });
  }
}
