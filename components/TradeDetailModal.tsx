import React, { useState, useRef, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
    Play, X, Edit3, Trash2, Clock, Image as ImageIcon,
    Maximize2, ArrowRight, Timer, Terminal, ArrowUpRight, ArrowDownRight,
    Share2, Check, ChevronLeft, ChevronRight, Zap, Brain, FileText, Monitor, Target,
    ShieldCheck, Layers, Wallet, Save, CornerDownLeft
} from 'lucide-react';
import { Trade, Account, CustomEmotion, PnLDisplayMode, User } from '../types';
import { formatPnL } from '../utils/formatPnL';
import { ExchangeRates } from '../services/currencyService';
import { storageService } from '../services/storageService';
import { ErrorBoundary } from './ErrorBoundary';
import ImageZoomModal from './ImageZoomModal';
import ConfirmationModal from './ConfirmationModal';

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
}

const TradeDetailModal: React.FC<TradeDetailModalProps> = ({
    trade, accountName, theme, onClose, onDelete, emotions, onPrev, onNext, hasPrev, hasNext,
    onUpdateTrade, pnlDisplayMode = 'usd', accounts = [], initialBalance, user, exchangeRates,
    allTrades = []
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
        if (trade.screenshot || (trade.screenshots && trade.screenshots.length > 0)) return;
        const loadFull = async () => {
            if (isLoadingDetails) return;
            setIsLoadingDetails(true);
            try {
                if (trade.id) {
                    const detailed = await storageService.getTradeById(String(trade.id));
                    if (detailed) setFullTrade(detailed);
                }
            } catch (e) {
                console.error("Failed to load full trade details", e);
            } finally {
                setIsLoadingDetails(false);
            }
        };
        loadFull();
    }, [trade.id]);

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
    const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);

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
    const realRRR = (riskAmount > 0) ? (pnl / riskAmount) : 0;

    const exitTime = activeTrade.timestamp || new Date(activeTrade.date).getTime();
    const tradeEntryTime = activeTrade.entryTime || activeTrade.entryDate || (exitTime - (safeValue(activeTrade.durationMinutes) * 60 * 1000));

    // Format the time range string
    const formatTime = (time: any) => {
        const d = new Date(time);
        return isNaN(d.getTime()) ? '--:--' : d.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
    };

    const timeRange = `${formatTime(tradeEntryTime)} - ${formatTime(exitTime)}`;
    const holdTime = activeTrade.duration || (Math.round(safeValue(activeTrade.durationMinutes || activeTrade.duration_minutes)) + 'm');
    const status = activeTrade.executionStatus || (activeTrade.isValid === false ? 'Invalid' : 'Valid');
    const isMissed = status === 'Missed';
    const isWin = pnl >= 0;

    const pnlColor = isMissed ? 'text-blue-400' : (isWin ? 'text-emerald-500' : 'text-rose-500');
    const directionColor = isMissed ? 'text-blue-400 bg-blue-500/10 border-blue-500/20' : (activeTrade.direction === 'Long' ? 'text-emerald-500 bg-emerald-500/10 border-emerald-500/20' : 'text-rose-500 bg-rose-500/10 border-rose-500/20');

    const getEmotionDetails = (emoId: string) => emotions.find(e => e.id === emoId) || { label: emoId, icon: '' };

    const Property = ({ label, value, subValue, color, icon: Icon }: { label: string, value: string | number, subValue?: string, color?: string, icon?: any }) => (
        <div className={`py-4 px-1 group/prop border-b ${isDark ? 'border-white/[0.03]' : 'border-slate-100'} last:border-0`}>
            <div className="flex items-center gap-2 mb-1.5 opacity-40 group-hover/prop:opacity-60 transition-opacity">
                {Icon && <Icon size={10} className="text-slate-400" />}
                <span className="text-[8px] font-black uppercase tracking-[0.2em]">{label}</span>
            </div>
            <div>
                <span className={`text-[13px] font-black font-mono tracking-tighter ${color || (isDark ? 'text-slate-200' : 'text-slate-900')}`}>{value}</span>
                {subValue && <p className="text-[8px] font-bold text-slate-500 mt-0.5 uppercase tracking-wide opacity-60">{subValue}</p>}
            </div>
        </div>
    );

    const handleShare = async () => {
        let url = '';
        const isUUID = (id: any) => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
        try {
            if (isUUID(trade.id)) {
                storageService.markTradeAsPublic(trade.id as string).catch(err => console.error("DB Mark Public failed", err));
                url = `${window.location.origin}${window.location.pathname}?shareId=${trade.id}`;
            } else {
                const shareableTrade = { ...trade, screenshot: null, screenshots: [] };
                const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(shareableTrade))));
                url = `${window.location.origin}${window.location.pathname}?share=${encoded}`;
            }
            await navigator.clipboard.writeText(url);
            setShareCopied(true);
            setTimeout(() => setShareCopied(false), 2000);
        } catch (err) {
            console.error("General sharing failure", err);
        }
    };

    const formattedPnL = formatValue(pnl, pnlDisplayMode, initialBalance || accounts.find(a => a.id === activeTrade.accountId)?.initialBalance, (riskAmount > 0) ? pnl / riskAmount : undefined);

    return (
        <ErrorBoundary name="TradeDetailModal">
            <div className="fixed inset-0 z-[110] flex items-center justify-center p-0 md:p-6 lg:p-12 overflow-hidden">
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="absolute inset-0 bg-[#020617]/95 backdrop-blur-2xl"
                    onClick={onClose}
                />

                <motion.div
                    initial={{ opacity: 0, scale: 0.95, y: 20 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95, y: 20 }}
                    className={`relative w-full max-w-[1600px] h-full lg:h-[85vh] rounded-none md:rounded-[40px] overflow-hidden shadow-[0_0_100px_rgba(0,0,0,0.8)] flex flex-col border ${isDark ? 'bg-[#0a0f1d]/80 border-white/10' : 'bg-white/90 border-slate-200'}`}
                >
                    {/* Header */}
                    <div className={`h-20 shrink-0 border-b flex items-center justify-between px-6 md:px-10 z-20 ${isDark ? 'border-white/5 bg-[#0a0f1d]/50' : 'bg-white/50 border-slate-100'} backdrop-blur-md`}>
                        <div className="flex items-center gap-8">
                            <div className="flex items-center gap-4">
                                <h2 className={`text-2xl font-black tracking-tighter uppercase ${isDark ? 'text-white' : 'text-slate-900'}`}>{trade.instrument}</h2>
                                <div className={`px-3 py-1 rounded-full border flex items-center gap-2 ${directionColor}`}>
                                    {isMissed ? <Clock size={12} /> : (trade.direction === 'Long' ? <ArrowUpRight size={14} strokeWidth={3} /> : <ArrowDownRight size={14} strokeWidth={3} />)}
                                    <span className="text-[10px] font-black uppercase tracking-widest">{isMissed ? 'MISSED' : trade.direction}</span>
                                </div>
                            </div>
                            <div className="h-8 w-px bg-white/10 hidden md:block" />
                            <div className="hidden md:flex flex-col">
                                <p className="text-[8px] font-black text-slate-500 uppercase tracking-widest">Transaction Date</p>
                                <p className={`text-[11px] font-bold ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                                    {trade.date ? new Date(trade.date).toLocaleDateString('cs-CZ', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—'}
                                </p>
                            </div>
                        </div>

                        <div className="flex items-center gap-3">
                            <div className="hidden sm:flex items-center gap-1 bg-white/5 p-1 rounded-2xl border border-white/5 mr-4">
                                <button onClick={onPrev} disabled={!hasPrev} className={`p-2 rounded-xl transition-all ${!hasPrev ? 'opacity-10 cursor-not-allowed' : 'hover:bg-white/10 text-slate-400 hover:text-white'}`}><ChevronLeft size={20} /></button>
                                <button onClick={onNext} disabled={!hasNext} className={`p-2 rounded-xl transition-all ${!hasNext ? 'opacity-10 cursor-not-allowed' : 'hover:bg-white/10 text-slate-400 hover:text-white'}`}><ChevronRight size={20} /></button>
                            </div>
                            <button onClick={handleShare} className={`p-3 rounded-2xl transition-all ${shareCopied ? 'bg-emerald-500/20 text-emerald-500' : 'bg-white/5 text-white hover:bg-white/10'}`}>{shareCopied ? <Check size={20} /> : <Share2 size={20} />}</button>
                            <button onClick={(e) => { e.stopPropagation(); setIsDeleteModalOpen(true); }} className="p-3 rounded-2xl bg-rose-500/10 text-rose-500 hover:bg-rose-500 hover:text-white transition-all"><Trash2 size={20} /></button>
                            <button onClick={onClose} className={`p-3 rounded-full transition-all ${isDark ? 'hover:bg-white/10 text-slate-400' : 'hover:bg-slate-100 text-slate-600'}`}><X size={24} /></button>
                        </div>
                    </div>

                    <div className="flex-1 flex flex-col lg:flex-row overflow-hidden relative">
                        {/* LEFT SIDEPANEL: Property Sheet */}
                        <div className={`w-full lg:w-[400px] shrink-0 border-b lg:border-b-0 lg:border-r flex flex-col z-10 ${isDark ? 'border-white/5 bg-[#0a0f1d]/40' : 'border-slate-100 bg-slate-50/40'} backdrop-blur-xl overflow-y-auto no-scrollbar`}>
                            {/* Dominant PnL Card */}
                            <div className="p-8 border-b border-white/5">
                                <p className="text-[10px] font-black text-slate-500 uppercase tracking-[0.3em] mb-3">Profit / Loss</p>
                                <div className="flex items-end justify-between gap-4">
                                    <h3 className={`text-5xl font-black font-mono tracking-tighter leading-none ${pnlColor}`}>{formattedPnL}</h3>
                                    <div className="flex flex-col items-end">
                                        <span className={`text-sm font-black font-mono ${realRRR >= 1 ? 'text-emerald-500' : 'text-slate-500'}`}>{isFinite(realRRR) ? realRRR.toFixed(2) : '0.00'} R</span>
                                        <span className="text-[8px] font-bold text-slate-600 uppercase tracking-widest leading-none mt-1">Reward/Risk</span>
                                    </div>
                                </div>
                            </div>

                            {/* Bento Properties */}
                            <div className="p-8 space-y-2">
                                <div className="grid grid-cols-2 gap-x-8">
                                    <Property label="ENTRY" value={entryPrice || '—'} icon={Target} />
                                    <Property label="EXIT" value={exitPrice || '—'} icon={ArrowRight} />
                                    <Property label="STOP LOSS" value={stopLoss || '—'} color="text-rose-500/80" icon={ShieldCheck} />
                                    <Property label="TAKE PROFIT" value={takeProfit || '—'} color="text-emerald-500/80" icon={Zap} />
                                    <Property label="POSITION" value={activeTrade.positionSize || 1} icon={Layers} />
                                    <Property label="HOLD TIME" value={holdTime} subValue={timeRange.includes('01:00 - 01:00') ? undefined : timeRange} icon={Timer} />
                                </div>

                                <div className="pt-6 space-y-6">
                                    {/* Accounts */}
                                    <div>
                                        <div className="flex items-center justify-between mb-4">
                                            <p className="text-[10px] font-black uppercase text-slate-500 tracking-[0.2em] flex items-center gap-2"><Wallet size={12} /> Execution Flow</p>
                                        </div>
                                        <div className="space-y-2">
                                            {groupTrades.map(gt => {
                                                const acc = accounts.find(a => a.id === gt.accountId);
                                                if (!acc && gt.accountId !== activeTrade.accountId) return null;
                                                const pnlVal = safeValue(gt.pnl);
                                                const isMasterTrade = masterTradeIdInGroup ? gt.id === masterTradeIdInGroup : (gt.isMaster || (!gt.masterTradeId && groupTrades.length > 1 && gt.id === groupTrades[0]?.id));

                                                return (
                                                    <div key={gt.id} className={`p-4 rounded-2xl border flex items-center justify-between transition-all ${isDark ? 'bg-white/[0.03] border-white/5 hover:bg-white/[0.06]' : 'bg-white border-slate-200'}`}>
                                                        <div className="flex items-center gap-3">
                                                            <div className={`w-2 h-2 rounded-full ${acc?.type === 'Funded' ? 'bg-purple-500 shadow-[0_0_12px_rgba(168,85,247,0.5)]' : 'bg-blue-500'}`} />
                                                            <div className="flex flex-col">
                                                                <span className="text-xs font-black uppercase tracking-tight truncate max-w-[140px]">{acc?.name || accountName}</span>
                                                                <div className="flex gap-2">
                                                                    {isMasterTrade && <span className="text-[8px] font-black text-blue-500 uppercase tracking-widest">Master Node</span>}
                                                                    {!isMasterTrade && groupTrades.length > 1 && <span className="text-[8px] font-black text-purple-500 uppercase tracking-widest">Copy Node</span>}
                                                                </div>
                                                            </div>
                                                        </div>
                                                        <span className={`text-xs font-black font-mono ${pnlVal >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>{formatValue(pnlVal)}</span>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>

                                    {/* Psychology & Tags */}
                                    <div className="space-y-4">
                                        <div>
                                            <p className="text-[10px] font-black uppercase text-slate-500 tracking-[0.2em] mb-3 flex items-center gap-2"><Brain size={12} /> Mindset Details</p>
                                            <div className="flex flex-wrap gap-2">
                                                {activeTrade.emotions?.map(e => <span key={e} className="px-3 py-1.5 rounded-xl bg-purple-500/10 border border-purple-500/20 text-purple-400 text-[10px] font-black uppercase tracking-wide">{getEmotionDetails(e).label}</span>)}
                                                {activeTrade.mistakes?.map(m => <span key={m} className="px-3 py-1.5 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-500 text-[10px] font-black uppercase tracking-wide">{m}</span>)}
                                                {!activeTrade.emotions?.length && !activeTrade.mistakes?.length && <span className="text-[10px] text-slate-600 italic">No emotional data</span>}
                                            </div>
                                        </div>
                                    </div>

                                    {/* Notes: Pro Inline Editing */}
                                    <div className="flex flex-col min-h-0 pt-4">
                                        <div className="flex items-center justify-between mb-3">
                                            <p className="text-[10px] font-black uppercase text-slate-500 tracking-[0.2em] flex items-center gap-2"><FileText size={12} /> Execution Log</p>
                                            {!isEditingNotes && (
                                                <button onClick={() => setIsEditingNotes(true)} className="text-[9px] font-black text-blue-500 uppercase tracking-widest hover:underline px-2 py-1">Edit Log</button>
                                            )}
                                        </div>
                                        {isEditingNotes ? (
                                            <div className="space-y-3">
                                                <textarea
                                                    autoFocus
                                                    className={`w-full p-4 rounded-2xl border text-xs font-medium leading-relaxed min-h-[150px] outline-none transition-all ${isDark ? 'bg-black/40 border-blue-500/30 text-white focus:border-blue-500' : 'bg-white border-blue-200 text-slate-900 focus:border-blue-500'}`}
                                                    value={editedNotes}
                                                    onChange={(e) => setEditedNotes(e.target.value)}
                                                    placeholder="Log details..."
                                                />
                                                <div className="flex justify-end gap-2">
                                                    <button onClick={() => { setIsEditingNotes(false); setEditedNotes(activeTrade.notes || ''); }} className={`px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest ${isDark ? 'text-slate-500 hover:text-white' : 'text-slate-400 hover:text-slate-900'}`}>Cancel</button>
                                                    <button onClick={handleSaveNotes} className="px-4 py-2 bg-blue-600 text-white rounded-xl text-[10px] font-black uppercase tracking-widest flex items-center gap-2 hover:bg-blue-500 transition-colors">
                                                        <Save size={12} /> Save Updates
                                                    </button>
                                                </div>
                                            </div>
                                        ) : (
                                            <div
                                                onClick={() => setIsEditingNotes(true)}
                                                className={`p-5 rounded-2xl border text-xs font-medium leading-[1.8] cursor-text transition-all ${isDark ? 'bg-black/30 border-white/5 text-slate-400 hover:border-white/10' : 'bg-white border-slate-100 text-slate-600 hover:border-slate-200'}`}
                                            >
                                                {activeTrade.notes || "Add execution log entry..."}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* RIGHT: THE CANVAS (Screenshot) */}
                        <div className={`flex-1 relative group overflow-hidden ${isDark ? 'bg-black/40' : 'bg-slate-100/50'}`}>
                            <AnimatePresence mode="wait">
                                {images.length > 0 ? (
                                    <motion.div
                                        key={images[activeImageIndex]}
                                        initial={{ opacity: 0, scale: 0.98 }}
                                        animate={{ opacity: 1, scale: 1 }}
                                        exit={{ opacity: 0, scale: 1.02 }}
                                        transition={{ duration: 0.4, ease: "easeOut" }}
                                        className="w-full h-full flex items-center justify-center p-8 lg:p-16"
                                    >
                                        <div className="relative max-w-full max-h-full">
                                            <img
                                                src={images[activeImageIndex]}
                                                className="max-w-full max-h-full object-contain rounded-3xl shadow-[0_50px_100px_-20px_rgba(0,0,0,0.6)] cursor-zoom-in group-hover:scale-[1.02] transition-transform duration-700"
                                                onClick={() => setIsZoomed(true)}
                                            />
                                            {/* Floating Zoom Button */}
                                            <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                                                <div className="p-6 bg-white/10 backdrop-blur-md rounded-full text-white border border-white/20 shadow-2xl pointer-events-auto cursor-pointer hover:scale-110 transition-transform" onClick={() => setIsZoomed(true)}>
                                                    <Maximize2 size={32} />
                                                </div>
                                            </div>
                                        </div>
                                    </motion.div>
                                ) : (
                                    <div className="w-full h-full flex flex-col items-center justify-center opacity-10 text-slate-500 p-20 text-center">
                                        <div className="p-10 rounded-[40px] border-2 border-dashed border-slate-500">
                                            <ImageIcon size={64} strokeWidth={1} />
                                        </div>
                                        <p className="text-xl font-black uppercase tracking-[0.4em] mt-10">NO VISUAL DATA</p>
                                        <p className="text-[10px] font-bold mt-2 opacity-60">Visual evidence not submitted for this transaction.</p>
                                    </div>
                                )}
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
                <ImageZoomModal src={images[activeImageIndex]} onClose={() => setIsZoomed(false)} />
            )}
        </ErrorBoundary>
    );
};

export default TradeDetailModal;
