import React, { useState, useEffect, useMemo } from 'react';
import { Input, Select, Button, TextArea, MultiSelect } from './UI';
import { AccountList } from './AccountList';
import { scrapeTradingView } from '../../lib/scraper';
import { supabase, SUPABASE_URL, SUPABASE_KEY } from '../../lib/supabase';
import { cropImage } from '../../lib/screenshot';
import { RefreshCw, CheckCircle2, XCircle, Eye, Send, RotateCcw, Clock } from 'lucide-react';
import { useTheme } from './ThemeContext';

// Chrome API global (extension context)
declare const chrome: any;

// ── Instrument mapping ─────────────────────────────────────────────────────────
// Futures symbols from TradingView → micro-contract names used in the journal
const INSTRUMENT_MAP: Record<string, string> = {
    NQ: 'MNQ',
    ES: 'MES',
    CL: 'MCL',
    GC: 'MGC',
    RTY: 'M2K',
    YM: 'MYM',
    SI: 'SIL',
    ZB: 'ZB',
    ZN: 'ZN',
};

function mapInstrument(symbol: string): string {
    // Strip trailing digits, exclamation marks and suffix
    const clean = symbol.replace(/[0-9!:_-].*$/, '').toUpperCase();
    return INSTRUMENT_MAP[clean] ?? clean;
}

// ── Session config type (mirrors main app's SessionConfig) ────────────────────
interface SessionConfig {
    id: string;
    name: string;
    startTime: string; // "HH:mm" local time
    endTime: string;   // "HH:mm" local time
    color: string;
}

// Simple fallback when no sessions from preferences
function detectSession(): string {
    const h = new Date().getUTCHours();
    if (h >= 12 && h < 22) return 'NY';
    if (h >= 7  && h < 12) return 'London';
    if (h >= 0  && h < 7)  return 'Asia';
    return 'Overnight';
}

// Convert "HH:mm" string to minutes since midnight
function timeToMinutes(t: string): number {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
}

// Find which session from user's preferences matches the current local time
function detectBestSession(sessions: SessionConfig[]): string {
    if (sessions.length === 0) return detectSession();

    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    const matches: { name: string; rangeSize: number }[] = [];

    for (const s of sessions) {
        const start = timeToMinutes(s.startTime);
        const end   = timeToMinutes(s.endTime);

        const inRange = end >= start
            ? currentMinutes >= start && currentMinutes < end          // normal range
            : currentMinutes >= start || currentMinutes < end;         // crosses midnight

        if (inRange) {
            const size = end >= start ? end - start : (1440 - start) + end;
            matches.push({ name: s.name, rangeSize: size });
        }
    }

    if (matches.length > 0) {
        // Most specific session = shortest duration
        matches.sort((a, b) => a.rangeSize - b.rangeSize);
        return matches[0].name;
    }

    // No match → return first session
    return sessions[0].name;
}

// ── Initial trade state factory ───────────────────────────────────────────────
function makeInitialTrade() {
    return {
        symbol: 'NQ1!',
        direction: 'LONG',
        risk: '500',
        entry: '',
        sl: '',
        tp: '',
        outcome: 'WIN' as 'WIN' | 'LOSS' | 'BE',
        entryDate: new Date().toISOString().split('T')[0],
        entryTime: new Date().toTimeString().split(' ')[0].slice(0, 5),
        exitDate: new Date().toISOString().split('T')[0],
        exitTime: new Date().toTimeString().split(' ')[0].slice(0, 5),
        pnl: '',
        notes: '',
        session: detectSession(),
        signal: '',
        htfConfluence: [] as string[],
        ltfConfluence:  [] as string[],
        emotions:       [] as string[],
        mistakes:       [] as string[],
    };
}

export function TradeForm({ isWide = false }: { isWide?: boolean }) {
    const { theme } = useTheme();
    const [trade, setTrade] = useState(makeInitialTrade);

    const [options, setOptions] = useState({
        htf:      [] as string[],
        ltf:      [] as string[],
        emotions: [] as string[],
        mistakes: [] as string[],
        signals:  [] as string[],
        sessions: [] as SessionConfig[],
    });

    const [selectedAccounts, setSelectedAccounts] = useState<string[]>([]);
    const [pnlManual, setPnlManual] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [submitStatus, setSubmitStatus] = useState<{ text: string, type: 'info' | 'success' | 'error' } | null>(null);
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const [isPreviewing, setIsPreviewing] = useState(false);
    const [lightboxOpen, setLightboxOpen] = useState(false);
    const [showReset, setShowReset] = useState(false);

    // ── Fullscreen lightbox ──────────────────────────────────────────────────
    useEffect(() => {
        if (!lightboxOpen || !previewUrl) return;

        const overlay = document.createElement('div');
        overlay.id = 'alpha-bridge-lightbox';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,0.96);display:flex;align-items:center;justify-content:center;cursor:zoom-out;';

        const img = document.createElement('img');
        img.src = previewUrl;
        img.style.cssText = 'max-width:100vw;max-height:100vh;width:100%;height:100%;object-fit:contain;display:block;';
        img.onclick = (e) => e.stopPropagation();

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '✕';
        closeBtn.style.cssText = 'position:fixed;top:16px;right:16px;background:rgba(0,0,0,0.7);border:1px solid rgba(255,255,255,0.3);border-radius:50%;width:40px;height:40px;cursor:pointer;color:white;font-size:22px;display:flex;align-items:center;justify-content:center;z-index:2147483648;';

        const close = () => { setLightboxOpen(false); };
        overlay.onclick = close;
        closeBtn.onclick = close;

        overlay.appendChild(img);
        overlay.appendChild(closeBtn);
        document.body.appendChild(overlay);

        return () => { document.body.removeChild(overlay); };
    }, [lightboxOpen, previewUrl]);

    // ── Field helpers ────────────────────────────────────────────────────────
    const updateField = (field: string) => (val: string) => {
        setTrade(prev => ({ ...prev, [field]: val }));
        if (field === 'pnl') setPnlManual(!!val);
    };

    const toggleMultiSelect = (field: 'htfConfluence' | 'ltfConfluence' | 'emotions' | 'mistakes') => (val: string) => {
        setTrade(prev => ({
            ...prev,
            [field]: prev[field].includes(val)
                ? prev[field].filter(i => i !== val)
                : [...prev[field], val],
        }));
    };

    // ── Form reset (keeps symbol / accounts / date) ─────────────────────────
    const handleReset = () => {
        setTrade(prev => ({
            ...makeInitialTrade(),
            // Persist symbol, direction and accounts context
            symbol: prev.symbol,
            direction: prev.direction,
            risk: prev.risk,
        }));
        setPreviewUrl(null);
        setPnlManual(false);
        setShowReset(false);
        setSubmitStatus(null);
    };

    // ── Fetch preferences ────────────────────────────────────────────────────
    useEffect(() => {
        const fetchPrefs = async () => {
            try {
                const { data: { session } } = await supabase.auth.getSession();
                if (!session) return;

                const { data } = await supabase
                    .from('profiles')
                    .select('preferences')
                    .eq('id', session.user.id)
                    .single();

                if (data?.preferences) {
                    const p = data.preferences;
                    const signals: string[] = (
                        p.signalOptions ?? p.signals ?? p.setups ?? p.setupOptions ?? []
                    );
                    const sessions: SessionConfig[] = Array.isArray(p.sessions) ? p.sessions : [];
                    setOptions({
                        htf:      p.htfOptions || [],
                        ltf:      p.ltfOptions || [],
                        emotions: (p.emotions || []).map((e: any) => e.label ?? e),
                        mistakes: p.standardMistakes || [],
                        signals,
                        sessions,
                    });
                    // Auto-select signal (first option)
                    if (signals.length > 0) {
                        setTrade(prev => ({ ...prev, signal: prev.signal || signals[0] }));
                    }
                    // Auto-detect session from user's configured sessions
                    if (sessions.length > 0) {
                        setTrade(prev => ({ ...prev, session: detectBestSession(sessions) }));
                    }
                }
            } catch (err) {
                console.error('[AlphaBridge] Failed to fetch user preferences:', err);
            }
        };
        fetchPrefs();
    }, []);

    // ── TradingView scraper ──────────────────────────────────────────────────
    useEffect(() => {
        const runScraper = () => {
            const result = scrapeTradingView();
            if (result.success && result.data) {
                setTrade(prev => {
                    const next = { ...prev };
                    if (result.symbol && result.symbol !== prev.symbol) next.symbol = result.symbol;
                    if (result.data.direction && result.data.direction !== prev.direction) next.direction = result.data.direction;
                    if (result.data.risk  && String(result.data.risk)  !== prev.risk)  next.risk  = String(result.data.risk);
                    if (result.data.entry && String(result.data.entry) !== prev.entry) next.entry = String(result.data.entry);
                    if (result.data.sl    && String(result.data.sl)    !== prev.sl)    next.sl    = String(result.data.sl);
                    if (result.data.tp    && String(result.data.tp)    !== prev.tp)    next.tp    = String(result.data.tp);
                    return next;
                });
            }
        };

        const interval = setInterval(runScraper, 2000);
        return () => clearInterval(interval);
    }, []);

    // ── R:R / estimated P&L ──────────────────────────────────────────────────
    const calculations = useMemo(() => {
        const entry       = parseFloat(trade.entry) || 0;
        const sl          = parseFloat(trade.sl)    || 0;
        const tp          = parseFloat(trade.tp)    || 0;
        const riskDollars = parseFloat(trade.risk)  || 0;

        let rrText   = "- : -";
        let estPnLVal = "";

        if (entry && sl) {
            const slDist = Math.abs(entry - sl);
            const tpDist = tp ? Math.abs(tp - entry) : 0;
            if (slDist > 0) {
                const rRatio = tpDist / slDist;
                if (tpDist > 0) rrText = `1 : ${rRatio.toFixed(2)}`;

                if (riskDollars) {
                    let calcPnl = 0;
                    if (trade.outcome === 'WIN')  calcPnl =  riskDollars * rRatio;
                    else if (trade.outcome === 'LOSS') calcPnl = -riskDollars;
                    else calcPnl = 0;
                    estPnLVal = Math.round(calcPnl).toString();
                }
            }
        }
        return { rrText, estPnLVal };
    }, [trade.entry, trade.sl, trade.tp, trade.risk, trade.outcome]);

    useEffect(() => {
        if (!pnlManual && calculations.estPnLVal) {
            setTrade(prev => ({ ...prev, pnl: calculations.estPnLVal }));
        }
    }, [calculations.estPnLVal, pnlManual]);

    // ── Preview screenshot ───────────────────────────────────────────────────
    const handlePreview = async () => {
        setIsPreviewing(true);
        setSubmitStatus({ text: "Generuji náhled...", type: 'info' });

        try {
            const host = document.getElementById('alpha-bridge-v2-host');
            if (host) host.style.display = 'none';

            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27 }));
            await new Promise(resolve => setTimeout(resolve, 800));

            chrome.runtime.sendMessage({ action: "captureVisibleTab" }, async (response: any) => {
                if (host) host.style.display = 'block';

                if (!response?.success) {
                    setIsPreviewing(false);
                    setSubmitStatus({ text: "Chyba při focení: " + (response?.error ?? "unknown"), type: 'error' });
                    return;
                }

                const chartArea = resolveChartArea();
                const rect = chartArea
                    ? chartArea.getBoundingClientRect()
                    : new DOMRect(0, 0, window.innerWidth, window.innerHeight);

                const croppedUrl = await cropImage(response.dataUrl, rect);
                setPreviewUrl(croppedUrl);
                setSubmitStatus(null);
                setIsPreviewing(false);
            });
        } catch (err: any) {
            setIsPreviewing(false);
            setSubmitStatus({ text: err.message, type: 'error' });
        }
    };

    // ── Submit ───────────────────────────────────────────────────────────────
    const handleSubmit = async () => {
        // Validation
        if (selectedAccounts.length === 0) {
            setSubmitStatus({ text: "Vyberte alespoň jeden účet!", type: 'error' }); return;
        }
        if (!trade.entry) {
            setSubmitStatus({ text: "Vyplňte Entry cenu!", type: 'error' }); return;
        }
        if (!trade.sl) {
            setSubmitStatus({ text: "Vyplňte Stop Loss!", type: 'error' }); return;
        }
        if (!trade.pnl && !trade.tp) {
            setSubmitStatus({ text: "Vyplňte Take Profit nebo Zisk ($)!", type: 'error' }); return;
        }

        const isWeekend = (dateStr: string | undefined) => {
            if (!dateStr) return false;
            const parts = dateStr.split('-');
            if (parts.length === 3) {
                const d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
                return !isNaN(d.getTime()) && (d.getDay() === 0 || d.getDay() === 6);
            }
            const d = new Date(dateStr);
            return !isNaN(d.getTime()) && (d.getDay() === 0 || d.getDay() === 6);
        };

        if (isWeekend(trade.entryDate) || isWeekend(trade.exitDate)) {
            setSubmitStatus({ text: "Obchod nelze zadat o víkendu!", type: 'error' }); return;
        }

        setIsSubmitting(true);
        setSubmitStatus({ text: "🔑 Načítám session...", type: 'info' });

        let host: HTMLElement | null = null;

        try {
            const { data: { session }, error: sessionErr } = await supabase.auth.getSession();
            if (sessionErr) throw new Error("Session chyba: " + sessionErr.message);
            if (!session) throw new Error("Nejste přihlášeni — otevřete popup extensiony a přihlaste se.");

            // 1. Hide UI + close TV dialogs
            setSubmitStatus({ text: "📸 Schovávám UI, fotím graf...", type: 'info' });
            host = document.getElementById('alpha-bridge-v2-host');
            if (host) host.style.display = 'none';

            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27 }));

            const tryCloseDialog = (doc: Document) => {
                const closeBtn = doc.querySelector('[data-name="close"], button[class*="close"], svg[class*="close"]');
                if (closeBtn) {
                    (closeBtn.tagName === 'svg' && closeBtn.parentElement
                        ? closeBtn.parentElement
                        : closeBtn as HTMLElement
                    ).click();
                } else {
                    const cancelBtn = Array.from(doc.querySelectorAll('span, button'))
                        .find(b => ['cancel', 'zrušit'].includes(b.textContent?.trim().toLowerCase() ?? ''));
                    if (cancelBtn) (cancelBtn as HTMLElement).click();
                }
            };

            try {
                tryCloseDialog(document);
                document.querySelectorAll('iframe').forEach(iframe => {
                    try { if (iframe.contentDocument) tryCloseDialog(iframe.contentDocument); } catch { /* CORS */ }
                });
            } catch { /* ignore */ }

            await new Promise(resolve => setTimeout(resolve, 800));

            // 2. Screenshot (with 15s timeout to prevent hang if background worker is unresponsive)
            setSubmitStatus({ text: "📸 Čekám na screenshot...", type: 'info' });
            const response: any = await new Promise((resolve, reject) => {
                const timeoutId = setTimeout(() => {
                    reject(new Error("Screenshot timeout — Chrome možná rate-limituje (počkej 5-10s a zkus znovu)."));
                }, 15000);
                chrome.runtime.sendMessage({ action: "captureVisibleTab" }, (res: any) => {
                    clearTimeout(timeoutId);
                    if (chrome.runtime.lastError) {
                        reject(new Error("Screenshot: " + chrome.runtime.lastError.message));
                    } else {
                        resolve(res);
                    }
                });
            });

            if (host) host.style.display = 'block';
            if (!response?.success) throw new Error("Chyba při focení: " + (response?.error ?? "Žádná odpověď od background workeru"));

            // 3. Crop
            setSubmitStatus({ text: "✂️ Ořezávám graf...", type: 'info' });
            const chartArea = resolveChartArea();
            const rect = chartArea
                ? chartArea.getBoundingClientRect()
                : new DOMRect(0, 0, window.innerWidth, window.innerHeight);

            const croppedImageUrl = await cropImage(response.dataUrl, rect);

            // 4. Compute values
            const entry = parseFloat(trade.entry) || null;
            const sl    = parseFloat(trade.sl)    || null;
            const tp    = parseFloat(trade.tp)    || null;
            const risk  = parseFloat(trade.risk)  || 0;
            let pnl = 0;

            if (trade.pnl) {
                pnl = parseFloat(trade.pnl) || 0;
            } else if (entry && sl) {
                const slDist = Math.abs(entry - sl);
                const tpDist = tp ? Math.abs(tp - entry) : 0;
                if (slDist > 0 && tpDist > 0) {
                    const rRatio = tpDist / slDist;
                    if (trade.outcome === 'WIN')       pnl =  risk * rRatio;
                    else if (trade.outcome === 'LOSS') pnl = -risk;
                }
            }

            const baseDateStr = trade.entryDate || new Date().toISOString().split('T')[0];
            const baseTimeStr = trade.entryTime || new Date().toTimeString().split(' ')[0].slice(0, 5);
            let finalDateIso  = new Date().toISOString();
            let finalTimestamp = Date.now();
            let durationString = "0 m";

            try {
                const parsedEntry = new Date(`${baseDateStr}T${baseTimeStr}:00`);
                const parsedExit  = new Date(`${trade.exitDate || baseDateStr}T${trade.exitTime || baseTimeStr}:00`);
                if (!isNaN(parsedEntry.getTime())) {
                    finalDateIso   = parsedEntry.toISOString();
                    finalTimestamp = parsedEntry.getTime();
                }
                if (!isNaN(parsedEntry.getTime()) && !isNaN(parsedExit.getTime())) {
                    const diffMs = parsedExit.getTime() - parsedEntry.getTime();
                    if (diffMs > 0) {
                        const h = Math.floor(diffMs / 3600000);
                        const m = Math.floor((diffMs % 3600000) / 60000);
                        durationString = h > 0 ? `${h}h ${m}m` : `${m} m`;
                    }
                }
            } catch { /* fallback */ }

            const finalInstrument = mapInstrument(trade.symbol || "Unknown");
            const finalSignal     = trade.signal || "Alpha Bridge v2";

            // 5. Upload screenshot (PNG)
            let publicUrl: string | null = null;
            if (croppedImageUrl) {
                setSubmitStatus({ text: "☁️ Nahrávám screenshot...", type: 'info' });
                const base64Data = croppedImageUrl.replace(/^data:image\/\w+;base64,/, "");
                const binary = atob(base64Data);
                const buffer = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) buffer[i] = binary.charCodeAt(i);
                const fileName = `ext_${Date.now()}_${Math.floor(Math.random() * 1000)}.png`;

                const { error: upErr } = await supabase.storage
                    .from('trade-images')
                    .upload(fileName, buffer, { contentType: 'image/png' });

                if (upErr) throw new Error("Nepodařilo se nahrát screenshot: " + upErr.message);

                const { data: urlData } = supabase.storage.from('trade-images').getPublicUrl(fileName);
                publicUrl = urlData?.publicUrl ?? null;
            }

            // 6. Build rows (masterTradeId pre-generated)
            const masterAccountId = selectedAccounts[0];
            const masterTradeId   = crypto.randomUUID();
            const commonGroupId   = crypto.randomUUID();

            setSubmitStatus({ text: "📋 Načítám účty...", type: 'info' });
            const { data: accountsData } = await supabase
                .from('accounts')
                .select('id, type, meta')
                .in('id', selectedAccounts);

            const accountPhaseMap = new Map<string, string>();
            accountsData?.forEach(acc => accountPhaseMap.set(acc.id, acc.meta?.phase || 'Challenge'));

            const rows = selectedAccounts.map(accId => {
                const isMaster = accId === masterAccountId;
                const tradeId  = isMaster ? masterTradeId : crypto.randomUUID();
                const phase    = accountPhaseMap.get(accId) || 'Challenge';

                const tradeData = {
                    id: tradeId,
                    accountId: accId,
                    instrument: finalInstrument,
                    entryPrice: entry,
                    exitPrice: trade.outcome === 'WIN' ? tp : trade.outcome === 'LOSS' ? sl : entry,
                    stopLoss: sl,
                    takeProfit: tp,
                    riskAmount: risk,
                    screenshot: publicUrl,
                    screenshots: publicUrl ? [publicUrl] : [],
                    duration: durationString,
                    exitDate: null,
                    status: 'CLOSED',
                    outcome: trade.outcome,
                    groupId: commonGroupId,
                    isMaster,
                    masterTradeId: isMaster ? null : masterTradeId,
                    session: trade.session,
                    phase,
                    executionStatus: "Valid",
                    signal: finalSignal,
                    htfConfluence: trade.htfConfluence,
                    ltfConfluence: trade.ltfConfluence,
                    htf: trade.htfConfluence,
                    ltf: trade.ltfConfluence,
                    emotions: trade.emotions,
                    mistakes: trade.mistakes,
                    notes: trade.notes,
                };

                return {
                    id: tradeId,
                    user_id: session.user.id,
                    account_id: accId,
                    instrument: finalInstrument,
                    direction: trade.direction,
                    pnl,
                    date: finalDateIso,
                    timestamp: finalTimestamp,
                    signal: finalSignal,
                    is_public: false,
                    data: tradeData,
                };
            });

            // 7. Save to DB
            setSubmitStatus({ text: "💾 Ukládám do databáze...", type: 'info' });
            const res = await fetch(`${SUPABASE_URL}/rest/v1/trades`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': SUPABASE_KEY,
                    'Authorization': `Bearer ${session.access_token}`,
                    'Prefer': 'return=representation',
                },
                body: JSON.stringify(rows),
            });

            // Session expiry detection
            if (res.status === 401) {
                await supabase.auth.signOut();
                throw new Error("Session expirovala — otevřete popup extensiony a přihlaste se znovu.");
            }

            if (!res.ok) {
                const errBody = await res.text();
                throw new Error(`Chyba databáze (${res.status}): ${errBody}`);
            }

            const savedTrades = await res.json();
            if (!savedTrades || savedTrades.length === 0) {
                throw new Error("Databáze odmítla uložení (RLS) — zkuste se odhlásit a přihlásit znovu.");
            }

            setSubmitStatus({
                text: `✅ Zapsáno! (${savedTrades.length} ${savedTrades.length === 1 ? 'účet' : 'účty'})`,
                type: 'success',
            });
            setShowReset(true);

        } catch (err: any) {
            console.error('[AlphaBridge]', err);
            setSubmitStatus({ text: err.message, type: 'error' });
        } finally {
            setIsSubmitting(false);
            if (host) host.style.display = 'block';
        }
    };

    // ── Signal Select options ────────────────────────────────────────────────
    const signalSelectOptions = options.signals.length > 0
        ? [{ value: '', label: '— Vyberte signál —' }, ...options.signals.map(s => ({ value: s, label: s }))]
        : [{ value: '', label: 'Alpha Bridge v2' }];

    return (
        <div className="w-full">
            <div className={isWide ? "flex gap-6 items-start" : ""}>
                {isWide && (
                    <div className="w-[280px] shrink-0 overflow-y-auto pr-3 custom-scrollbar border-r border-slate-700/20 max-h-[70vh]">
                        <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-blue-500 mb-4 flex items-center gap-2">
                            Tactical Engine
                        </h3>
                        <MultiSelect
                            label="HTF Kontext"
                            selected={trade.htfConfluence}
                            options={options.htf}
                            onToggle={toggleMultiSelect('htfConfluence')}
                            colorScheme="htf"
                        />
                        <MultiSelect
                            label="LTF Trigger"
                            selected={trade.ltfConfluence}
                            options={options.ltf}
                            onToggle={toggleMultiSelect('ltfConfluence')}
                            colorScheme="ltf"
                        />
                        <MultiSelect
                            label="Emoce"
                            selected={trade.emotions}
                            options={options.emotions}
                            onToggle={toggleMultiSelect('emotions')}
                            colorScheme="emotions"
                        />
                        <MultiSelect
                            label="Chyby"
                            selected={trade.mistakes}
                            options={options.mistakes}
                            onToggle={toggleMultiSelect('mistakes')}
                            colorScheme="mistakes"
                        />
                    </div>
                )}

                <div className="flex-1">
                    <div className="flex flex-col">
                        <AccountList onSelectionChange={setSelectedAccounts} />

                        {/* Symbol / Direction / R:R */}
                        <div className="flex gap-3 mb-4">
                            <div className="flex-1">
                                <label className={`block text-xs uppercase font-bold tracking-wider mb-1.5 ${theme === 'dark' ? 'text-slate-400' : 'text-slate-500'}`}>Symbol</label>
                                <input type="text" readOnly value={trade.symbol} className={`w-full border rounded-xl px-3 py-2 text-sm font-bold outline-none ${theme === 'dark' ? 'bg-slate-800/80 border-slate-700/50 text-yellow-400' : 'bg-white/80 border-slate-300/50 text-amber-600'}`} />
                            </div>
                            <div className="flex-1">
                                <label className={`block text-xs uppercase font-bold tracking-wider mb-1.5 ${theme === 'dark' ? 'text-slate-400' : 'text-slate-500'}`}>Směr</label>
                                <input type="text" readOnly value={trade.direction} className={`w-full border rounded-xl px-3 py-2 text-sm text-center font-bold outline-none ${theme === 'dark' ? 'bg-slate-800/80 border-slate-700/50' : 'bg-white/80 border-slate-300/50'} ${trade.direction === 'LONG' ? (theme === 'dark' ? 'text-emerald-400' : 'text-emerald-600') : (theme === 'dark' ? 'text-rose-400' : 'text-rose-600')}`} />
                            </div>
                            <div className="flex-[0.8]">
                                <label className={`block text-xs uppercase font-bold tracking-wider mb-1.5 ${theme === 'dark' ? 'text-slate-400' : 'text-slate-500'}`}>R:R</label>
                                <div className={`border rounded-xl h-[38px] flex items-center justify-center font-bold text-xs px-2 gap-1 min-w-[70px] ${theme === 'dark' ? 'bg-gradient-to-r from-blue-900/40 to-transparent border-blue-800/50 text-blue-400' : 'bg-gradient-to-r from-blue-100/50 to-transparent border-blue-200 text-blue-700'}`}>
                                    <span className="text-sm font-outfit">{calculations.rrText}</span>
                                </div>
                            </div>
                        </div>

                        <div className="flex gap-2 mb-2">
                            <div className="flex-1"><Input label="Entry" value={trade.entry} onChange={updateField('entry')} type="number" className="mb-0" /></div>
                            <div className="flex-1"><Input label="Stop Loss" value={trade.sl} onChange={updateField('sl')} type="number" className="mb-0" /></div>
                            <div className="flex-1"><Input label="Take Profit" value={trade.tp} onChange={updateField('tp')} type="number" className="mb-0" /></div>
                        </div>

                        <div className="flex gap-2 mb-2">
                            <div className="flex-1"><Input label="Risk ($)" value={trade.risk} onChange={updateField('risk')} type="number" className="mb-0" /></div>
                            <div className="flex-1">
                                <Input
                                    label="Zisk ($)"
                                    value={trade.pnl}
                                    onChange={updateField('pnl')}
                                    placeholder={calculations.estPnLVal || ""}
                                    type="number"
                                    className="mb-0"
                                />
                            </div>
                            <div className="flex-1">
                                <Select
                                    label="Stav"
                                    value={trade.outcome}
                                    onChange={updateField('outcome')}
                                    className="mb-0"
                                    options={[
                                        { value: 'WIN',  label: 'WIN 🟢' },
                                        { value: 'LOSS', label: 'LOSS 🔴' },
                                        { value: 'BE',   label: 'BE 🟡' },
                                    ]}
                                />
                            </div>
                        </div>

                        {/* Date + Entry time + Exit time — each with a "Teď" button */}
                        <div className="flex gap-2 mb-2">
                            <div className="flex-[0.9] min-w-0">
                                <Input
                                    label="Datum"
                                    value={trade.entryDate}
                                    onChange={(val) => { updateField('entryDate')(val); updateField('exitDate')(val); }}
                                    type="date"
                                    className="mb-0"
                                    inputClassName="px-2"
                                />
                            </div>
                            {/* Entry time + Teď */}
                            <div className="flex-1 min-w-0 flex flex-col">
                                <label className={`block text-xs font-bold uppercase tracking-wider mb-1.5 ${theme === 'dark' ? 'text-slate-400' : 'text-slate-500'}`}>Entry</label>
                                <div className="flex gap-1">
                                    <input
                                        type="time"
                                        value={trade.entryTime}
                                        onChange={(e) => updateField('entryTime')(e.target.value)}
                                        onKeyDown={(e) => e.stopPropagation()}
                                        className={`flex-1 min-w-0 border rounded-xl px-2 py-2 text-sm outline-none transition-all duration-200 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 ${theme === 'dark' ? 'bg-slate-800/80 border-slate-700/50 text-slate-100' : 'bg-white/80 border-slate-300/50 text-slate-800'}`}
                                    />
                                    <button
                                        type="button"
                                        onClick={() => updateField('entryTime')(new Date().toTimeString().slice(0, 5))}
                                        title="Nastavit aktuální čas"
                                        className={`px-2 rounded-xl border text-[10px] font-bold transition-all flex items-center gap-0.5 shrink-0 ${theme === 'dark' ? 'bg-slate-800/80 border-slate-700/50 text-slate-400 hover:text-blue-400 hover:border-blue-500/50' : 'bg-white/80 border-slate-300/50 text-slate-500 hover:text-blue-600 hover:border-blue-300'}`}
                                    >
                                        <Clock size={10} />
                                    </button>
                                </div>
                            </div>
                            {/* Exit time + Teď */}
                            <div className="flex-1 min-w-0 flex flex-col">
                                <label className={`block text-xs font-bold uppercase tracking-wider mb-1.5 ${theme === 'dark' ? 'text-slate-400' : 'text-slate-500'}`}>Exit</label>
                                <div className="flex gap-1">
                                    <input
                                        type="time"
                                        value={trade.exitTime}
                                        onChange={(e) => updateField('exitTime')(e.target.value)}
                                        onKeyDown={(e) => e.stopPropagation()}
                                        className={`flex-1 min-w-0 border rounded-xl px-2 py-2 text-sm outline-none transition-all duration-200 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 ${theme === 'dark' ? 'bg-slate-800/80 border-slate-700/50 text-slate-100' : 'bg-white/80 border-slate-300/50 text-slate-800'}`}
                                    />
                                    <button
                                        type="button"
                                        onClick={() => updateField('exitTime')(new Date().toTimeString().slice(0, 5))}
                                        title="Nastavit aktuální čas"
                                        className={`px-2 rounded-xl border text-[10px] font-bold transition-all flex items-center gap-0.5 shrink-0 ${theme === 'dark' ? 'bg-slate-800/80 border-slate-700/50 text-slate-400 hover:text-blue-400 hover:border-blue-500/50' : 'bg-white/80 border-slate-300/50 text-slate-500 hover:text-blue-600 hover:border-blue-300'}`}
                                    >
                                        <Clock size={10} />
                                    </button>
                                </div>
                            </div>
                        </div>

                        {/* Session (auto-detected, editable if preferences loaded) + Signal row */}
                        <div className="flex gap-2 mb-4 items-end">
                            <div className="shrink-0 flex flex-col" style={{ minWidth: '110px' }}>
                                {options.sessions.length > 0 ? (
                                    // User has sessions configured in app preferences — show as select
                                    <Select
                                        label="Relace"
                                        value={trade.session}
                                        onChange={updateField('session')}
                                        className="mb-0"
                                        options={options.sessions.map(s => ({ value: s.name, label: s.name }))}
                                    />
                                ) : (
                                    // No preferences — show auto-detected read-only badge
                                    <>
                                        <label className={`block text-xs font-bold uppercase tracking-wider mb-1.5 ${theme === 'dark' ? 'text-slate-400' : 'text-slate-500'}`}>Relace</label>
                                        <div className={`h-[38px] px-3 rounded-xl border flex items-center gap-1.5 text-xs font-bold whitespace-nowrap ${theme === 'dark' ? 'bg-blue-900/30 border-blue-800/50 text-blue-300' : 'bg-blue-50 border-blue-200 text-blue-700'}`}>
                                            {trade.session === 'NY'        && '🗽'}
                                            {trade.session === 'London'    && '🇬🇧'}
                                            {trade.session === 'Asia'      && '🌏'}
                                            {trade.session === 'Overnight' && '🌙'}
                                            {' '}{trade.session}
                                        </div>
                                    </>
                                )}
                            </div>
                            <div className="flex-1">
                                {options.signals.length > 0 ? (
                                    <Select
                                        label="Signál / Setup"
                                        value={trade.signal}
                                        onChange={updateField('signal')}
                                        className="mb-0"
                                        options={signalSelectOptions}
                                    />
                                ) : (
                                    <Input
                                        label="Signál / Setup"
                                        value={trade.signal}
                                        onChange={updateField('signal')}
                                        placeholder="Alpha Bridge v2"
                                        className="mb-0"
                                    />
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {isWide && (
                <TextArea label="Poznámky" value={trade.notes} onChange={updateField('notes')} placeholder="Důvod vstupu, pocity..." rows={2} />
            )}

            {!isWide && (
                <>
                    <MultiSelect
                        label="HTF Kontext"
                        selected={trade.htfConfluence}
                        options={options.htf}
                        onToggle={toggleMultiSelect('htfConfluence')}
                        colorScheme="htf"
                    />
                    <MultiSelect
                        label="LTF Trigger"
                        selected={trade.ltfConfluence}
                        options={options.ltf}
                        onToggle={toggleMultiSelect('ltfConfluence')}
                        colorScheme="ltf"
                    />
                    <MultiSelect
                        label="Emoce"
                        selected={trade.emotions}
                        options={options.emotions}
                        onToggle={toggleMultiSelect('emotions')}
                        colorScheme="emotions"
                    />
                    <MultiSelect
                        label="Chyby"
                        selected={trade.mistakes}
                        options={options.mistakes}
                        onToggle={toggleMultiSelect('mistakes')}
                        colorScheme="mistakes"
                    />
                    <TextArea label="Poznámky" value={trade.notes} onChange={updateField('notes')} placeholder="Důvod vstupu, pocity..." rows={2} />
                </>
            )}

            {previewUrl && (
                <div className={`mb-4 rounded-xl overflow-hidden border ${theme === 'dark' ? 'border-slate-700/50 bg-slate-800/80' : 'border-slate-200 bg-white'}`}>
                    <div className={`px-3 py-2 text-[10px] font-bold uppercase tracking-widest flex justify-between items-center border-b ${theme === 'dark' ? 'bg-white/[0.02] text-slate-400 border-slate-700/50' : 'bg-slate-50 text-slate-500 border-slate-200'}`}>
                        NÁHLED GRAFU
                        <button onClick={(e) => { e.preventDefault(); setPreviewUrl(null); }} className={`bg-transparent border-none cursor-pointer p-0 flex items-center justify-center transition-colors focus:outline-none ${theme === 'dark' ? 'text-slate-400 hover:text-red-400' : 'text-slate-500 hover:text-red-500'}`}>
                            <XCircle size={14} />
                        </button>
                    </div>
                    <img
                        src={previewUrl}
                        alt="Preview"
                        className="w-full h-auto block cursor-zoom-in"
                        onClick={() => setLightboxOpen(true)}
                        title="Klikněte pro zobrazení v plné velikosti"
                    />
                </div>
            )}

            {/* Lightbox is injected into document.body via useEffect to escape Shadow DOM */}

            <div className="flex gap-2">
                <Button
                    onClick={handlePreview}
                    disabled={isPreviewing || isSubmitting}
                    className={`flex-[0.35] border transition-colors shadow-sm font-bold text-xs ${theme === 'dark' ? '!bg-slate-800 !text-slate-200 hover:!bg-slate-700 border-slate-700/50' : '!bg-white !text-slate-700 hover:!bg-slate-50 border-slate-300'}`}
                >
                    {isPreviewing ? <RefreshCw size={14} className="animate-spin" /> : <Eye size={16} />}
                </Button>
                <Button onClick={handleSubmit} disabled={isSubmitting || isPreviewing} className="flex-1 text-xs">
                    {isSubmitting ? (
                        <><RefreshCw size={14} className="animate-spin" /> Zpracovávám...</>
                    ) : (
                        <><Send size={16} /> Zapsat do deníku</>
                    )}
                </Button>
            </div>

            {/* Reset button shown after successful submit */}
            {showReset && (
                <button
                    onClick={handleReset}
                    className={`w-full mt-2 p-2.5 rounded-xl border font-bold text-xs flex items-center justify-center gap-2 transition-all focus:outline-none ${theme === 'dark' ? 'border-slate-700/50 bg-slate-800/50 text-slate-400 hover:bg-slate-700/50 hover:text-slate-200' : 'border-slate-200 bg-slate-50 text-slate-500 hover:bg-slate-100 hover:text-slate-700'}`}
                >
                    <RotateCcw size={13} />
                    Nový obchod (vymazat pole)
                </button>
            )}

            <div className={`text-xs mt-4 text-center font-medium flex items-center justify-center gap-2 ${theme === 'dark' ? 'text-slate-400' : 'text-slate-500'}`}>
                {submitStatus ? (
                    <span className={submitStatus.type === 'error'
                        ? `font-bold flex items-center gap-1.5 ${theme === 'dark' ? 'text-red-400' : 'text-red-500'}`
                        : submitStatus.type === 'success'
                            ? `font-bold flex items-center gap-1.5 ${theme === 'dark' ? 'text-emerald-400' : 'text-emerald-600'}`
                            : `font-semibold flex items-center gap-1.5 ${theme === 'dark' ? 'text-blue-400' : 'text-blue-600'}`
                    }>
                        {submitStatus.type === 'error'   && <XCircle size={14} />}
                        {submitStatus.type === 'success' && <CheckCircle2 size={14} />}
                        {submitStatus.type === 'info'    && <RefreshCw size={14} className="animate-spin" />}
                        {submitStatus.text}
                    </span>
                ) : (
                    <><div className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-pulse shadow-[0_0_8px_rgba(59,130,246,0.8)]"></div> Připraven ke skenování</>
                )}
            </div>
        </div>
    );
}

// ── Chart area resolver (outside component for clarity) ───────────────────────
function resolveChartArea(): Element | null {
    const isFXReplay = window.location.hostname.includes('fxreplay.com');

    if (isFXReplay) {
        const iframes = Array.from(document.querySelectorAll('iframe'));
        if (iframes.length > 0) {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            iframes.forEach(iframe => {
                const r = iframe.getBoundingClientRect();
                if (r.width > 100 && r.height > 100) {
                    minX = Math.min(minX, r.left);  minY = Math.min(minY, r.top);
                    maxX = Math.max(maxX, r.right); maxY = Math.max(maxY, r.bottom);
                }
            });
            if (minX < Infinity) {
                const trim = { top: 45, bottom: 35, right: 55, left: 60 };
                return {
                    getBoundingClientRect: () => new DOMRect(
                        minX + trim.left, minY + trim.top,
                        maxX - minX - trim.right - trim.left,
                        maxY - minY - trim.top - trim.bottom,
                    ),
                } as unknown as Element;
            }
        }
        return (
            document.querySelector('#chart-container') ??
            document.querySelector('div[class*="chart"]') ??
            document.querySelector('.tv-chart-container') ??
            document.querySelector('main')
        );
    }

    // TradingView fallback chain
    return (
        document.querySelector('.layout__area--center') ??
        document.querySelector('.chart-container') ??
        document.querySelector('[class*="chart-markup-table"]') ??
        (document.querySelector('canvas') as HTMLCanvasElement | null)?.parentElement ??
        null
    );
}
