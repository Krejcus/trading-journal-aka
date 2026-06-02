/**
 * LossDayDebriefModal — automatický debrief po překročení daily limitu.
 *
 * Auto-trigger v App.tsx: po setTrades (z importu / manuálního zápisu) check
 * dnešního P&L. Pokud < -daily_limit + není autoDebrief flag → otevři.
 *
 * UX:
 *  - Stats dne (P&L, trades, WR, PF, nejhorší hodina, první loss, similar days 30d)
 *  - Coach analýza (auto-generated)
 *  - Porušená pravidla (auto-detekce + Sonnet)
 *  - 3 povinné věty: co se stalo / trigger / co zařídím že se neopakuje
 *  - Návrhy pravidel od coache (klik = aplikovat přes onApplyAction)
 *  - "Skip s warningem" — můžeš zavřít bez vyplnění, ale dostaneš popup
 */
import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertTriangle, X, Skull, Clock, Brain, TrendingDown, Shield, Pencil, FlaskConical, Loader2 } from 'lucide-react';
import type { SuggestedAction } from '../services/aiService';

interface DebriefStats {
  pnl: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  profitFactor: number | null;
  dailyLimit: number;
  firstLossTime: string | null;
  tradesAfterFirstLoss: number;
  similarDays: number;
  worstHour: { hour: number; pnl: number } | null;
}

interface DebriefData {
  date: string;
  stats: DebriefStats;
  analysis: string;
  broken_rules: Array<{ rule: string; detail: string }>;
  rule_suggestions: Array<{
    type: 'rule' | 'experiment' | 'modify_rule';
    label: string;
    duration?: string;
    targetId?: string;
    oldLabel?: string;
  }>;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** Klik "Uložit debrief" — App.tsx přijme reflexi + zaznamenané auto-debrief flag. */
  onSave: (data: { whatHappened: string; trigger: string; prevention: string; date: string }) => void;
  /** Aplikuje action návrh — reuse stejného flow jako z chat akcí. */
  onApplyAction: (action: SuggestedAction) => void;
  theme: 'dark' | 'light' | 'oled';
  /** Optional override — debrief pro konkrétní den. Default today. */
  targetDate?: string;
  /** Daily limit z user preferences nebo profilu. Default 250. */
  dailyLimit?: number;
}

const LossDayDebriefModal: React.FC<Props> = ({ isOpen, onClose, onSave, onApplyAction, theme, targetDate, dailyLimit = 250 }) => {
  const isDark = theme !== 'light';
  const [data, setData] = useState<DebriefData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Povinná reflexe
  const [whatHappened, setWhatHappened] = useState('');
  const [trigger, setTrigger] = useState('');
  const [prevention, setPrevention] = useState('');
  const [appliedActionIdx, setAppliedActionIdx] = useState<Set<number>>(new Set());

  // Skip warning state
  const [showSkipWarning, setShowSkipWarning] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const { supabase } = await import('../services/supabase');
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) { if (!cancelled) setError('Nejsi přihlášený.'); return; }
        const baseUrl = (supabase as any).supabaseUrl || (import.meta as any).env?.VITE_SUPABASE_URL || '';
        const res = await fetch(`${baseUrl}/functions/v1/loss-day-debrief`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ date: targetDate, daily_limit: dailyLimit }),
        });
        const dbody = await res.json();
        if (cancelled) return;
        if (res.ok && dbody.ok) {
          setData(dbody);
        } else {
          setError(dbody?.error === 'no-trades-today' ? 'Pro tento den nejsou obchody.' : 'Debrief se nepodařilo vygenerovat.');
        }
      } catch {
        if (!cancelled) setError('Chyba spojení.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isOpen, targetDate, dailyLimit]);

  useEffect(() => {
    if (!isOpen) {
      setData(null);
      setWhatHappened('');
      setTrigger('');
      setPrevention('');
      setAppliedActionIdx(new Set());
      setShowSkipWarning(false);
      setError(null);
    }
  }, [isOpen]);

  const isFilled = whatHappened.trim().length >= 5 && trigger.trim().length >= 5 && prevention.trim().length >= 5;

  const tryClose = () => {
    // Pokud user nevyplnil → warning, ale lze přesto zavřít.
    if (!isFilled) {
      setShowSkipWarning(true);
      return;
    }
    onClose();
  };

  const handleSave = () => {
    if (!data) return;
    onSave({
      whatHappened: whatHappened.trim(),
      trigger: trigger.trim(),
      prevention: prevention.trim(),
      date: data.date,
    });
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ type: 'spring', stiffness: 400, damping: 30 }}
            className={`max-w-3xl w-full max-h-[92vh] overflow-y-auto rounded-[32px] border shadow-2xl ${isDark ? 'bg-slate-900 border-rose-500/20' : 'bg-white border-rose-200'}`}
          >
            {/* Header — varovný tón */}
            <div className="relative p-6 lg:p-8 border-b border-rose-500/30 bg-gradient-to-b from-rose-500/10 to-transparent">
              <button onClick={tryClose} className={`absolute top-4 right-4 p-2 rounded-full ${isDark ? 'hover:bg-white/10 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}>
                <X size={18} />
              </button>
              <div className="flex items-center gap-4">
                <div className="p-3 bg-rose-500/15 border border-rose-500/40 rounded-2xl">
                  <Skull size={26} className="text-rose-500" />
                </div>
                <div>
                  <p className="text-[9px] font-black uppercase tracking-[0.3em] text-rose-500 mb-1">Loss Day Debrief</p>
                  <h2 className={`text-2xl font-black tracking-tight ${isDark ? 'text-white' : 'text-slate-900'}`}>
                    Daily limit byl překročen
                  </h2>
                </div>
              </div>
            </div>

            <div className="p-6 lg:p-8 space-y-5">
              {loading && (
                <div className="flex items-center justify-center py-16 gap-3">
                  <Loader2 size={20} className="animate-spin text-rose-500" />
                  <span className={`text-sm font-bold ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>Coach analyzuje den…</span>
                </div>
              )}

              {error && (
                <div className="p-4 rounded-2xl bg-rose-500/10 border border-rose-500/30 text-rose-500 text-sm font-bold text-center">
                  {error}
                </div>
              )}

              {data && !loading && (
                <>
                  {/* Stats grid */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <StatCard label="PnL" value={`-$${Math.abs(data.stats.pnl).toFixed(0)}`} sublabel={`limit -$${data.stats.dailyLimit}`} icon={TrendingDown} color="rose" isDark={isDark} />
                    <StatCard label="Obchodů" value={`${data.stats.trades}`} sublabel={`${data.stats.wins}W / ${data.stats.losses}L`} icon={Clock} color="slate" isDark={isDark} />
                    <StatCard label="WR" value={`${data.stats.winRate.toFixed(0)}%`} sublabel={data.stats.profitFactor != null ? `PF ${data.stats.profitFactor.toFixed(2)}` : 'PF —'} icon={Brain} color="amber" isDark={isDark} />
                    <StatCard label="Podobných dní" value={`${data.stats.similarDays}`} sublabel="za 30 dní" icon={Skull} color="rose" isDark={isDark} />
                  </div>

                  {/* Coach analýza */}
                  <Block icon={Brain} title="Coach analýza" color="blue" isDark={isDark}>
                    <p className={`text-sm leading-relaxed ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                      {data.analysis}
                    </p>
                  </Block>

                  {/* Porušená pravidla */}
                  {data.broken_rules.length > 0 && (
                    <Block icon={Shield} title="Porušená pravidla" color="rose" isDark={isDark}>
                      <ul className="space-y-1.5">
                        {data.broken_rules.map((b, i) => (
                          <li key={i} className="flex items-start gap-2 text-xs">
                            <span className="text-rose-500 font-black mt-0.5">❌</span>
                            <div>
                              <span className={`font-bold ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>{b.rule}</span>
                              <span className={`ml-2 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{b.detail}</span>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </Block>
                  )}

                  {/* Povinná reflexe */}
                  <Block icon={Pencil} title="Reflexe (povinná — 3 věty)" color="amber" isDark={isDark}>
                    <div className="space-y-3">
                      <ReflectionField
                        label="1. Co se reálně stalo"
                        placeholder="Stručně — co spustilo pokles, jak to eskalovalo."
                        value={whatHappened}
                        onChange={setWhatHappened}
                        isDark={isDark}
                      />
                      <ReflectionField
                        label="2. Trigger (co bylo bezprostřední příčina)"
                        placeholder="Po prvním lossu jsem… / Po news jsem ucítil…"
                        value={trigger}
                        onChange={setTrigger}
                        isDark={isDark}
                      />
                      <ReflectionField
                        label="3. Co konkrétně zařídím, že se to neopakuje"
                        placeholder="Zítra po prvním lossu zavřu platformu na 20 min."
                        value={prevention}
                        onChange={setPrevention}
                        isDark={isDark}
                      />
                    </div>
                  </Block>

                  {/* Coach návrhy pravidel */}
                  {data.rule_suggestions.length > 0 && (
                    <Block icon={FlaskConical} title="Coach navrhuje pravidla" color="emerald" isDark={isDark}>
                      <p className={`text-[11px] mb-3 ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
                        Klikni = okamžitě přidáno / upraveno v Nastavení → Pravidla.
                      </p>
                      <div className="space-y-2">
                        {data.rule_suggestions.map((s, i) => {
                          const applied = appliedActionIdx.has(i);
                          const isModify = s.type === 'modify_rule';
                          return (
                            <div key={i} className={`p-3 rounded-xl border flex items-start gap-3 ${isDark ? 'bg-white/5 border-white/10' : 'bg-slate-50 border-slate-200'}`}>
                              <div className={`p-1.5 rounded-lg shrink-0 ${isModify ? 'bg-amber-500/15 text-amber-500' : 'bg-emerald-500/15 text-emerald-500'}`}>
                                {isModify ? <Pencil size={14} /> : <Shield size={14} />}
                              </div>
                              <div className="flex-1 min-w-0">
                                <p className="text-[8px] font-black uppercase tracking-widest text-slate-500 mb-0.5">
                                  {s.type === 'modify_rule' ? 'Úprava pravidla' : s.type === 'experiment' ? `Experiment ${s.duration || ''}` : 'Nové pravidlo'}
                                </p>
                                {isModify && s.oldLabel && (
                                  <p className={`text-[11px] line-through opacity-60 ${isDark ? 'text-slate-400' : 'text-slate-500'} leading-tight`}>{s.oldLabel}</p>
                                )}
                                <p className={`text-xs font-bold leading-snug ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                                  {isModify ? '→ ' : ''}{s.label}
                                </p>
                              </div>
                              <button
                                onClick={() => {
                                  if (applied) return;
                                  onApplyAction(s as SuggestedAction);
                                  setAppliedActionIdx(prev => new Set([...prev, i]));
                                }}
                                disabled={applied}
                                className={`shrink-0 px-3 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-widest transition-all ${applied
                                  ? 'bg-emerald-500 text-white cursor-default'
                                  : (isModify ? 'bg-amber-500 hover:bg-amber-600 text-white' : 'bg-emerald-500 hover:bg-emerald-600 text-white')}`}
                              >
                                {applied ? 'Hotovo' : (isModify ? 'Změnit' : 'Přidat')}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    </Block>
                  )}

                  {/* Akce */}
                  <div className="flex gap-3 pt-2 sticky bottom-0 -mx-6 lg:-mx-8 px-6 lg:px-8 py-3 -mb-6 lg:-mb-8 bg-gradient-to-t from-[var(--bg-card)] via-[var(--bg-card)]/95 to-transparent">
                    <button
                      onClick={handleSave}
                      disabled={!isFilled}
                      className="flex-1 py-3 rounded-2xl text-[11px] font-black uppercase tracking-widest bg-gradient-to-r from-rose-600 to-rose-500 text-white shadow-xl shadow-rose-600/30 hover:shadow-rose-500/50 transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {isFilled ? 'Uložit debrief a zavřít →' : 'Vyplň 3 věty výše →'}
                    </button>
                  </div>
                </>
              )}
            </div>
          </motion.div>

          {/* Skip warning sub-modal */}
          <AnimatePresence>
            {showSkipWarning && (
              <div className="fixed inset-0 z-[310] flex items-center justify-center p-4 bg-black/70 backdrop-blur-md">
                <motion.div
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  className={`max-w-md w-full rounded-3xl border shadow-2xl p-6 ${isDark ? 'bg-slate-900 border-amber-500/30' : 'bg-white border-amber-200'}`}
                >
                  <div className="flex items-center gap-3 mb-3">
                    <AlertTriangle size={20} className="text-amber-500" />
                    <h3 className={`text-base font-black ${isDark ? 'text-white' : 'text-slate-900'}`}>Tohle se neuloží</h3>
                  </div>
                  <p className={`text-sm leading-relaxed mb-5 ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                    Bez reflexe nezůstane v deníku žádný záznam toho co se dnes stalo. Patterny se pak hůř hledají. Vážně chceš odejít?
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => { setShowSkipWarning(false); onClose(); }}
                      className={`flex-1 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest ${isDark ? 'bg-white/5 text-slate-400 hover:bg-white/10' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
                    >
                      Přesto odejít
                    </button>
                    <button
                      onClick={() => setShowSkipWarning(false)}
                      className="flex-1 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest bg-amber-500 text-white hover:bg-amber-600"
                    >
                      Vyplnit reflexi
                    </button>
                  </div>
                </motion.div>
              </div>
            )}
          </AnimatePresence>
        </div>
      )}
    </AnimatePresence>
  );
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const StatCard: React.FC<{
  label: string; value: string; sublabel: string; icon: any; color: 'rose' | 'slate' | 'amber'; isDark: boolean;
}> = ({ label, value, sublabel, icon: Icon, color, isDark }) => {
  const colorMap = {
    rose: 'text-rose-500 bg-rose-500/10 border-rose-500/20',
    slate: 'text-slate-500 bg-slate-500/10 border-slate-500/20',
    amber: 'text-amber-500 bg-amber-500/10 border-amber-500/20',
  }[color];
  return (
    <div className={`p-3 rounded-2xl border ${isDark ? 'bg-white/5 border-white/10' : 'bg-slate-50 border-slate-200'}`}>
      <div className="flex items-center gap-1.5 mb-1.5">
        <div className={`p-1 rounded-lg ${colorMap.split(' ').slice(1).join(' ')} border`}>
          <Icon size={10} className={colorMap.split(' ')[0]} />
        </div>
        <p className="text-[8px] font-black uppercase tracking-widest text-slate-500">{label}</p>
      </div>
      <p className={`text-lg font-black font-mono tracking-tighter ${isDark ? 'text-white' : 'text-slate-900'}`}>{value}</p>
      <p className="text-[9px] text-slate-500 font-bold">{sublabel}</p>
    </div>
  );
};

const Block: React.FC<{
  icon: any; title: string; color: 'blue' | 'rose' | 'amber' | 'emerald'; isDark: boolean; children: React.ReactNode;
}> = ({ icon: Icon, title, color, isDark, children }) => {
  const colorMap = {
    blue: 'text-blue-500 bg-blue-500/10 border-blue-500/20',
    rose: 'text-rose-500 bg-rose-500/10 border-rose-500/30',
    amber: 'text-amber-500 bg-amber-500/10 border-amber-500/30',
    emerald: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/20',
  }[color];
  return (
    <div className={`p-4 rounded-2xl border ${isDark ? 'bg-white/5 border-white/10' : 'bg-slate-50 border-slate-200'}`}>
      <div className="flex items-center gap-2 mb-3">
        <div className={`p-1.5 rounded-lg ${colorMap.split(' ').slice(1).join(' ')} border`}>
          <Icon size={12} className={colorMap.split(' ')[0]} />
        </div>
        <p className={`text-[9px] font-black uppercase tracking-[0.25em] ${colorMap.split(' ')[0]}`}>{title}</p>
      </div>
      {children}
    </div>
  );
};

const ReflectionField: React.FC<{
  label: string; placeholder: string; value: string; onChange: (s: string) => void; isDark: boolean;
}> = ({ label, placeholder, value, onChange, isDark }) => (
  <div>
    <label className={`text-[10px] font-black uppercase tracking-widest mb-1.5 block ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
      {label}
    </label>
    <textarea
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      rows={2}
      className={`w-full px-3 py-2.5 rounded-xl border text-xs leading-relaxed resize-none outline-none ${isDark ? 'bg-white/5 border-white/10 text-white placeholder:text-slate-600' : 'bg-white border-slate-200 text-slate-900 placeholder:text-slate-400'}`}
    />
    <p className={`text-[9px] mt-0.5 ${value.trim().length >= 5 ? 'text-emerald-500' : 'text-slate-500'}`}>
      {value.trim().length >= 5 ? '✓' : `${value.trim().length}/5 znaků`}
    </p>
  </div>
);

export default LossDayDebriefModal;
