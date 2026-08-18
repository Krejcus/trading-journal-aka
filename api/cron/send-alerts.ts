import type { VercelRequest, VercelResponse } from '@vercel/node';
import webpush from 'web-push';
import { createClient } from '@supabase/supabase-js';
import {
    evaluateCopierIncidents,
    type CopierAlertStateRow,
    type CopierRuntimeRow,
} from '../../server/copierIncidentWatchdog';

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

    // BEZPEČNOST: dřív `?debug=true` ÚPLNĚ obešel kontrolu CRON_SECRET → kdokoli mohl přes
    // ?debug=true&type=... rozeslat push notifikace všem uživatelům a tahat profily. Teď i
    // debug vyžaduje secret (přes ?secret=, protože browser nepošle Bearer header).
    const bearerOk = req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
    const debugSecretOk = isManualDebug && !!process.env.CRON_SECRET && req.query.secret === process.env.CRON_SECRET;
    if (!bearerOk && !debugSecretOk) {
        console.log(`[Cron] AUTH FAILED. Has CRON_SECRET: ${!!process.env.CRON_SECRET}, Header: ${req.headers.authorization?.slice(0, 20)}...`);
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

        // --- BATCH: Fetch all data in parallel (1 query each instead of per-user) ---
        const [profilesResult, prepsResult, reviewsResult, subsResult] = await Promise.all([
            supabase.from('profiles').select('id, preferences'),
            supabase.from('daily_preps').select('user_id').eq('date', todayStr),
            supabase.from('daily_reviews').select('user_id').eq('date', todayStr),
            // Odběry žijí ve vlastní tabulce, jeden řádek = jedno zařízení.
            // Dřív to byl jediný objekt v preferences, takže druhé zařízení
            // přepsalo první a alerty chodily náhodně jen na jedno z nich.
            supabase
                .from('push_subscriptions')
                .select('id, user_id, endpoint, p256dh, auth')
                .is('expired_at', null),
        ]);

        if (profilesResult.error || !profilesResult.data) {
            return res.status(500).json({ error: profilesResult.error?.message });
        }
        if (subsResult.error) {
            return res.status(500).json({ error: subsResult.error.message });
        }

        const profiles = profilesResult.data;
        // Pre-built lookup sets: O(1) per user instead of O(1 DB query)
        const usersWithPrepToday = new Set((prepsResult.data || []).map(r => r.user_id));
        const usersWithReviewToday = new Set((reviewsResult.data || []).map(r => r.user_id));

        // user_id -> všechna jeho aktivní zařízení
        const devicesByUser = new Map<string, PushDevice[]>();
        for (const row of subsResult.data || []) {
            const list = devicesByUser.get(row.user_id) || [];
            list.push({
                id: row.id,
                subscription: {
                    endpoint: row.endpoint,
                    keys: { p256dh: row.p256dh, auth: row.auth },
                },
            });
            devicesByUser.set(row.user_id, list);
        }

        console.log(`[Cron] ${pragueTime} (${currentMinutesTotal}min) | ${todayStr} | ${profiles.length} profiles | Mock: ${mockType || 'none'}`);

        // Helper: get session emoji
        const getEmoji = (name: string) => {
            const n = name.toLowerCase();
            if (n.includes('asia')) return '🌏';
            if (n.includes('london') || n.includes('eu')) return '🏰';
            if (n.includes('ny') || n.includes('usa')) return '🗽';
            return '🔔';
        };

        // Collect all push jobs across all users, then send in parallel.
        // Jeden job = jeden alert pro JEDNO zařízení, proto se dole rozgeneruje
        // přes všechna zařízení uživatele.
        type PushJob = { device: PushDevice; title: string; body: string; type: string; profileId: string };
        const pushJobs: PushJob[] = [];

        for (const profile of profiles) {
            const prefs = profile.preferences || {};
            const devices = devicesByUser.get(profile.id) || [];
            const settings = prefs.systemSettings || {};
            const userSessions = prefs.sessions || [];

            if (devices.length === 0) continue;

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
                const hasPrep = usersWithPrepToday.has(profile.id);
                const hasReview = usersWithReviewToday.has(profile.id);

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

                        if (settings.sessionStartAlert15m && Math.abs(currentMinutesTotal - (startM - 15)) <= 1) {
                            alerts.push({ title: `${emoji} ${session.name} za 15 minut`, body: 'Připrav se na seanci. Zkontroluj svůj herní plán.', type: `session-t15-${session.id || session.name}` });
                        }
                        if (settings.sessionStartAlertExact && Math.abs(currentMinutesTotal - startM) <= 1) {
                            alerts.push({ title: `${emoji} ${session.name} začíná`, body: dailyTip, type: `session-start-${session.id || session.name}` });
                        }
                        if (settings.sessionEndAlert10m && Math.abs(currentMinutesTotal - (endM - 10)) <= 1) {
                            alerts.push({ title: `⏰ ${session.name} končí za 10 minut`, body: 'Uzavři otevřené pozice a dodržuj plán.', type: `session-end10-${session.id || session.name}` });
                        }
                        if (settings.sessionEndAlertExact && Math.abs(currentMinutesTotal - endM) <= 1) {
                            alerts.push({ title: `🏁 ${session.name} skončila`, body: 'Ruce pryč od klávesnice. Čas na review.', type: `session-end-${session.id || session.name}` });
                        }
                    }
                }

                // === MORNING PREP ALERTS (Guardian) ===
                if (settings.guardianEnabled && firstSessionStart < Infinity) {
                    const minsToFirst = firstSessionStart - currentMinutesTotal;

                    if (settings.morningPrepAlert60m && Math.abs(minsToFirst - 60) <= 1 && !hasPrep) {
                        alerts.push({ title: '🛡️ Alpha: Přípravný čas', body: `${firstSessionName} začíná za hodinu. Postav si herní plán v klidu.`, type: 'guardian-t60' });
                    }
                    if (settings.morningPrepAlert15m && Math.abs(minsToFirst - 15) <= 1 && !hasPrep) {
                        alerts.push({ title: '⚡ Alpha: Poslední výzva', body: `${firstSessionName} za 15 minut a nemáš přípravu! Otevři deník.`, type: 'guardian-t15' });
                    }
                    if (settings.morningPrepAlertCritical && Math.abs(minsToFirst) <= 1 && !hasPrep) {
                        alerts.push({ title: '🚫 Alpha Guard: BEZ PŘÍPRAVY', body: 'Seance začala a nemáš herní plán. Dnes jen sleduj.', type: 'guardian-critical' });
                    }
                }

                // === EVENING AUDIT ALERT ===
                if (settings.eveningAuditAlertEnabled) {
                    const [auditH, auditM] = (settings.eveningAuditAlertTime || '20:00').split(':').map(Number);
                    const auditMinutes = auditH * 60 + auditM;
                    if (Math.abs(currentMinutesTotal - auditMinutes) <= 1 && !hasReview) {
                        alerts.push({ title: '📊 Čas na denní review', body: 'Uzavři dnešní den. Zapiš si co šlo dobře a co zlepšit.', type: 'evening-audit' });
                    }
                }

                // === MORNING DEBT ALERT ===
                if (settings.morningWakeUpDebtAlert && currentHour >= 6 && currentHour <= 7 && currentMinute === 0) {
                    // Debt check requires per-user query (different last prep dates), but only fires once a day
                    const { data: lastPrep } = await supabase.from('daily_preps').select('date').eq('user_id', profile.id).lt('date', todayStr).order('date', { ascending: false }).limit(1);
                    if (lastPrep && lastPrep.length > 0) {
                        const { count } = await supabase.from('daily_reviews').select('id', { count: 'exact', head: true }).eq('user_id', profile.id).eq('date', lastPrep[0].date);
                        if ((count || 0) === 0) {
                            alerts.push({ title: '⚠️ Dluh z předchozího dne', body: 'Nemáš hotový review za poslední obchodní den. Dokonči ho před dnešní seancí.', type: 'morning-debt' });
                        }
                    }
                }

                // === SOCIAL / NETWORK NOTIFICATIONS ===
                const netNotifs = prefs.networkNotifications;
                if (netNotifs && typeof netNotifs === 'object') {
                    const watchedUserIds = Object.keys(netNotifs).filter(uid => {
                        const n = netNotifs[uid];
                        return n && (n.newTrade || n.newPrep || n.newReview);
                    });

                    if (watchedUserIds.length > 0) {
                        const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000).toISOString();

                        // Fetch recent activity from watched users (all tables need created_at column)
                        const [recentTrades, recentPreps, recentReviews] = await Promise.all([
                            // `id` je nutné: alert_type nese ID zdrojového řádku, takže
                            // se každý obchod ohlásí právě jednou. Dřív byl klíč jen
                            // user_id a 5min lookback ho poslal 5× po sobě.
                            watchedUserIds.some(uid => netNotifs[uid]?.newTrade)
                                ? supabase.from('trades').select('id, user_id, instrument, direction').in('user_id', watchedUserIds.filter(uid => netNotifs[uid]?.newTrade)).gte('created_at', fiveMinAgo).limit(10)
                                : Promise.resolve({ data: [] }),
                            watchedUserIds.some(uid => netNotifs[uid]?.newPrep)
                                ? supabase.from('daily_preps').select('id, user_id').in('user_id', watchedUserIds.filter(uid => netNotifs[uid]?.newPrep)).gte('created_at', fiveMinAgo).limit(10)
                                : Promise.resolve({ data: [] }),
                            watchedUserIds.some(uid => netNotifs[uid]?.newReview)
                                ? supabase.from('daily_reviews').select('id, user_id').in('user_id', watchedUserIds.filter(uid => netNotifs[uid]?.newReview)).gte('created_at', fiveMinAgo).limit(10)
                                : Promise.resolve({ data: [] }),
                        ]);

                        // Get names for watched users
                        const watchedProfiles = profiles.filter(p => watchedUserIds.includes(p.id));
                        const nameMap: Record<string, string> = {};
                        if (watchedProfiles.length < watchedUserIds.length) {
                            const { data: extraProfiles } = await supabase.from('profiles').select('id, full_name').in('id', watchedUserIds);
                            (extraProfiles || []).forEach(p => { nameMap[p.id] = p.full_name || 'Trader'; });
                        }
                        watchedProfiles.forEach(p => { nameMap[p.id] = (p as any).full_name || 'Trader'; });

                        // Deduplicate by user (only one alert per type per user per cron run)
                        const seenTrade = new Set<string>();
                        const seenPrep = new Set<string>();
                        const seenReview = new Set<string>();

                        (recentTrades.data || []).forEach((t: any) => {
                            if (seenTrade.has(t.user_id)) return;
                            seenTrade.add(t.user_id);
                            const name = nameMap[t.user_id] || 'Trader';
                            alerts.push({ title: `📈 ${name} přidal obchod`, body: `${t.direction || ''} ${t.instrument || ''}`.trim(), type: `social-trade-${t.id}` });
                        });

                        (recentPreps.data || []).forEach((p: any) => {
                            if (seenPrep.has(p.user_id)) return;
                            seenPrep.add(p.user_id);
                            const name = nameMap[p.user_id] || 'Trader';
                            alerts.push({ title: `📋 ${name} dokončil přípravu`, body: 'Nová denní příprava k dispozici.', type: `social-prep-${p.id}` });
                        });

                        (recentReviews.data || []).forEach((r: any) => {
                            if (seenReview.has(r.user_id)) return;
                            seenReview.add(r.user_id);
                            const name = nameMap[r.user_id] || 'Trader';
                            alerts.push({ title: `📊 ${name} dokončil review`, body: 'Nový denní review k nahlédnutí.', type: `social-review-${r.id}` });
                        });
                    }
                }

                // === TEST MODE ===
                if (settings.testModeEnabled || prefs.testModeEnabled) {
                    alerts.push({ title: `AlphaTrade Debug (${pragueTime})`, body: `Automatické hlášení aktivní.`, type: 'debug' });
                }
            }

            if (alerts.length > 0) {
                console.log(`[Cron] User ${profile.id.slice(0, 8)}: ${alerts.map(a => a.type).join(', ')}`);
            }

            for (const alert of alerts) {
                for (const device of devices) {
                    pushJobs.push({ device, title: alert.title, body: alert.body, type: alert.type, profileId: profile.id });
                }
            }
        }

        // --- PARALLEL PUSH SENDING (batches of 10) ---
        let sentCount = 0;
        let duplicateCount = 0;
        const expiredDevices = new Set<string>();

        for (let i = 0; i < pushJobs.length; i += 10) {
            const batch = pushJobs.slice(i, i + 10);
            const results = await Promise.allSettled(
                batch.map(async (job) => {
                    if (expiredDevices.has(job.device.id)) return 'skip';

                    // IDEMPOTENCE: okna alertů jsou ±1 min a cron běží každou
                    // minutu, takže bez tohohle claimu odejde stejný alert 3×.
                    // Vloží se PŘED odesláním; konflikt = někdo (dřívější běh)
                    // ho už poslal. V debug režimu se přeskakuje, ať jde testovat
                    // opakovaně.
                    let deliveryId: number | null = null;
                    if (!mockType) {
                        const claim = await supabase
                            .from('alert_deliveries')
                            .upsert(
                                {
                                    user_id: job.profileId,
                                    alert_type: job.type,
                                    alert_date: todayStr,
                                    subscription_id: job.device.id,
                                    status: 'sent',
                                    title: job.title,
                                    body: job.body,
                                },
                                { onConflict: 'user_id,alert_type,alert_date,subscription_id', ignoreDuplicates: true }
                            )
                            .select('id');

                        if (claim.error) {
                            console.error('[Cron] Claim selhal:', claim.error.message);
                            return 'failed';
                        }
                        if (!claim.data || claim.data.length === 0) return 'duplicate';
                        deliveryId = claim.data[0].id;
                    }

                    const result = await sendPush(job.device.subscription, job.title, job.body, job.type);

                    if (result.status !== 'sent') {
                        if (deliveryId !== null) {
                            await supabase
                                .from('alert_deliveries')
                                .update({ status: result.status, status_code: result.statusCode ?? null, error: result.error ?? null })
                                .eq('id', deliveryId);
                        }
                        if (result.status === 'expired') {
                            // Cílený zápis na JEDNO zařízení. Dřív se tu přepisoval
                            // celý preferences blob snapshotem z počátku běhu, což
                            // uživateli mohlo vrátit stará nastavení.
                            expiredDevices.add(job.device.id);
                            await supabase
                                .from('push_subscriptions')
                                .update({ expired_at: new Date().toISOString(), last_error: result.error ?? null })
                                .eq('id', job.device.id);
                            console.log(`[Cleanup] Expired device ${job.device.id.slice(0, 8)} (user ${job.profileId.slice(0, 8)})`);
                        }
                    }

                    return result.status;
                })
            );
            for (const r of results) {
                if (r.status !== 'fulfilled') continue;
                if (r.value === 'sent') sentCount++;
                else if (r.value === 'duplicate') duplicateCount++;
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

        // --- COPIER REMOTE WATCHDOG ---------------------------------------
        // Lokální watchdog hlásí na obrazovku Macu, tedy stroje, který právě
        // umřel. Tady se heartbeat workera převádí na push do telefonu.
        // Vyhodnocení je čistá funkce (server/copierIncidentWatchdog.ts),
        // dedupe drží copier_alert_state — incident se hlásí jednou při
        // vzniku a jednou při zotavení, ne každou minutu.
        let copierAlertsSent = 0;
        try {
            const [runtimesResult, alertStatesResult] = await Promise.all([
                supabase
                    .from('tradovate_copier_device_runtime')
                    .select('device_id, user_id, status, last_seen_at, started_at'),
                supabase
                    .from('copier_alert_state')
                    .select('device_id, user_id, incident_key, active, detail'),
            ]);
            if (runtimesResult.error) throw new Error(runtimesResult.error.message);
            if (alertStatesResult.error) throw new Error(alertStatesResult.error.message);

            const evaluation = evaluateCopierIncidents({
                runtimes: (runtimesResult.data ?? []) as CopierRuntimeRow[],
                alertStates: (alertStatesResult.data ?? []) as CopierAlertStateRow[],
                now: now.getTime(),
            });

            for (const notification of evaluation.notifications) {
                const devices = devicesByUser.get(notification.userId) ?? [];
                for (const device of devices) {
                    const result = await sendPush(
                        device.subscription,
                        notification.title,
                        notification.body,
                        `copier-${notification.incidentKey}`,
                    );
                    if (result.status === 'sent') copierAlertsSent++;
                    if (result.status === 'expired') {
                        await supabase
                            .from('push_subscriptions')
                            .update({ expired_at: new Date().toISOString(), last_error: result.error ?? null })
                            .eq('id', device.id);
                    }
                }
            }

            for (const upsert of evaluation.upserts) {
                const nowIso = new Date().toISOString();
                await supabase.from('copier_alert_state').upsert({
                    user_id: upsert.userId,
                    device_id: upsert.deviceId,
                    incident_key: upsert.incidentKey,
                    active: upsert.active,
                    detail: upsert.detail,
                    updated_at: nowIso,
                    ...(upsert.active ? { detected_at: nowIso, resolved_at: null } : { resolved_at: nowIso }),
                    ...(upsert.notified ? { notified_at: nowIso } : {}),
                }, { onConflict: 'user_id,device_id,incident_key' });
            }
        } catch (copierWatchdogError) {
            // Watchdog nesmí shodit zbytek alertů — selhání jen zalogovat.
            console.error('[Cron] Copier watchdog failed:', copierWatchdogError);
        }

        console.log(`[Cron] Done: ${sentCount} sent, ${duplicateCount} deduped, ${pushJobs.length} total jobs, ${profiles.length} profiles, ${subsResult.data?.length || 0} devices, ${copierAlertsSent} copier alerts`);
        return res.status(200).json({
            success: true,
            sent: sentCount,
            deduped: duplicateCount,
            jobs: pushJobs.length,
            devices: subsResult.data?.length || 0,
            time: pragueTime,
            profiles: profiles.length,
            copierAlerts: copierAlertsSent,
        });

    } catch (err: any) {
        return res.status(500).json({ error: err.message });
    }
}

type PushDevice = {
    id: string;
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
};

type PushResult = {
    status: 'sent' | 'expired' | 'failed';
    statusCode?: number;
    error?: string;
};

async function sendPush(sub: any, title: string, body: string, alertType: string): Promise<PushResult> {
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
        return { status: 'sent' };
    } catch (e: any) {
        const statusCode = e?.statusCode || e?.status;
        const message = String(e?.body || e?.message || e).slice(0, 500);
        if (statusCode === 410 || statusCode === 404) {
            return { status: 'expired', statusCode, error: message };
        }
        console.error(`Push error (${statusCode}):`, message);
        return { status: 'failed', statusCode, error: message };
    }
}
