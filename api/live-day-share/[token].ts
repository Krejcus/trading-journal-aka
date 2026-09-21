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

/**
 * Odkaz otevírá člověk, ne stroj: holý `{"error":...}` je pro příjemce
 * nečitelný. Stroji (og crawler, appka s `?format=json`) zůstává JSON.
 */
const wantsJson = (req: VercelRequest): boolean =>
  req.query?.format === 'json' || String(req.headers.accept ?? '').includes('application/json');

const problemPage = (res: VercelResponse, status: number, heading: string, detail: string) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  return res.status(status).send(`<!doctype html>
<html lang="cs"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="robots" content="noindex,nofollow" />
<title>${escapeHtml(heading)} | AlphaTrade</title>
<style>body{margin:0;background:#020617;color:#fff;font-family:Inter,-apple-system,sans-serif;
display:grid;min-height:100vh;place-items:center;text-align:center;padding:24px}
h1{font-size:20px;font-weight:900;margin:18px 0 8px}p{margin:0;font-size:13px;color:#94a3b8;max-width:38ch;line-height:1.6}
img{width:64px;height:64px;object-fit:contain}</style></head>
<body><div><img src="/logos/at_logo_light_clean.png" alt="AlphaTrade" />
<h1>${escapeHtml(heading)}</h1><p>${escapeHtml(detail)}</p></div></body></html>`);
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method-not-allowed' });
  const token = tokenFromRequest(req);
  if (!LIVE_DAY_SHARE_TOKEN_PATTERN.test(token)) {
    return wantsJson(req)
      ? res.status(400).json({ error: 'invalid-share-token' })
      // Nejčastější příčina: k odkazu se při vložení do zprávy přilepila
      // tečka nebo závorka, takže token v adrese už není platné UUID.
      : problemPage(res, 400, 'Odkaz je poškozený',
          'Adresa nevypadá jako platný odkaz na kartu dne. Nejspíš se k ní na konci přilepil znak navíc — zkus ji zkopírovat znovu, celou a bez interpunkce.');
  }

  try {
    const row = await readPublicLiveDayShareRow(createLiveDayShareAdminClient(), token);
    const snapshot = row ? publicLiveDayShareFromRow(row) : null;
    if (!row || !snapshot) {
      return wantsJson(req)
        ? res.status(404).json({ error: 'share-not-found' })
        : problemPage(res, 404, 'Tato karta už není dostupná',
            'Odkaz je neplatný nebo jej autor zneplatnil.');
    }

    if (wantsJson(req)) {
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
