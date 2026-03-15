import React, { useState, useEffect, useMemo } from 'react';
import { Input, Select, Button, TextArea, MultiSelect } from './UI';
import { AccountList } from './AccountList';
import { scrapeTradingView } from '../../lib/scraper';
import { supabase } from '../../lib/supabase';
import { cropImage } from '../../lib/screenshot';
import { RefreshCw, CheckCircle2, XCircle, MinusCircle, Eye, Save, Send } from 'lucide-react';
import { useTheme } from './ThemeContext';

// Chrome API global (extension context)
declare const chrome: any;

export function TradeForm({ isWide = false }: { isWide?: boolean }) {
    const { theme } = useTheme();
    const [trade, setTrade] = useState({
        symbol: 'NQ1!',
        direction: 'LONG',
        risk: '500',
        entry: '',
        sl: '',
        tp: '',
        outcome: 'WIN',
        entryDate: new Date().toISOString().split('T')[0],
        entryTime: new Date().toTimeString().split(' ')[0].slice(0, 5),
        exitDate: new Date().toISOString().split('T')[0],
        exitTime: new Date().toTimeString().split(' ')[0].slice(0, 5),
        pnl: '',
        notes: '',
        htfConfluence: [] as string[],
        ltfConfluence: [] as string[],
        emotions: [] as string[],
        mistakes: [] as string[]
    });

    const [options, setOptions] = useState({
        htf: [] as string[],
        ltf: [] as string[],
        emotions: [] as string[],
        mistakes: [] as string[]
    });


    const [selectedAccounts, setSelectedAccounts] = useState<string[]>([]);
    const [pnlManual, setPnlManual] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [submitStatus, setSubmitStatus] = useState<{ text: string, type: 'info' | 'success' | 'error' } | null>(null);
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const [isPreviewing, setIsPreviewing] = useState(false);
    const [lightboxOpen, setLightboxOpen] = useState(false);

    // Inject fullscreen lightbox into document.body to escape Shadow DOM
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
        closeBtn.textContent = '\u2715';
        closeBtn.style.cssText = 'position:fixed;top:16px;right:16px;background:rgba(0,0,0,0.7);border:1px solid rgba(255,255,255,0.3);border-radius:50%;width:40px;height:40px;cursor:pointer;color:white;font-size:22px;display:flex;align-items:center;justify-content:center;z-index:2147483648;';
        
        const close = () => { setLightboxOpen(false); };
        overlay.onclick = close;
        closeBtn.onclick = close;
        
        overlay.appendChild(img);
        overlay.appendChild(closeBtn);
        document.body.appendChild(overlay);
        
        return () => { document.body.removeChild(overlay); };
    }, [lightboxOpen, previewUrl]);

    const updateField = (field: string) => (val: string) => {
        setTrade(prev => ({ ...prev, [field]: val }));
        if (field === 'pnl') setPnlManual(!!val);
    };

    const toggleMultiSelect = (field: 'htfConfluence' | 'ltfConfluence' | 'emotions' | 'mistakes') => (val: string) => {
        setTrade(prev => ({
            ...prev,
            [field]: prev[field].includes(val)
                ? prev[field].filter(i => i !== val)
                : [...prev[field], val]
        }));
    };

    // Fetch preferences
    useEffect(() => {
        const fetchPrefs = async () => {
            try {
                const { data: { session } } = await supabase.auth.getSession();
                if (session) {
                    const { data, error } = await supabase
                        .from('profiles')
                        .select('preferences')
                        .eq('id', session.user.id)
                        .single();

                    if (data?.preferences) {
                        setOptions({
                            htf: data.preferences.htfOptions || [],
                            ltf: data.preferences.ltfOptions || [],
                            emotions: (data.preferences.emotions || []).map((e: any) => e.label),
                            mistakes: data.preferences.standardMistakes || []
                        });
                    }
                }
            } catch (err) {
                console.error("Failed to fetch user preferences:", err);
            }
        };
        fetchPrefs();
    }, []);


    useEffect(() => {
        const runScraper = () => {
            const result = scrapeTradingView();
            if (result.success && result.data) {
                setTrade(prev => {
                    const newTrade = { ...prev };
                    if (result.symbol && result.symbol !== prev.symbol) newTrade.symbol = result.symbol;
                    if (result.data.direction && result.data.direction !== prev.direction) newTrade.direction = result.data.direction;

                    if (result.data.risk && String(result.data.risk) !== prev.risk) newTrade.risk = String(result.data.risk);
                    if (result.data.entry && String(result.data.entry) !== prev.entry) newTrade.entry = String(result.data.entry);
                    if (result.data.sl && String(result.data.sl) !== prev.sl) newTrade.sl = String(result.data.sl);
                    if (result.data.tp && String(result.data.tp) !== prev.tp) newTrade.tp = String(result.data.tp);

                    return newTrade;
                });
            }
        };

        const interval = setInterval(runScraper, 2000);
        return () => clearInterval(interval);
    }, []);

    // Compute RR and PnL
    const calculations = useMemo(() => {
        const entry = parseFloat(trade.entry) || 0;
        const sl = parseFloat(trade.sl) || 0;
        const tp = parseFloat(trade.tp) || 0;
        const riskDollars = parseFloat(trade.risk) || 0;

        let rrText = "- : -";
        let estPnLVal = "";

        if (entry && sl && (tp || ['WIN', 'LOSS', 'BE'].includes(trade.outcome))) {
            const slDist = Math.abs(entry - sl);
            const tpDist = tp ? Math.abs(tp - entry) : 0;
            if (slDist > 0) {
                const rRatio = tpDist / slDist;
                if (tpDist > 0) rrText = `1 : ${rRatio.toFixed(2)}`;

                if (riskDollars) {
                    let calcPnl = 0;
                    if (trade.outcome === 'WIN') calcPnl = riskDollars * rRatio;
                    else if (trade.outcome === 'LOSS') calcPnl = -riskDollars;
                    else calcPnl = 0;
                    estPnLVal = Math.round(calcPnl).toString();
                }
            }
        }
        return { rrText, estPnLVal };
    }, [trade.entry, trade.sl, trade.tp, trade.risk, trade.outcome]);

    // Auto-fill PnL when inputs change
    useEffect(() => {
        if (!pnlManual && calculations.estPnLVal) {
            setTrade(prev => ({ ...prev, pnl: calculations.estPnLVal }));
        }
    }, [calculations.estPnLVal, pnlManual]);

    const handlePreview = async () => {
        setIsPreviewing(true);
        setSubmitStatus({ text: "Generuji náhled...", type: 'info' });

        try {
            const host = document.getElementById('alpha-bridge-v2-host');
            if (host) host.style.display = 'none';

            // Clear focus from TV to hide floating UI
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27 }));
            // Small delay to ensure DOM repaints without Sidebar
            await new Promise(resolve => setTimeout(resolve, 800));

            chrome.runtime.sendMessage({ action: "captureVisibleTab" }, async (response) => {
                if (host) host.style.display = 'block';

                if (!response || !response.success) {
                    setIsPreviewing(false);
                    setSubmitStatus({ text: "Chyba při focení: " + (response ? response.error : "unknown"), type: 'error' });
                    return;
                }

                const imageUrl = response.dataUrl;

                const isFXReplay = window.location.hostname.includes('fxreplay.com');
                let chartArea: Element | null = null;
                
                if (isFXReplay) {
                    const iframes = Array.from(document.querySelectorAll('iframe'));
                    
                    if (iframes.length > 0) {
                        // Calculate bounding box encompassing ALL iframes
                        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                        
                        iframes.forEach(iframe => {
                            const rect = iframe.getBoundingClientRect();
                            if (rect.width > 100 && rect.height > 100) { // Ignore hidden/tiny iframes
                                minX = Math.min(minX, rect.left);
                                minY = Math.min(minY, rect.top);
                                maxX = Math.max(maxX, rect.right);
                                maxY = Math.max(maxY, rect.bottom);
                            }
                        });

                        if (minX < Infinity) {
                            const trimTop = 45;
                            const trimBottom = 35;
                            const trimRight = 55;
                            const trimLeft = 60;
                            chartArea = {
                                getBoundingClientRect: () => new DOMRect(minX + trimLeft, minY + trimTop, maxX - minX - trimRight - trimLeft, maxY - minY - trimTop - trimBottom)
                            } as unknown as Element;
                        }
                    }
                    
                    if (!chartArea) {
                        chartArea = document.querySelector('#chart-container') || document.querySelector('div[class*="chart"]') || document.querySelector('main');
                    }
                } else {
                    chartArea = document.querySelector('.layout__area--center');
                }

                const rect = chartArea ? chartArea.getBoundingClientRect() : new DOMRect(0, 0, window.innerWidth, window.innerHeight);
                const croppedImageUrl = await cropImage(imageUrl, rect);

                setPreviewUrl(croppedImageUrl);
                setSubmitStatus(null);
                setIsPreviewing(false);
            });
        } catch (err: any) {
            console.error(err);
            setIsPreviewing(false);
            setSubmitStatus({ text: err.message, type: 'error' });
        }
    };

    const handleSubmit = async () => {
        if (selectedAccounts.length === 0) {
            setSubmitStatus({ text: "Vyberte alespoň jeden účet!", type: 'error' });
            return;
        }

        const isWeekend = (dateStr: string | undefined) => {
            if (!dateStr) return false;
            const parts = dateStr.split('-');
            if (parts.length === 3) {
                const year = parseInt(parts[0]);
                const month = parseInt(parts[1]) - 1;
                const day = parseInt(parts[2]);
                const date = new Date(year, month, day);
                return !isNaN(date.getTime()) && (date.getDay() === 0 || date.getDay() === 6);
            }
            const d = new Date(dateStr);
            return !isNaN(d.getTime()) && (d.getDay() === 0 || d.getDay() === 6);
        };

        if (isWeekend(trade.entryDate) || isWeekend(trade.exitDate)) {
            setSubmitStatus({ text: "Obchod nelze zadat o víkendu! Vyberte pracovní den.", type: 'error' });
            setIsSubmitting(false);
            return;
        }

        setIsSubmitting(true);
        setSubmitStatus({ text: "Čistím graf a fotím...", type: 'info' });

        let host: HTMLElement | null = null;

        try {
            // 1. Get Session
            setSubmitStatus({ text: "🔑 Načítám session...", type: 'info' });
            const { data: { session }, error: sessionErr } = await supabase.auth.getSession();
            if (sessionErr) throw new Error("Session chyba: " + sessionErr.message);
            if (!session) throw new Error("Nejste přihlášeni. Odhlaste se a přihlaste znovu.");

            setSubmitStatus({ text: "📸 Schovávám UI, fotím graf...", type: 'info' });

            // 2. Hide UI for Screenshot
            host = document.getElementById('alpha-bridge-v2-host');
            if (host) host.style.display = 'none';

            // 3. Clear focus from TV to hide floating UI
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27 }));

            // 3.5 Specific FX Replay Hack: Try to close their "Long Position / Short Position" modal if it's open
            if (window.location.hostname.includes('fxreplay.com') || window.location.hostname.includes('tradingview')) {
                const tryCloseDialog = (doc: Document) => {
                    // Method 1: Target specifically standard TV dialog close buttons (`[data-name="close"]`)
                    const closeBtn = doc.querySelector('[data-name="close"], button[class*="close"], svg[class*="close"]');
                    if (closeBtn) {
                        if (closeBtn.tagName === 'svg' && closeBtn.parentElement) {
                            (closeBtn.parentElement as HTMLElement).click();
                        } else {
                            (closeBtn as HTMLElement).click();
                        }
                    } else {
                        // Method 2: Text based "Cancel"
                        const cancelButtons = Array.from(doc.querySelectorAll('span, button')).filter(b => b.textContent?.trim().toLowerCase() === 'cancel' || b.textContent?.trim().toLowerCase() === 'zrušit');
                        if (cancelButtons.length > 0) {
                            (cancelButtons[cancelButtons.length - 1] as HTMLElement).click(); 
                        }
                    }
                };

                try {
                    tryCloseDialog(document);
                    
                    // Look inside FX Replay iframes
                    document.querySelectorAll('iframe').forEach(iframe => {
                        try {
                            if (iframe.contentDocument) {
                                tryCloseDialog(iframe.contentDocument);
                            }
                        } catch(e) { /* Ignore CORS */ }
                    });
                } catch (e) {
                    // Ignore errors in UI closing attempts
                }
            }

            // Small delay to ensure DOM repaints without Sidebar
            await new Promise(resolve => setTimeout(resolve, 800));

            // 3. Capture Tab
            setSubmitStatus({ text: "📸 Čekám na screenshot...", type: 'info' });
            const response: any = await new Promise((resolve, reject) => {
                chrome.runtime.sendMessage({ action: "captureVisibleTab" }, (res) => {
                    if (chrome.runtime.lastError) {
                        reject(new Error("Screenshot: " + chrome.runtime.lastError.message));
                    } else {
                        resolve(res);
                    }
                });
            });

            // Restore UI immediately
            if (host) host.style.display = 'block';

            if (!response || !response.success) {
                throw new Error("Chyba při focení: " + (response ? response.error : "No response from background"));
            }

            setSubmitStatus({ text: "💾 Screenshot OK. Ukládám data...", type: 'info' });

            const imageUrl = response.dataUrl;
            const isFXReplay = window.location.hostname.includes('fxreplay.com');
            let chartArea: Element | null = null;
            
            if (isFXReplay) {
                const iframes = Array.from(document.querySelectorAll('iframe'));
                
                if (iframes.length > 0) {
                    // Calculate bounding box encompassing ALL iframes
                    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                    
                    iframes.forEach(iframe => {
                        const rect = iframe.getBoundingClientRect();
                        if (rect.width > 100 && rect.height > 100) { // Ignore hidden/tiny iframes
                            minX = Math.min(minX, rect.left);
                            minY = Math.min(minY, rect.top);
                            maxX = Math.max(maxX, rect.right);
                            maxY = Math.max(maxY, rect.bottom);
                        }
                    });

                    if (minX < Infinity) {
                        const trimTop = 45;
                        const trimBottom = 35;
                        const trimRight = 55;
                        const trimLeft = 60;
                        chartArea = {
                            getBoundingClientRect: () => new DOMRect(minX + trimLeft, minY + trimTop, maxX - minX - trimRight - trimLeft, maxY - minY - trimTop - trimBottom)
                        } as unknown as Element;
                    }
                }
                
                if (!chartArea) {
                    chartArea = document.querySelector('#chart-container') || document.querySelector('div[class*="chart"]') || document.querySelector('.tv-chart-container') || document.querySelector('main');
                }
            } else {
                // TradingView standard chart area
                chartArea = document.querySelector('.layout__area--center');
            }

            const rect = chartArea ? chartArea.getBoundingClientRect() : new DOMRect(0, 0, window.innerWidth, window.innerHeight);
            const croppedImageUrl = await cropImage(imageUrl, rect);


            // 4. Calculate final values
            const entry = parseFloat(trade.entry) || null;
            const sl = parseFloat(trade.sl) || null;
            const tp = parseFloat(trade.tp) || null;
            const risk = parseFloat(trade.risk) || 0;
            let pnl = 0;

            let exitPrice = null;
            if (trade.outcome === 'WIN') exitPrice = tp;
            else if (trade.outcome === 'LOSS') exitPrice = sl;
            else if (trade.outcome === 'BE') exitPrice = entry;

            // Resolve estimated PnL as actual PnL if available, but let manual PnL override it
            if (trade.pnl) {
                pnl = parseFloat(trade.pnl) || 0;
            } else if (entry && sl && (tp || ['WIN', 'LOSS', 'BE'].includes(trade.outcome))) {
                const slDist = Math.abs(entry - sl);
                const tpDist = tp ? Math.abs(tp - entry) : 0;
                if (slDist > 0 && tpDist > 0) {
                    const rRatio = tpDist / slDist;
                    if (trade.outcome === 'WIN') pnl = risk * rRatio;
                    else if (trade.outcome === 'LOSS') pnl = -risk;
                    else pnl = 0; // BE
                }
            }

            const commonGroupId = crypto.randomUUID();
            let masterTradeId: string | null = null;
            const baseDateStr = trade.entryDate || new Date().toISOString().split('T')[0];
            const baseTimeStr = trade.entryTime || new Date().toTimeString().split(' ')[0].slice(0, 5);
            let finalDateIso = new Date().toISOString();
            let finalTimestamp = Date.now();
            let durationString = "0 m";
            let durationMins = 0;

            try {
                const parsedDate = new Date(`${baseDateStr}T${baseTimeStr}:00`);
                const baseExitDateStr = trade.exitDate || baseDateStr;
                const baseExitTimeStr = trade.exitTime || baseTimeStr;
                const parsedExitDate = new Date(`${baseExitDateStr}T${baseExitTimeStr}:00`);

                if (!isNaN(parsedDate.getTime())) {
                    finalDateIso = parsedDate.toISOString();
                    finalTimestamp = parsedDate.getTime();
                }

                if (!isNaN(parsedDate.getTime()) && !isNaN(parsedExitDate.getTime())) {
                    const diffMs = parsedExitDate.getTime() - parsedDate.getTime();
                    if (diffMs > 0) {
                        durationMins = Math.floor(diffMs / 60000);
                        const h = Math.floor(durationMins / 60);
                        const m = durationMins % 60;
                        durationString = h > 0 ? `${h}h ${m}m` : `${m} m`;
                    }
                }
            } catch (e) {
                // Fallback to current time if parsing fails
            }

            // Fix MNQ mapping
            let finalInstrument = trade.symbol || "Unknown";
            if (finalInstrument.toUpperCase().startsWith('NQ')) finalInstrument = 'MNQ';

            // 4.5 Upload image to Supabase Storage (like V1)
            let publicUrl = null;
            if (croppedImageUrl) {
                setSubmitStatus({ text: "☁️ Nahrávám fotku...", type: 'info' });
                const base64Data = croppedImageUrl.replace(/^data:image\/\w+;base64,/, "");
                const binary = atob(base64Data);
                const array = [];
                for (let i = 0; i < binary.length; i++) array.push(binary.charCodeAt(i));
                const buffer = new Uint8Array(array);
                const fileName = `ext_${Date.now()}_${Math.floor(Math.random() * 1000)}.jpg`;

                const { error: upErr } = await supabase.storage.from('trade-images').upload(fileName, buffer, { contentType: 'image/jpeg' });
                if (upErr) {
                    console.error("Upload error:", upErr);
                    throw new Error("Nepodařilo se nahrát fotku: " + upErr.message);
                }

                const { data: urlData } = supabase.storage.from('trade-images').getPublicUrl(fileName);
                publicUrl = urlData?.publicUrl || null;
            }

            // 5. Build Submissions - strictly mimicking V1 popup.js sendData()
            const masterCheckbox = selectedAccounts.length > 0 ? selectedAccounts[0] : null;

            // 5.1 Fetch account data to get correct phase
            setSubmitStatus({ text: "📋 Načítám účty...", type: 'info' });
            console.log('[AlphaBridge TradeForm] 🎯 Selected account IDs:', selectedAccounts);
            console.log('[AlphaBridge TradeForm] 🔑 Session user ID:', session.user.id);

            const { data: accountsData, error: accountsError } = await supabase
                .from('accounts')
                .select('id, type, meta')
                .in('id', selectedAccounts);

            if (accountsError) {
                console.error('[AlphaBridge] Failed to fetch accounts:', accountsError);
            }

            console.log('[AlphaBridge TradeForm] 📊 Fetched accounts:', accountsData?.map(a => ({ id: a.id, phase: a.meta?.phase, type: a.type })));

            // Create a map of accountId -> phase for quick lookup
            const accountPhaseMap = new Map<string, string>();
            accountsData?.forEach(acc => {
                const phase = acc.meta?.phase || 'Challenge';
                accountPhaseMap.set(acc.id, phase);
            });

            const rows = selectedAccounts.map(accId => {
                const phase = accountPhaseMap.get(accId) || 'Challenge'; // Use actual phase from account
                const isMaster = accId === masterCheckbox;
                const tradeId = crypto.randomUUID();

                // EXACT V1 data block
                const tradeData = {
                    id: tradeId,
                    accountId: accId,
                    instrument: finalInstrument,
                    entryPrice: entry,
                    exitPrice: (trade.outcome === 'WIN' ? tp : (trade.outcome === 'LOSS' ? sl : entry)),
                    stopLoss: sl,
                    takeProfit: tp,
                    riskAmount: risk,
                    screenshot: publicUrl,
                    screenshots: publicUrl ? [publicUrl] : [],
                    exitDate: null,
                    status: (['WIN', 'LOSS', 'BE'].includes(trade.outcome || '')) ? 'CLOSED' : 'OPEN',
                    outcome: (['WIN', 'LOSS', 'BE'].includes(trade.outcome || '')) ? trade.outcome : null,
                    groupId: commonGroupId,
                    isMaster,
                    masterTradeId: (!isMaster && masterCheckbox) ? masterTradeId : (isMaster ? masterTradeId : null),
                    session: "NY",
                    phase,
                    executionStatus: "Valid",
                    signal: "Alpha Bridge v2",
                    htfConfluence: trade.htfConfluence,
                    ltfConfluence: trade.ltfConfluence,
                    // Duplicate for dashboard compatibility
                    htf: trade.htfConfluence,
                    ltf: trade.ltfConfluence,
                    emotions: trade.emotions,
                    mistakes: trade.mistakes,
                    notes: trade.notes
                };

                return {
                    id: tradeId,
                    user_id: session.user.id,
                    account_id: accId,
                    instrument: finalInstrument,
                    direction: trade.direction,
                    pnl: pnl,
                    date: finalDateIso,
                    timestamp: finalTimestamp,
                    signal: "Alpha Bridge v2",
                    is_public: false,
                    data: tradeData
                };
            });

            // 6. Insert via direct REST fetch to bypass Content Script auth sync issues
            setSubmitStatus({ text: "💾 Ukládám do databáze...", type: 'info' });

            const SUPABASE_URL = "https://kopinlpdvjfgmvxydohk.supabase.co";
            const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtvcGlubHBkdmpmZ212eHlkb2hrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjczNzgxMzksImV4cCI6MjA4Mjk1NDEzOX0.qW_Gi9AkZSBAubuYsv3ITor8fGEqEl56d-oJcUtxW8M";

            // DEBUG LOGGING
            console.log('[AlphaBridge] 🔍 Preparing to save trade...');
            console.log('[AlphaBridge] 📦 Request body (rows):', JSON.stringify(rows, null, 2));
            console.log('[AlphaBridge] 🔑 Session access_token:', session.access_token ? `${session.access_token.substring(0, 20)}...` : 'MISSING!');
            console.log('[AlphaBridge] 👤 Session user ID:', session.user?.id || 'MISSING!');

            const res = await fetch(`${SUPABASE_URL}/rest/v1/trades`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': SUPABASE_KEY,
                    'Authorization': `Bearer ${session.access_token}`,
                    'Prefer': 'return=representation'
                },
                body: JSON.stringify(rows)
            });

            console.log('[AlphaBridge] 📡 Response status:', res.status, res.statusText);
            console.log('[AlphaBridge] 📋 Response headers:', Object.fromEntries(res.headers.entries()));

            if (!res.ok) {
                const errBody = await res.text();
                console.error('[AlphaBridge] ❌ Error response body:', errBody);
                throw new Error(`DB chyba ${res.status}: ${errBody}`);
            }

            const savedTrades = await res.json();
            console.log('[AlphaBridge] ✅ Saved trades response:', savedTrades);

            if (!savedTrades || savedTrades.length === 0) {
                throw new Error("Databáze odmítla uložení (RLS). Zkuste se odhlásit a znovu přihlásit v Extenzi.");
            }

            setSubmitStatus({ text: `Zapsáno do deníku! 🚀 (${savedTrades.length}x)`, type: 'success' });
            setTimeout(() => setSubmitStatus(null), 4000);
        } catch (err: any) {
            console.error(err);
            setSubmitStatus({ text: err.message, type: 'error' });
        } finally {
            setIsSubmitting(false);
            if (host) host.style.display = 'block';
        }
    };

    return (
        <div className="w-full">
            <div className={isWide ? "flex gap-6 items-start" : ""}>
                {isWide && (
                    <div className="w-[280px] shrink-0 overflow-y-auto pr-3 custom-scrollbar border-r border-slate-700/20 max-h-[70vh]">
                        <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-cyan-500 mb-4 flex items-center gap-2">
                            Tactical Engine
                        </h3>
                        <MultiSelect
                            label="HTF Kontext"
                            selected={trade.htfConfluence}
                            options={options.htf}
                            onToggle={toggleMultiSelect('htfConfluence')}
                        />
                        <MultiSelect
                            label="LTF Trigger"
                            selected={trade.ltfConfluence}
                            options={options.ltf}
                            onToggle={toggleMultiSelect('ltfConfluence')}
                        />
                        <MultiSelect
                            label="Emoce"
                            selected={trade.emotions}
                            options={options.emotions}
                            onToggle={toggleMultiSelect('emotions')}
                        />
                        <MultiSelect
                            label="Chyby"
                            selected={trade.mistakes}
                            options={options.mistakes}
                            onToggle={toggleMultiSelect('mistakes')}
                        />
                    </div>
                )}

                <div className="flex-1">
                    <div className="flex flex-col">
                        <AccountList onSelectionChange={setSelectedAccounts} />

                        {/* Symbol, Direction & RR Array */}
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
                                <div className={`border rounded-xl h-[38px] flex items-center justify-center font-bold text-xs px-2 gap-1 min-w-[70px] ${theme === 'dark' ? 'bg-gradient-to-r from-cyan-900/40 to-transparent border-cyan-800/50 text-cyan-400' : 'bg-gradient-to-r from-cyan-100/50 to-transparent border-cyan-200 text-cyan-700'}`}>
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
                            <div className="flex-1"><Input label="Zisk ($)" value={trade.pnl} onChange={updateField('pnl')} placeholder={calculations.estPnLVal || ""} type="number" className="mb-0" /></div>
                            <div className="flex-1">
                                <Select
                                    label="Stav"
                                    value={trade.outcome}
                                    onChange={updateField('outcome')}
                                    className="mb-0"
                                    options={[
                                        { value: 'WIN', label: 'WIN 🟢' },
                                        { value: 'LOSS', label: 'LOSS 🔴' },
                                        { value: 'BE', label: 'BE 🟡' }
                                    ]}
                                />
                            </div>
                        </div>

                        <div className="flex gap-2 mb-4">
                            <div className="flex-[0.9] min-w-0"><Input label="Datum" value={trade.entryDate} onChange={(val) => { updateField('entryDate')(val); updateField('exitDate')(val); }} type="date" className="mb-0" inputClassName="px-2" /></div>
                            <div className="flex-1 min-w-0"><Input label="Entry" value={trade.entryTime} onChange={(val) => { updateField('entryTime')(val); updateField('exitTime')(val); }} type="time" className="mb-0" inputClassName="px-2" /></div>
                            <div className="flex-1 min-w-0"><Input label="Exit" value={trade.exitTime} onChange={updateField('exitTime')} type="time" className="mb-0" inputClassName="px-2" /></div>
                        </div>
                    </div>

                </div>
            </div>

            {isWide && (
                <TextArea label="Poznámky" value={trade.notes} onChange={updateField('notes')} placeholder="Důvod vstupu, pocity..." rows={2} />
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
                <Button onClick={handlePreview} disabled={isPreviewing || isSubmitting} className={`flex-[0.35] border transition-colors shadow-sm font-bold text-xs ${theme === 'dark' ? '!bg-slate-800 !text-slate-200 hover:!bg-slate-700 border-slate-700/50' : '!bg-white !text-slate-700 hover:!bg-slate-50 border-slate-300'}`}>
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

            <div className={`text-xs mt-4 text-center font-medium flex items-center justify-center gap-2 ${theme === 'dark' ? 'text-slate-400' : 'text-slate-500'}`}>
                {submitStatus ? (
                    <span className={submitStatus.type === 'error' ? `font-bold flex items-center gap-1.5 ${theme === 'dark' ? 'text-red-400' : 'text-red-500'}` : (submitStatus.type === 'success' ? `font-bold flex items-center gap-1.5 ${theme === 'dark' ? 'text-emerald-400' : 'text-emerald-600'}` : `font-semibold flex items-center gap-1.5 ${theme === 'dark' ? 'text-cyan-400' : 'text-cyan-600'}`)}>
                        {submitStatus.type === 'error' && <XCircle size={14} />}
                        {submitStatus.type === 'success' && <CheckCircle2 size={14} />}
                        {submitStatus.type === 'info' && <RefreshCw size={14} className="animate-spin" />}
                        {submitStatus.text}
                    </span>
                ) : (
                    <><div className="w-1.5 h-1.5 bg-cyan-500 rounded-full animate-pulse shadow-[0_0_8px_rgba(6,182,212,0.8)]"></div> Připraven ke skenování</>
                )}
            </div>

        </div>
    );
}
