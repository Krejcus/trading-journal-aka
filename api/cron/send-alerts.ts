import type { VercelRequest, VercelResponse } from '@vercel/node';
import webpush from 'web-push';
import { createClient } from '@supabase/supabase-js';

// Init Supabase with Service Role Key to bypass RLS in Cron job
const supabaseUrl = process.env.VITE_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY!;
const supabase = createClient(supabaseUrl, supabaseKey);

// Init Web Push
const publicVapidKey = 'BCwmYrmEguddSKE2FKQX0dv1gPwEDbwmuSXhN7wiNJ8tH0Aw2wHTVHpblm8_bDMUkgVqkvPSLJ32aqY84t_tOO4';
const privateVapidKey = process.env.VAPID_PRIVATE_KEY!;

webpush.setVapidDetails(
    'mailto:info@alphatrade.cz',
    publicVapidKey,
    privateVapidKey
);

// --- DYNAMIC CONTENT DATABASE ---
const TRADING_TIPS = [
    "Trpělivost platí tvé účty. Počkej si na setup.",
    "Trh nikam neuteče. Příležitostí je nekonečno.",
    "Tvoje ego je tvůj největší nepřítel. Bojuj s ním, ne s trhem.",
    "Risk management je jediný svatý grál tradingu.",
    "Ztráta je jen náklad na podnikání. Přijmi ji a jdi dál.",
    "Neobchoduj, když se nudíš. Obchoduj, když máš výhodu.",
    "Kvalita nad kvantitou. Jeden skvělý obchod stačí.",
    "Emoce jsou hluk. Plán je tvoje jediné ticho.",
    "Trh není tvůj kamarád, ale ani nepřítel. Je to zrcadlo tvé disciplíny.",
    "Dnešní výsledek definuje tvůj proces, ne tvoje štěstí."
];

export default async function handler(req: VercelRequest, res: VercelResponse) {
    const isManualDebug = req.query.debug === 'true';
    const mockType = req.query.type as string;

    if (!isManualDebug && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).end('Unauthorized');
    }

    // --- HTML DASHBOARD FOR MANUAL DEBUG ---
    if (isManualDebug && !mockType) {
        return res.status(200).send(`
            <!DOCTYPE html>
            <html lang="cs">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>AlphaTrade | Notification Lab</title>
                <script src="https://cdn.tailwindcss.com"></script>
                <style>
                    body { background: #060608; color: #fafafa; font-family: system-ui, -apple-system, sans-serif; }
                    .glass { background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05); backdrop-filter: blur(12px); }
                    .btn { transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1); }
                    .btn:active { scale: 0.96; }
                </style>
            </head>
            <body class="flex items-center justify-center min-h-screen p-4">
                <div class="max-w-md w-full glass p-6 rounded-[3rem] shadow-2xl border-white/5">
                    <div class="flex items-center gap-4 mb-10 p-2">
                        <div class="w-12 h-12 bg-blue-600 rounded-2xl flex items-center justify-center shadow-lg shadow-blue-500/20">
                            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
                        </div>
                        <div>
                            <h1 class="text-lg font-black italic tracking-tighter uppercase leading-none">Notification Lab</h1>
                            <p class="text-[9px] text-zinc-500 font-bold tracking-[0.3em] uppercase mt-1">Version 1.4.8 FINAL</p>
                        </div>
                    </div>
                    
                    <div class="space-y-6">
                        <!-- SECTION: REAL SEANCE -->
                        <div>
                            <p class="text-[9px] text-zinc-500 font-black uppercase tracking-[0.2em] mb-3 px-2 text-center underline decoration-blue-500/30">Sessions & Dynamic Tips:</p>
                            <div class="grid grid-cols-3 gap-2">
                                <a href="?debug=true&type=asia" class="btn p-3 glass hover:bg-zinc-800 rounded-2xl text-center flex flex-col items-center gap-1">
                                    <span class="text-lg">🌏</span>
                                    <span class="text-[8px] font-black uppercase">Asia</span>
                                </a>
                                <a href="?debug=true&type=london" class="btn p-3 glass hover:bg-zinc-800 rounded-2xl text-center flex flex-col items-center gap-1">
                                    <span class="text-lg">🏰</span>
                                    <span class="text-[8px] font-black uppercase">London</span>
                                </a>
                                <a href="?debug=true&type=ny" class="btn p-3 glass hover:bg-zinc-800 rounded-2xl text-center flex flex-col items-center gap-1">
                                    <span class="text-lg">🗽</span>
                                    <span class="text-[8px] font-black uppercase">NY</span>
                                </a>
                            </div>
                        </div>

                        <!-- SECTION: GUARDIAN PROGRESS -->
                        <div>
                            <p class="text-[9px] text-zinc-500 font-black uppercase tracking-[0.2em] mb-3 px-2 text-center italic">Guardian Progression:</p>
                            <div class="space-y-2">
                                <a href="?debug=true&type=g_30m" class="btn block w-full p-4 glass hover:bg-zinc-800 rounded-2xl flex items-center justify-between group">
                                    <div class="flex flex-col">
                                        <span class="text-[10px] font-black italic tracking-tight group-hover:text-amber-400 uppercase">🛡️ Alpha: Přípravný čas</span>
                                        <span class="text-[8px] text-zinc-500 font-medium">Stage 1: Klidné upozornění</span>
                                    </div>
                                    <span class="text-[10px] opacity-30 group-hover:opacity-100 transition-opacity">☕</span>
                                </a>
                                <a href="?debug=true&type=g_10m" class="btn block w-full p-4 glass hover:bg-zinc-800 rounded-2xl flex items-center justify-between group">
                                    <div class="flex flex-col">
                                        <span class="text-[10px] font-black italic tracking-tight group-hover:text-orange-400 uppercase">⚡ Alpha: Poslední výzva</span>
                                        <span class="text-[8px] text-zinc-500 font-medium">Stage 2: Urgentní varování</span>
                                    </div>
                                    <span class="text-[10px] opacity-30 group-hover:opacity-100 transition-opacity">⌛</span>
                                </a>
                                <a href="?debug=true&type=g_start" class="btn block w-full p-4 bg-rose-500/5 border border-rose-500/10 hover:bg-rose-500/10 rounded-2xl flex items-center justify-between group">
                                    <div class="flex flex-col text-left">
                                        <span class="text-[10px] font-black italic tracking-tight text-rose-500 uppercase leading-none mb-1">🚫 Alpha Guard: PŘÍSTUP BLOKOVÁN</span>
                                        <span class="text-[8px] text-zinc-500 font-medium tracking-tight">Stage 3: Zákaz obchodování</span>
                                    </div>
                                    <span class="text-[10px]">🛑</span>
                                </a>
                            </div>
                        </div>

                        <!-- SECTION: OTHERS -->
                        <div class="pt-4 border-t border-white/5 flex gap-2">
                            <a href="?debug=true&type=review_detox" class="btn flex-1 p-3 glass hover:bg-emerald-500/10 rounded-xl text-[9px] font-bold text-center uppercase tracking-wider group hover:text-emerald-400">📊 Review</a>
                            <a href="?debug=true&type=standard" class="btn flex-1 p-3 glass hover:bg-white/5 rounded-xl text-[9px] font-bold text-center uppercase tracking-wider text-zinc-500 underline decoration-zinc-800">Technický test</a>
                        </div>
                    </div>

                    <div class="mt-8 text-center">
                         <span class="text-[8px] font-bold text-zinc-700 uppercase tracking-[0.4em]">Proprietary AlphaGuard System</span>
                    </div>
                </div>
            </body>
            </html>
        `);
    }

    try {
        const now = new Date();
        const pragueTime = new Intl.DateTimeFormat('cs-CZ', {
            timeZone: 'Europe/Prague',
            hour: 'numeric',
            minute: 'numeric',
            hour12: false
        }).format(now);

        const [currentHour, currentMinute] = pragueTime.split(':').map(Number);
        const currentMinutesTotal = currentHour * 60 + currentMinute;

        // Pick dynamic trading tip based on today's day
        const tipIdx = now.getDate() % TRADING_TIPS.length;
        const dailyTip = TRADING_TIPS[tipIdx];

        let { data: profiles, error } = await supabase
            .from('profiles')
            .select('id, preferences');

        if (error || !profiles) {
            return res.status(500).json({ error: error?.message });
        }

        let sentCount = 0;

        for (const profile of profiles) {
            const prefs = profile.preferences || {};
            const sub = prefs.pushSubscription;
            const settings = prefs.systemSettings || {};
            const userSessions = prefs.sessions || [];

            if (!sub) continue;

            let shouldSend = false;
            let title = '';
            let body = '';

            // --- 1. HANDLE MOCK TYPES (MANUAL DEBUG) ---
            if (mockType) {
                switch (mockType) {
                    case 'asia':
                        shouldSend = true;
                        title = '🌏 ASIA OPEN';
                        body = dailyTip;
                        break;
                    case 'london':
                        shouldSend = true;
                        title = '🏰 LONDON OPEN';
                        body = dailyTip;
                        break;
                    case 'ny':
                        shouldSend = true;
                        title = '🗽 NY OPEN';
                        body = dailyTip;
                        break;
                    case 'g_30m':
                        shouldSend = true;
                        title = '🛡️ Alpha: Přípravný čas';
                        body = 'Trhy se pomalu probouzejí. Ideální čas postavit si herní plán v klidu.';
                        break;
                    case 'g_10m':
                        shouldSend = true;
                        title = '⚡ Alpha: Poslední výzva';
                        body = 'Seance startuje za 10 minut. Stále ti chybí hotová příprava!';
                        break;
                    case 'g_start':
                        shouldSend = true;
                        title = '🚫 Alpha Guard: PŘÍSTUP BLOKOVÁN';
                        body = 'Střežený režim aktivní. Nemáte herní plán - dnes jen sledujte.';
                        break;
                    case 'review_detox':
                        shouldSend = true;
                        title = '📊 KONEC DNE';
                        body = 'Grafy tě už nepotřebují. Uzavři deník a vypni terminál.';
                        break;
                    default:
                        shouldSend = true;
                        title = 'AlphaTrade Diagnostika';
                        body = `Server běží OK. (${pragueTime})`;
                }
            } else {
                // --- 2. REAL CRON LOGIC (AUTOMATIC) ---
                if (settings.sessionAlertsEnabled) {
                    for (const session of userSessions) {
                        const [sH, sM] = (session.startTime || "0:0").split(':').map(Number);
                        const startMTotal = sH * 60 + sM;

                        // Exact Session Start?
                        if (settings.sessionStartAlertExact && Math.abs(currentMinutesTotal - startMTotal) <= 1) {
                            shouldSend = true;
                            let emoji = '🔔';
                            const nameLower = (session.name || '').toLowerCase();
                            if (nameLower.includes('asia')) emoji = '🌏';
                            if (nameLower.includes('london') || nameLower.includes('eu')) emoji = '🏰';
                            if (nameLower.includes('ny') || nameLower.includes('usa')) emoji = '🗽';
                            title = `${emoji} ${session.name} začíná`;
                            body = dailyTip;
                        }

                        // TODO: Add logic for T-30 and T-10 automated alerts based on real DB preps
                    }
                }

                if (settings.testModeEnabled || prefs.testModeEnabled) {
                    shouldSend = true;
                    title = `AlphaTrade Debug (${pragueTime})`;
                    body = `Automatické hlášení aktivní.`;
                }
            }

            if (shouldSend) {
                const alertType = mockType || 'session';
                const result = await sendPush(sub, title, body, alertType);
                if (result === 'sent') sentCount++;
                if (result === 'expired') {
                    // Subscription is dead (410 Gone) - clean it from DB
                    const cleanedPrefs = { ...prefs };
                    delete cleanedPrefs.pushSubscription;
                    await supabase
                        .from('profiles')
                        .update({ preferences: cleanedPrefs })
                        .eq('id', profile.id);
                    console.log(`[Cleanup] Removed expired push subscription for user ${profile.id}`);
                }
            }
        }

        if (mockType) {
            return res.status(200).send(`
                <body style="background:#060608;color:#fafafa;display:flex;align-items:center;justify-content:center;min-height:100vh;flex-direction:column;font-family:sans-serif;padding:20px;text-align:center;">
                    <div style="font-size:40px;margin-bottom:20px;">⚡</div>
                    <h1 style="font-weight:900;margin-top:20px;text-transform:uppercase;letter-spacing:-1px;">NASAZENO</h1>
                    <p style="color:#71717a;margin-top:10px;font-size:14px;max-width:300px;">Zpráva odeslána.</p>
                    <a href="?debug=true" style="margin-top:40px;color:#3b82f6;text-decoration:none;font-weight:bold;font-size:11px;text-transform:uppercase;letter-spacing:1px;border:1px solid #3b82f644;padding:12px 24px;border-radius:15px;background:rgba(255,255,255,0.02);">Zpět do labu</a>
                </body>
            `);
        }

        return res.status(200).json({ success: true, sent: sentCount });

    } catch (err: any) {
        return res.status(500).json({ error: err.message });
    }
}

async function sendPush(sub: any, title: string, body: string, alertType: string): Promise<'sent' | 'expired' | 'failed'> {
    const payload = JSON.stringify({ title, body, url: '/', tag: `alpha-${alertType}` });
    try {
        await webpush.sendNotification(sub, payload, {
            timeout: 5000,
            TTL: 3600,
            headers: {
                'Topic': `alpha-${alertType}`,
                'Urgency': 'high'
            }
        });
        return 'sent';
    } catch (e: any) {
        const statusCode = e?.statusCode || e?.status;
        if (statusCode === 410 || statusCode === 404) {
            return 'expired';
        }
        console.error(`Push error (${statusCode}):`, e?.body || e?.message || e);
        return 'failed';
    }
}
