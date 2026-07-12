import React, { useState, useRef, useEffect, useMemo } from 'react';
import { pointValueFor } from '../services/tradovateImport';
import { motion, AnimatePresence } from 'framer-motion';
import {
    Play, X, Edit3, Trash2, Clock, Image as ImageIcon,
    Maximize2, ArrowRight, Timer, Terminal, ArrowUpRight, ArrowDownRight,
    Share2, Check, ChevronLeft, ChevronRight, Zap, Brain, FileText, Monitor, Target,
    ShieldCheck, Layers, Wallet, Save, CornerDownLeft, AlertOctagon
} from 'lucide-react';
import { Trade, Account, CustomEmotion, PnLDisplayMode, User } from '../types';
import { formatPnL } from '../utils/formatPnL';
import { ExchangeRates } from '../services/currencyService';
import { storageService } from '../services/storageService';
import { ErrorBoundary } from './ErrorBoundary';
import ImageZoomModal from './ImageZoomModal';
import ConfirmationModal from './ConfirmationModal';
import TradeExecutionIntel from './TradeExecutionIntel';
import ManualTradeForm from './ManualTradeForm';
import TradeShareModal from './TradeShareModal';

interface PropertyProps {
    label: string;
    value: string | number;
    subValue?: string;
    color?: string;
    icon?: any;
    isDark?: boolean;
}

const Property = React.memo(({ label, value, subValue, color, icon: Icon, isDark = true }: PropertyProps) => (
    <div className={`py-1.5 px-1 lg:py-2.5 group/prop lg:border-b ${isDark ? 'lg:border-white/[0.03]' : 'lg:border-slate-100'} lg:last:border-0`}>
        <div className="flex items-center gap-1 lg:gap-1.5 mb-0.5 lg:mb-1 opacity-40 group-hover/prop:opacity-60 transition-opacity">
            {Icon && <Icon size={9} className="text-slate-400" />}
            <span className="text-[8px] font-black uppercase tracking-[0.15em] lg:tracking-[0.2em]">{label}</span>
        </div>
        <div>
            <span className={`text-[11px] lg:text-[12px] font-black font-mono tracking-tighter ${color || (isDark ? 'text-slate-200' : 'text-slate-900')}`}>{value}</span>
            {subValue && <p className="text-[7px] lg:text-[8px] font-bold text-slate-500 mt-0.5 uppercase tracking-wide opacity-60">{subValue}</p>}
        </div>
    </div>
));

// Editovatelná verze Property — pro SL/TP dodatečné doplnění
// (typicky když byl SL posunut po vstupu a parser ho ignoroval).
// Klik na value → input, Enter/blur uloží, Esc zruší.
const EditableNumberProperty: React.FC<{
  label: string;
  value: number | undefined;
  placeholder?: string;
  color?: string;
  icon: any;
  isDark: boolean;
  onSave: (value: number | undefined) => void;
}> = ({ label, value, placeholder, color, icon: Icon, isDark, onSave }) => {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value !== undefined ? String(value) : '');

  useEffect(() => { setText(value !== undefined ? String(value) : ''); }, [value]);

  const commit = () => {
    const trimmed = text.trim().replace(',', '.');
    if (trimmed === '') {
      onSave(undefined);
    } else {
      const n = parseFloat(trimmed);
      if (!isNaN(n) && n > 0) onSave(n);
    }
    setEditing(false);
  };

  return (
    <div className={`py-1.5 px-1 lg:py-2.5 group/prop lg:border-b ${isDark ? 'lg:border-white/[0.03]' : 'lg:border-slate-100'} lg:last:border-0`}>
      <div className="flex items-center gap-1 lg:gap-1.5 mb-0.5 lg:mb-1 opacity-40 group-hover/prop:opacity-60 transition-opacity">
        {Icon && <Icon size={9} className="text-slate-400" />}
        <span className="text-[8px] font-black uppercase tracking-[0.15em] lg:tracking-[0.2em]">{label}</span>
        {value === undefined && (
          <span className={`text-[7px] font-black uppercase tracking-widest px-1 py-0 rounded ${isDark ? 'bg-amber-500/20 text-amber-300' : 'bg-amber-100 text-amber-700'}`}>+ doplnit</span>
        )}
      </div>
      <div>
        {editing ? (
          <input
            type="number"
            step="0.25"
            autoFocus
            value={text}
            onChange={e => setText(e.target.value)}
            onBlur={commit}
            onKeyDown={e => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') { setText(value !== undefined ? String(value) : ''); setEditing(false); }
            }}
            placeholder={placeholder}
            className={`w-full text-[11px] lg:text-[12px] font-black font-mono tracking-tighter outline-none border rounded px-1.5 py-0.5 ${
              isDark ? 'bg-white/5 border-white/20 text-white' : 'bg-white border-slate-300 text-slate-900'
            }`}
          />
        ) : (
          <button
            onClick={() => setEditing(true)}
            className={`text-[11px] lg:text-[12px] font-black font-mono tracking-tighter text-left w-full hover:bg-white/5 rounded transition-colors ${
              color || (isDark ? 'text-slate-200' : 'text-slate-900')
            } ${value === undefined ? 'opacity-50 italic' : ''}`}
            title="Klikni pro úpravu"
          >
            {value !== undefined ? value : (placeholder || '—')}
          </button>
        )}
      </div>
    </div>
  );
};

interface TradeDetailModalProps {
    trade: Trade;
    accountName: string;
    theme: 'dark' | 'light' | 'oled';
    onClose: () => void;
    onDelete: () => void;
    emotions: CustomEmotion[];
    onPrev?: () => void;
    onNext?: () => void;
    hasPrev?: boolean;
    hasNext?: boolean;
    onUpdateTrade?: (updates: Partial<Trade>) => void;
    pnlDisplayMode?: PnLDisplayMode;
    accounts?: Account[];
    initialBalance?: number;
    user?: User;
    exchangeRates?: ExchangeRates | null;
    allTrades?: Trade[];
    /** Otevřít rovnou v editačním formuláři (průvodce doplněním importovaných obchodů). */
    startInEditMode?: boolean;
    /** Zavolá se po ULOŽENÍ v režimu průvodce — přejdi na další obchod. */
    onSaved?: () => void;
}

const TradeDetailModal: React.FC<TradeDetailModalProps> = ({
    trade, accountName, theme, onClose, onDelete, emotions, onPrev, onNext, hasPrev, hasNext,
    onUpdateTrade, pnlDisplayMode = 'usd', accounts = [], initialBalance, user, exchangeRates,
    allTrades = [], startInEditMode = false, onSaved
}) => {
    const isDark = theme !== 'light';
    const targetCurrency = user?.currency || 'USD';

    const safeValue = (val: any) => {
        const parsed = parseFloat(String(val || 0));
        return isNaN(parsed) ? 0 : parsed;
    };

    const formatValue = (val: number, mode: PnLDisplayMode = pnlDisplayMode, bal?: number, rr?: number, sign: boolean = true) => {
        // Ensure inputs to formatPnL are numbers
        const cleanVal = isNaN(val) ? 0 : val;
        const cleanRR = (rr !== undefined && isFinite(rr)) ? rr : undefined;
        return formatPnL(cleanVal, mode, bal, cleanRR, sign, targetCurrency, exchangeRates);
    };

    const [fullTrade, setFullTrade] = useState<Trade>(trade);
    const [isLoadingDetails, setIsLoadingDetails] = useState(false);

    // Scroll Lock
    useEffect(() => {
        const originalBodyOverflow = document.body.style.overflow;
        const originalHtmlOverflow = document.documentElement.style.overflow;

        document.body.style.overflow = 'hidden';
        document.documentElement.style.overflow = 'hidden';

        return () => {
            document.body.style.overflow = originalBodyOverflow;
            document.documentElement.style.overflow = originalHtmlOverflow;
        };
    }, []);


    const activeTrade = fullTrade || trade;

    useEffect(() => {
        setFullTrade(trade);
        // If parent trade already has screenshot data, use it directly (no extra DB call)
        if (trade.screenshot || (trade.screenshots && trade.screenshots.length > 0)) return;
        let cancelled = false;
        const loadFull = async () => {
            if (isLoadingDetails) return;
            setIsLoadingDetails(true);
            try {
                if (trade.id) {
                    const detailed = await storageService.getTradeById(String(trade.id));
                    // Merge only screenshot/screenshots from DB — keep parent prop's
                    // up-to-date fields (executionStatus, isValid, notes, etc.) so we
                    // don't overwrite an optimistic update with stale DB data.
                    if (detailed && !cancelled) {
                        setFullTrade(prev => ({
                            ...prev,
                            screenshot: detailed.screenshot ?? prev.screenshot,
                            screenshots: detailed.screenshots ?? prev.screenshots,
                            drawings: detailed.drawings ?? prev.drawings,
                            aiSuggestions: (detailed as any).aiSuggestions ?? (prev as any).aiSuggestions,
                            visionAnalysis: (detailed as any).visionAnalysis ?? (prev as any).visionAnalysis,
                        }));
                    }
                }
            } catch (e) {
                console.error("Failed to load full trade details", e);
            } finally {
                if (!cancelled) setIsLoadingDetails(false);
            }
        };
        loadFull();
        return () => { cancelled = true; };
    // Sync na CELÝ trade objekt — když edit upraví jakékoliv pole, sync fullTrade.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [trade]);

    const groupTrades = useMemo(() => {
        if (!allTrades.length) return [activeTrade];

        // 1. Try grouping by groupId (preferred for new trades)
        if (activeTrade.groupId) {
            const trades = allTrades.filter(t => t.groupId === activeTrade.groupId);
            const seen = new Set();
            return trades.filter(t => {
                const duplicate = seen.has(t.accountId);
                seen.add(t.accountId);
                return !duplicate;
            });
        }

        // 2. Fallback: Smart Grouping for old trades (same instrument + same timestamp + same direction)
        const fuzzyMatches = allTrades.filter(t =>
            t.instrument === activeTrade.instrument &&
            t.timestamp === activeTrade.timestamp &&
            t.direction === activeTrade.direction
        );

        if (fuzzyMatches.length > 1) {
            const seen = new Set();
            return fuzzyMatches.filter(t => {
                const duplicate = seen.has(t.accountId);
                seen.add(t.accountId);
                return !duplicate;
            });
        }

        return [activeTrade];
    }, [activeTrade.groupId, activeTrade.instrument, activeTrade.timestamp, activeTrade.direction, activeTrade.id, allTrades]);

    // Smarter MASTER identification
    const masterTradeIdInGroup = useMemo(() => {
        if (groupTrades.length <= 1) return null;

        // 1. Explicit master flag
        const explicitMaster = groupTrades.find(t => t.isMaster);
        if (explicitMaster) return explicitMaster.id;

        // 2. Look for "HLAVNÍ" (Main) in account name
        const masterByName = groupTrades.find(t => {
            const acc = accounts.find(a => a.id === t.accountId);
            const name = acc?.name || (t.accountId === activeTrade.accountId ? accountName : '');
            return name?.toLowerCase().includes('hlavní');
        });
        if (masterByName) return masterByName.id;

        // 3. Fallback to first one
        return groupTrades[0]?.id;
    }, [groupTrades, accounts, activeTrade.accountId, accountName]);

    const [isZoomed, setIsZoomed] = useState(false);
    const [activeImageIndex, setActiveImageIndex] = useState(0);
    const [shareCopied, setShareCopied] = useState(false);
    const [isShareCardOpen, setIsShareCardOpen] = useState(false);
    const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);

    // Full Edit Mode — ManualTradeForm overlay
    const [isFullEditOpen, setIsFullEditOpen] = useState(!!startInEditMode);
    // Průvodce: rozliš uložení (→ další obchod) od zrušení (→ konec průvodce).
    const wizardSavedRef = useRef(false);
    // Při přechodu na další obchod v průvodci znovu otevři editační formulář.
    useEffect(() => {
        if (startInEditMode) {
            wizardSavedRef.current = false;
            setIsFullEditOpen(true);
        }
    }, [trade.id, startInEditMode]);
    // Bezpečnostní pojistka: v režimu průvodce bez onUpdateTrade by se editační formulář
    // nevyrenderoval (viz render guard níž) a průvodce by visel na detailu bez akce — radši ukonči.
    useEffect(() => {
        if (startInEditMode && !onUpdateTrade) onClose();
    }, [startInEditMode, onUpdateTrade, onClose]);
    const [editPrefs, setEditPrefs] = useState<{ htf: string[]; ltf: string[]; mistakes: string[] }>({ htf: [], ltf: [], mistakes: [] });
    useEffect(() => {
        storageService.getCachedPreferences().then((p: any) => {
            if (!p) return;
            setEditPrefs({ htf: p.htfOptions || [], ltf: p.ltfOptions || [], mistakes: p.standardMistakes || [] });
        }).catch(() => {});
    }, []);

    // Keyboard navigation — šipky listují trady, Escape zavírá
    useEffect(() => {
        const handleKey = (e: KeyboardEvent) => {
            if (isFullEditOpen) return;
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
            if (e.key === 'ArrowLeft' && hasPrev) onPrev?.();
            if (e.key === 'ArrowRight' && hasNext) onNext?.();
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', handleKey);
        return () => window.removeEventListener('keydown', handleKey);
    }, [hasPrev, hasNext, onPrev, onNext, onClose, isFullEditOpen]);

    // Inline Editing State
    const [isEditingNotes, setIsEditingNotes] = useState(false);
    const [editedNotes, setEditedNotes] = useState(activeTrade.notes || '');

    useEffect(() => {
        setEditedNotes(activeTrade.notes || '');
    }, [activeTrade.notes]);

    const handleSaveNotes = () => {
        onUpdateTrade?.({ notes: editedNotes });
        setIsEditingNotes(false);
    };

    const images = activeTrade.screenshots && activeTrade.screenshots.length > 0
        ? activeTrade.screenshots
        : (activeTrade.screenshot ? [activeTrade.screenshot] : []);

    const entryPrice = safeValue(activeTrade.entryPrice);
    const exitPrice = safeValue(activeTrade.exitPrice);
    const stopLoss = safeValue(activeTrade.stopLoss);
    const takeProfit = safeValue(activeTrade.takeProfit);
    const riskAmount = safeValue(activeTrade.riskAmount);

    // Defensive RRR calculation
    const pnl = safeValue(activeTrade.pnl);
    // Price-based RR (jako TradingView) — čistý cenový poměr bez fees.
    // Pokud máme entry + exit + stopLoss, použij to (přesnější, matches TV).
    // Fallback na pnl/risk pokud něco chybí (např. SL doplněno ručně bez exit price).
    const priceBasedRR = (() => {
      if (entryPrice > 0 && exitPrice > 0 && stopLoss > 0) {
        const profitMove = Math.abs(entryPrice - exitPrice);
        const riskMove = Math.abs(entryPrice - stopLoss);
        if (riskMove > 0) {
          const sign = pnl >= 0 ? 1 : -1;
          return sign * (profitMove / riskMove);
        }
      }
      return null;
    })();
    const realRRR = priceBasedRR !== null
      ? priceBasedRR
      : (riskAmount > 0 ? pnl / riskAmount : 0);

    const exitTime = activeTrade.timestamp || new Date(activeTrade.date).getTime();
    const tradeEntryTime = activeTrade.entryTime || activeTrade.entryDate || (exitTime - (safeValue(activeTrade.durationMinutes) * 60 * 1000));

    // Format the time range string
    const formatTime = (time: any) => {
        const d = new Date(time);
        return isNaN(d.getTime()) ? '--:--' : d.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
    };

    const timeRange = `${formatTime(tradeEntryTime)} - ${formatTime(exitTime)}`;
    const holdTime = activeTrade.duration || (Math.round(safeValue(activeTrade.durationMinutes ?? (activeTrade as any).duration_minutes)) + 'm');
    // Status MUSÍ číst z nejnovějšího trade propu (ne z fullTrade, který může být přepsán stale DB fetchem)
    const status = trade.executionStatus || activeTrade.executionStatus || ((trade.isValid === false || activeTrade.isValid === false) ? 'Invalid' : 'Valid');
    const isMissed = status === 'Missed';
    // Manual BE override má přednost před auto detekcí z pnl
    const isBEOverride = activeTrade.isBE === true;
    const isWin = !isBEOverride && pnl >= 0;

    const pnlColor = isMissed ? 'text-blue-400' : (isWin ? 'text-emerald-500' : 'text-rose-500');
    const directionColor = isMissed ? 'text-blue-400 bg-blue-500/10 border-blue-500/20' : (activeTrade.direction === 'Long' ? 'text-emerald-500 bg-emerald-500/10 border-emerald-500/20' : 'text-rose-500 bg-rose-500/10 border-rose-500/20');

    const getEmotionDetails = (emoId: string) => emotions.find(e => e.id === emoId) || { label: emoId, icon: '' };

    const [imageLoadError, setImageLoadError] = useState(false);

    // Reset error state when switching images
    useEffect(() => { setImageLoadError(false); }, [activeImageIndex]);
    // Reset error state when trade changes
    useEffect(() => { setImageLoadError(false); }, [activeTrade.id]);


    const handleShare = async () => {
        let url = '';
        const isUUID = (id: any) => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
        try {
            if (isUUID(trade.id)) {
                storageService.markTradeAsPublic(trade.id as string).catch(err => console.error("DB Mark Public failed", err));
                url = `${window.location.origin}${window.location.pathname}?shareId=${trade.id}`;
            } else {
                const shareableTrade = { ...trade, screenshot: null, screenshots: [] };
                // Modern Unicode-safe encode: UTF-8 string → bytes → base64
                const jsonStr = JSON.stringify(shareableTrade);
                const bytes = new TextEncoder().encode(jsonStr);
                const encoded = btoa(String.fromCharCode(...bytes));
                url = `${window.location.origin}${window.location.pathname}?share=${encoded}`;
            }
            await navigator.clipboard.writeText(url);
            setShareCopied(true);
            setTimeout(() => setShareCopied(false), 2000);
        } catch (err) {
            console.error("General sharing failure", err);
        }
    };

    // Preferuj price-based RR (jako TradingView) pro PnL display v R mode
    const formattedPnL = formatValue(pnl, pnlDisplayMode, initialBalance || accounts.find(a => a.id === activeTrade.accountId)?.initialBalance, priceBasedRR !== null ? priceBasedRR : ((riskAmount > 0) ? pnl / riskAmount : undefined));

    return (
        <ErrorBoundary name="TradeDetailModal">
            <div className="fixed inset-0 z-[110] flex items-center justify-center p-0 md:p-6 lg:p-12 overflow-hidden">
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="absolute inset-0 bg-theme-page-95 backdrop-blur-2xl"
                    onClick={onClose}
                />

                <motion.div
                    initial={{ opacity: 0, scale: 0.95, y: 20 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95, y: 20 }}
                    className={`relative w-full max-w-[1600px] h-full lg:h-[85vh] rounded-none md:rounded-[40px] overflow-hidden shadow-[0_0_100px_rgba(0,0,0,0.8)] flex flex-col border ${isDark ? 'bg-theme-card-80 border-white/10' : 'bg-white/90 border-slate-200'}`}
                >
                    {/* Header */}
                    <div className={`h-14 lg:h-20 shrink-0 border-b flex items-center justify-between px-4 md:px-10 z-20 ${isDark ? 'border-white/5 bg-theme-card-50' : 'bg-white/50 border-slate-100'} backdrop-blur-md`}>
                        <div className="flex items-center gap-3 lg:gap-8 min-w-0">
                            <div className="flex items-center gap-2 lg:gap-4 min-w-0">
                                <h2 className={`text-lg lg:text-2xl font-black tracking-tighter uppercase truncate ${isDark ? 'text-white' : 'text-slate-900'}`}>{trade.instrument}</h2>
                                <div className={`px-2 lg:px-3 py-1 rounded-full border flex items-center gap-1.5 shrink-0 ${directionColor}`}>
                                    {isMissed ? <Clock size={11} /> : (trade.direction === 'Long' ? <ArrowUpRight size={12} strokeWidth={3} /> : <ArrowDownRight size={12} strokeWidth={3} />)}
                                    <span className="text-[9px] lg:text-[10px] font-black uppercase tracking-widest">{isMissed ? 'MISSED' : trade.direction}</span>
                                </div>
                                {!isMissed && (
                                    <div className={`px-2 lg:px-3 py-1 rounded-full border flex items-center gap-1.5 shrink-0 ${status === 'Invalid' ? 'text-rose-500 bg-rose-500/10 border-rose-500/20' : 'text-emerald-500 bg-emerald-500/10 border-emerald-500/20'}`}>
                                        {status === 'Invalid' ? <AlertOctagon size={11} strokeWidth={3} /> : <Check size={11} strokeWidth={3} />}
                                        <span className="text-[9px] lg:text-[10px] font-black uppercase tracking-widest">{status === 'Invalid' ? 'NEVALIDNÍ' : 'VALIDNÍ'}</span>
                                    </div>
                                )}
                            </div>
                            <div className="h-6 w-px bg-white/10 hidden lg:block" />
                            <div className="hidden lg:flex flex-col">
                                <p className="text-[8px] font-black text-slate-500 uppercase tracking-widest">Transaction Date</p>
                                <p className={`text-[11px] font-bold ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                                    {trade.date ? new Date(trade.date).toLocaleDateString('cs-CZ', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—'}
                                </p>
                            </div>
                        </div>

                        <div className="flex items-center gap-1.5 lg:gap-3">
                            {/* Prev/Next */}
                            <div className={`flex items-center gap-0.5 p-0.5 rounded-xl border ${isDark ? 'bg-white/5 border-white/5' : 'bg-white border-slate-200'}`}>
                                <button onClick={onPrev} disabled={!hasPrev} className={`p-1.5 lg:p-2 rounded-lg transition-all ${!hasPrev ? 'opacity-20 cursor-not-allowed' : isDark ? 'hover:bg-white/10 text-slate-400 hover:text-white' : 'hover:bg-slate-100 text-slate-400 hover:text-slate-700'}`}><ChevronLeft size={16} /></button>
                                <button onClick={onNext} disabled={!hasNext} className={`p-1.5 lg:p-2 rounded-lg transition-all ${!hasNext ? 'opacity-20 cursor-not-allowed' : isDark ? 'hover:bg-white/10 text-slate-400 hover:text-white' : 'hover:bg-slate-100 text-slate-400 hover:text-slate-700'}`}><ChevronRight size={16} /></button>
                            </div>
                            <button onClick={() => setIsShareCardOpen(true)} title="Sdílet jako kartu" className={`p-2 lg:p-3 rounded-xl lg:rounded-2xl transition-all ${isDark ? 'bg-white/5 text-slate-400 hover:bg-white/10 hover:text-white' : 'bg-white text-slate-400 hover:text-slate-700 hover:bg-slate-50 border border-slate-200'}`}><Share2 size={16} /></button>
                            {onUpdateTrade && (
                                <button onClick={(e) => { e.stopPropagation(); setIsFullEditOpen(true); }} className={`p-2 lg:p-3 rounded-xl lg:rounded-2xl transition-all ${isDark ? 'bg-blue-500/10 text-blue-500 hover:bg-blue-500 hover:text-white' : 'bg-white text-blue-400 hover:bg-blue-500 hover:text-white border border-blue-200'}`} title={String(activeTrade.id).startsWith('combined_') ? 'Upravit obchod (změny se propíší na všechny účty; PnL/risk se edituje individuálně)' : 'Upravit obchod'}><Edit3 size={16} /></button>
                            )}
                            <button onClick={(e) => { e.stopPropagation(); setIsDeleteModalOpen(true); }} className={`p-2 lg:p-3 rounded-xl lg:rounded-2xl transition-all ${isDark ? 'bg-rose-500/10 text-rose-500 hover:bg-rose-500 hover:text-white' : 'bg-white text-rose-400 hover:bg-rose-500 hover:text-white border border-rose-200'}`}><Trash2 size={16} /></button>
                            <button onClick={onClose} className={`p-2 lg:p-3 rounded-full transition-all ${isDark ? 'hover:bg-white/10 text-slate-400' : 'bg-white hover:bg-slate-50 text-slate-400 border border-slate-200'}`}><X size={20} /></button>
                        </div>
                    </div>

                    <div className="flex-1 flex flex-col lg:flex-row overflow-hidden relative">

                        {/* LEFT: Pure trade data only */}
                        <div className={`order-2 lg:order-1 w-full lg:w-[320px] flex-1 lg:flex-none shrink-0 border-t lg:border-t-0 lg:border-r flex flex-col z-10 ${isDark ? 'border-white/5 bg-theme-card-40' : 'border-slate-100 bg-slate-50/40'} backdrop-blur-xl overflow-y-auto no-scrollbar`}>
                            {/* PnL hero card */}
                            <div className={`p-5 border-b relative ${isDark ? 'border-white/5' : 'border-slate-100'} ${isMissed ? 'bg-blue-500/[0.04]' : isBEOverride ? 'bg-amber-500/[0.04]' : isWin ? 'bg-emerald-500/[0.04]' : 'bg-rose-500/[0.04]'}`}>
                                <p className="text-[9px] font-black text-slate-500 uppercase tracking-[0.3em] mb-2">Profit / Loss</p>
                                <div className="flex items-baseline justify-between gap-4 flex-wrap">
                                    <h3 className={`text-4xl lg:text-4xl font-black font-mono tracking-tighter leading-none ${pnlColor}`} style={{ color: isMissed ? '#60a5fa' : isBEOverride ? '#f59e0b' : isWin ? '#10b981' : '#f43f5e' }}>
                                        {formattedPnL || '—'}
                                    </h3>
                                    <div className="flex flex-col items-end">
                                        <span className={`text-base font-black font-mono ${realRRR >= 1 ? 'text-emerald-500' : 'text-slate-500'}`}>{isFinite(realRRR) ? realRRR.toFixed(2) : '0.00'} R</span>
                                        <span className="text-[8px] font-bold text-slate-600 uppercase tracking-widest leading-none mt-1">Reward/Risk</span>
                                    </div>
                                </div>
                                {/* BE override — když trade byl fakticky BE ale fees/slippage daly +/- pár dolarů */}
                                {!isMissed && onUpdateTrade && (
                                  <button
                                    onClick={() => onUpdateTrade({ isBE: !isBEOverride } as any)}
                                    className={`mt-3 inline-flex items-center gap-1.5 px-3 py-1 rounded-lg text-[9px] font-black uppercase tracking-widest transition-all active:scale-95 ${
                                      isBEOverride
                                        ? 'bg-amber-500 text-white shadow-sm'
                                        : isDark ? 'bg-white/5 text-slate-400 hover:bg-white/10 border border-white/10' : 'bg-white text-slate-500 hover:bg-amber-50 hover:text-amber-600 border border-slate-200'
                                    }`}
                                    title={isBEOverride ? 'Odznačit jako BE (vrátit auto detekci podle pnl)' : 'Označit jako BE (počítá se jako break-even ve statistikách bez ohledu na pnl)'}
                                  >
                                    {isBEOverride ? '✓ Označeno jako BE' : '⚖ Označit jako BE'}
                                  </button>
                                )}
                            </div>
                            {/* Metrics — 3-col na mobile (kompaktnější), 2-col na desktop */}
                            <div className="p-3 lg:p-5">
                                <div className="grid grid-cols-3 gap-x-2 gap-y-3 lg:grid-cols-2 lg:gap-x-6 lg:gap-y-4">
                                    <Property label="ENTRY" value={entryPrice || '—'} icon={Target} isDark={isDark} />
                                    <Property label="EXIT" value={exitPrice || '—'} color={isWin ? 'text-emerald-400' : 'text-rose-400'} icon={ArrowRight} isDark={isDark} />
                                    <EditableNumberProperty
                                      label="STOP"
                                      value={activeTrade.stopLoss}
                                      placeholder="—"
                                      color="text-rose-500/80"
                                      icon={ShieldCheck}
                                      isDark={isDark}
                                      onSave={(val) => {
                                        if (!onUpdateTrade) return;
                                        // Při změně SL spočítej i riskAmount (pro RR display)
                                        const updates: Partial<Trade> = { stopLoss: val };
                                        if (val !== undefined && activeTrade.entryPrice && activeTrade.positionSize) {
                                          const pv = pointValueFor(activeTrade.instrument);
                                          const risk = Math.abs(activeTrade.entryPrice - val) * activeTrade.positionSize * pv;
                                          updates.riskAmount = risk > 0 ? risk : undefined;
                                        } else {
                                          updates.riskAmount = undefined;
                                        }
                                        onUpdateTrade(updates);
                                      }}
                                    />
                                    <EditableNumberProperty
                                      label="TARGET"
                                      value={activeTrade.takeProfit}
                                      placeholder="—"
                                      color="text-emerald-500/80"
                                      icon={Zap}
                                      isDark={isDark}
                                      onSave={(val) => {
                                        if (!onUpdateTrade) return;
                                        const updates: Partial<Trade> = { takeProfit: val };
                                        if (val !== undefined && activeTrade.entryPrice && activeTrade.positionSize) {
                                          const pv = pointValueFor(activeTrade.instrument);
                                          const target = Math.abs(val - activeTrade.entryPrice) * activeTrade.positionSize * pv;
                                          updates.targetAmount = target > 0 ? target : undefined;
                                        } else {
                                          updates.targetAmount = undefined;
                                        }
                                        onUpdateTrade(updates);
                                      }}
                                    />
                                    <Property label="POSITION" value={activeTrade.positionSize || 1} icon={Layers} isDark={isDark} />
                                    <Property label="HOLD" value={holdTime} subValue={timeRange.includes('01:00 - 01:00') ? undefined : timeRange} icon={Timer} isDark={isDark} />
                                </div>
                                <div className="pt-4">
                                    <p className="text-[10px] font-black uppercase text-slate-500 tracking-[0.2em] flex items-center gap-2 mb-2"><Wallet size={12} /> Účty</p>
                                    <div className="space-y-1.5">
                                        {groupTrades.map(gt => {
                                            const acc = accounts.find(a => a.id === gt.accountId);
                                            if (!acc && gt.accountId !== activeTrade.accountId) return null;
                                            const pnlVal = safeValue(gt.pnl);
                                            const isMasterTrade = masterTradeIdInGroup ? gt.id === masterTradeIdInGroup : (gt.isMaster || (!gt.masterTradeId && groupTrades.length > 1 && gt.id === groupTrades[0]?.id));
                                            return (
                                                <div key={gt.id} className={`px-3 py-2 rounded-xl border flex items-center justify-between transition-all ${isDark ? 'bg-white/[0.03] border-white/5 hover:bg-white/[0.06]' : 'bg-white border-slate-200'}`}>
                                                    <div className="flex items-center gap-2.5 min-w-0">
                                                        <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${acc?.type === 'Funded' ? 'bg-purple-500 shadow-[0_0_8px_rgba(168,85,247,0.5)]' : 'bg-blue-500'}`} />
                                                        <span className="text-[11px] font-black uppercase tracking-tight truncate max-w-[120px]">{acc?.name || accountName}</span>
                                                        {isMasterTrade && groupTrades.length > 1 && <span className="text-[7px] font-black text-blue-500 uppercase tracking-widest shrink-0">MASTER</span>}
                                                        {!isMasterTrade && groupTrades.length > 1 && <span className="text-[7px] font-black text-purple-500 uppercase tracking-widest shrink-0">COPY</span>}
                                                    </div>
                                                    <span className={`text-[11px] font-black font-mono shrink-0 ${pnlVal >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>{formatValue(pnlVal)}</span>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>

                                {/* Mindset */}
                                {!!(activeTrade.emotions?.length || activeTrade.mistakes?.length) && (
                                    <div className={`pt-4 border-t ${isDark ? 'border-white/[0.03]' : 'border-slate-100'}`}>
                                        <p className="text-[10px] font-black uppercase text-slate-500 tracking-[0.2em] mb-2.5 flex items-center gap-2"><Brain size={11} /> Mindset</p>
                                        <div className="flex flex-wrap gap-1.5">
                                            {activeTrade.emotions?.map(e => <span key={e} className="px-2 py-1 rounded-lg bg-purple-500/10 border border-purple-500/20 text-purple-400 text-[9px] font-black uppercase tracking-wide">{getEmotionDetails(e).label}</span>)}
                                            {activeTrade.mistakes?.map(m => <span key={m} className="px-2 py-1 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-500 text-[9px] font-black uppercase tracking-wide">{m}</span>)}
                                        </div>
                                    </div>
                                )}

                                {/* HTF Confluence */}
                                {!!activeTrade.htfConfluence?.length && (
                                    <div className={`pt-4 border-t ${isDark ? 'border-white/[0.03]' : 'border-slate-100'}`}>
                                        <p className="text-[10px] font-black uppercase text-slate-500 tracking-[0.2em] mb-2.5 flex items-center gap-2"><Monitor size={11} /> HTF Confluence</p>
                                        <div className="flex flex-wrap gap-1.5">
                                            {activeTrade.htfConfluence.map(c => <span key={c} className="px-2 py-1 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-400 text-[9px] font-black uppercase tracking-wide">{c}</span>)}
                                        </div>
                                    </div>
                                )}

                                {/* LTF Confluence */}
                                {!!activeTrade.ltfConfluence?.length && (
                                    <div className={`pt-4 border-t ${isDark ? 'border-white/[0.03]' : 'border-slate-100'}`}>
                                        <p className="text-[10px] font-black uppercase text-slate-500 tracking-[0.2em] mb-2.5 flex items-center gap-2"><Zap size={11} /> LTF Confluence</p>
                                        <div className="flex flex-wrap gap-1.5">
                                            {activeTrade.ltfConfluence.map(c => <span key={c} className="px-2 py-1 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-500 text-[9px] font-black uppercase tracking-wide">{c}</span>)}
                                        </div>
                                    </div>
                                )}

                                {/* AlphaBridge Intel — MFE/MAE v R, execution tagy, entry model,
                                    excursion (co zbylo na stole) a counterfactual. Vykreslí se jen
                                    když obchod nese data z extension (jinak vrací null). */}
                                <TradeExecutionIntel trade={activeTrade} isDark={isDark} />

                                {/* Notes + AI (MOBILE ONLY) — na desktop jsou v right pane bottom.
                                    Pořadí: nejdřív Poznámky (user content), pak AI návrhy. */}
                                <div className="lg:hidden pt-4 mt-4 border-t border-slate-100 dark:border-white/[0.03] space-y-4">
                                    <div>
                                        <p className="text-[10px] font-black uppercase text-slate-500 tracking-[0.2em] mb-3 flex items-center gap-2"><FileText size={12} /> Poznámky</p>
                                        <div className={`p-4 rounded-2xl border text-xs font-medium leading-[1.8] ${isDark ? 'bg-black/30 border-white/5 text-slate-400' : 'bg-white border-slate-100 text-slate-600'}`}>
                                            {activeTrade.notes || <span className="italic opacity-40">No log entry.</span>}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* RIGHT: screenshot top + info bottom.
                            Na mobile: flex-none (natural height image) — pak sidebar dole.
                            Na desktop: flex-1 (zabere prostor v row layoutu). */}
                        <div className="order-1 lg:order-2 flex-none lg:flex-1 flex flex-col overflow-hidden">

                            {/* TOP: Screenshot — na mobile přizpůsobí výšku obrázku (žádné pruhy),
                                na desktop fixní 3/5 flex prostor (lg:flex-[3_3_0] + absolute fill). */}
                            <div className={`relative group lg:flex-[3_3_0] lg:min-h-0 lg:overflow-hidden`}>
                            {/* Loading spinner while fetching full trade details */}
                            {isLoadingDetails && (
                                <div className="w-full py-16 lg:absolute lg:inset-0 flex items-center justify-center z-10">
                                    <div className="w-10 h-10 rounded-full border-2 border-white/10 border-t-emerald-500 animate-spin" />
                                </div>
                            )}
                            <AnimatePresence mode="wait">
                                {!isLoadingDetails && (images.length > 0 && !imageLoadError) ? (
                                    <motion.div
                                        key={images[activeImageIndex]}
                                        initial={{ opacity: 0 }}
                                        animate={{ opacity: 1 }}
                                        exit={{ opacity: 0 }}
                                        transition={{ duration: 0.3 }}
                                        className="relative lg:absolute lg:inset-0"
                                    >
                                        <img
                                            src={images[activeImageIndex]}
                                            className="block w-full h-auto lg:absolute lg:inset-0 lg:w-full lg:h-full lg:object-contain cursor-zoom-in"
                                            onClick={() => setIsZoomed(true)}
                                            onError={() => setImageLoadError(true)}
                                        />
                                        {/* Zoom on hover */}
                                        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                                            <div className="p-5 bg-black/40 backdrop-blur-md rounded-full text-white border border-white/20 shadow-2xl pointer-events-auto cursor-pointer hover:scale-110 transition-transform" onClick={() => setIsZoomed(true)}>
                                                <Maximize2 size={28} />
                                            </div>
                                        </div>
                                    </motion.div>
                                ) : !isLoadingDetails ? (
                                    <div className="w-full lg:h-full flex flex-col items-center justify-center opacity-20 text-slate-500 p-8 lg:p-20 text-center">
                                        <div className="p-6 lg:p-10 rounded-[30px] lg:rounded-[40px] border-2 border-dashed border-slate-500">
                                            <ImageIcon size={36} strokeWidth={1} className="lg:hidden" />
                                            <ImageIcon size={64} strokeWidth={1} className="hidden lg:block" />
                                        </div>
                                        <p className="text-sm lg:text-xl font-black uppercase tracking-[0.3em] lg:tracking-[0.4em] mt-6 lg:mt-10">
                                            {imageLoadError ? 'CHYBA NAČÍTÁNÍ' : 'NO VISUAL DATA'}
                                        </p>
                                        <p className="text-[9px] font-bold mt-1.5 opacity-60 hidden lg:block">
                                            {imageLoadError ? 'Obrázek se nepodařilo načíst.' : 'Visual evidence not submitted for this transaction.'}
                                        </p>
                                    </div>
                                ) : null}
                            </AnimatePresence>

                            {/* Floating Navigation Pill */}
                            {images.length > 1 && (
                                <div className="absolute bottom-10 left-1/2 -translate-x-1/2 z-30">
                                    <div className="flex items-center gap-4 px-6 py-4 bg-black/60 backdrop-blur-2xl rounded-full border border-white/10 shadow-2xl">
                                        <button
                                            onClick={() => setActiveImageIndex((activeImageIndex - 1 + images.length) % images.length)}
                                            className="p-2 text-white/50 hover:text-white transition-colors"
                                        >
                                            <ChevronLeft size={24} />
                                        </button>

                                        <div className="flex gap-2">
                                            {images.map((_, i) => (
                                                <button
                                                    key={i}
                                                    onClick={() => setActiveImageIndex(i)}
                                                    className={`w-1.5 h-1.5 rounded-full transition-all duration-300 ${activeImageIndex === i ? 'w-6 bg-white' : 'bg-white/20 hover:bg-white/40'}`}
                                                />
                                            ))}
                                        </div>

                                        <button
                                            onClick={() => setActiveImageIndex((activeImageIndex + 1) % images.length)}
                                            className="p-2 text-white/50 hover:text-white transition-colors"
                                        >
                                            <ChevronRight size={24} />
                                        </button>
                                    </div>
                                </div>
                            )}

                            {/* Canvas Nav Arrows (Desktop) */}
                            {images.length > 1 && (
                                <>
                                    <button
                                        onClick={() => setActiveImageIndex((activeImageIndex - 1 + images.length) % images.length)}
                                        className="absolute left-8 top-1/2 -translate-y-1/2 p-4 text-white/20 hover:text-white opacity-0 group-hover:opacity-100 transition-all z-20"
                                    >
                                        <ChevronLeft size={48} />
                                    </button>
                                    <button
                                        onClick={() => setActiveImageIndex((activeImageIndex + 1) % images.length)}
                                        className="absolute right-8 top-1/2 -translate-y-1/2 p-4 text-white/20 hover:text-white opacity-0 group-hover:opacity-100 transition-all z-20"
                                    >
                                        <ChevronRight size={48} />
                                    </button>
                                </>
                            )}
                        </div>

                            {/* BOTTOM: AI + Notes (DESKTOP ONLY) — na mobile přesunuto do sidebar dole */}
                            <div className={`hidden lg:block flex-[2_2_0] min-h-0 overflow-y-auto no-scrollbar border-t ${isDark ? 'border-white/5 bg-theme-card-40' : 'border-slate-100 bg-slate-50/30'}`}>
                                <div className="px-5 lg:px-6 pt-3 pb-5 lg:pb-6 space-y-4">
                                    {/* Notes */}
                                    <div>
                                        <p className="text-[10px] font-black uppercase text-slate-500 tracking-[0.2em] mb-3 flex items-center gap-2"><FileText size={12} /> Poznámky</p>
                                        <div className={`p-5 rounded-2xl border text-xs font-medium leading-[1.8] ${isDark ? 'bg-black/30 border-white/5 text-slate-400' : 'bg-white border-slate-100 text-slate-600'}`}>
                                            {activeTrade.notes || <span className="italic opacity-40">No log entry.</span>}
                                        </div>
                                    </div>
                                </div>
                            </div>

                        </div>{/* /RIGHT */}
                    </div>
                </motion.div>

                <ConfirmationModal
                    isOpen={isDeleteModalOpen}
                    onClose={() => setIsDeleteModalOpen(false)}
                    onConfirm={onDelete}
                    title="Smazat obchod"
                    message="Opravdu chcete tento obchod trvale odstranit z Alpha Matrixu? Tuto akci nelze vrátit."
                    theme={theme}
                />
            </div>

            {isZoomed && images.length > 0 && (
                <ImageZoomModal images={images} initialIndex={activeImageIndex} onClose={() => setIsZoomed(false)} />
            )}

            {/* FULL EDIT MODE — ManualTradeForm overlay */}
            {isFullEditOpen && onUpdateTrade && (
                <ManualTradeForm
                    key={String(activeTrade.id)}
                    editTrade={activeTrade}
                    onUpdate={(updates) => {
                        // Označ „uloženo" až PO úspěšném dořešení (ManualTradeForm volá onClose
                        // teprve po resolve této promise) — jinak by průvodce postoupil i po selhání.
                        return Promise.resolve(onUpdateTrade(updates)).then(res => { wizardSavedRef.current = true; return res; });
                    }}
                    onClose={() => {
                        if (startInEditMode) {
                            // Průvodce: uložení → další obchod; zrušení → konec průvodce.
                            if (wizardSavedRef.current) { wizardSavedRef.current = false; onSaved?.(); }
                            else { onClose(); }
                        } else {
                            setIsFullEditOpen(false);
                        }
                    }}
                    theme={theme}
                    accounts={accounts}
                    activeAccountId={String(activeTrade.accountId || '')}
                    availableEmotions={emotions}
                    availableMistakes={editPrefs.mistakes}
                    availableHtfOptions={editPrefs.htf}
                    availableLtfOptions={editPrefs.ltf}
                />
            )}

            {/* SHARE CARD MODAL — generuje shareable PNG s AlphaTrade brandingem */}
            {isShareCardOpen && (
                <TradeShareModal
                    trade={activeTrade}
                    username={(() => {
                        // Priority: name → email prefix → fallback
                        if (user?.name) return `@${user.name.toLowerCase().replace(/\s+/g, '')}`;
                        if (user?.email) return `@${user.email.split('@')[0]}`;
                        return '@trader';
                    })()}
                    avatarUrl={user?.avatar}
                    onClose={() => setIsShareCardOpen(false)}
                />
            )}
        </ErrorBoundary>
    );
};

export default TradeDetailModal;
