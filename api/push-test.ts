// ============================================================================
// Zkušební push notifikace
// ----------------------------------------------------------------------------
// Ověření doručení bez CRON_SECRET v URL. Autorizuje se JWT přihlášeného
// uživatele (stejný vzor jako edge funkce chat/tts): anon key nemá user.sub,
// takže ho getUser() odmítne.
//
// Klient se sem hlásí svým tokenem, takže RLS samo omezí `push_subscriptions`
// na jeho vlastní řádky — service role key tu není potřeba a záměrně se
// nepoužívá. Endpoint umí poslat notifikaci výhradně na vlastní zařízení.
// ============================================================================

import type { VercelRequest, VercelResponse } from '@vercel/node';
import webpush from 'web-push';
import { createClient } from '@supabase/supabase-js';
import { handleNativeCors } from '../server/nativeCors';

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL!;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY!;

const publicVapidKey = 'BCwmYrmEguddSKE2FKQX0dv1gPwEDbwmuSXhN7wiNJ8tH0Aw2wHTVHpblm8_bDMUkgVqkvPSLJ32aqY84t_tOO4';

export default async function handler(req: VercelRequest, res: VercelResponse) {
    if (handleNativeCors(req, res, ['POST'])) return;
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'method-not-allowed' });
    }

    const privateVapidKey = process.env.VAPID_PRIVATE_KEY;
    if (!privateVapidKey) {
        // Bez klíče by webpush spadl uvnitř — radši srozumitelná hláška, ať je
        // z UI hned poznat, že chybí konfigurace, ne že selhalo doručení.
        return res.status(500).json({ error: 'missing-vapid-key', message: 'VAPID_PRIVATE_KEY není nastavený ve Vercelu.' });
    }
    webpush.setVapidDetails('mailto:info@alphatrade.cz', publicVapidKey, privateVapidKey);

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'missing-token' });
    }

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
        global: { headers: { Authorization: authHeader } },
        auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userData?.user) {
        return res.status(401).json({ error: 'invalid-token' });
    }

    // RLS omezí výběr na vlastní odběry uživatele.
    const { data: devices, error: devicesErr } = await supabase
        .from('push_subscriptions')
        .select('id, endpoint, p256dh, auth, platform, user_agent')
        .is('expired_at', null);

    if (devicesErr) {
        return res.status(500).json({ error: 'devices-query-failed', message: devicesErr.message });
    }
    if (!devices || devices.length === 0) {
        return res.status(200).json({
            sent: 0,
            devices: 0,
            message: 'Žádné zařízení nemá registrovaný odběr. Zapni notifikace v Nastavení.',
            results: [],
        });
    }

    const stamp = new Intl.DateTimeFormat('cs-CZ', {
        timeZone: 'Europe/Prague', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).format(new Date());

    const payload = JSON.stringify({
        title: '✅ Test doručení',
        body: `Push notifikace fungují. Odesláno ${stamp}.`,
        url: '/',
        tag: 'alpha-push-test',
    });

    const results = await Promise.all(devices.map(async device => {
        const subscription = {
            endpoint: device.endpoint,
            keys: { p256dh: device.p256dh, auth: device.auth },
        };
        try {
            await webpush.sendNotification(subscription, payload, {
                timeout: 5000,
                TTL: 600,
                headers: { Topic: 'alpha-push-test', Urgency: 'high' },
            });
            return { id: device.id, platform: device.platform, status: 'sent' as const };
        } catch (e: any) {
            const statusCode = e?.statusCode || e?.status;
            const message = String(e?.body || e?.message || e).slice(0, 300);

            if (statusCode === 410 || statusCode === 404) {
                // Odběr už na straně push služby neexistuje. Označíme ho, ať ho
                // cron přeskakuje a v Nastavení je vidět jako "vypadlo".
                await supabase
                    .from('push_subscriptions')
                    .update({ expired_at: new Date().toISOString(), last_error: message })
                    .eq('id', device.id);
                return { id: device.id, platform: device.platform, status: 'expired' as const, statusCode, error: message };
            }
            return { id: device.id, platform: device.platform, status: 'failed' as const, statusCode, error: message };
        }
    }));

    const sent = results.filter(r => r.status === 'sent').length;
    return res.status(200).json({ sent, devices: devices.length, time: stamp, results });
}
