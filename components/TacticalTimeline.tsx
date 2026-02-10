
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
  AlertOctagon,
  Trash2
} from 'lucide-react';
import ConfirmationModal from './ConfirmationModal';

interface TacticalTimelineProps {
  date: string;
  prep?: DailyPrep;
  review?: DailyReview;
  trades: Trade[];
  theme: 'dark' | 'light' | 'oled';
  onEditPrep: () => void;
  onEditReview: () => void;
  onDeletePrep?: (date: string) => void;
  onDeleteReview?: (date: string) => void;
  isMini?: boolean;
}

const TacticalTimeline: React.FC<TacticalTimelineProps> = ({ date, prep, review, trades, theme, onEditPrep, onEditReview, onDeletePrep, onDeleteReview, isMini = false }) => {
  const isDark = theme !== 'light';
  const [zoomImg, setZoomImg] = useState<string | null>(null);
  const [isDeletingPrep, setIsDeletingPrep] = useState(false);
  const [isDeletingReview, setIsDeletingReview] = useState(false);

  const dayStats = useMemo(() => {
    if (trades.length === 0) return null;
    const pnl = trades.reduce((acc, t) => acc + t.pnl, 0);
    const wins = trades.filter(t => t.pnl > 0).length;
    const wr = (wins / trades.length) * 100;
    return { pnl, wr, count: trades.length };
  }, [trades]);

  const events = [
    { type: 'prep', time: '08:00', label: 'Pre-Market Preparation' },
    ...trades.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0)).map(t => {
      const d = new Date(t.timestamp || 0);
      const time = d.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
      const isPlaceholderTime = time === '01:00' || time === '00:00';
      return {
        type: 'trade',
        time: isPlaceholderTime ? '' : time,
        data: t
      };
    }),
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
      <div className={`absolute ${isMini ? 'left-4' : 'left-10 lg:left-1/2'} top-0 bottom-0 w-px ${isMini ? '' : '-translate-x-1/2'} ${isDark ? 'bg-[var(--border-subtle)]' : 'bg-slate-200'}`}></div>

      <div className={isMini ? 'space-y-4' : 'space-y-12'}>
        {events.map((event, idx) => (
          <div key={idx} className={`relative flex items-center ${isMini ? 'justify-start' : 'lg:justify-center'} ${!isMini && event.type === 'trade' ? (idx % 2 === 0 ? 'lg:flex-row-reverse' : '') : ''}`}>

            {/* Timeline Dot */}
            <div className={`absolute ${isMini ? 'left-4' : 'left-10 lg:left-1/2'} -translate-x-1/2 z-10 ${isMini ? 'w-1.5 h-1.5' : 'w-4 h-4'} rounded-full border-2 flex items-center justify-center transition-all duration-500 ${event.type === 'prep' ? 'bg-blue-600 border-black/50' :
              event.type === 'review' ? 'bg-indigo-600 border-black/50' :
                (event.type === 'trade' && (event as any).data.pnl >= 0 ? 'bg-emerald-500 border-black/50' : 'bg-rose-500 border-black/50')
              }`}>
              {!isMini && <div className="absolute -top-6 text-[9px] font-black uppercase text-slate-500 tracking-widest whitespace-nowrap">{event.time}</div>}
            </div>

            <div className={`${isMini ? 'w-full pl-7' : 'w-full lg:w-[45%] pl-16 lg:pl-0'} ${!isMini && idx % 2 === 0 && event.type === 'trade' ? 'lg:pr-12 lg:text-right' : 'lg:pl-12'}`}>

              {/* RANNÍ PŘÍPRAVA */}
              {event.type === 'prep' && (
                <div onClick={onEditPrep} className={`group ${padding} ${rounded} border cursor-pointer transition-all hover:scale-[1.01] ${prep ? (isDark ? 'bg-blue-600/5 border-blue-500/20 shadow-lg shadow-blue-500/5' : 'bg-blue-50 border-blue-200 shadow-sm') : (isDark ? 'bg-[var(--bg-card)] border-[var(--border-subtle)]' : 'bg-white border-slate-200')
                  }`}>
                  <div className={`flex items-center gap-1.5 mb-1.5`}>
                    <div className={`${isMini ? 'p-1' : 'p-2'} rounded-lg bg-blue-600/10 text-blue-500`}><Coffee size={iconSize} /></div>
                    <h4 className={`${textTitle} font-black uppercase tracking-widest`}>Příprava</h4>
                    {prep && onDeletePrep && !isMini && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setIsDeletingPrep(true);
                        }}
                        className="ml-auto p-1.5 hover:bg-rose-500/10 text-slate-400 hover:text-rose-500 rounded-lg transition-all"
                        title="Smazat přípravu"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                    {isMini && <span className="text-[6px] text-slate-600 font-mono ml-auto">08:00</span>}
                  </div>
                  {prep ? (
                    <div className={isMini ? 'space-y-1' : 'space-y-4'}>

                      <div className={`grid ${isMini ? 'grid-cols-2' : (prep.scenarios.sessions && prep.scenarios.sessions.length > 1 ? 'grid-cols-2' : 'grid-cols-1')} gap-3`}>
                        {/* New Session-Based Cards - Tactical Gallery */}
                        {prep.scenarios.sessions && prep.scenarios.sessions.length > 0 ? (
                          prep.scenarios.sessions.map((session, i) => (
                            <div key={session.id || i} className={`group/session overflow-hidden rounded-[24px] border ${isDark ? 'bg-slate-900/40 border-white/5 hover:border-white/10' : 'bg-white/40 border-slate-200/50 hover:border-slate-300'}`}>
                              {session.image && (
                                <div className="aspect-video relative overflow-hidden group/img cursor-pointer" onClick={(e) => { e.stopPropagation(); setZoomImg(session.image!); }}>
                                  <img src={session.image} className="w-full h-full object-cover transition-transform duration-700 group-hover/session:scale-110" />
                                  <div className="absolute inset-0 bg-black/40 opacity-0 group-hover/img:opacity-100 flex items-center justify-center transition-all bg-gradient-to-t from-black/60 to-transparent">
                                    <Maximize2 size={16} className="text-white" />
                                  </div>
                                  <div className="absolute top-2 left-2 px-2 py-1 bg-black/60 backdrop-blur-md rounded-lg border border-white/10">
                                    <p className="text-[7px] font-black uppercase text-white tracking-widest">{session.label}</p>
                                  </div>
                                </div>
                              )}
                              <div className="p-4">
                                {!session.image && (
                                  <div className="flex items-center gap-2 mb-2">
                                    <Activity size={10} className="text-blue-500" />
                                    <span className="text-[8px] font-black uppercase text-slate-500 tracking-widest">{session.label}</span>
                                  </div>
                                )}
                                {session.plan && (
                                  <p className={`text-[10px] leading-relaxed italic ${isDark ? 'text-slate-400' : 'text-slate-600'} line-clamp-4`}>
                                    "{session.plan}"
                                  </p>
                                )}
                              </div>
                            </div>
                          ))
                        ) : (
                          /* Legacy Support - Multi Images */
                          <>
                            {prep.scenarios.scenarioImages && prep.scenarios.scenarioImages.length > 0 && (
                              <div className={`col-span-2 grid ${isMini ? 'grid-cols-2' : 'grid-cols-3'} gap-1.5`}>
                                {prep.scenarios.scenarioImages.map((img, i) => (
                                  <div key={i} className="aspect-video rounded-lg overflow-hidden border border-blue-500/20 relative group/img" onClick={(e) => { e.stopPropagation(); setZoomImg(img); }}>
                                    <img src={img} className="w-full h-full object-cover" />
                                    <div className="absolute inset-0 bg-black/40 opacity-100 flex items-center justify-center transition-all md:opacity-0 md:group-hover/img:opacity-100"><Maximize2 size={10} className="text-white" /></div>
                                  </div>
                                ))}
                              </div>
                            )}

                            {/* Legacy Support - Bull/Bear Images */}
                            {(prep.scenarios.bullishImage || prep.scenarios.bearishImage) && (
                              <div className="col-span-2 grid grid-cols-2 gap-1.5">
                                {prep.scenarios.bullishImage && (
                                  <div className="aspect-video rounded-lg overflow-hidden border border-emerald-500/20 relative group/img" onClick={(e) => { e.stopPropagation(); setZoomImg(prep.scenarios.bullishImage!); }}>
                                    <img src={prep.scenarios.bullishImage} className="w-full h-full object-cover" />
                                  </div>
                                )}
                                {prep.scenarios.bearishImage && (
                                  <div className="aspect-video rounded-lg overflow-hidden border border-rose-500/20 relative group/img" onClick={(e) => { e.stopPropagation(); setZoomImg(prep.scenarios.bearishImage!); }}>
                                    <img src={prep.scenarios.bearishImage} className="w-full h-full object-cover" />
                                  </div>
                                )}
                              </div>
                            )}

                            {/* Legacy Support - Text */}
                            {!isMini && (
                              <>
                                {prep.scenarios.bullish && <div className="col-span-2"><p className="text-[10px] text-slate-400 italic line-clamp-2 mt-1">"Bullish: {prep.scenarios.bullish}"</p></div>}
                                {prep.scenarios.bearish && <div className="col-span-2"><p className="text-[10px] text-slate-400 italic line-clamp-2 mt-1">"Bearish: {prep.scenarios.bearish}"</p></div>}
                              </>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  ) : (
                    <p className={`${isMini ? 'text-[7px]' : 'text-sm'} text-slate-500 italic`}>Naplánuj den...</p>
                  )}
                </div>
              )}

              {/* JEDNOTLIVÉ OBCHODY */}
              {event.type === 'trade' && (
                <div className={`group ${padding} ${rounded} border transition-all hover:shadow-xl hover:scale-[1.01] ${isDark ? 'bg-[var(--bg-card)] border-[var(--border-subtle)]' : 'bg-white border-slate-200 shadow-sm'}`}>
                  <div className={`flex items-center justify-between ${isMini ? 'mb-1.5' : 'mb-4'} ${!isMini && idx % 2 === 0 ? 'lg:flex-row-reverse' : ''}`}>
                    <div className="flex items-center gap-1">
                      <span className={`${isMini ? 'px-1 py-0.5' : 'px-2 py-0.5'} rounded-lg text-[6px] md:text-[7px] font-black uppercase ${(event as any).data.pnl >= 0 ? 'bg-emerald-500/10 text-emerald-500 border border-emerald-500/20' : 'bg-rose-500/10 text-rose-500 border border-rose-500/20'
                        }`}>{(event as any).data.direction}</span>
                      {!isMini && <span className="text-[10px] font-black uppercase tracking-tight text-slate-500">{(event as any).data.instrument}</span>}
                      {(event as any).data.accountCount >= 1 && (
                        <span className={`px-1.5 py-0.5 rounded-lg text-[6px] md:text-[7px] font-black uppercase bg-blue-500/10 text-blue-500 border border-blue-500/20`}>
                          Kopírováno na {(event as any).data.accountCount} {(event as any).data.accountCount === 1 ? 'účet' : ((event as any).data.accountCount >= 2 && (event as any).data.accountCount <= 4) ? 'účty' : 'účtů'}
                        </span>
                      )}
                    </div>
                    <div className="flex flex-col items-end">
                      <span className={`${isMini ? 'text-[10px] md:text-xs' : 'text-lg'} font-black font-mono ${(event as any).data.pnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                        ${(event as any).data.pnl.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                      </span>
                      {(event as any).data.accountCount >= 1 && !isMini && (
                        <span className="text-[8px] font-bold text-slate-500 uppercase tracking-tighter">Suma P&L</span>
                      )}
                    </div>
                  </div>

                  {(event as any).data.screenshot && (
                    <div
                      className={`${isMini ? 'mb-1' : 'mb-4'} aspect-video rounded-lg overflow-hidden border border-white/5 relative group/tradeimg cursor-pointer`}
                      onClick={() => setZoomImg((event as any).data.screenshot!)}
                    >
                      <img src={(event as any).data.screenshot} className="w-full h-full object-cover transition-transform duration-700 group-hover/tradeimg:scale-110" />
                      {!isMini && (
                        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover/tradeimg:opacity-100 flex items-center justify-center transition-all">
                          <Maximize2 size={16} className="text-white" />
                        </div>
                      )}
                    </div>
                  )}

                  {!isMini && (
                    <div className={`flex gap-1 flex-wrap ${idx % 2 === 0 ? 'lg:justify-end' : ''}`}>
                      {(event as any).data.mistakes?.map((mistake: any) => (
                        <span key={mistake} className="px-2 py-0.5 rounded bg-rose-500/10 text-rose-500 text-[8px] font-black uppercase border border-rose-500/20">{mistake}</span>
                      ))}
                    </div>
                  )}
                  {isMini && <p className="text-[6px] text-slate-600 font-mono mt-1 text-right">{event.time}</p>}
                </div>
              )}

              {/* DENNÍ AUDIT */}
              {event.type === 'review' && (
                <div onClick={onEditReview} className={`group ${padding} ${rounded} border cursor-pointer transition-all hover:scale-[1.01] ${review ? (isDark ? 'bg-indigo-600/5 border-indigo-500/20 shadow-lg shadow-indigo-500/5' : 'bg-indigo-50 border-indigo-200 shadow-sm') : (isDark ? 'bg-[var(--bg-card)] border-[var(--border-subtle)]' : 'bg-white border-slate-200')
                  }`}>
                  <div className={`flex justify-between items-start ${isMini ? 'mb-1.5' : 'mb-4'}`}>
                    <div className="flex items-center gap-1.5">
                      <div className={`${isMini ? 'p-1' : 'p-2'} rounded-lg bg-indigo-600/10 text-indigo-500`}><Moon size={iconSize} /></div>
                      <h4 className={`${textTitle} font-black uppercase tracking-widest`}>Večerní Audit</h4>
                      {review && onDeleteReview && !isMini && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setIsDeletingReview(true);
                          }}
                          className="p-1 hover:bg-rose-500/10 text-slate-400 hover:text-rose-500 rounded-lg transition-all"
                          title="Smazat audit"
                        >
                          <Trash2 size={12} />
                        </button>
                      )}
                    </div>
                    {review && (
                      <div className={`flex ${isMini ? 'gap-0.5' : 'gap-1'}`}>
                        {[1, 2, 3, 4, 5].map(s => (
                          <div key={s} className={`${isMini ? 'w-0.5 h-0.5 md:w-1 md:h-1' : 'w-2 h-2'} rounded-full ${s <= review.rating ? 'bg-yellow-500' : 'bg-slate-800'}`} />
                        ))}
                      </div>
                    )}
                  </div>

                  {review ? (
                    <div className={isMini ? 'space-y-1' : 'space-y-5'}>
                      <div className={`grid ${isMini ? 'grid-cols-1' : 'grid-cols-2'} gap-1.5`}>
                        <div className={`${isMini ? 'p-1.5 md:p-2' : 'p-3'} rounded-xl border ${theme !== 'light' ? 'bg-[var(--bg-input)] border-[var(--border-subtle)]' : 'bg-slate-50 border-slate-100'}`}>
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

      <ConfirmationModal
        isOpen={isDeletingPrep}
        onClose={() => setIsDeletingPrep(false)}
        onConfirm={() => onDeletePrep?.(date)}
        title="Smazat přípravu"
        message="Opravdu chcete smazat ranní přípravu pro tento den? Tato akce je nevratná."
        theme={theme}
      />

      <ConfirmationModal
        isOpen={isDeletingReview}
        onClose={() => setIsDeletingReview(false)}
        onConfirm={() => onDeleteReview?.(date)}
        title="Smazat audit"
        message="Opravdu chcete smazat večerní audit (reflexi) pro tento den? Tato akce je nevratná."
        theme={theme}
      />
    </div>
  );
};

export default TacticalTimeline;
