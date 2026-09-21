import type { VercelRequest, VercelResponse } from '@vercel/node';

import { LIVE_DAY_SHARE_TOKEN_PATTERN, liveDayShareMoney } from '../../lib/liveDayShare.js';
import {
  createLiveDayShareAdminClient,
  publicLiveDayShareFromRow,
  readPublicLiveDayShareRow,
  resolveLiveDayShareOrigin,
} from '../../server/liveDayShareStore.js';

const escapeHtml = (value: string): string => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const tokenFromRequest = (req: VercelRequest): string => {
  const raw = req.query?.token;
  return String(Array.isArray(raw) ? raw[0] ?? '' : raw ?? '').trim();
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method-not-allowed' });
  const token = tokenFromRequest(req);
  if (!LIVE_DAY_SHARE_TOKEN_PATTERN.test(token)) return res.status(400).json({ error: 'invalid-share-token' });

  try {
    const row = await readPublicLiveDayShareRow(createLiveDayShareAdminClient(), token);
    const snapshot = row ? publicLiveDayShareFromRow(row) : null;
    if (!row || !snapshot) return res.status(404).json({ error: 'share-not-found' });

    if (req.query?.format === 'json' || String(req.headers.accept ?? '').includes('application/json')) {
      res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=60');
      return res.status(200).json(snapshot);
    }

    const origin = resolveLiveDayShareOrigin();
    if (!origin) return res.status(500).send('Share origin is not configured.');
    const shareUrl = `${origin}/day/${encodeURIComponent(token)}`;
    const appUrl = `${origin}/?dayShare=${encodeURIComponent(token)}`;
    const imageUrl = `${origin}/api/live-day-share-image/${encodeURIComponent(token)}`;
    const date = new Intl.DateTimeFormat('cs-CZ', {
      day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC',
    }).format(new Date(`${snapshot.tradeDate}T12:00:00Z`));
    const title = `${liveDayShareMoney(snapshot.summary.confirmed)} · Karta dne | AlphaTrade`;
    const trades = snapshot.trades == null ? '—' : String(snapshot.trades);
    const description = `${snapshot.owner.name} · ${date} · ${trades} leader obchodů · ${snapshot.summary.accountCount} účtů`;

    const html = `<!doctype html>
<html lang="cs">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}" />
  <meta name="robots" content="noindex,nofollow" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="AlphaTrade" />
  <meta property="og:url" content="${escapeHtml(shareUrl)}" />
  <meta property="og:title" content="${escapeHtml(title)}" />
  <meta property="og:description" content="${escapeHtml(description)}" />
  <meta property="og:image" content="${escapeHtml(imageUrl)}" />
  <meta property="og:image:type" content="image/png" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escapeHtml(title)}" />
  <meta name="twitter:description" content="${escapeHtml(description)}" />
  <meta name="twitter:image" content="${escapeHtml(imageUrl)}" />
  <meta http-equiv="refresh" content="0;url=${escapeHtml(appUrl)}" />
  <script>window.location.replace(${JSON.stringify(appUrl)});</script>
  <style>body{margin:0;background:#020617;color:#fff;font-family:Inter,-apple-system,sans-serif;display:grid;min-height:100vh;place-items:center}a{color:#22d3ee}</style>
</head>
<body><p>Otevírám kartu dne… <a href="${escapeHtml(appUrl)}">Pokračovat</a></p></body>
</html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=60');
    res.setHeader('Referrer-Policy', 'no-referrer');
    return res.status(200).send(html);
  } catch (error) {
    console.error('[live-day-share] read failed:', error instanceof Error ? error.message : String(error));
    return res.status(503).json({ error: 'share-unavailable' });
  }
}
