// Tactical Timeline V2 — nový layout Deníku s:
//   - Ranní aktivace (compact: rituály + commitments + heslo dne)
//   - Session karty collapsed/expanded s visual strip (analýza → trades → breakdown)
//   - Quick Notes (FAB + zobrazení v auditu)
//   - Compressed Večerní audit
//
// Fáze 1 (současný stav): READ-ONLY view + delegace editace na V1 modaly přes
// onEditPrep / onEditReview. Žádná schema změna, plně reverzibilní (přepínáno
// featureFlag `denik_v2`).
//
// Fáze 2 (budoucnost): inline edit přímo v Session kartách.

import React, { useState, useMemo, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Sun, Moon, ChevronDown, MessageSquare, Sparkles, CheckCircle2, Image as ImageIcon,
  Plus, Trash2, AlertTriangle, Maximize2,
} from 'lucide-react';
import { DailyPrep, DailyReview, Trade, SessionConfig, SessionBreakdown, IronRule, QuickNote, SessionAnalysis } from '../types';
import { storageService } from '../services/storageService';
import { thumbSmall, thumbLarge, fullSize } from '../services/imageUrlService';
import ImageZoomModal from './ImageZoomModal';
import { getActiveCommitments } from '../services/coachMemoryService';
import VoiceMemoButton from './VoiceMemoButton';

interface Props {
  date: string;
  prep?: DailyPrep;
  review?: DailyReview;
  trades: Trade[];
  theme: 'dark' | 'light' | 'oled';
  sessions?: SessionConfig[];
  sessionBreakdowns?: SessionBreakdown[];
  rituals?: IronRule[];
  onEditPrep: () => void;
  onEditReview: () => void;
  onDeletePrep?: (date: string) => void;
  onDeleteReview?: (date: string) => void;
  /** Uloží/aktualizuje quick notes v daily_reviews.quickNotes[]. */
  onAddQuickNote?: (note: QuickNote) => void;
  onDeleteQuickNote?: (noteId: string) => void;
  /** Inline edit — aktualizuje prep.scenarios.sessions[] pro daný session. */
  onUpdatePrepSession?: (sessionId: string, sessionLabel: string, updates: Partial<SessionAnalysis>) => void;
  /** Inline edit — aktualizuje review.sessionBreakdowns[] (notes + screenshot). */
  onUpdateBreakdown?: (sessionId: string, sessionLabel: string, notes: string, screenshot?: string) => void;
  /** Inline edit Ranní aktivace — toggle rituálu (Pass/Fail), update afirmace + cíle. */
  onUpdatePrep?: (updates: Partial<DailyPrep>) => void;
  /** Inline edit Večerní audit — takeaway, tomorrow plan, mistakes. */
  onUpdateReview?: (updates: Partial<DailyReview>) => void;
  /** User mistakes katalog (z Settings) — pro chip toggle ve Večerním auditu. */
  userMistakes?: string[];
}

const TacticalTimelineV2: React.FC<Props> = ({
  date, prep, review, trades, theme,
  sessions = [], sessionBreakdowns = [],
  rituals = [],
  onEditPrep, onEditReview, onDeletePrep, onDeleteReview,
  onAddQuickNote, onDeleteQuickNote,
  onUpdatePrepSession, onUpdateBreakdown,
  onUpdatePrep, onUpdateReview, userMistakes = [],
}) => {
  const isDark = theme !== 'light';

  // Stav: která session je expanded (default: žádná)
  const [expandedSession, setExpandedSession] = useState<string | null>(null);
  const [morningExpanded, setMorningExpanded] = useState(false);
  const [auditExpanded, setAuditExpanded] = useState(false);
  const [zoomImg, setZoomImg] = useState<string | null>(null);
  const [quickNoteOpen, setQuickNoteOpen] = useState(false);
  const [quickNoteText, setQuickNoteText] = useState('');

  // Načti aktivní commitments
  const [commitments, setCommitments] = useState<Array<{ content: string; metadata?: any }>>([]);
  useEffect(() => {
    getActiveCommitments().then(cs => setCommitments(cs as any)).catch(() => {});
  }, [date]);

  // Quick notes z review.quickNotes[] (top-level field — DB ukládá review jako JSONB)
  const quickNotes: QuickNote[] = useMemo(() => {
    return (review?.quickNotes as QuickNote[]) || [];
  }, [review]);

  // Rituals completed
  const completedRituals = useMemo(() => {
    const completions = (prep as any)?.ritualCompletions || [];
    return rituals.filter(r => completions.find((c: any) => c.ruleId === r.id && c.status === 'Pass')).length;
  }, [prep, rituals]);

  // Group trades by session
  const sessionData = useMemo(() => {
    return sessions.map(session => {
      const [startH, startM] = session.startTime.split(':').map(Number);
      const [endH, endM] = session.endTime.split(':').map(Number);
      const startMin = startH * 60 + startM;
      const endMin = endH * 60 + endM;
      const sessionTrades = trades.filter(t => {
        if (!t.timestamp || t.executionStatus === 'Missed') return false;
        const d = new Date(t.timestamp);
        const tm = d.getHours() * 60 + d.getMinutes();
        return endMin <= startMin ? (tm >= startMin || tm < endMin) : (tm >= startMin && tm < endMin);
      }).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
      const breakdown = sessionBreakdowns.find(b => b.sessionId === session.id);
      const prepSession = (prep as any)?.scenarios?.sessions?.find((s: any) => s.id === session.id);
      const pnl = sessionTrades.reduce((s, t) => s + (t.pnl || 0), 0);
      return { session, trades: sessionTrades, breakdown, prepSession, pnl };
    });
  }, [sessions, trades, sessionBreakdowns, prep]);

  // Auto-expand: pokud současný čas je v session range nebo je nejbližší
  useEffect(() => {
    const now = new Date();
    const today = now.toLocaleDateString('en-CA');
    if (date !== today) return; // jen pro dnešek
    const currentMin = now.getHours() * 60 + now.getMinutes();
    let activeSession: string | null = null;
    for (const { session } of sessionData) {
      const [startH, startM] = session.startTime.split(':').map(Number);
      const [endH, endM] = session.endTime.split(':').map(Number);
      const startMin = startH * 60 + startM;
      const endMin = endH * 60 + endM;
      if (currentMin >= startMin && currentMin < endMin) {
        activeSession = session.id;
        break;
      }
    }
    if (activeSession && expandedSession === null) {
      setExpandedSession(activeSession);
    }
  }, [date, sessionData, expandedSession]);

  const handleSaveQuickNote = () => {
    const txt = quickNoteText.trim();
    if (!txt || !onAddQuickNote) return;
    onAddQuickNote({
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      text: txt,
    });
    setQuickNoteText('');
    setQuickNoteOpen(false);
  };

  const formatTimeFromTimestamp = (ts: number) =>
    new Date(ts).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });

  const cardBase = isDark
    ? 'bg-[var(--bg-card)] border-[var(--border-subtle)]'
    : 'bg-white border-slate-200 shadow-sm';

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="relative py-4 px-2 lg:py-6 lg:px-4 space-y-3 pb-32">
      {/* Vertical line */}
      <div className="absolute left-10 top-0 bottom-32 w-px bg-slate-200" />

      {/* ========== 08:00 RANNÍ AKTIVACE ========== */}
      <TimelineNode time="08:00" color="amber">
        {!morningExpanded ? (
          <CollapsedCard
            isDark={isDark}
            borderColor="amber"
            onClick={() => setMorningExpanded(true)}
            icon={<Sun size={16} className="text-amber-500" />}
            iconBg="bg-amber-500/10 border-amber-500/30"
            title="Ranní aktivace"
            subtitle={
              prep
                ? `Rituály ${completedRituals}/${rituals.length} · ${commitments.length} závazků aktivních`
                : 'Nevyplněno — odškrtni rituály'
            }
            status={prep ? 'done' : 'pending'}
          />
        ) : (
          <ExpandedMorningCard
            isDark={isDark}
            prep={prep}
            rituals={rituals}
            completedRituals={completedRituals}
            commitments={commitments}
            onEdit={onEditPrep}
            onDelete={prep && onDeletePrep ? () => onDeletePrep(date) : undefined}
            onCollapse={() => setMorningExpanded(false)}
            onUpdatePrep={onUpdatePrep}
            date={date}
          />
        )}
      </TimelineNode>

      {/* ========== SESSIONS ========== */}
      {sessionData.map(({ session, trades: sTrades, breakdown, prepSession, pnl }) => {
        const expanded = expandedSession === session.id;
        const hasData = !!(prepSession?.image || prepSession?.plan || sTrades.length > 0 || breakdown?.notes || breakdown?.screenshot);
        const color = session.color || (session.name.toLowerCase().includes('london') ? 'blue' : 'orange');

        return (
          <TimelineNode key={session.id} time={session.startTime} color={color}>
            {!expanded ? (
              <CollapsedSessionCard
                isDark={isDark}
                session={session}
                color={color}
                trades={sTrades}
                pnl={pnl}
                prepSession={prepSession}
                breakdown={breakdown}
                hasData={hasData}
                onClick={() => setExpandedSession(session.id)}
                onZoom={(src) => setZoomImg(src)}
              />
            ) : (
              <ExpandedSessionCard
                isDark={isDark}
                session={session}
                color={color}
                trades={sTrades}
                pnl={pnl}
                prepSession={prepSession}
                breakdown={breakdown}
                onCollapse={() => setExpandedSession(null)}
                onZoom={(src) => setZoomImg(src)}
                onUpdatePrepSession={onUpdatePrepSession}
                onUpdateBreakdown={onUpdateBreakdown}
                onFallbackEditPrep={onEditPrep}
                onFallbackEditReview={onEditReview}
              />
            )}
          </TimelineNode>
        );
      })}

      {/* ========== 18:00 VEČERNÍ AUDIT ========== */}
      <TimelineNode time="18:00" color="indigo">
        {!auditExpanded ? (
          <CollapsedCard
            isDark={isDark}
            borderColor="indigo"
            onClick={() => setAuditExpanded(true)}
            icon={<Moon size={16} className="text-indigo-500" />}
            iconBg="bg-indigo-500/10 border-indigo-500/30"
            title="Večerní audit"
            subtitle={
              review?.psycho?.notes
                ? `Reflexe vyplněná · ${quickNotes.length} myšlenek`
                : quickNotes.length > 0
                  ? `Vyplň po sessions · ${quickNotes.length} myšlenek čeká`
                  : 'Vyplň po obou sessions'
            }
            status={review?.psycho?.notes ? 'done' : 'pending'}
          />
        ) : (
          <ExpandedAuditCard
            isDark={isDark}
            review={review}
            trades={trades}
            quickNotes={quickNotes}
            onEdit={onEditReview}
            onDelete={review && onDeleteReview ? () => onDeleteReview(date) : undefined}
            onCollapse={() => setAuditExpanded(false)}
            onDeleteNote={onDeleteQuickNote}
            onUpdateReview={onUpdateReview}
            userMistakes={userMistakes}
            date={date}
          />
        )}
      </TimelineNode>

      {/* ========== FLOATING QUICK NOTE FAB ========== */}
      <div className="fixed bottom-24 right-4 lg:bottom-8 lg:right-8 z-40">
        <AnimatePresence>
          {quickNoteOpen && (
            <motion.div
              initial={{ opacity: 0, y: 10, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 10, scale: 0.95 }}
              transition={{ type: 'spring', stiffness: 380, damping: 28 }}
              className="absolute bottom-16 right-0 w-80 p-5 rounded-3xl backdrop-blur-2xl border overflow-hidden"
              style={{
                background: isDark
                  ? 'linear-gradient(135deg, rgba(139, 92, 246, 0.15) 0%, rgba(30, 27, 75, 0.85) 100%)'
                  : 'linear-gradient(135deg, rgba(255,255,255,0.85) 0%, rgba(243, 232, 255, 0.75) 100%)',
                borderColor: isDark ? 'rgba(196, 181, 253, 0.25)' : 'rgba(196, 181, 253, 0.5)',
                boxShadow: isDark
                  ? '0 20px 50px -10px rgba(124, 58, 237, 0.4), inset 0 1px 0 rgba(255,255,255,0.1)'
                  : '0 20px 50px -10px rgba(124, 58, 237, 0.25), inset 0 1px 0 rgba(255,255,255,0.95)',
              }}
            >
              {/* Glass shine line top */}
              <div
                className="absolute top-0 left-6 right-6 h-px pointer-events-none"
                style={{ background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.7), transparent)' }}
              />

              <div className="flex items-center justify-between mb-3 relative">
                <p className={`text-[10px] font-black uppercase tracking-widest ${isDark ? 'text-violet-300' : 'text-violet-700'}`}>💭 Rychlá myšlenka</p>
                <button onClick={() => setQuickNoteOpen(false)} className={`text-lg leading-none ${isDark ? 'text-slate-400 hover:text-white' : 'text-slate-400 hover:text-slate-700'}`}>×</button>
              </div>

              <div className="relative">
                <textarea
                  value={quickNoteText}
                  onChange={(e) => setQuickNoteText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleSaveQuickNote();
                    }
                    if (e.key === 'Escape') setQuickNoteOpen(false);
                  }}
                  placeholder="Co tě právě napadlo? Enter = uložit · Shift+Enter = nový řádek · 🎙 diktuj"
                  autoFocus
                  rows={4}
                  className={`w-full p-3 pr-12 rounded-2xl backdrop-blur-sm text-xs resize-none outline-none transition-all border ${
                    isDark
                      ? 'bg-white/5 border-white/10 text-slate-200 placeholder:text-slate-500 focus:bg-white/10 focus:border-violet-400/50'
                      : 'bg-white/60 border-white/80 text-slate-700 placeholder:text-slate-400 focus:bg-white/90 focus:border-violet-400/50'
                  }`}
                  style={{ boxShadow: isDark ? 'inset 0 1px 0 rgba(255,255,255,0.05)' : 'inset 0 1px 0 rgba(255,255,255,0.9)' }}
                />
                {/* Voice memo button — překrytý vpravo dole v textarea */}
                <div className="absolute bottom-2 right-2">
                  <VoiceMemoButton
                    size="sm"
                    title="Diktuj myšlenku"
                    onTranscribed={(t) => {
                      const sep = quickNoteText.trim().length > 0 ? '\n\n' : '';
                      setQuickNoteText(quickNoteText + sep + t);
                    }}
                  />
                </div>
              </div>

              <div className="flex gap-2 mt-3 relative">
                <button
                  onClick={() => setQuickNoteOpen(false)}
                  className={`flex-1 py-2.5 rounded-2xl text-[10px] font-black uppercase tracking-widest backdrop-blur-sm transition-all ${
                    isDark ? 'bg-white/5 hover:bg-white/10 text-slate-300 border border-white/10' : 'bg-white/60 hover:bg-white/80 text-slate-600 border border-white/80'
                  }`}
                  style={!isDark ? { boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.9)' } : undefined}
                >
                  Zrušit
                </button>
                <button
                  onClick={handleSaveQuickNote}
                  disabled={!quickNoteText.trim()}
                  className="flex-[2] py-2.5 rounded-2xl text-[10px] font-black uppercase tracking-widest text-white disabled:opacity-40 disabled:cursor-not-allowed transition-all hover:brightness-110 active:scale-95 relative overflow-hidden"
                  style={{
                    background: 'linear-gradient(135deg, #a78bfa 0%, #8b5cf6 50%, #7c3aed 100%)',
                    boxShadow: '0 6px 20px -4px rgba(124,58,237,0.5), inset 0 1px 0 rgba(255,255,255,0.4), inset 0 -2px 4px rgba(0,0,0,0.15)',
                  }}
                >
                  {/* Top shine */}
                  <span
                    className="absolute top-0 left-3 right-3 h-px pointer-events-none"
                    style={{ background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.7), transparent)' }}
                  />
                  <span className="relative drop-shadow-[0_1px_2px_rgba(0,0,0,0.2)]">Uložit s timestampem</span>
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Glass FAB tlačítko — průhledná bublina s violet okrajem */}
        <motion.button
          whileTap={{ scale: 0.92 }}
          whileHover={{ scale: 1.05 }}
          onClick={() => setQuickNoteOpen(v => !v)}
          className="relative w-14 h-14 rounded-full backdrop-blur-xl grid place-items-center overflow-hidden transition-all"
          title="Rychlá poznámka (cokoli tě napadne)"
          style={{
            background: isDark
              ? 'rgba(255,255,255,0.04)'
              : 'rgba(255,255,255,0.25)',
            border: `1.5px solid ${isDark ? 'rgba(196, 181, 253, 0.55)' : 'rgba(124, 58, 237, 0.4)'}`,
            boxShadow: isDark
              ? '0 8px 24px -4px rgba(124,58,237,0.25), inset 0 1px 0 rgba(255,255,255,0.08)'
              : '0 8px 24px -4px rgba(124,58,237,0.2), inset 0 1px 0 rgba(255,255,255,0.6)',
          }}
        >
          {/* Top glass shine */}
          <span
            className="absolute top-1 left-3 right-3 h-px pointer-events-none"
            style={{ background: `linear-gradient(90deg, transparent, ${isDark ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.9)'}, transparent)` }}
          />
          {/* Inner diagonal highlight */}
          <span
            className="absolute inset-0 rounded-full pointer-events-none"
            style={{ background: `linear-gradient(135deg, ${isDark ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.35)'} 0%, transparent 50%)` }}
          />
          <span className="relative text-2xl">💭</span>
        </motion.button>
      </div>

      {zoomImg && (
        <ImageZoomModal images={[zoomImg]} initialIndex={0} onClose={() => setZoomImg(null)} />
      )}
    </div>
  );
};

// ─── Atomické komponenty ───────────────────────────────────────────────────

const TimelineNode: React.FC<{ time: string; color: string; children: React.ReactNode }> = ({ time, color, children }) => {
  const dotColors: Record<string, string> = {
    amber: 'bg-amber-500', blue: 'bg-blue-500', orange: 'bg-orange-500', indigo: 'bg-indigo-500',
    violet: 'bg-violet-500', emerald: 'bg-emerald-500',
  };
  return (
    <div className="relative flex items-center pl-16">
      <div className={`absolute left-10 -translate-x-1/2 w-3 h-3 rounded-full border-2 border-black/50 ${dotColors[color] || 'bg-slate-400'}`}>
        <div className="absolute -top-6 text-[9px] font-black uppercase text-slate-500 tracking-widest whitespace-nowrap">{time}</div>
      </div>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
};

const CollapsedCard: React.FC<{
  isDark: boolean;
  borderColor: string;
  onClick: () => void;
  icon: React.ReactNode;
  iconBg: string;
  title: string;
  subtitle: string;
  status: 'done' | 'pending' | 'live';
}> = ({ isDark, borderColor, onClick, icon, iconBg, title, subtitle, status }) => {
  const borderClass = isDark
    ? `border-${borderColor}-500/20 bg-${borderColor}-500/5`
    : `border-${borderColor}-200 bg-${borderColor}-50/30`;
  const statusBadge = status === 'done'
    ? <span className="px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 text-[9px] font-black uppercase">✓ Hotovo</span>
    : status === 'live'
      ? <span className="px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 text-[9px] font-black uppercase animate-pulse">● Live</span>
      : <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 text-[9px] font-black uppercase">Čeká</span>;
  return (
    <button
      onClick={onClick}
      className={`w-full p-4 rounded-2xl border transition-all hover:scale-[1.005] active:scale-[0.995] text-left ${borderClass} ${isDark ? '' : 'hover:bg-white'}`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <div className={`w-9 h-9 rounded-xl border grid place-items-center shrink-0 ${iconBg}`}>{icon}</div>
          <div className="min-w-0 flex-1">
            <h3 className="text-xs font-black uppercase tracking-widest truncate">{title}</h3>
            <p className="text-[10px] text-slate-500 truncate">{subtitle}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {statusBadge}
          <ChevronDown size={14} className="text-slate-400" />
        </div>
      </div>
    </button>
  );
};

const CollapsedSessionCard: React.FC<{
  isDark: boolean;
  session: SessionConfig;
  color: string;
  trades: Trade[];
  pnl: number;
  prepSession: any;
  breakdown?: SessionBreakdown;
  hasData: boolean;
  onClick: () => void;
  onZoom: (src: string) => void;
}> = ({ isDark, session, color, trades, pnl, prepSession, breakdown, hasData, onClick, onZoom }) => {
  const status: 'done' | 'pending' | 'live' = hasData ? (breakdown?.notes || breakdown?.screenshot ? 'done' : 'live') : 'pending';
  const pnlClass = pnl > 0 ? 'text-emerald-600' : pnl < 0 ? 'text-rose-600' : 'text-slate-500';
  const sessionColor = session.color || (color === 'blue' ? '#3b82f6' : '#f97316');

  return (
    <div className={`rounded-2xl border overflow-hidden cursor-pointer transition-all hover:shadow-md ${
      isDark ? `border-${color}-500/20 bg-[var(--bg-card)]` : `border-${color}-200 bg-${color}-50/30 hover:bg-${color}-50/50`
    }`} onClick={onClick}>
      {/* Header — compact: malé logo + name + čas inline */}
      <div className="flex items-center justify-between p-3 pb-2.5">
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          <div className="w-6 h-6 rounded-lg border grid place-items-center shrink-0 text-white font-black text-[10px]" style={{ backgroundColor: sessionColor, borderColor: sessionColor }}>
            {session.name[0]}
          </div>
          <h3 className="text-xs font-black uppercase tracking-widest truncate flex items-center gap-1.5">
            <span>{session.name}</span>
            <span className="font-normal text-slate-400 normal-case tracking-normal text-[10px]">{session.startTime}–{session.endTime}</span>
            {trades.length > 0 && (
              <span className="font-normal text-slate-500 normal-case tracking-normal text-[10px]">
                · {trades.length} · <span className={`font-mono font-black ${pnlClass}`}>{pnl >= 0 ? '+' : ''}${pnl.toFixed(0)}</span>
              </span>
            )}
          </h3>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {status === 'done' && <span className="px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 text-[9px] font-black uppercase">✓</span>}
          {status === 'live' && <span className="px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 text-[9px] font-black uppercase animate-pulse">● Live</span>}
          {status === 'pending' && <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 text-[9px] font-black uppercase">Čeká</span>}
          <ChevronDown size={14} className="text-slate-400" />
        </div>
      </div>

      {/* Visual strip: analýza → trades → breakdown */}
      {hasData ? (
        <div className="flex gap-2 px-4 pb-4 items-stretch overflow-x-auto">
          {/* Analýza screen */}
          <div className="shrink-0 flex flex-col gap-1">
            <p className="text-[8px] font-black uppercase text-slate-400 tracking-widest text-center">Analýza</p>
            {prepSession?.image ? (
              <div
                className="w-28 h-20 rounded-lg overflow-hidden border border-slate-200 cursor-zoom-in"
                onClick={(e) => { e.stopPropagation(); onZoom(fullSize(prepSession.image)); }}
              >
                <img src={thumbSmall(prepSession.image)} className="w-full h-full object-cover" loading="lazy" alt="Analýza" />
              </div>
            ) : (
              <div className="w-28 h-20 rounded-lg border-2 border-dashed border-slate-300 grid place-items-center text-slate-400">
                <ImageIcon size={20} />
              </div>
            )}
          </div>

          {/* Arrow */}
          <div className="flex flex-col justify-center items-center px-1 shrink-0 text-slate-300">→</div>

          {/* Trades — mini screens with PnL overlay */}
          <div className="flex-1 min-w-0 flex gap-1.5 items-stretch overflow-x-auto">
            {trades.length === 0 ? (
              <div className="flex-1 grid place-items-center text-[10px] text-slate-400 italic">žádné trades</div>
            ) : (
              trades.map(t => {
                const time = t.timestamp ? new Date(t.timestamp).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' }) : '';
                const isWin = (t.pnl || 0) > 0;
                const screen = t.screenshot || (t.screenshots && t.screenshots[0]);
                return (
                  <div key={t.id} className="shrink-0 flex flex-col gap-1">
                    <p className="text-[8px] font-black uppercase text-slate-400 tracking-widest text-center font-mono">{time}</p>
                    <div
                      className={`relative w-24 h-16 rounded-lg overflow-hidden border ${isWin ? 'border-emerald-200' : 'border-rose-200'} ${screen ? 'cursor-zoom-in' : ''} bg-gradient-to-br from-slate-100 to-slate-200`}
                      onClick={(e) => { if (screen) { e.stopPropagation(); onZoom(fullSize(screen)); } }}
                    >
                      {screen ? (
                        <img src={thumbSmall(screen)} className="w-full h-full object-cover" loading="lazy" alt={`Trade ${time}`} />
                      ) : (
                        <div className="absolute inset-0 grid place-items-center text-slate-400 text-[8px]">📈</div>
                      )}
                      <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/70 to-transparent p-1">
                        <p className="text-[10px] font-black font-mono text-white text-right leading-none">{(t.pnl || 0) >= 0 ? '+' : ''}${(t.pnl || 0).toFixed(0)}</p>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Arrow */}
          <div className="flex flex-col justify-center items-center px-1 shrink-0 text-slate-300">→</div>

          {/* Breakdown screen */}
          <div className="shrink-0 flex flex-col gap-1">
            <p className="text-[8px] font-black uppercase text-slate-400 tracking-widest text-center">Breakdown</p>
            {breakdown?.screenshot ? (
              <div
                className="w-28 h-20 rounded-lg overflow-hidden border border-violet-200 cursor-zoom-in"
                onClick={(e) => { e.stopPropagation(); onZoom(fullSize(breakdown.screenshot!)); }}
              >
                <img src={thumbSmall(breakdown.screenshot)} className="w-full h-full object-cover" loading="lazy" alt="Breakdown" />
              </div>
            ) : (
              <div className="w-28 h-20 rounded-lg border-2 border-dashed border-slate-300 grid place-items-center text-slate-400">
                <ImageIcon size={20} />
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="px-4 pb-4 text-center py-6 border-2 border-dashed border-slate-300 rounded-2xl mx-4 mb-4">
          <p className="text-xs text-slate-500 mb-2">{session.name} — připrav plán než začne</p>
          <p className="text-[10px] text-slate-400">Klikni pro otevření</p>
        </div>
      )}
    </div>
  );
};

const ExpandedMorningCard: React.FC<{
  isDark: boolean;
  prep?: DailyPrep;
  rituals: IronRule[];
  completedRituals: number;
  commitments: Array<{ content: string; metadata?: any }>;
  onEdit: () => void;
  onDelete?: () => void;
  onCollapse: () => void;
  onUpdatePrep?: (updates: Partial<DailyPrep>) => void;
  date: string;
}> = ({ isDark, prep, rituals, commitments, onDelete, onCollapse, onUpdatePrep, date }) => {
  const cardClass = isDark
    ? 'bg-gradient-to-br from-amber-500/10 to-transparent border-amber-500/30'
    : 'bg-gradient-to-br from-amber-50 to-white border-amber-200 shadow-sm';

  // Optimistický local state — instant UI reakce, async propagace do parenta.
  // Bez tohoto by každý klik na ritual čekal na parent re-render (lag).
  const [localCompletions, setLocalCompletions] = useState<any[]>((prep?.ritualCompletions || []) as any[]);
  useEffect(() => {
    setLocalCompletions((prep?.ritualCompletions || []) as any[]);
  }, [prep?.ritualCompletions]);

  const toggleRitual = (ruleId: string) => {
    const ei = localCompletions.findIndex(c => c.ruleId === ruleId);
    const current = ei >= 0 ? localCompletions[ei].status : 'Pending';
    const next = current === 'Pass' ? 'Pending' : 'Pass';
    const merged = ei >= 0
      ? localCompletions.map((c, i) => i === ei ? { ...c, status: next } : c)
      : [...localCompletions, { ruleId, status: next }];
    setLocalCompletions(merged); // instant UI
    if (onUpdatePrep) onUpdatePrep({ ritualCompletions: merged }); // async propagate
  };

  const focus = (prep as any)?.dailyFocus || '';
  const affirmation = (prep as any)?.mindsetState || '';
  const completedRituals = rituals.filter(r => localCompletions.find(c => c.ruleId === r.id && c.status === 'Pass')).length;

  return (
    <div className={`p-5 rounded-3xl border ${cardClass}`}>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-amber-500/10 border border-amber-500/30 grid place-items-center"><Sun size={16} className="text-amber-500" /></div>
          <div>
            <h3 className="text-sm font-black uppercase tracking-widest">Ranní aktivace</h3>
            <p className="text-[10px] text-slate-500">{completedRituals}/{rituals.length} rituálů · {commitments.length} závazků</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {onDelete && (
            <button onClick={onDelete} className="p-1.5 rounded-lg hover:bg-rose-500/10 text-slate-400 hover:text-rose-500" title="Smazat"><Trash2 size={12} /></button>
          )}
          <button onClick={onCollapse} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400"><ChevronDown size={14} className="rotate-180" /></button>
        </div>
      </div>

      {/* RITUÁLY — checkboxy */}
      {rituals.length > 0 && (
        <div className="mb-3">
          <p className="text-[9px] font-black uppercase tracking-widest text-slate-500 mb-2">✓ Rituály</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {rituals.map(r => {
              const comp = localCompletions.find((c: any) => c.ruleId === r.id);
              const done = comp?.status === 'Pass';
              return (
                <button
                  key={r.id}
                  onClick={() => toggleRitual(r.id)}
                  disabled={!onUpdatePrep}
                  className={`flex items-center gap-2 p-2.5 rounded-xl border text-left transition-all active:scale-95 ${
                    done
                      ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-700'
                      : isDark ? 'bg-white/5 border-white/10 text-slate-400 hover:bg-white/10' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  <div className={`w-4 h-4 rounded border-2 grid place-items-center shrink-0 ${done ? 'bg-emerald-500 border-emerald-500' : 'border-slate-300'}`}>
                    {done && <CheckCircle2 size={10} className="text-white" />}
                  </div>
                  <span className="text-xs font-bold flex-1">{r.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* COMMITMENTS — read-only */}
      {commitments.length > 0 && (
        <div className="mb-3 p-3 rounded-xl bg-blue-50 border border-blue-100">
          <p className="text-[9px] font-black uppercase tracking-widest text-blue-600 mb-2">⚡ Aktivní závazky</p>
          <ul className="space-y-1">
            {commitments.slice(0, 4).map((c, i) => (
              <li key={i} className="text-[11px] text-slate-700">▸ {c.content}</li>
            ))}
          </ul>
        </div>
      )}

      {/* RANNÍ AFIRMACE — AI generated */}
      <MorningAffirmationBlock
        isDark={isDark}
        affirmation={affirmation}
        focus={focus}
        onUpdate={(text, newFocus) => {
          if (!onUpdatePrep) return;
          const updates: any = { mindsetState: text };
          if (newFocus !== undefined) updates.dailyFocus = newFocus;
          onUpdatePrep(updates);
        }}
        disabled={!onUpdatePrep}
      />
    </div>
  );
};

const QuickNoteRow: React.FC<{
  note: QuickNote;
  isDark: boolean;
  onDelete?: () => void;
  onUpdate?: (newText: string) => void;
}> = ({ note, isDark, onDelete, onUpdate }) => {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note.text);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const confirmTimerRef = useRef<number | null>(null);

  useEffect(() => { setText(note.text); }, [note.text]);
  useEffect(() => {
    // Auto-cancel confirm po 4 sec pokud user neklikl
    if (confirmDelete) {
      confirmTimerRef.current = window.setTimeout(() => setConfirmDelete(false), 4000);
      return () => { if (confirmTimerRef.current) window.clearTimeout(confirmTimerRef.current); };
    }
  }, [confirmDelete]);

  const commit = () => {
    if (onUpdate && text.trim() && text !== note.text) onUpdate(text.trim());
    setEditing(false);
  };

  const time = new Date(note.timestamp).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });

  return (
    <div className={`p-2.5 rounded-lg border ${isDark ? 'bg-white/5 border-violet-500/20' : 'bg-white border-violet-100'}`}>
      <div className="flex items-start gap-2">
        <span className="text-[10px] font-mono font-black text-violet-500 shrink-0 mt-0.5">{time}</span>
        {editing && onUpdate ? (
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            onBlur={commit}
            onKeyDown={e => {
              // Enter = uložit, Shift+Enter = nový řádek
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                commit();
              }
              if (e.key === 'Escape') { setText(note.text); setEditing(false); }
            }}
            autoFocus
            rows={2}
            placeholder="Enter = uložit · Shift+Enter = nový řádek · Esc = zrušit"
            className={`flex-1 p-1.5 rounded text-[11px] leading-relaxed resize-none outline-none border focus:ring-2 focus:ring-violet-500/20 ${
              isDark ? 'bg-violet-500/10 border-violet-500/30 text-slate-200' : 'bg-violet-50 border-violet-200 text-slate-700'
            }`}
          />
        ) : (
          <p
            onClick={() => onUpdate && setEditing(true)}
            className={`text-[11px] text-slate-700 leading-relaxed italic flex-1 ${onUpdate ? 'cursor-text hover:bg-violet-50/50 -mx-1 px-1 rounded' : ''}`}
            title={onUpdate ? 'Klikni pro úpravu' : undefined}
          >
            "{note.text}"
          </p>
        )}
        {onDelete && !editing && (
          <div className="shrink-0 flex items-center gap-1">
            {/* Trash ikona — klik = enter confirm mode */}
            <button
              onClick={() => setConfirmDelete(v => !v)}
              className={`p-1.5 rounded transition-all active:scale-90 ${
                confirmDelete
                  ? 'text-rose-500 bg-rose-50'
                  : 'text-slate-400 hover:text-rose-500 hover:bg-rose-50'
              }`}
              title={confirmDelete ? 'Klikni "Smazat" pro potvrzení' : 'Smazat myšlenku'}
            >
              <Trash2 size={12} />
            </button>
            {/* Inline confirm tlačítko — viditelné jen po prvním klik */}
            {confirmDelete && (
              <button
                onClick={onDelete}
                className="px-2 py-1 rounded bg-rose-500 hover:bg-rose-600 text-white text-[9px] font-black uppercase tracking-widest animate-in fade-in slide-in-from-left-2 duration-150"
              >
                Smazat
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

const MorningAffirmationBlock: React.FC<{
  isDark: boolean;
  affirmation: string;
  focus: string;
  onUpdate: (text: string, focus?: string) => void;
  disabled: boolean;
}> = ({ isDark, affirmation, focus, onUpdate, disabled }) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchAffirmation = async () => {
    setLoading(true);
    setError(null);
    try {
      const { supabase } = await import('../services/supabase');
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { setError('Nejsi přihlášený.'); return; }
      const baseUrl = (supabase as any).supabaseUrl || (import.meta as any).env?.VITE_SUPABASE_URL || '';
      const res = await fetch(`${baseUrl}/functions/v1/daily-start-brief`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        onUpdate(data.affirmation || '', data.focus);
      } else {
        setError('Coach selhal — zkus znovu.');
      }
    } catch {
      setError('Chyba spojení.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <div className="mb-3">
        <div className="flex items-center justify-between mb-1.5">
          <p className="text-[9px] font-black uppercase tracking-widest text-violet-600">✨ Ranní afirmace (AI)</p>
          {!disabled && (
            <button
              onClick={fetchAffirmation}
              disabled={loading}
              className={`px-2 py-0.5 rounded-md text-[9px] font-black uppercase tracking-widest transition-all ${
                loading
                  ? 'bg-slate-200 text-slate-400 cursor-wait'
                  : 'bg-violet-500 hover:bg-violet-600 text-white shadow-sm'
              }`}
            >
              {loading ? '⏳ Generuju...' : (affirmation ? '↻ Znovu' : '✨ Vygeneruj')}
            </button>
          )}
        </div>
        {affirmation ? (
          <textarea
            value={affirmation}
            onChange={e => onUpdate(e.target.value, focus)}
            rows={3}
            disabled={disabled}
            className={`w-full p-3 rounded-xl border text-xs leading-relaxed italic resize-none outline-none focus:ring-2 focus:ring-violet-500/20 transition-all ${
              isDark ? 'bg-violet-500/5 border-violet-500/20 text-slate-200' : 'bg-violet-50 border-violet-200 text-slate-700'
            }`}
          />
        ) : (
          <div className={`p-4 rounded-xl border-2 border-dashed text-center text-xs italic ${
            isDark ? 'border-violet-500/20 text-slate-500' : 'border-violet-200 text-violet-400'
          }`}>
            Klikni „✨ Vygeneruj" pro personalizovanou afirmaci od AI coache
          </div>
        )}
        {error && <p className="text-[10px] text-rose-500 mt-1">{error}</p>}
      </div>

      {/* CÍL DNE — auto-vyplněn AI, ale editovatelný */}
      <div>
        <p className="text-[9px] font-black uppercase tracking-widest text-amber-600 mb-1.5">🎯 Co dnes hlídat</p>
        <input
          type="text"
          value={focus}
          onChange={e => onUpdate(affirmation, e.target.value)}
          placeholder="Jedna věc na kterou se dnes zaměřím (nebo to AI vyplní s afirmací)..."
          disabled={disabled}
          className={`w-full px-3 py-2 rounded-xl border text-xs outline-none focus:ring-2 focus:ring-amber-500/20 transition-all ${
            isDark ? 'bg-amber-500/5 border-amber-500/20 text-slate-200 placeholder:text-slate-600' : 'bg-white border-amber-200 text-slate-700 placeholder:text-amber-400'
          }`}
        />
      </div>
    </>
  );
};

const ExpandedSessionCard: React.FC<{
  isDark: boolean;
  session: SessionConfig;
  color: string;
  trades: Trade[];
  pnl: number;
  prepSession: any;
  breakdown?: SessionBreakdown;
  onCollapse: () => void;
  onZoom: (src: string) => void;
  onUpdatePrepSession?: (sessionId: string, sessionLabel: string, updates: Partial<SessionAnalysis>) => void;
  onUpdateBreakdown?: (sessionId: string, sessionLabel: string, notes: string, screenshot?: string) => void;
  onFallbackEditPrep: () => void;
  onFallbackEditReview: () => void;
}> = ({ isDark, session, color, trades, pnl, prepSession, breakdown, onCollapse, onZoom, onUpdatePrepSession, onUpdateBreakdown, onFallbackEditPrep, onFallbackEditReview }) => {
  const sessionColor = session.color || (color === 'blue' ? '#3b82f6' : '#f97316');
  const pnlClass = pnl > 0 ? 'text-emerald-600' : pnl < 0 ? 'text-rose-600' : 'text-slate-500';
  const [editingKickoff, setEditingKickoff] = useState(false);
  const [editingDebrief, setEditingDebrief] = useState(false);

  return (
    <div className={`rounded-3xl border overflow-hidden ${isDark ? 'bg-[var(--bg-card)] border-white/10' : 'bg-white border-slate-200 shadow-sm'}`}>
      {/* Header — compact: malé logo + name + čas inline */}
      <div className="flex items-center justify-between p-3 border-b border-slate-100">
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          <div className="w-7 h-7 rounded-lg text-white font-black grid place-items-center text-[11px] shrink-0" style={{ backgroundColor: sessionColor }}>{session.name[0]}</div>
          <h3 className="text-xs font-black uppercase tracking-widest flex items-center gap-1.5 min-w-0 truncate">
            <span>{session.name}</span>
            <span className="font-normal text-slate-400 normal-case tracking-normal text-[10px]">{session.startTime}–{session.endTime}</span>
          </h3>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {trades.length > 0 && <span className={`text-xs font-black font-mono ${pnlClass} mr-1`}>{pnl >= 0 ? '+' : ''}${pnl.toFixed(0)}</span>}
          <button onClick={onCollapse} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400"><ChevronDown size={14} className="rotate-180" /></button>
        </div>
      </div>

      {/* ① KICK-OFF — analýza + plán */}
      <div className="p-5 border-b border-dashed border-slate-200">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: sessionColor }}></div>
            <p className="text-[10px] font-black uppercase tracking-widest" style={{ color: sessionColor }}>① Kick-off — Plán</p>
          </div>
          {(prepSession?.plan || prepSession?.image) && !editingKickoff && (
            <button onClick={() => setEditingKickoff(true)} className="text-[9px] font-black uppercase tracking-widest text-slate-500 hover:text-slate-700">Upravit</button>
          )}
        </div>

        {editingKickoff && onUpdatePrepSession ? (
          <KickoffEditor
            isDark={isDark}
            session={session}
            prepSession={prepSession}
            sessionColor={sessionColor}
            onSave={(updates) => {
              onUpdatePrepSession(session.id, session.name, updates);
              setEditingKickoff(false);
            }}
            onCancel={() => setEditingKickoff(false)}
          />
        ) : (prepSession?.image || prepSession?.plan) ? (
          <>
            {prepSession.bias && (
              <div className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full mb-3 text-[10px] font-black uppercase tracking-widest ${
                prepSession.bias === 'Bullish' ? 'bg-emerald-500/10 text-emerald-600' :
                prepSession.bias === 'Bearish' ? 'bg-rose-500/10 text-rose-600' :
                'bg-slate-500/10 text-slate-600'
              }`}>
                {prepSession.bias === 'Bullish' ? '🐂' : prepSession.bias === 'Bearish' ? '🐻' : '◐'} {prepSession.bias}
              </div>
            )}
            {prepSession.plan && (
              <div className={`p-3 rounded-xl mb-3 ${isDark ? 'bg-white/5' : 'bg-slate-50'}`}>
                <p className="text-xs text-slate-700 leading-relaxed whitespace-pre-wrap">{prepSession.plan}</p>
              </div>
            )}
            {prepSession.image && (
              <div className="aspect-video rounded-xl overflow-hidden border border-slate-200 cursor-zoom-in" onClick={() => onZoom(fullSize(prepSession.image))}>
                <img src={thumbLarge(prepSession.image)} className="w-full h-full object-cover" loading="lazy" alt="Analýza" />
              </div>
            )}
          </>
        ) : (
          <button
            onClick={() => onUpdatePrepSession ? setEditingKickoff(true) : onFallbackEditPrep()}
            className="w-full py-6 border-2 border-dashed border-slate-300 rounded-2xl text-xs text-slate-500 hover:bg-slate-50"
          >
            <span className="block text-2xl mb-2">📊</span>
            Naplánuj {session.name} →
          </button>
        )}
      </div>

      {/* ② LIVE — trades */}
      {trades.length > 0 && (
        <div className="p-5 border-b border-slate-100">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <div className="w-1.5 h-1.5 rounded-full bg-emerald-500"></div>
              <p className="text-[10px] font-black uppercase tracking-widest text-emerald-600">② Live — {trades.length} trade{trades.length !== 1 ? 's' : ''}</p>
            </div>
            <span className={`text-xs font-black font-mono ${pnlClass}`}>{pnl >= 0 ? '+' : ''}${pnl.toFixed(0)}</span>
          </div>
          <div className="space-y-2">
            {trades.map(t => {
              const time = t.timestamp ? new Date(t.timestamp).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' }) : '';
              const isWin = (t.pnl || 0) > 0;
              return (
                <div key={t.id} className={`flex items-center gap-3 p-2.5 rounded-lg ${isWin ? 'bg-emerald-50 border border-emerald-100' : 'bg-rose-50 border border-rose-100'}`}>
                  <span className={`text-[10px] font-mono ${isWin ? 'text-emerald-600' : 'text-rose-600'}`}>●</span>
                  <span className="text-[11px] font-mono text-slate-600">{time}</span>
                  <span className={`px-1.5 py-0.5 rounded text-[8px] font-black uppercase ${isWin ? 'bg-emerald-500/10 text-emerald-600' : 'bg-rose-500/10 text-rose-600'}`}>{t.direction}</span>
                  <span className="text-[10px] text-slate-500">{t.instrument}</span>
                  <span className={`ml-auto text-xs font-black font-mono ${isWin ? 'text-emerald-600' : 'text-rose-600'}`}>{(t.pnl || 0) >= 0 ? '+' : ''}${(t.pnl || 0).toFixed(0)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ③ DEBRIEF — reflexe */}
      <div className="p-5 bg-slate-50/30">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-violet-500"></div>
            <p className="text-[10px] font-black uppercase tracking-widest text-violet-600">③ Debrief — Reflexe</p>
          </div>
          {(breakdown?.notes || breakdown?.screenshot) && !editingDebrief && (
            <button onClick={() => setEditingDebrief(true)} className="text-[9px] font-black uppercase tracking-widest text-slate-500 hover:text-slate-700">Upravit</button>
          )}
        </div>

        {editingDebrief && onUpdateBreakdown ? (
          <DebriefEditor
            isDark={isDark}
            session={session}
            breakdown={breakdown}
            onSave={(notes, screenshot) => {
              onUpdateBreakdown(session.id, session.name, notes, screenshot);
              setEditingDebrief(false);
            }}
            onCancel={() => setEditingDebrief(false)}
          />
        ) : (breakdown?.notes || breakdown?.screenshot) ? (
          <>
            {breakdown.notes && (
              <div className={`p-3 rounded-xl mb-3 ${isDark ? 'bg-violet-500/10' : 'bg-violet-50'} border ${isDark ? 'border-violet-500/20' : 'border-violet-100'}`}>
                <p className="text-xs text-slate-700 leading-relaxed whitespace-pre-wrap">{breakdown.notes}</p>
              </div>
            )}
            {breakdown.screenshot && (
              <div className="aspect-video rounded-xl overflow-hidden border border-violet-200 cursor-zoom-in" onClick={() => onZoom(fullSize(breakdown.screenshot!))}>
                <img src={thumbLarge(breakdown.screenshot)} className="w-full h-full object-cover" loading="lazy" alt="Breakdown" />
              </div>
            )}
          </>
        ) : (
          <button
            onClick={() => onUpdateBreakdown ? setEditingDebrief(true) : onFallbackEditReview()}
            className="w-full py-6 border-2 border-dashed border-slate-300 rounded-2xl text-xs text-slate-500 hover:bg-slate-50"
          >
            {trades.length > 0 ? `${session.name} skončil. Jak to dopadlo vs. plán?` : `Žádné trades. Stojí to za poznámku?`}
            <span className="block text-[10px] mt-1 text-violet-500 font-black uppercase tracking-widest">Udělej debrief →</span>
          </button>
        )}
      </div>
    </div>
  );
};

// ─── Inline editory ───────────────────────────────────────────────────────

const KickoffEditor: React.FC<{
  isDark: boolean;
  session: SessionConfig;
  prepSession: any;
  sessionColor: string;
  onSave: (updates: Partial<SessionAnalysis>) => void;
  onCancel: () => void;
}> = ({ isDark, session, prepSession, sessionColor, onSave, onCancel }) => {
  const [bias, setBias] = useState<'Bullish' | 'Neutral' | 'Bearish'>(prepSession?.bias || 'Neutral');
  const [plan, setPlan] = useState(prepSession?.plan || '');
  const [image, setImage] = useState<string | undefined>(prepSession?.image);
  const [uploading, setUploading] = useState(false);

  const uploadFromFile = async (file: File, prefix: string) => {
    setUploading(true);
    try {
      const reader = new FileReader();
      const dataUrl = await new Promise<string>((resolve, reject) => {
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const url = await storageService.uploadScreenshot(dataUrl, prefix);
      setImage(url);
    } catch (err) {
      console.error('[KickoffEditor] upload failed:', err);
    } finally {
      setUploading(false);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) await uploadFromFile(file, `kickoff_${session.id}_${Date.now()}`);
  };

  // Ctrl+V / Cmd+V paste — zachytí obrázek ze schránky kdekoli v editoru
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items as any) {
        if (item.type?.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) {
            e.preventDefault();
            uploadFromFile(file, `kickoff_${session.id}_${Date.now()}`);
            break;
          }
        }
      }
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [session.id]);

  return (
    <div className={`p-4 rounded-2xl border ${isDark ? 'bg-white/5 border-white/10' : 'bg-slate-50 border-slate-200'}`}>
      {/* HTF Bias */}
      <p className={`text-[9px] font-black uppercase tracking-widest mb-2 ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>HTF Bias</p>
      <div className="flex gap-2 mb-4">
        {(['Bullish', 'Neutral', 'Bearish'] as const).map(b => (
          <button
            key={b}
            onClick={() => setBias(b)}
            className={`flex-1 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${
              bias === b
                ? b === 'Bullish' ? 'bg-emerald-500 text-white' : b === 'Bearish' ? 'bg-rose-500 text-white' : 'bg-slate-500 text-white'
                : isDark ? 'bg-white/5 text-slate-400 hover:bg-white/10' : 'bg-white text-slate-600 hover:bg-slate-100'
            }`}
          >
            {b === 'Bullish' ? '🐂 Bull' : b === 'Bearish' ? '🐻 Bear' : '◐ Neutral'}
          </button>
        ))}
      </div>

      {/* Plán */}
      <p className={`text-[9px] font-black uppercase tracking-widest mb-2 ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>Plán</p>
      <div className="relative mb-4">
        <textarea
          value={plan}
          onChange={e => setPlan(e.target.value)}
          placeholder="Kde čekám entry, kde SL, kde TP..."
          rows={4}
          className={`w-full p-3 pr-12 rounded-xl border text-xs resize-none outline-none focus:ring-2 transition-all ${
            isDark ? 'bg-[var(--bg-input)] border-white/10 text-slate-200 focus:ring-white/20' : 'bg-white border-slate-200 text-slate-700 focus:ring-slate-300'
          }`}
        />
        <div className="absolute bottom-2 right-2">
          <VoiceMemoButton
            size="sm"
            title="Diktuj plán"
            onTranscribed={(t) => {
              const sep = plan.trim().length > 0 ? '\n\n' : '';
              setPlan(plan + sep + t);
            }}
          />
        </div>
      </div>

      {/* Screenshot */}
      <p className={`text-[9px] font-black uppercase tracking-widest mb-2 ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>Screenshot analýzy</p>
      {image ? (
        <div className="relative mb-4">
          <div className="aspect-video rounded-xl overflow-hidden border border-slate-200">
            <img src={thumbLarge(image)} className="w-full h-full object-cover" alt="Analýza" />
          </div>
          <button
            onClick={() => setImage(undefined)}
            className="absolute top-2 right-2 px-2 py-1 rounded-lg bg-rose-500 text-white text-[9px] font-black uppercase tracking-widest"
          >
            Smazat
          </button>
        </div>
      ) : (
        <label className={`block aspect-video rounded-xl border-2 border-dashed cursor-pointer mb-4 grid place-items-center text-slate-400 hover:bg-slate-100/50 ${uploading ? 'opacity-50' : ''}`}>
          <input type="file" accept="image/*" className="hidden" onChange={handleFileChange} disabled={uploading} />
          <div className="text-center">
            <ImageIcon size={28} className="mx-auto mb-2" />
            <p className="text-[10px] font-black uppercase tracking-widest">{uploading ? 'Nahrávám...' : 'Klikni nebo Ctrl+V'}</p>
          </div>
        </label>
      )}

      {/* Akce */}
      <div className="flex gap-2">
        <button onClick={onCancel} className={`flex-1 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest ${
          isDark ? 'bg-white/5 hover:bg-white/10 text-slate-400' : 'bg-white hover:bg-slate-100 text-slate-600 border border-slate-200'
        }`}>Zrušit</button>
        <button
          onClick={() => onSave({ id: session.id, label: session.name, bias, plan, image, color: sessionColor })}
          className="flex-[2] py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest text-white"
          style={{ backgroundColor: sessionColor }}
        >
          Uložit plán
        </button>
      </div>
    </div>
  );
};

const DebriefEditor: React.FC<{
  isDark: boolean;
  session: SessionConfig;
  breakdown?: SessionBreakdown;
  onSave: (notes: string, screenshot?: string) => void;
  onCancel: () => void;
}> = ({ isDark, session, breakdown, onSave, onCancel }) => {
  const [notes, setNotes] = useState(breakdown?.notes || '');
  const [screenshot, setScreenshot] = useState<string | undefined>(breakdown?.screenshot);
  const [uploading, setUploading] = useState(false);

  const uploadFromFile = async (file: File, prefix: string) => {
    setUploading(true);
    try {
      const reader = new FileReader();
      const dataUrl = await new Promise<string>((resolve, reject) => {
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const url = await storageService.uploadScreenshot(dataUrl, prefix);
      setScreenshot(url);
    } catch (err) {
      console.error('[DebriefEditor] upload failed:', err);
    } finally {
      setUploading(false);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) await uploadFromFile(file, `debrief_${session.id}_${Date.now()}`);
  };

  // Ctrl+V / Cmd+V paste — zachytí obrázek ze schránky kdekoli v editoru
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items as any) {
        if (item.type?.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) {
            e.preventDefault();
            uploadFromFile(file, `debrief_${session.id}_${Date.now()}`);
            break;
          }
        }
      }
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [session.id]);

  return (
    <div className={`p-4 rounded-2xl border ${isDark ? 'bg-violet-500/5 border-violet-500/20' : 'bg-violet-50 border-violet-200'}`}>
      <p className={`text-[9px] font-black uppercase tracking-widest mb-2 ${isDark ? 'text-violet-400' : 'text-violet-700'}`}>Plán vs realita</p>
      <div className="relative mb-4">
        <textarea
          value={notes}
          onChange={e => setNotes(e.target.value)}
          placeholder={`Co se v ${session.name} stalo? Lessons, mistakes...`}
          rows={5}
          className={`w-full p-3 pr-12 rounded-xl border text-xs resize-none outline-none focus:ring-2 transition-all ${
            isDark ? 'bg-[var(--bg-input)] border-white/10 text-slate-200 focus:ring-violet-400/30' : 'bg-white border-violet-200 text-slate-700 focus:ring-violet-300'
          }`}
        />
        <div className="absolute bottom-2 right-2">
          <VoiceMemoButton
            size="sm"
            title="Diktuj reflexi"
            onTranscribed={(t) => {
              const sep = notes.trim().length > 0 ? '\n\n' : '';
              setNotes(notes + sep + t);
            }}
          />
        </div>
      </div>

      <p className={`text-[9px] font-black uppercase tracking-widest mb-2 ${isDark ? 'text-violet-400' : 'text-violet-700'}`}>Screenshot výsledku (nepovinné)</p>
      {screenshot ? (
        <div className="relative mb-4">
          <div className="aspect-video rounded-xl overflow-hidden border border-violet-200">
            <img src={thumbLarge(screenshot)} className="w-full h-full object-cover" alt="Breakdown" />
          </div>
          <button
            onClick={() => setScreenshot(undefined)}
            className="absolute top-2 right-2 px-2 py-1 rounded-lg bg-rose-500 text-white text-[9px] font-black uppercase tracking-widest"
          >
            Smazat
          </button>
        </div>
      ) : (
        <label className={`block aspect-video rounded-xl border-2 border-dashed cursor-pointer mb-4 grid place-items-center text-slate-400 hover:bg-violet-50 ${uploading ? 'opacity-50' : ''}`}>
          <input type="file" accept="image/*" className="hidden" onChange={handleFileChange} disabled={uploading} />
          <div className="text-center">
            <ImageIcon size={28} className="mx-auto mb-2" />
            <p className="text-[10px] font-black uppercase tracking-widest">{uploading ? 'Nahrávám...' : 'Klikni nebo Ctrl+V'}</p>
          </div>
        </label>
      )}

      <div className="flex gap-2">
        <button onClick={onCancel} className={`flex-1 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest ${
          isDark ? 'bg-white/5 hover:bg-white/10 text-slate-400' : 'bg-white hover:bg-slate-100 text-slate-600 border border-slate-200'
        }`}>Zrušit</button>
        <button
          onClick={() => onSave(notes, screenshot)}
          disabled={!notes.trim()}
          className="flex-[2] py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest text-white bg-violet-600 hover:bg-violet-700 disabled:opacity-40"
        >
          Uložit debrief
        </button>
      </div>
    </div>
  );
};

const ExpandedAuditCard: React.FC<{
  isDark: boolean;
  review?: DailyReview;
  trades: Trade[];
  quickNotes: QuickNote[];
  onEdit: () => void;
  onDelete?: () => void;
  onCollapse: () => void;
  onDeleteNote?: (id: string) => void;
  onUpdateReview?: (updates: Partial<DailyReview>) => void;
  userMistakes?: string[];
  date: string;
}> = ({ isDark, review, trades, quickNotes, onDelete, onCollapse, onDeleteNote, onUpdateReview, userMistakes = [] }) => {
  const realTrades = trades.filter(t => t.executionStatus !== 'Missed');
  const pnl = realTrades.reduce((s, t) => s + (t.pnl || 0), 0);
  const pnlClass = pnl > 0 ? 'text-emerald-600' : pnl < 0 ? 'text-rose-600' : 'text-slate-500';
  const cardClass = isDark
    ? 'bg-gradient-to-br from-indigo-500/10 to-transparent border-indigo-500/30'
    : 'bg-gradient-to-br from-indigo-50 to-white border-indigo-200 shadow-sm';

  const takeaway = (review?.psycho?.notes as string) || '';

  const updateTakeaway = (v: string) => {
    if (!onUpdateReview) return;
    onUpdateReview({ psycho: { ...(review?.psycho || {}), notes: v } as any });
  };

  return (
    <div className={`p-5 rounded-3xl border ${cardClass}`}>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-indigo-500/10 border border-indigo-500/30 grid place-items-center"><Moon size={16} className="text-indigo-500" /></div>
          <div>
            <h3 className="text-sm font-black uppercase tracking-widest">Večerní audit</h3>
            <p className="text-[10px] text-slate-500">Co si odnášíš · plán na zítra</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {onDelete && <button onClick={onDelete} className="p-1.5 rounded-lg hover:bg-rose-500/10 text-slate-400 hover:text-rose-500"><Trash2 size={12} /></button>}
          <button onClick={onCollapse} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400"><ChevronDown size={14} className="rotate-180" /></button>
        </div>
      </div>

      {/* Quick notes summary */}
      {quickNotes.length > 0 && (
        <div className="p-4 rounded-xl bg-violet-50 border border-violet-200 mb-4">
          <p className="text-[9px] font-black uppercase tracking-widest text-violet-600 mb-3">💭 Myšlenky z dnešku ({quickNotes.length})</p>
          <div className="space-y-2">
            {quickNotes.map(n => (
              <QuickNoteRow
                key={n.id}
                note={n}
                isDark={isDark}
                onDelete={onDeleteNote ? () => onDeleteNote(n.id) : undefined}
                onUpdate={onUpdateReview ? (newText) => {
                  const updated = quickNotes.map(qn => qn.id === n.id ? { ...qn, text: newText } : qn);
                  onUpdateReview({ quickNotes: updated });
                } : undefined}
              />
            ))}
          </div>
        </div>
      )}

      {/* Den P&L */}
      <div className={`p-3 rounded-xl border mb-4 ${isDark ? 'bg-white/5 border-white/10' : 'bg-white border-slate-200'}`}>
        <p className="text-[8px] font-black uppercase text-slate-400 tracking-widest mb-1">Den P&L</p>
        <p className={`text-lg font-black font-mono ${pnlClass}`}>{pnl >= 0 ? '+' : ''}${pnl.toFixed(0)}</p>
      </div>

      {/* CO SI ODNÁŠÍŠ */}
      <div className="mb-3">
        <p className="text-[9px] font-black uppercase tracking-widest text-slate-500 mb-1.5">📝 Co si odnášíš</p>
        <div className="relative">
          <textarea
            value={takeaway}
            onChange={e => updateTakeaway(e.target.value)}
            placeholder="Co dnes prošlo dobře? Co se zalomilo? Klíčový insight..."
            rows={4}
            disabled={!onUpdateReview}
            className={`w-full p-3 pr-12 rounded-xl border text-xs leading-relaxed resize-none outline-none focus:ring-2 focus:ring-indigo-500/20 transition-all ${
              isDark ? 'bg-white/5 border-white/10 text-slate-200 placeholder:text-slate-600' : 'bg-white border-slate-200 text-slate-700 placeholder:text-slate-400'
            }`}
          />
          <div className="absolute bottom-2 right-2">
            <VoiceMemoButton size="sm" title="Diktuj reflexi" onTranscribed={(t) => updateTakeaway(takeaway + (takeaway.trim() ? '\n\n' : '') + t)} />
          </div>
        </div>
      </div>

      {/* Chyby vyhozené — vyplňují se per-trade, ne per-day */}
    </div>
  );
};

export default TacticalTimelineV2;
