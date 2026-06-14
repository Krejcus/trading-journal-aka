import React, { useState, useEffect } from 'react';
import { 
  Moon, Sun, CheckCircle2, XCircle, Brain, Target, Sparkles, Star, AlertCircle, 
  Play, BookOpen, Clock, Heart, Trash2, Plus, Edit2, Check, ArrowRight
} from 'lucide-react';
import type { DailyPrep, DailyReview, SessionConfig, IronRule } from '../types';

interface CoachSessionPreviewProps {
  mode: 'morning_prep' | 'post_session' | 'evening_review';
  state: any; // Prep or Review parsed object
  onChange: (updatedState: any) => void;
  onSave: () => void;
  isSaving: boolean;
  coachType: 'analytical' | 'fast';
  sessions?: SessionConfig[];
  ironRules?: IronRule[];
}

export const CoachSessionPreview: React.FC<CoachSessionPreviewProps> = ({
  mode,
  state,
  onChange,
  onSave,
  isSaving,
  coachType,
  sessions = [],
  ironRules = []
}) => {
  // Trace changes to animate pulsing borders
  const [pulseKeys, setPulseKeys] = useState<Record<string, boolean>>({});

  useEffect(() => {
    // Whenever state updates, flash updated fields
    const newPulseKeys: Record<string, boolean> = {};
    Object.keys(state || {}).forEach(k => {
      newPulseKeys[k] = true;
    });
    setPulseKeys(newPulseKeys);
    const timer = setTimeout(() => setPulseKeys({}), 800);
    return () => clearTimeout(timer);
  }, [state]);

  const updateField = (key: string, value: any) => {
    onChange({ ...state, [key]: value });
  };

  const activeColor = coachType === 'fast' ? 'amber' : 'blue';
  const accentBorder = coachType === 'fast' 
    ? 'border-amber-500/40 shadow-amber-500/5 bg-amber-500/5' 
    : 'border-blue-500/40 shadow-blue-500/5 bg-blue-500/5';

  const pulseClass = (key: string) => 
    pulseKeys[key] ? `transition-all duration-300 border-${activeColor}-500/50 bg-${activeColor}-500/5 scale-[1.01]` : 'border-[var(--border-subtle)]';

  // ─── RENDERS FOR EACH SEANCE ────────────────────────────────────────────────

  const renderMorningPrep = () => {
    const p = (state || {}) as any;
    const rituals = (ironRules || []).filter(r => r.type === 'ritual');
    const tradingRules = (ironRules || []).filter(r => r.type === 'trading');
    
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 h-full overflow-y-auto pr-1 pb-4 scrollbar-thin">
        {/* Checklist Card (Real Rituals) */}
        <div className={`p-4 rounded-2xl border bg-[var(--bg-card)] flex flex-col gap-3 transition-all duration-300 ${pulseClass('ritualCompletions')}`}>
          <span className="text-xs font-black text-[var(--text-secondary)] uppercase tracking-wider block mb-1">Ranní rituály</span>
          
          <div className="space-y-2.5">
            {rituals.map(ritual => {
              const comp = p.ritualCompletions?.find((rc: any) => rc.ruleId === ritual.id);
              const isCompleted = comp?.status === 'Pass';
              
              return (
                <label key={ritual.id} className="flex items-start gap-2.5 cursor-pointer text-xs font-semibold text-[var(--text-primary)] select-none">
                  <input 
                    type="checkbox" 
                    checked={isCompleted} 
                    onChange={(e) => {
                      const current = p.ritualCompletions || [];
                      const exists = current.find((rc: any) => rc.ruleId === ritual.id);
                      let updated;
                      if (exists) {
                        updated = current.map((rc: any) => rc.ruleId === ritual.id ? { ...rc, status: e.target.checked ? 'Pass' : 'Pending' } : rc);
                      } else {
                        updated = [...current, { ruleId: ritual.id, status: e.target.checked ? 'Pass' : 'Pending', label: ritual.label }];
                      }
                      updateField('ritualCompletions', updated);
                    }}
                    className={`rounded border-[var(--border-subtle)] text-${activeColor}-600 focus:ring-0 w-4 h-4 cursor-pointer mt-0.5`}
                  />
                  <span>{ritual.label}</span>
                </label>
              );
            })}
            {rituals.length === 0 && (
              <span className="text-xs text-[var(--text-secondary)] italic">Žádné rituály nejsou nakonfigurovány v nastavení.</span>
            )}
          </div>
        </div>

        {/* Trading Rules Card */}
        <div className={`p-4 rounded-2xl border bg-[var(--bg-card)] flex flex-col gap-3 transition-all duration-300 ${pulseClass('committedRuleIds')}`}>
          <span className="text-xs font-black text-[var(--text-secondary)] uppercase tracking-wider block mb-1">Trading pravidla k dodržení</span>
          
          <div className="space-y-2.5">
            {tradingRules.map(rule => {
              const isCommitted = p.committedRuleIds?.includes(rule.id);
              
              return (
                <label key={rule.id} className="flex items-start gap-2.5 cursor-pointer text-xs font-semibold text-[var(--text-primary)] select-none">
                  <input 
                    type="checkbox" 
                    checked={isCommitted} 
                    onChange={(e) => {
                      const current = p.committedRuleIds || [];
                      let updated;
                      if (e.target.checked) {
                        updated = [...current, rule.id];
                      } else {
                        updated = current.filter((id: string) => id !== rule.id);
                      }
                      updateField('committedRuleIds', updated);
                    }}
                    className={`rounded border-[var(--border-subtle)] text-${activeColor}-600 focus:ring-0 w-4 h-4 cursor-pointer mt-0.5`}
                  />
                  <span>{rule.label}</span>
                </label>
              );
            })}
            {tradingRules.length === 0 && (
              <span className="text-xs text-[var(--text-secondary)] italic">Žádná trading pravidla nejsou nakonfigurována v nastavení.</span>
            )}
          </div>
        </div>

        {/* Daily Goals Card */}
        <div className={`p-4 rounded-2xl border bg-[var(--bg-card)] transition-all duration-300 ${pulseClass('goals')}`}>
          <span className="text-xs font-black text-[var(--text-secondary)] uppercase tracking-wider block mb-2">Cíle dne</span>
          <div className="space-y-2">
            {(p.goals || []).map((goal: string, idx: number) => (
              <div key={idx} className="flex items-center justify-between gap-2 bg-[var(--bg-page)] px-3 py-2 rounded-xl border border-[var(--border-subtle)]">
                <span className="text-xs font-semibold text-[var(--text-primary)]">{goal}</span>
                <button 
                  type="button"
                  onClick={() => updateField('goals', p.goals?.filter((_: any, i: number) => i !== idx))}
                  className="text-red-400 hover:text-red-300 p-0.5 rounded cursor-pointer"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
            <div className="flex gap-2 mt-2">
              <input 
                type="text" 
                placeholder="Přidat nový cíl..." 
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && e.currentTarget.value.trim()) {
                    const val = e.currentTarget.value.trim();
                    updateField('goals', [...(p.goals || []), val]);
                    e.currentTarget.value = '';
                  }
                }}
                className={`flex-grow bg-[var(--bg-page)] text-xs border border-[var(--border-subtle)] rounded-xl px-3 py-2 text-[var(--text-primary)] outline-none focus:border-${activeColor}-500/50`}
              />
            </div>
          </div>
        </div>

        {/* Affirmation & Focus Card */}
        <div className={`p-4 md:col-span-2 rounded-2xl border bg-[var(--bg-card)] transition-all duration-300 ${pulseClass('mindsetState')}`}>
          <span className="text-xs font-black text-[var(--text-secondary)] uppercase tracking-wider block mb-3">Mentální nastavení a afirmace</span>
          <div className="space-y-3">
            <div>
              <span className="text-[10px] font-bold text-[var(--text-secondary)] uppercase tracking-widest block mb-1">Dnešní afirmace</span>
              <textarea 
                value={p.mindsetState || ''} 
                onChange={(e) => updateField('mindsetState', e.target.value)}
                placeholder="Napiš svou dnešní afirmaci..."
                rows={2}
                className="w-full text-xs bg-[var(--bg-page)] border border-[var(--border-subtle)] rounded-xl p-2.5 outline-none focus:border-blue-500/30 text-[var(--text-primary)]"
              />
            </div>
            <div>
              <span className="text-[10px] font-bold text-[var(--text-secondary)] uppercase tracking-widest block mb-1">Heslo dne / Focus</span>
              <input 
                type="text"
                value={p.dailyFocus || ''} 
                onChange={(e) => updateField('dailyFocus', e.target.value)}
                placeholder="Např. Trpělivost, SL, Čekání..."
                className="w-full text-xs bg-[var(--bg-page)] border border-[var(--border-subtle)] rounded-xl px-3 py-2 outline-none focus:border-blue-500/30 text-[var(--text-primary)]"
              />
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderEveningReview = () => {
    const r = (state || {}) as any;
    const tradingRules = (ironRules || []).filter(r => r.type === 'trading');

    return (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 h-full overflow-y-auto pr-1 pb-4 scrollbar-thin">
        {/* Rating Card */}
        <div className={`p-4 rounded-2xl border bg-[var(--bg-card)] flex flex-col justify-between transition-all duration-300 ${pulseClass('rating')}`}>
          <span className="text-xs font-black text-[var(--text-secondary)] uppercase tracking-wider block mb-1">Hodnocení dne</span>
          <div className="flex gap-1.5 my-3">
            {[1, 2, 3, 4, 5].map(star => (
              <button
                key={star}
                type="button"
                onClick={() => updateField('rating', star)}
                className="p-1 rounded-lg hover:bg-[var(--bg-page)] cursor-pointer transition-all"
              >
                <Star 
                  size={22} 
                  fill={star <= (r.rating || 0) ? '#eab308' : 'none'} 
                  className={star <= (r.rating || 0) ? 'text-amber-500' : 'text-[var(--text-secondary)]'}
                />
              </button>
            ))}
          </div>
          <span className="text-[10px] text-[var(--text-secondary)] italic">1 = katastrofa, 5 = perfektní seance</span>
        </div>

        {/* Scenario Result Card */}
        <div className={`p-4 rounded-2xl border bg-[var(--bg-card)] flex flex-col justify-between transition-all duration-300 ${pulseClass('scenarioResult')}`}>
          <span className="text-xs font-black text-[var(--text-secondary)] uppercase tracking-wider block mb-1">Skutečný scénář trhu</span>
          <div className="grid grid-cols-2 gap-2 my-2">
            {(['Bullish', 'Bearish', 'Range', 'Unpredicted'] as const).map(res => (
              <button
                key={res}
                type="button"
                onClick={() => updateField('scenarioResult', res)}
                className={`py-1.5 rounded-xl text-[10px] font-bold cursor-pointer transition-all border ${
                  r.scenarioResult === res
                    ? 'bg-blue-600/10 text-blue-400 border-blue-500/30'
                    : 'bg-transparent text-[var(--text-secondary)] border-[var(--border-subtle)]'
                }`}
              >
                {res === 'Unpredicted' ? 'Nečekaný' : res}
              </button>
            ))}
          </div>
        </div>

        {/* Main Takeaway & Lessons */}
        <div className={`p-4 md:col-span-2 rounded-2xl border bg-[var(--bg-card)] transition-all duration-300 ${pulseClass('mainTakeaway')}`}>
          <span className="text-xs font-black text-[var(--text-secondary)] uppercase tracking-wider block mb-3">Zhodnocení dne</span>
          <div className="space-y-3">
            <div>
              <span className="text-[10px] font-bold text-[var(--text-secondary)] uppercase tracking-widest block mb-1">Hlavní poznatek</span>
              <textarea 
                value={r.mainTakeaway || ''} 
                onChange={(e) => updateField('mainTakeaway', e.target.value)}
                placeholder="Co byl tvůj největší vhled z dnešního tradingu..."
                rows={2}
                className="w-full text-xs bg-[var(--bg-page)] border border border-[var(--border-subtle)] rounded-xl p-2.5 outline-none focus:border-blue-500/30 text-[var(--text-primary)]"
              />
            </div>
            <div>
              <span className="text-[10px] font-bold text-[var(--text-secondary)] uppercase tracking-widest block mb-1">Ponaučení / Lekce</span>
              <textarea 
                value={r.lessons || ''} 
                onChange={(e) => updateField('lessons', e.target.value)}
                placeholder="Co příště uděláš jinak / co sis odnesl..."
                rows={2}
                className="w-full text-xs bg-[var(--bg-page)] border border border-[var(--border-subtle)] rounded-xl p-2.5 outline-none focus:border-blue-500/30 text-[var(--text-primary)]"
              />
            </div>
          </div>
        </div>

        {/* Goals Accomplishment */}
        <div className={`p-4 md:col-span-2 rounded-2xl border bg-[var(--bg-card)] transition-all duration-300 ${pulseClass('goalResults')}`}>
          <span className="text-xs font-black text-[var(--text-secondary)] uppercase tracking-wider block mb-2">Vyhodnocení cílů</span>
          <div className="space-y-2">
            {(r.goalResults || []).map((goal: any, idx: number) => (
              <div key={idx} className="flex items-center justify-between gap-3 bg-[var(--bg-page)] px-3 py-2.5 rounded-xl border border-[var(--border-subtle)]">
                <span className="text-xs font-semibold text-[var(--text-primary)]">{goal.text}</span>
                <button
                  type="button"
                  onClick={() => {
                    const updated = [...(r.goalResults || [])];
                    updated[idx] = { ...goal, achieved: !goal.achieved };
                    updateField('goalResults', updated);
                  }}
                  className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-[10px] font-bold cursor-pointer transition-all border ${
                    goal.achieved 
                      ? 'bg-green-500/10 text-green-400 border-green-500/20' 
                      : 'bg-red-500/10 text-red-400 border-red-500/20'
                  }`}
                >
                  {goal.achieved ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
                  <span>{goal.achieved ? 'Splněno' : 'Nesplněno'}</span>
                </button>
              </div>
            ))}
            {(!r.goalResults || r.goalResults.length === 0) && (
              <span className="text-xs text-[var(--text-secondary)] italic block py-2">Žádné ranní cíle k vyhodnocení.</span>
            )}
          </div>
        </div>

        {/* Rule Adherence Card */}
        <div className={`p-4 md:col-span-2 rounded-2xl border bg-[var(--bg-card)] transition-all duration-300 ${pulseClass('ruleAdherence')}`}>
          <span className="text-xs font-black text-[var(--text-secondary)] uppercase tracking-wider block mb-2">Dodržení obchodních pravidel</span>
          <div className="space-y-2.5">
            {tradingRules.map(rule => {
              const comp = r.ruleAdherence?.find((a: any) => a.ruleId === rule.id);
              const status = comp?.status || 'Pending';
              
              return (
                <div key={rule.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 bg-[var(--bg-page)] px-3 py-2.5 rounded-xl border border-[var(--border-subtle)]">
                  <span className="text-xs font-semibold text-[var(--text-primary)] truncate max-w-[50%] sm:max-w-none">{rule.label}</span>
                  <div className="flex gap-1 flex-shrink-0">
                    <button
                      type="button"
                      onClick={() => {
                        const current = r.ruleAdherence || [];
                        const exists = current.find((a: any) => a.ruleId === rule.id);
                        let updated;
                        if (exists) {
                          updated = current.map((a: any) => a.ruleId === rule.id ? { ...a, status: 'Pass' } : a);
                        } else {
                          updated = [...current, { ruleId: rule.id, status: 'Pass', label: rule.label }];
                        }
                        updateField('ruleAdherence', updated);
                      }}
                      className={`px-2.5 py-1 rounded-lg text-[10px] font-bold cursor-pointer border transition-all ${
                        status === 'Pass'
                          ? 'bg-green-500/10 text-green-400 border-green-500/20'
                          : 'bg-transparent text-[var(--text-secondary)] border-[var(--border-subtle)] hover:text-green-400 hover:border-green-500/25'
                      }`}
                    >
                      Splněno
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const current = r.ruleAdherence || [];
                        const exists = current.find((a: any) => a.ruleId === rule.id);
                        let updated;
                        if (exists) {
                          updated = current.map((a: any) => a.ruleId === rule.id ? { ...a, status: 'Fail' } : a);
                        } else {
                          updated = [...current, { ruleId: rule.id, status: 'Fail', label: rule.label }];
                        }
                        updateField('ruleAdherence', updated);
                      }}
                      className={`px-2.5 py-1 rounded-lg text-[10px] font-bold cursor-pointer border transition-all ${
                        status === 'Fail'
                          ? 'bg-red-500/10 text-red-400 border-red-500/20'
                          : 'bg-transparent text-[var(--text-secondary)] border-[var(--border-subtle)] hover:text-red-400 hover:border-red-500/25'
                      }`}
                    >
                      Porušeno
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const current = r.ruleAdherence || [];
                        const exists = current.find((a: any) => a.ruleId === rule.id);
                        let updated;
                        if (exists) {
                          updated = current.map((a: any) => a.ruleId === rule.id ? { ...a, status: 'Pending' } : a);
                        } else {
                          updated = [...current, { ruleId: rule.id, status: 'Pending', label: rule.label }];
                        }
                        updateField('ruleAdherence', updated);
                      }}
                      className={`px-2.5 py-1 rounded-lg text-[10px] font-bold cursor-pointer border transition-all ${
                        status === 'Pending'
                          ? 'bg-slate-500/10 text-slate-400 border-slate-500/20'
                          : 'bg-transparent text-[var(--text-secondary)] border-[var(--border-subtle)] hover:text-[var(--text-primary)]'
                      }`}
                    >
                      Nerozhodnuto
                    </button>
                  </div>
                </div>
              );
            })}
            {tradingRules.length === 0 && (
              <span className="text-xs text-[var(--text-secondary)] italic">Žádná pravidla nejsou nakonfigurována v nastavení.</span>
            )}
          </div>
        </div>

        {/* Mistakes Card */}
        <div className={`p-4 md:col-span-2 rounded-2xl border bg-[var(--bg-card)] transition-all duration-300 ${pulseClass('mistakes')}`}>
          <span className="text-xs font-black text-[var(--text-secondary)] uppercase tracking-wider block mb-2">Chyby dne</span>
          <div className="flex flex-wrap gap-2">
            {(r.mistakes || []).map((mistake: string, idx: number) => (
              <span 
                key={idx} 
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold bg-red-500/10 border border-red-500/20 text-red-400"
              >
                <span>{mistake}</span>
                <button 
                  type="button"
                  onClick={() => updateField('mistakes', r.mistakes?.filter((_: any, i: number) => i !== idx))}
                  className="text-red-400 hover:text-red-300 p-0.5 rounded cursor-pointer"
                >
                  <Trash2 size={11} />
                </button>
              </span>
            ))}
            <input 
              type="text" 
              placeholder="Zapsat chybu..." 
              onKeyDown={(e) => {
                if (e.key === 'Enter' && e.currentTarget.value.trim()) {
                  const val = e.currentTarget.value.trim();
                  updateField('mistakes', [...(r.mistakes || []), val]);
                  e.currentTarget.value = '';
                }
              }}
              className={`bg-[var(--bg-page)] text-xs border border-[var(--border-subtle)] rounded-xl px-3 py-1.5 text-[var(--text-primary)] outline-none focus:border-red-500/30`}
            />
          </div>
        </div>

        {/* Psycho details */}
        <div className={`p-4 md:col-span-2 rounded-2xl border bg-[var(--bg-card)] transition-all duration-300 ${pulseClass('psycho')}`}>
          <span className="text-xs font-black text-[var(--text-secondary)] uppercase tracking-wider block mb-3">Psychologický stav</span>
          <div className="space-y-3">
            <div>
              <span className="text-[10px] font-bold text-[var(--text-secondary)] uppercase tracking-widest block mb-1">Stresory (co mě dnes vyvedlo z míry)</span>
              <input 
                type="text"
                value={r.psycho?.stressors || ''} 
                onChange={(e) => updateField('psycho', { ...r.psycho, stressors: e.target.value })}
                placeholder="Např. zpoždění vlaku, velký slippage..."
                className="w-full text-xs bg-[var(--bg-page)] border border-[var(--border-subtle)] rounded-xl px-3 py-2 outline-none focus:border-blue-500/30 text-[var(--text-primary)]"
              />
            </div>
            <div>
              <span className="text-[10px] font-bold text-[var(--text-secondary)] uppercase tracking-widest block mb-1">Vděčnost (za co jsem dnes vděčný)</span>
              <input 
                type="text"
                value={r.psycho?.gratitude || ''} 
                onChange={(e) => updateField('psycho', { ...r.psycho, gratitude: e.target.value })}
                placeholder="Např. zdraví, trpělivost, držení SL..."
                className="w-full text-xs bg-[var(--bg-page)] border border-[var(--border-subtle)] rounded-xl px-3 py-2 outline-none focus:border-blue-500/30 text-[var(--text-primary)]"
              />
            </div>
            <div>
              <span className="text-[10px] font-bold text-[var(--text-secondary)] uppercase tracking-widest block mb-1">Mentální poznámky</span>
              <textarea 
                value={r.psycho?.notes || ''} 
                onChange={(e) => updateField('psycho', { ...r.psycho, notes: e.target.value })}
                placeholder="Jak se ti dnes reálně tradovalo..."
                rows={2}
                className="w-full text-xs bg-[var(--bg-page)] border border-[var(--border-subtle)] rounded-xl p-2.5 outline-none focus:border-blue-500/30 text-[var(--text-primary)]"
              />
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderPostSession = () => {
    const s = (state || {}) as { sessionId?: 'london' | 'ny' | 'asia' | null; notes?: string };

    return (
      <div className="flex flex-col gap-4 h-full pr-1 pb-4 overflow-y-auto">
        {/* Session Selector Card */}
        <div className={`p-4 rounded-2xl border bg-[var(--bg-card)] transition-all duration-300 ${pulseClass('sessionId')}`}>
          <span className="text-xs font-black text-[var(--text-secondary)] uppercase tracking-wider block mb-2">Aktivní seance</span>
          <div className="flex gap-2">
            {(['london', 'ny', 'asia'] as const).map(id => (
              <button
                key={id}
                onClick={() => updateField('sessionId', id)}
                className={`flex-1 py-2 rounded-xl text-xs font-bold cursor-pointer transition-all border capitalize ${
                  s.sessionId === id
                    ? `bg-${activeColor}-500/10 text-${activeColor}-400 border-${activeColor}-500/30`
                    : 'bg-transparent text-[var(--text-secondary)] border-[var(--border-subtle)] hover:text-[var(--text-primary)]'
                }`}
              >
                {id === 'ny' ? 'New York (NY)' : id}
              </button>
            ))}
          </div>
        </div>

        {/* Notes Card */}
        <div className={`p-4 rounded-2xl border bg-[var(--bg-card)] flex-1 flex flex-col transition-all duration-300 ${pulseClass('notes')}`}>
          <span className="text-xs font-black text-[var(--text-secondary)] uppercase tracking-wider block mb-2">Hlavní poznatky ze seance</span>
          <textarea 
            value={s.notes || ''} 
            onChange={(e) => updateField('notes', e.target.value)}
            placeholder="Popiš průběh seance, chování ceny, zda jsi dodržel plány..."
            className="w-full flex-1 min-h-[150px] text-xs bg-[var(--bg-page)] border border-[var(--border-subtle)] rounded-xl p-3 outline-none focus:border-blue-500/30 text-[var(--text-primary)] resize-none"
          />
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full bg-[var(--bg-card)]/30 rounded-2xl border border-[var(--border-subtle)] overflow-hidden shadow-xs">
      {/* Header */}
      <div className="px-5 py-4 border-b border-[var(--border-subtle)] flex items-center justify-between bg-[var(--bg-card)]/50 backdrop-blur-xs flex-shrink-0">
        <div className="flex items-center gap-2">
          <div className={`p-1.5 rounded-xl bg-${activeColor}-500/10 border border-${activeColor}-500/20 text-${activeColor}-400`}>
            <Sparkles size={16} />
          </div>
          <div>
            <h3 className="text-sm font-black text-[var(--text-primary)] leading-none">
              {mode === 'morning_prep' ? 'Ranní příprava' : mode === 'evening_review' ? 'Večerní audit' : 'Post-Session debrief'}
            </h3>
            <span className="text-[10px] text-[var(--text-secondary)] font-semibold mt-1 block">Live synchronizace s AI</span>
          </div>
        </div>

        <button 
          onClick={onSave}
          disabled={isSaving}
          className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold bg-${activeColor}-600 hover:bg-${activeColor}-500 text-white shadow-md cursor-pointer disabled:opacity-50 transition-all select-none`}
        >
          {isSaving ? (
            <span>Ukládám...</span>
          ) : (
            <>
              <span>Uložit do deníku</span>
              <ArrowRight size={13} />
            </>
          )}
        </button>
      </div>

      {/* Bento Grid Form preview */}
      <div className="flex-1 p-5 min-h-0 bg-[var(--bg-page)]/20">
        {mode === 'morning_prep' && renderMorningPrep()}
        {mode === 'evening_review' && renderEveningReview()}
        {mode === 'post_session' && renderPostSession()}
      </div>
    </div>
  );
};
