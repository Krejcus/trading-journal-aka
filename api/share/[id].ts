/**
 * Vercel Serverless Function — `/api/share/[id]`
 *
 * Účel: Vrací HTML s OG (Open Graph) + Twitter Card meta tagy pro public sharing.
 *
 * Flow:
 *   1. Crawler (Discord/X/Slack) navštíví `https://alphatrade.app/share/abc-123`
 *   2. Vercel rewrite: `/share/:id` → `/api/share/:id` (tato funkce)
 *   3. Funkce načte trade z Supabase (public RLS — read-only pro public trades)
 *   4. Vrátí HTML s og:title, og:description, og:image
 *   5. Crawler vidí meta tagy → vygeneruje preview card v chatu
 *   6. Pokud místo crawleru přijde human (browser), JS redirect na `/?shareId=abc-123`
 *
 * og:image = trade.screenshot (Supabase Storage URL — public CDN)
 * Pokud screenshot chybí, fallback na app logo.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

// Vercel runtime config — použijeme Node.js runtime kvůli @supabase/supabase-js
export const config = { runtime: 'nodejs' };

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL!;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY!;

const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false },
});

/** Bezpečné escape HTML pro meta tag values */
function escapeHtml(s: string): string {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** Formátování PnL pro nadpis */
function fmtPnl(pnl: number): string {
    const sign = pnl >= 0 ? '+' : '';
    return `${sign}$${Math.round(pnl).toLocaleString('en-US')}`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
    const idParam = req.query?.id;
    const id = (Array.isArray(idParam) ? idParam[0] : idParam) || req.url?.split('/').pop()?.split('?')[0];
    if (!id) {
        res.status(400).send('Missing trade ID');
        return;
    }

    // Public metadata and redirects must never trust request Host headers.
    const configuredOrigin = process.env.APP_URL || process.env.VITE_APP_URL || 'https://alphatrade.app';
    const origin = configuredOrigin.replace(/\/$/, '');
    const appUrl = `${origin}/?shareId=${id}`;
    const shareUrl = `${origin}/share/${id}`;

    // Fallback hodnoty pokud trade nenajdeme nebo není public
    let title = 'AlphaTrade — Trade Journal';
    let description = 'Profesionální trading journal s AI Coachem a pattern analýzou.';
    let image = `${origin}/logos/at_logo_light_clean.png`;

    try {
        // Fetch trade — RLS dovolí jen `is_public = true` pro anon role
        const { data: trade, error } = await supabase
            .from('trades')
            .select('id, instrument, direction, pnl, data, date, is_public')
            .eq('id', id)
            .eq('is_public', true)
            .maybeSingle();

        if (!error && trade) {
            const pnl = Number(trade.pnl || 0);
            const direction = String(trade.direction || '').toUpperCase();
            const instrument = trade.instrument || 'Trade';
            const tradeData: any = trade.data || {};

            // R-multiple
            const riskAmount = Number(tradeData.riskAmount || 0);
            const rText = riskAmount > 0 ? ` · ${(pnl / riskAmount).toFixed(1)}R` : '';

            title = `${instrument} ${direction} ${fmtPnl(pnl)}${rText} | AlphaTrade`;

            // Description: konfluence + session pokud existuje
            const htf = (tradeData.htfConfluence || []).slice(0, 2).join(', ');
            const session = tradeData.session ? ` · ${tradeData.session}` : '';
            description = htf
                ? `${htf}${session} · Trade idea sdílená přes AlphaTrade.`
                : `${pnl >= 0 ? 'Winning' : 'Losing'} ${direction.toLowerCase()} trade na ${instrument}${session}.`;

            // Screenshot — OG preview image
            const screenshot = tradeData.screenshot || (Array.isArray(tradeData.screenshots) ? tradeData.screenshots[0] : null);
            if (screenshot && typeof screenshot === 'string' && !screenshot.startsWith('data:')) {
                image = screenshot;
            }
        }
    } catch (e) {
        console.warn('[share] Failed to fetch trade:', e);
        // Pokračujeme s default hodnotami
    }

    // HTML response — OG tagy + meta refresh fallback + JS redirect pro humans
    const html = `<!DOCTYPE html>
<html lang="cs">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}" />

<!-- Open Graph / Facebook -->
<meta property="og:type" content="article" />
<meta property="og:url" content="${escapeHtml(shareUrl)}" />
<meta property="og:title" content="${escapeHtml(title)}" />
<meta property="og:description" content="${escapeHtml(description)}" />
<meta property="og:image" content="${escapeHtml(image)}" />
<meta property="og:image:width" content="1600" />
<meta property="og:image:height" content="900" />
<meta property="og:site_name" content="AlphaTrade" />

<!-- Twitter -->
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:url" content="${escapeHtml(shareUrl)}" />
<meta name="twitter:title" content="${escapeHtml(title)}" />
<meta name="twitter:description" content="${escapeHtml(description)}" />
<meta name="twitter:image" content="${escapeHtml(image)}" />

<!-- Redirect humans (NOT crawlers, ti JS nezpracují) -->
<meta http-equiv="refresh" content="0; url=${escapeHtml(appUrl)}" />
<script>window.location.replace(${JSON.stringify(appUrl)});</script>

<style>
  body { font-family: -apple-system, sans-serif; background: #0a0e1a; color: white; margin: 0; padding: 60px 24px; text-align: center; }
  .logo { width: 80px; height: 80px; margin-bottom: 24px; }
  .title { font-size: 24px; font-weight: 700; margin-bottom: 12px; }
  .link { color: #22d3ee; text-decoration: none; font-weight: 600; }
</style>
</head>
<body>
<img src="${escapeHtml(origin)}/logos/at_logo_light_clean.png" alt="AlphaTrade" class="logo" />
<div class="title">${escapeHtml(title)}</div>
<p>Otevírám AlphaTrade...</p>
<p><a class="link" href="${escapeHtml(appUrl)}">Klikni pokud se nepřesměruje</a></p>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // Cache for 5 minutes — trade data může změnit, ale meta tagy se obnovují
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
    res.status(200).send(html);
}
