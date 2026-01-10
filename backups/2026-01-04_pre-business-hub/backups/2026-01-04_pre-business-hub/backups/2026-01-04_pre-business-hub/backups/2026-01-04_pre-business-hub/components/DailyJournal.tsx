
import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { DailyPrep, DailyReview, WeeklyReview, Trade, GoalResult, IronRule, RuleCompletion } from '../types';
import DisciplineDashboard from './DisciplineDashboard';
import TacticalTimeline from './TacticalTimeline';
import { storageService } from '../services/storageService';
import { 
  Coffee, 
  Moon, 
  CheckCircle2, 
  Save, 
  Sparkles,
  Zap,
  Brain,
  Star,
  Plus,
  X,
  Target,
  AlertCircle,
  ShieldCheck,
  ShieldAlert,
  Clock,
  LayoutGrid,
  Calendar,
  BarChart3,
  TrendingUp,
  TrendingDown,
  Trophy,
  History,
  Activity,
  Award,
  ImageIcon,
  Maximize2,
  AlertOctagon,
  ChevronLeft,
  ChevronRight,
  RotateCcw,
  Smile,
  Frown,
  Meh,
  FileText,
  TrendingUp as TrendUp,
  AlertTriangle,
  Check,
  Scissors,
  Flag,
  Rocket,
  List,
  Filter,
  Layers,
  ArrowRight,
  MessageSquare,
  StickyNote,
  DollarSign,
  Gauge,
  CircleCheck,
  CircleAlert,
  Sun,
  ClipboardCheck
} from 'lucide-react';

interface DailyJournalProps {
  theme: 'dark' | 'light';
  trades: Trade[];
  preps: DailyPrep[];
  reviews: DailyReview[];
  onSavePrep: (prep: DailyPrep) => void;
  onSaveReview: (review: DailyReview) => void;
  standardGoals: string[];
  ironRules: IronRule[];
}

const DailyJournal: React.FC<DailyJournalProps> = ({ theme, trades, preps, reviews, onSavePrep, onSaveReview, standardGoals, ironRules }) => {
  const getToday = () => new Date().toLocaleDateString('en-CA');
  const [selectedDate, setSelectedDate] = useState(getToday());
  const today = getToday();

  const [activeTab, setActiveTab] = useState<'daily' | 'weekly'>('daily');
  const [view, setView] = useState<'timeline' | 'edit-prep' | 'edit-review' | 'edit-weekly'>('timeline');
  const [activeImageField, setActiveImageField] = useState<'bullish' | 'bearish' | null>(null);
  
  const [weeklyReviews, setWeeklyReviews] = useState<WeeklyReview[]>([]);

  // Weekly Navigation State
  const [activeWeekMonday, setActiveWeekMonday] = useState(() => {
    const d = new Date();
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    return new Date(d.setDate(diff)).toLocaleDateString('en-CA');
  });

  useEffect(() => {
    const loadExtra = async () => {
      setWeeklyReviews(await storageService.getWeeklyReviews());
    };
    loadExtra();
  }, []);

  // --- WEEKLY LOGIC ---
  const currentWeekInfo = useMemo(() => {
    const monday = new Date(activeWeekMonday);
    const weekDays = Array.from({ length: 5 }, (_, i) => {
      const current = new Date(monday);
      current.setDate(monday.getDate() + i);
      return current.toLocaleDateString('en-CA');
    });
    const onejan = new Date(monday.getFullYear(), 0, 1);
    const weekNum = Math.ceil((((monday.getTime() - onejan.getTime()) / 86400000) + onejan.getDay() + 1) / 7);
    return { days: weekDays, weekNumber: weekNum, year: monday.getFullYear(), mondayDate: activeWeekMonday };
  }, [activeWeekMonday]);

  const navigateWeek = (direction: 'prev' | 'next') => {
    const d = new Date(activeWeekMonday);
    if (direction === 'prev') d.setDate(d.getDate() - 7);
    else d.setDate(d.getDate() + 7);
    setActiveWeekMonday(d.toLocaleDateString('en-CA'));
  };

  const weeklyStats = useMemo(() => {
    const weekTrades = trades.filter(t => currentWeekInfo.days.includes(t.date.split('T')[0]));
    const weekPreps = preps.filter(p => currentWeekInfo.days.includes(p.date));
    const weekReviews = reviews.filter(r => currentWeekInfo.days.includes(r.date));

    const pnl = weekTrades.reduce((s, t) => s + t.pnl, 0);
    const validTrades = weekTrades.filter(t => t.isValid !== false);
    const invalidTrades = weekTrades.filter(t => t.isValid === false);
    const disciplinedPnL = validTrades.reduce((s, t) => s + t.pnl, 0);
    const wins = weekTrades.filter(t => t.pnl > 0).length;
    
    // Counts for Prep/Audit
    const prepCount = weekPreps.length;
    const auditCount = weekReviews.length;

    // Session Analytics
    const sessions = { ASIA: 0, LDN: 0, NY: 0 };
    weekTrades.forEach(t => {
       const h = new Date(t.timestamp).getHours();
       if (h >= 8 && h < 14) sessions.LDN += t.pnl;
       else if (h >= 14 && h < 21) sessions.NY += t.pnl;
       else sessions.ASIA += t.pnl;
    });

    const sessionEntries = Object.entries(sessions);
    const bestSession = sessionEntries.length > 0 ? sessionEntries.sort((a,b) => b[1] - a[1])[0] : ['N/A', 0];
    const worstSession = sessionEntries.length > 0 ? sessionEntries.sort((a,b) => a[1] - b[1])[0] : ['N/A', 0];

    // Iron Rule Compliance
    const ritualCompliance = ironRules.map(rule => {
       let passedCount = 0;
       currentWeekInfo.days.forEach(day => {
          const p = weekPreps.find(prep => prep.date === day);
          const r = weekReviews.find(rev => rev.date === day);
          const isRitualPass = p?.ritualCompletions?.find(c => c.ruleId === rule.id)?.status === 'Pass';
          const isTradingPass = r?.ruleAdherence?.find(a => a.ruleId === rule.id)?.status === 'Pass';
          if (isRitualPass || isTradingPass) passedCount++;
       });
       return { label: rule.label, count: passedCount, total: 5 };
    });

    const goalsAchieved = weekReviews.reduce((sum, r) => sum + (r.goalResults?.filter(g => g.achieved).length || 0), 0);
    const totalMistakes = weekReviews.reduce((sum, r) => sum + (r.mistakes?.filter(m => m.trim() !== '').length || 0), 0);
    const dailyNotes = weekReviews.map(r => ({ date: r.date, text: r.mainTakeaway })).filter(n => n.text.trim() !== '');

    return { 
      pnl, 
      disciplinedPnL,
      validCount: validTrades.length,
      invalidCount: invalidTrades.length,
      count: weekTrades.length, 
      wr: weekTrades.length > 0 ? (wins / weekTrades.length) * 100 : 0,
      totalMistakes,
      goalsAchieved,
      dailyNotes,
      bestSession,
      worstSession,
      ritualCompliance,
      prepCount,
      auditCount
    };
  }, [trades, reviews, preps, currentWeekInfo, ironRules]);

  const navigateDate = (direction: 'prev' | 'next') => {
    const d = new Date(selectedDate);
    if (direction === 'prev') d.setDate(d.getDate() - 1);
    else d.setDate(d.getDate() + 1);
    const newDateStr = d.toLocaleDateString('en-CA');
    if (newDateStr <= today) { setSelectedDate(newDateStr); setView('timeline'); }
  };

  const currentPrep = useMemo(() => preps.find(p => p.date === selectedDate), [preps, selectedDate]);
  const currentReview = useMemo(() => reviews.find(r => r.date === selectedDate), [reviews, selectedDate]);
  const currentTrades = useMemo(() => trades.filter(t => t.date.startsWith(selectedDate)), [trades, selectedDate]);

  const rituals = ironRules.filter(r => r.type === 'ritual');
  const tradeRules = ironRules.filter(r => r.type === 'trading');

  const autoMistakes = useMemo(() => {
    const m = new Set<string>();
    currentTrades.forEach(t => t.mistakes?.forEach(mistake => m.add(mistake)));
    return Array.from(m);
  }, [currentTrades]);

  const [prepForm, setPrepForm] = useState<DailyPrep>({ id: `prep_${selectedDate}`, date: selectedDate, scenarios: { bullish: '', bearish: '', bullishImage: '', bearishImage: '' }, goals: standardGoals.length > 0 ? [...standardGoals] : [''], checklist: { sleptWell: false, planReady: false, disciplineCommitted: false, newsChecked: false }, ritualCompletions: rituals.map(r => ({ ruleId: r.id, status: 'Pending' })), mindsetState: '', confidence: 5 });
  const [reviewForm, setReviewForm] = useState<DailyReview>({ id: `review_${selectedDate}`, date: selectedDate, mainTakeaway: '', mistakes: autoMistakes.length > 0 ? autoMistakes : [''], lessons: '', rating: 0, goalResults: [], scenarioResult: 'Range', ruleAdherence: tradeRules.map(r => ({ ruleId: r.id, status: 'Pending' })) });

  useEffect(() => {
    if (currentPrep) setPrepForm(currentPrep);
    else setPrepForm({ id: `prep_${selectedDate}`, date: selectedDate, scenarios: { bullish: '', bearish: '', bullishImage: '', bearishImage: '' }, goals: standardGoals.length > 0 ? [...standardGoals] : [''], checklist: { sleptWell: false, planReady: false, disciplineCommitted: false, newsChecked: false }, ritualCompletions: rituals.map(r => ({ ruleId: r.id, status: 'Pending' })), mindsetState: '', confidence: 5 });
  }, [currentPrep, selectedDate, standardGoals, rituals.length]);

  useEffect(() => {
    if (currentReview) setReviewForm(currentReview);
    else {
      const initialResults: GoalResult[] = currentPrep ? currentPrep.goals.filter(g => g.trim() !== '').map(g => ({ text: g, achieved: true })) : [];
      setReviewForm({ id: `review_${selectedDate}`, date: selectedDate, mainTakeaway: '', mistakes: autoMistakes.length > 0 ? autoMistakes : [''], lessons: '', rating: 0, goalResults: initialResults, scenarioResult: 'Range', ruleAdherence: tradeRules.map(r => ({ ruleId: r.id, status: 'Pending' })) });
    }
  }, [currentReview, currentPrep, selectedDate, autoMistakes, tradeRules.length]);

  const handleToggleRitual = (ruleId: string) => {
    setPrepForm(prev => {
      const completions = prev.ritualCompletions || [];
      const index = completions.findIndex(c => c.ruleId === ruleId);
      const newCompletions = [...completions];
      if (index === -1) newCompletions.push({ ruleId, status: 'Pass' });
      else newCompletions[index] = { ...newCompletions[index], status: newCompletions[index].status === 'Pass' ? 'Pending' : 'Pass' };
      return { ...prev, ritualCompletions: newCompletions };
    });
  };

  const handleSetRuleStatus = (ruleId: string, status: 'Pass' | 'Fail') => {
    setReviewForm(prev => {
      const adherence = prev.ruleAdherence || [];
      const index = adherence.findIndex(a => a.ruleId === ruleId);
      const newAdherence = [...adherence];
      if (index === -1) newAdherence.push({ ruleId, status });
      else newAdherence[index] = { ...newAdherence[index], status };
      return { ...prev, ruleAdherence: newAdherence };
    });
  };

  const handlePaste = useCallback((e: ClipboardEvent) => {
    if (view !== 'edit-prep' || !activeImageField) return;
    const items = e.clipboardData?.items;
    if (items) {
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image') !== -1) {
          const blob = items[i].getAsFile();
          if (blob) {
            const reader = new FileReader();
            reader.onloadend = () => {
              const base64 = reader.result as string;
              setPrepForm(prev => ({ ...prev, scenarios: { ...prev.scenarios, [activeImageField === 'bullish' ? 'bullishImage' : 'bearishImage']: base64 } }));
            };
            reader.readAsDataURL(blob);
          }
        }
      }
    }
  }, [view, activeImageField]);

  useEffect(() => { window.addEventListener('paste', handlePaste); return () => window.removeEventListener('paste', handlePaste); }, [handlePaste]);

  const inputClass = `w-full px-4 py-3 rounded-xl border transition-all text-sm outline-none focus:ring-2 focus:ring-blue-500/40 ${theme === 'dark' ? 'bg-slate-950 border-slate-800 text-white placeholder-slate-600' : 'bg-slate-50 border-slate-200 text-slate-900'}`;
  const labelClass = `block text-[10px] font-black uppercase tracking-widest mb-2 text-slate-500`;

  return (
    <div className="space-y-6 lg:space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700 pb-20">
      <div className="flex justify-center">
        <div className={`p-1 rounded-2xl border flex gap-1 ${theme === 'dark' ? 'bg-slate-900/50 border-slate-800' : 'bg-white border-slate-200 shadow-sm'}`}>
          {[
            { id: 'daily', label: 'Daily', icon: Clock },
            { id: 'weekly', label: 'Weekly', icon: Calendar }
          ].map(tab => (
            <button key={tab.id} onClick={() => { setActiveTab(tab.id as any); setView('timeline'); }} className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-black uppercase transition-all ${activeTab === tab.id ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20' : 'text-slate-500 hover:text-slate-300'}`}><tab.icon size={14} /> {tab.label}</button>
          ))}
        </div>
      </div>

      {activeTab === 'daily' && (
        <DisciplineDashboard theme={theme} preps={preps} reviews={reviews} trades={trades} ironRules={ironRules} />
      )}

      <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-4 border-b border-slate-800/50 pb-6">
        <div className="space-y-2">
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 sm:gap-6">
            <h2 className={`text-3xl md:text-5xl font-black tracking-tighter italic ${theme === 'dark' ? 'text-white' : 'text-slate-900'}`}>
              {activeTab === 'daily' ? 'DAILY HUB' : 'WEEKLY HUB'}
            </h2>
            <div className="flex items-center gap-2 bg-slate-900/60 p-1 rounded-2xl border border-white/5 shadow-inner">
                 <button onClick={() => activeTab === 'daily' ? navigateDate('prev') : navigateWeek('prev')} className="p-2 hover:bg-white/10 rounded-xl text-slate-400 hover:text-white transition-all active:scale-90"><ChevronLeft size={20} /></button>
                 <div className="px-3 py-1 text-center min-w-[100px]">
                   <p className="text-[8px] font-black text-blue-500 uppercase tracking-[0.2em] mb-0.5">{activeTab === 'daily' ? 'Tactical Date' : `Week ${currentWeekInfo.weekNumber}`}</p>
                   <p className="text-xs font-black text-white font-mono">{activeTab === 'daily' ? selectedDate : currentWeekInfo.mondayDate}</p>
                 </div>
                 <button onClick={() => activeTab === 'daily' ? navigateDate('next') : navigateWeek('next')} disabled={activeTab === 'daily' && selectedDate === today} className={`p-2 rounded-xl transition-all active:scale-90 ${activeTab === 'daily' && selectedDate === today ? 'opacity-20 cursor-not-allowed' : 'hover:bg-white/10 text-slate-400 hover:text-white'}`}><ChevronRight size={20} /></button>
            </div>
          </div>
          <p className="text-slate-500 font-black uppercase text-[9px] tracking-[0.3em]">
            {activeTab === 'daily' ? `Chronological Feed • Trace Engine` : `Weekly Debrief • Týden ${currentWeekInfo.weekNumber}`}
          </p>
        </div>
        <div className="flex gap-2 w-full sm:w-auto">
          {view === 'timeline' && activeTab === 'daily' && (
            <><button onClick={() => setView('edit-prep')} className="flex-1 sm:flex-none px-4 py-3 bg-blue-600 text-white rounded-2xl font-black text-[10px] uppercase tracking-widest shadow-lg active:scale-95 transition-all">Ranní</button><button onClick={() => setView('edit-review')} className="flex-1 sm:flex-none px-4 py-3 bg-indigo-600 text-white rounded-2xl font-black text-[10px] uppercase tracking-widest shadow-lg active:scale-95 transition-all">Večerní</button></>
          )}
          {view !== 'timeline' && (<button onClick={() => setView('timeline')} className="w-full sm:w-auto flex items-center justify-center gap-2 px-6 py-2.5 rounded-xl font-bold text-xs bg-slate-800 text-slate-300 hover:bg-slate-700 transition-all active:scale-95"><LayoutGrid size={14} /> Feed</button>)}
        </div>
      </div>

      {activeTab === 'daily' && view === 'timeline' && (
        <TacticalTimeline date={selectedDate} prep={currentPrep} review={currentReview} trades={currentTrades} theme={theme} onEditPrep={() => setView('edit-prep')} onEditReview={() => setView('edit-review')} />
      )}

      {activeTab === 'weekly' && view === 'timeline' && (
        <div className="space-y-8 animate-in fade-in duration-500">
           {/* Mobile optimized weekly grid */}
           <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-4">
              {currentWeekInfo.days.map((dateStr) => {
                 const dayTrades = trades.filter(t => t.date.startsWith(dateStr));
                 const dayPrep = preps.find(p => p.date === dateStr);
                 const dayReview = reviews.find(r => r.date === dateStr);
                 return (
                    <div key={dateStr} className={`rounded-[28px] border overflow-hidden transition-all flex flex-col h-full ${theme === 'dark' ? 'bg-[#1E293B]/60 border-slate-800' : 'bg-white border-slate-200 shadow-sm'}`}>
                       <div className="p-4 border-b border-slate-800/50 flex justify-between items-center shrink-0">
                          <div>
                             <p className="text-[10px] font-black uppercase text-slate-500 tracking-widest">{new Date(dateStr).toLocaleString('cs-CZ', { weekday: 'long' })}</p>
                             <p className="text-[9px] font-bold text-slate-400">{dateStr}</p>
                          </div>
                          {dateStr === today && <span className="px-2 py-0.5 bg-blue-600 rounded-lg text-[7px] font-black uppercase text-white shadow-lg shadow-blue-500/20">Dnes</span>}
                       </div>
                       <div className="flex-1 overflow-y-auto custom-scrollbar no-scrollbar max-h-[400px]">
                          <TacticalTimeline 
                             date={dateStr} 
                             prep={dayPrep} 
                             review={dayReview} 
                             trades={dayTrades} 
                             theme={theme} 
                             onEditPrep={() => { setSelectedDate(dateStr); setView('edit-prep'); setActiveTab('daily'); }} 
                             onEditReview={() => { setSelectedDate(dateStr); setView('edit-review'); setActiveTab('daily'); }}
                             isMini={true}
                          />
                       </div>
                    </div>
                 );
              })}
           </div>

           {/* Summary Section */}
           <div className={`p-6 md:p-10 rounded-[40px] border relative overflow-hidden ${theme === 'dark' ? 'bg-[#0F172A]/40 border-slate-800' : 'bg-white border-slate-200 shadow-xl'}`}>
              <div className="relative z-10 grid grid-cols-1 lg:grid-cols-12 gap-8 md:gap-12">
                 
                 <div className="lg:col-span-4 space-y-8 md:space-y-12">
                    <div className="space-y-6">
                       <p className="text-[10px] font-black uppercase text-blue-500 tracking-[0.2em] flex items-center gap-2"><Layers size={14} /> Weekly Alpha Metrics</p>
                       <div className="grid grid-cols-2 gap-y-6 md:gap-y-8 gap-x-6">
                          <div><p className="text-[9px] font-bold text-slate-500 uppercase mb-1">Skutečné PnL</p><p className={`text-2xl md:text-3xl font-black ${weeklyStats.pnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>${weeklyStats.pnl.toLocaleString()}</p></div>
                          <div><p className="text-[9px] font-bold text-slate-500 uppercase mb-1">Disciplinované</p><p className={`text-2xl md:text-3xl font-black text-blue-500`}>${weeklyStats.disciplinedPnL.toLocaleString()}</p></div>
                          <div><p className="text-[9px] font-bold text-slate-500 uppercase mb-1">Exekuce</p><div className="flex items-center gap-2"><p className="text-xl font-black text-white">{weeklyStats.validCount}/{weeklyStats.count}</p></div></div>
                          <div><p className="text-[9px] font-bold text-slate-500 uppercase mb-1">Win Rate</p><p className="text-xl font-black text-white">{weeklyStats.wr.toFixed(1)}%</p></div>
                          
                          <div className="col-span-2 grid grid-cols-2 gap-3">
                             <div className="p-3 rounded-2xl bg-blue-600/5 border border-blue-500/10"><p className="text-[8px] font-black text-slate-500 uppercase mb-1 flex items-center gap-1"><Sun size={10} /> Ranní Hub</p><p className="text-lg font-black text-blue-400">{weeklyStats.prepCount}/5</p></div>
                             <div className={`p-3 rounded-2xl ${weeklyStats.auditCount === 5 ? 'bg-emerald-600/5 border-emerald-500/10' : 'bg-indigo-600/5 border-indigo-500/10'}`}><p className="text-[8px] font-black text-slate-500 uppercase mb-1 flex items-center gap-1"><Moon size={10} /> Večerní Hub</p><p className="text-lg font-black text-indigo-400">{weeklyStats.auditCount}/5</p></div>
                          </div>
                       </div>
                    </div>
                 </div>

                 <div className="lg:col-span-4 space-y-6 md:space-y-8">
                    <p className="text-[10px] font-black uppercase text-amber-500 tracking-[0.2em] flex items-center gap-2"><Target size={14} /> Iron Rule Progress</p>
                    <div className="space-y-5">
                       {weeklyStats.ritualCompliance.map((ritual, idx) => (
                          <div key={idx} className="space-y-2">
                             <div className="flex justify-between text-[10px] font-black uppercase tracking-tighter">
                                <span className="text-slate-400 truncate pr-2">{ritual.label}</span>
                                <span className={ritual.count >= 4 ? 'text-emerald-500' : 'text-blue-500'}>{ritual.count}/5</span>
                             </div>
                             <div className="h-1.5 w-full bg-slate-900/50 rounded-full overflow-hidden flex gap-0.5 p-0.5">
                                {[...Array(5)].map((_, i) => (
                                   <div key={i} className={`flex-1 rounded-full ${i < ritual.count ? 'bg-blue-600 shadow-[0_0_8px_rgba(37,99,235,0.4)]' : 'bg-slate-800'}`} />
                                ))}
                             </div>
                          </div>
                       ))}
                    </div>
                    
                    <div className="pt-6 border-t border-slate-800/50 grid grid-cols-2 gap-4">
                       <div>
                          <p className="text-[9px] font-black uppercase text-rose-500 mb-1">Errors</p>
                          <p className="text-3xl font-black text-rose-500">{weeklyStats.totalMistakes}</p>
                       </div>
                       <div className="text-right">
                          <p className="text-[9px] font-black uppercase text-emerald-500 mb-1">Goals</p>
                          <p className="text-3xl font-black text-emerald-500">{weeklyStats.goalsAchieved}</p>
                       </div>
                    </div>
                 </div>

                 <div className="lg:col-span-4 flex flex-col">
                    <p className="text-[10px] font-black uppercase text-slate-500 tracking-[0.2em] flex items-center gap-2 mb-6"><StickyNote size={14} /> Daily Feed Stream</p>
                    <div className="space-y-3 overflow-y-auto custom-scrollbar no-scrollbar max-h-[350px]">
                       {weeklyStats.dailyNotes.length > 0 ? weeklyStats.dailyNotes.map((note, idx) => (
                         <div key={idx} className="p-4 rounded-2xl bg-slate-950/40 border border-white/5 relative group transition-all">
                            <p className="text-[8px] font-black text-blue-500 uppercase mb-1.5">{new Date(note.date).toLocaleString('cs-CZ', { weekday: 'short', day: 'numeric', month: 'numeric' })}</p>
                            <p className="text-xs text-slate-300 italic leading-relaxed">"{note.text}"</p>
                         </div>
                       )) : (
                         <div className="h-32 flex flex-col items-center justify-center border border-dashed border-slate-800 rounded-2xl opacity-30">
                            <ClipboardCheck size={20} className="mb-2" />
                            <p className="text-[9px] font-black uppercase">No logs</p>
                         </div>
                       )}
                    </div>
                 </div>

              </div>
           </div>
        </div>
      )}

      {/* EDIT FORMS */}
      {(view === 'edit-prep' || view === 'edit-review') && (
        <div className="max-w-4xl mx-auto animate-in slide-in-from-right-4 duration-500">
          {view === 'edit-prep' && (
            <div className="space-y-6 lg:space-y-8">
              <section className={`p-6 md:p-8 rounded-[32px] md:rounded-[40px] border ${theme === 'dark' ? 'bg-slate-900/50 border-slate-800' : 'bg-white border-slate-200'}`}>
                <div className="flex items-center gap-4 mb-6 md:mb-8"><div className="p-3 rounded-2xl bg-blue-500/10 text-blue-500"><Zap size={20} /></div><div><h3 className="text-xl md:text-2xl font-black italic uppercase">PREATTACK</h3><p className="text-[9px] font-black uppercase text-slate-500 tracking-widest">Ranní aktivace</p></div></div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{rituals.map(ritual => { const comp = prepForm.ritualCompletions?.find(c => c.ruleId === ritual.id); const isDone = comp?.status === 'Pass'; return (<button key={ritual.id} onClick={() => handleToggleRitual(ritual.id)} className={`p-4 rounded-xl border flex items-center justify-between transition-all active:scale-95 ${isDone ? 'bg-emerald-600 border-emerald-500 text-white shadow-lg shadow-emerald-600/20' : (theme === 'dark' ? 'bg-slate-950 border-slate-800 text-slate-400' : 'bg-slate-50 border-slate-200 text-slate-600')}`}><span className="text-[10px] font-black uppercase tracking-tight text-left pr-2">{ritual.label}</span>{isDone ? <Check size={16} /> : <div className="w-4 h-4 rounded-full border border-slate-800 shrink-0" />}</button>); })}</div>
              </section>
              <section className={`p-6 md:p-8 rounded-[32px] md:rounded-[40px] border ${theme === 'dark' ? 'bg-slate-900/50 border-slate-800' : 'bg-white border-slate-200 shadow-sm'}`}>
                <div className="flex items-center gap-4 mb-6 md:mb-8"><div className="p-3 rounded-2xl bg-blue-500/10 text-blue-500"><Sparkles size={20} /></div><div><h3 className="text-xl md:text-2xl font-black italic uppercase">SCENARIOS</h3><p className="text-[9px] font-black uppercase text-slate-500 tracking-widest">Vizualizace & Mapping</p></div></div>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 md:gap-10">
                  <div className="space-y-4"><label className={`${labelClass} text-emerald-500`}>Bullish Scénář</label><textarea value={prepForm.scenarios.bullish} onChange={e => setPrepForm({...prepForm, scenarios: {...prepForm.scenarios, bullish: e.target.value}})} className={`${inputClass} h-32 resize-none`} /><div onClick={() => setActiveImageField('bullish')} className={`relative aspect-video rounded-2xl border-2 border-dashed transition-all flex flex-col items-center justify-center cursor-pointer overflow-hidden ${prepForm.scenarios.bullishImage ? 'border-emerald-500' : (activeImageField === 'bullish' ? 'border-blue-500 bg-blue-500/5' : 'border-slate-800 bg-slate-950/20')}`}>{prepForm.scenarios.bullishImage ? (<img src={prepForm.scenarios.bullishImage} className="w-full h-full object-cover" />) : (<div className="text-center p-4"><ImageIcon size={20} className="mx-auto mb-2 text-slate-700" /><p className="text-[8px] font-black uppercase text-slate-600">Vložit (CTRL+V)</p></div>)}</div></div>
                  <div className="space-y-4"><label className={`${labelClass} text-rose-500`}>Bearish Scénář</label><textarea value={prepForm.scenarios.bearish} onChange={e => setPrepForm({...prepForm, scenarios: {...prepForm.scenarios, bearish: e.target.value}})} className={`${inputClass} h-32 resize-none`} /><div onClick={() => setActiveImageField('bearish')} className={`relative aspect-video rounded-2xl border-2 border-dashed transition-all flex flex-col items-center justify-center cursor-pointer overflow-hidden ${prepForm.scenarios.bearishImage ? 'border-rose-500' : (activeImageField === 'bearish' ? 'border-blue-500 bg-blue-500/5' : 'border-slate-800 bg-slate-950/20')}`}>{prepForm.scenarios.bearishImage ? (<img src={prepForm.scenarios.bearishImage} className="w-full h-full object-cover" />) : (<div className="text-center p-4"><ImageIcon size={20} className="mx-auto mb-2 text-slate-700" /><p className="text-[8px] font-black uppercase text-slate-600">Vložit (CTRL+V)</p></div>)}</div></div>
                </div>
                <button onClick={() => { onSavePrep(prepForm); setView('timeline'); window.scrollTo(0,0); }} className="w-full mt-8 py-4 bg-blue-600 rounded-2xl font-black text-[10px] uppercase tracking-widest text-white shadow-xl active:scale-95 transition-all">ULOŽIT PLÁN</button>
              </section>
            </div>
          )}
          {view === 'edit-review' && (
            <div className="space-y-6 lg:space-y-8">
              <section className={`p-6 md:p-8 rounded-[32px] md:rounded-[40px] border ${theme === 'dark' ? 'bg-slate-900/50 border-slate-800' : 'bg-white border-slate-200'}`}>
                <div className="flex items-center gap-4 mb-6 md:mb-8"><div className="p-3 rounded-2xl bg-amber-500/10 text-amber-500"><ShieldAlert size={20} /></div><div><h3 className="text-xl md:text-2xl font-black italic uppercase">EXECUTION AUDIT</h3><p className="text-[9px] font-black uppercase text-slate-500 tracking-widest">Dodržení pravidel</p></div></div>
                <div className="space-y-3 md:space-y-4">{tradeRules.map(rule => { const comp = reviewForm.ruleAdherence?.find(a => a.ruleId === rule.id); const status = comp?.status || 'Pending'; return (<div key={rule.id} className={`p-4 md:p-5 rounded-2xl border flex flex-col sm:flex-row sm:items-center justify-between gap-4 ${theme === 'dark' ? 'bg-slate-950/50 border-slate-800' : 'bg-slate-50 border-slate-200'}`}><div className="flex-1"><h4 className="text-[11px] font-black uppercase tracking-widest">{rule.label}</h4></div><div className="flex gap-2"><button onClick={() => handleSetRuleStatus(rule.id, 'Pass')} className={`flex-1 sm:flex-none px-6 py-2 rounded-xl font-black text-[9px] uppercase tracking-widest transition-all ${status === 'Pass' ? 'bg-emerald-600 text-white' : 'bg-slate-900 text-slate-600'}`}>Pass</button><button onClick={() => handleSetRuleStatus(rule.id, 'Fail')} className={`flex-1 sm:flex-none px-6 py-2 rounded-xl font-black text-[9px] uppercase tracking-widest transition-all ${status === 'Fail' ? 'bg-rose-600 text-white' : 'bg-slate-900 text-slate-600'}`}>Fail</button></div></div>); })}</div>
              </section>
              <section className={`p-6 md:p-8 rounded-[32px] md:rounded-[40px] border ${theme === 'dark' ? 'bg-slate-900/50 border-slate-800' : 'bg-white border-slate-200 shadow-sm'}`}>
                <div className="flex items-center gap-4 mb-6 md:mb-8"><div className="p-3 rounded-2xl bg-indigo-500/10 text-indigo-500"><ShieldCheck size={20} /></div><div><h3 className="text-xl md:text-2xl font-black italic uppercase">AUDIT HUB</h3><p className="text-[9px] font-black uppercase text-slate-500 tracking-widest">Reflexe dne</p></div></div>
                <div className="space-y-6">
                  <div><label className={labelClass}>Hlavní poznatek</label><textarea value={reviewForm.mainTakeaway} onChange={e => setReviewForm({...reviewForm, mainTakeaway: e.target.value})} className={`${inputClass} h-32 resize-none`} /></div>
                  <div className={`p-5 md:p-6 rounded-[28px] border ${theme === 'dark' ? 'bg-rose-500/5 border-rose-500/10' : 'bg-rose-50 border-rose-100'}`}><p className="text-[10px] font-black uppercase text-rose-500 mb-4 flex items-center gap-2"><AlertOctagon size={14} /> Chyby dne</p><div className="flex flex-wrap gap-2">{reviewForm.mistakes.map((m, i) => (<div key={i} className="flex items-center gap-2 px-3 py-1.5 bg-slate-950/50 border border-slate-800 rounded-xl"><span className="text-[10px] font-black uppercase text-slate-300">{m}</span><button onClick={() => setReviewForm({...reviewForm, mistakes: reviewForm.mistakes.filter((_, idx) => idx !== i)})} className="text-slate-600 hover:text-rose-500"><X size={12} /></button></div>))}<button onClick={() => setReviewForm({...reviewForm, mistakes: [...reviewForm.mistakes, '']})} className="p-2 border border-dashed border-slate-700 rounded-xl text-slate-500 hover:text-blue-500 active:scale-95 transition-all"><Plus size={14} /></button></div></div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4"><div className="p-5 rounded-2xl bg-slate-950/50 border border-slate-800 text-center"><p className={labelClass}>Rating Disciplíny</p><div className="flex justify-center gap-2 mt-2">{[1,2,3,4,5].map(s => (<button key={s} onClick={() => setReviewForm({...reviewForm, rating: s})} className="active:scale-125 transition-transform"><Star key={s} size={20} className={s <= reviewForm.rating ? 'text-yellow-500 fill-yellow-500' : 'text-slate-700'} /></button>))}</div></div><div className="p-5 rounded-2xl bg-slate-950/50 border border-slate-800 text-center"><p className={labelClass}>PnL Dne</p><p className={`text-xl font-black ${currentTrades.reduce((s,t)=>s+t.pnl,0) >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>${currentTrades.reduce((s,t)=>s+t.pnl,0).toLocaleString()}</p></div></div><button onClick={() => { onSaveReview(reviewForm); setView('timeline'); window.scrollTo(0,0); }} className="w-full py-4 bg-indigo-600 text-white rounded-2xl font-black uppercase text-[10px] tracking-widest shadow-xl active:scale-95 transition-all">UZAVŘÍT AUDIT</button></div>
              </section>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default DailyJournal;
