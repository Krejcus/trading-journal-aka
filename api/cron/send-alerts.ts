import type { VercelRequest, VercelResponse } from '@vercel/node';
import webpush from 'web-push';
import { createClient } from '@supabase/supabase-js';

// Init Supabase with Service Role Key to bypass RLS in Cron job
// VITE_ prefix vars are only available at build time, not in serverless runtime
const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY!;
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

        // Today's date in Prague timezone (YYYY-MM-DD)
        const todayStr = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Prague' }).format(now);

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

            // Collect all alerts for this user (multiple can fire in one cron run)
            const alerts: { title: string; body: string; type: string }[] = [];

            // --- 1. HANDLE MOCK TYPES (MANUAL DEBUG) ---
            if (mockType) {
                switch (mockType) {
                    case 'asia':
                        alerts.push({ title: '🌏 ASIA OPEN', body: dailyTip, type: 'asia' });
                        break;
                    case 'london':
                        alerts.push({ title: '🏰 LONDON OPEN', body: dailyTip, type: 'london' });
                        break;
                    case 'ny':
                        alerts.push({ title: '🗽 NY OPEN', body: dailyTip, type: 'ny' });
                        break;
                    case 'g_30m':
                        alerts.push({ title: '🛡️ Alpha: Přípravný čas', body: 'Trhy se pomalu probouzejí. Ideální čas postavit si herní plán v klidu.', type: 'g_30m' });
                        break;
                    case 'g_10m':
                        alerts.push({ title: '⚡ Alpha: Poslední výzva', body: 'Seance startuje za 10 minut. Stále ti chybí hotová příprava!', type: 'g_10m' });
                        break;
                    case 'g_start':
                        alerts.push({ title: '🚫 Alpha Guard: PŘÍSTUP BLOKOVÁN', body: 'Střežený režim aktivní. Nemáte herní plán - dnes jen sledujte.', type: 'g_start' });
                        break;
                    case 'review_detox':
                        alerts.push({ title: '📊 KONEC DNE', body: 'Grafy tě už nepotřebují. Uzavři deník a vypni terminál.', type: 'review_detox' });
                        break;
                    default:
                        alerts.push({ title: 'AlphaTrade Diagnostika', body: `Server běží OK. (${pragueTime})`, type: 'standard' });
                }
            } else {
                // --- 2. REAL CRON LOGIC (AUTOMATIC) ---

                // Helper: get session emoji
                const getEmoji = (name: string) => {
                    const n = name.toLowerCase();
                    if (n.includes('asia')) return '🌏';
                    if (n.includes('london') || n.includes('eu')) return '🏰';
                    if (n.includes('ny') || n.includes('usa')) return '🗽';
                    return '🔔';
                };

                // Lazy-loaded DB data (only fetched if needed)
                let _hasPrepToday: boolean | null = null;
                let _hasReviewToday: boolean | null = null;
                let _isDebtActive: boolean | null = null;

                const hasPrepToday = async () => {
                    if (_hasPrepToday !== null) return _hasPrepToday;
                    const { count } = await supabase.from('daily_preps').select('id', { count: 'exact', head: true }).eq('user_id', profile.id).eq('date', todayStr);
                    _hasPrepToday = (count || 0) > 0;
                    return _hasPrepToday;
                };
                const hasReviewToday = async () => {
                    if (_hasReviewToday !== null) return _hasReviewToday;
                    const { count } = await supabase.from('daily_reviews').select('id', { count: 'exact', head: true }).eq('user_id', profile.id).eq('date', todayStr);
                    _hasReviewToday = (count || 0) > 0;
                    return _hasReviewToday;
                };
                const isDebtActive = async () => {
                    if (_isDebtActive !== null) return _isDebtActive;
                    // Debt = last day with a prep has no review
                    const { data: lastPrep } = await supabase.from('daily_preps').select('date').eq('user_id', profile.id).lt('date', todayStr).order('date', { ascending: false }).limit(1);
                    if (!lastPrep || lastPrep.length === 0) { _isDebtActive = false; return false; }
                    const lastPrepDate = lastPrep[0].date;
                    const { count } = await supabase.from('daily_reviews').select('id', { count: 'exact', head: true }).eq('user_id', profile.id).eq('date', lastPrepDate);
                    _isDebtActive = (count || 0) === 0;
                    return _isDebtActive;
                };

                // Find first session of the day (for morning prep alerts)
                let firstSessionStart = Infinity;
                let firstSessionName = '';
                for (const s of userSessions) {
                    const [h, m] = (s.startTime || '0:0').split(':').map(Number);
                    const mins = h * 60 + m;
                    if (mins < firstSessionStart) {
                        firstSessionStart = mins;
                        firstSessionName = s.name;
                    }
                }

                // === SESSION ALERTS ===
                if (settings.sessionAlertsEnabled) {
                    for (const session of userSessions) {
                        const [sH, sM] = (session.startTime || '0:0').split(':').map(Number);
                        const [eH, eM] = (session.endTime || '0:0').split(':').map(Number);
                        const startM = sH * 60 + sM;
                        const endM = eH * 60 + eM;
                        const emoji = getEmoji(session.name);

                        // T-15 before session start
                        if (settings.sessionStartAlert15m && Math.abs(currentMinutesTotal - (startM - 15)) <= 1) {
                            alerts.push({
                                title: `${emoji} ${session.name} za 15 minut`,
                                body: 'Připrav se na seanci. Zkontroluj svůj herní plán.',
                                type: `session-t15-${session.id || session.name}`
                            });
                        }

                        // Exact session start
                        if (settings.sessionStartAlertExact && Math.abs(currentMinutesTotal - startM) <= 1) {
                            alerts.push({
                                title: `${emoji} ${session.name} začíná`,
                                body: dailyTip,
                                type: `session-start-${session.id || session.name}`
                            });
                        }

                        // T-10 before session end
                        if (settings.sessionEndAlert10m && Math.abs(currentMinutesTotal - (endM - 10)) <= 1) {
                            alerts.push({
                                title: `⏰ ${session.name} končí za 10 minut`,
                                body: 'Uzavři otevřené pozice a dodržuj plán.',
                                type: `session-end10-${session.id || session.name}`
                            });
                        }

                        // Exact session end
                        if (settings.sessionEndAlertExact && Math.abs(currentMinutesTotal - endM) <= 1) {
                            alerts.push({
                                title: `🏁 ${session.name} skončila`,
                                body: 'Ruce pryč od klávesnice. Čas na review.',
                                type: `session-end-${session.id || session.name}`
                            });
                        }
                    }
                }

                // === MORNING PREP ALERTS (Guardian) ===
                if (settings.guardianEnabled && firstSessionStart < Infinity) {
                    const minsToFirst = firstSessionStart - currentMinutesTotal;

                    // T-60: Calm reminder to prepare
                    if (settings.morningPrepAlert60m && Math.abs(minsToFirst - 60) <= 1) {
                        if (!(await hasPrepToday())) {
                            alerts.push({
                                title: '🛡️ Alpha: Přípravný čas',
                                body: `${firstSessionName} začíná za hodinu. Postav si herní plán v klidu.`,
                                type: 'guardian-t60'
                            });
                        }
                    }

                    // T-15: Urgent prep warning
                    if (settings.morningPrepAlert15m && Math.abs(minsToFirst - 15) <= 1) {
                        if (!(await hasPrepToday())) {
                            alerts.push({
                                title: '⚡ Alpha: Poslední výzva',
                                body: `${firstSessionName} za 15 minut a nemáš přípravu! Otevři deník.`,
                                type: 'guardian-t15'
                            });
                        }
                    }

                    // T-0: Critical — session starting, no prep
                    if (settings.morningPrepAlertCritical && Math.abs(minsToFirst) <= 1) {
                        if (!(await hasPrepToday())) {
                            alerts.push({
                                title: '🚫 Alpha Guard: BEZ PŘÍPRAVY',
                                body: 'Seance začala a nemáš herní plán. Dnes jen sleduj.',
                                type: 'guardian-critical'
                            });
                        }
                    }
                }

                // === EVENING AUDIT ALERT ===
                if (settings.eveningAuditAlertEnabled) {
                    const [auditH, auditM] = (settings.eveningAuditAlertTime || '20:00').split(':').map(Number);
                    const auditMinutes = auditH * 60 + auditM;
                    if (Math.abs(currentMinutesTotal - auditMinutes) <= 1) {
                        if (!(await hasReviewToday())) {
                            alerts.push({
                                title: '📊 Čas na denní review',
                                body: 'Uzavři dnešní den. Zapiš si co šlo dobře a co zlepšit.',
                                type: 'evening-audit'
                            });
                        }
                    }
                }

                // === MORNING DEBT ALERT ===
                // Fire once in morning (between 6:00-8:00) if previous trading day has no review
                if (settings.morningWakeUpDebtAlert && currentHour >= 6 && currentHour <= 7 && currentMinute === 0) {
                    if (await isDebtActive()) {
                        alerts.push({
                            title: '⚠️ Dluh z předchozího dne',
                            body: 'Nemáš hotový review za poslední obchodní den. Dokonči ho před dnešní seancí.',
                            type: 'morning-debt'
                        });
                    }
                }

                // === TEST MODE ===
                if (settings.testModeEnabled || prefs.testModeEnabled) {
                    alerts.push({
                        title: `AlphaTrade Debug (${pragueTime})`,
                        body: `Automatické hlášení aktivní.`,
                        type: 'debug'
                    });
                }
            }

            // Send all alerts for this user
            for (const alert of alerts) {
                const result = await sendPush(sub, alert.title, alert.body, alert.type);
                if (result === 'sent') sentCount++;
                if (result === 'expired') {
                    const cleanedPrefs = { ...prefs };
                    delete cleanedPrefs.pushSubscription;
                    await supabase
                        .from('profiles')
                        .update({ preferences: cleanedPrefs })
                        .eq('id', profile.id);
                    console.log(`[Cleanup] Removed expired push subscription for user ${profile.id}`);
                    break; // No point sending more if subscription is dead
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
