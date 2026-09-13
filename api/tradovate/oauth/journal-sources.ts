import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createTradovateAdminClient, readTradovateServerConfig, requireSupabaseUserId } from '../../../server/tradovateOAuthStore.js';
import { handleNativeCors } from '../../../server/nativeCors.js';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
/** Read stored availability only. No OAuth token decryption or broker request. */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (handleNativeCors(req, res, ['POST'])) return;
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method-not-allowed' });
  try {
    const config = readTradovateServerConfig();
    const ownerId = await requireSupabaseUserId(req.headers.authorization, config);
    const ids: unknown = req.body?.connectionIds;
    if (!req.body || Object.keys(req.body).length !== 1 || !Array.isArray(ids) || ids.length < 1 || ids.length > 25
      || ids.some(id => typeof id !== 'string' || !uuid.test(id)) || new Set(ids.map(id => id.toLowerCase())).size !== ids.length) {
      return res.status(400).json({ error: 'invalid-journal-source-scope' });
    }
    const { data, error } = await createTradovateAdminClient(config).rpc('read_journal_source_status', {
      p_user_id: ownerId, p_connection_ids: ids,
    }).abortSignal(AbortSignal.timeout(20_000));
    if (error?.code === '42501') return res.status(404).json({ error: 'journal-source-scope-unavailable' });
    if (error || !data) return res.status(502).json({ error: 'journal-source-unavailable' });
    return res.status(200).json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message === 'missing-auth-token' || message === 'invalid-auth-token') return res.status(401).json({ error: 'journal-unauthorized' });
    return res.status(502).json({ error: 'journal-source-unavailable' });
  }
}
