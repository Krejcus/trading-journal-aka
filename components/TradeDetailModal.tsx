
import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Play } from 'lucide-react';
import { Trade, Account, CustomEmotion, PnLDisplayMode, User } from '../types';
import { formatPnL } from '../utils/formatPnL';
import { ExchangeRates } from '../services/currencyService';
import { storageService } from '../services/storageService';
import {
    X, Edit3, Trash2, Clock, Image as ImageIcon,
    Maximize2, ArrowRight, Timer, Terminal, ArrowUpRight, ArrowDownRight,
    Share2, Check, ChevronLeft, ChevronRight, Zap, Brain, FileText, Monitor, Target,
    ShieldCheck, Layers, Wallet
} from 'lucide-react';
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

    const DataTile = ({ label, value, subValue, color, icon: Icon }: { label: string, value: string | number, subValue?: string, color?: string, icon?: any }) => (
        <div className={`p-2.5 border-r border-b ${isDark ? 'border-white/5 bg-white/[0.01]' : 'border-slate-100 bg-slate-50/30'} flex flex-col justify-between`}>
            <div className="flex items-center gap-1 opacity-40">
                {Icon && <Icon size={8} />}
                <span className="text-[7px] font-black uppercase tracking-[0.15em]">{label}</span>
            </div>
            <div className="mt-1">
                <span className={`text-[11px] font-black font-mono tracking-tighter ${color || (isDark ? 'text-slate-200' : 'text-slate-900')}`}>{value}</span>
                {subValue && <p className="text-[7px] font-medium text-slate-500 mt-0.5">{subValue}</p>}
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
            <div className="fixed inset-0 z-[110] flex items-center justify-center p-0 md:p-6 bg-[#020617]/90 backdrop-blur-2xl animate-in fade-in duration-500">
                <div className={`w-full max-w-[1400px] h-full lg:h-full max-h-[100dvh] lg:max-h-[850px] rounded-none md:rounded-[32px] overflow-hidden shadow-[0_0_100px_rgba(0,0,0,1)] flex flex-col border ${isDark ? 'bg-[#0a0f1d] border-white/10' : 'bg-white border-slate-200'}`}>

                    {/* Header: Terminal Style */}
                    <div className={`h-16 shrink-0 border-b flex items-center justify-between px-3 md:px-6 ${isDark ? 'border-white/5 bg-[#0a0f1d]' : 'bg-white border-slate-100'}`}>
                        <div className="flex items-center gap-2 md:gap-6">
                            <div className="hidden sm:flex items-center gap-1.5 bg-white/5 p-1 rounded-xl border border-white/5">
                                <button onClick={onPrev} disabled={!hasPrev} className={`p-1.5 rounded-lg transition-all ${!hasPrev ? 'opacity-10 cursor-not-allowed' : 'hover:bg-white/10 text-slate-400 hover:text-white'}`}><ChevronLeft size={18} /></button>
                                <button onClick={onNext} disabled={!hasNext} className={`p-1.5 rounded-lg transition-all ${!hasNext ? 'opacity-10 cursor-not-allowed' : 'hover:bg-white/10 text-slate-400 hover:text-white'}`}><ChevronRight size={18} /></button>
                            </div>
                            <div className={`px-2 py-1 rounded-lg border flex items-center gap-1.5 ${directionColor}`}>
                                {isMissed ? <Clock size={10} /> : (trade.direction === 'Long' ? <ArrowUpRight size={12} strokeWidth={3} /> : <ArrowDownRight size={12} strokeWidth={3} />)}
                                <span className="text-[8px] md:text-[9px] font-black uppercase tracking-widest">{isMissed ? 'ZMEŠKÁNO' : trade.direction}</span>
                            </div>
                            <div className="min-w-0">
                                <h2 className={`text-sm md:text-base font-black tracking-tighter uppercase truncate ${isDark ? 'text-white' : 'text-slate-900'}`}>{trade.instrument}</h2>
                                <div className="flex items-center gap-2">
                                    <p className="text-[7px] md:text-[8px] font-bold text-slate-500 uppercase tracking-widest truncate">
                                        {trade.date ? new Date(trade.date).toLocaleDateString('cs-CZ', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—'}
                                    </p>
                                    {trade.date && !(() => {
                                        const d = new Date(trade.date);
                                        const t = d.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
                                        return t === '01:00' || t === '00:00';
                                    })() && (
                                            <span className="text-[7px] md:text-[8px] font-mono font-black text-blue-500/50 bg-blue-500/5 px-1.5 py-0.5 rounded border border-blue-500/10">
                                                {new Date(trade.date).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' })}
                                            </span>
                                        )}
                                </div>
                            </div>
                        </div>

                        <div className="flex items-center gap-2 md:gap-4">
                            <div className="text-right hidden xs:block">
                                <p className={`text-lg md:text-2xl font-black font-mono tracking-tighter leading-none ${pnlColor}`}>
                                    {formattedPnL}
                                </p>
                                <p className="text-[7px] font-black text-slate-500 uppercase tracking-widest mt-1">PROFIT / LOSS</p>
                            </div>
                            <div className="h-8 w-px bg-white/10 mx-1 md:mx-2 hidden xs:block" />
                            <div className="flex gap-1 md:gap-2">
                                <button onClick={handleShare} className={`p-2 md:p-2.5 rounded-xl transition-all ${shareCopied ? 'bg-emerald-500/20 text-emerald-500' : 'bg-white/5 text-white hover:bg-white/10'}`}>{shareCopied ? <Check size={16} /> : <Share2 size={16} />}</button>
                                <button onClick={(e) => { e.stopPropagation(); setIsDeleteModalOpen(true); }} className="p-2 md:p-2.5 rounded-xl bg-rose-500/10 text-rose-500 hover:bg-rose-500 hover:text-white transition-all"><Trash2 size={16} /></button>
                                <button onClick={onClose} className="p-2 md:p-2.5 hover:bg-white/10 rounded-full text-slate-500 transition-all"><X size={20} /></button>
                            </div>
                        </div>
                    </div>

                    <ConfirmationModal
                        isOpen={isDeleteModalOpen}
                        onClose={() => setIsDeleteModalOpen(false)}
                        onConfirm={onDelete}
                        title="Smazat obchod"
                        message="Opravdu chcete tento obchod trvale odstranit z Alpha Matrixu? Tuto akci nelze vrátit."
                        theme={theme}
                    />

                    {/* Main Content: Scrollable on mobile, flex-row on desktop */}
                    <div className="flex-1 flex flex-col lg:flex-row overflow-y-auto lg:overflow-hidden">

                        {/* LEFT: DATA MATRIX */}
                        <div className={`w-full lg:w-[360px] xl:w-[420px] shrink-0 border-b lg:border-b-0 lg:border-r flex flex-col ${isDark ? 'border-white/5 bg-[#0a0f1d]' : 'border-slate-100 bg-slate-50/20'}`}>

                            {/* Matrix Grid */}
                            <div className="grid grid-cols-2 border-b border-white/5">
                                <DataTile label="ENTRY" value={entryPrice || '—'} icon={ArrowRight} />
                                <DataTile label="EXIT" value={exitPrice || '—'} icon={ArrowRight} />
                                <DataTile label="STOP LOSS" value={stopLoss || '—'} color="text-rose-500" icon={ShieldCheck} />
                                <DataTile label="TAKE PROFIT" value={takeProfit || '—'} color="text-emerald-500" icon={Target} />
                                <DataTile label="QUANTITY" value={activeTrade.positionSize || 1} icon={Layers} />
                                <DataTile label="DURATION" value={holdTime} subValue={timeRange.includes('01:00 - 01:00') || timeRange.includes('00:00 - 00:00') ? undefined : timeRange} icon={Timer} />
                                <DataTile label="RISK AMOUNT" value={formatValue(riskAmount, 'usd')} color="text-slate-400" />
                                <DataTile label="RR RATIO" value={`${isFinite(realRRR) ? realRRR.toFixed(2) : '0.00'} R`} color={realRRR >= 1 ? 'text-emerald-500' : 'text-slate-400'} />
                            </div>

                            {/* Accounts Stack */}
                            <div className="p-5 border-b border-white/5">
                                <div className="flex items-center justify-between mb-3 text-[8px] font-black uppercase text-slate-500 tracking-widest">
                                    <div className="flex items-center gap-1.5"><Wallet size={10} /> Active Accounts</div>
                                    <span className="text-white/20">Distribution</span>
                                </div>
                                <div className="space-y-2">
                                    {groupTrades.map(gt => {
                                        const acc = accounts.find(a => a.id === gt.accountId);
                                        if (!acc && gt.accountId !== activeTrade.accountId) return null;

                                        const pnlVal = safeValue(gt.pnl);
                                        const accName = acc?.name || (gt.accountId === activeTrade.accountId ? accountName : 'Unknown Account');

                                        const isMasterTrade = masterTradeIdInGroup ? gt.id === masterTradeIdInGroup : (gt.isMaster || (!gt.masterTradeId && groupTrades.length > 1 && gt.id === groupTrades[0]?.id));
                                        const isCopyTrade = !isMasterTrade && groupTrades.length > 1;

                                        return (
                                            <div key={gt.id} className={`p-2 rounded-xl border flex items-center justify-between transition-all ${isDark ? 'bg-white/5 border-white/5 hover:bg-white/10' : 'bg-white border-slate-200'}`}>
                                                <div className="flex items-center gap-2">
                                                    <div className={`w-1.5 h-1.5 rounded-full ${acc?.type === 'Funded' ? 'bg-purple-500 shadow-[0_0_8px_rgba(168,85,247,0.5)]' : 'bg-blue-500'}`} />
                                                    <span className="text-[10px] font-black uppercase tracking-tight truncate max-w-[120px]">{accName}</span>
                                                    {isMasterTrade && (
                                                        <span className="px-1.5 py-0.5 bg-blue-600/20 text-blue-400 rounded text-[7px] font-black tracking-widest border border-blue-500/30">MASTER</span>
                                                    )}
                                                    {isCopyTrade && (
                                                        <span className="px-1.5 py-0.5 bg-purple-600/20 text-purple-400 rounded text-[7px] font-black tracking-widest border border-purple-500/30">COPY</span>
                                                    )}
                                                </div>
                                                <span className={`text-[10px] font-mono font-bold ${pnlVal >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                                    {formatValue(pnlVal)}
                                                </span>
                                            </div>
                                        );
                                    })}
                                    {groupTrades.length === 0 && (
                                        <div className="text-[9px] text-slate-600 italic px-1">Source: {accountName}</div>
                                    )}
                                </div>
                            </div>

                            {/* Strategy & Context */}
                            <div className="flex-1 p-5 space-y-5 overflow-hidden">
                                <div>
                                    <p className="text-[8px] font-black uppercase text-slate-500 tracking-widest mb-2 flex items-center gap-1.5"><Monitor size={10} /> Structure & Strategy</p>
                                    <div className="flex flex-wrap gap-1.5">
                                        {activeTrade.htfConfluence?.map(t => <span key={t} className="px-2 py-1 rounded-md bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 text-[8px] font-black uppercase">{t}</span>)}
                                        {activeTrade.ltfConfluence?.map(t => <span key={t} className="px-2 py-1 rounded-md bg-blue-500/10 border border-blue-500/20 text-blue-400 text-[8px] font-black uppercase">{t}</span>)}
                                        {(!activeTrade.htfConfluence?.length && !activeTrade.ltfConfluence?.length) && <span className="text-[9px] text-slate-600 italic">No tags detected</span>}
                                    </div>
                                </div>

                                <div>
                                    <p className="text-[8px] font-black uppercase text-slate-500 tracking-widest mb-2 flex items-center gap-1.5"><Brain size={10} /> Psychology Grade</p>
                                    <div className="flex flex-wrap gap-1.5">
                                        {activeTrade.emotions?.map(e => (
                                            <span key={e} className="px-2 py-1 rounded-md bg-purple-500/10 border border-purple-500/20 text-purple-400 text-[8px] font-black uppercase">{getEmotionDetails(e).label}</span>
                                        ))}
                                        {activeTrade.mistakes?.map(m => (
                                            <span key={m} className="px-2 py-1 rounded-md bg-rose-500/10 border border-rose-500/20 text-rose-500 text-[8px] font-black uppercase">{m}</span>
                                        ))}
                                        {!activeTrade.emotions?.length && !activeTrade.mistakes?.length && <span className="text-[9px] text-slate-600 italic">Emotional state: Flat</span>}
                                    </div>
                                </div>

                                <div className="flex-1 flex flex-col min-h-0">
                                    <p className="text-[8px] font-black uppercase text-slate-500 tracking-widest mb-2 flex items-center gap-1.5"><FileText size={10} /> Terminal Log</p>
                                    <div className={`p-3 rounded-xl border text-[10px] font-medium leading-[1.6] flex-1 overflow-y-auto no-scrollbar ${isDark ? 'bg-black/40 border-white/5 text-slate-400' : 'bg-white border-slate-100 text-slate-600'}`}>
                                        {activeTrade.notes || "No log entry for this execution."}
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* RIGHT: SCREENSHOT AREA */}
                        <div className={`flex-1 relative group overflow-hidden min-h-[400px] lg:min-h-0 ${isDark ? 'bg-black/20' : 'bg-slate-100/50'}`}>
                            {images.length > 0 ? (
                                <div className="w-full h-full flex flex-col">
                                    <div className="flex-1 relative p-4 flex items-center justify-center">
                                        <img
                                            src={images[activeImageIndex]}
                                            className="max-w-full max-h-full object-contain rounded-xl shadow-[0_30px_60px_-12px_rgba(0,0,0,0.5)] cursor-zoom-in group-hover:scale-[1.01] transition-transform duration-500"
                                            onClick={() => setIsZoomed(true)}
                                        />
                                        <button
                                            onClick={() => setIsZoomed(true)}
                                            className="absolute bottom-10 left-1/2 -translate-x-1/2 px-5 py-2.5 rounded-2xl bg-black/60 backdrop-blur-md border border-white/10 text-white text-[10px] font-black uppercase tracking-widest opacity-0 group-hover:opacity-100 transition-all hover:bg-indigo-600"
                                        >
                                            View Fullscreen
                                        </button>
                                    </div>

                                    {/* Thumbnail Reel (Horizontal) */}
                                    {images.length > 1 && (
                                        <div className="h-20 shrink-0 flex items-center justify-center gap-3 p-4 bg-black/10">
                                            {images.map((src, i) => (
                                                <button
                                                    key={i}
                                                    onClick={() => setActiveImageIndex(i)}
                                                    className={`h-12 aspect-video rounded-lg overflow-hidden border-2 transition-all ${activeImageIndex === i ? 'border-indigo-500 scale-105 shadow-lg' : 'border-transparent opacity-40 hover:opacity-100'}`}
                                                >
                                                    <img src={src} className="w-full h-full object-cover" />
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <div className="w-full h-full flex flex-col items-center justify-center opacity-20 text-slate-500">
                                    <ImageIcon size={64} strokeWidth={1} />
                                    <p className="text-[10px] font-black uppercase tracking-[0.3em] mt-6">NO VISUAL DATA</p>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            {/* Zoom Layer */}
            {isZoomed && images.length > 0 && (
                <ImageZoomModal src={images[activeImageIndex]} onClose={() => setIsZoomed(false)} />
            )}
        </ErrorBoundary>
    );
};

export default TradeDetailModal;
