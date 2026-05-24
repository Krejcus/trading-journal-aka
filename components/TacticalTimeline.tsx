
import React, { useState, useMemo, useRef, useEffect } from 'react';
import { DailyPrep, DailyReview, Trade, SessionConfig, SessionBreakdown, IronRule, PsychoMetricConfig } from '../types';
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
  ShieldAlert,
  Star,
  X,
  Maximize2,
  Activity,
  AlertTriangle,
  FileText,
  BarChart3,
  AlertOctagon,
  Trash2,
  MessageSquare,
  ChevronDown,
  Plus,
  ImagePlus,
  Check,
  ClipboardCheck,
  Image as ImageIcon
} from 'lucide-react';
import ConfirmationModal from './ConfirmationModal';
import ImageZoomModal from './ImageZoomModal';
import { storageService } from '../services/storageService';
import VoiceMemoButton from './VoiceMemoButton';
import { thumbSmall, thumbMedium, fullSize } from '../services/imageUrlService';

interface WeekFocusGoal {
  text: string;
  emoji?: string;
}

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
  sessions?: SessionConfig[];
  sessionBreakdowns?: SessionBreakdown[];
  onUpdateBreakdown?: (sessionId: string, sessionLabel: string, notes: string, screenshot?: string) => void;
  // Inline editing props
  prepForm?: DailyPrep;
  reviewForm?: DailyReview;
  editPrepForm?: (updater: (prev: DailyPrep) => DailyPrep) => void;
  editReviewForm?: (updater: DailyReview | ((prev: DailyReview) => DailyReview)) => void;
  onSavePrep?: (prep: DailyPrep) => void;
  onSaveReview?: (review: DailyReview) => void;
  rituals?: IronRule[];
  tradeRules?: IronRule[];
  psychoMetrics?: PsychoMetricConfig[];
  currentWeekFocus?: { goals: WeekFocusGoal[] } | null;
  isSaving?: boolean;
  lastSaved?: Date | null;
  /** Pokud nastavené, otevře prep/review v expanded edit módu při mountu */
  autoExpand?: 'prep' | 'review' | null;
  /** Callback poté co byl autoExpand aplikován — pro vyčištění stavu v rodiči */
  onAutoExpandConsumed?: () => void;
}

// Inline breakdown editor component
const BreakdownCard: React.FC<{
  session: SessionConfig;
  breakdown?: SessionBreakdown;
  theme: 'dark' | 'light' | 'oled';
  onUpdate: (notes: string, screenshot?: string) => void;
  onZoomImg?: (src: string) => void;
}> = ({ session, breakdown, theme, onUpdate, onZoomImg }) => {
  const isDark = theme !== 'light';
  const [isEditing, setIsEditing] = useState(false);
  const [text, setText] = useState(breakdown?.notes || '');
  const [screenshot, setScreenshot] = useState<string | undefined>(breakdown?.screenshot);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isEditingRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;
  const textRef = useRef(text);
  textRef.current = text;
  const screenshotRef = useRef(screenshot);
  screenshotRef.current = screenshot;
  const breakdownRef = useRef(breakdown);
  breakdownRef.current = breakdown;

  // Sync from props only when NOT actively editing (prevents overwriting local edits)
  useEffect(() => {
    if (!isEditingRef.current) {
      setText(breakdown?.notes || '');
      setScreenshot(breakdown?.screenshot);
    }
  }, [breakdown?.notes, breakdown?.screenshot]);

  // Emergency flush: save pending changes when tab is hidden or browser closes
  useEffect(() => {
    const flush = () => {
      if (!isEditingRef.current) return;
      clearTimeout(debounceRef.current);
      const bd = breakdownRef.current;
      if (textRef.current !== (bd?.notes || '') || screenshotRef.current !== bd?.screenshot) {
        onUpdateRef.current(textRef.current, screenshotRef.current);
      }
    };
    const onVisChange = () => { if (document.visibilityState === 'hidden') flush(); };
    document.addEventListener('visibilitychange', onVisChange);
    window.addEventListener('beforeunload', flush);
    return () => {
      document.removeEventListener('visibilitychange', onVisChange);
      window.removeEventListener('beforeunload', flush);
    };
  }, []);

  useEffect(() => {
    if (isEditing && textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = textareaRef.current.scrollHeight + 'px';
    }
  }, [isEditing]);

  // Debounced auto-save: propagate changes to parent on every keystroke (300ms)
  useEffect(() => {
    if (!isEditingRef.current) return;
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      onUpdateRef.current(text, screenshot);
    }, 300);
    return () => clearTimeout(debounceRef.current);
  }, [text, screenshot]);

  const handleBlur = () => {
    // Flush any pending debounce immediately
    clearTimeout(debounceRef.current);
    if (text !== (breakdown?.notes || '') || screenshot !== breakdown?.screenshot) {
      onUpdate(text, screenshot);
    }
    setIsEditing(false);
    isEditingRef.current = false;
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      clearTimeout(debounceRef.current);
      setIsEditing(false);
      isEditingRef.current = false;
      setText(breakdown?.notes || '');
      setScreenshot(breakdown?.screenshot);
    }
  };

  const processFile = (file: File) => {
    const reader = new FileReader();
    reader.onloadend = async () => {
      const base64 = reader.result as string;
      // Optimistic: show base64 immediately
      setScreenshot(base64);
      // Upload to Storage in background, then replace with URL
      try {
        const url = await storageService.uploadScreenshot(base64, `review_${Date.now()}`);
        setScreenshot(url);
        onUpdate(text, url);
      } catch (e) {
        // Fallback: keep base64 if upload fails (will be migrated later)
        console.warn('[TacticalTimeline] Upload failed, keeping base64:', e);
        onUpdate(text, base64);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleRemoveScreenshot = () => {
    setScreenshot(undefined);
    onUpdate(text, undefined);
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') !== -1) {
        const blob = items[i].getAsFile();
        if (blob) processFile(blob);
        e.preventDefault();
        break;
      }
    }
  };

  const hasContent = text.trim().length > 0 || !!screenshot;
  const sessionColor = session.color || '#6366f1';

  if (!hasContent && !isEditing) {
    return (
      <button
        onClick={() => { setIsEditing(true); isEditingRef.current = true; }}
        className={`w-full px-4 py-3 rounded-2xl border-2 border-dashed transition-all flex items-center gap-3 group/bd ${
          isDark
            ? 'border-white/10 hover:border-white/20 hover:bg-white/5'
            : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'
        }`}
      >
        <div className="p-1.5 rounded-lg" style={{ backgroundColor: sessionColor + '15' }}>
          <MessageSquare size={14} style={{ color: sessionColor }} />
        </div>
        <span className={`text-[10px] font-bold ${isDark ? 'text-slate-500 group-hover/bd:text-slate-400' : 'text-slate-400 group-hover/bd:text-slate-500'} transition-colors`}>
          Přidat breakdown pro {session.name}...
        </span>
      </button>
    );
  }

  return (
    <div
      className={`px-4 py-3 rounded-2xl border transition-all ${
        isDark
          ? 'bg-white/[0.03] border-white/10'
          : 'bg-slate-50/50 border-slate-200'
      }`}
      style={{ borderLeftWidth: 3, borderLeftColor: sessionColor }}
    >
      <div className="flex items-center gap-2 mb-2">
        <MessageSquare size={12} style={{ color: sessionColor }} />
        <span className="text-[9px] font-black uppercase tracking-widest" style={{ color: sessionColor }}>
          {session.name} Breakdown
        </span>
      </div>

      {/* Screenshot or paste zone */}
      {screenshot ? (
        <div className="relative mb-2 group/bdimg">
          <div
            className="aspect-video rounded-xl overflow-hidden border border-white/5 cursor-pointer"
            onClick={() => onZoomImg?.(screenshot)}
          >
            <img src={thumbMedium(screenshot)} className="w-full h-full object-cover" loading="lazy" />
          </div>
          <button
            onClick={handleRemoveScreenshot}
            className="absolute top-1.5 right-1.5 p-1 bg-red-600 text-white rounded-full opacity-0 group-hover/bdimg:opacity-100 transition-opacity"
          >
            <X size={10} />
          </button>
        </div>
      ) : (
        <div
          tabIndex={0}
          onPaste={handlePaste}
          className={`mb-2 flex items-center justify-center rounded-xl border-2 border-dashed py-3 cursor-pointer transition-all outline-none focus:ring-1 ${
            isDark
              ? 'border-white/10 hover:border-white/20 focus:ring-white/20 text-slate-600 hover:text-slate-400'
              : 'border-slate-200 hover:border-slate-300 focus:ring-slate-300 text-slate-400 hover:text-slate-500'
          }`}
        >
          <ImagePlus size={12} className="mr-1.5" />
          <span className="text-[8px] font-bold uppercase tracking-wider">Ctrl+V screenshot</span>
        </div>
      )}

      {isEditing ? (
        <div className="relative">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = e.target.scrollHeight + 'px';
            }}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder="Jak probíhala session? Co jsi mohl udělat lépe?"
            className={`w-full text-sm leading-relaxed bg-transparent border-none outline-none resize-none placeholder:italic pr-12 ${
              isDark ? 'text-slate-300 placeholder:text-slate-600' : 'text-slate-700 placeholder:text-slate-400'
            }`}
            rows={3}
          />
          <div className="absolute bottom-1 right-1" onMouseDown={(e) => e.preventDefault()}>
            <VoiceMemoButton
              size="sm"
              onTranscribed={(t) => {
                const sep = text.trim().length > 0 ? '\n\n' : '';
                const newText = text + sep + t;
                setText(newText);
                onUpdate(newText, screenshot);
              }}
            />
          </div>
        </div>
      ) : (
        <div
          onClick={() => { setIsEditing(true); isEditingRef.current = true; }}
          className={`text-sm leading-relaxed cursor-pointer hover:opacity-80 transition-opacity whitespace-pre-wrap ${
            text.trim()
              ? (isDark ? 'text-slate-400' : 'text-slate-600')
              : (isDark ? 'text-slate-600 italic' : 'text-slate-400 italic')
          }`}
        >
          {text.trim() || 'Klikni pro přidání poznámky...'}
        </div>
      )}
    </div>
  );
};

const TacticalTimeline: React.FC<TacticalTimelineProps> = ({ date, prep, review, trades, theme, onEditPrep, onEditReview, onDeletePrep, onDeleteReview, isMini = false, sessions, sessionBreakdowns, onUpdateBreakdown, prepForm, reviewForm, editPrepForm, editReviewForm, onSavePrep, onSaveReview, rituals, tradeRules, psychoMetrics, currentWeekFocus, isSaving, lastSaved, autoExpand, onAutoExpandConsumed }) => {
  const isDark = theme !== 'light';
  const [zoomImg, setZoomImg] = useState<string | null>(null);
  const [isDeletingPrep, setIsDeletingPrep] = useState(false);
  const [isDeletingReview, setIsDeletingReview] = useState(false);
  const [isBreakdownExpanded, setIsBreakdownExpanded] = useState(false);
  const [expandedBreakdownSessions, setExpandedBreakdownSessions] = useState<Set<string>>(new Set());
  const [isPrepExpanded, setIsPrepExpanded] = useState(false);
  const [isReviewExpanded, setIsReviewExpanded] = useState(false);

  // Reaguj na autoExpand signál — otevři prep nebo review když rodič požádá
  useEffect(() => {
    if (autoExpand === 'prep') {
      setIsPrepExpanded(true);
      onAutoExpandConsumed?.();
    } else if (autoExpand === 'review') {
      setIsReviewExpanded(true);
      onAutoExpandConsumed?.();
    }
  }, [autoExpand, onAutoExpandConsumed]);
  const [activeSessionTab, setActiveSessionTab] = useState<string | null>(null);
  const [quickNote, setQuickNote] = useState('');

  // Initialize active session tab
  useEffect(() => {
    if (!activeSessionTab && prepForm?.scenarios?.sessions?.length) {
      setActiveSessionTab(prepForm.scenarios.sessions[0].id);
    }
  }, [prepForm?.scenarios?.sessions]);

  const canInlineEdit = !isMini && !!editPrepForm && !!editReviewForm;

  const handleToggleRitual = (ruleId: string) => {
    if (!editPrepForm) return;
    editPrepForm(prev => {
      const completions = prev.ritualCompletions || [];
      const index = completions.findIndex(c => c.ruleId === ruleId);
      const newCompletions = [...completions];
      const label = rituals?.find(r => r.id === ruleId)?.label;
      if (index === -1) newCompletions.push({ ruleId, status: 'Pass', label });
      else newCompletions[index] = { ...newCompletions[index], status: newCompletions[index].status === 'Pass' ? 'Pending' : 'Pass', label: newCompletions[index].label || label };
      return { ...prev, ritualCompletions: newCompletions };
    });
  };

  const handleSetRuleStatus = (ruleId: string, status: 'Pass' | 'Fail') => {
    if (!editReviewForm) return;
    editReviewForm(prev => {
      const adherence = (prev as DailyReview).ruleAdherence || [];
      const index = adherence.findIndex(a => a.ruleId === ruleId);
      const newAdherence = [...adherence];
      const label = tradeRules?.find(r => r.id === ruleId)?.label;
      if (index === -1) newAdherence.push({ ruleId, status, label });
      else newAdherence[index] = { ...newAdherence[index], status, label: newAdherence[index].label || label };
      return { ...prev, ruleAdherence: newAdherence };
    });
  };

  const addQuickNote = () => {
    if (!quickNote.trim() || !editReviewForm) return;
    const now = new Date();
    const timestamp = `[${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}]`;
    const newNote = `${timestamp} ${quickNote}`;
    editReviewForm(prev => ({
      ...prev,
      psycho: {
        ...(prev as DailyReview).psycho!,
        notes: (prev as DailyReview).psycho?.notes ? `${(prev as DailyReview).psycho!.notes}\n${newNote}` : newNote
      }
    }));
    setQuickNote('');
  };

  // Handle paste for prep session images
  useEffect(() => {
    if (!isPrepExpanded || !editPrepForm || !activeSessionTab) return;
    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image') !== -1) {
          const blob = items[i].getAsFile();
          if (blob) {
            const reader = new FileReader();
            reader.onloadend = async () => {
              const base64 = reader.result as string;
              // Optimistic: zobrazit base64 hned
              editPrepForm(prev => ({
                ...prev,
                scenarios: {
                  ...prev.scenarios,
                  sessions: prev.scenarios.sessions?.map(s =>
                    s.id === activeSessionTab ? { ...s, image: base64 } : s
                  )
                }
              }));
              // Upload to Storage v pozadí, potom nahradit URL
              try {
                const url = await storageService.uploadScreenshot(base64, `prep_sess_${activeSessionTab}_${Date.now()}`);
                editPrepForm(prev => ({
                  ...prev,
                  scenarios: {
                    ...prev.scenarios,
                    sessions: prev.scenarios.sessions?.map(s =>
                      s.id === activeSessionTab ? { ...s, image: url } : s
                    )
                  }
                }));
              } catch (e) {
                console.warn('[TacticalTimeline prep] Upload failed, keeping base64:', e);
              }
            };
            reader.readAsDataURL(blob);
          }
          e.preventDefault();
          break;
        }
      }
    };
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [isPrepExpanded, editPrepForm, activeSessionTab]);

  const dayStats = useMemo(() => {
    if (trades.length === 0) return null;
    const pnl = trades.reduce((acc, t) => acc + t.pnl, 0);
    const wins = trades.filter(t => t.pnl > 0).length;
    const wr = (wins / trades.length) * 100;
    return { pnl, wr, count: trades.length };
  }, [trades]);

  // Group trades into sessions
  const sessionGroups = useMemo(() => {
    if (!sessions?.length) return null;

    const sortedTrades = [...trades].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    return sessions.map(session => {
      const [startH, startM] = session.startTime.split(':').map(Number);
      const [endH, endM] = session.endTime.split(':').map(Number);
      const startMin = startH * 60 + startM;
      const endMin = endH * 60 + endM;

      const sessionTrades = sortedTrades.filter(t => {
        if (!t.timestamp) return false;
        const d = new Date(t.timestamp);
        const tradeMin = d.getHours() * 60 + d.getMinutes();
        // Handle overnight sessions (e.g. endMin < startMin)
        if (endMin <= startMin) {
          return tradeMin >= startMin || tradeMin < endMin;
        }
        return tradeMin >= startMin && tradeMin < endMin;
      });

      const breakdown = sessionBreakdowns?.find(b => b.sessionId === session.id);
      const prepSession = prep?.scenarios?.sessions?.find((s: any) => s.id === session.id);
      const sessionPnl = sessionTrades.reduce((sum, t) => sum + t.pnl, 0);

      return { session, trades: sessionTrades, breakdown, pnl: sessionPnl, prepSession };
    });
  }, [sessions, trades, sessionBreakdowns, prep]);

  const breakdownCount = useMemo(() => {
    return sessionBreakdowns?.filter(b => b.notes?.trim()).length || 0;
  }, [sessionBreakdowns]);

  // Helper classes based on mini mode
  const textTitle = isMini ? 'text-[7px] md:text-[8px]' : 'text-xs';
  const iconSize = isMini ? 10 : 16;
  const padding = isMini ? 'p-2' : 'p-6';
  const rounded = isMini ? 'rounded-xl md:rounded-2xl' : 'rounded-[32px]';

  // Render a single trade card
  const renderTradeCard = (trade: Trade, altSide: boolean = false) => {
    const d = new Date(trade.timestamp || 0);
    const time = d.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
    const isPlaceholderTime = time === '01:00' || time === '00:00';

    return (
      <div className="relative flex items-center">
        {/* Timeline Dot */}
        <div className={`absolute ${isMini ? 'left-4' : 'left-10'} -translate-x-1/2 ${isMini ? 'w-1.5 h-1.5' : 'w-4 h-4'} rounded-full border-2 flex items-center justify-center transition-all duration-500 ${trade.pnl >= 0 ? 'bg-emerald-500 border-black/50' : 'bg-rose-500 border-black/50'}`}>
          {!isMini && !isPlaceholderTime && <div className="absolute -top-6 text-[9px] font-black uppercase text-slate-500 tracking-widest whitespace-nowrap">{time}</div>}
        </div>

        <div className={`relative z-[1] w-full ${isMini ? 'pl-7' : 'pl-16'}`}>
          <div className={`group ${isMini ? padding : 'p-3'} ${rounded} border transition-all hover:shadow-lg ${isDark ? 'bg-[var(--bg-card)] border-[var(--border-subtle)]' : 'bg-white border-slate-200 shadow-sm'}`}>
            {isMini ? (
              <>
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-1">
                    <span className={`px-1 py-0.5 rounded-lg text-[6px] md:text-[7px] font-black uppercase ${trade.pnl >= 0 ? 'bg-emerald-500/10 text-emerald-500 border border-emerald-500/20' : 'bg-rose-500/10 text-rose-500 border border-rose-500/20'}`}>
                      {trade.direction}
                    </span>
                  </div>
                  <span className={`text-[10px] md:text-xs font-black font-mono ${trade.pnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                    ${trade.pnl.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </span>
                </div>
                {trade.screenshot && (
                  <div
                    className="mb-1 aspect-video rounded-lg overflow-hidden border border-white/5 relative cursor-pointer"
                    onClick={() => setZoomImg(fullSize(trade.screenshot)!)}
                  >
                    <img src={thumbSmall(trade.screenshot)} className="w-full h-full object-cover" loading="lazy" />
                  </div>
                )}
                <p className="text-[6px] text-slate-600 font-mono mt-1 text-right">{!isPlaceholderTime ? time : ''}</p>
              </>
            ) : (
              <div className="flex items-center gap-3">
                {/* Image left — small thumbnail */}
                {trade.screenshot && (
                  <div
                    className="shrink-0 h-16 sm:h-20 w-28 sm:w-36 rounded-lg overflow-hidden border border-white/5 relative group/tradeimg cursor-pointer bg-slate-50 flex items-center justify-center"
                    onClick={() => setZoomImg(fullSize(trade.screenshot)!)}
                  >
                    <img src={thumbSmall(trade.screenshot)} className="h-full w-auto object-contain transition-transform duration-700 group-hover/tradeimg:scale-105" loading="lazy" />
                    <div className="absolute inset-0 bg-black/40 opacity-0 group-hover/tradeimg:opacity-100 flex items-center justify-center transition-all">
                      <Maximize2 size={12} className="text-white" />
                    </div>
                  </div>
                )}

                {/* Right: badges + mistakes */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className={`px-2 py-0.5 rounded-lg text-[8px] font-black uppercase ${trade.pnl >= 0 ? 'bg-emerald-500/10 text-emerald-500 border border-emerald-500/20' : 'bg-rose-500/10 text-rose-500 border border-rose-500/20'}`}>
                      {trade.direction}
                    </span>
                    <span className="text-[11px] font-black uppercase tracking-tight text-slate-700">{trade.instrument}</span>
                    {trade.accountCount >= 1 && (
                      <span className="px-1.5 py-0.5 rounded-lg text-[7px] font-black uppercase bg-blue-500/10 text-blue-500 border border-blue-500/20">
                        ×{trade.accountCount}
                      </span>
                    )}
                  </div>
                  {trade.mistakes && trade.mistakes.length > 0 && (
                    <div className="flex gap-1 flex-wrap mt-1.5">
                      {trade.mistakes.map((mistake: any) => (
                        <span key={mistake} className="px-1.5 py-0.5 rounded bg-rose-500/10 text-rose-500 text-[7px] font-black uppercase border border-rose-500/20">{mistake}</span>
                      ))}
                    </div>
                  )}
                </div>

                {/* PnL right */}
                <div className="shrink-0 text-right">
                  <span className={`text-base font-black font-mono ${trade.pnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                    ${trade.pnl.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </span>
                  {trade.accountCount >= 1 && (
                    <p className="text-[7px] font-bold text-slate-500 uppercase tracking-tighter">Suma P&L</p>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className={`relative ${isMini ? 'py-3 px-1' : 'py-4 px-2 lg:py-10 lg:px-4'}`}>
      {/* Vertical Line — vždy vlevo */}
      <div className={`absolute ${isMini ? 'left-4' : 'left-10'} top-0 bottom-0 w-px ${isDark ? 'bg-[var(--border-subtle)]' : 'bg-slate-200'}`}></div>

      <div className={isMini ? 'space-y-4' : 'space-y-6 lg:space-y-12'}>

        {/* ====== PREP CARD ====== */}
        <div className="relative flex items-center">
          <div className={`absolute ${isMini ? 'left-4' : 'left-10'} -translate-x-1/2 ${isMini ? 'w-1.5 h-1.5' : 'w-4 h-4'} rounded-full border-2 flex items-center justify-center transition-all duration-500 bg-blue-600 border-black/50`}>
            {!isMini && <div className="absolute -top-6 text-[9px] font-black uppercase text-slate-500 tracking-widest whitespace-nowrap">08:00</div>}
          </div>
          <div className={`relative z-[1] w-full ${isMini ? 'pl-7' : 'pl-16 lg:pl-16'}`}>
            <div className={`${padding} ${rounded} border transition-all ${prep ? (isDark ? 'bg-blue-600/5 border-blue-500/20 shadow-lg shadow-blue-500/5' : 'bg-blue-50 border-blue-200 shadow-sm') : (isDark ? 'bg-[var(--bg-card)] border-[var(--border-subtle)]' : 'bg-white border-slate-200')}`}>
              {/* Header — click to expand/collapse */}
              <div
                className="flex items-center justify-between gap-2 cursor-pointer"
                onClick={() => canInlineEdit ? setIsPrepExpanded(!isPrepExpanded) : onEditPrep()}
              >
                <div className="flex items-center gap-1.5 min-w-0 flex-1">
                  <div className={`${isMini ? 'p-1' : 'p-2'} rounded-lg bg-blue-600/10 text-blue-500 flex-shrink-0`}><Coffee size={iconSize} /></div>
                  <div className="min-w-0">
                    <h4 className={`${textTitle} font-black uppercase tracking-widest`}>Příprava</h4>
                    {prep && !prep.completed && !isMini && (
                      <span className="inline-block mt-0.5 px-2 py-0.5 rounded-md text-[7px] font-black uppercase bg-amber-500/10 text-amber-500 border border-amber-500/20">Rozpracováno</span>
                    )}
                    {isMini && <span className="text-[6px] text-slate-600 font-mono">08:00</span>}
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {!isMini && isPrepExpanded && isSaving && (
                    <div className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-blue-500/10 text-blue-500 animate-pulse">
                      <div className="w-1.5 h-1.5 rounded-full bg-blue-500" />
                      <span className="text-[8px] font-black uppercase tracking-widest">Ukládám...</span>
                    </div>
                  )}
                  {!isMini && isPrepExpanded && !isSaving && lastSaved && (
                    <div className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-emerald-500/10 text-emerald-500">
                      <Check size={10} />
                      <span className="text-[8px] font-black uppercase tracking-widest">{lastSaved.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    </div>
                  )}
                  {prep && onDeletePrep && !isMini && (
                    <button onClick={(e) => { e.stopPropagation(); setIsDeletingPrep(true); }} className="p-1.5 hover:bg-rose-500/10 text-slate-400 hover:text-rose-500 rounded-lg transition-all" title="Smazat přípravu">
                      <Trash2 size={14} />
                    </button>
                  )}
                  {canInlineEdit && <ChevronDown size={16} className={`text-slate-500 transition-transform duration-300 ${isPrepExpanded ? 'rotate-180' : ''}`} />}
                </div>
              </div>

              {/* Collapsed — horizontal session strip */}
              {!isPrepExpanded && !isMini && prep && (
                <div className="mt-3 flex gap-2 items-stretch">
                  {prep.scenarios.sessions?.map((session, i) => {
                    const sessConfig = sessions?.find(s => s.id === session.id);
                    const now = new Date();
                    let isActive = false;
                    let timeLabel = '';
                    if (sessConfig?.startTime && sessConfig?.endTime) {
                      timeLabel = `${sessConfig.startTime}–${sessConfig.endTime}`;
                      const [sh, sm] = sessConfig.startTime.split(':').map(Number);
                      const [eh, em] = sessConfig.endTime.split(':').map(Number);
                      const startMin = sh * 60 + sm;
                      const endMin = eh * 60 + em;
                      const nowMin = now.getHours() * 60 + now.getMinutes();
                      isActive = date === now.toLocaleDateString('en-CA') && nowMin >= startMin && nowMin <= endMin;
                    }
                    const color = session.color || sessConfig?.color || '#6366f1';
                    const biasEmoji = session.bias === 'Bullish' ? '🐂' : session.bias === 'Bearish' ? '🐻' : session.bias === 'Neutral' ? '⚖️' : null;
                    return (
                      <div
                        key={session.id || i}
                        className={`relative flex-1 min-w-0 overflow-hidden rounded-2xl border transition-all flex flex-col ${
                          isActive
                            ? 'border-blue-500/40 shadow-[0_0_20px_rgba(59,130,246,0.15)]'
                            : isDark ? 'border-white/5' : 'border-slate-200/70'
                        }`}
                        style={{ borderTopWidth: 3, borderTopColor: color }}
                      >
                        {/* Screenshot or placeholder */}
                        <div
                          className={`relative w-full h-32 overflow-hidden flex items-center justify-center cursor-pointer ${
                            session.image ? '' : isDark ? 'bg-white/[0.02]' : 'bg-slate-50'
                          }`}
                          onClick={(e) => { if (session.image) { e.stopPropagation(); setZoomImg(fullSize(session.image)); } }}
                        >
                          {session.image ? (
                            <>
                              <img src={thumbMedium(session.image)} className="w-full h-full object-cover" loading="lazy" />
                              <div className="absolute inset-0 bg-black/0 hover:bg-black/20 transition-all flex items-center justify-center">
                                <Maximize2 size={14} className="text-white opacity-0 hover:opacity-100 transition-all" />
                              </div>
                            </>
                          ) : (
                            <div className="text-center">
                              <ImageIcon size={16} className={`mx-auto mb-1 ${isDark ? 'text-slate-700' : 'text-slate-300'}`} />
                              <p className="text-[7px] font-black uppercase text-slate-400 tracking-widest">Bez screenu</p>
                            </div>
                          )}
                          {isActive && (
                            <span className="absolute top-1.5 right-1.5 px-1.5 py-0.5 bg-blue-500 text-white rounded text-[7px] font-black uppercase tracking-widest animate-pulse">NOW</span>
                          )}
                        </div>

                        {/* Info below image */}
                        <div className="px-2.5 py-2 flex flex-col gap-1">
                          <div className="flex items-center justify-between gap-1">
                            <span className="text-[9px] font-black uppercase tracking-widest truncate" style={{ color }}>{session.label}</span>
                            {biasEmoji && (
                              <span className="text-[10px] shrink-0">{biasEmoji}</span>
                            )}
                          </div>
                          {timeLabel && (
                            <span className="text-[8px] font-black text-slate-400 font-mono">{timeLabel}</span>
                          )}
                          {session.plan ? (
                            <p className={`text-[9px] leading-snug italic line-clamp-2 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                              {session.plan}
                            </p>
                          ) : (
                            <p className="text-[8px] text-slate-400 italic">Bez plánu</p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              {!isPrepExpanded && isMini && prep && (
                <div className="mt-1 space-y-1">
                  <div className="grid grid-cols-2 gap-3">
                    {prep.scenarios.sessions?.map((session, i) => (
                      <div key={session.id || i} className={`overflow-hidden rounded-xl border ${isDark ? 'bg-slate-900/40 border-white/5' : 'bg-white/40 border-slate-200/50'}`}>
                        <div className="p-2"><span className="text-[7px] font-black text-slate-500">{session.label}</span></div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {!isPrepExpanded && !prep && (
                <p className={`mt-2 ${isMini ? 'text-[7px]' : 'text-sm'} text-slate-500 italic`}>Naplánuj den...</p>
              )}

              {/* Expanded — inline editing form */}
              {isPrepExpanded && canInlineEdit && prepForm && (
                <div className="mt-4 space-y-3">
                  {/* Session tabs — slim compact */}
                  {prepForm.scenarios.sessions && prepForm.scenarios.sessions.length > 1 && (
                    <div className={`inline-flex items-center p-0.5 rounded-xl border gap-0.5 ${isDark ? 'bg-black/40 border-slate-800' : 'bg-slate-100 border-slate-200'}`}>
                      {prepForm.scenarios.sessions.map(session => {
                        const isActive = activeSessionTab === session.id;
                        const sessionColor = session.color || '#3b82f6';
                        return (
                          <button
                            key={session.id}
                            onClick={() => setActiveSessionTab(session.id)}
                            className={`px-4 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-widest transition-all ${isActive ? 'text-white shadow-md' : 'text-slate-500 hover:text-slate-400'}`}
                            style={isActive ? { backgroundColor: sessionColor } : undefined}
                          >
                            {session.label}
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {/* Active session editor — compact 2-col */}
                  {prepForm.scenarios.sessions?.filter(s => s.id === activeSessionTab).map(session => (
                    <div key={session.id} className="grid grid-cols-[1fr_260px] gap-3">

                      {/* LEFT: bias row + textarea */}
                      <div className="flex flex-col gap-2">
                        {/* Bias — compact inline pills */}
                        <div className="flex items-center gap-2">
                          <TrendingUp size={11} className={`shrink-0 ${session.bias === 'Bullish' ? 'text-emerald-500' : session.bias === 'Bearish' ? 'text-rose-500' : 'text-slate-500'}`} />
                          <span className="text-[8px] font-black uppercase tracking-widest text-slate-400 shrink-0">{session.label} Bias</span>
                          <div className="flex gap-1 ml-1">
                            {(['Bullish', 'Neutral', 'Bearish'] as const).map(b => {
                              const isAct = (session.bias ?? 'Neutral') === b;
                              const activeStyle = b === 'Bullish' ? 'bg-emerald-500 border-emerald-400 text-white' : b === 'Bearish' ? 'bg-rose-500 border-rose-400 text-white' : 'bg-slate-500 border-slate-400 text-white';
                              const inactiveStyle = isDark ? 'bg-[var(--bg-page)] border-[var(--border-subtle)] text-slate-400 hover:text-slate-200' : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50';
                              const emoji = { Bullish: '🐂', Neutral: '⚖️', Bearish: '🐻' };
                              return (
                                <button
                                  key={b}
                                  onClick={() => editPrepForm!(prev => ({
                                    ...prev,
                                    scenarios: { ...prev.scenarios, sessions: prev.scenarios.sessions?.map(s => s.id === session.id ? { ...s, bias: b } : s) }
                                  }))}
                                  className={`px-2.5 py-1 rounded-lg border text-[8px] font-black uppercase tracking-wide transition-all active:scale-95 flex items-center gap-1 ${isAct ? activeStyle : inactiveStyle}`}
                                >
                                  <span>{emoji[b]}</span>
                                  <span>{b}</span>
                                </button>
                              );
                            })}
                          </div>
                        </div>

                        {/* Textarea */}
                        <div className="relative flex-1 flex flex-col">
                          <textarea
                            value={session.plan}
                            onChange={(e) => editPrepForm!(prev => ({
                              ...prev,
                              scenarios: { ...prev.scenarios, sessions: prev.scenarios.sessions?.map(s => s.id === session.id ? { ...s, plan: e.target.value } : s) }
                            }))}
                            placeholder="Tactical game plan pro tuto seanci..."
                            className={`w-full flex-1 min-h-[130px] rounded-xl p-3 pr-12 border text-[12px] leading-relaxed transition-all placeholder:text-slate-400 outline-none focus:ring-2 focus:ring-blue-500/20 resize-none ${isDark ? 'bg-[var(--bg-page)] border-[var(--border-subtle)] text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-700'}`}
                          />
                          <div className="absolute bottom-2 right-2">
                            <VoiceMemoButton
                              size="sm"
                              onTranscribed={(t) => {
                                editPrepForm!(prev => ({
                                  ...prev,
                                  scenarios: { ...prev.scenarios, sessions: prev.scenarios.sessions?.map(s => {
                                    if (s.id !== session.id) return s;
                                    const sep = (s.plan || '').trim().length > 0 ? '\n\n' : '';
                                    return { ...s, plan: (s.plan || '') + sep + t };
                                  }) }
                                }));
                              }}
                            />
                          </div>
                        </div>
                      </div>

                      {/* RIGHT: screenshot */}
                      <div className="flex flex-col gap-1.5">
                        <div className="flex items-center justify-between">
                          <span className="text-[8px] font-black uppercase tracking-widest text-slate-400">{session.label} Chart</span>
                          {session.image && (
                            <button
                              onClick={() => editPrepForm!(prev => ({ ...prev, scenarios: { ...prev.scenarios, sessions: prev.scenarios.sessions?.map(s => s.id === session.id ? { ...s, image: '' } : s) } }))}
                              className="px-1.5 py-0.5 bg-rose-500/10 text-rose-500 rounded text-[7px] font-black uppercase hover:bg-rose-500 hover:text-white transition-all"
                            >Clear</button>
                          )}
                        </div>
                        <div className={`flex-1 rounded-xl border-2 border-dashed overflow-hidden flex items-center justify-center min-h-[148px] ${session.image ? 'border-transparent' : isDark ? 'border-slate-700 bg-white/[0.02]' : 'border-slate-200 bg-slate-50'}`}>
                          {session.image ? (
                            <div className="relative w-full h-full group/pimg">
                              <img src={thumbMedium(session.image)} className="w-full h-full object-cover" loading="lazy" />
                              <div className="absolute inset-0 bg-black/0 group-hover/pimg:bg-black/40 transition-all flex items-center justify-center">
                                <button onClick={() => setZoomImg(fullSize(session.image)!)} className="p-1.5 rounded-lg bg-black/60 text-white opacity-0 group-hover/pimg:opacity-100 transition-all"><Maximize2 size={12} /></button>
                              </div>
                            </div>
                          ) : (
                            <div className="text-center p-3">
                              <ImageIcon size={16} className={`mx-auto mb-1.5 ${isDark ? 'text-slate-600' : 'text-slate-400'}`} />
                              <p className="text-[7px] font-black uppercase text-slate-500 tracking-widest">CTRL+V to paste</p>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}

                  {/* Bottom bar: confidence + rituals + button */}
                  <div className={`flex flex-col gap-2 pt-2 border-t ${isDark ? 'border-slate-800' : 'border-slate-100'}`}>
                    {/* Confidence inline */}
                    <div className="flex items-center gap-3">
                      <Brain size={11} className="text-violet-500 shrink-0" />
                      <span className="text-[8px] font-black uppercase tracking-widest text-slate-400 shrink-0 w-20">Sebevědomí</span>
                      <input
                        type="range" min="0" max="100" step="5"
                        value={prepForm.confidence ?? 50}
                        onChange={(e) => editPrepForm!(prev => ({ ...prev, confidence: Number(e.target.value) }))}
                        className="flex-1 h-1.5 rounded-lg appearance-none cursor-pointer"
                        style={{
                          accentColor: (prepForm.confidence ?? 50) >= 70 ? '#10b981' : (prepForm.confidence ?? 50) >= 40 ? '#f59e0b' : '#f43f5e',
                          background: `linear-gradient(to right, ${(prepForm.confidence ?? 50) >= 70 ? '#10b981' : (prepForm.confidence ?? 50) >= 40 ? '#f59e0b' : '#f43f5e'} ${prepForm.confidence ?? 50}%, ${isDark ? '#334155' : '#e2e8f0'} ${prepForm.confidence ?? 50}%)`
                        }}
                      />
                      <span className={`text-[11px] font-black tabular-nums w-8 text-right shrink-0 ${(prepForm.confidence ?? 50) >= 70 ? 'text-emerald-400' : (prepForm.confidence ?? 50) >= 40 ? 'text-amber-400' : 'text-rose-400'}`}>
                        {prepForm.confidence ?? 50}%
                      </span>
                    </div>

                    {/* Rituals — compact chips */}
                    {rituals && rituals.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {rituals.map(ritual => {
                          const comp = prepForm.ritualCompletions?.find(c => c.ruleId === ritual.id);
                          const isDone = comp?.status === 'Pass';
                          return (
                            <button
                              key={ritual.id}
                              onClick={() => handleToggleRitual(ritual.id)}
                              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[8px] font-black uppercase tracking-tight transition-all active:scale-95 ${isDone ? 'bg-emerald-500 border-emerald-400 text-white shadow-sm shadow-emerald-500/30' : (isDark ? 'bg-[var(--bg-page)] border-[var(--border-subtle)] text-slate-400' : 'bg-slate-50 border-slate-200 text-slate-500')}`}
                            >
                              {isDone ? <Check size={10} /> : <div className={`w-2.5 h-2.5 rounded-full border shrink-0 ${isDark ? 'border-slate-600' : 'border-slate-300'}`} />}
                              {ritual.label}
                            </button>
                          );
                        })}
                      </div>
                    )}

                    {/* Complete button — compact */}
                    <button
                      onClick={() => {
                        const completedPrep = { ...prepForm, completed: true };
                        editPrepForm?.(() => completedPrep); // sync DailyJournal form state → debounced autosave nenese starý completed: undefined
                        onSavePrep?.(completedPrep);
                        setIsPrepExpanded(false);
                      }}
                      className="w-full py-2.5 bg-blue-600 text-white rounded-xl font-black uppercase text-[9px] tracking-widest shadow-lg shadow-blue-500/20 active:scale-95 transition-all hover:bg-blue-500"
                    >
                      DOKONČIT PŘÍPRAVU
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ====== TRADES — grouped in 2-col grid ====== */}
        {!isMini && trades.length > 0 && (() => {
          const sortedTrades = [...trades].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
          const firstTime = sortedTrades[0]?.timestamp ? new Date(sortedTrades[0].timestamp).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' }) : '';
          const totalPnl = sortedTrades.reduce((s, t) => s + t.pnl, 0);
          const dotColor = totalPnl >= 0 ? 'bg-emerald-500' : 'bg-rose-500';
          return (
            <div className="relative flex items-center">
              {/* Timeline dot — single one for all trades */}
              <div className={`absolute left-10 -translate-x-1/2 w-4 h-4 rounded-full border-2 flex items-center justify-center transition-all duration-500 ${dotColor} border-black/50`}>
                {firstTime && <div className="absolute -top-6 text-[9px] font-black uppercase text-slate-500 tracking-widest whitespace-nowrap">{firstTime}</div>}
              </div>

              <div className="relative z-[1] w-full pl-16">
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
                  {sortedTrades.map((trade, idx) => {
                    const d = new Date(trade.timestamp || 0);
                    const tTime = d.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
                    const isPlaceholder = tTime === '01:00' || tTime === '00:00';
                    return (
                      <div
                        key={trade.id || idx}
                        className={`group p-3 ${rounded} border transition-all hover:shadow-lg ${isDark ? 'bg-[var(--bg-card)] border-[var(--border-subtle)]' : 'bg-white border-slate-200 shadow-sm'}`}
                      >
                        <div className="flex items-center gap-3">
                          {trade.screenshot && (
                            <div
                              className="shrink-0 h-16 sm:h-20 w-24 sm:w-32 rounded-lg overflow-hidden border border-white/5 relative group/tradeimg cursor-pointer bg-slate-50 flex items-center justify-center"
                              onClick={() => setZoomImg(fullSize(trade.screenshot)!)}
                            >
                              <img src={thumbSmall(trade.screenshot)} className="h-full w-auto object-contain transition-transform duration-700 group-hover/tradeimg:scale-105" loading="lazy" />
                              <div className="absolute inset-0 bg-black/40 opacity-0 group-hover/tradeimg:opacity-100 flex items-center justify-center transition-all">
                                <Maximize2 size={12} className="text-white" />
                              </div>
                            </div>
                          )}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              {!isPlaceholder && (
                                <span className="text-[8px] font-black font-mono text-slate-500">{tTime}</span>
                              )}
                              <span className={`px-1.5 py-0.5 rounded text-[8px] font-black uppercase ${trade.pnl >= 0 ? 'bg-emerald-500/10 text-emerald-500 border border-emerald-500/20' : 'bg-rose-500/10 text-rose-500 border border-rose-500/20'}`}>
                                {trade.direction}
                              </span>
                              <span className="text-[10px] font-black uppercase tracking-tight text-slate-700">{trade.instrument}</span>
                            </div>
                            {trade.mistakes && trade.mistakes.length > 0 && (
                              <div className="flex gap-1 flex-wrap mt-1.5">
                                {trade.mistakes.map((mistake: any) => (
                                  <span key={mistake} className="px-1.5 py-0.5 rounded bg-rose-500/10 text-rose-500 text-[7px] font-black uppercase border border-rose-500/20">{mistake}</span>
                                ))}
                              </div>
                            )}
                          </div>
                          <div className="shrink-0 text-right">
                            <span className={`text-sm font-black font-mono ${trade.pnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                              ${trade.pnl.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                            </span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          );
        })()}

        {/* Mini mode: keep original flat list */}
        {isMini && [...trades].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0)).map((trade, idx) => (
          <React.Fragment key={trade.id || idx}>
            {renderTradeCard(trade, idx % 2 === 0)}
          </React.Fragment>
        ))}

        {/* ====== SESSION BREAKDOWN CARD (single card for all sessions) ====== */}
        {sessionGroups && !isMini && (
          <div className="relative flex items-center">
            <div className="absolute left-10 -translate-x-1/2 w-4 h-4 rounded-full border-2 border-black/50 bg-amber-500 flex items-center justify-center">
              <div className="absolute -top-6 text-[9px] font-black uppercase text-slate-500 tracking-widest whitespace-nowrap">Breakdown</div>
            </div>
            <div className="relative z-[1] w-full pl-16">
              <div className={`${padding} ${rounded} border transition-all ${
                breakdownCount > 0
                  ? (isDark ? 'bg-amber-600/5 border-amber-500/20 shadow-lg shadow-amber-500/5' : 'bg-amber-50 border-amber-200 shadow-sm')
                  : (isDark ? 'bg-[var(--bg-card)] border-[var(--border-subtle)]' : 'bg-white border-slate-200')
              }`}>
                {/* Header — click to expand/collapse */}
                <div
                  className="flex items-center justify-between gap-2 cursor-pointer"
                  onClick={() => setIsBreakdownExpanded(!isBreakdownExpanded)}
                >
                  <div className="flex items-center gap-1.5 min-w-0 flex-1">
                    <div className="p-2 rounded-lg bg-amber-500/10 text-amber-500 flex-shrink-0"><BarChart3 size={iconSize} /></div>
                    <div className="min-w-0">
                      <h4 className={`${textTitle} font-black uppercase tracking-widest`}>Session Breakdown</h4>
                      {breakdownCount > 0 && (
                        <span className="inline-block mt-0.5 px-2 py-0.5 rounded-md text-[7px] font-black uppercase bg-amber-500/10 text-amber-500 border border-amber-500/20">
                          {breakdownCount}/{sessionGroups.length}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    {dayStats && (
                      <span className={`text-sm font-black font-mono ${dayStats.pnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                        ${dayStats.pnl.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                      </span>
                    )}
                    <ChevronDown size={16} className={`text-slate-500 transition-transform duration-300 ${isBreakdownExpanded ? 'rotate-180' : ''}`} />
                  </div>
                </div>

                {/* Collapsed preview — analysis → trades → breakdown visual strip */}
                {!isBreakdownExpanded && breakdownCount > 0 && sessionGroups && (
                  <div className="mt-3 space-y-2">
                    {sessionGroups.map((group, i) => {
                      const bd = group.breakdown;
                      const hasContent = bd?.notes?.trim() || bd?.screenshot || group.prepSession?.image || group.trades.length > 0;
                      if (!hasContent) return null;
                      const sessionColor = group.session.color || '#6366f1';
                      const isExpanded = expandedBreakdownSessions.has(group.session.id);
                      const toggleExpanded = (e: React.MouseEvent) => {
                        e.stopPropagation();
                        setExpandedBreakdownSessions(prev => {
                          const next = new Set(prev);
                          isExpanded ? next.delete(group.session.id) : next.add(group.session.id);
                          return next;
                        });
                      };
                      return (
                        <div
                          key={group.session.id || i}
                          className={`overflow-hidden rounded-2xl border transition-all ${isDark ? 'bg-slate-900/40 border-white/5' : 'bg-white/40 border-slate-200/50'}`}
                          style={{ borderLeftWidth: 3, borderLeftColor: sessionColor }}
                        >
                          {/* Header row */}
                          <div
                            className="flex items-center justify-between px-3 pt-2.5 pb-1 cursor-pointer"
                            onClick={toggleExpanded}
                          >
                            <div className="flex items-center gap-2">
                              <span className="text-[9px] font-black uppercase tracking-widest" style={{ color: sessionColor }}>{group.session.name}</span>
                              {group.trades.length > 0 && (
                                <span className={`text-[8px] font-black font-mono ${group.pnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                                  {group.pnl >= 0 ? '+' : ''}${group.pnl.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                                </span>
                              )}
                              <span className="text-[8px] text-slate-400">{group.trades.length} trade{group.trades.length !== 1 ? 's' : ''}</span>
                            </div>
                            <ChevronDown size={12} className={`text-slate-400 transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`} />
                          </div>

                          {/* Visual strip: [analysis screen] [trades] [breakdown screen] */}
                          <div className="flex gap-2 px-3 pb-3 items-stretch">
                            {/* Analysis screenshot */}
                            {group.prepSession?.image && (
                              <div className="relative shrink-0 flex flex-col gap-1">
                                <p className="text-[7px] font-black uppercase text-slate-400 tracking-widest text-center">Analýza</p>
                                <div
                                  className="w-28 h-20 rounded-lg overflow-hidden cursor-pointer border border-white/10"
                                  onClick={(e) => { e.stopPropagation(); setZoomImg(fullSize(group.prepSession!.image!)); }}
                                >
                                  <img src={thumbSmall(group.prepSession.image)} className="w-full h-full object-cover" loading="lazy" />
                                </div>
                              </div>
                            )}

                            {/* Arrow + trades in the middle */}
                            {(group.prepSession?.image || bd?.screenshot) && group.trades.length > 0 && (
                              <div className="flex flex-col justify-center items-center gap-1 px-1 shrink-0">
                                <ChevronRight size={12} className="text-slate-300" />
                              </div>
                            )}
                            {group.trades.length > 0 && (
                              <div className="flex flex-col justify-center gap-1 min-w-0 flex-1">
                                <p className="text-[7px] font-black uppercase text-slate-400 tracking-widest">Trades</p>
                                <div className="flex flex-col gap-1">
                                  {group.trades.map((t, tIdx) => {
                                    const time = new Date(t.timestamp || 0).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
                                    return (
                                      <div key={t.id || tIdx} className={`flex items-center justify-between gap-2 px-2 py-1 rounded-lg ${isDark ? 'bg-white/[0.04]' : 'bg-slate-100'}`}>
                                        <div className="flex items-center gap-1.5 min-w-0">
                                          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${t.pnl >= 0 ? 'bg-emerald-500' : 'bg-rose-500'}`} />
                                          <span className="text-[8px] font-mono text-slate-500 shrink-0">{time}</span>
                                          <span className={`text-[7px] font-black uppercase shrink-0 ${t.direction === 'Long' ? 'text-emerald-500' : 'text-rose-500'}`}>{t.direction}</span>
                                        </div>
                                        <span className={`text-[9px] font-black font-mono shrink-0 ${t.pnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                                          {t.pnl >= 0 ? '+' : ''}${t.pnl.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                                        </span>
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            )}

                            {/* Arrow before breakdown */}
                            {bd?.screenshot && (group.prepSession?.image || group.trades.length > 0) && (
                              <div className="flex flex-col justify-center items-center gap-1 px-1 shrink-0">
                                <ChevronRight size={12} className="text-slate-300" />
                              </div>
                            )}

                            {/* Breakdown screenshot */}
                            {bd?.screenshot && (
                              <div className="relative shrink-0 flex flex-col gap-1">
                                <p className="text-[7px] font-black uppercase text-slate-400 tracking-widest text-center">Breakdown</p>
                                <div
                                  className="w-28 h-20 rounded-lg overflow-hidden cursor-pointer border border-white/10"
                                  onClick={(e) => { e.stopPropagation(); setZoomImg(fullSize(bd.screenshot!)); }}
                                >
                                  <img src={thumbSmall(bd.screenshot)} className="w-full h-full object-cover" loading="lazy" />
                                </div>
                              </div>
                            )}
                          </div>

                          {/* Expanded notes */}
                          {isExpanded && bd?.notes?.trim() && (
                            <div className={`px-3 pb-3 pt-1 border-t ${isDark ? 'border-white/5' : 'border-slate-100'}`}>
                              <p className={`text-[11px] leading-relaxed italic ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>"{bd.notes}"</p>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Expanded — sessions side by side with prep info + trades + breakdown */}
                {isBreakdownExpanded && (
                  <div className={`mt-6 grid gap-4 ${sessionGroups.length >= 3 ? 'grid-cols-1 sm:grid-cols-3' : sessionGroups.length === 2 ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1'}`}>
                    {sessionGroups.map(group => {
                      const sessionColor = group.session.color || '#6366f1';
                      return (
                        <div
                          key={group.session.id}
                          className={`rounded-2xl border p-4 flex flex-col ${
                            isDark ? 'bg-white/[0.02] border-white/10' : 'bg-slate-50/50 border-slate-200'
                          }`}
                          style={{ borderTopWidth: 3, borderTopColor: sessionColor }}
                        >
                          {/* Session header */}
                          <div className="flex items-center justify-between mb-3">
                            <div className="flex items-center gap-2">
                              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: sessionColor }} />
                              <span className="text-[10px] font-black uppercase tracking-widest" style={{ color: sessionColor }}>
                                {group.session.name}
                              </span>
                            </div>
                            {group.trades.length > 0 && (
                              <span className={`text-[10px] font-black font-mono ${group.pnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                                ${group.pnl.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                              </span>
                            )}
                          </div>

                          {/* Prep screenshot + plan */}
                          {group.prepSession?.image && (
                            <div
                              className="aspect-video rounded-xl overflow-hidden border border-white/5 mb-3 cursor-pointer relative group/prepimg"
                              onClick={() => setZoomImg(fullSize(group.prepSession.image))}
                            >
                              <img src={thumbMedium(group.prepSession.image)} className="w-full h-full object-cover" loading="lazy" />
                              <div className="absolute inset-0 bg-black/40 opacity-0 group-hover/prepimg:opacity-100 flex items-center justify-center transition-all">
                                <Maximize2 size={14} className="text-white" />
                              </div>
                              <div className="absolute top-1.5 left-1.5 px-1.5 py-0.5 bg-black/60 backdrop-blur-md rounded-lg border border-white/10">
                                <p className="text-[6px] font-black text-white tracking-widest">PREP</p>
                              </div>
                            </div>
                          )}
                          {group.prepSession?.plan && (
                            <p className={`text-[9px] leading-relaxed italic mb-3 ${isDark ? 'text-slate-400' : 'text-slate-600'} line-clamp-3`}>
                              "{group.prepSession.plan}"
                            </p>
                          )}

                          {/* Compact trade list */}
                          {group.trades.length > 0 && (
                            <div className="space-y-1 mb-3">
                              <span className="text-[8px] font-black uppercase text-slate-500 tracking-widest">Obchody</span>
                              {group.trades.map((trade, tIdx) => {
                                const d = new Date(trade.timestamp || 0);
                                const time = d.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
                                return (
                                  <div
                                    key={trade.id || tIdx}
                                    className={`flex items-center justify-between px-2 py-1.5 rounded-lg ${
                                      isDark ? 'bg-white/[0.03]' : 'bg-white'
                                    }`}
                                  >
                                    <div className="flex items-center gap-1.5">
                                      <span className={`w-1.5 h-1.5 rounded-full ${trade.pnl >= 0 ? 'bg-emerald-500' : 'bg-rose-500'}`} />
                                      <span className="text-[8px] font-mono text-slate-500">{time}</span>
                                      <span className={`px-1 py-0.5 rounded text-[6px] font-black uppercase ${
                                        trade.pnl >= 0 ? 'bg-emerald-500/10 text-emerald-500' : 'bg-rose-500/10 text-rose-500'
                                      }`}>{trade.direction}</span>
                                    </div>
                                    <span className={`text-[10px] font-black font-mono ${trade.pnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                                      ${trade.pnl.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                                    </span>
                                  </div>
                                );
                              })}
                            </div>
                          )}

                          {/* Breakdown textarea — pushed to bottom */}
                          {onUpdateBreakdown && (
                            <div className="mt-auto">
                              <BreakdownCard
                                session={group.session}
                                breakdown={group.breakdown}
                                theme={theme}
                                onUpdate={(notes, screenshot) => onUpdateBreakdown(group.session.id, group.session.name, notes, screenshot)}
                                onZoomImg={setZoomImg}
                              />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ====== REVIEW CARD ====== */}
        <div className="relative flex items-center">
          <div className={`absolute ${isMini ? 'left-4' : 'left-10'} -translate-x-1/2 ${isMini ? 'w-1.5 h-1.5' : 'w-4 h-4'} rounded-full border-2 flex items-center justify-center transition-all duration-500 bg-indigo-600 border-black/50`}>
            {!isMini && <div className="absolute -top-6 text-[9px] font-black uppercase text-slate-500 tracking-widest whitespace-nowrap">18:00</div>}
          </div>
          <div className={`relative z-[1] w-full ${isMini ? 'pl-7' : 'pl-16 lg:pl-16'}`}>
            <div className={`${padding} ${rounded} border transition-all ${review ? (isDark ? 'bg-indigo-600/5 border-indigo-500/20 shadow-lg shadow-indigo-500/5' : 'bg-indigo-50 border-indigo-200 shadow-sm') : (isDark ? 'bg-[var(--bg-card)] border-[var(--border-subtle)]' : 'bg-white border-slate-200')}`}>
              {/* Header — click to expand/collapse */}
              <div
                className="flex items-center justify-between gap-2 cursor-pointer"
                onClick={() => canInlineEdit ? setIsReviewExpanded(!isReviewExpanded) : onEditReview()}
              >
                <div className="flex items-center gap-1.5 min-w-0 flex-1">
                  <div className={`${isMini ? 'p-1' : 'p-2'} rounded-lg bg-indigo-600/10 text-indigo-500 flex-shrink-0`}><Moon size={iconSize} /></div>
                  <div className="min-w-0">
                    <h4 className={`${textTitle} font-black uppercase tracking-widest`}>Večerní Audit</h4>
                    {review && !review.completed && !isMini && (
                      <span className="inline-block mt-0.5 px-2 py-0.5 rounded-md text-[7px] font-black uppercase bg-amber-500/10 text-amber-500 border border-amber-500/20">Rozpracováno</span>
                    )}
                    {isMini && <span className="text-[6px] text-slate-600 font-mono">18:00</span>}
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {!isMini && isReviewExpanded && isSaving && (
                    <div className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-blue-500/10 text-blue-500 animate-pulse">
                      <div className="w-1.5 h-1.5 rounded-full bg-blue-500" />
                      <span className="text-[8px] font-black uppercase tracking-widest">Ukládám...</span>
                    </div>
                  )}
                  {!isMini && isReviewExpanded && !isSaving && lastSaved && (
                    <div className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-emerald-500/10 text-emerald-500">
                      <Check size={10} />
                      <span className="text-[8px] font-black uppercase tracking-widest">{lastSaved.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    </div>
                  )}
                  {review && onDeleteReview && !isMini && (
                    <button onClick={(e) => { e.stopPropagation(); setIsDeletingReview(true); }} className="p-1 hover:bg-rose-500/10 text-slate-400 hover:text-rose-500 rounded-lg transition-all" title="Smazat audit">
                      <Trash2 size={12} />
                    </button>
                  )}
                  {canInlineEdit && <ChevronDown size={16} className={`text-slate-500 transition-transform duration-300 ${isReviewExpanded ? 'rotate-180' : ''}`} />}
                </div>
              </div>

              {/* Collapsed — preview */}
              {!isReviewExpanded && review && (
                <div className={`mt-3 ${isMini ? 'space-y-1' : 'space-y-3'}`}>
                  <div className={`${isMini ? 'p-1.5' : 'p-3'} rounded-xl border ${isDark ? 'bg-[var(--bg-input)] border-[var(--border-subtle)]' : 'bg-slate-50 border-slate-100'}`}>
                    <p className="text-[7px] font-black uppercase text-slate-500">PnL</p>
                    <p className={`${isMini ? 'text-[10px]' : 'text-sm'} font-black font-mono ${dayStats && dayStats.pnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                      ${dayStats?.pnl.toLocaleString(undefined, { maximumFractionDigits: 0 }) || '0'}
                    </p>
                  </div>
                  {isMini && <p className="text-[6px] text-slate-600 font-mono text-right">18:00</p>}
                </div>
              )}
              {!isReviewExpanded && !review && (
                <p className={`mt-2 ${isMini ? 'text-[7px]' : 'text-sm'} text-slate-500 italic`}>Udělej reflexi...</p>
              )}

              {/* Expanded — inline editing form */}
              {isReviewExpanded && canInlineEdit && reviewForm && (
                <div className="mt-6 space-y-6">
                  {/* Execution audit — rule adherence */}
                  {tradeRules && tradeRules.length > 0 && (
                    <div>
                      <div className="flex items-center gap-2 mb-3">
                        <ShieldAlert size={14} className="text-amber-500" />
                        <span className="text-[10px] font-black uppercase tracking-widest text-slate-500">Dodržení pravidel</span>
                      </div>
                      <div className="grid grid-cols-2 lg:grid-cols-3 gap-2">
                        {tradeRules.map(rule => {
                          const comp = reviewForm.ruleAdherence?.find(a => a.ruleId === rule.id);
                          const status = comp?.status || 'Pending';
                          return (
                            <div key={rule.id} className={`p-3 rounded-xl border flex flex-col justify-between gap-2 ${isDark ? 'bg-[var(--bg-page)]/50 border-[var(--border-subtle)]' : 'bg-slate-50 border-slate-200'}`}>
                              <h4 className="text-[8px] font-black uppercase tracking-widest leading-tight line-clamp-2">{rule.label}</h4>
                              <div className="flex gap-1.5">
                                <button
                                  onClick={() => handleSetRuleStatus(rule.id, 'Pass')}
                                  className={`flex-1 py-1.5 rounded-lg font-black text-[7px] uppercase tracking-widest transition-all ${status === 'Pass' ? 'bg-emerald-600 text-white' : (isDark ? 'bg-[var(--bg-card)] text-slate-500 hover:bg-white/5' : 'bg-white text-slate-400 hover:bg-slate-100')}`}
                                >Pass</button>
                                <button
                                  onClick={() => handleSetRuleStatus(rule.id, 'Fail')}
                                  className={`flex-1 py-1.5 rounded-lg font-black text-[7px] uppercase tracking-widest transition-all ${status === 'Fail' ? 'bg-rose-600 text-white' : (isDark ? 'bg-[var(--bg-card)] text-slate-500 hover:bg-white/5' : 'bg-white text-slate-400 hover:bg-slate-100')}`}
                                >Fail</button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Weekly Focus */}
                  {currentWeekFocus && (
                    <div className={`p-4 rounded-2xl border ${isDark ? 'bg-emerald-500/5 border-emerald-500/10' : 'bg-emerald-50 border-emerald-100'}`}>
                      <div className="flex items-center gap-2 mb-3">
                        <ClipboardCheck size={14} className="text-emerald-500" />
                        <span className="text-[10px] font-black uppercase tracking-widest text-emerald-500">Weekly Focus</span>
                      </div>
                      <div className="space-y-1.5">
                        {currentWeekFocus.goals.map((goal, idx) => {
                          const adherence = reviewForm.weeklyGoalAdherence?.[idx]?.status === 'Pass';
                          return (
                            <button
                              key={idx}
                              onClick={() => {
                                editReviewForm!(prev => {
                                  const newList = [...((prev as DailyReview).weeklyGoalAdherence || [])];
                                  while (newList.length <= idx) newList.push({ ruleId: `wf_${idx}`, status: 'Pending' });
                                  newList[idx] = { ruleId: `wf_${idx}`, status: adherence ? 'Pending' : 'Pass' };
                                  return { ...prev, weeklyGoalAdherence: newList };
                                });
                              }}
                              className={`w-full px-3 py-2 rounded-xl border flex items-center justify-between transition-all ${adherence ? 'bg-emerald-500 text-white border-emerald-400' : (isDark ? 'bg-[var(--bg-input)]/50 border-[var(--border-subtle)]' : 'bg-white border-slate-100')}`}
                            >
                              <div className="flex items-center gap-2">
                                <span className={`text-xs ${adherence ? '' : 'grayscale opacity-50'}`}>{goal.emoji || '🎯'}</span>
                                <span className={`text-[9px] font-black tracking-tight ${adherence ? 'text-white' : 'text-slate-400'}`}>{goal.text}</span>
                              </div>
                              {adherence && <Check size={10} strokeWidth={4} />}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Psycho-cybernetics */}
                  {psychoMetrics && psychoMetrics.length > 0 && (
                    <div>
                      <div className="flex items-center gap-2 mb-3">
                        <Brain size={14} className="text-indigo-500" />
                        <span className="text-[10px] font-black uppercase tracking-widest text-slate-500">Psycho-Cybernetics</span>
                      </div>
                      <div className="grid grid-cols-2 lg:grid-cols-3 gap-2">
                        {psychoMetrics.map(metric => {
                          const value = reviewForm.psycho?.metrics?.[metric.id] || 5;
                          return (
                            <div key={metric.id} className={`p-3 rounded-xl border ${isDark ? 'bg-[var(--bg-page)]/50 border-[var(--border-subtle)]' : 'bg-white border-slate-200'}`}>
                              <div className="flex justify-between items-center mb-2">
                                <label className="text-[8px] font-black uppercase text-slate-500 tracking-widest flex items-center gap-1.5">
                                  <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: metric.color }} />
                                  {metric.label}
                                </label>
                                <span className="text-[9px] font-black text-blue-500">{value}/10</span>
                              </div>
                              <input
                                type="range" min="1" max="10" step="1"
                                value={value}
                                onChange={(e) => {
                                  const newMetrics = { ...reviewForm.psycho?.metrics, [metric.id]: Number(e.target.value) };
                                  editReviewForm!({ ...reviewForm, psycho: { ...reviewForm.psycho!, metrics: newMetrics } });
                                }}
                                className={`w-full h-1.5 rounded-lg appearance-none cursor-pointer ${isDark ? 'bg-[var(--bg-card)]' : 'bg-slate-200'}`}
                                style={{ accentColor: metric.color }}
                              />
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Stressors & Gratitude */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <label className="block text-[9px] font-black uppercase tracking-widest text-rose-500">Stresory & Spouštěče</label>
                        <VoiceMemoButton
                          size="sm"
                          onTranscribed={(t) => {
                            const cur = reviewForm.psycho?.stressors || '';
                            const sep = cur.trim().length > 0 ? '\n\n' : '';
                            editReviewForm!({ ...reviewForm, psycho: { ...reviewForm.psycho!, stressors: cur + sep + t } });
                          }}
                        />
                      </div>
                      <textarea
                        value={reviewForm.psycho?.stressors || ''}
                        onChange={(e) => editReviewForm!({ ...reviewForm, psycho: { ...reviewForm.psycho!, stressors: e.target.value } })}
                        className={`w-full h-20 p-3 rounded-xl border text-[11px] resize-none outline-none focus:ring-2 focus:ring-blue-500/20 transition-all ${isDark ? 'bg-[var(--bg-input)] border-[var(--border-subtle)] text-slate-300 placeholder-slate-600' : 'bg-slate-50 border-slate-200 text-slate-700'}`}
                        placeholder="Co mě rozhodilo?"
                      />
                    </div>
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <label className="block text-[9px] font-black uppercase tracking-widest text-emerald-500">Vděčnost & Radost</label>
                        <VoiceMemoButton
                          size="sm"
                          onTranscribed={(t) => {
                            const cur = reviewForm.psycho?.gratitude || '';
                            const sep = cur.trim().length > 0 ? '\n\n' : '';
                            editReviewForm!({ ...reviewForm, psycho: { ...reviewForm.psycho!, gratitude: cur + sep + t } });
                          }}
                        />
                      </div>
                      <textarea
                        value={reviewForm.psycho?.gratitude || ''}
                        onChange={(e) => editReviewForm!({ ...reviewForm, psycho: { ...reviewForm.psycho!, gratitude: e.target.value } })}
                        className={`w-full h-20 p-3 rounded-xl border text-[11px] resize-none outline-none focus:ring-2 focus:ring-blue-500/20 transition-all ${isDark ? 'bg-[var(--bg-input)] border-[var(--border-subtle)] text-slate-300 placeholder-slate-600' : 'bg-slate-50 border-slate-200 text-slate-700'}`}
                        placeholder="Co se povedlo?"
                      />
                    </div>
                  </div>

                  {/* Personal journal */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <label className="block text-[9px] font-black uppercase tracking-widest text-slate-500">Osobní Deník</label>
                      <VoiceMemoButton
                        size="sm"
                        onTranscribed={(t) => {
                          const cur = reviewForm.psycho?.notes || '';
                          const sep = cur.trim().length > 0 ? '\n\n' : '';
                          editReviewForm!({ ...reviewForm, psycho: { ...reviewForm.psycho!, notes: cur + sep + t } });
                        }}
                      />
                    </div>
                    <div className="flex gap-2 mb-2">
                      <input
                        type="text"
                        value={quickNote}
                        onChange={(e) => setQuickNote(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && addQuickNote()}
                        placeholder="Rychlý zápis..."
                        className={`flex-1 h-8 px-3 rounded-lg border text-[11px] outline-none focus:ring-2 focus:ring-blue-500/20 transition-all ${isDark ? 'bg-[var(--bg-input)] border-[var(--border-subtle)] text-white placeholder-slate-600' : 'bg-slate-50 border-slate-200 text-slate-900'}`}
                      />
                      <button onClick={addQuickNote} className="px-3 bg-blue-600 text-white rounded-lg hover:bg-blue-500 transition-all font-black uppercase text-[8px]">Zapsat</button>
                    </div>
                    <textarea
                      value={reviewForm.psycho?.notes || ''}
                      onChange={(e) => editReviewForm!({ ...reviewForm, psycho: { ...reviewForm.psycho!, notes: e.target.value } })}
                      className={`w-full h-24 p-3 rounded-xl border font-mono text-[10px] leading-relaxed resize-none outline-none focus:ring-2 focus:ring-blue-500/20 transition-all ${isDark ? 'bg-[var(--bg-input)] border-[var(--border-subtle)] text-slate-300 placeholder-slate-600' : 'bg-slate-50 border-slate-200 text-slate-700'}`}
                      placeholder="Proud myšlenek..."
                    />
                  </div>

                  {/* Complete button */}
                  <button
                    onClick={() => {
                      const completedReview = { ...reviewForm, completed: true };
                      editReviewForm?.(completedReview); // sync DailyJournal form state → debounced autosave nenese starý completed: undefined
                      onSaveReview?.(completedReview);
                      setIsReviewExpanded(false);
                    }}
                    className="w-full py-4 bg-indigo-600 text-white rounded-2xl font-black uppercase text-[10px] tracking-widest shadow-xl shadow-indigo-500/20 active:scale-95 transition-all hover:bg-indigo-500"
                  >
                    DOKONČIT REVIEW
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

      </div>

      {zoomImg && (
        <ImageZoomModal src={zoomImg} onClose={() => setZoomImg(null)} />
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
