/**
 * DailyStartModal — ranní příprava před obchodováním.
 *
 * Auto-trigger v App.tsx: pokud user nemá dnes prep + je 6-12 PRG (workday).
 * Plus manuální tlačítko "Start Day" na dashboardu.
 *
 * UX:
 *  - Včerejší kontext (P&L + review takeaway)
 *  - Připomínka z paměti (proaktivně — spálené účty, recurring patterny)
 *  - Dnešní závazek checklist (z iron rules + manuální klik)
 *  - Afirmace + heslo dne
 *  - Klik "Připraven" uloží timestamp, modal se zavře
 */
import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Sparkles, Sun, Brain, Target, AlertTriangle, CheckCircle2, X, Loader2 } from 'lucide-react';
import type { IronRule } from '../types';

interface BriefData {
  yesterday_recap: string;
  memory_reminder: string;
  affirmation: string;
  focus: string;
  has_failed_account: boolean;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** Klik "Připraven" — App.tsx přijme commitnutá pravidla + brief data, uloží do daily_preps. */
  onConfirm: (data: { committedRuleIds: string[]; affirmation: string; focus: string }) => void;
  theme: 'dark' | 'light' | 'oled';
  ironRules: IronRule[];
}

const DailyStartModal: React.FC<Props> = ({ isOpen, onClose, onConfirm, theme, ironRules }) => {
  const isDark = theme !== 'light';
  const [brief, setBrief] = useState<BriefData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [committedRules, setCommittedRules] = useState<Set<string>>(new Set());

  // Fetch brief při otevření
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
        const res = await fetch(`${baseUrl}/functions/v1/daily-start-brief`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        const data = await res.json();
        if (cancelled) return;
        if (res.ok && data.ok) {
          setBrief(data);
        } else {
          setError('Brief se nepodařilo vygenerovat.');
        }
      } catch {
        if (!cancelled) setError('Chyba spojení.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isOpen]);

  // Reset při zavření
  useEffect(() => {
    if (!isOpen) {
      setBrief(null);
      setCommittedRules(new Set());
      setError(null);
    }
  }, [isOpen]);

  const rituals = ironRules.filter(r => r.type === 'ritual');
  const tradingRules = ironRules.filter(r => r.type === 'trading');

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center p-4 bg-black/70 backdrop-blur-md">
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ type: 'spring', stiffness: 400, damping: 30 }}
            className={`max-w-2xl w-full max-h-[90vh] flex flex-col rounded-[32px] border shadow-2xl ${isDark ? 'bg-slate-900 border-white/10' : 'bg-white border-slate-200'}`}
          >
            {/* Header (fixed at top) */}
            <div className="shrink-0 relative p-6 lg:p-8 border-b border-amber-500/20 bg-gradient-to-b from-amber-500/5 to-transparent">
              <button onClick={onClose} className={`absolute top-4 right-4 p-2 rounded-full ${isDark ? 'hover:bg-white/10 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}>
                <X size={18} />
              </button>
              <div className="flex items-center gap-4">
                <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-2xl">
                  <Sun size={24} className="text-amber-500" />
                </div>
                <div>
                  <p className="text-[9px] font-black uppercase tracking-[0.3em] text-amber-500 mb-1">Ranní příprava</p>
                  <h2 className={`text-2xl font-black tracking-tight ${isDark ? 'text-white' : 'text-slate-900'}`}>
                    Než vyrazíš na trh
                  </h2>
                </div>
              </div>
            </div>

            {/* Scrollable content (flex-1, takes remaining height) */}
            <div className="flex-1 overflow-y-auto p-6 lg:p-8 space-y-6">
              {loading && (
                <div className="flex items-center justify-center py-12 gap-3">
                  <Loader2 size={20} className="animate-spin text-amber-500" />
                  <span className={`text-sm font-bold ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>Coach připravuje brief…</span>
                </div>
              )}

              {error && (
                <div className="p-4 rounded-2xl bg-rose-500/10 border border-rose-500/30 text-rose-500 text-sm font-bold text-center">
                  {error}
                </div>
              )}

              {brief && !loading && (
                <>
                  {/* Včerejší recap */}
                  <Section icon={Sparkles} title="Včerejší kontext" color="slate" isDark={isDark}>
                    <p className={`text-sm leading-relaxed ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                      {brief.yesterday_recap}
                    </p>
                  </Section>

                  {/* Připomínka z paměti */}
                  {brief.memory_reminder && (
                    <Section
                      icon={brief.has_failed_account ? AlertTriangle : Brain}
                      title={brief.has_failed_account ? 'Čerstvá zkušenost — hlídej' : 'Připomínka z paměti'}
                      color={brief.has_failed_account ? 'rose' : 'blue'}
                      isDark={isDark}
                    >
                      <p className={`text-sm leading-relaxed font-medium ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                        {brief.memory_reminder}
                      </p>
                    </Section>
                  )}

                  {/* Dnešní závazek */}
                  <Section icon={CheckCircle2} title="Dnešní závazek" color="emerald" isDark={isDark}>
                    <p className={`text-[11px] mb-3 ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
                      Klikni si pravidla která dnes držíš. Závazek = vědomá volba.
                    </p>
                    {(rituals.length + tradingRules.length === 0) ? (
                      <p className={`text-xs italic ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                        Žádná pravidla v Nastavení.
                      </p>
                    ) : (
                      <div className="space-y-1.5">
                        {[...rituals, ...tradingRules].slice(0, 8).map(r => {
                          const checked = committedRules.has(r.id);
                          // Parse experiment / checklist prefixy
                          const isChecklist = r.label.startsWith('📋 ');
                          const isExperiment = /^⏱\s*\[/.test(r.label);
                          const cleanLabel = isChecklist
                            ? r.label.split('\n')[0].replace(/^📋\s+/, '')
                            : isExperiment
                              ? r.label.replace(/^⏱\s*\[[^\]]+\]\s*/, '')
                              : r.label;
                          return (
                            <button
                              key={r.id}
                              onClick={() => {
                                const next = new Set(committedRules);
                                if (checked) next.delete(r.id); else next.add(r.id);
                                setCommittedRules(next);
                              }}
                              className={`w-full flex items-center gap-3 p-2.5 rounded-xl border transition-all text-left ${checked
                                ? 'bg-emerald-500/15 border-emerald-500/40'
                                : (isDark ? 'bg-white/5 border-white/10 hover:bg-white/10' : 'bg-slate-50 border-slate-200 hover:bg-slate-100')}`}
                            >
                              <div className={`w-4 h-4 rounded-md border-2 shrink-0 flex items-center justify-center ${checked ? 'bg-emerald-500 border-emerald-500' : (isDark ? 'border-slate-600' : 'border-slate-300')}`}>
                                {checked && <CheckCircle2 size={12} className="text-white" strokeWidth={3} />}
                              </div>
                              <span className={`text-xs font-bold ${checked ? (isDark ? 'text-emerald-300' : 'text-emerald-700') : (isDark ? 'text-slate-300' : 'text-slate-700')}`}>
                                {cleanLabel}
                              </span>
                              {isExperiment && <span className="ml-auto text-[8px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600">EXP</span>}
                              {r.type === 'ritual' && <span className="ml-auto text-[8px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-400">Ritual</span>}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </Section>

                  {/* Afirmace + heslo dne */}
                  <div className={`p-5 rounded-2xl border ${isDark ? 'bg-gradient-to-br from-violet-900/20 to-slate-900/40 border-violet-500/20' : 'bg-gradient-to-br from-violet-50 to-white border-violet-200'}`}>
                    <div className="flex items-center gap-2 mb-3">
                      <Sparkles size={14} className="text-violet-500" />
                      <p className="text-[9px] font-black uppercase tracking-[0.25em] text-violet-500">Afirmace</p>
                    </div>
                    <p className={`text-sm leading-relaxed font-medium ${isDark ? 'text-slate-200' : 'text-slate-700'} mb-3`}>
                      {brief.affirmation}
                    </p>
                    {brief.focus && (
                      <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-violet-500/15 text-violet-500 text-[10px] font-black uppercase tracking-wider">
                        <Target size={11} /> {brief.focus}
                      </div>
                    )}
                  </div>

                </>
              )}
            </div>

            {/* Sticky footer — glassmorphism akce. Frosted bg s amber glow,
                inner highlight a inset shadow pro 3D efekt. */}
            {brief && !loading && (
              <div
                className={`shrink-0 flex gap-3 p-4 lg:p-6 border-t rounded-b-[32px] backdrop-blur-xl ${
                  isDark
                    ? 'bg-gradient-to-b from-slate-900/70 to-slate-950/90 border-white/10'
                    : 'bg-gradient-to-b from-white/40 to-slate-100/80 border-amber-500/20'
                }`}
                style={isDark ? undefined : { boxShadow: '0 -10px 30px -10px rgba(245,158,11,0.15), inset 0 1px 0 rgba(255,255,255,0.6)' }}
              >
                <button
                  onClick={onClose}
                  className={`shrink-0 px-5 py-3 rounded-2xl text-[11px] font-black uppercase tracking-widest backdrop-blur-md transition-all hover:scale-[1.02] active:scale-95 ${
                    isDark
                      ? 'bg-white/5 hover:bg-white/10 text-slate-400 border border-white/10'
                      : 'bg-white/60 hover:bg-white/90 border border-white/80 text-slate-700'
                  }`}
                  style={!isDark ? { boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.9), 0 2px 8px rgba(0,0,0,0.04)' } : undefined}
                >
                  Později
                </button>
                <button
                  onClick={() => {
                    onConfirm({
                      committedRuleIds: Array.from(committedRules),
                      affirmation: brief.affirmation,
                      focus: brief.focus,
                    });
                  }}
                  className="relative flex-1 py-3 rounded-2xl text-[11px] font-black uppercase tracking-widest text-white transition-all hover:scale-[1.02] active:scale-95 overflow-hidden group"
                  style={{
                    background: 'linear-gradient(135deg, #fbbf24 0%, #f59e0b 50%, #d97706 100%)',
                    boxShadow: '0 8px 24px -4px rgba(245,158,11,0.5), 0 4px 12px -2px rgba(245,158,11,0.3), inset 0 1px 0 rgba(255,255,255,0.4), inset 0 -2px 4px rgba(0,0,0,0.15)',
                  }}
                >
                  {/* Inner glass highlight overlay */}
                  <span
                    className="absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none"
                    style={{ background: 'linear-gradient(135deg, rgba(255,255,255,0.25) 0%, transparent 60%)' }}
                  />
                  {/* Top shine line — classic glass effect */}
                  <span
                    className="absolute top-0 left-4 right-4 h-px pointer-events-none"
                    style={{ background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.7), transparent)' }}
                  />
                  <span className="relative drop-shadow-[0_1px_2px_rgba(0,0,0,0.2)]">Připraven k tradingu →</span>
                </button>
              </div>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};

// ─── Helper ─────────────────────────────────────────────────────────────────

const Section: React.FC<{
  icon: any;
  title: string;
  color: 'slate' | 'rose' | 'blue' | 'emerald';
  isDark: boolean;
  children: React.ReactNode;
}> = ({ icon: Icon, title, color, isDark, children }) => {
  const colorMap = {
    slate: { bg: 'bg-slate-500/10', text: 'text-slate-500', border: 'border-slate-500/20' },
    rose:  { bg: 'bg-rose-500/10',  text: 'text-rose-500',  border: 'border-rose-500/30' },
    blue:  { bg: 'bg-blue-500/10',  text: 'text-blue-500',  border: 'border-blue-500/20' },
    emerald:{bg: 'bg-emerald-500/10',text: 'text-emerald-500',border:'border-emerald-500/20' },
  }[color];
  return (
    <div className={`p-4 rounded-2xl border ${isDark ? 'bg-white/5 border-white/10' : 'bg-slate-50 border-slate-200'}`}>
      <div className="flex items-center gap-2 mb-2.5">
        <div className={`p-1.5 rounded-lg ${colorMap.bg} ${colorMap.border} border`}>
          <Icon size={12} className={colorMap.text} />
        </div>
        <p className={`text-[9px] font-black uppercase tracking-[0.25em] ${colorMap.text}`}>{title}</p>
      </div>
      {children}
    </div>
  );
};

export default DailyStartModal;
