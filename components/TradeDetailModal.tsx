
import React, { useState } from 'react';
import { Play } from 'lucide-react';
import { Trade, Account, CustomEmotion } from '../types';
import { storageService } from '../services/storageService';
import {
    X, Edit3, Trash2, Clock, Image as ImageIcon,
    Maximize2, ArrowRight, Timer, Terminal, ArrowUpRight, ArrowDownRight,
    Share2, Check, ChevronLeft, ChevronRight, Zap, Brain, FileText, Monitor
} from 'lucide-react';
import TradeReplay from './TradeReplay';
import { ErrorBoundary } from './ErrorBoundary';

interface TradeDetailModalProps {
    trade: Trade;
    accountName: string;
    theme: 'dark' | 'light' | 'oled';
    onClose: () => void;
    onEdit: () => void;
    onDelete: () => void;
    emotions: CustomEmotion[];
    onPrev?: () => void;
    onNext?: () => void;
    hasPrev?: boolean;
    hasNext?: boolean;
}

const TradeDetailModal: React.FC<TradeDetailModalProps> = ({
    trade, accountName, theme, onClose, onEdit, onDelete, emotions, onPrev, onNext, hasPrev, hasNext
}) => {
    const isDark = theme !== 'light';
    const [isZoomed, setIsZoomed] = useState(false);
    const [activeImageIndex, setActiveImageIndex] = useState(0);
    const [shareCopied, setShareCopied] = useState(false);
    const [showReplayFullscreen, setShowReplayFullscreen] = useState(false);

    const images = trade.screenshots && trade.screenshots.length > 0
        ? trade.screenshots
        : (trade.screenshot ? [trade.screenshot] : []);

    const entryPrice = parseFloat(String(trade.entryPrice || 0));
    const exitPrice = parseFloat(String(trade.exitPrice || 0));
    const stopLoss = parseFloat(String(trade.stopLoss || 0));
    const takeProfit = parseFloat(String(trade.takeProfit || 0));
    const riskAmount = parseFloat(String(trade.riskAmount || 0));

    const realRRR = (riskAmount !== 0 && riskAmount !== undefined) ? (trade.pnl / riskAmount).toFixed(2) : 'N/A';
    const holdTime = trade.duration || (Math.round(trade.durationMinutes || 0) + 'm');

    const status = trade.executionStatus || (trade.isValid === false ? 'Invalid' : 'Valid');
    const isMissed = status === 'Missed';
    const isWin = trade.pnl >= 0;

    const pnlColor = isMissed ? 'text-blue-400' : (isWin ? 'text-emerald-500' : 'text-rose-500');
    const directionColor = isMissed ? 'text-blue-400 bg-blue-500/10 border-blue-500/20' : (trade.direction === 'Long' ? 'text-emerald-500 bg-emerald-500/10 border-emerald-500/20' : 'text-rose-500 bg-rose-500/10 border-rose-500/20');

    const getEmotionDetails = (emoId: string) => emotions.find(e => e.id === emoId) || { label: emoId };

    const MetricCell = ({ label, value, color }: { label: string, value: string | number, color?: string }) => (
        <div className={`p-3 md:p-4 border-r border-b ${isDark ? 'border-white/5' : 'border-slate-100'} flex flex-col justify-center`}>
            <span className="text-[8px] md:text-[9px] font-black uppercase text-slate-500 tracking-wider mb-0.5 md:mb-1">{label}</span>
            <span className={`text-xs md:text-sm font-black font-mono tracking-tight ${color || (isDark ? 'text-white' : 'text-slate-900')}`}>{value}</span>
        </div>
    );

    const handleShare = async () => {
        let url = '';
        const isUUID = (id: any) => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

        try {
            if (isUUID(trade.id)) {
                storageService.markTradeAsPublic(trade.id as string).catch(err => {
                    console.error("DB Mark Public failed", err);
                });
                url = `${window.location.origin}${window.location.pathname}?shareId=${trade.id}`;
            } else {
                const shareableTrade = { ...trade, screenshot: null, screenshots: [] };
                const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(shareableTrade))));
                url = `${window.location.origin}${window.location.pathname}?share=${encoded}`;
            }

            try {
                await navigator.clipboard.writeText(url);
                setShareCopied(true);
                setTimeout(() => setShareCopied(false), 2000);
            } catch (clipErr) {
                console.warn("Auto-copy blocked by browser, showing link manually", clipErr);
                window.prompt("Odkaz ke sdílení (zkopíruj pomocí CTRL+C):", url);
            }
        } catch (err) {
            console.error("General sharing failure", err);
            if (url) window.prompt("Odkaz ke sdílení:", url);
            else alert("Nepodařilo se vygenerovat odkaz.");
        }
    };

    return (
        <>
            <div className="fixed inset-0 z-[110] flex items-center justify-center p-2 md:p-4 bg-[var(--bg-page)]/80 backdrop-blur-xl animate-in fade-in duration-300">
                <div className={`w-full max-w-7xl h-[95vh] md:h-[85vh] rounded-[24px] md:rounded-[32px] overflow-hidden shadow-2xl flex flex-col border ${isDark ? 'bg-[var(--bg-card)] border-[var(--border-subtle)]' : 'bg-white border-slate-200'}`}>

                    <div className={`min-h-[80px] h-auto md:h-20 shrink-0 border-b flex flex-wrap items-center justify-between px-4 md:px-8 py-3 md:py-0 ${isDark ? 'border-[var(--border-subtle)] bg-[var(--bg-card)]' : 'bg-white border-slate-100'}`}>
                        <div className="flex items-center gap-3 md:gap-6">
                            {(onPrev || onNext) && (
                                <div className="flex items-center gap-1 bg-slate-500/5 rounded-xl p-1 border border-white/5 mr-2">
                                    <button
                                        onClick={onPrev}
                                        disabled={!hasPrev}
                                        className={`p-1.5 rounded-lg transition-all ${!hasPrev ? 'opacity-10 cursor-not-allowed' : 'hover:bg-white/10 active:scale-95 text-slate-400 hover:text-white'}`}
                                    >
                                        <ChevronLeft size={20} />
                                    </button>
                                    <button
                                        onClick={onNext}
                                        disabled={!hasNext}
                                        className={`p-1.5 rounded-lg transition-all ${!hasNext ? 'opacity-10 cursor-not-allowed' : 'hover:bg-white/10 active:scale-95 text-slate-400 hover:text-white'}`}
                                    >
                                        <ChevronRight size={20} />
                                    </button>
                                </div>
                            )}

                            <div className={`px-2 md:px-3 py-1 md:py-1.5 rounded-lg border flex items-center gap-1.5 md:gap-2 ${directionColor}`}>
                                {isMissed ? <Clock size={12} /> : (trade.direction === 'Long' ? <ArrowUpRight size={14} strokeWidth={3} /> : <ArrowDownRight size={14} strokeWidth={3} />)}
                                <span className="text-[8px] md:text-[10px] font-black uppercase tracking-widest">{isMissed ? 'Zmeškáno' : trade.direction}</span>
                            </div>
                            <div>
                                <h2 className={`text-sm md:text-lg font-black tracking-tighter uppercase ${isDark ? 'text-white' : 'text-slate-900'}`}>{trade.instrument}</h2>
                                <div className="flex items-center gap-2">
                                    <p className="text-[8px] md:text-[9px] font-bold text-slate-500 uppercase tracking-widest">{new Date(trade.date).toLocaleString('cs-CZ', { dateStyle: 'short', timeStyle: 'short' })}</p>
                                    {trade.phase && (
                                        <span className={`px-1.5 py-0.5 rounded text-[7px] font-black tracking-widest border ${trade.phase === 'Funded'
                                            ? 'bg-purple-500/10 text-purple-400 border-purple-500/20'
                                            : 'bg-amber-500/10 text-amber-500 border-amber-500/20'
                                            }`}>
                                            {trade.phase.toUpperCase()}
                                        </span>
                                    )}
                                </div>
                            </div>
                        </div>

                        <div className={`text-xl md:text-3xl font-black font-mono tracking-tighter ${pnlColor} mx-2`}>
                            {isMissed ? '±' : (isWin ? '+' : '-')}${Math.abs(trade.pnl).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                        </div>

                        <div className="flex items-center gap-2 md:gap-3 ml-auto md:ml-0 mt-2 md:mt-0">
                            <button
                                onClick={() => setShowReplayFullscreen(true)}
                                className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-600 text-white hover:bg-indigo-500 transition-all shadow-lg shadow-indigo-500/20 active:scale-95 group"
                                title="Vstoupit do hloubkové analýzy"
                            >
                                <Play size={16} fill="currentColor" className="group-hover:translate-x-0.5 transition-transform" />
                                <span className="font-black text-[10px] uppercase tracking-widest hidden sm:inline">Replay</span>
                            </button>
                            <div className="h-6 md:h-8 w-px bg-slate-800 mx-0.5 md:mx-1"></div>
                            <button
                                onClick={handleShare}
                                className={`p-2 md:p-2.5 rounded-xl transition-all flex items-center gap-1 md:gap-2 ${shareCopied ? 'bg-emerald-500/20 text-emerald-500' : 'bg-blue-500/10 text-blue-500 hover:bg-blue-600 hover:text-white'}`}
                                title="Sdílet"
                            >
                                {shareCopied ? <Check size={14} /> : <Share2 size={14} />}
                                {shareCopied && <span className="text-[8px] font-black uppercase hidden sm:inline">Zkopírováno</span>}
                            </button>
                            <button onClick={onEdit} className="p-2 md:p-2.5 rounded-xl bg-slate-500/10 text-slate-500 hover:bg-slate-600 hover:text-white transition-all"><Edit3 size={16} /></button>
                            <button
                                onClick={(e) => { e.stopPropagation(); if (window.confirm("Smazat?")) onDelete(); }}
                                className="p-2 md:p-2.5 rounded-xl bg-rose-500/10 text-rose-500 hover:bg-rose-600 hover:text-white transition-all"
                            >
                                <Trash2 size={16} />
                            </button>
                            <div className="h-6 md:h-8 w-px bg-slate-800 mx-0.5 md:mx-1"></div>
                            <button onClick={onClose} className="p-2 md:p-2.5 hover:bg-white/10 rounded-full transition-all text-slate-500 hover:text-white"><X size={20} /></button>
                        </div>
                    </div>

                    {/* Main Split Content Area */}
                    <div className="flex-1 grid grid-cols-1 md:grid-cols-[320px_1fr] xl:grid-cols-[400px_1fr] overflow-hidden">

                        {/* Left Sidebar: Metrics + Screenshots */}
                        <div className={`flex flex-col overflow-y-auto custom-scrollbar border-r ${isDark ? 'bg-[var(--bg-card)]/50 border-[var(--border-subtle)]' : 'bg-slate-50 border-slate-200'}`}>

                            <div className={`grid grid-cols-2 border-b ${isDark ? 'border-[var(--border-subtle)] bg-[var(--bg-card)]' : 'border-slate-200 bg-white'}`}>
                                <MetricCell label="Vstupní cena" value={entryPrice || '-'} />
                                <MetricCell label="Výstupní cena" value={exitPrice || '-'} />
                                <MetricCell label="Stop Loss" value={stopLoss || '-'} color="text-rose-500" />
                                <MetricCell label="Take Profit" value={takeProfit || '-'} color="text-emerald-500" />
                                <MetricCell label="Velikost (Jednotky)" value={trade.positionSize || 1} />
                                <MetricCell label="Doba držení" value={holdTime} color="text-blue-400" />
                                <MetricCell label="Riziko ($)" value={`$${riskAmount}`} color="text-slate-400" />
                                <MetricCell label="Realizované RRR" value={`${realRRR}R`} color={isWin ? (parseFloat(realRRR) > 1 ? 'text-emerald-500' : 'text-slate-400') : 'text-rose-500'} />
                            </div>

                            <div className="p-4 md:p-6 space-y-4 md:space-y-6">
                                <div className="space-y-2 md:space-y-3">
                                    <p className="text-[8px] md:text-[9px] font-black uppercase text-slate-500 tracking-widest flex items-center gap-2"><Monitor size={12} /> Kontext a Soutoky</p>
                                    <div className="flex flex-wrap gap-1.5 md:gap-2">
                                        {trade.htfConfluence?.length ? trade.htfConfluence.map(t => <span key={t} className="px-1.5 md:px-2 py-0.5 md:py-1 rounded-md bg-blue-500/10 border border-blue-500/20 text-blue-400 text-[8px] md:text-[9px] font-bold uppercase">{t}</span>) : <span className="text-[9px] md:text-[10px] text-slate-600 italic">Žádná HTF data</span>}
                                        {trade.ltfConfluence?.length ? trade.ltfConfluence.map(t => <span key={t} className="px-1.5 md:px-2 py-0.5 md:py-1 rounded-md bg-amber-500/10 border border-amber-500/20 text-amber-500 text-[8px] md:text-[9px] font-bold uppercase">{t}</span>) : null}
                                    </div>
                                </div>

                                <div className="space-y-2 md:space-y-3">
                                    <p className="text-[8px] md:text-[9px] font-black uppercase text-slate-500 tracking-widest flex items-center gap-2"><Brain size={12} /> Psychologie a Chyby</p>
                                    <div className="flex flex-wrap gap-1.5 md:gap-2">
                                        {trade.emotions?.length ? trade.emotions.map(e => {
                                            const det = getEmotionDetails(e);
                                            return <span key={e} className="px-1.5 md:px-2 py-0.5 md:py-1 rounded-md bg-purple-500/10 border border-purple-500/20 text-purple-400 text-[8px] md:text-[9px] font-bold uppercase">{det.label}</span>
                                        }) : <span className="text-[9px] md:text-[10px] text-slate-600 italic">Neutrální stav</span>}
                                        {trade.mistakes?.length ? trade.mistakes.map(m => <span key={m} className="px-1.5 md:px-2 py-0.5 md:py-1 rounded-md bg-rose-500/10 border border-rose-500/20 text-rose-500 text-[8px] md:text-[9px] font-bold uppercase">{m}</span>) : null}
                                    </div>
                                </div>

                                <div className="space-y-2 md:space-y-3">
                                    <p className="text-[8px] md:text-[9px] font-black uppercase text-slate-500 tracking-widest flex items-center gap-2"><FileText size={12} /> Poznámky k protokolu</p>
                                    <div className={`p-3 md:p-4 rounded-xl border text-[10px] md:text-xs font-medium leading-relaxed ${isDark ? 'bg-black/20 border-white/5 text-slate-300' : 'bg-white border-slate-200 text-slate-700'}`}>
                                        {trade.notes || "Žádné poznámky k tomuto obchodu."}
                                    </div>
                                </div>
                            </div>

                            {/* Screenshots (Moved to Left Sidebar) */}
                            <div className={`flex-1 relative flex flex-col min-h-[250px] border-t ${isDark ? 'border-[var(--border-subtle)]' : 'border-slate-200'}`}>
                                <div className="flex-1 relative flex items-center justify-center overflow-hidden group bg-black/5">
                                    {images.length > 0 ? (
                                        <>
                                            <img src={images[activeImageIndex]} className="w-full h-full object-contain" />
                                            <div className="absolute top-4 right-4 flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                                <button onClick={() => setIsZoomed(true)} className="p-2 rounded-xl bg-black/50 backdrop-blur-md text-white border border-white/10 hover:bg-blue-600 transition-colors shadow-xl">
                                                    <Maximize2 size={16} />
                                                </button>
                                            </div>
                                        </>
                                    ) : (
                                        <div className="text-center opacity-30">
                                            <ImageIcon size={48} className="mx-auto mb-2 text-slate-500" />
                                            <p className="text-[8px] font-black uppercase tracking-[0.2em] text-slate-500">Bez náhledu</p>
                                        </div>
                                    )}
                                </div>

                                {images.length > 1 && (
                                    <div className={`h-16 border-t shrink-0 flex items-center gap-2 px-2 overflow-x-auto no-scrollbar ${isDark ? 'bg-[var(--bg-card)] border-[var(--border-subtle)]' : 'bg-white border-slate-200'}`}>
                                        {images.map((src, i) => (
                                            <div
                                                key={i}
                                                onClick={() => setActiveImageIndex(i)}
                                                className={`h-10 aspect-video rounded border overflow-hidden cursor-pointer transition-all flex-shrink-0 ${activeImageIndex === i ? 'ring-2 ring-blue-500 opacity-100' : 'opacity-50 hover:opacity-100'}`}
                                            >
                                                <img src={src} className="w-full h-full object-cover" />
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>
                        {/* Right Panel: Interactive Chart */}
                        <div className={`relative h-full w-full overflow-hidden ${isDark ? 'bg-[var(--bg-page)]' : 'bg-slate-100'}`}>
                            <ErrorBoundary name="TradeReplay">
                                <TradeReplay
                                    trade={trade}
                                    theme={theme}
                                    onClose={() => { }}
                                    embedded={true}
                                    minimal={true}
                                />
                            </ErrorBoundary>
                        </div>
                    </div>
                </div>
            </div>


            {isZoomed && images.length > 0 && (
                <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/98 backdrop-blur-3xl p-4 md:p-6 animate-in fade-in duration-300" onClick={() => setIsZoomed(false)}>
                    <button className="absolute top-4 md:top-10 right-4 md:right-10 p-3 md:p-5 bg-white/10 hover:bg-white/10 rounded-full transition-all border border-white/10 text-white"><X size={32} /></button>
                    <img src={images[activeImageIndex]} className="max-w-full max-h-full object-contain rounded-[16px] md:rounded-[32px] shadow-[0_0_100px_rgba(59,130,246,0.15)] border border-white/10" onClick={e => e.stopPropagation()} />
                </div>
            )}

            {showReplayFullscreen && (
                <div className="fixed inset-0 z-[300] bg-black/95 backdrop-blur-3xl animate-in fade-in duration-500">
                    <TradeReplay
                        trade={trade}
                        theme={theme}
                        onClose={() => setShowReplayFullscreen(false)}
                        minimal={false}
                        embedded={false}
                    />
                </div>
            )}

        </>
    );
};

export default TradeDetailModal;
