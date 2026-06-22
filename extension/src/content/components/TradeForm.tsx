import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Input, Select, Button, TextArea, MultiSelect } from './UI';
import { AccountList } from './AccountList';
import { readActivePosition, captureChartSnapshot, captureMultiTF, getChartLayout, computeCounterfactual, CounterfactualRead, readBoxLevels } from '../../lib/positionReader';
import { supabase, SUPABASE_URL, SUPABASE_KEY } from '../../lib/supabase';
import { cropImage } from '../../lib/screenshot';
import { RefreshCw, CheckCircle2, XCircle, Eye, Send, RotateCcw, Clock, Layers, TrendingUp, TrendingDown } from 'lucide-react';
import { useTheme } from './ThemeContext';
import VoiceMemoButton from './VoiceMemoButton';

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

// Find which session from user's preferences matches a given time-of-day.
// atMinutes = minuty od půlnoci (z času VSTUPU obchodu). Bez parametru = aktuální čas.
function detectBestSession(sessions: SessionConfig[], atMinutes?: number): string {
    if (sessions.length === 0) return detectSession();

    const now = new Date();
    const currentMinutes = atMinutes ?? (now.getHours() * 60 + now.getMinutes());

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

    // Žádná session netrefena → obchod byl mimo definované session.
    return 'Mimo session';
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
        contracts: '',
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
        executionStatus: 'Valid' as 'Valid' | 'Invalid' | 'Missed',
        // Execution varianty — auto-detekce z grafu při čtení pozice (s možností přepsat).
        slPlacement: '',   // kam SL: fvg / swing / ote / other (auto)
        targetType:  '',   // kam target: kategorie (auto z detekovaného levelu)
        targetLevel: '',   // přesný detekovaný TP level (např. "PDH", "VWAP +1σ") — bonus data
    };
}

// Execution → LTF Trigger tagy. Po auto-detekci se odpovídající tag sám označí v LTF konfluenci.
const EXEC_SL_TAGS: Record<string, string> = { fvg: 'SL FVG', ote: 'SL OTE', swing: 'SL Swing' };
const ALL_SL_TAGS = ['SL FVG', 'SL OTE', 'SL Swing'];
const SL_TAG_TO_KEY: Record<string, string> = { 'SL FVG': 'fvg', 'SL OTE': 'ote', 'SL Swing': 'swing' };
// Čistá kategorie slPlacement odvozená z reálně označeného LTF tagu (source of truth).
const slKeyFromTags = (ltf: string[]): string | null => { for (const t of ltf) { if (SL_TAG_TO_KEY[t]) return SL_TAG_TO_KEY[t]; } return null; };

// TP tagy do LTF Trigger (stejný princip jako SL). Detekovaný level → tag, a zpět.
const ALL_TP_TAGS = ['TP dHigh', 'TP dLow', 'TP PDH', 'TP PDL', 'TP PWH', 'TP PWL', 'TP VWAP', 'TP deviace +1', 'TP deviace -1', 'TP deviace +2', 'TP deviace -2'];

// ENTRY tagy (vstupní model): odraz od levelu + struktura (kolikátý zlom) + entry na hraně FVG.
const ALL_ENTRY_TAGS = ['Entry FVG', 'CHoCH 1.', 'BoS 2.', 'BoS 3.', 'BoS 4.', 'Odraz dHigh', 'Odraz dLow', 'Odraz PDH', 'Odraz PDL', 'Odraz PWH', 'Odraz PWL', 'Odraz VWAP', 'Odraz deviace +1', 'Odraz deviace -1', 'Odraz deviace +2', 'Odraz deviace -2'];
const isEntryTag = (t: string) => /^(Entry FVG|CHoCH|BoS|Odraz)\b/.test(t);
// level (např. "VWAP +1σ", "dHigh") → krátký název pro odraz tag ("deviace +1", "VWAP", "dHigh")
const levelShort = (level: string): string => {
    const dev = level.match(/VWAP\s*([+-])\s*(\d)\s*σ/i);
    if (dev) return `deviace ${dev[1]}${dev[2]}`;
    if (/^VWAP$/i.test(level.trim())) return 'VWAP';
    return level.trim();
};
// cf.entryMap → seznam entry tagů (struktura + odraz + FVG). Odraz může mít víc levelů (konfluence).
const entryTagsFromMap = (em: any): string[] => {
    if (!em || !em.available) return [];
    const out: string[] = [];
    if (em.structureType && em.structureOrder >= 1) out.push(`${em.structureType} ${em.structureOrder}.`);
    const odraz: string[] = Array.isArray(em.odrazLevels) ? em.odrazLevels : (em.odrazLevel ? [em.odrazLevel] : []);
    for (const lv of odraz) out.push(`Odraz ${levelShort(String(lv))}`);
    if (em.entryFvg) out.push('Entry FVG');
    return out;
};

// Flat-by čas (no overnight) v minutách lokálního dne — strop pro "kam by to došlo". 22:00 = RTH close.
const FLAT_BY_MIN = 22 * 60;
const isTpTag = (t: string) => /^TP\s+/.test(t);
// detekovaný level (např. "VWAP +1σ", "PDH") → TP tag ("TP deviace +1", "TP PDH")
const tpTagFromLevel = (level: string): string | null => {
    if (!level) return null;
    const dev = level.match(/VWAP\s*([+-])\s*(\d)\s*σ/i);
    if (dev) return `TP deviace ${dev[1]}${dev[2]}`;
    if (/^VWAP$/i.test(level.trim())) return 'TP VWAP';
    return `TP ${level.trim()}`;
};
// reálně označený TP tag → {targetLevel, targetType} (source of truth při ukládání)
const tpInfoFromTag = (ltf: string[]): { targetLevel: string | null; targetType: string | null } => {
    const tag = ltf.find(isTpTag);
    if (!tag) return { targetLevel: null, targetType: null };
    const body = tag.replace(/^TP\s+/, '').trim();
    const dev = body.match(/^deviace\s*([+-])(\d)$/i);
    if (dev) return { targetLevel: `VWAP ${dev[1]}${dev[2]}σ`, targetType: 'deviation' };
    if (/^VWAP$/i.test(body)) return { targetLevel: 'VWAP', targetType: 'liquidity' };
    return { targetLevel: body, targetType: /dHigh|dLow/i.test(body) ? 'daily' : 'liquidity' };
};

// Auto-detekce execution tagů z grafu: porovná reálný SL/TP boxu s úrovněmi z counterfactualu.
//   SL placement = nejbližší z fvg/ote/swing. Target = nejbližší likviditní level (+ kategorie).
function detectExecTags(entry: number, sl: number, tp: number, c: any): { slPlacement: string; targetType: string; targetLevel: string; targetLevels: string[] } {
    const out: { slPlacement: string; targetType: string; targetLevel: string; targetLevels: string[] } = { slPlacement: '', targetType: '', targetLevel: '', targetLevels: [] };
    const slCand: { k: string; v: number }[] = [];
    if (c.fvg && c.fvg.ok && c.fvg.sl != null) slCand.push({ k: 'fvg', v: c.fvg.sl });
    if (c.ote && c.ote.ok && c.ote.sl != null) slCand.push({ k: 'ote', v: c.ote.sl });
    if (c.swing && c.swing.ok && c.swing.sl != null) slCand.push({ k: 'swing', v: c.swing.sl });
    if (slCand.length && sl != null) {
        let best: any = null, bd = Infinity;
        for (const x of slCand) { const d = Math.abs(sl - x.v); if (d < bd) { bd = d; best = x; } }
        const dist = Math.abs(entry - sl) || 1;
        out.slPlacement = (best && bd <= Math.max(2, dist * 0.2)) ? best.k : 'other';
    }
    // TP tagy: level(y) u TP z DYNAMICKÉHO pásma v baru zásahu (+ konfluence se statickými). Zamrzlé labely nesedí.
    const isLiveVwapLbl = (s: string) => /^\s*VWAP(\s*[+-]\s*[12]\s*σ)?\s*$/i.test(s);
    if (c.excursion && c.excursion.available && Array.isArray(c.excursion.tpLevels) && c.excursion.tpLevels.length) {
        out.targetLevels = c.excursion.tpLevels.map((s: string) => String(s).trim());
        out.targetLevel = out.targetLevels[0];
        out.targetType = /σ|VWAP\s*[+-]/i.test(out.targetLevel) ? 'deviation' : /dHigh|dLow/i.test(out.targetLevel) ? 'daily' : 'liquidity';
    } else if (c.tpTargets && c.tpTargets.length && tp != null) {
        // Fallback: statické levely (PDH/dLow…) — live VWAP rodinu vynech (tu řeší dynamika výše).
        let best: any = null, bd = Infinity;
        for (const t of c.tpTargets) { if (isLiveVwapLbl(String(t.label))) continue; const d = Math.abs(tp - t.price); if (d < bd) { bd = d; best = t; } }
        const dist = Math.abs(entry - tp) || 1;
        if (best && bd <= Math.max(3, dist * 0.1)) {
            // konfluence statických levelů u TP
            const confBand = Math.max(3, dist * 0.08); const seenT: any = {};
            for (const t of c.tpTargets) { if (isLiveVwapLbl(String(t.label))) continue; if (Math.abs(t.price - best.price) <= confBand) { const lbl = String(t.label).replace(/\s*\[.*?\]\s*$/, '').trim(); if (!seenT[lbl]) { seenT[lbl] = true; out.targetLevels.push(lbl); } } }
            out.targetLevel = out.targetLevels[0] || '';
            out.targetType = /σ|VWAP\s*[+-]/i.test(out.targetLevel) ? 'deviation' : /dHigh|dLow/i.test(out.targetLevel) ? 'daily' : 'liquidity';
        } else {
            out.targetType = 'fixed_rr';
        }
    }
    return out;
}

export function TradeForm({ isWide = false, autoLoadSignal = 0, mode = 'normal', active = false }: { isWide?: boolean; autoLoadSignal?: number; mode?: 'normal' | 'backtest'; active?: boolean }) {
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
    // Režim (Live/Backtest) je teď řízen z headeru (Sidebar) a přichází propsem `mode`.

    // ── Backtest session (pre/post) — ukládá se do samostatné backtest_sessions tabulky ──
    const [btSession, setBtSession] = useState<{ bias: '' | 'Long' | 'Short' | 'Neutral'; preNotes: string; postNotes: string }>({ bias: '', preNotes: '', postNotes: '' });
    const [sessionStatus, setSessionStatus] = useState<{ text: string; type: 'info' | 'success' | 'error' } | null>(null);
    const [pnlManual, setPnlManual] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [submitStatus, setSubmitStatus] = useState<{ text: string, type: 'info' | 'success' | 'error' } | null>(null);
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const [isPreviewing, setIsPreviewing] = useState(false);
    const [lightboxOpen, setLightboxOpen] = useState(false);
    const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
    const openLightbox = (url: string) => { setLightboxUrl(url); setLightboxOpen(true); };
    // Aktuální seznam URL galerie (entry + kontext) pro navigaci šipkami v lightboxu.
    const galleryUrlsRef = useRef<string[]>([]);
    const [showReset, setShowReset] = useState(false);

    // ── Fullscreen lightbox (s navigací ◀▶ napříč galerií) ────────────────────
    useEffect(() => {
        const lbUrl = lightboxUrl || previewUrl;
        if (!lightboxOpen || !lbUrl) return;

        const gallery = galleryUrlsRef.current;
        const curIdx = gallery.indexOf(lbUrl);
        const go = (dir: number) => {
            if (curIdx < 0 || gallery.length < 2) return;
            const ni = (curIdx + dir + gallery.length) % gallery.length;
            setLightboxUrl(gallery[ni]);
        };

        const overlay = document.createElement('div');
        overlay.id = 'alpha-bridge-lightbox';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,0.96);display:flex;align-items:center;justify-content:center;cursor:zoom-out;';

        const img = document.createElement('img');
        img.src = lbUrl;
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

        // Navigační šipky + počítadlo jen když je v galerii víc snímků.
        const multi = curIdx >= 0 && gallery.length > 1;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
            else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
            else if (e.key === 'Escape') { close(); }
        };
        if (multi) {
            const arrowCss = 'position:fixed;top:50%;transform:translateY(-50%);background:rgba(0,0,0,0.6);border:1px solid rgba(255,255,255,0.3);border-radius:50%;width:48px;height:48px;cursor:pointer;color:white;font-size:26px;display:flex;align-items:center;justify-content:center;z-index:2147483648;';
            const prev = document.createElement('button');
            prev.textContent = '‹'; prev.style.cssText = arrowCss + 'left:16px;';
            prev.onclick = (e) => { e.stopPropagation(); go(-1); };
            const next = document.createElement('button');
            next.textContent = '›'; next.style.cssText = arrowCss + 'right:16px;';
            next.onclick = (e) => { e.stopPropagation(); go(1); };
            const counter = document.createElement('div');
            counter.textContent = `${curIdx + 1} / ${gallery.length}`;
            counter.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.6);color:white;padding:4px 12px;border-radius:999px;font-size:13px;font-weight:700;z-index:2147483648;';
            overlay.appendChild(prev); overlay.appendChild(next); overlay.appendChild(counter);
        }
        document.addEventListener('keydown', onKey);
        document.body.appendChild(overlay);

        return () => { document.removeEventListener('keydown', onKey); document.body.removeChild(overlay); };
    }, [lightboxOpen, lightboxUrl, previewUrl]);

    // ── Field helpers ────────────────────────────────────────────────────────
    const updateField = (field: string) => (val: string) => {
        setTrade(prev => ({ ...prev, [field]: val }));
        if (field === 'pnl') setPnlManual(!!val);
    };

    // Append transkribovaný hlas do notes (s mezerou když už něco je)
    const appendToNotes = (text: string) => {
        if (!text) return;
        setTrade(prev => ({
            ...prev,
            notes: prev.notes ? `${prev.notes.trim()} ${text}` : text,
        }));
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
        setHtfShots([]);
        setCf(null);
        setPnlManual(false);
        setShowReset(false);
        setSubmitStatus(null);
        // Auto-sync: odemkni sledovaný box, ať se další obchod chytí na nový box.
        trackedBoxRef.current = null;
        lastBoxRef.current = '';
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
                    // Auto-detect session z času VSTUPU obchodu (ne z aktuálního času).
                    if (sessions.length > 0) {
                        setTrade(prev => {
                            const mins = prev.entryTime ? timeToMinutes(prev.entryTime) : NaN;
                            return { ...prev, session: detectBestSession(sessions, isNaN(mins) ? undefined : mins) };
                        });
                    }
                }
            } catch (err) {
                console.error('[AlphaBridge] Failed to fetch user preferences:', err);
            }
        };
        fetchPrefs();
    }, []);

    // ── Načtení Long/Short position boxu z grafu (přes chart API) ─────────────
    const [posReadStatus, setPosReadStatus] = useState<{ text: string; type: 'info' | 'success' | 'error' } | null>(null);
    // Summary header je rozbalovací — sbalený ukáže gist, klik rozbalí detailní pole.
    const [detailsOpen, setDetailsOpen] = useState(false);
    // Auto-sync: poslední přečtené úrovně boxu (pro detekci změny při pollingu).
    const lastBoxRef = useRef<string>('');
    // Auto-sync: ID sledovaného boxu — čte se vždy tenhle, i když klikneš jinam (zruší se výběr).
    const trackedBoxRef = useRef<any>(null);
    // Status „Načteno" sám zmizí po chvíli (úspěch) — ať pruh nehlučí.
    const statusTimerRef = useRef<any>(null);
    // Risk na 1 kontrakt z posledního načtení boxu — umožňuje přepočítat risk při ruční změně kontraktů.
    const [perContractRisk, setPerContractRisk] = useState(0);
    // MFE/MAE z posledního načtení pozice (snapshot pro qty v době čtení) — uloží se do obchodu.
    const [posMetrics, setPosMetrics] = useState<{ mfeUsd: number | null; maeUsd: number | null; mfeR: number | null; maeR: number | null; mfePoints: number | null; maePoints: number | null }>({ mfeUsd: null, maeUsd: null, mfeR: null, maeR: null, mfePoints: null, maePoints: null });
    // Counterfactual "co kdyby" pro 3 SL placementy — dočasná tabulka u zápisu.
    const [cf, setCf] = useState<CounterfactualRead | null>(null);
    const [cfLoading, setCfLoading] = useState(false);
    // Override editor — uživatel doladí OTE/FVG úrovně (znají se z grafu) a přepočítá.
    const [cfEdit, setCfEdit] = useState<{ fvg: string; ote: string; swing: string }>({ fvg: '', ote: '', swing: '' });
    useEffect(() => {
        if (cf && cf.ok) setCfEdit({
            fvg: cf.fvg && cf.fvg.sl != null ? String(cf.fvg.sl) : '',
            ote: cf.ote && cf.ote.sl != null ? String(cf.ote.sl) : '',
            swing: cf.swing && cf.swing.sl != null ? String(cf.swing.sl) : '',
        });
    }, [cf]);
    const recomputeCf = () => {
        const num = (s: string) => { const n = parseFloat(s); return Number.isFinite(n) ? n : undefined; };
        setCfLoading(true);
        computeCounterfactual({ fvg: num(cfEdit.fvg), ote: num(cfEdit.ote), swing: num(cfEdit.swing) })
            .then((c) => { setCf(c || null); }).finally(() => setCfLoading(false));
    };
    // Multi-TF kontext snímky, nahrají se k obchodu při uložení.
    const [htfShots, setHtfShots] = useState<{ label: string; dataUrl: string }[]>([]);
    const [isCapturingHtf, setIsCapturingHtf] = useState(false);
    const [htfPickerOpen, setHtfPickerOpen] = useState(false);
    // Layout grafu (split screen) — kolik panelů a jejich aktuální TF.
    const [layout, setLayout] = useState<{ paneCount: number; panes: { res: string; sym: string }[] } | null>(null);
    // Které TF snímat per panel: htfPaneTfs[paneIdx] = seznam TF, které ten panel projede.
    // Pohledy = zip přes panely (kratší seznam se dopdoplní poslední hodnotou). Persistuje.
    const [htfPaneTfs, setHtfPaneTfs] = useState<string[][]>([['60', '240']]);
    const defaultPaneTfs = (count: number): string[][] => {
        if (count >= 2) return [['30', '60'], ['60', '240']].slice(0, count).concat(Array(Math.max(0, count - 2)).fill(['60', '240']));
        return [['60', '240']];
    };
    // Načti layout + uloženou konfiguraci TF (klíčováno počtem panelů) při otevření pickeru.
    const loadLayoutAndTfs = async () => {
        const r = await getChartLayout();
        const count = r.ok && r.paneCount ? r.paneCount : 1;
        setLayout(r.ok ? { paneCount: count, panes: r.panes || [] } : { paneCount: 1, panes: [] });
        try {
            chrome.storage?.local?.get(['ab_htf_panetfs'], (s: any) => {
                const stored = s?.ab_htf_panetfs;
                if (Array.isArray(stored) && stored.length === count && stored.every((a: any) => Array.isArray(a))) setHtfPaneTfs(stored);
                else setHtfPaneTfs(defaultPaneTfs(count));
            });
        } catch { setHtfPaneTfs(defaultPaneTfs(count)); }
    };
    const toggleHtfTf = (paneIdx: number, res: string) => {
        setHtfPaneTfs(prev => {
            const next = prev.map((list, i) => {
                if (i !== paneIdx) return list;
                return list.includes(res) ? list.filter(x => x !== res) : [...list, res];
            });
            try { chrome.storage?.local?.set({ ab_htf_panetfs: next }); } catch { /* ignore */ }
            return next;
        });
    };
    // Sestaví "pohledy" (frames) zip přes panely; kratší seznam doplní poslední hodnotou.
    const buildFrames = (paneTfs: string[][]): string[][] => {
        const maxLen = Math.max(1, ...paneTfs.map(a => a.length));
        const frames: string[][] = [];
        for (let f = 0; f < maxLen; f++) {
            frames.push(paneTfs.map(list => list.length ? (list[f] !== undefined ? list[f] : list[list.length - 1]) : ''));
        }
        return frames;
    };
    // Drž ref galerie aktuální (pro navigaci šipkami v lightboxu).
    galleryUrlsRef.current = [...(previewUrl ? [previewUrl] : []), ...htfShots.map(s => s.dataUrl)];
    const handleContractsChange = (val: string) => {
        setTrade(prev => {
            const n = parseFloat(val) || 0;
            const next = { ...prev, contracts: val };
            if (perContractRisk > 0 && n > 0) next.risk = String(Math.round(n * perContractRisk));
            return next;
        });
    };
    const handleReadPosition = async () => {
        if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
        setPosReadStatus({ text: 'Čtu pozici z grafu…', type: 'info' });
        const r = await readActivePosition(trackedBoxRef.current);
        if (!r.ok) {
            // Sledovaný box zmizel → odemkni, ať se příště zamkne na aktuální výběr.
            if (r.reason === 'box-gone') trackedBoxRef.current = null;
            setPosReadStatus({ text: `Pozice nenačtena: ${r.reason || 'neznámá chyba'}`, type: 'error' });
            return;
        }
        trackedBoxRef.current = r.boxId ?? trackedBoxRef.current; // zamkni na přečtený box (stabilní i po kliknutí jinam)
        lastBoxRef.current = `${r.entry}|${r.sl}|${r.tp}|${r.direction === 'LONG'}`; // auto-sync: zapamatuj stav boxu
        // Unix sekundy → lokální datum/čas (sessions jsou definované v lokálním čase).
        const pad = (n: number) => String(n).padStart(2, '0');
        const toParts = (unixSec?: number | null) => {
            if (unixSec == null) return null;
            const dt = new Date(unixSec * 1000);
            return {
                date: `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`,
                time: `${pad(dt.getHours())}:${pad(dt.getMinutes())}`,
                minutes: dt.getHours() * 60 + dt.getMinutes(),
            };
        };
        const entryP = toParts(r.entryTime);
        // Auto-výsledek: přesný exit z barů (první zásah SL/TP) má přednost před pravým okrajem boxu.
        const autoExitP = toParts(r.autoExitTime);
        const exitP = autoExitP || toParts(r.exitTime);
        const session = entryP ? detectBestSession(options.sessions, entryP.minutes) : undefined;
        setPerContractRisk(r.perContractRisk || 0);
        setPosMetrics({
            mfeUsd: r.mfeUsd ?? null, maeUsd: r.maeUsd ?? null,
            mfeR: r.mfeR ?? null, maeR: r.maeR ?? null,
            mfePoints: r.mfePoints ?? null, maePoints: r.maePoints ?? null,
        });

        setTrade(prev => ({
            ...prev,
            symbol: r.symbol || prev.symbol,
            direction: r.direction || prev.direction,
            entry: r.entry != null ? String(r.entry) : prev.entry,
            sl: r.sl != null ? String(r.sl) : prev.sl,
            tp: r.tp != null ? String(r.tp) : prev.tp,
            risk: r.riskActual != null ? String(r.riskActual) : (r.risk != null ? String(Math.round(r.risk)) : prev.risk),
            contracts: r.qty != null ? String(r.qty) : prev.contracts,
            entryDate: entryP ? entryP.date : prev.entryDate,
            exitDate: exitP ? exitP.date : (entryP ? entryP.date : prev.exitDate),
            entryTime: entryP ? entryP.time : prev.entryTime,
            exitTime: exitP ? exitP.time : (entryP ? entryP.time : prev.exitTime),
            session: session || prev.session,
            // Auto-detekovaný výsledek z grafu (co se trefilo první). Uživatel může přepsat.
            outcome: r.autoOutcome ? (r.autoOutcome as 'WIN' | 'LOSS') : prev.outcome,
        }));
        // Slim potvrzení — detaily (risk/RR/MFE/MAE) jsou už v kartě. Jen upozornění na nejednoznačný bar.
        const warnTxt = r.autoAmbiguous ? ' · ⚠️ SL i TP v 1 baru' : '';
        setPosReadStatus({ text: `✓ Načteno${warnTxt}`, type: 'success' });
        // Úspěch sám zmizí po 2.5s (varování necháme déle). Chyby/info zůstávají.
        if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
        statusTimerRef.current = setTimeout(() => setPosReadStatus(null), r.autoAmbiguous ? 6000 : 2500);

        // Counterfactual "co kdyby" + auto-detekce execution tagů (SL placement / Target) z grafu.
        setCf(null);
        setCfLoading(true);
        computeCounterfactual(undefined, trackedBoxRef.current, FLAT_BY_MIN).then((c) => {
            setCf(c || null);
            if (c && c.ok && r.entry != null && r.sl != null && r.tp != null) {
                const det = detectExecTags(r.entry, r.sl, r.tp, c);
                const slTag = EXEC_SL_TAGS[det.slPlacement]; // 'SL Swing' atd. (undefined pro 'other'/'')
                // TP tagy z konfluence (může být víc levelů na stejném místě, např. "TP deviace +2" + "TP PDH").
                const tpTags = Array.from(new Set((det.targetLevels.length ? det.targetLevels : (det.targetLevel ? [det.targetLevel] : []))
                    .map(tpTagFromLevel).filter((x): x is string => !!x)));
                const entryTags = entryTagsFromMap(c.entryMap); // 'CHoCH 1.' / 'Odraz dHigh' / 'Entry FVG'
                setTrade(prev => {
                    let ltf = prev.ltfConfluence.filter(t => !ALL_SL_TAGS.includes(t) && !isTpTag(t) && !isEntryTag(t)); // odeber staré exec/entry tagy
                    if (slTag) ltf = [...ltf, slTag];
                    if (tpTags.length) ltf = [...ltf, ...tpTags];
                    if (entryTags.length) ltf = [...ltf, ...entryTags];
                    return { ...prev, slPlacement: det.slPlacement, targetType: det.targetType, targetLevel: det.targetLevel, ltfConfluence: ltf };
                });
            }
        }).finally(() => setCfLoading(false));
    };

    // Načti existující session pro daný účet+datum+blok (ať vidíš dřív napsané pre/post).
    useEffect(() => {
        if (mode !== 'backtest') return;
        const accId = selectedAccounts[0];
        if (!accId || !trade.entryDate || !trade.session) { setBtSession({ bias: '', preNotes: '', postNotes: '' }); return; }
        let cancelled = false;
        (async () => {
            const { data } = await supabase
                .from('backtest_sessions')
                .select('data')
                .eq('account_id', accId)
                .eq('date', trade.entryDate)
                .eq('block', trade.session)
                .maybeSingle();
            if (cancelled) return;
            const d = (data as any)?.data;
            setBtSession(d ? { bias: d.bias || '', preNotes: d.preNotes || '', postNotes: d.postNotes || '' } : { bias: '', preNotes: '', postNotes: '' });
        })();
        return () => { cancelled = true; };
    }, [mode, selectedAccounts, trade.entryDate, trade.session]);

    const saveSession = async () => {
        if (!selectedAccounts.length) { setSessionStatus({ text: 'Vyber backtest účet', type: 'error' }); return; }
        if (!trade.entryDate || !trade.session) { setSessionStatus({ text: 'Chybí datum nebo blok (načti pozici z grafu)', type: 'error' }); return; }
        setSessionStatus({ text: 'Ukládám session…', type: 'info' });
        const { data: { session: authSess } } = await supabase.auth.getSession();
        if (!authSess) { setSessionStatus({ text: 'Nepřihlášen', type: 'error' }); return; }
        const rows = selectedAccounts.map(accId => ({
            user_id: authSess.user.id,
            account_id: accId,
            date: trade.entryDate,
            block: trade.session,
            data: { bias: btSession.bias, preNotes: btSession.preNotes, postNotes: btSession.postNotes },
            updated_at: new Date().toISOString(),
        }));
        const { error } = await supabase.from('backtest_sessions').upsert(rows, { onConflict: 'account_id,date,block' });
        if (error) { setSessionStatus({ text: `Chyba: ${error.message}`, type: 'error' }); return; }
        setSessionStatus({ text: `Session uložena · ${trade.session} ${trade.entryDate}`, type: 'success' });
    };

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
            // Nejdřív čistý chart snapshot (TradingView clientSnapshot) — žádný crop.
            const snap = await captureChartSnapshot();
            if (snap.ok && snap.dataUrl) {
                setPreviewUrl(snap.dataUrl);
                setSubmitStatus(null);
                setIsPreviewing(false);
                return;
            }

            // Fallback: starý způsob (foť celou stránku + ořež chart area).
            console.warn('[AlphaBridge] preview clientSnapshot selhal, fallback:', snap.reason);
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

    // Auto-load: rodič (klik na logo s pozicí na grafu) zvýší autoLoadSignal → přečti pozici + udělej screen.
    useEffect(() => {
        if (autoLoadSignal <= 0) return;
        setDetailsOpen(false); // čistý sbalený summary při otevření z loga
        trackedBoxRef.current = null; // klik na logo = zamkni se nově na aktuálně vybraný box
        (async () => {
            await handleReadPosition();
            await handlePreview();
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoLoadSignal]);

    // Auto-sync: když je panel aktivní, lehce hlídej box; po úpravě (debounce) sám přepíše pozici.
    useEffect(() => {
        if (!active) return;
        let cancelled = false;
        let debounce: any = null;
        const poll = async () => {
            const b = await readBoxLevels(trackedBoxRef.current);
            if (cancelled || !b.ok) {
                // Sledovaný box smazán → odemkni, aby se další poll mohl chytit na nový/vybraný box.
                if (b.boxGone) { trackedBoxRef.current = null; lastBoxRef.current = ''; }
                return;
            }
            const key = `${b.entry}|${b.sl}|${b.tp}|${b.isLong}`;
            if (key !== lastBoxRef.current) {
                lastBoxRef.current = key; // hned ulož, ať se neretriggeruje při dalším pollu
                if (debounce) clearTimeout(debounce);
                debounce = setTimeout(() => { if (!cancelled) handleReadPosition(); }, 450);
            }
        };
        const interval = setInterval(poll, 600);
        return () => { cancelled = true; clearInterval(interval); if (debounce) clearTimeout(debounce); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active]);

    // Multi-TF kontext: přepne panely na vybrané TF, vyrámuje na obchod, snímne layout, vrátí zpět.
    const tfLabel = (r: string) => ({ '1': '1m', '5': '5m', '15': '15m', '30': '30m', '60': '1H', '240': '4H', 'D': 'D', 'W': 'W' } as Record<string, string>)[r] || r;
    // Label pohledu: pro split spoj TF panelů (30m · 1H), pro single jen jeden TF.
    const frameLabel = (frame: string[]) => frame.filter(Boolean).map(tfLabel).join(' · ');
    const handleCaptureHtf = async () => {
        const frames = buildFrames(htfPaneTfs).filter(f => f.some(Boolean));
        if (!frames.length) { setSubmitStatus({ text: 'Vyber aspoň jeden TF (⚙ u ikony vrstev).', type: 'error' }); return; }
        setIsCapturingHtf(true);
        setSubmitStatus({ text: "🔭 Snímám kontext (graf chvíli probliká)...", type: 'info' });
        try {
            const res = await captureMultiTF(frames);
            if (!res.ok || !res.shots || !res.shots.length) {
                setSubmitStatus({ text: `Kontext nenačten: ${res.reason || 'žádné snímky'}`, type: 'error' });
                setIsCapturingHtf(false);
                return;
            }
            setHtfShots(res.shots.map(s => ({ label: frameLabel(s.frame), dataUrl: s.dataUrl })));
            const labels = res.shots.map(s => frameLabel(s.frame)).join(' + ');
            setSubmitStatus({ text: `Kontext zachycen: ${labels}`, type: 'success' });
        } catch (err: any) {
            setSubmitStatus({ text: err.message || 'Chyba', type: 'error' });
        } finally {
            setIsCapturingHtf(false);
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

            // 2. Screenshot — nejdřív zkus čistý chart snapshot přes TradingView API
            //    (clientSnapshot → retina canvas, žádný crop, žádný Chrome rate-limit).
            setSubmitStatus({ text: "📸 Snímám graf...", type: 'info' });
            let croppedImageUrl: string;
            const snap = await captureChartSnapshot();

            if (snap.ok && snap.dataUrl) {
                if (host) host.style.display = 'block';
                croppedImageUrl = snap.dataUrl; // čistý graf vč. RR boxu, bez ořezu
            } else {
                // Fallback: starý způsob (captureVisibleTab + crop chart area).
                console.warn('[AlphaBridge] clientSnapshot selhal, fallback na captureVisibleTab:', snap.reason);
                await new Promise(resolve => setTimeout(resolve, 800));
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

                setSubmitStatus({ text: "✂️ Ořezávám graf...", type: 'info' });
                const chartArea = resolveChartArea();
                const rect = chartArea
                    ? chartArea.getBoundingClientRect()
                    : new DOMRect(0, 0, window.innerWidth, window.innerHeight);

                croppedImageUrl = await cropImage(response.dataUrl, rect);
            }

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

            // Calculate exit price based on pnl if manually entered, otherwise default to tp/sl/entry
            let calculatedExitPrice = trade.outcome === 'WIN' ? tp : trade.outcome === 'LOSS' ? sl : entry;
            if (entry && sl && trade.pnl && risk && !isNaN(pnl)) {
                const directionSign = trade.direction === 'SHORT' ? -1 : 1;
                const riskMove = Math.abs(entry - sl);
                if (riskMove > 0) {
                    calculatedExitPrice = entry + directionSign * (pnl / risk) * riskMove;
                }
            }

            const baseDateStr = trade.entryDate || new Date().toISOString().split('T')[0];
            const baseTimeStr = trade.entryTime || new Date().toTimeString().split(' ')[0].slice(0, 5);
            // Konvence appky: `date` / `timestamp` = EXIT time (close trade), entry je oddělené.
            // Detail modal pak vypočítá `tradeEntryTime = exitTime - durationMinutes*60000`
            // (nebo použije explicitní `entryTime` field).
            let finalDateIso  = new Date().toISOString();
            let finalTimestamp = Date.now();
            let entryTimestamp: number | null = null;
            let entryDateIso: string | null = null;
            let durationString = "0 m";
            let durationMinutesNum = 0;

            try {
                const parsedEntry = new Date(`${baseDateStr}T${baseTimeStr}:00`);
                const parsedExit  = new Date(`${trade.exitDate || baseDateStr}T${trade.exitTime || baseTimeStr}:00`);

                if (!isNaN(parsedEntry.getTime())) {
                    entryTimestamp = parsedEntry.getTime();
                    entryDateIso = parsedEntry.toISOString();
                }

                if (!isNaN(parsedExit.getTime())) {
                    // Trade.date / timestamp = EXIT time, ne entry
                    finalDateIso = parsedExit.toISOString();
                    finalTimestamp = parsedExit.getTime();
                }

                if (!isNaN(parsedEntry.getTime()) && !isNaN(parsedExit.getTime())) {
                    const diffMs = parsedExit.getTime() - parsedEntry.getTime();
                    if (diffMs > 0) {
                        durationMinutesNum = diffMs / 60000;
                        const h = Math.floor(diffMs / 3600000);
                        const m = Math.floor((diffMs % 3600000) / 60000);
                        durationString = h > 0 ? `${h}h ${m}m` : `${m} m`;
                    }
                }
            } catch { /* fallback */ }

            const finalInstrument = mapInstrument(trade.symbol || "Unknown");
            const finalSignal     = trade.signal || "Alpha Bridge v2";

            // 5. Upload screenshotů (entry + HTF kontext)
            // Helper: dataURL → storage → public URL. JPEG i PNG dle prefixu.
            const uploadDataUrl = async (dataUrl: string): Promise<string | null> => {
                const isJpeg = /^data:image\/jpe?g/i.test(dataUrl);
                const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, "");
                const binary = atob(base64Data);
                const buffer = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) buffer[i] = binary.charCodeAt(i);
                const ext = isJpeg ? 'jpg' : 'png';
                const fileName = `ext_${Date.now()}_${Math.floor(Math.random() * 100000)}.${ext}`;
                const { error: upErr } = await supabase.storage
                    .from('trade-images')
                    .upload(fileName, buffer, { contentType: isJpeg ? 'image/jpeg' : 'image/png' });
                if (upErr) throw new Error("Nepodařilo se nahrát screenshot: " + upErr.message);
                const { data: urlData } = supabase.storage.from('trade-images').getPublicUrl(fileName);
                return urlData?.publicUrl ?? null;
            };

            let publicUrl: string | null = null;
            const htfUrls: string[] = [];
            if (croppedImageUrl) {
                setSubmitStatus({ text: "☁️ Nahrávám screenshot...", type: 'info' });
                publicUrl = await uploadDataUrl(croppedImageUrl);
            }
            // HTF kontext snímky (1H, 4H) — nahraj a přidej do galerie obchodu.
            if (htfShots.length) {
                setSubmitStatus({ text: `☁️ Nahrávám HTF kontext (${htfShots.length})...`, type: 'info' });
                for (const s of htfShots) {
                    const u = await uploadDataUrl(s.dataUrl);
                    if (u) htfUrls.push(u);
                }
            }
            const allScreenshots = [publicUrl, ...htfUrls].filter((u): u is string => !!u);

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
                    exitPrice: calculatedExitPrice,
                    stopLoss: sl,
                    takeProfit: tp,
                    riskAmount: risk,
                    screenshot: publicUrl,
                    screenshots: allScreenshots,  // entry + HTF kontext (1H/4H)
                    duration: durationString,
                    durationMinutes: durationMinutesNum,
                    entryTime: entryTimestamp,
                    entryDate: entryDateIso,
                    exitDate: finalDateIso,
                    status: 'CLOSED',
                    outcome: trade.outcome,
                    groupId: commonGroupId,
                    isMaster,
                    masterTradeId: isMaster ? null : masterTradeId,
                    session: trade.session,
                    phase,
                    executionStatus: trade.executionStatus,
                    isValid: trade.executionStatus === 'Valid',
                    signal: finalSignal,
                    htfConfluence: trade.htfConfluence,
                    ltfConfluence: trade.ltfConfluence,
                    emotions: trade.emotions,
                    mistakes: trade.mistakes,
                    notes: trade.notes,
                    // MFE/MAE z grafu (max favorable/adverse excursion). runUp/drawdown = $ pro analytiku exekuce.
                    runUp: posMetrics.mfeUsd != null ? posMetrics.mfeUsd : 0,
                    drawdown: posMetrics.maeUsd != null ? posMetrics.maeUsd : 0,
                    mfeR: posMetrics.mfeR,
                    maeR: posMetrics.maeR,
                    mfePoints: posMetrics.mfePoints,
                    maePoints: posMetrics.maePoints,
                    excursionAvailable: posMetrics.mfeUsd != null,  // false = MFE/MAE se nepodařilo načíst (ne 0)
                    // Execution varianty — SL i Target odvozeny z reálně označených LTF tagů (source of truth).
                    slPlacement: slKeyFromTags(trade.ltfConfluence),
                    targetType: tpInfoFromTag(trade.ltfConfluence).targetType,
                    targetLevel: tpInfoFromTag(trade.ltfConfluence).targetLevel,
                    // Counterfactual "co kdyby" pro 3 SL placementy (FVG/OTE/swing) — pro porovnávací analytiku.
                    counterfactual: cf && cf.ok
                        ? { available: true, isLong: cf.isLong, entry: cf.entry, tp: cf.tp, swing: cf.swing, ote: cf.ote, fvg: cf.fvg, tpTargets: cf.tpTargets }
                        : { available: false, reason: (cf && cf.reason) || 'no-data' },
                    // Excursion "kam by to došlo do konce dne" — level ceiling + level ladder + klasický trailing.
                    excursion: cf && cf.ok && cf.excursion ? cf.excursion : { available: false },
                    // Entry model — odraz level + struktura (kolikátý zlom) + entry na hraně FVG.
                    entryMap: cf && cf.ok && cf.entryMap ? cf.entryMap : { available: false },
                    // Session kontext (backtest) — otisknuto do obchodu, ať je samostatný pro analýzu.
                    sessionBias: mode === 'backtest' ? (btSession.bias || null) : null,
                    sessionPreNotes: mode === 'backtest' ? (btSession.preNotes || null) : null,
                    sessionPostNotes: mode === 'backtest' ? (btSession.postNotes || null) : null,
                    // Držel ses biasu? null = bias nezadán / Neutral (nelze posoudit).
                    biasAligned: (mode === 'backtest' && (btSession.bias === 'Long' || btSession.bias === 'Short'))
                        ? ((btSession.bias === 'Long' && trade.direction === 'LONG') || (btSession.bias === 'Short' && trade.direction === 'SHORT'))
                        : null,
                    // Meta — verze schématu a zdroj, ať AI ví, co kde čekat.
                    schemaVersion: 2,
                    source: 'alphabridge',
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

            // 8. Fire-and-forget AI enrichment — jen pokud má trade notes nebo screenshot
            // (filtr "skutečný obchod" vs. testovací záznam)
            const hasNotes = (trade.notes || '').trim().length > 0;
            const hasScreenshot = !!publicUrl;
            if (hasNotes || hasScreenshot) {
                for (const savedTrade of savedTrades) {
                    fetch(`${SUPABASE_URL}/functions/v1/enrich-trade`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${session.access_token}`,
                        },
                        body: JSON.stringify({ tradeId: savedTrade.id }),
                    }).catch(e => console.warn('[AlphaBridge] enrich-trade failed:', e));
                }
            }

        } catch (err: any) {
            console.error('[AlphaBridge]', err);
            setSubmitStatus({ text: err.message, type: 'error' });
        } finally {
            setIsSubmitting(false);
            if (host) host.style.display = 'block';
        }
    };

    // ── Execution varianty (provedení) — strukturované kategorie pro porovnání setupů ──
    // LTF Trigger options + execution tagy (SL FVG/OTE/Swing + TP úrovně) — auto-označí se po detekci.
    // Zahrnuje i aktuálně označené tagy, ať se vyrenderuje i dynamicky detekovaný level (např. TP POC).
    const ltfOptionsWithExec = useMemo(
        () => Array.from(new Set([...(options.ltf || []), ...ALL_SL_TAGS, ...ALL_TP_TAGS, ...ALL_ENTRY_TAGS, ...trade.ltfConfluence])),
        [options.ltf, trade.ltfConfluence]
    );

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
                            options={ltfOptionsWithExec}
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
                        <AccountList onSelectionChange={setSelectedAccounts} mode={mode} />

                        {/* Pozice se čte automaticky (auto-sync hlídá box) — manuální tlačítko odebráno. */}
                        {posReadStatus && (
                            <div className={`mb-2 text-[11px] font-medium px-1 ${posReadStatus.type === 'error' ? 'text-rose-500' : posReadStatus.type === 'success' ? 'text-emerald-500' : 'text-slate-400'}`}>
                                {posReadStatus.text}
                            </div>
                        )}
                        {/* Summary řádek — přehled obchodu na první pohled (po načtení / vyplnění) */}
                        {(() => {
                            const e = Number(trade.entry), s = Number(trade.sl), tpv = Number(trade.tp);
                            if (!(e && s && tpv)) return null;
                            const rr = Math.abs(s - e) > 0 ? Math.round((Math.abs(tpv - e) / Math.abs(s - e)) * 100) / 100 : null;
                            const isLong = trade.direction === 'LONG';
                            const pnlNum = trade.pnl !== '' && trade.pnl != null ? Number(trade.pnl) : null;
                            const out = trade.outcome;
                            const dirCls = isLong
                                ? (theme === 'dark' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-emerald-100 text-emerald-700')
                                : (theme === 'dark' ? 'bg-rose-500/15 text-rose-300' : 'bg-rose-100 text-rose-700');
                            const outPill = out === 'WIN'
                                ? (theme === 'dark' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-emerald-100 text-emerald-700')
                                : out === 'LOSS'
                                    ? (theme === 'dark' ? 'bg-rose-500/15 text-rose-300' : 'bg-rose-100 text-rose-700')
                                    : (theme === 'dark' ? 'bg-slate-700/50 text-slate-300' : 'bg-slate-200 text-slate-600');
                            const dP = (trade.entryDate || '').split('-');
                            const dateShort = dP.length === 3 ? `${dP[2]}.${dP[1]}.` : (trade.entryDate || '');
                            const timeStr = trade.entryTime ? (trade.exitTime && trade.exitTime !== trade.entryTime ? `${trade.entryTime}→${trade.exitTime}` : trade.entryTime) : '';
                            const es = trade.executionStatus;
                            const esLabel = es === 'Valid' ? 'Valid' : es === 'Invalid' ? 'Invalid' : 'Missed';
                            const esPill = es === 'Valid'
                                ? (theme === 'dark' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-emerald-100 text-emerald-700')
                                : es === 'Invalid'
                                    ? (theme === 'dark' ? 'bg-rose-500/15 text-rose-300' : 'bg-rose-100 text-rose-700')
                                    : (theme === 'dark' ? 'bg-blue-500/15 text-blue-300' : 'bg-blue-100 text-blue-700');
                            const muted = theme === 'dark' ? 'text-slate-100' : 'text-slate-800';
                            return (
                                <button
                                    type="button"
                                    onClick={() => setDetailsOpen(o => !o)}
                                    title={detailsOpen ? 'Sbalit detaily' : 'Rozbalit detaily'}
                                    className={`w-full mb-3 flex flex-col gap-1.5 px-3 py-2.5 rounded-xl border overflow-hidden transition-all ${theme === 'dark' ? 'bg-slate-800/60 border-slate-700/50 hover:border-slate-600' : 'bg-white border-slate-200 shadow-sm hover:border-slate-300'}`}
                                >
                                    <div className="flex items-center gap-1.5 w-full">
                                        <span className={`inline-flex items-center gap-1 text-[11px] font-black px-2 py-1 rounded-lg shrink-0 ${dirCls}`}>
                                            {isLong ? <TrendingUp size={13} /> : <TrendingDown size={13} />}{isLong ? 'LONG' : 'SHORT'}
                                        </span>
                                        <span className={`text-[11px] font-bold tracking-wide truncate min-w-0 ${muted}`}>{trade.symbol}</span>
                                        {rr != null && (
                                            <span className={`text-[15px] font-black tabular-nums leading-none ml-auto shrink-0 ${theme === 'dark' ? 'text-slate-100' : 'text-slate-800'}`}>{rr}<span className="text-[10px] opacity-60">R</span></span>
                                        )}
                                        {out && <span className={`text-[10px] font-black px-2 py-1 rounded-md shrink-0 ${outPill}`}>{out}</span>}
                                        {pnlNum != null && <span className={`text-[13px] font-black tabular-nums leading-none shrink-0 ${pnlNum > 0 ? 'text-emerald-500' : pnlNum < 0 ? 'text-rose-500' : (theme === 'dark' ? 'text-slate-300' : 'text-slate-600')}`}>{pnlNum > 0 ? '+' : ''}${Math.round(pnlNum).toLocaleString('en-US')}</span>}
                                        <span className={`text-[11px] shrink-0 transition-transform ${detailsOpen ? 'rotate-180' : ''} ${theme === 'dark' ? 'text-slate-500' : 'text-slate-400'}`}>▾</span>
                                    </div>
                                    <div className={`flex items-center gap-1.5 w-full text-[10px] font-bold ${muted}`}>
                                        {dateShort && <span className="tabular-nums">{dateShort}</span>}
                                        {timeStr && <><span className="opacity-40">·</span><span className="tabular-nums">{timeStr}</span></>}
                                        {trade.session && <><span className="opacity-40">·</span><span className="truncate">{trade.session}</span></>}
                                        {es && <span className={`text-[9px] font-black px-1.5 py-0.5 rounded-md ml-auto shrink-0 ${esPill}`}>{esLabel}</span>}
                                    </div>
                                    {/* Excursion proužek — entry uprostřed. Vlevo červeně MAE heat (vůči 1R).
                                        Vpravo zeleně "kam by to došlo do konce dne" + tečky levelů (✓/✗) + značka TP a trailingu. */}
                                    {(() => {
                                        const exc = cf && cf.ok && cf.excursion && cf.excursion.available ? cf.excursion : null;
                                        const maeR = posMetrics.maeR != null ? Math.abs(posMetrics.maeR) : null;
                                        const mae = Math.abs(posMetrics.maeUsd || 0);
                                        if (!exc && posMetrics.mfeUsd == null) return null;
                                        const redFrac = maeR != null ? Math.min(maeR, 1) : 0;
                                        const hitSL = redFrac >= 0.999 || (exc != null && exc.stopReason === 'sl');

                                        // Fallback (bez levelů/boxu): původní realized MFE/MAE proužek.
                                        if (!exc) {
                                            const mfe = posMetrics.mfeUsd || 0; const mfeR = posMetrics.mfeR;
                                            const greenFrac = (mfeR != null && rr) ? Math.min(mfeR / rr, 1) : (mfe / Math.max(mae, mfe, 1));
                                            return (
                                                <div className="w-full pt-1 mt-0.5 border-t border-dashed border-current/10">
                                                    <div className="flex items-center justify-between text-[9px] font-bold mb-1 leading-none">
                                                        <span className="text-rose-500 tabular-nums">{maeR != null ? `−${maeR}R` : `−$${mae.toLocaleString('en-US')}`}</span>
                                                        <span className={`text-[8px] font-black uppercase tracking-wider opacity-40 ${muted}`}>MAE ◂ entry ▸ MFE</span>
                                                        <span className="text-emerald-500 tabular-nums">{mfeR != null ? `+${mfeR}R` : `+$${mfe.toLocaleString('en-US')}`}</span>
                                                    </div>
                                                    <div className={`relative h-1.5 rounded-full ${theme === 'dark' ? 'bg-slate-700/40' : 'bg-slate-200'}`}>
                                                        <div className="absolute top-0 bottom-0 rounded-l-full bg-rose-500/70" style={{ right: '50%', width: `${redFrac * 50}%` }} />
                                                        <div className="absolute top-0 bottom-0 rounded-r-full bg-emerald-500/70" style={{ left: '50%', width: `${greenFrac * 50}%` }} />
                                                        <div className={`absolute -top-0.5 -bottom-0.5 left-1/2 w-px -translate-x-1/2 ${theme === 'dark' ? 'bg-slate-300' : 'bg-slate-500'}`} />
                                                    </div>
                                                </div>
                                            );
                                        }

                                        const tpR = exc.tpR != null ? exc.tpR : (rr || 0);
                                        const ceilR = exc.mfePotentialR;
                                        const trailR = exc.trail ? exc.trail.exitR : null;
                                        const levels = exc.levels || [];
                                        const rightVals = [tpR, ceilR, trailR, ...levels.map(l => l.r)].filter((v): v is number => v != null && v > 0);
                                        const rightMax = Math.max(...rightVals, 1);
                                        const pos = (r: number) => 50 + Math.min(Math.max(r, 0) / rightMax, 1) * 50; // % zleva
                                        const greenW = ceilR != null ? Math.min(ceilR / rightMax, 1) * 50 : 0;
                                        const tickDark = theme === 'dark' ? 'bg-white/70' : 'bg-slate-900/60';
                                        const dotMiss = theme === 'dark' ? 'bg-slate-600 border-slate-500' : 'bg-slate-300 border-slate-400';
                                        return (
                                            <div className="w-full pt-1 mt-0.5 border-t border-dashed border-current/10">
                                                <div className="flex items-center justify-between text-[9px] font-bold mb-1.5 leading-none">
                                                    <span className="text-rose-500 tabular-nums">{maeR != null ? `−${maeR}R` : '—'}</span>
                                                    <span className={`text-[8px] font-black uppercase tracking-wider opacity-40 ${muted}`}>heat ◂ entry ▸ strop</span>
                                                    <span className="text-emerald-500 tabular-nums">{ceilR != null ? `+${ceilR}R` : '—'}{exc.topReached ? ` ${exc.topReached.label}` : ''}</span>
                                                </div>
                                                <div className={`relative h-1.5 rounded-full ${theme === 'dark' ? 'bg-slate-700/40' : 'bg-slate-200'}`}>
                                                    <div className={`absolute -top-0.5 -bottom-0.5 left-0 w-px ${hitSL ? 'bg-rose-500' : 'bg-rose-500/30'}`} />
                                                    <div className="absolute top-0 bottom-0 rounded-l-full bg-rose-500/70" style={{ right: '50%', width: `${redFrac * 50}%` }} />
                                                    <div className="absolute top-0 bottom-0 rounded-r-full bg-emerald-500/70" style={{ left: '50%', width: `${greenW}%` }} />
                                                    <div className={`absolute -top-0.5 -bottom-0.5 left-1/2 w-px -translate-x-1/2 ${theme === 'dark' ? 'bg-slate-300' : 'bg-slate-500'}`} />
                                                    {tpR > 0 && <div className={`absolute -top-1 -bottom-1 w-px -translate-x-1/2 ${tickDark}`} style={{ left: `${pos(tpR)}%` }} title={`TP +${tpR}R`} />}
                                                    {trailR != null && trailR > 0 && <div className="absolute -top-1 -bottom-1 w-0.5 -translate-x-1/2 bg-amber-500" style={{ left: `${pos(trailR)}%` }} title={`trailing +${trailR}R`} />}
                                                    {levels.map((l, idx) => l.r > 0 ? (
                                                        <div key={idx} className={`absolute top-1/2 w-1.5 h-1.5 rounded-full -translate-x-1/2 -translate-y-1/2 border ${l.reached ? 'bg-emerald-400 border-emerald-600' : dotMiss}`} style={{ left: `${pos(l.r)}%` }} title={`${l.label} +${l.r}R ${l.reached ? '✓' : '✗'}`} />
                                                    ) : null)}
                                                </div>
                                                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[9px] font-bold mt-1.5 leading-none">
                                                    {exc.topReached && <span className="text-emerald-500">strop +{exc.topReached.r}R · {exc.topReached.label}</span>}
                                                    <span className={`opacity-70 ${muted}`}>TP +{tpR}R</span>
                                                    {trailR != null && <span className="text-amber-500">✂ trail +{trailR}R</span>}
                                                    {exc.leftOnTableR != null && <span className={exc.leftOnTableR > 0 ? 'text-emerald-500' : `opacity-60 ${muted}`}>na stole {exc.leftOnTableR > 0 ? '+' : ''}{exc.leftOnTableR}R</span>}
                                                    {exc.stopReason === 'sl' && <span className="text-rose-500">↘ cesta brala SL</span>}
                                                    {exc.levelsContemporary === false && <span className="text-amber-500">⚠ levely mimo den</span>}
                                                </div>
                                            </div>
                                        );
                                    })()}
                                </button>
                            );
                        })()}

                        {/* Backtest session (pre/post) — jen v backtest módu */}
                        {mode === 'backtest' && (
                            <div className={`mb-4 p-3 rounded-xl border ${theme === 'dark' ? 'bg-violet-500/5 border-violet-500/20' : 'bg-violet-50 border-violet-200'}`}>
                                <div className="flex items-center justify-between mb-2">
                                    <span className={`text-[10px] font-black uppercase tracking-wider ${theme === 'dark' ? 'text-violet-300' : 'text-violet-700'}`}>🧪 Session {trade.session ? `· ${trade.session}` : ''} {trade.entryDate ? `· ${trade.entryDate}` : ''}</span>
                                </div>

                                {/* Bias toggle */}
                                <div className="flex gap-1.5 mb-2">
                                    {(['Long', 'Neutral', 'Short'] as const).map(b => {
                                        const active = btSession.bias === b;
                                        const cls = active
                                            ? (b === 'Long' ? 'bg-emerald-600 text-white' : b === 'Short' ? 'bg-rose-600 text-white' : 'bg-slate-500 text-white')
                                            : (theme === 'dark' ? 'bg-white/5 text-slate-400' : 'bg-white text-slate-500 border border-slate-200');
                                        return (
                                            <button key={b} type="button" onClick={() => setBtSession(s => ({ ...s, bias: active ? '' : b }))}
                                                className={`flex-1 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-wider transition-all ${cls}`}>
                                                {b === 'Long' ? 'Long ↑' : b === 'Short' ? 'Short ↓' : 'Neutral'}
                                            </button>
                                        );
                                    })}
                                </div>

                                <TextArea label="Pre — na co koukám" value={btSession.preNotes} onChange={(v: string) => setBtSession(s => ({ ...s, preNotes: v }))} rows={2} placeholder="Bias + na co dnes čekám…" />
                                <TextArea label="Post — čeho jsem si všiml / co doladit" value={btSession.postNotes} onChange={(v: string) => setBtSession(s => ({ ...s, postNotes: v }))} rows={2} placeholder="Co fungovalo, co příště jinak…" />

                                <button type="button" onClick={saveSession}
                                    className="w-full mt-1 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-[11px] font-black uppercase tracking-wider transition-all active:scale-95">
                                    Uložit session
                                </button>
                                {sessionStatus && (
                                    <div className={`mt-1.5 text-[11px] font-medium px-1 ${sessionStatus.type === 'error' ? 'text-rose-500' : sessionStatus.type === 'success' ? 'text-emerald-500' : 'text-slate-400'}`}>
                                        {sessionStatus.text}
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Detailní pole — animovaně se sbalí do summary headeru (rozbalí klikem). Před načtením vždy viditelná. */}
                        <div style={{ display: 'grid', gridTemplateRows: (!(Number(trade.entry) && Number(trade.sl) && Number(trade.tp)) || detailsOpen) ? '1fr' : '0fr', transition: 'grid-template-rows 0.28s ease' }}>
                        <div style={{ overflow: 'hidden', minHeight: 0 }}>
                        {/* Level ladder — "kam by to došlo do konce dne" (ceiling + levely ✓/✗ + klasický trailing) */}
                        {cf && cf.ok && cf.excursion && cf.excursion.available && (() => {
                            const exc = cf.excursion!;
                            const fb = exc.flatByMin != null ? `${String(Math.floor(exc.flatByMin / 60)).padStart(2, '0')}:${String(exc.flatByMin % 60).padStart(2, '0')}` : '';
                            const txt = theme === 'dark' ? 'text-slate-200' : 'text-slate-700';
                            const sub = theme === 'dark' ? 'text-slate-400' : 'text-slate-500';
                            return (
                                <div className={`mb-4 p-3 rounded-xl border ${theme === 'dark' ? 'bg-slate-800/40 border-slate-700/50' : 'bg-slate-50 border-slate-200'}`}>
                                    <div className="flex items-center justify-between mb-2">
                                        <span className={`text-[10px] font-black uppercase tracking-wider ${txt}`}>Kam by to došlo{fb ? ` · do ${fb}` : ''}</span>
                                        {exc.leftOnTableR != null && <span className={`text-[10px] font-black ${exc.leftOnTableR > 0 ? 'text-emerald-500' : sub}`}>na stole {exc.leftOnTableR > 0 ? '+' : ''}{exc.leftOnTableR}R</span>}
                                    </div>
                                    <div className="flex items-center justify-between text-[11px] font-bold mb-1">
                                        <span className="text-emerald-500">⤒ strop {exc.mfePotentialR != null ? `+${exc.mfePotentialR}R` : '—'}{exc.topReached ? ` (${exc.topReached.label})` : ''}</span>
                                        <span className={sub}>TP +{exc.tpR}R</span>
                                    </div>
                                    {exc.trail && (
                                        <div className="flex items-center justify-between text-[11px] font-bold mb-1">
                                            <span className="text-amber-500">✂ klasický trailing {exc.trail.exitR != null ? `+${exc.trail.exitR}R` : '—'}</span>
                                            <span className={sub}>{exc.trail.bars != null ? `${exc.trail.bars} barů · ` : ''}{exc.trail.reason}</span>
                                        </div>
                                    )}
                                    <div className="pt-1.5 mt-1 border-t border-dashed border-current/10 space-y-0.5">
                                        {exc.levelsContemporary === false ? (
                                            <span className="text-[10px] text-amber-500 leading-snug block">⚠ Levely nejsou z doby obchodu — graf je na jiném dni (indikátor kreslí jen aktuální úrovně). Strop a „na stole" výše platí (počítané z barů). Pro správné levely otevři obchod v den, kdy proběhl (replay).</span>
                                        ) : exc.levels && exc.levels.length > 0 ? exc.levels.map((l, i) => (
                                            <div key={i} className="flex items-center justify-between text-[11px]">
                                                <span className="flex items-center gap-1.5">
                                                    <span className={l.reached ? 'text-emerald-500' : 'text-slate-400'}>{l.reached ? '✓' : '✗'}</span>
                                                    <span className={`font-bold ${txt}`}>{l.label}</span>
                                                </span>
                                                <span className="flex items-center gap-2 tabular-nums">
                                                    <span className={l.reached ? 'text-emerald-500 font-bold' : 'text-slate-400'}>+{l.r}R</span>
                                                    <span className="opacity-40 text-[9px] w-7 text-right">{l.reached && l.bars != null ? `${l.bars}b` : ''}</span>
                                                </span>
                                            </div>
                                        )) : <span className="text-[10px] opacity-40">žádné levely ve směru obchodu</span>}
                                        {exc.vwapApprox && exc.levels && exc.levels.some(l => l.dynamic) && (
                                            <span className="text-[9px] text-amber-500 leading-snug block pt-1">⚠ VWAP pásma přibližná — start session není v grafu načtený. Doscrolluj graf doleva na začátek dne (00:00) a načti pozici znovu.</span>
                                        )}
                                    </div>
                                    {exc.stopReason === 'sl' && <div className="text-[9px] text-rose-500 pt-1.5">↘ cesta cestou brala původní SL — strop omezen</div>}
                                </div>
                            );
                        })()}
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
                            <div className="flex-[0.7]"><Input label="Kontrakty" value={trade.contracts} onChange={handleContractsChange} type="number" className="mb-0" /></div>
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
                            <div className="flex-[1.35] min-w-0">
                                <Input
                                    label="Datum"
                                    value={trade.entryDate}
                                    onChange={(val) => { updateField('entryDate')(val); updateField('exitDate')(val); }}
                                    type="date"
                                    className="mb-0"
                                    inputClassName="px-2"
                                />
                            </div>
                            {/* Entry time */}
                            <div className="flex-[0.85] min-w-0 flex flex-col">
                                <label className={`block text-xs font-bold uppercase tracking-wider mb-1.5 ${theme === 'dark' ? 'text-slate-400' : 'text-slate-500'}`}>Entry</label>
                                <input
                                    type="time"
                                    value={trade.entryTime}
                                    onChange={(e) => {
                                        const v = e.target.value;
                                        // Auto-detekce session z času VSTUPU (ne z aktuálního času).
                                        setTrade(prev => {
                                            const next: any = { ...prev, entryTime: v };
                                            if (options.sessions.length > 0 && v) {
                                                const mins = timeToMinutes(v);
                                                if (!isNaN(mins)) next.session = detectBestSession(options.sessions, mins);
                                            }
                                            return next;
                                        });
                                    }}
                                    onKeyDown={(e) => e.stopPropagation()}
                                    className={`w-full border rounded-xl px-2 py-2 text-sm outline-none transition-all duration-200 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 ${theme === 'dark' ? 'bg-slate-800/80 border-slate-700/50 text-slate-100' : 'bg-white/80 border-slate-300/50 text-slate-800'}`}
                                />
                            </div>
                            {/* Exit time */}
                            <div className="flex-[0.85] min-w-0 flex flex-col">
                                <label className={`block text-xs font-bold uppercase tracking-wider mb-1.5 ${theme === 'dark' ? 'text-slate-400' : 'text-slate-500'}`}>Exit</label>
                                <input
                                    type="time"
                                    value={trade.exitTime}
                                    onChange={(e) => updateField('exitTime')(e.target.value)}
                                    onKeyDown={(e) => e.stopPropagation()}
                                    className={`w-full border rounded-xl px-2 py-2 text-sm outline-none transition-all duration-200 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 ${theme === 'dark' ? 'bg-slate-800/80 border-slate-700/50 text-slate-100' : 'bg-white/80 border-slate-300/50 text-slate-800'}`}
                                />
                            </div>
                        </div>

                        {/* Stav obchodu + Relace vedle sebe */}
                        <div className="flex gap-2 mb-4 items-start">
                            <div className="flex-1 min-w-0">
                            <label className={`block text-xs font-bold uppercase tracking-wider mb-1.5 ${theme === 'dark' ? 'text-slate-400' : 'text-slate-500'}`}>Stav obchodu</label>
                            <div className={`p-1 rounded-xl border flex gap-1 ${trade.executionStatus === 'Valid' ? (theme === 'dark' ? 'bg-emerald-900/20 border-emerald-700/40' : 'bg-emerald-50 border-emerald-200') : trade.executionStatus === 'Invalid' ? (theme === 'dark' ? 'bg-rose-900/20 border-rose-700/40' : 'bg-rose-50 border-rose-200') : (theme === 'dark' ? 'bg-blue-900/20 border-blue-700/40' : 'bg-blue-50 border-blue-200')}`}>
                                <button
                                    type="button"
                                    onClick={() => updateField('executionStatus')('Valid')}
                                    className={`flex-1 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-wider transition-all ${trade.executionStatus === 'Valid' ? 'bg-emerald-600 text-white shadow-md' : theme === 'dark' ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-700'}`}
                                >
                                    Validní
                                </button>
                                <button
                                    type="button"
                                    onClick={() => updateField('executionStatus')('Invalid')}
                                    className={`flex-1 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-wider transition-all ${trade.executionStatus === 'Invalid' ? 'bg-rose-600 text-white shadow-md' : theme === 'dark' ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-700'}`}
                                >
                                    Nevalidní
                                </button>
                                <button
                                    type="button"
                                    onClick={() => updateField('executionStatus')('Missed')}
                                    className={`flex-1 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-wider transition-all ${trade.executionStatus === 'Missed' ? 'bg-blue-600 text-white shadow-md' : theme === 'dark' ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-700'}`}
                                >
                                    Missed
                                </button>
                            </div>
                            </div>
                            <div className="shrink-0 flex flex-col" style={{ minWidth: '110px' }}>
                                {options.sessions.length > 0 ? (
                                    // User has sessions configured in app preferences — show as select
                                    <Select
                                        label="Relace"
                                        value={trade.session}
                                        onChange={updateField('session')}
                                        className="mb-0"
                                        options={[...options.sessions.map(s => ({ value: s.name, label: s.name })), { value: 'Mimo session', label: 'Mimo session' }]}
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
                        </div>
                        </div>
                        </div>
                    </div>
                </div>
            </div>

            {isWide && (
                <TextArea
                    label="Poznámky"
                    value={trade.notes}
                    onChange={updateField('notes')}
                    placeholder="Důvod vstupu, pocity..."
                    rows={2}
                    actionSlot={<VoiceMemoButton onTranscribed={appendToNotes} size="sm" title="Diktovat poznámky (CZ)" />}
                />
            )}

            {!isWide && (
                <>
                    <div className="flex gap-2 items-start">
                        <div className="flex-1 min-w-0">
                            <MultiSelect
                                label="HTF Kontext"
                                selected={trade.htfConfluence}
                                options={options.htf}
                                onToggle={toggleMultiSelect('htfConfluence')}
                                colorScheme="htf"
                            />
                        </div>
                        <div className="flex-1 min-w-0">
                            <MultiSelect
                                label="LTF Trigger"
                                selected={trade.ltfConfluence}
                                options={ltfOptionsWithExec}
                                onToggle={toggleMultiSelect('ltfConfluence')}
                                colorScheme="ltf"
                            />
                        </div>
                    </div>
                    <div className="flex gap-2 items-start">
                        <div className="flex-1 min-w-0">
                            <MultiSelect
                                label="Emoce"
                                selected={trade.emotions}
                                options={options.emotions}
                                onToggle={toggleMultiSelect('emotions')}
                                colorScheme="emotions"
                            />
                        </div>
                        <div className="flex-1 min-w-0">
                            <MultiSelect
                                label="Chyby"
                                selected={trade.mistakes}
                                options={options.mistakes}
                                onToggle={toggleMultiSelect('mistakes')}
                                colorScheme="mistakes"
                            />
                        </div>
                    </div>
                    <TextArea
                        label="Poznámky"
                        value={trade.notes}
                        onChange={updateField('notes')}
                        placeholder="Důvod vstupu, pocity..."
                        rows={2}
                        actionSlot={<VoiceMemoButton onTranscribed={appendToNotes} size="sm" title="Diktovat poznámky (CZ)" />}
                    />
                </>
            )}

            {/* Counterfactual "co kdyby" — dočasná tabulka: pro každý SL placement SL/TP + RR/$ */}
            {(cfLoading || cf) && (() => {
                const riskNum = Number(trade.risk) || 0;
                const rows: { key: string; label: string; r?: any }[] = [
                    { key: 'fvg', label: 'FVG', r: cf?.fvg },
                    { key: 'ote', label: 'OTE', r: cf?.ote },
                    { key: 'swing', label: 'Swing', r: cf?.swing },
                ];
                const tagToKey: Record<string, string> = { fvg: 'fvg', ote: 'ote', swing: 'swing' };
                const usedKey = tagToKey[trade.slPlacement] || '';
                return (
                    <div className={`mb-4 rounded-xl border overflow-hidden ${theme === 'dark' ? 'border-slate-700/50 bg-slate-800/50' : 'border-slate-200 bg-slate-50'}`}>
                        <div className={`px-3 py-2 text-[10px] font-black uppercase tracking-widest flex items-center gap-2 border-b ${theme === 'dark' ? 'text-amber-400 border-slate-700/50' : 'text-amber-600 border-slate-200'}`}>
                            🔮 Co kdyby · SL placement {cfLoading && <RefreshCw size={11} className="animate-spin" />}
                        </div>
                        {cfLoading && !cf ? (
                            <div className="px-3 py-3 text-[11px] text-slate-400">Počítám 3 varianty z barů…</div>
                        ) : (cf && !cf.ok) ? (
                            <div className="px-3 py-3 text-[11px] text-slate-400">
                                {cf.reason === 'entry-mimo-graf'
                                    ? 'Entry je mimo načtený graf — posuň/zoomni graf tak, aby byl entry candle vidět, a načti pozici znovu.'
                                    : `Nešlo spočítat: ${cf.reason || 'neznámý důvod'}`}
                            </div>
                        ) : (
                            <table className="w-full text-[11px]">
                                <thead>
                                    <tr className={`${theme === 'dark' ? 'text-slate-500' : 'text-slate-400'} text-[9px] uppercase tracking-wider`}>
                                        <th className="text-left font-bold px-3 py-1">SL @</th>
                                        <th className="text-right font-bold px-1 py-1">Cena</th>
                                        <th className="text-right font-bold px-2 py-1">Fixní TP</th>
                                        <th className="text-right font-bold px-3 py-1">Trailing</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {rows.map(({ key, label, r }) => {
                                        const has = r && r.ok && r.valid !== false;
                                        const tr = has ? r.trail : null;
                                        const unit = riskNum ? '' : 'R';
                                        const toVal = (rR?: number | null) => rR == null ? null : (riskNum ? Math.round(rR * riskNum) : rR);
                                        const fixV = has ? toVal(r.realizedR) : null;
                                        const trV = tr ? toVal(tr.realizedR) : null;
                                        const fixEmo = !has ? '' : r.outcome === 'WIN' ? '✅' : r.outcome === 'LOSS' ? '❌' : '⏳';
                                        const trEmo = !tr ? '' : tr.reason === 'tp' ? '✅' : (tr.reason === 'trail+' || tr.reason === 'trail') ? '🪜' : '⏳';
                                        const vCls = (v: number | null) => v == null ? 'text-slate-400' : v > 0 ? 'text-emerald-500' : v < 0 ? 'text-red-500' : '';
                                        const fmt = (v: number | null) => v == null ? '—' : (v > 0 ? '+' : '') + v + unit;
                                        const isUsed = usedKey === key;
                                        return (
                                            <tr key={key} className={`border-t ${theme === 'dark' ? 'border-slate-700/30' : 'border-slate-200/70'} ${isUsed ? (theme === 'dark' ? 'bg-violet-900/20' : 'bg-violet-50') : ''}`}>
                                                <td className="text-left px-3 py-1.5 font-bold">{label}{isUsed && <span className="ml-1 text-violet-500 text-[8px] font-black">★</span>}</td>
                                                <td className="text-right px-1 py-1">
                                                    <input
                                                        type="number" step="0.25" inputMode="decimal"
                                                        value={(cfEdit as any)[key]}
                                                        onChange={(e) => setCfEdit(prev => ({ ...prev, [key]: e.target.value }))}
                                                        onKeyDown={(e) => { if (e.key === 'Enter') recomputeCf(); }}
                                                        onBlur={recomputeCf}
                                                        className={`w-[86px] text-right tabular-nums rounded-md px-1.5 py-0.5 text-[11px] border focus:outline-none focus:border-violet-500 ${theme === 'dark' ? 'bg-slate-900/60 border-slate-700 text-slate-200' : 'bg-white border-slate-300 text-slate-700'}`}
                                                    />
                                                </td>
                                                <td className="text-right px-2 py-1.5 tabular-nums whitespace-nowrap">
                                                    <span className={`font-bold ${vCls(fixV)}`}>{fixEmo} {fmt(fixV)}</span>
                                                    {isWide && has && r.realizedR != null && <span className={`text-[10px] font-bold ml-1.5 ${theme === 'dark' ? 'text-slate-200' : 'text-slate-700'}`}>{r.realizedR > 0 ? '+' : ''}{r.realizedR}R</span>}
                                                </td>
                                                <td className="text-right px-3 py-1.5 tabular-nums whitespace-nowrap">
                                                    <div>
                                                        <span className={`font-bold ${vCls(trV)}`}>{trEmo} {fmt(trV)}</span>
                                                        {isWide && tr && tr.realizedR != null && <span className={`text-[10px] font-bold ml-1.5 ${theme === 'dark' ? 'text-slate-200' : 'text-slate-700'}`}>{tr.realizedR > 0 ? '+' : ''}{tr.realizedR}R</span>}
                                                    </div>
                                                    {isWide && tr && (tr.trailSteps > 0 || tr.exit) && <div className={`text-[9px] font-bold ${theme === 'dark' ? 'text-slate-300' : 'text-slate-600'}`}>{tr.trailSteps > 0 ? `${tr.trailSteps}× posun` : ''}{tr.exit ? `${tr.trailSteps > 0 ? ' · ' : ''}exit ${tr.exit}` : ''}</div>}
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        )}
                    </div>
                );
            })()}

            {/* TP targety — likviditní levely z indikátoru (PDH/PDL/PWH/dHigh/VWAP…) vs swing SL */}
            {cf && cf.ok && cf.tpTargets && cf.tpTargets.length > 0 && (() => {
                const riskNum = Number(trade.risk) || 0;
                const unit = riskNum ? '' : 'R';
                return (
                    <div className={`mb-4 rounded-xl border overflow-hidden ${theme === 'dark' ? 'border-slate-700/50 bg-slate-800/50' : 'border-slate-200 bg-slate-50'}`}>
                        <div className={`px-3 py-2 text-[10px] font-black uppercase tracking-widest border-b ${theme === 'dark' ? 'text-sky-400 border-slate-700/50' : 'text-sky-600 border-slate-200'}`}>
                            🎯 TP targety {!isWide && <span className="text-slate-400">· risk = swing</span>}
                        </div>
                        <table className="w-full text-[11px]">
                            <thead>
                                <tr className={`${theme === 'dark' ? 'text-slate-500' : 'text-slate-400'} text-[9px] uppercase tracking-wider`}>
                                    <th className="text-left font-bold px-3 py-1">Target</th>
                                    <th className="text-right font-bold px-2 py-1">Cena</th>
                                    <th className="text-center font-bold px-2 py-1">Výsledek</th>
                                    <th className="text-right font-bold px-3 py-1">{riskNum ? '$ / R' : 'R'}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {cf.tpTargets!.map((t, i) => {
                                    const m = String(t.label).match(/^(.*?)\s*(\[.*\])?\s*$/);
                                    const core = m ? m[1] : t.label;
                                    const tag = m && m[2] ? m[2].replace(/[[\]]/g, '') : '';
                                    const reached = t.outcome === 'WIN';
                                    const usd = t.realizedR != null && riskNum ? Math.round(t.realizedR * riskNum) : null;
                                    const main = riskNum ? usd : t.realizedR;
                                    const vCls = main == null ? 'text-slate-400' : main > 0 ? 'text-emerald-500' : main < 0 ? 'text-red-500' : '';
                                    return (
                                        <tr key={i} className={`border-t ${theme === 'dark' ? 'border-slate-700/30' : 'border-slate-200/70'}`}>
                                            <td className="text-left px-3 py-1.5 font-bold whitespace-nowrap">{core}{tag && <span className="ml-1 text-[8px] font-bold text-slate-400">{tag}</span>}</td>
                                            <td className="text-right px-2 py-1.5 tabular-nums text-slate-400">{t.price}</td>
                                            <td className="text-center px-2 py-1.5 whitespace-nowrap">{reached ? <span className="text-emerald-500 font-black">✅ došlo</span> : t.outcome === 'LOSS' ? <span className="text-red-500 font-black">❌ SL</span> : <span className="text-slate-400">⏳</span>}</td>
                                            <td className={`text-right px-3 py-1.5 tabular-nums font-bold whitespace-nowrap ${vCls}`}>
                                                {main == null ? '—' : (main > 0 ? '+' : '') + main + unit}
                                                {isWide && riskNum && t.realizedR != null && <span className={`text-[10px] ml-1.5 ${theme === 'dark' ? 'text-slate-200' : 'text-slate-700'}`}>{t.realizedR > 0 ? '+' : ''}{t.realizedR}R</span>}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                );
            })()}

            {/* Galerie náhledů — entry graf + HTF kontext, horizontálně scrollovatelná */}
            {(previewUrl || htfShots.length > 0) && (() => {
                const gallery = [
                    ...(previewUrl ? [{ label: 'Graf', url: previewUrl }] : []),
                    ...htfShots.map(s => ({ label: s.label, url: s.dataUrl })),
                ];
                return (
                    <div className="mb-4">
                        <div className={`flex justify-between items-center mb-1.5 text-[10px] font-bold uppercase tracking-widest ${theme === 'dark' ? 'text-slate-400' : 'text-slate-500'}`}>
                            <span>Náhledy ({gallery.length}) · scroll →</span>
                            <button onClick={(e) => { e.preventDefault(); setPreviewUrl(null); setHtfShots([]); }} title="Zahodit náhledy" className={`bg-transparent border-none cursor-pointer p-0 ${theme === 'dark' ? 'text-slate-400 hover:text-red-400' : 'text-slate-500 hover:text-red-500'}`}>
                                <XCircle size={14} />
                            </button>
                        </div>
                        <div className="flex gap-2 overflow-x-auto pb-1.5 snap-x snap-mandatory" style={{ scrollbarWidth: 'thin' }}>
                            {gallery.map((g, i) => (
                                <div key={i} className={`relative shrink-0 w-[80%] snap-start rounded-xl overflow-hidden border ${theme === 'dark' ? 'border-slate-700/50 bg-slate-800/80' : 'border-slate-200 bg-white'}`}>
                                    <div className={`absolute top-1.5 left-1.5 z-10 px-1.5 py-0.5 rounded text-[9px] font-black ${theme === 'dark' ? 'bg-black/60 text-violet-300' : 'bg-white/85 text-violet-600'}`}>{g.label}</div>
                                    <img src={g.url} alt={g.label} className="w-full h-auto block cursor-zoom-in" onClick={() => openLightbox(g.url)} title="Klikni pro plnou velikost" />
                                </div>
                            ))}
                        </div>
                    </div>
                );
            })()}

            {/* Kontext picker — per-panel výběr TF (split screen: pohledy se zipnou přes panely) */}
            {htfPickerOpen && (() => {
                const TF_OPTS: [string, string][] = [['1', '1m'], ['5', '5m'], ['15', '15m'], ['30', '30m'], ['60', '1H'], ['240', '4H'], ['D', 'D']];
                const split = (layout?.paneCount || 1) > 1;
                const previewFrames = buildFrames(htfPaneTfs).filter(f => f.some(Boolean));
                return (
                    <div className={`mb-2 p-2.5 rounded-xl border ${theme === 'dark' ? 'border-slate-700/50 bg-slate-800/50' : 'border-slate-200 bg-slate-50'}`}>
                        <div className="text-[9px] font-black uppercase tracking-widest mb-2 text-slate-500">
                            Kontext — které TF snímat {split ? `· split ${layout?.paneCount} panely` : ''}
                        </div>
                        {htfPaneTfs.map((paneList, pi) => (
                            <div key={pi} className="mb-2 last:mb-0">
                                {split && (
                                    <div className="text-[9px] font-bold mb-1 text-slate-400">
                                        {pi === 0 ? 'Levý panel' : pi === 1 ? 'Pravý panel' : `Panel ${pi + 1}`}
                                        {layout?.panes?.[pi]?.sym ? ` · ${layout.panes[pi].sym} (teď ${tfLabel(layout.panes[pi].res)})` : ''}
                                    </div>
                                )}
                                <div className="flex flex-wrap gap-1">
                                    {TF_OPTS.map(([r, l]) => {
                                        const on = paneList.includes(r);
                                        return (
                                            <button key={r} onClick={() => toggleHtfTf(pi, r)} className={`px-2 py-1 rounded-lg text-[10px] font-black transition-colors border ${on ? 'bg-violet-600 border-violet-500 text-white' : (theme === 'dark' ? 'border-slate-700 text-slate-400 hover:bg-slate-700/50' : 'border-slate-300 text-slate-500 hover:bg-slate-100')}`}>{l}</button>
                                        );
                                    })}
                                </div>
                            </div>
                        ))}
                        <div className="text-[9px] text-slate-400 mt-1.5 pt-1.5 border-t border-slate-700/30">
                            {previewFrames.length ? <>Zachytí {previewFrames.length} {previewFrames.length === 1 ? 'pohled' : previewFrames.length < 5 ? 'pohledy' : 'pohledů'}: {previewFrames.map(frameLabel).join('  ·  ')}</> : 'Vyber aspoň jeden TF.'}
                        </div>
                    </div>
                );
            })()}

            <div className="flex gap-2">
                <div
                    className="flex-[0.35] relative"
                    title="Zachytit kontext (⚙ = výběr TF / split panely)"
                    onContextMenu={(e) => { e.preventDefault(); setHtfPickerOpen(o => { if (!o) loadLayoutAndTfs(); return !o; }); }}
                >
                    <Button
                        onClick={handleCaptureHtf}
                        disabled={isCapturingHtf || isSubmitting || isPreviewing}
                        className={`w-full border transition-colors shadow-sm font-bold text-xs ${theme === 'dark' ? '!bg-slate-800 !text-violet-300 hover:!bg-slate-700 border-slate-700/50' : '!bg-white !text-violet-600 hover:!bg-slate-50 border-slate-300'}`}
                    >
                        {isCapturingHtf ? <RefreshCw size={14} className="animate-spin" /> : <Layers size={16} />}
                    </Button>
                    <span onClick={(e) => { e.stopPropagation(); setHtfPickerOpen(o => { if (!o) loadLayoutAndTfs(); return !o; }); }} className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-violet-600 text-white text-[8px] font-black flex items-center justify-center cursor-pointer" title="Výběr TF">⚙</span>
                </div>
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
