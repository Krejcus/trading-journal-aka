
import React, { useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Trash2, Plus, Brain, X, Target,
  Monitor, Zap, Globe, Clock, AlertOctagon, ShieldCheck,
  ShieldAlert, Activity, Check, ChevronLeft,
  ChevronRight, Sparkles, Sliders, Shield, Bell, AlertCircle
} from 'lucide-react';
import ConfirmationModal from './ConfirmationModal';
import { CustomEmotion, SessionConfig, IronRule, PsychoMetricConfig, WeeklyFocus, SystemSettings } from '../types';

interface SettingsProps {
  theme: 'dark' | 'light' | 'oled';
  userEmotions: CustomEmotion[];
  setUserEmotions: React.Dispatch<React.SetStateAction<CustomEmotion[]>>;
  userMistakes: string[];
  setUserMistakes: React.Dispatch<React.SetStateAction<string[]>>;
  htfOptions: string[];
  setHtfOptions: React.Dispatch<React.SetStateAction<string[]>>;
  ltfOptions: string[];
  setLtfOptions: React.Dispatch<React.SetStateAction<string[]>>;
  sessions: SessionConfig[];
  setSessions: React.Dispatch<React.SetStateAction<SessionConfig[]>>;
  ironRules: IronRule[];
  setIronRules: React.Dispatch<React.SetStateAction<IronRule[]>>;
  psychoMetrics: PsychoMetricConfig[];
  setPsychoMetrics: React.Dispatch<React.SetStateAction<PsychoMetricConfig[]>>;
  weeklyFocusList: WeeklyFocus[];
  setWeeklyFocusList: React.Dispatch<React.SetStateAction<WeeklyFocus[]>>;
  systemSettings: SystemSettings;
  setSystemSettings: (settings: SystemSettings) => void;
  standardGoals: string[];
  setStandardGoals: (goals: string[]) => void;
  onEnableNotifications?: () => void;
  appVersion?: string;
  onHardRefresh?: () => void;
  accentColor?: string;
  onAccentColorChange?: (color: string) => void;
}

// Global Helper for Weekly Focus Consistency
const getWeekISOString = (date: Date) => {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
};

const COMMON_EMOJIS = ['🎯', '🔥', '💎', '🚀', '📈', '🧘', '🧠', '⚡', '🏆', '💰', '📉', '🛡️', '✅', '❌', '⏰', '📅', '📊', '💪', '🦁', '🦅'];

const EmojiPicker = ({ onSelect, onClose, isDark }: { onSelect: (e: string) => void, onClose: () => void, isDark: boolean }) => (
  <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={onClose}>
    <motion.div
      initial={{ scale: 0.9, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      className={`p-6 rounded-[32px] border shadow-2xl max-w-[280px] ${isDark ? 'bg-slate-900 border-white/10' : 'bg-[var(--bg-card)] border-[var(--border-subtle)]'}`}
      onClick={e => e.stopPropagation()}
    >
      <div className="grid grid-cols-5 gap-3">
        {COMMON_EMOJIS.map(emoji => (
          <button
            key={emoji}
            onClick={() => { onSelect(emoji); onClose(); }}
            className={`w-10 h-10 rounded-xl text-xl flex items-center justify-center transition-all ${isDark ? 'hover:bg-white/10 active:bg-white/20' : 'hover:bg-[var(--bg-page)] active:bg-[var(--border-subtle)]'}`}
          >
            {emoji}
          </button>
        ))}
      </div>
    </motion.div>
  </div>
);

// Visual Components defined OUTSIDE to prevent remounting on every parent render
const SectionHeader = ({ icon: Icon, title, subtitle, color, isDark }: any) => (
  <div className="flex items-center gap-4 mb-6">
    <div className={`p-3 rounded-2xl ${color} text-white shadow-lg`}>
      <Icon size={20} />
    </div>
    <div>
      <h3 className={`text-lg font-black tracking-tight uppercase ${isDark ? 'text-white' : 'text-[var(--text-primary)]'}`}>{title}</h3>
      <p className="text-[10px] font-bold uppercase tracking-widest text-[var(--text-muted)]">{subtitle}</p>
    </div>
  </div>
);

const InputField = ({ value, onChange, placeholder, onKeyDown, icon: Icon, type = "text", isDark }: any) => (
  <div className="relative group/input flex-1">
    {Icon && <Icon size={14} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500 group-focus-within/input:text-blue-500 transition-colors" />}
    <input
      type={type}
      value={value}
      onChange={onChange}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      className={`w-full ${Icon ? 'pl-11' : 'px-4'} py-3.5 rounded-2xl text-xs font-bold outline-none border transition-all ${isDark ? 'bg-white/5 border-white/5 focus:bg-white/10 focus:border-blue-500/50 text-white' : 'bg-[var(--bg-input)] border-[var(--border-subtle)] focus:border-[var(--border-active)] text-[var(--text-primary)]'
        }`}
    />
  </div>
);

const Card = ({ children, className = "", isDark }: any) => (
  <div className={`p-6 rounded-[32px] border ${isDark ? 'bg-[#0a0f1d]/60 border-white/5 shadow-2xl backdrop-blur-xl' : 'bg-[var(--bg-card)] border-[var(--border-subtle)] shadow-sm backdrop-blur-md'} ${className}`}>
    {children}
  </div>
);

const Toggle = ({ active, onClick, label, desc, isDark }: any) => (
  <div className={`flex items-center justify-between p-4 rounded-2xl border transition-all group cursor-pointer ${isDark ? 'border-white/5 hover:bg-white/5' : 'border-[var(--border-subtle)] hover:bg-[var(--bg-page)]'}`} onClick={onClick}>
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] font-black uppercase tracking-widest text-[var(--text-primary)]">{label}</span>
      {desc && <span className="text-[9px] text-[var(--text-muted)] font-bold">{desc}</span>}
    </div>
    <div className={`w-10 h-5 rounded-full transition-all relative ${active ? 'bg-[var(--text-secondary)] shadow-[0_0_12px_var(--border-active)]' : (isDark ? 'bg-slate-800' : 'bg-[var(--border-subtle)]')}`}>
      <div className={`absolute top-1 w-3 h-3 rounded-full bg-white transition-all ${active ? 'left-6' : 'left-1'}`} />
    </div>
  </div>
);

const Settings: React.FC<SettingsProps> = ({
  theme, userEmotions, setUserEmotions,
  userMistakes, setUserMistakes,
  htfOptions, setHtfOptions, ltfOptions, setLtfOptions,
  sessions, setSessions,
  ironRules, setIronRules,
  psychoMetrics, setPsychoMetrics,
  weeklyFocusList, setWeeklyFocusList,
  systemSettings, setSystemSettings,
  standardGoals, setStandardGoals,
  onEnableNotifications, appVersion, onHardRefresh,
  accentColor = 'blue',
  onAccentColorChange
}) => {
  const [activeTab, setActiveTab] = useState<'psychology' | 'strategy' | 'market' | 'system'>('psychology');
  const isDark = theme !== 'light';

  // Local State for adding items
  const [newHtf, setNewHtf] = useState('');
  const [newLtf, setNewLtf] = useState('');
  const [newMistake, setNewMistake] = useState('');
  const [newEmoLabel, setNewEmoLabel] = useState('');
  const [newRuleLabel, setNewRuleLabel] = useState('');
  const [newRuleType, setNewRuleType] = useState<'ritual' | 'trading'>('ritual');
  const [newMetricLabel, setNewMetricLabel] = useState('');
  const [newMetricColor, setNewMetricColor] = useState('#3b82f6');
  const [newStandardGoal, setNewStandardGoal] = useState('');
  const [emojiPickerTarget, setEmojiPickerTarget] = useState<{ goalIdx: number } | null>(null);

  const [itemToDelete, setItemToDelete] = useState<{ id: string | number, type: 'metric' | 'rule' | 'emotion' | 'mistake' | 'session' | 'goal' } | null>(null);
  const [toast, setToast] = useState<{ message: string, id: number } | null>(null);

  const showToast = (message: string) => {
    setToast({ message, id: Date.now() });
    setTimeout(() => {
      setToast(prev => prev?.message === message ? null : prev);
    }, 2000);
  };

  // Weekly Focus Logic with standardized helper
  const [selectedWeek, setSelectedWeek] = useState(() => getWeekISOString(new Date()));

  const handleWeekChange = (dir: number) => {
    setSelectedWeek(current => {
      const [year, week] = current.split('-W').map(Number);
      const d = new Date(Date.UTC(year, 0, 1));
      const dayNum = d.getUTCDay() || 7;
      // Go to Monday of that week
      d.setUTCDate(d.getUTCDate() + (week - 1) * 7 - dayNum + 1);
      // Apply offset
      d.setUTCDate(d.getUTCDate() + (dir * 7));
      return getWeekISOString(d);
    });
  };

  const getWeekRange = (weekISO: string) => {
    const [year, week] = weekISO.split('-W').map(Number);
    const d = new Date(Date.UTC(year, 0, 1));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + (week - 1) * 7 - dayNum + 1);
    const mon = new Date(d);
    const sun = new Date(d);
    sun.setUTCDate(sun.getUTCDate() + 6);
    return `${mon.getUTCDate()}.${mon.getUTCMonth() + 1}. - ${sun.getUTCDate()}.${sun.getUTCMonth() + 1}.`;
  };

  // Re-compute current focus ensuring strict filtering by weekISO
  const currentWeeklyFocus = useMemo(() => {
    return weeklyFocusList.find(wf => wf.weekISO === selectedWeek) || { id: '', weekISO: selectedWeek, goals: [] };
  }, [weeklyFocusList, selectedWeek]);

  // Handlers
  const addMistake = () => { if (newMistake && !userMistakes.includes(newMistake)) { setUserMistakes([...userMistakes, newMistake]); setNewMistake(''); showToast('Chyba přidána'); } };
  const addEmo = () => { if (newEmoLabel) { setUserEmotions([...userEmotions, { id: Date.now().toString(), label: newEmoLabel, icon: '' }]); setNewEmoLabel(''); showToast('Emoce přidána'); } };
  const addMetric = () => { if (newMetricLabel.trim()) { setPsychoMetrics([...psychoMetrics, { id: `metric_${Date.now()}`, label: newMetricLabel, color: newMetricColor }]); setNewMetricLabel(''); showToast('Metrika přidána'); } };
  const addIronRule = () => { if (newRuleLabel) { setIronRules([...ironRules, { id: `rule_${Date.now()}`, label: newRuleLabel, type: newRuleType }]); setNewRuleLabel(''); showToast('Pravidlo přidáno'); } };
  const addHtf = () => { if (newHtf && !htfOptions.includes(newHtf)) { setHtfOptions([...htfOptions, newHtf]); setNewHtf(''); showToast('HTF přidána'); } };
  const addLtf = () => { if (newLtf && !ltfOptions.includes(newLtf)) { setLtfOptions([...ltfOptions, newLtf]); setNewLtf(''); showToast('LTF přidána'); } };
  const addStandardGoal = () => { if (newStandardGoal && !standardGoals.includes(newStandardGoal)) { setStandardGoals([...standardGoals, newStandardGoal]); setNewStandardGoal(''); showToast('Cíl přidán'); } };
  const addSession = () => { setSessions([...sessions, { id: `session_${Date.now()}`, name: 'Nová Seance', startTime: '09:00', endTime: '17:00', color: '#6366f1' }]); showToast('Seance vytvořena'); };
  const updateSession = (id: string, up: Partial<SessionConfig>) => { setSessions(sessions.map(s => s.id === id ? { ...s, ...up } : s)); showToast('Seance aktualizována'); };

  const updateSystem = (key: keyof SystemSettings, val: any) => {
    setSystemSettings({ ...systemSettings, [key]: val });
    showToast('Nastavení aktualizováno');
  };

  const tabs = [
    { id: 'psychology', label: 'Psychologie', icon: Brain, desc: 'Emoce & Metriky' },
    { id: 'strategy', label: 'Strategie', icon: Target, desc: 'Pravidla & Focus' },
    { id: 'market', label: 'Trh', icon: Clock, desc: 'Seance & Čas' },
    { id: 'system', label: 'Systém', icon: Shield, desc: 'Alpha Guardian' },
  ] as const;

  return (
    <div className="max-w-7xl mx-auto pb-20 space-y-6">
      {/* Top Navbar Style */}
      <div className={`p-2 rounded-[28px] border flex flex-wrap items-center justify-center gap-2 ${isDark ? 'bg-black/40 border-white/5 backdrop-blur-3xl' : 'bg-[var(--bg-card)] border-[var(--border-subtle)] shadow-xl'}`}>
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`
              flex items-center gap-3 px-6 py-2.5 rounded-2xl text-[11px] font-black uppercase tracking-widest transition-all duration-300 border relative group overflow-hidden
              ${activeTab === tab.id
                ? 'bg-[var(--text-secondary)] border-[var(--border-active)] text-white shadow-lg shadow-[var(--border-active)]/30'
                : (isDark
                  ? 'bg-transparent border-transparent text-slate-500 hover:bg-white/5 hover:text-white'
                  : 'bg-transparent border-transparent text-[var(--text-muted)] hover:bg-[var(--bg-page)] hover:text-[var(--text-primary)]')
              }
            `}
          >
            <tab.icon size={16} className={activeTab === tab.id ? 'animate-pulse' : ''} />
            <span>{tab.label}</span>
            {activeTab === tab.id && (
              <motion.div layoutId="setting-tab-indicator" className="absolute bottom-0 left-0 right-0 h-0.5 bg-white/30" />
            )}
            <div className="absolute inset-0 bg-gradient-to-r from-white/0 via-white/5 to-white/0 opacity-0 group-hover:opacity-100 -translate-x-full group-hover:translate-x-full transition-all duration-1000"></div>
          </button>
        ))}
      </div>

      {/* Main Content Area */}
      <main className="min-w-0">
        <div className="space-y-6">
          {activeTab === 'psychology' && (
            <div className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <Card isDark={isDark}>
                  <SectionHeader icon={Activity} title="Metriky Psychiky" subtitle="Posuvníky pro denní audit" color="bg-indigo-600" isDark={isDark} />
                  <div className="space-y-3 mb-6">
                    {psychoMetrics.map(m => (
                      <div key={m.id} className={`flex items-center justify-between p-3.5 rounded-2xl border ${isDark ? 'bg-white/5 border-white/5' : 'bg-slate-50 border-slate-100'} group`}>
                        <div className="flex items-center gap-3">
                          <div className="w-2.5 h-2.5 rounded-full shadow-[0_0_8px_currentColor]" style={{ color: m.color, backgroundColor: m.color }} />
                          <span className="text-[10px] font-black uppercase tracking-widest">{m.label}</span>
                        </div>
                        <button onClick={() => setItemToDelete({ id: m.id, type: 'metric' })} className="p-2 text-slate-500 hover:text-rose-500 opacity-0 group-hover:opacity-100 transition-all"><Trash2 size={14} /></button>
                      </div>
                    ))}
                  </div>
                  <div className="flex gap-2 p-1.5 rounded-[22px] bg-indigo-500/5 border border-indigo-500/10">
                    <input value={newMetricLabel} onChange={e => setNewMetricLabel(e.target.value)} onKeyDown={e => e.key === 'Enter' && addMetric()} placeholder="Název metriky..." className="flex-1 bg-transparent px-4 py-2 text-[10px] font-bold outline-none" />
                    <input type="color" value={newMetricColor} onChange={e => setNewMetricColor(e.target.value)} className="w-10 h-10 rounded-xl bg-transparent border-0 cursor-pointer p-0" />
                    <button onClick={addMetric} className="w-10 h-10 rounded-xl bg-indigo-600 text-white flex items-center justify-center hover:bg-indigo-500 shadow-lg active:scale-90 transition-all"><Plus size={20} /></button>
                  </div>
                </Card>

                <Card isDark={isDark}>
                  <SectionHeader icon={AlertOctagon} title="Katalog Chyb" subtitle="Identifikace slabých stránek" color="bg-rose-600" isDark={isDark} />
                  <div className="flex flex-wrap gap-2 mb-6 max-h-[160px] overflow-y-auto custom-scrollbar pr-2">
                    {userMistakes.map(m => (
                      <div key={m} className={`group flex items-center gap-2 px-4 py-1.5 rounded-full border text-[9px] font-black uppercase transition-all ${isDark ? 'bg-rose-500/5 border-rose-500/20 text-rose-400 hover:bg-rose-500 hover:text-white' : 'bg-rose-50 border-slate-100 text-rose-600 hover:bg-rose-600 hover:text-white'}`}>
                        <span>{m}</span>
                        <button onClick={() => { setUserMistakes(prev => prev.filter(x => x !== m)); showToast('Odstraněno'); }} className="opacity-40 group-hover:opacity-100"><X size={12} /></button>
                      </div>
                    ))}
                  </div>
                  <div className="flex gap-2 p-1.5 rounded-[22px] bg-rose-500/5 border border-rose-500/10">
                    <InputField value={newMistake} onChange={(e: any) => setNewMistake(e.target.value)} onKeyDown={(e: any) => e.key === 'Enter' && addMistake()} placeholder="Přidat chybu (např. Overtrading)" isDark={isDark} />
                    <button onClick={addMistake} className="w-12 rounded-xl bg-rose-600 text-white flex items-center justify-center hover:bg-rose-500 shadow-lg active:scale-95 transition-all"><Plus size={20} /></button>
                  </div>
                </Card>
              </div>

              <Card isDark={isDark}>
                <SectionHeader icon={Brain} title="Emoční Mapa" subtitle="Vliv emocí na rozhodování" color="bg-purple-600" isDark={isDark} />
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
                  {userEmotions.map(emo => (
                    <div key={emo.id} className={`p-4 rounded-2xl border flex flex-col items-center justify-center gap-2 text-center group transition-all duration-300 hover:translate-y-[-2px] relative ${isDark ? 'bg-white/5 border-white/5 hover:border-purple-500/40 hover:bg-purple-500/5' : 'bg-slate-50 border-slate-100 hover:shadow-md'}`}>
                      <div className="w-1.5 h-1.5 rounded-full bg-purple-500 shadow-[0_0_8px_rgba(168,85,247,0.8)]" />
                      <span className="text-[10px] font-black uppercase tracking-tight text-slate-400 group-hover:text-purple-400">{emo.label}</span>
                      <button onClick={() => { setUserEmotions(prev => prev.filter(e => e.id !== emo.id)); showToast('Odstraněno'); }} className="absolute top-2 right-2 p-1 text-slate-600 hover:text-rose-500 opacity-0 group-hover:opacity-100 transition-all"><X size={10} /></button>
                    </div>
                  ))}
                </div>
                <div className="flex gap-2 max-w-md mx-auto p-1.5 rounded-[22px] bg-purple-500/5 border border-purple-500/10">
                  <InputField value={newEmoLabel} onChange={(e: any) => setNewEmoLabel(e.target.value)} onKeyDown={(e: any) => e.key === 'Enter' && addEmo()} placeholder="Nová emoce..." isDark={isDark} />
                  <button onClick={addEmo} className="px-6 rounded-xl bg-purple-600 text-white text-[10px] font-black uppercase tracking-widest hover:bg-purple-500 shadow-lg active:scale-95 transition-all">Přidat</button>
                </div>
              </Card>
            </div>
          )}

          {activeTab === 'strategy' && (
            <div className="space-y-6">
              <Card isDark={isDark}>
                <SectionHeader icon={ShieldCheck} title="Železná Pravidla" subtitle="Tvůj denní kodex disciplíny" color="bg-blue-600" isDark={isDark} />
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                  {ironRules.map(rule => (
                    <div key={rule.id} className={`relative p-5 rounded-[24px] border group transition-all ${isDark ? 'bg-white/5 border-white/5 hover:border-blue-500/30' : 'bg-slate-50 border-slate-100 hover:shadow-lg'}`}>
                      <div className="flex items-center gap-4">
                        <div className={`w-12 h-12 rounded-2xl flex items-center justify-center shadow-lg ${rule.type === 'ritual' ? 'bg-indigo-600 text-white shadow-indigo-600/20' : 'bg-blue-600 text-white shadow-blue-600/20'}`}>
                          {rule.type === 'ritual' ? <Zap size={20} /> : <ShieldAlert size={20} />}
                        </div>
                        <div>
                          <p className="text-xs font-black uppercase tracking-tight mb-1">{rule.label}</p>
                          <div className="flex items-center gap-2">
                            <span className={`text-[8px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded-md ${rule.type === 'ritual' ? 'bg-indigo-500/20 text-indigo-400' : 'bg-blue-500/20 text-blue-400'}`}>
                              {rule.type === 'ritual' ? 'Ritual' : 'Hard Rule'}
                            </span>
                            <div className="w-1 h-1 rounded-full bg-slate-600" />
                            <span className="text-[8px] font-black uppercase tracking-widest text-slate-500">Unbreakable</span>
                          </div>
                        </div>
                      </div>
                      <button onClick={() => setItemToDelete({ id: rule.id, type: 'rule' })} className="absolute top-4 right-4 p-2 text-slate-600 hover:text-rose-500 opacity-0 group-hover:opacity-100 transition-all"><Trash2 size={14} /></button>
                    </div>
                  ))}
                </div>
                <div className="flex flex-col sm:flex-row gap-3 p-2 rounded-[28px] bg-blue-500/5 border border-blue-500/10">
                  <InputField value={newRuleLabel} onChange={(e: any) => setNewRuleLabel(e.target.value)} onKeyDown={(e: any) => e.key === 'Enter' && addIronRule()} placeholder="Nadefinuj nové pravidlo..." isDark={isDark} />
                  <select value={newRuleType} onChange={e => setNewRuleType(e.target.value as any)} className={`px-4 py-3 rounded-2xl text-[10px] font-black uppercase tracking-widest outline-none border transition-all ${isDark ? 'bg-white/5 border-white/10 text-white' : 'bg-white border-slate-200 text-slate-900'}`}>
                    <option value="ritual">Rituál</option>
                    <option value="trading">Pravidlo</option>
                  </select>
                  <button onClick={addIronRule} className="px-8 py-3 bg-blue-600 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest shadow-xl shadow-blue-600/40 hover:bg-blue-500 transition-all">Přidat Pravidlo</button>
                </div>
              </Card>

              <Card isDark={isDark}>
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
                  <SectionHeader icon={Target} title="Weekly Focus" subtitle="Tvůj hlavní směr pro tento týden" color="bg-emerald-600" isDark={isDark} />
                  <div className={`flex items-center gap-2 p-1.5 rounded-[22px] border ${isDark ? 'bg-black/30 border-white/10' : 'bg-slate-50 border-slate-200 shadow-inner'}`}>
                    <button onClick={() => handleWeekChange(-1)} className="p-2 rounded-xl hover:bg-white/5 transition-all text-slate-400"><ChevronLeft size={18} /></button>
                    <div className="px-4 text-center">
                      <p className={`text-[10px] font-black uppercase tracking-widest whitespace-nowrap ${isDark ? 'text-emerald-500' : 'text-emerald-600'}`}>{selectedWeek}</p>
                      <p className="text-[7px] font-black text-slate-500 leading-none">{getWeekRange(selectedWeek)}</p>
                    </div>
                    <button onClick={() => handleWeekChange(1)} className="p-2 rounded-xl hover:bg-white/5 transition-all text-slate-400"><ChevronRight size={18} /></button>
                  </div>
                </div>

                <div className="space-y-3 mb-8 min-h-[100px] flex flex-col items-center justify-center">
                  <AnimatePresence mode="popLayout">
                    {currentWeeklyFocus.goals.length === 0 ? (
                      <motion.div key={`empty-${selectedWeek}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="py-12 flex flex-col items-center text-slate-500 gap-2">
                        <Sparkles size={24} className="opacity-20" />
                        <p className="text-[9px] font-black uppercase tracking-[0.2em]">Žádné cíle pro tento týden</p>
                      </motion.div>
                    ) : (
                      currentWeeklyFocus.goals.map((goal, idx) => (
                        <motion.div
                          key={`${selectedWeek}-${goal.id}`}
                          layout
                          initial={{ opacity: 0, scale: 0.95 }}
                          animate={{ opacity: 1, scale: 1 }}
                          exit={{ opacity: 0, scale: 0.95 }}
                          className={`w-full flex items-center gap-4 p-4 rounded-2xl border transition-all ${isDark ? 'bg-white/5 border-white/5' : 'bg-slate-50 border-slate-100'}`}
                        >
                          <button
                            onClick={() => setEmojiPickerTarget({ goalIdx: idx })}
                            className="w-10 h-10 rounded-xl bg-emerald-500/10 text-xl flex items-center justify-center hover:scale-105 active:scale-95 transition-all text-center"
                          >
                            {goal.emoji || '🎯'}
                          </button>
                          <input
                            value={goal.text}
                            onChange={(e) => {
                              const newList = [...weeklyFocusList];
                              const exIdx = newList.findIndex(wf => wf.weekISO === selectedWeek);
                              const val = e.target.value;

                              if (exIdx !== -1) {
                                const newGoals = [...newList[exIdx].goals];
                                newGoals[idx] = { ...newGoals[idx], text: val };
                                newList[exIdx] = { ...newList[exIdx], goals: newGoals };
                                setWeeklyFocusList(newList);
                              }
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && currentWeeklyFocus.goals.length < 5) {
                                const nl = [...weeklyFocusList];
                                const i = nl.findIndex(wf => wf.weekISO === selectedWeek);
                                const newGoal = { id: crypto.randomUUID(), text: '', emoji: '🎯' };
                                if (i !== -1) nl[i] = { ...nl[i], goals: [...nl[i].goals, newGoal] };
                                else nl.push({ id: crypto.randomUUID(), weekISO: selectedWeek, goals: [newGoal] });
                                setWeeklyFocusList(nl);
                                showToast('Cíl přidán');
                              }
                            }}
                            className="flex-1 bg-transparent border-0 outline-none text-xs font-bold"
                            placeholder="Zadej týdenní focus..."
                          />
                          <button onClick={() => {
                            const nl = [...weeklyFocusList];
                            const i = nl.findIndex(wf => wf.weekISO === selectedWeek);
                            if (i !== -1) {
                              nl[i] = { ...nl[i], goals: nl[i].goals.filter((_, gx) => gx !== idx) };
                              setWeeklyFocusList(nl);
                              showToast('Odstraněno');
                            }
                          }} className="p-2 text-slate-600 hover:text-rose-500 transition-colors"><Trash2 size={14} /></button>
                        </motion.div>
                      ))
                    )}
                  </AnimatePresence>

                  {currentWeeklyFocus.goals.length < 5 && (
                    <button onClick={() => {
                      const nl = [...weeklyFocusList];
                      const i = nl.findIndex(wf => wf.weekISO === selectedWeek);
                      const newGoal = { id: crypto.randomUUID(), text: '', emoji: '🎯' };
                      if (i !== -1) nl[i] = { ...nl[i], goals: [...nl[i].goals, newGoal] };
                      else nl.push({ id: crypto.randomUUID(), weekISO: selectedWeek, goals: [newGoal] });
                      setWeeklyFocusList(nl);
                      showToast('Cíl přidán');
                    }} className={`w-full py-5 mt-4 rounded-[22px] border border-dashed text-[10px] font-black uppercase tracking-[0.2em] transition-all ${isDark ? 'border-white/10 text-slate-500 hover:border-emerald-500/50 hover:text-emerald-500 hover:bg-emerald-500/5' : 'border-slate-300 text-slate-400 hover:border-emerald-500/50 hover:bg-emerald-50 hover:text-emerald-600'}`}>
                      + Další Týdenní Cíl
                    </button>
                  )}
                </div>
              </Card>

              <Card isDark={isDark}>
                <SectionHeader icon={Target} title="Výchozí Cíle Dne" subtitle="Automaticky předvyplněno v deníku" color="bg-orange-600" isDark={isDark} />
                <div className="flex flex-wrap gap-2 mb-6 pr-2 max-h-[140px] overflow-y-auto custom-scrollbar">
                  {standardGoals.map(goal => (
                    <span key={goal} className={`flex items-center gap-2 px-4 py-1.5 rounded-xl border text-[9px] font-black uppercase ${isDark ? 'bg-white/5 border-white/10 text-orange-400 group hover:border-orange-500/50' : 'bg-orange-50 border-orange-100 text-orange-600'}`}>
                      {goal}
                      <button onClick={() => { setStandardGoals(standardGoals.filter(x => x !== goal)); showToast('Odstraněno'); }} className="text-rose-500/50 hover:text-rose-500"><X size={12} /></button>
                    </span>
                  ))}
                </div>
                <div className="flex gap-2">
                  <InputField value={newStandardGoal} onChange={(e: any) => setNewStandardGoal(e.target.value)} onKeyDown={(e: any) => e.key === 'Enter' && addStandardGoal()} placeholder="Nový výchozí cíl..." isDark={isDark} />
                  <button onClick={addStandardGoal} className="px-6 rounded-xl bg-orange-600 text-white text-[10px] font-black uppercase tracking-widest hover:bg-orange-500 shadow-lg active:scale-95 transition-all">Přidat</button>
                </div>
              </Card>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <Card isDark={isDark}>
                  <SectionHeader icon={Activity} title="HTF Confluence" subtitle="Vyšší časové rámce" color="bg-emerald-600" isDark={isDark} />
                  <div className="flex flex-wrap gap-2 mb-6 pr-2 max-h-[140px] overflow-y-auto custom-scrollbar">
                    {htfOptions.map(opt => (
                      <span key={opt} className={`flex items-center gap-2 px-4 py-1.5 rounded-xl border text-[9px] font-black uppercase ${isDark ? 'bg-white/5 border-white/10 text-emerald-400 group hover:border-emerald-500/50' : 'bg-emerald-50 border-emerald-100 text-emerald-600'}`}>
                        {opt}
                        <button onClick={() => { setHtfOptions(prev => prev.filter(x => x !== opt)); showToast('Odstraněno'); }} className="text-rose-500/50 hover:text-rose-500"><X size={12} /></button>
                      </span>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <InputField value={newHtf} onChange={(e: any) => setNewHtf(e.target.value)} onKeyDown={(e: any) => e.key === 'Enter' && addHtf()} placeholder="Nová HTF..." isDark={isDark} />
                    <button onClick={addHtf} className="w-12 h-12 rounded-xl bg-emerald-600 text-white flex items-center justify-center hover:bg-emerald-500 shadow-lg active:scale-95 transition-all"><Plus size={24} /></button>
                  </div>
                </Card>
                <Card isDark={isDark}>
                  <SectionHeader icon={Monitor} title="LTF Confluence" subtitle="Potvrzení vstupu" color="bg-blue-600" isDark={isDark} />
                  <div className="flex flex-wrap gap-2 mb-6 pr-2 max-h-[140px] overflow-y-auto custom-scrollbar">
                    {ltfOptions.map(opt => (
                      <span key={opt} className={`flex items-center gap-2 px-4 py-1.5 rounded-xl border text-[9px] font-black uppercase ${isDark ? 'bg-white/5 border-white/10 text-blue-400 hover:border-blue-500/50' : 'bg-blue-50 border-blue-100 text-blue-600'}`}>
                        {opt}
                        <button onClick={() => { setLtfOptions(prev => prev.filter(x => x !== opt)); showToast('Odstraněno'); }} className="text-rose-500/50 hover:text-rose-500"><X size={12} /></button>
                      </span>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <InputField value={newLtf} onChange={(e: any) => setNewLtf(e.target.value)} onKeyDown={(e: any) => e.key === 'Enter' && addLtf()} placeholder="Nová LTF..." isDark={isDark} />
                    <button onClick={addLtf} className="w-12 h-12 rounded-xl bg-blue-600 text-white flex items-center justify-center hover:bg-blue-500 shadow-lg active:scale-95 transition-all"><Plus size={24} /></button>
                  </div>
                </Card>
              </div>
            </div>
          )}

          {activeTab === 'market' && (
            <div className="space-y-6">
              <Card isDark={isDark}>
                <div className="flex items-center justify-between mb-8">
                  <SectionHeader icon={Globe} title="Obchodní Seance" subtitle="Harmonogram tvého dne" color="bg-indigo-600" isDark={isDark} />
                  <button onClick={addSession} className="px-6 py-3 bg-indigo-600 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest shadow-xl shadow-indigo-600/30 hover:bg-indigo-500 active:scale-95 transition-all flex items-center gap-2"><Plus size={16} /> Přidat seanci</button>
                </div>

                <div className={`mb-10 p-8 rounded-[40px] border ${isDark ? 'bg-black/30 border-white/5' : 'bg-slate-50 border-slate-100'} overflow-hidden relative group`}>
                  <div className="flex justify-between text-[8px] font-black text-slate-500 uppercase mb-5 px-3">
                    {[0, 3, 6, 9, 12, 15, 18, 21].map(h => <span key={h}>{h}h</span>)}
                    <span>24h</span>
                  </div>
                  <div className="h-4 w-full bg-slate-900 rounded-full relative shadow-inner flex items-center">
                    <div className="absolute inset-x-0 h-[1px] bg-white/5 top-1/2" />
                    {sessions.map(s => {
                      const [sh, sm] = (s.startTime || '09:00').split(':').map(Number);
                      const [eh, em] = (s.endTime || '17:00').split(':').map(Number);
                      const start = ((sh * 60 + sm) / 1440) * 100;
                      const end = ((eh * 60 + em) / 1440) * 100;
                      const width = end >= start ? end - start : (100 - start) + end;
                      return (
                        <div key={s.id} className="absolute h-full opacity-80 rounded-full transition-all duration-500 hover:opacity-100 group-hover:h-[120%]" style={{ left: `${start}%`, width: `${width}%`, backgroundColor: s.color || '#3b82f6', boxShadow: `0 0 15px ${s.color}40` }} />
                      );
                    })}
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
                  {sessions.map(s => (
                    <div key={s.id} className={`p-6 rounded-[32px] border relative transition-all duration-300 hover:scale-[1.02] ${isDark ? 'bg-white/5 border-white/5 hover:border-indigo-500/40' : 'bg-white border-slate-100 hover:shadow-xl'}`}>
                      <div className="space-y-5">
                        <div className="flex items-center gap-3">
                          <div className="relative group shrink-0">
                            <input type="color" value={s.color || '#3b82f6'} onChange={e => updateSession(s.id, { color: e.target.value })} className="absolute inset-0 opacity-0 cursor-pointer w-full h-full" />
                            <div className="w-8 h-8 rounded-xl border-2 border-white/10 shadow-lg" style={{ backgroundColor: s.color || '#3b82f6' }} />
                          </div>
                          <input value={s.name} onChange={e => updateSession(s.id, { name: e.target.value })} className={`flex-1 bg-transparent text-sm font-black uppercase tracking-tighter outline-none border-b border-transparent focus:border-indigo-500 py-1 transition-all ${isDark ? 'text-white' : 'text-slate-900'}`} />
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                          <div className="space-y-1.5">
                            <label className="text-[8px] font-black uppercase text-slate-500 tracking-widest">Start Time</label>
                            <input type="time" value={s.startTime} onChange={e => updateSession(s.id, { startTime: e.target.value })} className={`w-full px-3 py-2 rounded-xl text-xs font-bold ${isDark ? 'bg-white/5 border-white/5' : 'bg-slate-50 border-slate-200'}`} />
                          </div>
                          <div className="space-y-1.5">
                            <label className="text-[8px] font-black uppercase text-slate-500 tracking-widest">End Time</label>
                            <input type="time" value={s.endTime} onChange={e => updateSession(s.id, { endTime: e.target.value })} className={`w-full px-3 py-2 rounded-xl text-xs font-bold ${isDark ? 'bg-white/5 border-white/5' : 'bg-slate-50 border-slate-200'}`} />
                          </div>
                        </div>
                      </div>
                      <button onClick={() => { setSessions(prev => prev.filter(x => x.id !== s.id)); showToast('Odstraněno'); }} className="absolute -top-2 -right-2 w-8 h-8 rounded-full bg-rose-600 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all shadow-lg active:scale-90"><Trash2 size={14} /></button>
                    </div>
                  ))}
                </div>
              </Card>
            </div>
          )}

          {activeTab === 'system' && (
            <div className="space-y-6">
              {/* Accent Color Picker */}
              <Card isDark={isDark}>
                <SectionHeader icon={Sliders} title="Accent Color" subtitle="Personalizuj barvu rozhraní" color="bg-gradient-to-br from-purple-600 to-pink-600" isDark={isDark} />
                <p className={`text-xs mb-6 ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                  Vyber akcentovou barvu, která se objeví na buttonech, aktivních prvcích a zvýrazněních v celé aplikaci.
                </p>
                <div className="grid grid-cols-4 sm:grid-cols-7 gap-3">
                  {[
                    { id: 'blue', color: '#3b82f6', label: 'Modrá' },
                    { id: 'purple', color: '#a855f7', label: 'Fialová' },
                    { id: 'pink', color: '#ec4899', label: 'Růžová' },
                    { id: 'green', color: '#10b981', label: 'Zelená' },
                    { id: 'orange', color: '#f97316', label: 'Oranžová' },
                    { id: 'red', color: '#ef4444', label: 'Červená' },
                    { id: 'cyan', color: '#06b6d4', label: 'Cyan' },
                  ].map(ac => (
                    <button
                      key={ac.id}
                      onClick={() => {
                        if (onAccentColorChange) {
                          onAccentColorChange(ac.id);
                          showToast(`${ac.label} aktivována`);
                        }
                      }}
                      className={`group relative flex flex-col items-center gap-2 p-4 rounded-2xl border-2 transition-all duration-300 ${accentColor === ac.id
                        ? 'border-white/40 scale-105'
                        : isDark
                          ? 'border-white/5 hover:border-white/20'
                          : 'border-slate-200 hover:border-slate-300'
                        }`}
                      style={{
                        backgroundColor: accentColor === ac.id ? `${ac.color}20` : 'transparent'
                      }}
                    >
                      <div
                        className="w-12 h-12 rounded-xl shadow-lg transition-all duration-300 group-hover:scale-110"
                        style={{
                          backgroundColor: ac.color,
                          boxShadow: accentColor === ac.id ? `0 0 20px ${ac.color}80` : `0 4px 12px ${ac.color}40`
                        }}
                      />
                      <span className={`text-[9px] font-black uppercase tracking-widest transition-all ${accentColor === ac.id
                        ? isDark ? 'text-white' : 'text-slate-900'
                        : 'text-slate-500'
                        }`}>
                        {ac.label}
                      </span>
                      {accentColor === ac.id && (
                        <motion.div
                          layoutId="accent-indicator"
                          className="absolute -top-1 -right-1 w-6 h-6 rounded-full bg-white shadow-lg flex items-center justify-center"
                        >
                          <Check size={14} style={{ color: ac.color }} strokeWidth={3} />
                        </motion.div>
                      )}
                    </button>
                  ))}
                </div>
              </Card>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Seance & Alerty */}
                <Card isDark={isDark}>
                  <SectionHeader icon={Bell} title="Seance & Alerty" subtitle="Push notifikace do telefonu" color="bg-blue-600" isDark={isDark} />
                  <div className="space-y-2">
                    <Toggle
                      active={systemSettings.sessionAlertsEnabled}
                      onClick={() => updateSystem('sessionAlertsEnabled', !systemSettings.sessionAlertsEnabled)}
                      label="Aktivovat Notifikace Seancí"
                      desc="Ponechte vypnuté, pokud nechcete být rušeni."
                      isDark={isDark}
                    />
                    <AnimatePresence>
                      {systemSettings.sessionAlertsEnabled && (
                        <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="space-y-2 pl-4 border-l border-blue-500/20 ml-2 py-2">
                          <Toggle active={systemSettings.sessionStartAlert15m} onClick={() => updateSystem('sessionStartAlert15m', !systemSettings.sessionStartAlert15m)} label="15 minut před startem" isDark={isDark} />
                          <Toggle active={systemSettings.sessionStartAlertExact} onClick={() => updateSystem('sessionStartAlertExact', !systemSettings.sessionStartAlertExact)} label="Při startu seance" isDark={isDark} />
                          <Toggle active={systemSettings.sessionEndAlertExact} onClick={() => updateSystem('sessionEndAlertExact', !systemSettings.sessionEndAlertExact)} label="Při konci seance" isDark={isDark} />
                          <Toggle active={systemSettings.sessionEndAlert10m} onClick={() => updateSystem('sessionEndAlert10m', !systemSettings.sessionEndAlert10m)} label="10 minut po (čas na audit)" isDark={isDark} />
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </Card>

                {/* Alpha Guardian */}
                <Card isDark={isDark}>
                  <SectionHeader icon={Shield} title="Alpha Guardian" subtitle="Hlídač disciplíny a procesu" color="bg-emerald-600" isDark={isDark} />
                  <div className="space-y-2">
                    <Toggle
                      active={systemSettings.guardianEnabled}
                      onClick={() => updateSystem('guardianEnabled', !systemSettings.guardianEnabled)}
                      label="Aktivovat Alpha Guardian"
                      desc="Integrovaný risk manager a mentor."
                      isDark={isDark}
                    />
                    <AnimatePresence>
                      {systemSettings.guardianEnabled && (
                        <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="space-y-2 pl-4 border-l border-emerald-500/20 ml-2 py-2">
                          <p className="text-[8px] font-black uppercase text-[var(--text-muted)] tracking-widest mb-2 px-4">Upozornění na přípravu</p>
                          <Toggle active={systemSettings.morningPrepAlert60m} onClick={() => updateSystem('morningPrepAlert60m', !systemSettings.morningPrepAlert60m)} label="60 minut před startem" desc="Informační připomínka" isDark={isDark} />
                          <Toggle active={systemSettings.morningPrepAlert15m} onClick={() => updateSystem('morningPrepAlert15m', !systemSettings.morningPrepAlert15m)} label="15 minut před startem" desc="Důrazná připomínka" isDark={isDark} />
                          <Toggle active={systemSettings.morningPrepAlertCritical} onClick={() => updateSystem('morningPrepAlertCritical', !systemSettings.morningPrepAlertCritical)} label="Start seance (Kritické)" desc="Pruhy na dashboardu" isDark={isDark} />

                          <div className={`h-px my-4 ${isDark ? 'bg-white/5' : 'bg-[var(--border-subtle)]'}`} />
                          <Toggle active={systemSettings.strictModeEnabled} onClick={() => updateSystem('strictModeEnabled', !systemSettings.strictModeEnabled)} label="Strict Enforcement" desc="Blokovat zápis obchodu bez přípravy" isDark={isDark} />
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </Card>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <Card isDark={isDark}>
                  <SectionHeader icon={Check} title="Večerní Audit" subtitle="Uzavření obchodního dne" color="bg-indigo-600" isDark={isDark} />
                  <div className="space-y-4">
                    <Toggle
                      active={systemSettings.eveningAuditAlertEnabled}
                      onClick={() => updateSystem('eveningAuditAlertEnabled', !systemSettings.eveningAuditAlertEnabled)}
                      label="Připomínka Auditu"
                      desc="Kdy chcete uzavřít deník?"
                      isDark={isDark}
                    />
                    {systemSettings.eveningAuditAlertEnabled && (
                      <div className="px-4">
                        <label className="text-[8px] font-black uppercase text-[var(--text-muted)] tracking-widest mb-1.5 block">Čas notifikace</label>
                        <input
                          type="time"
                          value={systemSettings.eveningAuditAlertTime}
                          onChange={(e) => updateSystem('eveningAuditAlertTime', e.target.value)}
                          className={`w-full max-w-[120px] px-4 py-2.5 rounded-2xl text-xs font-bold outline-none border transition-all ${isDark ? 'bg-white/5 border-white/10 text-white' : 'bg-[var(--bg-input)] border-[var(--border-subtle)] text-[var(--text-primary)]'
                            }`}
                        />
                      </div>
                    )}
                  </div>
                </Card>

                {/* Resty z minulosti */}
                <Card isDark={isDark}>
                  <SectionHeader icon={AlertCircle} title="Backlog Guardian" subtitle="Vymahač dluhů z minulosti" color="bg-rose-600" isDark={isDark} />
                  <div className="space-y-2">
                    <Toggle
                      active={systemSettings.morningWakeUpDebtAlert}
                      onClick={() => updateSystem('morningWakeUpDebtAlert', !systemSettings.morningWakeUpDebtAlert)}
                      label="Morning Debt Collector"
                      desc="Ranní upozornění na neuzavřený audit z včerejška."
                      isDark={isDark}
                    />
                  </div>
                </Card>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Debug / Test Mode */}
                <Card isDark={isDark}>
                  <SectionHeader icon={Zap} title="Debug Režim" subtitle="Testování notifikací a Guardiana" color="bg-zinc-600" isDark={isDark} />
                  <div className="space-y-4">
                    <Toggle
                      active={systemSettings.testModeEnabled}
                      onClick={() => updateSystem('testModeEnabled', !systemSettings.testModeEnabled)}
                      label="Testovací Režim"
                      desc="Zapne simulaci kritického stavu a pošle notifikaci každou minutu."
                      isDark={isDark}
                    />
                  </div>
                </Card>
              </div>

              {/* iOS Notification Helper */}
              <div className={`p-8 rounded-[40px] border ${isDark ? 'bg-blue-600/5 border-blue-500/20' : 'bg-[var(--bg-card)] border-[var(--border-subtle)]'} flex flex-col items-center text-center gap-4`}>
                <div className="p-4 bg-[var(--text-secondary)] rounded-3xl text-white shadow-2xl"><Bell size={32} /></div>
                <div className="max-w-xl">
                  <h3 className="text-xl font-black italic tracking-tighter mb-2 text-[var(--text-primary)]">AKTIVUJTE PUSH NOTIFIKACE</h3>
                  <p className={`text-xs font-bold leading-relaxed mb-6 ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                    Pro doručování zpráv do iPhonu/Androidu musíte mít aplikaci přidanou na ploše.<br />
                    Klepněte na <span className="p-1 px-2 bg-blue-600/20 text-blue-500 rounded-lg mx-1 inline-flex items-center gap-1"><Plus size={10} /> Přidat na plochu</span> v prohlížeči Safari.
                  </p>
                  <button
                    onClick={onEnableNotifications || (() => {
                      if ('Notification' in window) {
                        Notification.requestPermission().then(res => {
                          alert(res === 'granted' ? 'Notifikace povoleny!' : 'Notifikace byly zamítnuty v prohlížeči.');
                        });
                      }
                    })}
                    className="px-8 py-4 bg-blue-600 text-white rounded-2xl font-black uppercase text-[10px] tracking-widest shadow-xl shadow-blue-600/40 hover:bg-blue-500 active:scale-95 transition-all"
                  >
                    Povolit notifikace na tomto zařízení
                  </button>
                </div>
              </div>

              {/* Diagnostic / Support */}
              <div className={`mt-12 p-8 rounded-[40px] border ${isDark ? 'bg-zinc-900/50 border-white/5' : 'bg-slate-50 border-slate-200'} flex flex-col gap-6`}>
                <div className="flex flex-col md:flex-row justify-between items-center gap-4">
                  <div>
                    <h4 className={`text-sm font-bold ${isDark ? 'text-white' : 'text-slate-900'}`}>Systémová diagnostika</h4>
                    <p className="text-[10px] text-zinc-500 font-medium whitespace-nowrap overflow-hidden text-ellipsis">Verze: {appVersion || 'Unknown'}</p>
                  </div>
                  {onHardRefresh && (
                    <button
                      onClick={onHardRefresh}
                      className="px-6 py-3 bg-zinc-800 hover:bg-rose-900/20 hover:text-rose-500 text-zinc-400 rounded-2xl text-[10px] font-bold uppercase tracking-widest transition-all border border-white/5"
                    >
                      Hard Refresh
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </main>

      <ConfirmationModal
        isOpen={!!itemToDelete}
        onClose={() => setItemToDelete(null)}
        onConfirm={() => {
          if (!itemToDelete) return;
          if (itemToDelete.type === 'metric') setPsychoMetrics(prev => prev.filter(x => x.id !== itemToDelete.id));
          if (itemToDelete.type === 'rule') setIronRules(prev => prev.filter(x => x.id !== itemToDelete.id));
          if (itemToDelete.type === 'emotion') setUserEmotions(prev => prev.filter(x => x.id !== itemToDelete.id));
          if (itemToDelete.type === 'mistake') setUserMistakes(prev => prev.filter(x => x !== itemToDelete.id));
          if (itemToDelete.type === 'session') setSessions(prev => prev.filter(x => x.id !== itemToDelete.id));
          if (itemToDelete.type === 'goal') setStandardGoals(standardGoals.filter(x => x !== itemToDelete.id));
          showToast('Odstraněno');
        }}
        title={
          itemToDelete?.type === 'metric' ? 'Smazat metriku' :
            itemToDelete?.type === 'rule' ? 'Smazat pravidlo' :
              itemToDelete?.type === 'emotion' ? 'Smazat emoci' :
                itemToDelete?.type === 'session' ? 'Smazat seanci' : 'Smazat položku'
        }
        message="Opravdu chcete tuto položku trvale odstranit? Tato akce je nevratná."
        theme={theme}
      />

      {/* Emoji Picker Modal */}
      {emojiPickerTarget && (
        <EmojiPicker
          isDark={isDark}
          onClose={() => setEmojiPickerTarget(null)}
          onSelect={(emoji) => {
            const newList = [...weeklyFocusList];
            const exIdx = newList.findIndex(wf => wf.weekISO === selectedWeek);
            if (exIdx !== -1) {
              const newGoals = [...newList[exIdx].goals];
              newGoals[emojiPickerTarget.goalIdx] = { ...newGoals[emojiPickerTarget.goalIdx], emoji };
              newList[exIdx] = { ...newList[exIdx], goals: newGoals };
              setWeeklyFocusList(newList);
            }
          }}
        />
      )}

      {/* Persistence Notification Toast */}
      <AnimatePresence>
        {toast && (
          <motion.div
            key={toast.id}
            initial={{ opacity: 0, y: 50, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9, y: 20 }}
            className="fixed bottom-12 left-1/2 -translate-x-1/2 z-[300] pointer-events-none"
          >
            <div className={`px-6 py-3 rounded-2xl border shadow-2xl flex items-center gap-3 backdrop-blur-xl ${isDark ? 'bg-emerald-500/20 border-emerald-500/30 text-emerald-400' : 'bg-emerald-600 border-emerald-500 text-white'}`}>
              <Check size={16} strokeWidth={3} className={isDark ? 'text-emerald-400' : 'text-white'} />
              <span className="text-[10px] font-black uppercase tracking-[0.2em]">{toast.message}</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default Settings;
