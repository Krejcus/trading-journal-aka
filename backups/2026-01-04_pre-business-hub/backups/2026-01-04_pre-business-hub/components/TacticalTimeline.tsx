
import React, { useState, useMemo } from 'react';
import { DailyPrep, DailyReview, Trade } from '../types';
import { 
  Coffee, 
  Zap, 
  Moon, 
  TrendingUp, 
  TrendingDown, 
  Clock, 
  Target, 
  Brain,
  ChevronRight,
  AlertCircle,
  ShieldCheck,
  Star,
  X,
  Maximize2,
  Activity,
  AlertTriangle,
  FileText,
  BarChart3,
  AlertOctagon
} from 'lucide-react';

interface TacticalTimelineProps {
  date: string;
  prep?: DailyPrep;
  review?: DailyReview;
  trades: Trade[];
  theme: 'dark' | 'light';
  onEditPrep: () => void;
  onEditReview: () => void;
  isMini?: boolean;
}

const TacticalTimeline: React.FC<TacticalTimelineProps> = ({ date, prep, review, trades, theme, onEditPrep, onEditReview, isMini = false }) => {
  const isDark = theme === 'dark';
  const [zoomImg, setZoomImg] = useState<string | null>(null);

  const dayStats = useMemo(() => {
    if (trades.length === 0) return null;
    const pnl = trades.reduce((acc, t) => acc + t.pnl, 0);
    const wins = trades.filter(t => t.pnl > 0).length;
    const wr = (wins / trades.length) * 100;
    return { pnl, wr, count: trades.length };
  }, [trades]);

  const events = [
    { type: 'prep', time: '08:00', label: 'Pre-Market Preparation' },
    ...trades.sort((a, b) => a.timestamp - b.timestamp).map(t => ({ 
      type: 'trade', 
      time: new Date(t.timestamp).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' }), 
      data: t 
    })),
    { type: 'review', time: '18:00', label: 'Post-Market Review' }
  ];

  // Helper classes based on mini mode
  const textTitle = isMini ? 'text-[7px] md:text-[8px]' : 'text-xs';
  const textTime = isMini ? 'text-[6px] md:text-[7px]' : 'text-[9px]';
  const iconSize = isMini ? 10 : 16;
  const padding = isMini ? 'p-2' : 'p-6';
  const rounded = isMini ? 'rounded-xl md:rounded-2xl' : 'rounded-[32px]';
  const gap = isMini ? 'gap-1' : 'gap-4';

  return (
    <div className={`relative ${isMini ? 'py-3 px-1' : 'py-10 px-4'}`}>
      {/* Central Line */}
      <div className={`absolute ${isMini ? 'left-4' : 'left-10 lg:left-1/2'} top-0 bottom-0 w-px ${isMini ? '' : '-translate-x-1/2'} ${isDark ? 'bg-slate-800' : 'bg-slate-200'}`}></div>

      <div className={isMini ? 'space-y-4' : 'space-y-12'}>
        {events.map((event, idx) => (
          <div key={idx} className={`relative flex items-center ${isMini ? 'justify-start' : 'lg:justify-center'} ${!isMini && event.type === 'trade' ? (idx % 2 === 0 ? 'lg:flex-row-reverse' : '') : ''}`}>
            
            {/* Timeline Dot */}
            <div className={`absolute ${isMini ? 'left-4' : 'left-10 lg:left-1/2'} -translate-x-1/2 z-10 ${isMini ? 'w-1.5 h-1.5' : 'w-4 h-4'} rounded-full border-2 flex items-center justify-center transition-all duration-500 ${
              event.type === 'prep' ? 'bg-blue-600 border-blue-900/50' : 
              event.type === 'review' ? 'bg-indigo-600 border-indigo-900/50' : 
              ((event.data as Trade).pnl >= 0 ? 'bg-emerald-500 border-emerald-900/50' : 'bg-rose-500 border-rose-900/50')
            }`}>
               {!isMini && <div className="absolute -top-6 text-[9px] font-black uppercase text-slate-500 tracking-widest whitespace-nowrap">{event.time}</div>}
            </div>

            <div className={`${isMini ? 'w-full pl-7' : 'w-full lg:w-[45%] pl-16 lg:pl-0'} ${!isMini && idx % 2 === 0 && event.type === 'trade' ? 'lg:pr-12 lg:text-right' : 'lg:pl-12'}`}>
              
              {/* RANNÍ PŘÍPRAVA */}
              {event.type === 'prep' && (
                <div onClick={onEditPrep} className={`group ${padding} ${rounded} border cursor-pointer transition-all hover:scale-[1.01] ${
                  prep ? (isDark ? 'bg-blue-600/5 border-blue-500/20 shadow-lg shadow-blue-500/5' : 'bg-blue-50 border-blue-200 shadow-sm') : (isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200')
                }`}>
                  <div className={`flex items-center gap-1.5 mb-1.5`}>
                    <div className={`${isMini ? 'p-1' : 'p-2'} rounded-lg bg-blue-600/10 text-blue-500`}><Coffee size={iconSize} /></div>
                    <h4 className={`${textTitle} font-black uppercase tracking-widest`}>Příprava</h4>
                    {isMini && <span className="text-[6px] text-slate-600 font-mono ml-auto">08:00</span>}
                  </div>
                  {prep ? (
                    <div className={isMini ? 'space-y-1' : 'space-y-4'}>
                      <div className={`grid ${isMini ? 'grid-cols-1' : 'grid-cols-2'} gap-1.5`}>
                        <div className="space-y-1">
                          <p className="text-[6px] md:text-[8px] font-black uppercase text-emerald-500 tracking-widest flex items-center gap-1"><TrendingUp size={8}/> Bullish</p>
                          {prep.scenarios.bullishImage && (
                            <div className="aspect-video rounded-lg overflow-hidden border border-emerald-500/20 relative group/img" onClick={(e) => { e.stopPropagation(); setZoomImg(prep.scenarios.bullishImage!); }}>
                              <img src={prep.scenarios.bullishImage} className="w-full h-full object-cover" />
                              <div className="absolute inset-0 bg-black/40 opacity-0 group-hover/img:opacity-100 flex items-center justify-center transition-all"><Maximize2 size={10} className="text-white" /></div>
                            </div>
                          )}
                          {!isMini && <p className="text-[10px] text-slate-400 italic line-clamp-2">"{prep.scenarios.bullish}"</p>}
                        </div>
                        <div className="space-y-1">
                          <p className="text-[6px] md:text-[8px] font-black uppercase text-rose-500 tracking-widest flex items-center gap-1"><TrendingDown size={8}/> Bearish</p>
                          {prep.scenarios.bearishImage && (
                            <div className="aspect-video rounded-lg overflow-hidden border border-rose-500/20 relative group/img" onClick={(e) => { e.stopPropagation(); setZoomImg(prep.scenarios.bearishImage!); }}>
                              <img src={prep.scenarios.bearishImage} className="w-full h-full object-cover" />
                              <div className="absolute inset-0 bg-black/40 opacity-0 group-hover/img:opacity-100 flex items-center justify-center transition-all"><Maximize2 size={10} className="text-white" /></div>
                            </div>
                          )}
                          {!isMini && <p className="text-[10px] text-slate-400 italic line-clamp-2">"{prep.scenarios.bearish}"</p>}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <p className={`${isMini ? 'text-[7px]' : 'text-sm'} text-slate-500 italic`}>Naplánuj den...</p>
                  )}
                </div>
              )}

              {/* JEDNOTLIVÉ OBCHODY */}
              {event.type === 'trade' && (
                <div className={`group ${padding} ${rounded} border transition-all hover:shadow-xl hover:scale-[1.01] ${isDark ? 'bg-[#1E293B] border-slate-800' : 'bg-white border-slate-200 shadow-sm'}`}>
                  <div className={`flex items-center justify-between ${isMini ? 'mb-1.5' : 'mb-4'} ${!isMini && idx % 2 === 0 ? 'lg:flex-row-reverse' : ''}`}>
                    <div className="flex items-center gap-1">
                      <span className={`${isMini ? 'px-1 py-0.5' : 'px-2 py-0.5'} rounded-lg text-[6px] md:text-[7px] font-black uppercase ${
                        (event.data as Trade).pnl >= 0 ? 'bg-emerald-500/10 text-emerald-500 border border-emerald-500/20' : 'bg-rose-500/10 text-rose-500 border border-rose-500/20'
                      }`}>{(event.data as Trade).direction}</span>
                      {!isMini && <span className="text-[10px] font-black uppercase tracking-tight text-slate-500">{(event.data as Trade).instrument}</span>}
                    </div>
                    <span className={`${isMini ? 'text-[10px] md:text-xs' : 'text-lg'} font-black font-mono ${(event.data as Trade).pnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                      ${(event.data as Trade).pnl.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                    </span>
                  </div>
                  
                  {(event.data as Trade).screenshot && (
                    <div 
                      className={`${isMini ? 'mb-1' : 'mb-4'} aspect-video rounded-lg overflow-hidden border border-white/5 relative group/tradeimg cursor-pointer`}
                      onClick={() => setZoomImg((event.data as Trade).screenshot!)}
                    >
                      <img src={(event.data as Trade).screenshot} className="w-full h-full object-cover transition-transform duration-700 group-hover/tradeimg:scale-110" />
                      {!isMini && (
                        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover/tradeimg:opacity-100 flex items-center justify-center transition-all">
                          <Maximize2 size={16} className="text-white" />
                        </div>
                      )}
                    </div>
                  )}

                  {!isMini && (
                    <div className={`flex gap-1 flex-wrap ${idx % 2 === 0 ? 'lg:justify-end' : ''}`}>
                      {(event.data as Trade).mistakes?.map(mistake => (
                        <span key={mistake} className="px-2 py-0.5 rounded bg-rose-500/10 text-rose-500 text-[8px] font-black uppercase border border-rose-500/20">{mistake}</span>
                      ))}
                    </div>
                  )}
                  {isMini && <p className="text-[6px] text-slate-600 font-mono mt-1 text-right">{event.time}</p>}
                </div>
              )}

              {/* DENNÍ AUDIT */}
              {event.type === 'review' && (
                <div onClick={onEditReview} className={`group ${padding} ${rounded} border cursor-pointer transition-all hover:scale-[1.01] ${
                  review ? (isDark ? 'bg-indigo-600/5 border-indigo-500/20 shadow-lg shadow-indigo-500/5' : 'bg-indigo-50 border-indigo-200 shadow-sm') : (isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200')
                }`}>
                  <div className={`flex justify-between items-start ${isMini ? 'mb-1.5' : 'mb-4'}`}>
                    <div className="flex items-center gap-1.5">
                      <div className={`${isMini ? 'p-1' : 'p-2'} rounded-lg bg-indigo-600/10 text-indigo-500`}><Moon size={iconSize} /></div>
                      <h4 className={`${textTitle} font-black uppercase tracking-widest`}>Audit</h4>
                    </div>
                    {review && (
                       <div className={`flex ${isMini ? 'gap-0.5' : 'gap-1'}`}>
                          {[1,2,3,4,5].map(s => (
                             <div key={s} className={`${isMini ? 'w-0.5 h-0.5 md:w-1 md:h-1' : 'w-2 h-2'} rounded-full ${s <= review.rating ? 'bg-yellow-500' : 'bg-slate-800'}`} />
                          ))}
                       </div>
                    )}
                  </div>

                  {review ? (
                    <div className={isMini ? 'space-y-1' : 'space-y-5'}>
                       <div className={`grid ${isMini ? 'grid-cols-1' : 'grid-cols-2'} gap-1.5`}>
                          <div className={`${isMini ? 'p-1.5 md:p-2' : 'p-3'} rounded-xl bg-slate-950/40 border border-white/5`}>
                             <p className="text-[6px] md:text-[7px] font-black uppercase text-slate-500">PnL</p>
                             <p className={`${isMini ? 'text-[9px] md:text-[10px]' : 'text-sm'} font-black font-mono ${dayStats && dayStats.pnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                               ${dayStats?.pnl.toLocaleString(undefined, { maximumFractionDigits: 0 }) || '0'}
                             </p>
                          </div>
                       </div>
                       {isMini && <p className="text-[6px] text-slate-600 font-mono text-right mt-1">18:00</p>}
                    </div>
                  ) : (
                    <p className={`${isMini ? 'text-[7px]' : 'text-sm'} text-slate-500 italic`}>Udělej reflexi...</p>
                  )}
                </div>
              )}

            </div>
          </div>
        ))}
      </div>

      {zoomImg && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/95 backdrop-blur-xl p-6 animate-in fade-in duration-300" onClick={() => setZoomImg(null)}>
           <button className="absolute top-10 right-10 p-4 bg-white/10 hover:bg-white/20 rounded-full text-white transition-all active:scale-90"><X size={32} className="text-white" /></button>
           <img src={zoomImg} className="max-w-full max-h-full object-contain rounded-2xl shadow-2xl border border-white/10" onClick={e => e.stopPropagation()} />
        </div>
      )}
    </div>
  );
};

export default TacticalTimeline;
