
import React, { useState } from 'react';
import { Trade } from '../types';
import {
   ArrowUpRight, ArrowDownRight, Monitor, Brain, FileText,
   BarChart2, ShieldCheck, Activity, AlertTriangle, X
} from 'lucide-react';

interface SharedTradeViewProps {
   trade: Trade;
   theme: 'dark' | 'light';
}

const SharedTradeView: React.FC<SharedTradeViewProps> = ({ trade, theme }) => {
   const [zoomedImage, setZoomedImage] = useState<string | null>(null);
   const isDark = true; // Force dark theme for the "Elite" public view look

   const entryPrice = parseFloat(String(trade.entryPrice || 0));
   const exitPrice = parseFloat(String(trade.exitPrice || 0));
   const stopLoss = parseFloat(String(trade.stopLoss || 0));
   const takeProfit = parseFloat(String(trade.takeProfit || 0));
   const riskAmount = parseFloat(String(trade.riskAmount || 0));

   const realRRR = (riskAmount !== 0 && riskAmount !== undefined) ? (Math.abs(trade.pnl) / riskAmount).toFixed(2) : 'N/A';
   const holdTime = trade.duration || (Math.round(trade.durationMinutes || 0) + 'm');

   const isWin = trade.pnl >= 0;
   const pnlColor = isWin ? 'text-emerald-500' : 'text-rose-500';
   const directionColor = trade.direction === 'Long' ? 'text-emerald-500 bg-emerald-500/10 border-emerald-500/20' : 'text-orange-500 bg-orange-500/10 border-orange-500/20';

   const MetricCell = ({ label, value, color = 'text-white' }: { label: string, value: string | number, color?: string }) => (
      <div className="p-6 border-r border-b border-white/5 flex flex-col justify-center">
         <span className="text-[10px] font-black uppercase text-slate-500 tracking-wider mb-2">{label}</span>
         <span className={`text-xl font-black font-mono tracking-tight ${color}`}>{value}</span>
      </div>
   );

   return (
      <div className="min-h-screen bg-[#020617] text-slate-200 font-sans flex flex-col items-center justify-center p-4 md:p-8">

         {/* Brand Header */}
         <div className="mb-8 text-center animate-in fade-in slide-in-from-top-4 duration-700">
            <div className="inline-flex items-center gap-2 mb-2 p-2 rounded-xl bg-blue-900/20 border border-blue-500/30 text-blue-400">
               <ShieldCheck size={16} /> <span className="text-[10px] font-black uppercase tracking-widest">Verified Execution</span>
            </div>
            <h1 className="text-3xl font-black tracking-tighter italic text-white">ALPHATRADE <span className="text-slate-600">SNAPSHOT</span></h1>
         </div>

         <div className="w-full max-w-5xl rounded-[32px] overflow-hidden shadow-2xl flex flex-col border border-white/10 bg-[#0a0f1d] animate-in zoom-in-95 duration-500">

            {/* Header */}
            <div className="h-24 shrink-0 border-b border-white/5 bg-[#0F172A]/50 backdrop-blur-xl flex items-center justify-between px-8">
               <div className="flex items-center gap-6">
                  <div className={`px-4 py-2 rounded-xl border flex items-center gap-2 ${directionColor}`}>
                     {trade.direction === 'Long' ? <ArrowUpRight size={18} strokeWidth={3} /> : <ArrowDownRight size={18} strokeWidth={3} />}
                     <span className="text-xs font-black uppercase tracking-widest">{trade.direction}</span>
                  </div>
                  <div>
                     <h2 className="text-2xl font-black tracking-tighter uppercase text-white">{trade.instrument}</h2>
                     <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">{new Date(trade.date).toLocaleString('cs-CZ')}</p>
                  </div>
               </div>

               <div className="text-right">
                  <p className="text-[10px] font-black uppercase text-slate-500 tracking-widest mb-1">Net Result</p>
                  <div className={`text-4xl font-black font-mono tracking-tighter leading-none ${pnlColor}`}>
                     {isWin ? '+' : ''}${Math.abs(trade.pnl).toLocaleString()}
                  </div>
               </div>
            </div>

            {/* Metrics Grid */}
            <div className="grid grid-cols-2 md:grid-cols-4 border-b border-white/5 bg-[#0F172A]/30">
               <MetricCell label="Entry Price" value={entryPrice || '-'} />
               <MetricCell label="Exit Price" value={exitPrice || '-'} />
               <MetricCell label="Realized RR" value={`${realRRR}R`} color={parseFloat(realRRR) > 1 ? 'text-emerald-500' : 'text-slate-400'} />
               <MetricCell label="Duration" value={holdTime} color="text-blue-400" />
            </div>

            {/* Content Body */}
            <div className="p-8 grid grid-cols-1 md:grid-cols-2 gap-8 bg-gradient-to-b from-transparent to-black/20">
               <div className="space-y-8">
                  <div className="space-y-4">
                     <p className="text-[10px] font-black uppercase text-slate-500 tracking-widest flex items-center gap-2"><Monitor size={14} /> Context & Confluence</p>
                     <div className="flex flex-wrap gap-2">
                        {trade.htfConfluence?.length ? trade.htfConfluence.map(t => <span key={t} className="px-3 py-1.5 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-400 text-[10px] font-black uppercase">{t}</span>) : <span className="text-xs text-slate-600 italic">No public context data</span>}
                        {trade.ltfConfluence?.length ? trade.ltfConfluence.map(t => <span key={t} className="px-3 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-500 text-[10px] font-black uppercase">{t}</span>) : null}
                     </div>
                  </div>

                  <div className="space-y-4">
                     <p className="text-[10px] font-black uppercase text-slate-500 tracking-widest flex items-center gap-2"><Brain size={14} /> Psycho & Mistakes</p>
                     <div className="flex flex-wrap gap-2">
                        {trade.emotions?.length ? trade.emotions.map(e => <span key={e} className="px-3 py-1.5 rounded-lg bg-purple-500/10 border border-purple-500/20 text-purple-400 text-[10px] font-black uppercase">{e}</span>) : <span className="text-xs text-slate-600 italic">Neutral state</span>}
                        {trade.mistakes?.length ? trade.mistakes.map(m => <span key={m} className="px-3 py-1.5 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-500 text-[10px] font-black uppercase">{m}</span>) : null}
                     </div>
                  </div>

                  <div className="space-y-4">
                     <p className="text-[10px] font-black uppercase text-slate-500 tracking-widest flex items-center gap-2"><FileText size={14} /> Trader Notes</p>
                     <div className="p-6 rounded-2xl border border-white/5 bg-[#0F172A]/50 text-sm text-slate-300 italic leading-relaxed">
                        {trade.notes || "No notes attached to this snapshot."}
                     </div>
                  </div>
               </div>

               <div className="flex flex-col gap-4">
                  {(trade.screenshots?.length || trade.screenshot) ? (
                     <div className="space-y-4">
                        <p className="text-[10px] font-black uppercase text-slate-500 tracking-widest flex items-center gap-2">
                           <BarChart2 size={14} /> Visual Evidence
                        </p>
                        <div className="space-y-4">
                           {(trade.screenshots || [trade.screenshot]).map((src, i) => (
                              src && (
                                 <div
                                    key={i}
                                    className="rounded-2xl border border-white/10 overflow-hidden shadow-2xl cursor-zoom-in hover:border-white/20 transition-all hover:scale-[1.01]"
                                    onClick={() => setZoomedImage(src)}
                                 >
                                    <img src={src} alt={`Chart ${i + 1}`} className="w-full h-auto" />
                                 </div>
                              )
                           ))}
                        </div>
                     </div>
                  ) : (
                     <div className="flex flex-col items-center justify-center p-8 h-full rounded-3xl border border-dashed border-slate-800 bg-slate-900/20 text-center">
                        <BarChart2 size={48} className="text-slate-800 mb-4" />
                        <p className="text-xs font-black uppercase text-slate-600 tracking-widest mb-1">Visual Data Not Available</p>
                        <p className="text-[10px] text-slate-700">Charts are not included in public snapshots for bandwidth efficiency.</p>
                     </div>
                  )}
               </div>
            </div>

         </div>

         <div className="mt-8 text-center opacity-30">
            <p className="text-[9px] font-black uppercase tracking-[0.3em] text-slate-500">Powered by AlphaTrade Terminal</p>
         </div>

         {/* Zoom Modal */}
         {zoomedImage && (
            <div
               className="fixed inset-0 z-[500] bg-black/95 backdrop-blur-2xl flex items-center justify-center p-4 md:p-12 animate-in fade-in duration-300"
               onClick={() => setZoomedImage(null)}
            >
               <button
                  className="absolute top-8 right-8 p-4 bg-white/10 hover:bg-white/20 rounded-full transition-all text-white border border-white/10"
                  onClick={() => setZoomedImage(null)}
               >
                  <X size={24} />
               </button>
               <img
                  src={zoomedImage}
                  alt="Zoomed Chart"
                  className="max-w-full max-h-full object-contain rounded-2xl shadow-2xl border border-white/10"
                  onClick={(e) => e.stopPropagation()}
               />
            </div>
         )}
      </div>
   );
};

export default SharedTradeView;
