
import React, { useState } from 'react';
import { Save, Shield, Trash2, Database, Key, Plus, Brain, Tag, X, Target, ListChecks, Monitor, Zap, Globe, Clock, AlertOctagon, ShieldCheck, ShieldAlert, DollarSign, Activity } from 'lucide-react';
import { CustomEmotion, SessionConfig, IronRule, PsychoMetricConfig } from '../types';

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
  instrumentFees: Record<string, number>;
  setInstrumentFees: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  psychoMetrics: PsychoMetricConfig[];
  setPsychoMetrics: React.Dispatch<React.SetStateAction<PsychoMetricConfig[]>>;
}

const INSTRUMENT_LIST = ['MNQ', 'NQ', 'MES', 'ES', 'CL', 'GC', 'CUSTOM'];

const Settings: React.FC<SettingsProps> = ({
  theme, userEmotions, setUserEmotions,
  userMistakes, setUserMistakes,
  htfOptions, setHtfOptions, ltfOptions, setLtfOptions,
  sessions, setSessions,
  ironRules, setIronRules,
  instrumentFees, setInstrumentFees,
  psychoMetrics, setPsychoMetrics
}) => {
  const [activeTab, setActiveTab] = useState<'psychology' | 'strategy' | 'market' | 'financials'>('psychology');

  const [newHtf, setNewHtf] = useState('');
  const [newLtf, setNewLtf] = useState('');
  const [newMistake, setNewMistake] = useState('');
  const [newEmoLabel, setNewEmoLabel] = useState('');
  const [newRuleLabel, setNewRuleLabel] = useState('');
  const [newRuleType, setNewRuleType] = useState<'ritual' | 'trading'>('ritual');

  const [selectedFeeInst, setSelectedFeeInst] = useState('MNQ');
  const [newFeeVal, setNewFeeVal] = useState('');

  const [newMetricLabel, setNewMetricLabel] = useState('');
  const [newMetricColor, setNewMetricColor] = useState('#6366f1');

  const addHtf = () => { if (newHtf && !htfOptions.includes(newHtf)) { setHtfOptions([...htfOptions, newHtf]); setNewHtf(''); } };
  const addLtf = () => { if (newLtf && !ltfOptions.includes(newLtf)) { setLtfOptions([...ltfOptions, newLtf]); setNewLtf(''); } };
  const addMistake = () => { if (newMistake && !userMistakes.includes(newMistake)) { setUserMistakes([...userMistakes, newMistake]); setNewMistake(''); } };
  const addEmo = () => { if (newEmoLabel) { setUserEmotions([...userEmotions, { id: Date.now().toString(), label: newEmoLabel, icon: '' }]); setNewEmoLabel(''); } };
  const addIronRule = () => { if (newRuleLabel) { setIronRules([...ironRules, { id: `rule_${Date.now()}`, label: newRuleLabel, type: newRuleType }]); setNewRuleLabel(''); } };
  const addMetric = () => {
    if (newMetricLabel.trim()) {
      setPsychoMetrics([...psychoMetrics, { id: `metric_${Date.now()}`, label: newMetricLabel, color: newMetricColor }]);
      setNewMetricLabel('');
    }
  };
  const saveFee = () => { if (newFeeVal !== '') { setInstrumentFees({ ...instrumentFees, [selectedFeeInst]: parseFloat(newFeeVal) }); setNewFeeVal(''); } };

  const removeFee = (inst: string) => {
    const newFees = { ...instrumentFees };
    delete newFees[inst];
    setInstrumentFees(newFees);
  };

  const removeHtf = (opt: string) => setHtfOptions(htfOptions.filter(o => o !== opt));
  const removeLtf = (opt: string) => setLtfOptions(ltfOptions.filter(o => o !== opt));
  const removeMistake = (opt: string) => setUserMistakes(userMistakes.filter(o => o !== opt));
  const removeEmo = (id: string) => setUserEmotions(userEmotions.filter(e => e.id !== id));
  const removeRule = (id: string) => setIronRules(ironRules.filter(r => r.id !== id));
  const updateSession = (id: string, updates: Partial<SessionConfig>) => setSessions(sessions.map(s => s.id === id ? { ...s, ...updates } : s));
  const addSession = () => {
    const newSession: SessionConfig = { id: `session_${Date.now()}`, name: 'Nová Seance', startTime: '09:00', endTime: '17:00', color: '#6366f1' };
    setSessions([...sessions, newSession]);
  };
  const removeSession = (id: string) => { if (sessions.length > 1) setSessions(sessions.filter(s => s.id !== id)); };

  const isDark = theme !== 'light';
  const inputClass = `px-4 py-3 rounded-xl border focus:ring-2 focus:ring-blue-500/40 outline-none transition-all ${isDark ? 'bg-[var(--bg-input)] border-[var(--border-subtle)] text-white placeholder-slate-700' : 'bg-slate-50 border-slate-200 text-slate-900 placeholder-slate-400'
    }`;

  const tabs = [
    { id: 'psychology', label: 'Psychologie', icon: Brain, description: 'Emoce a katalog chyb' },
    { id: 'strategy', label: 'Strategie', icon: Target, description: 'Pravidla a konfluence' },
    { id: 'market', label: 'Trh', icon: Clock, description: 'Seance a časový plán' },
    { id: 'financials', label: 'Finance', icon: DollarSign, description: 'Poplatky a kalkulace' },
  ] as const;

  return (
    <div className={`p-0.5 gap-0.5 flex flex-col lg:flex-row animate-in fade-in slide-in-from-bottom-4 duration-700 pb-16 max-w-7xl mx-auto rounded-[32px] border overflow-hidden ${isDark ? 'bg-[var(--bg-card)] border-[var(--border-subtle)] backdrop-blur-3xl' : 'bg-white border-slate-200 shadow-2xl'}`}>
      {/* Integrated Sidebar Navigation */}
      <aside className={`w-full lg:w-64 shrink-0 p-4 lg:p-6 flex flex-col border-b lg:border-b-0 lg:border-r ${isDark ? 'border-[var(--border-subtle)] bg-[var(--bg-page)]/20' : 'border-slate-100 bg-slate-50/50'}`}>
        <div className="mb-6 px-2 lg:px-4">
          <h2 className={`text-xl font-black italic tracking-tighter mb-0.5 ${isDark ? 'text-white' : 'text-slate-900'}`}>SETTINGS</h2>
          <p className="text-[9px] font-black uppercase tracking-widest text-slate-500">System Configuration Hub</p>
        </div>
        <div className="space-y-1.5">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`w-full flex items-center gap-3.5 px-5 py-3.5 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all relative group
                  ${isActive
                    ? (isDark ? 'bg-blue-600 text-white shadow-xl shadow-blue-600/20 ring-1 ring-blue-500' : 'bg-blue-600 text-white shadow-lg shadow-blue-600/10')
                    : (isDark ? 'text-slate-500 hover:text-slate-300 hover:bg-[var(--text-primary)]/5' : 'text-slate-400 hover:text-slate-900 hover:bg-white')
                  }
                `}
              >
                <Icon size={16} className={isActive ? 'text-white' : ''} />
                <div className="text-left">
                  <span className="block">{tab.label}</span>
                  <span className={`text-[7px] opacity-60 font-bold normal-case tracking-tight block ${isActive ? 'text-white/80' : ''}`}>{tab.description}</span>
                </div>
              </button>
            );
          })}
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 min-w-0 p-5 lg:p-8">
        <div className="space-y-8">
          {activeTab === 'psychology' && (
            <div className="space-y-6 animate-in fade-in slide-in-from-right-8 duration-500">
              {/* Errors Section */}
              <section className={`p-6 rounded-[32px] border relative overflow-hidden ${isDark ? 'bg-[var(--bg-card)]/80 border-[var(--border-subtle)]' : 'bg-white border-slate-200 shadow-sm'}`}>
                <div className="flex items-center gap-3 mb-6">
                  <div className="p-3 rounded-xl bg-rose-500 text-white shadow-lg shadow-rose-500/10"><AlertOctagon size={20} /></div>
                  <div>
                    <h3 className={`text-xl font-black italic tracking-tighter ${isDark ? 'text-white' : 'text-slate-900'}`}>KATALOG CHYB</h3>
                    <p className="text-[9px] font-black uppercase tracking-widest text-slate-500">Identifikace a eliminace špatných návyků</p>
                  </div>
                </div>

                <div className={`mb-8 p-6 rounded-[24px] border border-dashed ${isDark ? 'border-[var(--border-subtle)] bg-[var(--bg-page)]/20' : 'border-slate-200 bg-slate-50'}`}>
                  <h4 className={`text-sm font-bold uppercase tracking-widest mb-4 flex items-center gap-2 ${isDark ? 'text-indigo-400' : 'text-indigo-600'}`}><Activity size={16} /> Metriky Psychiky (Posuvníky)</h4>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="space-y-3">
                      {psychoMetrics.map(metric => (
                        <div key={metric.id} className={`p-3 rounded-xl border flex items-center justify-between group ${isDark ? 'bg-[var(--bg-input)] border-[var(--border-subtle)]' : 'bg-slate-50 border-slate-200'}`}>
                          <div className="flex items-center gap-3">
                            <div className="w-3 h-3 rounded-full shadow-[0_0_10px_currentColor]" style={{ backgroundColor: metric.color, color: metric.color }} />
                            <span className="font-bold text-xs uppercase tracking-wider">{metric.label}</span>
                          </div>
                          <button onClick={() => setPsychoMetrics(psychoMetrics.filter(m => m.id !== metric.id))} className="text-slate-500 hover:text-rose-500 transition-colors p-2 hover:bg-rose-500/10 rounded-lg"><Trash2 size={14} /></button>
                        </div>
                      ))}
                    </div>
                    <div className={`space-y-3 p-4 rounded-2xl border ${isDark ? 'bg-[var(--bg-page)]/30 border-[var(--border-subtle)]' : 'bg-slate-50/30 border-slate-200'}`}>
                      <p className="text-[10px] uppercase font-black text-slate-500">Přidat novou metriku</p>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={newMetricLabel}
                          onChange={(e) => setNewMetricLabel(e.target.value)}
                          placeholder="Název (např. Focus)"
                          className={`${inputClass} flex-1`}
                        />
                        <input
                          type="color"
                          value={newMetricColor}
                          onChange={(e) => setNewMetricColor(e.target.value)}
                          className="h-full w-12 p-0.5 bg-transparent border-0 rounded cursor-pointer self-stretch"
                        />
                        <button onClick={addMetric} className="px-3 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl transition-all shadow-lg active:scale-95"><Plus size={18} /></button>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-6">
                  {userMistakes.map(mistake => (
                    <div key={mistake} className={`p-4 rounded-2xl border flex items-center justify-between group transition-all hover:scale-[1.01] ${isDark ? 'bg-[var(--bg-input)]/50 border-[var(--border-subtle)] hover:border-rose-500/30' : 'bg-slate-50 border-slate-100 hover:shadow-sm'}`}>
                      <span className="text-[10px] font-black uppercase tracking-tight text-slate-400 group-hover:text-rose-400 transition-colors">{mistake}</span>
                      <button onClick={() => removeMistake(mistake)} className="p-2 rounded-lg bg-rose-500/10 text-rose-500 opacity-0 group-hover:opacity-100 transition-all hover:bg-rose-500 hover:text-white"><X size={12} /></button>
                    </div>
                  ))}
                </div>
                <div className="flex flex-col sm:flex-row gap-3 p-3 rounded-2xl bg-slate-950/20 border border-white/5 backdrop-blur-xl">
                  <input value={newMistake} onChange={e => setNewMistake(e.target.value)} onKeyDown={e => e.key === 'Enter' && addMistake()} className={`${inputClass} flex-1 py-3 px-4 text-xs`} placeholder="Nová typická bota..." />
                  <button onClick={addMistake} className="px-6 py-3 bg-rose-600 hover:bg-rose-500 text-white rounded-xl font-black uppercase text-[10px] tracking-widest shadow-xl shadow-rose-600/20 active:scale-95 transition-all flex items-center justify-center gap-2"><Plus size={16} /> Přidat chybu</button>
                </div>
              </section>

              {/* Emotions Section */}
              <section className={`p-6 rounded-[32px] border relative overflow-hidden ${isDark ? 'bg-[var(--bg-card)]/80 border-[var(--border-subtle)]' : 'bg-white border-slate-200 shadow-sm'}`}>
                <div className="flex items-center gap-3 mb-6">
                  <div className="p-3 rounded-xl bg-purple-500 text-white shadow-lg shadow-purple-500/10"><Brain size={20} /></div>
                  <div>
                    <h3 className={`text-xl font-black italic tracking-tighter ${isDark ? 'text-white' : 'text-slate-900'}`}>EMOČNÍ MAPA</h3>
                    <p className="text-[9px] font-black uppercase tracking-widest text-slate-500">Sledování vlivu emocí na tvůj trading</p>
                  </div>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3 mb-6">
                  {userEmotions.map(emo => (
                    <div key={emo.id} className={`p-4 rounded-2xl border flex flex-col items-center justify-center gap-2 group transition-all hover:scale-[1.02] ${isDark ? 'bg-[var(--bg-input)]/50 border-[var(--border-subtle)] hover:border-purple-500/30' : 'bg-slate-50 border-slate-100 hover:shadow-sm'}`}>
                      <span className="text-[10px] font-black uppercase tracking-tight text-slate-400 group-hover:text-purple-400 transition-colors text-center">{emo.label}</span>
                      <button onClick={() => removeEmo(emo.id)} className="p-1.5 rounded-lg bg-rose-500/10 text-rose-500 opacity-0 group-hover:opacity-100 transition-all hover:bg-rose-500 hover:text-white"><Trash2 size={10} /></button>
                    </div>
                  ))}
                </div>
                <div className="flex flex-col sm:flex-row gap-3 p-3 rounded-2xl bg-slate-950/20 border border-white/5 backdrop-blur-xl">
                  <input value={newEmoLabel} onChange={e => setNewEmoLabel(e.target.value)} onKeyDown={e => e.key === 'Enter' && addEmo()} className={`${inputClass} flex-1 py-3 px-4 text-xs`} placeholder="Jak se cítíš?" />
                  <button onClick={addEmo} className="px-6 py-3 bg-purple-600 hover:bg-purple-500 text-white rounded-xl font-black uppercase text-[10px] tracking-widest shadow-xl shadow-purple-600/20 active:scale-95 transition-all flex items-center justify-center gap-2"><Plus size={16} /> Přidat emoci</button>
                </div>
              </section>
            </div>
          )
          }

          {
            activeTab === 'strategy' && (
              <div className="space-y-6 animate-in fade-in slide-in-from-right-8 duration-500">
                {/* Iron Rules */}
                <section className={`p-6 rounded-[32px] border relative overflow-hidden ${isDark ? 'bg-[#0a0f1d]/80 border-blue-500/10' : 'bg-white border-slate-200 shadow-sm'}`}>
                  <div className="flex items-center gap-3 mb-6">
                    <div className="p-3 rounded-xl bg-blue-500 text-white shadow-lg shadow-blue-500/10"><ShieldCheck size={20} /></div>
                    <div>
                      <h3 className={`text-xl font-black italic tracking-tighter ${isDark ? 'text-white' : 'text-slate-900'}`}>ŽELEZNÁ PRAVIDLA</h3>
                      <p className="text-[9px] font-black uppercase tracking-widest text-slate-500">Master Checklist tvého obchodního dne</p>
                    </div>
                  </div>
                  <div className="space-y-2 mb-6">
                    {ironRules.map(rule => (
                      <div key={rule.id} className={`p-4 rounded-2xl border flex items-center justify-between group transition-all ${isDark ? 'bg-[var(--bg-input)]/50 border-[var(--border-subtle)] hover:border-blue-500/30' : 'bg-slate-50 border-slate-100 hover:shadow-sm'}`}>
                        <div className="flex items-center gap-4">
                          <div className={`p-2.5 rounded-xl transition-all group-hover:scale-105 ${rule.type === 'ritual' ? 'bg-indigo-500 text-white shadow-lg shadow-indigo-500/10' : 'bg-blue-600 text-white shadow-lg shadow-blue-600/10'}`}>
                            {rule.type === 'ritual' ? <Zap size={18} /> : <ShieldAlert size={18} />}
                          </div>
                          <div>
                            <p className="text-xs font-black uppercase tracking-tight mb-0.5">{rule.label}</p>
                            <div className="flex items-center gap-2">
                              <p className={`text-[8px] font-black uppercase tracking-widest ${rule.type === 'ritual' ? 'text-indigo-400' : 'text-blue-400'}`}>{rule.type === 'ritual' ? 'Daily Ritual' : 'Hard Rule'}</p>
                              <span className="w-0.5 h-0.5 rounded-full bg-slate-600" />
                              <p className="text-[8px] font-black uppercase tracking-widest text-slate-500">Unbreakable</p>
                            </div>
                          </div>
                        </div>
                        <button onClick={() => removeRule(rule.id)} className="p-2.5 rounded-xl bg-rose-500/10 text-rose-500 opacity-0 group-hover:opacity-100 transition-all hover:bg-rose-500 hover:text-white"><Trash2 size={16} /></button>
                      </div>
                    ))}
                  </div>
                  <div className={`flex flex-col sm:flex-row gap-3 p-3 rounded-2xl border backdrop-blur-xl ${isDark ? 'bg-[var(--bg-card)]/20 border-[var(--border-subtle)]' : 'bg-slate-50 border-slate-100'}`}>
                    <input value={newRuleLabel} onChange={e => setNewRuleLabel(e.target.value)} className={`${inputClass} flex-[2] py-3 px-4 text-xs truncate`} placeholder="Nadefinuj nové pravidlo..." />
                    <select value={newRuleType} onChange={e => setNewRuleType(e.target.value as any)} className={`${inputClass} flex-1 min-w-[120px] py-3 px-4 text-[9px] uppercase font-black tracking-widest`}>
                      <option value="ritual">Rituál</option>
                      <option value="trading">Pravidlo</option>
                    </select>
                    <button onClick={addIronRule} className="px-6 py-3 bg-blue-600 hover:bg-blue-500 text-white rounded-xl font-black uppercase text-[10px] tracking-widest shadow-xl shadow-blue-600/20 active:scale-95 transition-all flex items-center justify-center gap-2"><Plus size={16} /> Přidat</button>
                  </div>
                </section>

                {/* Confluence Hub */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <section className={`p-6 rounded-[32px] border relative overflow-hidden ${isDark ? 'bg-[#0a0f1d]/80 border-white/5' : 'bg-white border-slate-200 shadow-sm'}`}>
                    <h4 className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-6 flex items-center gap-2.5">
                      <div className="p-1.5 rounded-lg bg-blue-500/10 text-blue-500"><Activity size={16} /></div>
                      HTF Confluence
                    </h4>
                    <div className="flex flex-wrap gap-2 mb-6">
                      {htfOptions.map(opt => (
                        <div key={opt} className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-blue-600/10 border border-blue-500/20 text-[9px] font-black uppercase text-blue-400 group hover:bg-blue-600 hover:text-white transition-all">
                          <span>{opt}</span>
                          <button onClick={() => removeHtf(opt)} className="text-rose-500 hover:text-white"><X size={14} /></button>
                        </div>
                      ))}
                    </div>
                    <div className="flex gap-2.5">
                      <input value={newHtf} onChange={e => setNewHtf(e.target.value)} onKeyDown={e => e.key === 'Enter' && addHtf()} className={`${inputClass} flex-1 py-3 px-4 text-xs`} placeholder="Nová HTF..." />
                      <button onClick={addHtf} className="p-3 bg-blue-600 hover:bg-blue-500 text-white rounded-xl shadow-lg transition-all active:scale-90"><Plus size={20} /></button>
                    </div>
                  </section>
                  <section className={`p-6 rounded-[32px] border relative overflow-hidden ${isDark ? 'bg-[#0a0f1d]/80 border-white/5' : 'bg-white border-slate-200 shadow-sm'}`}>
                    <h4 className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-6 flex items-center gap-2.5">
                      <div className="p-1.5 rounded-lg bg-blue-500/10 text-blue-500"><Activity size={16} /></div>
                      LTF Confluence
                    </h4>
                    <div className="flex flex-wrap gap-2 mb-6">
                      {ltfOptions.map(opt => (
                        <div key={opt} className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-blue-600/10 border border-blue-500/20 text-[9px] font-black uppercase text-blue-400 group hover:bg-blue-600 hover:text-white transition-all">
                          <span>{opt}</span>
                          <button onClick={() => removeLtf(opt)} className="text-rose-500 hover:text-white"><X size={14} /></button>
                        </div>
                      ))}
                    </div>
                    <div className="flex gap-2.5">
                      <input value={newLtf} onChange={e => setNewLtf(e.target.value)} onKeyDown={e => e.key === 'Enter' && addLtf()} className={`${inputClass} flex-1 py-3 px-4 text-xs`} placeholder="Nová LTF..." />
                      <button onClick={addLtf} className="p-3 bg-blue-600 hover:bg-blue-500 text-white rounded-xl shadow-lg transition-all active:scale-90"><Plus size={20} /></button>
                    </div>
                  </section>
                </div>
              </div>
            )
          }

          {
            activeTab === 'market' && (
              <div className="space-y-6 animate-in fade-in slide-in-from-right-8 duration-500">
                <section className={`p-6 rounded-[32px] border relative overflow-hidden ${isDark ? 'bg-[var(--bg-card)]/80 border-[var(--border-subtle)]' : 'bg-white border-slate-200 shadow-sm'}`}>
                  <div className="flex items-center justify-between mb-8">
                    <div className="flex items-center gap-3">
                      <div className="p-3 rounded-xl bg-indigo-600 text-white shadow-lg shadow-indigo-500/10"><Globe size={20} /></div>
                      <div>
                        <h3 className={`text-xl font-black italic tracking-tighter ${isDark ? 'text-white' : 'text-slate-900'}`}>OBCHODNÍ SEANCE</h3>
                        <p className="text-[9px] font-black uppercase tracking-widest text-slate-500">Definice obchodního dne s minutovou přesností</p>
                      </div>
                    </div>
                    <button onClick={addSession} className="px-6 py-3 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl font-black uppercase text-[10px] tracking-widest transition-all shadow-xl shadow-indigo-600/20 flex items-center gap-2 active:scale-95"><Plus size={18} /> Přidat seanci</button>
                  </div>

                  {/* Updated Timeline Visualization */}
                  <div className={`mb-8 p-6 rounded-[32px] border ${isDark ? 'bg-[var(--bg-page)]/50 border-[var(--border-subtle)]' : 'bg-slate-50 border-slate-100 shadow-inner'}`}>
                    <div className="flex justify-between text-[9px] font-black text-slate-500 uppercase mb-4 px-2">
                      {[0, 3, 6, 9, 12, 15, 18, 21].map(h => <span key={h}>{h}h</span>)}
                      <span>24h</span>
                    </div>
                    <div className="h-6 w-full bg-slate-900 rounded-full relative overflow-hidden flex shadow-inner group">
                      {sessions.map(session => {
                        const startTime = session.startTime || '09:00';
                        const endTime = session.endTime || '17:00';
                        const [startH, startM] = startTime.split(':').map(Number);
                        const [endH, endM] = endTime.split(':').map(Number);

                        const startMinutes = startH * 60 + (startM || 0);
                        const endMinutes = endH * 60 + (endM || 0);

                        const start = (startMinutes / 1440) * 100;
                        const end = (endMinutes / 1440) * 100;

                        const width = end >= start ? end - start : (100 - start) + end;

                        const blockColor = session.color || '#3b82f6';

                        if (end < start) {
                          return (
                            <React.Fragment key={session.id}>
                              <div className="absolute h-full opacity-70 group-hover:opacity-100 transition-all duration-500" style={{ left: `${start}%`, width: `${100 - start}%`, backgroundColor: blockColor }} />
                              <div className="absolute h-full opacity-70 group-hover:opacity-100 transition-all duration-500" style={{ left: '0%', width: `${end}%`, backgroundColor: blockColor }} />
                            </React.Fragment>
                          );
                        }
                        return <div key={session.id} className="absolute h-full opacity-70 border-x border-white/10 group-hover:opacity-100 transition-all duration-500" style={{ left: `${start}%`, width: `${width}%`, backgroundColor: blockColor }} />;
                      })}
                      <div className="absolute inset-x-0 h-px bg-white/10 top-1/2" />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
                    {sessions.map(session => (
                      <div key={session.id} className={`p-5 rounded-[32px] border relative group transition-all hover:scale-[1.01] ${isDark ? 'bg-[var(--bg-input)]/80 border-[var(--border-subtle)] hover:border-indigo-500/20' : 'bg-white border-slate-100 shadow-sm hover:shadow-lg'}`}>
                        <button onClick={() => removeSession(session.id)} className="absolute -top-2 -right-2 p-2 bg-rose-600 text-white rounded-xl opacity-0 group-hover:opacity-100 transition-all shadow-xl active:scale-95 z-10"><X size={14} /></button>
                        <div className="space-y-4">
                          <div className="flex items-center gap-3">
                            <div className="relative group/color shrink-0">
                              <input type="color" value={session.color || '#3b82f6'} onChange={e => updateSession(session.id, { color: e.target.value })} className="absolute inset-0 opacity-0 cursor-pointer w-full h-full" />
                              <div className="w-8 h-8 rounded-xl shadow-lg transition-transform group-hover/color:scale-110 border-2 border-white/10" style={{ backgroundColor: session.color || '#3b82f6' }} />
                            </div>
                            <input value={session.name} onChange={e => updateSession(session.id, { name: e.target.value })} className={`flex-1 bg-transparent text-sm font-black uppercase tracking-widest outline-none border-b border-transparent focus:border-indigo-500 py-0.5 transition-all ${isDark ? 'text-white' : 'text-slate-900'}`} placeholder="Název" />
                          </div>

                          <div className="grid grid-cols-2 gap-3">
                            <div className="space-y-1.5">
                              <label className="text-[8px] font-black uppercase text-slate-500 flex items-center gap-1.5"><Clock size={10} className="text-indigo-400" /> Start</label>
                              <input type="time" value={session.startTime} onChange={e => updateSession(session.id, { startTime: e.target.value })} className={`${inputClass} w-full py-2 px-3 text-[10px] font-black tracking-widest`} />
                            </div>
                            <div className="space-y-1.5">
                              <label className="text-[8px] font-black uppercase text-slate-500 flex items-center gap-1.5"><Clock size={10} className="text-rose-400" /> Konec</label>
                              <input type="time" value={session.endTime} onChange={e => updateSession(session.id, { endTime: e.target.value })} className={`${inputClass} w-full py-2 px-3 text-[10px] font-black tracking-widest`} />
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              </div>
            )
          }

          {
            activeTab === 'financials' && (
              <div className="space-y-6 animate-in fade-in slide-in-from-right-8 duration-500">
                <section className={`p-6 rounded-[32px] border relative overflow-hidden ${isDark ? 'bg-[var(--bg-card)]/80 border-[var(--border-subtle)]' : 'bg-white border-slate-200 shadow-sm'}`}>
                  <div className="flex items-center gap-3 mb-8">
                    <div className="p-3 rounded-xl bg-emerald-500 text-white shadow-lg shadow-emerald-500/10"><DollarSign size={20} /></div>
                    <div>
                      <h3 className={`text-xl font-black italic tracking-tighter ${isDark ? 'text-white' : 'text-slate-900'}`}>FEE ENGINE</h3>
                      <p className="text-[9px] font-black uppercase tracking-widest text-slate-500">Konfigurace nákladů na kontrakt (RT)</p>
                    </div>
                  </div>

                  <div className={`grid grid-cols-1 md:grid-cols-3 gap-4 items-end mb-8 p-6 rounded-[24px] border backdrop-blur-xl ${isDark ? 'bg-[var(--bg-page)]/20 border-[var(--border-subtle)]' : 'bg-slate-50 border-slate-100'}`}>
                    <div className="space-y-2">
                      <label className="text-[10px] font-black uppercase text-slate-500 ml-1 tracking-widest">Instrument</label>
                      <select value={selectedFeeInst} onChange={e => setSelectedFeeInst(e.target.value)} className={`${inputClass} w-full py-2.5 uppercase font-black tracking-widest text-[10px]`}>
                        {INSTRUMENT_LIST.map(inst => <option key={inst} value={inst}>{inst}</option>)}
                      </select>
                    </div>
                    <div className="space-y-2">
                      <label className="text-[10px] font-black uppercase text-slate-500 ml-1 tracking-widest">Poplatek (RT)</label>
                      <div className="relative">
                        <span className="absolute left-4 top-1/2 -translate-y-1/2 text-emerald-500 font-black text-sm">$</span>
                        <input type="number" step="0.01" value={newFeeVal} onChange={e => setNewFeeVal(e.target.value)} placeholder="0.52" className={`${inputClass} w-full pl-9 py-2.5 font-black text-xs`} />
                      </div>
                    </div>
                    <button onClick={saveFee} className="h-[44px] bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl font-black uppercase text-[10px] tracking-widest shadow-xl shadow-emerald-600/20 transition-all active:scale-95 flex items-center justify-center gap-2">Uložit</button>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                    {Object.entries(instrumentFees).map(([inst, fee]) => (
                      <div key={inst} className={`p-5 rounded-[24px] border flex flex-col items-center gap-1.5 relative group transition-all hover:scale-[1.05] ${isDark ? 'bg-[var(--bg-input)]/80 border-[var(--border-subtle)] hover:border-emerald-500/30' : 'bg-white border-slate-100 shadow-sm hover:shadow-lg'}`}>
                        <button onClick={() => removeFee(inst)} className="absolute top-3 right-3 p-2 text-slate-600 hover:text-rose-500 opacity-0 group-hover:opacity-100 transition-all bg-rose-500/5 rounded-lg"><X size={12} /></button>
                        <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest">{inst}</span>
                        <div className="flex items-baseline gap-1">
                          <span className="text-xl font-black text-emerald-500 tracking-tighter">${(fee as number).toFixed(2)}</span>
                          <span className="text-[8px] font-bold text-slate-600 uppercase">RT</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              </div>
            )
          }
        </div >
      </main >
    </div >
  );
};

export default Settings;
