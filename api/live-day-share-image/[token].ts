import type { VercelRequest, VercelResponse } from '@vercel/node';

import { LIVE_DAY_SHARE_PREVIEW_BUCKET, LIVE_DAY_SHARE_TOKEN_PATTERN } from '../../lib/liveDayShare.js';
import { createLiveDayShareAdminClient, readPublicLiveDayShareRow } from '../../server/liveDayShareStore.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method-not-allowed' });
  const raw = req.query?.token;
  const token = String(Array.isArray(raw) ? raw[0] ?? '' : raw ?? '').trim();
  if (!LIVE_DAY_SHARE_TOKEN_PATTERN.test(token)) return res.status(400).json({ error: 'invalid-share-token' });

  try {
    const db = createLiveDayShareAdminClient();
    const row = await readPublicLiveDayShareRow(db, token);
    if (!row) return res.status(404).json({ error: 'share-not-found' });
    const { data, error } = await db.storage.from(LIVE_DAY_SHARE_PREVIEW_BUCKET).download(row.preview_path);
    if (error || !data) return res.status(404).json({ error: 'preview-not-found' });
    const bytes = Buffer.from(await data.arrayBuffer());
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Length', String(bytes.byteLength));
    res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=60');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.status(200).send(bytes);
  } catch (error) {
    console.error('[live-day-share-image] read failed:', error instanceof Error ? error.message : String(error));
    return res.status(503).json({ error: 'preview-unavailable' });
  }
}
