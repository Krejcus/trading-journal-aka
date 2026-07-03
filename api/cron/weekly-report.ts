// Vercel cron → Supabase edge funkce weekly-report (neděle večer, viz vercel.json).
// Jen tenký trigger: auth přes CRON_SECRET (Vercel posílá Bearer), edge funkce
// dostane secret v x-cron-secret a udělá veškerou práci (Anthropic key žije tam).
import type { VercelRequest, VercelResponse } from '@vercel/node';

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL!;

export default async function handler(req: VercelRequest, res: VercelResponse) {
    const secret = process.env.CRON_SECRET;
    if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
        return res.status(401).json({ error: 'unauthorized' });
    }
    try {
        const r = await fetch(`${supabaseUrl}/functions/v1/weekly-report`, {
            method: 'POST',
            headers: { 'x-cron-secret': secret, 'content-type': 'application/json' },
            body: '{}',
        });
        const body = await r.json().catch(() => ({}));
        return res.status(r.ok ? 200 : 502).json(body);
    } catch (e: any) {
        return res.status(500).json({ error: String(e?.message || e) });
    }
}
