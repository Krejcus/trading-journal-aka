
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

import TradeDetailModal from './TradeDetailModal';

interface TradeHistoryProps {
  trades: Trade[];
  accounts: Account[];
  onDelete: (id: number | string) => void;
  onEdit: (trade: Trade) => void;
  onClear: () => void;
  theme: 'dark' | 'light' | 'oled';
  emotions: CustomEmotion[];
  onUpdateTrade?: (tradeId: string | number, updates: Partial<Trade>) => void;
}

const TradeHistory: React.FC<TradeHistoryProps> = ({ trades, accounts, onDelete, onEdit, onClear, theme, emotions, onUpdateTrade }) => {
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
          <h2 className={`text-4xl font-black tracking-tighter italic ${theme !== 'light' ? 'text-white' : 'text-slate-900'}`}>HISTORIE OBCHODŮ</h2>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
        {trades.slice().map((trade) => {
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
              className={`group relative flex flex-col md:flex-row h-auto md:h-56 rounded-[24px] border overflow-hidden transition-all duration-500 cursor-pointer ${glowClass} glass-panel hover:scale-[1.01]`}
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
                    {/* Master/Copy Indicators */}
                    {trade.isMaster && (
                      <span className="px-1.5 py-0.5 bg-blue-600/20 text-blue-400 rounded text-[7px] font-black tracking-widest border border-blue-500/30 flex items-center gap-1">
                        MASTER <Zap size={8} />
                      </span>
                    )}
                    {trade.masterTradeId && (
                      <span className="px-1.5 py-0.5 bg-purple-600/20 text-purple-400 rounded text-[7px] font-black tracking-widest border border-purple-500/30">COPY</span>
                    )}
                    {trade.phase && (
                      <span className={`px-1.5 py-0.5 rounded text-[7px] font-black tracking-widest border ${trade.phase === 'Funded'
                        ? 'bg-purple-500/10 text-purple-400 border-purple-500/20'
                        : 'bg-amber-500/10 text-amber-500 border-amber-500/20'
                        }`}>
                        {trade.phase.toUpperCase()}
                      </span>
                    )}
                  </div>

                  <h3 className={`text-2xl font-black uppercase tracking-tighter truncate leading-none ${theme !== 'light' ? 'text-white group-hover:text-trade-accent' : 'text-slate-900'} transition-colors duration-300`}>
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
                      {isMissed ? '±' : (isWin ? '+' : '-')}${Math.abs(trade.pnl).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                      {trade.isMaster && (
                        <span className="text-[10px] text-slate-500 ml-2 font-black uppercase tracking-widest">
                          + {accounts.filter(a => a.parentAccountId === trade.accountId).length} copies
                        </span>
                      )}
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
                    <div className={`absolute inset-0 bg-gradient-to-r ${theme !== 'light' ? 'from-[var(--bg-card)] via-transparent' : 'from-white via-transparent'} to-transparent md:block hidden z-20`}></div>
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
                <div className={`w-20 hidden md:flex items-center justify-center border-l bg-[var(--bg-page)]/10 group-hover:bg-blue-500/5 transition-colors duration-500 ${theme === 'light' ? 'border-slate-100' : 'border-[var(--border-subtle)]'}`}>
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
          onUpdateTrade={(updates) => onUpdateTrade?.(selectedTrade.id, updates)}
          onPrev={() => {
            const sorted = trades.slice();
            const idx = sorted.findIndex(t => t.id === selectedTrade.id);
            if (idx > 0) setSelectedTrade(sorted[idx - 1]);
          }}
          onNext={() => {
            const sorted = trades.slice();
            const idx = sorted.findIndex(t => t.id === selectedTrade.id);
            if (idx < sorted.length - 1) setSelectedTrade(sorted[idx + 1]);
          }}
          hasPrev={trades.findIndex(t => t.id === selectedTrade.id) > 0}
          hasNext={trades.findIndex(t => t.id === selectedTrade.id) < trades.length - 1}
        />
      )}
    </div>
  );
};

export default TradeHistory;
