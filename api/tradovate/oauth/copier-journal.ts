import type { VercelRequest, VercelResponse } from '@vercel/node';
import { authorizeTradovateCopierDevice } from '../../../server/tradovateCopierDevice.js';
import { createTradovateAdminClient, readTradovateServerConfig, requireSupabaseUserId } from '../../../server/tradovateOAuthStore.js';
import { storeJournalBatch } from '../../../server/tradovateJournalStore.js';
import { journalFeedCursor, readJournalEvidencePage } from '../../../server/journalEvidenceRead.js';
import { handleNativeCors } from '../../../server/nativeCors.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (handleNativeCors(req, res, ['GET', 'POST'])) return;
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).json({ error: 'method-not-allowed' });
  try {
    const config = readTradovateServerConfig();
    if (config.environment !== 'demo') return res.status(409).json({ error: 'copier-journal-demo-only' });
    const db = createTradovateAdminClient(config);
    if (req.method === 'GET') {
      const ownerId = await requireSupabaseUserId(req.headers.authorization, config);
      const connectionId = typeof req.query.connectionId === 'string' ? req.query.connectionId : '';
      const after = journalFeedCursor(req.query.after, 0);
      const through = req.query.through == null ? undefined : journalFeedCursor(req.query.through);
      return res.status(200).json(await readJournalEvidencePage(db, { ownerId, connectionId, environment: config.environment }, after, through));
    }
    const device = await authorizeTradovateCopierDevice({ db, authorization: req.headers.authorization });
    return res.status(200).json(await storeJournalBatch(db, device, req.body?.events));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('device-auth') || message.includes('device-revoked')) return res.status(401).json({ error: 'journal-unauthorized' });
    if (message === 'missing-auth-token' || message === 'invalid-auth-token') return res.status(401).json({ error: 'journal-unauthorized' });
    if (message === 'journal-connection-not-found') return res.status(404).json({ error: message });
    if (message.startsWith('invalid-journal-')) return res.status(400).json({ error: message });
    console.warn('[copier-journal] evidence upload failed');
    return res.status(502).json({ error: 'journal-unavailable' });
  }
}
