
import React, { useState } from 'react';
import { Trade, Account, CustomEmotion } from '../types';
import { storageService } from '../services/storageService';
import {
  Trash2, TrendingUp, TrendingDown, X, Edit3, Calendar,
  Tag, Clock, DollarSign, FileText, Image as ImageIcon,
  ChevronRight, ChevronLeft, Wallet, Target, AlertTriangle, AlertCircle, Brain,
  ShieldCheck, ShieldAlert, BarChart3, Activity, Zap, Monitor,
  Maximize2, ArrowRight, Timer, Gauge, Hash, Ruler, Percent,
  Compass, Hourglass, Cpu, Terminal, Layers, ArrowUpRight, ArrowDownRight,
  Share2, Check, Copy
} from 'lucide-react';

interface TradeHistoryProps {
  trades: Trade[];
  accounts: Account[];
  onDelete: (id: number | string) => void;
  onEdit: (trade: Trade) => void;
  onClear: () => void;
  theme: 'dark' | 'light';
  emotions: CustomEmotion[];
}

const TradeHistory: React.FC<TradeHistoryProps> = ({ trades, accounts, onDelete, onEdit, onClear, theme, emotions }) => {
  const [selectedTrade, setSelectedTrade] = useState<Trade | null>(null);
  const [zoomImage, setZoomImage] = useState<string | null>(null);

  const formatTradeDate = (dateStr: string) => {
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? dateStr : d.toLocaleString('cs-CZ', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const getAccountName = (id: string) => accounts.find(a => a.id === id)?.name || 'Neznámý účet';
  const getEmotionDetails = (emoId: string) => emotions.find(e => e.id === emoId) || { label: emoId };

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700 pb-20">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div className="space-y-1">
          <h2 className={`text-4xl font-black tracking-tighter italic ${theme === 'dark' ? 'text-white' : 'text-slate-900'}`}>HISTORIE OBCHODŮ</h2>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
        {trades.slice().reverse().map((trade) => {
          const status = trade.executionStatus || (trade.isValid === false ? 'Invalid' : 'Valid');
          const isMissed = status === 'Missed';
          const isWin = trade.pnl >= 0;

          let glowClass = isWin ? 'neon-border-green neon-glow-green' : 'neon-border-red neon-glow-red';
          if (isMissed) glowClass = 'border-l-4 border-blue-500 opacity-60 grayscale-[0.3]';

          const pnlColor = isMissed ? 'text-blue-400' : (isWin ? 'text-emerald-500' : 'text-rose-500');
          const tradeHex = `0x${Math.abs(Number(trade.id)).toString(16).padStart(6, '0')}`;

          return (
            <div
              key={trade.id}
              onClick={() => setSelectedTrade(trade)}
              className={`group relative flex flex-col md:flex-row h-auto md:h-56 rounded-[24px] border overflow-hidden transition-all duration-500 cursor-pointer ${glowClass} ${theme === 'dark'
                ? 'bg-[#0a0f1d]/80 border-white/5 backdrop-blur-md hover:bg-[#0a0f1d]'
                : 'bg-white border-slate-200 shadow-sm'
                }`}
            >
              <div className="absolute top-2 right-4 opacity-5 pointer-events-none">
                <span className="text-[8px] font-mono font-bold tracking-widest uppercase">System.Alpha.v4.0</span>
              </div>
              <div className="absolute bottom-2 left-4 opacity-5 pointer-events-none">
                <span className="text-[8px] font-mono font-bold tracking-widest uppercase">LOG_ID_{tradeHex}</span>
              </div>

              <div className="flex-1 flex flex-col justify-between p-6 min-w-0 relative z-10">
                <div className="space-y-2">
                  <div className="flex items-center gap-3 mb-1">
                    <span className={`px-2 py-0.5 rounded-md text-[7px] font-black uppercase border tracking-tighter ${isMissed ? 'bg-blue-500/10 text-blue-400 border-blue-500/20' :
                      isWin ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20' : 'bg-rose-500/10 text-rose-500 border-rose-500/20'
                      }`}>
                      {isMissed ? 'MISSED' : trade.direction}
                    </span>
                    <span className="text-[9px] font-mono font-bold text-slate-500">{formatTradeDate(trade.date)}</span>
                  </div>

                  <h3 className={`text-2xl font-black uppercase tracking-tighter truncate leading-none ${theme === 'dark' ? 'text-white group-hover:text-trade-accent' : 'text-slate-900'} transition-colors duration-300`}>
                    {trade.instrument}
                  </h3>

                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {(trade.emotions || []).slice(0, 3).map(eId => {
                      const e = getEmotionDetails(eId);
                      return <span key={eId} className="text-[8px] font-black uppercase text-blue-500/60 bg-blue-500/5 px-2 py-0.5 rounded border border-blue-500/10">{e.label}</span>;
                    })}
                  </div>
                </div>

                <div className="flex items-end justify-between mt-6 md:mt-0">
                  <div className="flex flex-col">
                    <span className={`text-3xl md:text-4xl font-black tracking-tighter leading-none font-mono ${pnlColor}`}>
                      {isMissed ? '±' : (isWin ? '+' : '')}${Math.abs(trade.pnl).toLocaleString()}
                    </span>
                    <div className="flex items-center gap-2 mt-2">
                      <Terminal size={10} className="text-slate-600" />
                      <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest truncate max-w-[120px]">{getAccountName(trade.accountId)}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 text-[9px] font-black uppercase text-slate-500 group-hover:text-blue-500 transition-all duration-300 group-hover:translate-x-1">
                    Audit <ChevronRight size={14} className="text-blue-500/50" />
                  </div>
                </div>
              </div>

              <div className={`relative transition-all duration-700 overflow-hidden ${trade.screenshot ? 'h-48 md:h-full w-full md:w-[42%]' : 'hidden'}`}>
                {trade.screenshot && (
                  <div
                    className="w-full h-full relative group/img"
                    onClick={(e) => { e.stopPropagation(); setZoomImage(trade.screenshot!); }}
                  >
                    <img src={trade.screenshot} className="w-full h-full object-cover transition-transform duration-1000 group-hover/img:scale-105" />
                    <div className={`absolute inset-0 bg-gradient-to-r ${theme === 'dark' ? 'from-[#0a0f1d] via-transparent' : 'from-white via-transparent'} to-transparent md:block hidden z-20`}></div>
                    <div className="absolute inset-0 bg-black/40 opacity-0 group-hover/img:opacity-100 flex items-center justify-center transition-all duration-500 backdrop-blur-[1px] z-30">
                      <div className="p-4 bg-white/10 rounded-full text-white shadow-2xl border border-white/20 animate-in zoom-in-95"><Maximize2 size={24} /></div>
                    </div>
                    {trade.screenshots && trade.screenshots.length > 1 && (
                      <div className="absolute bottom-3 right-3 px-2 py-1 bg-black/60 rounded-md text-[8px] font-black text-white uppercase tracking-widest backdrop-blur-md z-40">
                        +{trade.screenshots.length - 1} more
                      </div>
                    )}
                  </div>
                )}
              </div>

              {!trade.screenshot && (
                <div className="w-20 hidden md:flex items-center justify-center border-l border-white/5 bg-slate-900/10 group-hover:bg-blue-500/5 transition-colors duration-500">
                  <Cpu size={20} className="text-slate-800/40 group-hover:text-blue-500 transition-colors" />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {zoomImage && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/95 backdrop-blur-2xl p-4 animate-in fade-in duration-500" onClick={() => setZoomImage(null)}>
          <button className="absolute top-8 right-8 p-4 bg-white/5 hover:bg-white/10 rounded-full transition-all text-white border border-white/10 active:scale-90"><X size={32} /></button>
          <img src={zoomImage} className="max-w-full max-h-full object-contain rounded-[32px] shadow-[0_0_150px_rgba(59,130,246,0.15)] border border-white/5" onClick={e => e.stopPropagation()} />
          <div className="absolute bottom-10 px-8 py-3 bg-black/60 border border-white/10 rounded-full text-blue-500 text-[10px] font-black uppercase tracking-[0.5em] backdrop-blur-md">ALPHA DATA LOG</div>
        </div>
      )}

      {selectedTrade && (
        <TradeDetailModal
          trade={selectedTrade}
          accountName={getAccountName(selectedTrade.accountId)}
          theme={theme}
          onClose={() => setSelectedTrade(null)}
          onEdit={() => { onEdit(selectedTrade); setSelectedTrade(null); }}
          onDelete={() => { onDelete(selectedTrade.id); setSelectedTrade(null); }}
          emotions={emotions}
          onPrev={() => {
            const sorted = trades.slice().reverse();
            const idx = sorted.findIndex(t => t.id === selectedTrade.id);
            if (idx > 0) setSelectedTrade(sorted[idx - 1]);
          }}
          onNext={() => {
            const sorted = trades.slice().reverse();
            const idx = sorted.findIndex(t => t.id === selectedTrade.id);
            if (idx < sorted.length - 1) setSelectedTrade(sorted[idx + 1]);
          }}
          hasPrev={trades.slice().reverse().findIndex(t => t.id === selectedTrade.id) > 0}
          hasNext={trades.slice().reverse().findIndex(t => t.id === selectedTrade.id) < trades.length - 1}
        />
      )}
    </div>
  );
};

const TradeDetailModal: React.FC<{
  trade: Trade,
  accountName: string,
  theme: 'dark' | 'light',
  onClose: () => void,
  onEdit: () => void,
  onDelete: () => void,
  emotions: CustomEmotion[],
  onPrev: () => void,
  onNext: () => void,
  hasPrev: boolean,
  hasNext: boolean
}> = ({ trade, accountName, theme, onClose, onEdit, onDelete, emotions, onPrev, onNext, hasPrev, hasNext }) => {
  const isDark = theme === 'dark';
  const [isZoomed, setIsZoomed] = useState(false);
  const [activeImageIndex, setActiveImageIndex] = useState(0);
  const [shareCopied, setShareCopied] = useState(false);

  const images = trade.screenshots && trade.screenshots.length > 0
    ? trade.screenshots
    : (trade.screenshot ? [trade.screenshot] : []);

  const entryPrice = parseFloat(String(trade.entryPrice || 0));
  const exitPrice = parseFloat(String(trade.exitPrice || 0));
  const stopLoss = parseFloat(String(trade.stopLoss || 0));
  const takeProfit = parseFloat(String(trade.takeProfit || 0));
  const riskAmount = parseFloat(String(trade.riskAmount || 0));

  const realRRR = (riskAmount !== 0 && riskAmount !== undefined) ? (Math.abs(trade.pnl) / riskAmount).toFixed(2) : 'N/A';
  const holdTime = trade.duration || (Math.round(trade.durationMinutes || 0) + 'm');

  const status = trade.executionStatus || (trade.isValid === false ? 'Invalid' : 'Valid');
  const isMissed = status === 'Missed';
  const isWin = trade.pnl >= 0;

  const pnlColor = isMissed ? 'text-blue-400' : (isWin ? 'text-emerald-500' : 'text-rose-500');
  const directionColor = isMissed ? 'text-blue-400 bg-blue-500/10 border-blue-500/20' : (trade.direction === 'Long' ? 'text-emerald-500 bg-emerald-500/10 border-emerald-500/20' : 'text-orange-500 bg-orange-500/10 border-orange-500/20');

  const getEmotionDetails = (emoId: string) => emotions.find(e => e.id === emoId) || { label: emoId };

  const MetricCell = ({ label, value, color = 'text-white' }: { label: string, value: string | number, color?: string }) => (
    <div className={`p-3 md:p-4 border-r border-b ${isDark ? 'border-white/5' : 'border-slate-100'} flex flex-col justify-center`}>
      <span className="text-[8px] md:text-[9px] font-black uppercase text-slate-500 tracking-wider mb-0.5 md:mb-1">{label}</span>
      <span className={`text-xs md:text-sm font-black font-mono tracking-tight ${color}`}>{value}</span>
    </div>
  );

  const handleShare = async () => {
    let url = '';
    const isUUID = (id: any) => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

    try {
      if (isUUID(trade.id)) {
        // We trigger the database update but DON'T await it here to keep 
        // the clipboard write within the immediate user-gesture window (Safari fix)
        storageService.markTradeAsPublic(trade.id as string).catch(err => {
          console.error("DB Mark Public failed", err);
        });
        url = `${window.location.origin}${window.location.pathname}?shareId=${trade.id}`;
      } else {
        const shareableTrade = { ...trade, screenshot: null, screenshots: [] };
        const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(shareableTrade))));
        url = `${window.location.origin}${window.location.pathname}?share=${encoded}`;
      }

      // Try automatic copy
      try {
        await navigator.clipboard.writeText(url);
        setShareCopied(true);
        setTimeout(() => setShareCopied(false), 2000);
      } catch (clipErr) {
        console.warn("Auto-copy blocked by browser, showing link manually", clipErr);
        // Fallback for Safari/Privacy settings: Show the link so user can copy it manually
        window.prompt("Odkaz ke sdílení (zkopíruj pomocí CTRL+C):", url);
      }
    } catch (err) {
      console.error("General sharing failure", err);
      // Last resort fallback
      if (url) window.prompt("Odkaz ke sdílení:", url);
      else alert("Nepodařilo se vygenerovat odkaz.");
    }
  };

  return (
    <>
      <div className="fixed inset-0 z-[110] flex items-center justify-center p-2 md:p-4 bg-slate-950/80 backdrop-blur-xl animate-in fade-in duration-300">
        <div className={`w-full max-w-7xl h-[95vh] md:h-[85vh] rounded-[24px] md:rounded-[32px] overflow-hidden shadow-2xl flex flex-col border ${isDark ? 'bg-[#0a0f1d] border-white/10' : 'bg-white border-slate-200'}`}>

          <div className={`min-h-[80px] h-auto md:h-20 shrink-0 border-b flex flex-wrap items-center justify-between px-4 md:px-8 py-3 md:py-0 ${isDark ? 'border-white/5 bg-[#0a0f1d]' : 'bg-white border-slate-100'}`}>
            <div className="flex items-center gap-3 md:gap-6">
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

              <div className={`px-2 md:px-3 py-1 md:py-1.5 rounded-lg border flex items-center gap-1.5 md:gap-2 ${directionColor}`}>
                {isMissed ? <Clock size={12} /> : (trade.direction === 'Long' ? <ArrowUpRight size={14} strokeWidth={3} /> : <ArrowDownRight size={14} strokeWidth={3} />)}
                <span className="text-[8px] md:text-[10px] font-black uppercase tracking-widest">{isMissed ? 'Missed' : trade.direction}</span>
              </div>
              <div>
                <h2 className={`text-sm md:text-lg font-black tracking-tighter uppercase ${isDark ? 'text-white' : 'text-slate-900'}`}>{trade.instrument}</h2>
                <p className="text-[8px] md:text-[9px] font-bold text-slate-500 uppercase tracking-widest">{new Date(trade.date).toLocaleString('cs-CZ', { dateStyle: 'short', timeStyle: 'short' })}</p>
              </div>
            </div>

            <div className={`text-xl md:text-3xl font-black font-mono tracking-tighter ${pnlColor} mx-2`}>
              {isMissed ? '±' : (isWin ? '+' : '')}${Math.abs(trade.pnl).toLocaleString()}
            </div>

            <div className="flex items-center gap-2 md:gap-3 ml-auto md:ml-0 mt-2 md:mt-0">
              <button
                onClick={handleShare}
                className={`p-2 md:p-2.5 rounded-xl transition-all flex items-center gap-1 md:gap-2 ${shareCopied ? 'bg-emerald-500/20 text-emerald-500' : 'bg-blue-500/10 text-blue-500 hover:bg-blue-600 hover:text-white'}`}
                title="Sdílet"
              >
                {shareCopied ? <Check size={14} /> : <Share2 size={14} />}
                {shareCopied && <span className="text-[8px] font-black uppercase hidden sm:inline">Copied</span>}
              </button>
              <button onClick={onEdit} className="p-2 md:p-2.5 rounded-xl bg-slate-500/10 text-slate-500 hover:bg-slate-600 hover:text-white transition-all"><Edit3 size={16} /></button>
              <button onClick={(e) => { e.stopPropagation(); if (window.confirm("Smazat?")) onDelete(); }} className="p-2 md:p-2.5 rounded-xl bg-rose-500/10 text-rose-500 hover:bg-rose-600 hover:text-white transition-all"><Trash2 size={16} /></button>
              <div className="h-6 md:h-8 w-px bg-slate-800 mx-0.5 md:mx-1"></div>
              <button onClick={onClose} className="p-2 md:p-2.5 hover:bg-white/10 rounded-full transition-all text-slate-500 hover:text-white"><X size={20} /></button>
            </div>
          </div>

          <div className="flex-1 flex flex-col md:flex-row overflow-hidden">

            <div className={`w-full md:w-[35%] xl:w-[30%] flex flex-col overflow-y-auto custom-scrollbar border-b md:border-b-0 md:border-r ${isDark ? 'bg-[#0F172A]/50 border-white/5' : 'bg-slate-50 border-slate-200'}`}>

              <div className={`grid grid-cols-2 border-b ${isDark ? 'border-white/5 bg-[#0a0f1d]' : 'border-slate-200 bg-white'}`}>
                <MetricCell label="Entry Price" value={entryPrice || '-'} />
                <MetricCell label="Exit Price" value={exitPrice || '-'} />
                <MetricCell label="Stop Loss" value={stopLoss || '-'} color="text-rose-500" />
                <MetricCell label="Take Profit" value={takeProfit || '-'} color="text-emerald-500" />
                <MetricCell label="Size (Units)" value={trade.positionSize || 1} />
                <MetricCell label="Duration" value={holdTime} color="text-blue-400" />
                <MetricCell label="Risk Amount" value={`$${riskAmount}`} color="text-slate-400" />
                <MetricCell label="Realized RR" value={`${realRRR}R`} color={parseFloat(realRRR) > 1 ? 'text-emerald-500' : 'text-slate-400'} />
              </div>

              <div className="p-4 md:p-6 space-y-4 md:space-y-6">
                <div className="space-y-2 md:space-y-3">
                  <p className="text-[8px] md:text-[9px] font-black uppercase text-slate-500 tracking-widest flex items-center gap-2"><Monitor size={12} /> Context & Confluence</p>
                  <div className="flex flex-wrap gap-1.5 md:gap-2">
                    {trade.htfConfluence?.length ? trade.htfConfluence.map(t => <span key={t} className="px-1.5 md:px-2 py-0.5 md:py-1 rounded-md bg-blue-500/10 border border-blue-500/20 text-blue-400 text-[8px] md:text-[9px] font-bold uppercase">{t}</span>) : <span className="text-[9px] md:text-[10px] text-slate-600 italic">No HTF data</span>}
                    {trade.ltfConfluence?.length ? trade.ltfConfluence.map(t => <span key={t} className="px-1.5 md:px-2 py-0.5 md:py-1 rounded-md bg-amber-500/10 border border-amber-500/20 text-amber-500 text-[8px] md:text-[9px] font-bold uppercase">{t}</span>) : null}
                  </div>
                </div>

                <div className="space-y-2 md:space-y-3">
                  <p className="text-[8px] md:text-[9px] font-black uppercase text-slate-500 tracking-widest flex items-center gap-2"><Brain size={12} /> Psycho & Mistakes</p>
                  <div className="flex flex-wrap gap-1.5 md:gap-2">
                    {trade.emotions?.length ? trade.emotions.map(e => {
                      const det = getEmotionDetails(e);
                      return <span key={e} className="px-1.5 md:px-2 py-0.5 md:py-1 rounded-md bg-purple-500/10 border border-purple-500/20 text-purple-400 text-[8px] md:text-[9px] font-bold uppercase">{det.label}</span>
                    }) : <span className="text-[9px] md:text-[10px] text-slate-600 italic">Neutral state</span>}
                    {trade.mistakes?.length ? trade.mistakes.map(m => <span key={m} className="px-1.5 md:px-2 py-0.5 md:py-1 rounded-md bg-rose-500/10 border border-rose-500/20 text-rose-500 text-[8px] md:text-[9px] font-bold uppercase">{m}</span>) : null}
                  </div>
                </div>

                <div className="space-y-2 md:space-y-3">
                  <p className="text-[8px] md:text-[9px] font-black uppercase text-slate-500 tracking-widest flex items-center gap-2"><FileText size={12} /> Protocol Notes</p>
                  <div className={`p-3 md:p-4 rounded-xl border text-[10px] md:text-xs font-medium leading-relaxed ${isDark ? 'bg-black/20 border-white/5 text-slate-300' : 'bg-white border-slate-200 text-slate-700'}`}>
                    {trade.notes || "Žádné poznámky k tomuto obchodu."}
                  </div>
                </div>
              </div>
            </div>

            <div className={`flex-1 relative flex flex-col ${isDark ? 'bg-[#050914]' : 'bg-slate-100'}`}>
              <div className="flex-1 relative flex items-center justify-center overflow-hidden group">
                {images.length > 0 ? (
                  <>
                    <img src={images[activeImageIndex]} className="w-full h-full object-contain" />
                    <div className="absolute top-4 right-4 flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button onClick={() => setIsZoomed(true)} className="p-2 md:p-3 rounded-xl bg-black/50 backdrop-blur-md text-white border border-white/10 hover:bg-blue-600 transition-colors shadow-xl">
                        <Maximize2 size={18} />
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="text-center opacity-30">
                    <ImageIcon size={64} className="mx-auto mb-4 text-slate-500" />
                    <p className="text-[10px] md:text-xs font-black uppercase tracking-[0.2em] text-slate-500">Visual Data Missing</p>
                  </div>
                )}
              </div>

              {images.length > 1 && (
                <div className={`h-20 md:h-24 border-t shrink-0 flex items-center gap-2 md:gap-3 px-3 md:px-4 overflow-x-auto no-scrollbar ${isDark ? 'bg-[#0a0f1d] border-white/5' : 'bg-white border-slate-200'}`}>
                  {images.map((src, i) => (
                    <div
                      key={i}
                      onClick={() => setActiveImageIndex(i)}
                      className={`h-12 md:h-16 aspect-video rounded-lg border overflow-hidden cursor-pointer transition-all flex-shrink-0 ${activeImageIndex === i ? 'ring-2 ring-blue-500 opacity-100' : 'opacity-50 hover:opacity-100'}`}
                    >
                      <img src={src} className="w-full h-full object-cover" />
                    </div>
                  ))}
                </div>
              )}
            </div>

          </div>
        </div>
      </div>

      {isZoomed && images.length > 0 && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/98 backdrop-blur-3xl p-4 md:p-6 animate-in fade-in duration-300" onClick={() => setIsZoomed(false)}>
          <button className="absolute top-4 md:top-10 right-4 md:right-10 p-3 md:p-5 bg-white/10 hover:bg-white/10 rounded-full transition-all border border-white/10 text-white"><X size={32} /></button>
          <img src={images[activeImageIndex]} className="max-w-full max-h-full object-contain rounded-[16px] md:rounded-[32px] shadow-[0_0_100px_rgba(59,130,246,0.1)] border border-white/10" onClick={e => e.stopPropagation()} />
        </div>
      )}
    </>
  );
};

export default TradeHistory;
