import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Bot, Plus, Trash2, MessageSquare, ChevronLeft, ChevronDown, Send, Loader2, Sparkles, X, PanelLeftClose, PanelLeftOpen, Headphones, Brain, Zap } from 'lucide-react';
import type { Trade, Account, IronRule, PlaybookItem, DailyPrep, DailyReview, AIConversation, SessionConfig, RuleCompletion, SessionAnalysis } from '../types';
import { streamAIResponse, buildTraderContext, parseAllRefs, prewarmCoachMemory, type AIMessage } from '../services/aiService';
import { storageService } from '../services/storageService';
import { summarizeConversation } from '../services/coachMemoryService';
import { MessageBubble, type ExtendedMessage } from './AICards';
import ConfirmationModal from './ConfirmationModal';
import TradeDetailModal from './TradeDetailModal';
import VoiceMemoButton from './VoiceMemoButton';
import VoiceModeOverlay from './VoiceModeOverlay';
import { enqueueSpeak, cleanForSpeech, cancelSpeech } from '../services/ttsService';
import { COACH_SESSIONS, buildDynamicSessionPrompt } from '../services/coachPrompts';
import { COACH_PERSONAS, resolvePersona, type CoachPersonaSetting, type CoachPersonaId } from '../services/coachPersonas';
import { CoachSessionPreview } from './CoachSessionPreview';

// ─── Session start cards ──────────────────────────────────────────────────────

const SessionStartCards: React.FC<{
  onStart: (mode: 'morning_prep' | 'post_session' | 'evening_review') => void;
}> = ({ onStart }) => {
  return (
    <div className="w-full space-y-2.5">
      <div className="text-[9px] font-black uppercase tracking-widest text-[var(--text-secondary)] text-center mb-1">
        Řízené seance (Live synchronizace)
      </div>
      <div className="grid grid-cols-1 gap-2">
        <button
          onClick={() => onStart('morning_prep')}
          className="flex items-center gap-3 p-3 text-left rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] hover:border-blue-500/40 hover:bg-blue-500/5 transition-all group cursor-pointer"
        >
          <div className="w-9 h-9 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400 group-hover:scale-105 transition-transform flex-shrink-0 text-lg">
            ☕
          </div>
          <div className="flex-1 min-w-0">
            <h4 className="text-[11px] font-black text-[var(--text-primary)]">Spustit Ranní přípravu</h4>
            <p className="text-[9px] text-[var(--text-secondary)] leading-normal mt-0.5">Rituály, bias, scénáře a denní cíle před startem trhu.</p>
          </div>
        </button>

        <button
          onClick={() => onStart('post_session')}
          className="flex items-center gap-3 p-3 text-left rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] hover:border-amber-500/40 hover:bg-amber-500/5 transition-all group cursor-pointer"
        >
          <div className="w-9 h-9 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400 group-hover:scale-105 transition-transform flex-shrink-0 text-lg">
            📊
          </div>
          <div className="flex-1 min-w-0">
            <h4 className="text-[11px] font-black text-[var(--text-primary)]">Po-obchodní debrief</h4>
            <p className="text-[9px] text-[var(--text-secondary)] leading-normal mt-0.5">Rychlé vyhodnocení pocitů a plánů ihned po seanci (Londýn/NY).</p>
          </div>
        </button>

        <button
          onClick={() => onStart('evening_review')}
          className="flex items-center gap-3 p-3 text-left rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] hover:border-emerald-500/40 hover:bg-emerald-500/5 transition-all group cursor-pointer"
        >
          <div className="w-9 h-9 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400 group-hover:scale-105 transition-transform flex-shrink-0 text-lg">
            🌙
          </div>
          <div className="flex-1 min-w-0">
            <h4 className="text-[11px] font-black text-[var(--text-primary)]">Spustit Večerní audit</h4>
            <p className="text-[9px] text-[var(--text-secondary)] leading-normal mt-0.5">Zhodnocení dne, chyb, cílů a celkového psychologického stavu.</p>
          </div>
        </button>
      </div>
    </div>
  );
};

// ─── Quick prompts ────────────────────────────────────────────────────────────

const QUICK_PROMPTS = [
  'Jaké jsou moje nejčastější chyby?',
  'Ukaž mi 3 nejhorší obchody',
  'Jak vypadala moje poslední příprava?',
  'Ukaž mi poslední audit',
  'Jaký setup mi funguje nejlépe?',
];

// ─── Category helpers ─────────────────────────────────────────────────────────

function detectCategory(text: string): AIConversation['category'] {
  const lower = text.toLowerCase();
  if (
    lower.includes('report') ||
    lower.includes('shrnutí') ||
    lower.includes('měsíc') ||
    lower.includes('týden')
  ) return 'report';
  if (
    lower.includes('analýz') ||
    lower.includes('setup') ||
    lower.includes('pattern') ||
    lower.includes('obchod')
  ) return 'analysis';
  return 'general';
}

const CATEGORY_COLORS: Record<AIConversation['category'], string> = {
  general: 'bg-slate-500/10 text-slate-400 border-slate-500/20',
  analysis: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  report: 'bg-violet-500/10 text-violet-400 border-violet-500/20',
};

const CATEGORY_LABELS: Record<AIConversation['category'], string> = {
  general: 'Obecné',
  analysis: 'Analýza',
  report: 'Report',
};

// ─── Date grouping ─────────────────────────────────────────────────────────────

function getDateGroup(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const weekAgo = new Date(today.getTime() - 7 * 86400000);
  const convDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  if (convDate.getTime() === today.getTime()) return 'Dnes';
  if (convDate.getTime() === yesterday.getTime()) return 'Včera';
  if (convDate.getTime() > weekAgo.getTime()) return 'Tento týden';
  return 'Starší';
}

function formatRelativeDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const convDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  if (convDate.getTime() === today.getTime())
    return date.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
  if (convDate.getTime() === yesterday.getTime()) return 'Včera';
  return date.toLocaleDateString('cs-CZ', { day: '2-digit', month: '2-digit' });
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  trades: Trade[];
  accounts: Account[];
  ironRules: IronRule[];
  /** Aktuální seznam standardGoals — pro derivovaný "applied" stav v ActionPanelu */
  standardGoals?: string[];
  playbookItems: PlaybookItem[];
  dailyPreps: DailyPrep[];
  dailyReviews: DailyReview[];
  sessions?: SessionConfig[];
  theme?: string;
  onOpenTrade?: (trade: Trade) => void;
  onOpenJournal?: (date: string) => void;
  initialConversationId?: string;
  /** When set on mount (and no initialConversationId), creates a new conversation and sends this prompt as the first message. */
  initialPrompt?: string;
  /** Called after `initialPrompt` is consumed so the parent can clear it. */
  onInitialPromptConsumed?: () => void;
  /** Klik na "Přidat" v action card v Coach response. Parent rozhodne co se stane (přidá rule / cíl / atd.) */
  onApplyAction?: (action: import('../services/aiService').SuggestedAction) => void;
  /** Reportuje rodičovi (App.tsx), zda coach právě streamuje — pro nav warning modal. */
  onStreamingChange?: (isStreaming: boolean) => void;
  /** Aktuální mód dashboardu — 'backtesting' automaticky přepne coach scope. */
  dashboardMode?: string;
}

// ─── Main component ───────────────────────────────────────────────────────────

const AICoachPage: React.FC<Props> = ({
  trades, accounts, ironRules, standardGoals, playbookItems,
  dailyPreps, dailyReviews, theme,
  onOpenTrade, onOpenJournal, onApplyAction,
  initialConversationId, initialPrompt, onInitialPromptConsumed,
  onStreamingChange, sessions = [], dashboardMode
}) => {
  // Init z globálního cache (persisted v localStorage) — žádný flash prázdného seznamu po reloadu.
  // useEffect níž pak refresh z DB na pozadí.
  const [conversations, setConversations] = useState<AIConversation[]>(
    () => storageService.getCachedConversations()
  );
  const [activeConvId, setActiveConvId] = useState<string | null>(initialConversationId ?? null);
  const [messages, setMessages] = useState<ExtendedMessage[]>([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [toolStatus, setToolStatus] = useState<string | null>(null);
  const [activeSessionMode, setActiveSessionMode] = useState<'morning_prep' | 'post_session' | 'evening_review' | null>(() => {
    try {
      const savedSessionStr = localStorage.getItem('active_coach_session');
      if (savedSessionStr) {
        const saved = JSON.parse(savedSessionStr);
        const todayStr = new Date().toLocaleDateString('en-CA');
        if (
          saved.conversationId === (initialConversationId ?? null) &&
          (saved.formState?.date === todayStr || saved.formState?.sessionId)
        ) {
          return saved.mode;
        }
      }
    } catch {}
    return null;
  });

  const [sessionFormState, setSessionFormState] = useState<any>(() => {
    try {
      const savedSessionStr = localStorage.getItem('active_coach_session');
      if (savedSessionStr) {
        const saved = JSON.parse(savedSessionStr);
        const todayStr = new Date().toLocaleDateString('en-CA');
        if (
          saved.conversationId === (initialConversationId ?? null) &&
          (saved.formState?.date === todayStr || saved.formState?.sessionId)
        ) {
          return saved.formState;
        }
      }
    } catch {}
    return null;
  });

  const [isSavingSession, setIsSavingSession] = useState(false);
  const [activeSessionTab, setActiveSessionTab] = useState<'chat' | 'preview'>('chat');
  const [aiModel, setAiModel] = useState<'analytical' | 'fast'>(() => {
    try {
      const saved = localStorage.getItem('alphatrade_ai_model');
      return (saved as 'analytical' | 'fast') || 'analytical';
    } catch {
      return 'analytical';
    }
  });

  // Persona coache (osobnost/tón) — nezávislá osa na modelu. 'auto' = vybere se dle kontextu.
  const [coachPersona, setCoachPersona] = useState<CoachPersonaSetting>(() => {
    try {
      const saved = localStorage.getItem('alphatrade_coach_persona');
      return (saved as CoachPersonaSetting) || 'auto';
    } catch {
      return 'auto';
    }
  });
  const [showPersonaDropdown, setShowPersonaDropdown] = useState(false);
  const personaDropdownRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    try { localStorage.setItem('alphatrade_coach_persona', coachPersona); } catch { /* no-op */ }
  }, [coachPersona]);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (personaDropdownRef.current && !personaDropdownRef.current.contains(e.target as Node)) {
        setShowPersonaDropdown(false);
      }
    };
    if (showPersonaDropdown) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showPersonaDropdown]);

  const isTodayWeekend = useMemo(() => {
    const d = new Date();
    const day = d.getDay();
    return day === 0 || day === 6;
  }, []);

  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const modelDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(event.target as Node)) {
        setShowModelDropdown(false);
      }
    };
    if (showModelDropdown) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showModelDropdown]);

  const sessionConvIdRef = useRef<string | null>(initialConversationId ?? null);
  // Když právě startuje seance (handleStartSession), drží convId — [activeConvId]
  // effect pak NEresetuje activeSessionMode na null (jinak by formulář zmizel).
  const sessionStartingRef = useRef<string | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem('alphatrade_ai_model', aiModel);
    } catch (e) {
      console.warn('[AICoachPage] Failed to save AI model choice:', e);
    }
  }, [aiModel]);

  // Sync state on conversation change
  useEffect(() => {
    // Právě startuje seance pro tuhle konverzaci → handleStartSession nastavuje
    // activeSessionMode/sessionFormState sám, NEresetuj je (jinak formulář zmizí).
    if (sessionStartingRef.current && sessionStartingRef.current === activeConvId) {
      sessionStartingRef.current = null;
      sessionConvIdRef.current = activeConvId;
      return;
    }
    try {
      const savedSessionStr = localStorage.getItem('active_coach_session');
      if (savedSessionStr) {
        const saved = JSON.parse(savedSessionStr);
        const todayStr = new Date().toLocaleDateString('en-CA');
        if (
          saved.conversationId === activeConvId &&
          (saved.formState?.date === todayStr || saved.formState?.sessionId)
        ) {
          sessionConvIdRef.current = activeConvId;
          setActiveSessionMode(saved.mode);
          setSessionFormState(saved.formState);
          return;
        }
      }
    } catch (e) {
      console.warn('[AICoachPage] Failed to parse saved session:', e);
    }
    sessionConvIdRef.current = activeConvId;
    setActiveSessionMode(null);
    setSessionFormState(null);
  }, [activeConvId]);

  // Persist session state to localStorage on changes
  useEffect(() => {
    if (!activeConvId || sessionConvIdRef.current !== activeConvId) return;
    
    try {
      if (activeSessionMode && sessionFormState) {
        const payload = {
          conversationId: activeConvId,
          mode: activeSessionMode,
          formState: sessionFormState
        };
        localStorage.setItem('active_coach_session', JSON.stringify(payload));
      } else {
        const savedSessionStr = localStorage.getItem('active_coach_session');
        if (savedSessionStr) {
          const saved = JSON.parse(savedSessionStr);
          if (saved.conversationId === activeConvId) {
            localStorage.removeItem('active_coach_session');
          }
        }
      }
    } catch (e) {
      console.warn('[AICoachPage] Failed to save active session:', e);
    }
  }, [activeSessionMode, sessionFormState, activeConvId]);

  const handleModelChange = (model: 'analytical' | 'fast') => {
    if (aiModel === model) return;
    setAiModel(model);

    if (activeConvId) {
      const systemMessage: ExtendedMessage = {
        role: 'assistant',
        content: '',
        isSystemEvent: true,
        systemEventText: model === 'fast'
          ? 'Přepnuto na Rychlého kouče (Haiku 4.5)'
          : 'Přepnuto na Analytického kouče (Sonnet 4.6)'
      };
      setMessages(prev => [...prev, systemMessage]);
    }
  };

  // Nahřej memory cache (profil/závazky/summaries) hned při otevření stránky —
  // první zpráva pak nečeká na 3 DB roundtripy.
  useEffect(() => { prewarmCoachMemory(); }, []);
  // Warning modal — pokud user mění konverzaci (nebo zakládá novou) během streamu.
  // Stejný princip jako navigace v App.tsx: stream se odpojí → odpověď zmizí.
  const [pendingConvAction, setPendingConvAction] = useState<(() => void) | null>(null);
  const [mobileView, setMobileView] = useState<'list' | 'chat'>(initialConversationId ? 'chat' : 'list');
  const [loadingConv, setLoadingConv] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [openTrade, setOpenTrade] = useState<Trade | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [voiceModeOpen, setVoiceModeOpen] = useState(false);

  // Proactive greeting state: Coach generates a personalized greeting + 3 suggested topics
  // when user opens AI Coach without an active conversation.
  const [proactive, setProactive] = useState<{ greeting: string; suggestions: string[] } | null>(null);
  const [loadingProactive, setLoadingProactive] = useState(false);
  const proactiveFetchedRef = useRef(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea — roste s obsahem (jako Claude/ChatGPT). Scrollbar
  // až po překročení max výšky (~50vh) pro fakt extrémní texty.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  // ─── AI Seance Cockpit Handlers ──────────────────────────────────────────────
  const handleStartSession = async (mode: 'morning_prep' | 'post_session' | 'evening_review') => {
    let convId = activeConvId;
    const todayStr = new Date().toLocaleDateString('en-CA');
    
    // Generování čitelného českého data pro titulek
    const dateParts = todayStr.split('-');
    const czDateStr = `${dateParts[2]}.${dateParts[1]}.`;
    const title = mode === 'morning_prep'
      ? `☕ Ranní příprava (${czDateStr})`
      : mode === 'evening_review'
      ? `🌙 Večerní audit (${czDateStr})`
      : `📊 Debrief seance (${czDateStr})`;
    const category = mode === 'morning_prep' ? 'general' : mode === 'evening_review' ? 'report' : 'analysis';

    if (!convId) {
      try {
        const conv = await storageService.createConversation(title, coachScope);
        if (conv) {
          await storageService.updateConversation(conv.id, { title, category });
          conv.title = title;
          conv.category = category;
          justCreatedConvIdsRef.current.add(conv.id);
          setConversations(prev => [conv, ...prev]);
          setActiveConvId(conv.id);
          convId = conv.id;
          setMobileView('chat');
        }
      } catch (e) {
        console.error('[AICoachPage] failed to create conversation for session:', e);
        alert('Nepodařilo se zahájit seanci. Zkuste to prosím znovu.');
        return;
      }
    } else {
      try {
        await storageService.updateConversation(convId, { title, category });
        setConversations(prev => prev.map(c => c.id === convId ? { ...c, title, category } : c));
      } catch (e) {
        console.warn('[AICoachPage] failed to update conversation title for session:', e);
      }
    }

    // Označ, že pro tuhle konverzaci právě startuje seance → [activeConvId] effect
    // pak activeSessionMode nepřepíše na null.
    if (convId) sessionStartingRef.current = convId;
    setActiveSessionMode(mode);
    setActiveSessionTab('chat');

    if (mode === 'morning_prep') {
      const existingPrep = dailyPreps.find(p => p.date === todayStr);
      const configSessions = (sessions && sessions.length > 0) ? sessions : [
        { id: 'asia', name: 'Asia', startTime: '02:00', endTime: '08:00', color: '#64748b' },
        { id: 'london', name: 'London', startTime: '09:00', endTime: '16:00', color: '#3b82f6' },
        { id: 'ny', name: 'New York', startTime: '15:30', endTime: '22:00', color: '#f97316' }
      ];
      const rituals = ironRules.filter(r => r.type === 'ritual');

      let initialRitualCompletions: RuleCompletion[] = rituals.map(r => ({ ruleId: r.id, status: 'Pending' as const, label: r.label }));
      let initialSessions: SessionAnalysis[] = configSessions.map(s => ({ id: s.id, label: s.name, color: s.color, plan: '', image: '', bias: 'Neutral' as const }));

      if (existingPrep) {
        if (existingPrep.ritualCompletions) {
          initialRitualCompletions = rituals.map(r => {
            const ext = existingPrep.ritualCompletions?.find(c => c.ruleId === r.id);
            return {
              ruleId: r.id,
              status: ext?.status || 'Pending',
              label: r.label
            };
          });
        }
        if (existingPrep.scenarios?.sessions) {
          initialSessions = configSessions.map(s => {
            const ext = existingPrep.scenarios.sessions?.find(x => x.id === s.id);
            return {
              id: s.id,
              label: s.name,
              color: s.color,
              plan: ext?.plan || '',
              image: ext?.image || '',
              bias: ext?.bias || 'Neutral'
            };
          });
        }
      }

      setSessionFormState({
        id: existingPrep?.id || `prep-${todayStr}`,
        date: todayStr,
        sleepHours: (existingPrep as any)?.sleepHours ?? null,
        sleptWell: existingPrep?.checklist?.sleptWell ?? true,
        planReady: existingPrep?.checklist?.planReady ?? false,
        newsChecked: existingPrep?.checklist?.newsChecked ?? false,
        disciplineCommitted: existingPrep?.checklist?.disciplineCommitted ?? false,
        bias: existingPrep?.bias || 'Neutral',
        goals: existingPrep?.goals || [],
        confidence: existingPrep?.confidence ?? 50,
        ritualCompletions: initialRitualCompletions,
        scenarios: {
          ...(existingPrep?.scenarios || {}),
          sessions: initialSessions
        },
        committedRuleIds: (existingPrep as any)?.committedRuleIds || [],
        mindsetState: existingPrep?.mindsetState || '',
        dailyFocus: (existingPrep as any)?.dailyFocus || ''
      });
    } else if (mode === 'evening_review') {
      const existingReview = dailyReviews.find(r => r.date === todayStr);
      let goalsList: string[] = [];
      try {
        const preps = await storageService.getDailyPreps();
        const todayPrep = preps.find(p => p.date === todayStr);
        if (todayPrep?.goals) goalsList = todayPrep.goals;
      } catch (e) {
        console.warn('[AICoachPage] failed to load today prep for goals:', e);
      }
      
      const tradingRules = ironRules.filter(r => r.type === 'trading');
      let initialRuleAdherence: RuleCompletion[] = tradingRules.map(r => ({ ruleId: r.id, status: 'Pending' as const, label: r.label }));

      if (existingReview) {
        if (existingReview.ruleAdherence) {
          initialRuleAdherence = tradingRules.map(r => {
            const ext = existingReview.ruleAdherence?.find(c => c.ruleId === r.id);
            return {
              ruleId: r.id,
              status: ext?.status || 'Pending',
              label: r.label
            };
          });
        }
      }

      setSessionFormState({
        id: existingReview?.id || `review-${todayStr}`,
        date: todayStr,
        rating: existingReview?.rating ?? 3,
        mainTakeaway: existingReview?.mainTakeaway || '',
        lessons: existingReview?.lessons || '',
        mistakes: existingReview?.mistakes || [],
        scenarioResult: existingReview?.scenarioResult || 'Neutral',
        goalResults: existingReview?.goalResults || goalsList.map(g => ({ text: g, achieved: false })),
        psycho: {
          stressors: existingReview?.psycho?.stressors || '',
          gratitude: existingReview?.psycho?.gratitude || '',
          notes: existingReview?.psycho?.notes || ''
        },
        ruleAdherence: initialRuleAdherence,
        // Rozbor po seancích — předvyplníme z konfigurace seancí (notes z existujícího auditu).
        sessionBreakdowns: ((sessions && sessions.length > 0)
          ? sessions
          : [{ id: 'london', name: 'London' }, { id: 'ny', name: 'New York' }, { id: 'asia', name: 'Asia' }]
        ).map((s: any) => {
          const ext = existingReview?.sessionBreakdowns?.find(b => b.sessionId === s.id);
          return { sessionId: s.id, sessionLabel: s.name, notes: ext?.notes || '', ...(ext?.screenshot ? { screenshot: ext.screenshot } : {}) };
        })
      });
    } else if (mode === 'post_session') {
      const existingReview = dailyReviews.find(r => r.date === todayStr);
      let sessionNotes = '';
      let sessionId: 'london' | 'ny' | 'asia' = 'ny';
      if (existingReview && existingReview.sessionBreakdowns) {
        const bd = existingReview.sessionBreakdowns.find(b => b.sessionId === 'ny');
        if (bd) {
          sessionNotes = bd.notes || '';
          sessionId = bd.sessionId as 'london' | 'ny' | 'asia';
        }
      }
      setSessionFormState({
        sessionId,
        notes: sessionNotes
      });
    }

    setMessages([]);
    firstMessageSentRef.current = false;

    const welcomeText = mode === 'morning_prep'
      ? `Ahoj Filipe! Vítám tě u Ranní přípravy. Než se vrhneme na dnešek — mrkni, jak ti šel poslední den a co sis vzal jako lekci. Pojďme nastavit dnešek tak, ať na to navážeš. Jak to vypadá s ranními rituály a jaký máš dnes hlavní cíl?`
      : mode === 'evening_review'
      ? `Vítej u Večerního auditu, Filipe. Pojďme v klidu projít dnešek — co se povedlo, co zabolelo a co si z toho odneseš. Jak bys den ohodnotil od 1 do 5 a co byl tvůj hlavní poznatek?`
      : `Debrief seance, ať to máme čerstvé. Kterou seanci vyhodnocujeme (Londýn / New York / Asia) a jak na tom byla hlava během čekání na vstupy?`;

    const assistantMsg: ExtendedMessage = { role: 'assistant', content: welcomeText, aiModel };
    setMessages([assistantMsg]);

    if (convId) {
      storageService.appendMessage(convId, 'assistant', welcomeText)
        .catch(err => console.error('[AICoachPage] failed to save greeting:', err));
    }
  };

  const handleSaveSession = async () => {
    if (!sessionFormState || !activeSessionMode) return;
    setIsSavingSession(true);
    try {
      const todayStr = new Date().toLocaleDateString('en-CA');
      
      if (activeSessionMode === 'morning_prep') {
        const preps = await storageService.getDailyPreps();
        const existing = preps.find(p => p.date === todayStr);
        const prep: DailyPrep = {
          confidence: 50,
          checklist: {
            sleptWell: true,
            planReady: false,
            disciplineCommitted: false,
            newsChecked: false
          },
          scenarios: {
            bullish: '',
            bearish: '',
            sessions: []
          },
          ...(existing || {}),
          id: existing?.id || sessionFormState.id || `prep-${todayStr}`,
          date: todayStr,
          bias: existing?.bias || 'Neutral',
          goals: sessionFormState.goals || existing?.goals || [],
          ritualCompletions: sessionFormState.ritualCompletions || existing?.ritualCompletions || [],
          committedRuleIds: sessionFormState.committedRuleIds || (existing as any)?.committedRuleIds || [],
          mindsetState: sessionFormState.mindsetState || existing?.mindsetState || '',
          dailyFocus: sessionFormState.dailyFocus || (existing as any)?.dailyFocus || '',
          completed: true
        } as any;
        await storageService.saveSinglePrep(prep);
        
      } else if (activeSessionMode === 'evening_review') {
        const reviews = await storageService.getDailyReviews();
        const existing = reviews.find(r => r.date === todayStr);
        const review: DailyReview = {
          ...(existing || {}),
          id: existing?.id || sessionFormState.id || `review-${todayStr}`,
          date: todayStr,
          mainTakeaway: sessionFormState.mainTakeaway || '',
          lessons: sessionFormState.lessons || '',
          mistakes: sessionFormState.mistakes || [],
          rating: sessionFormState.rating || 3,
          goalResults: sessionFormState.goalResults || [],
          scenarioResult: sessionFormState.scenarioResult || 'Neutral',
          psycho: {
            ...(existing?.psycho || {}),
            stressors: sessionFormState.psycho?.stressors || '',
            gratitude: sessionFormState.psycho?.gratitude || '',
            notes: sessionFormState.psycho?.notes || ''
          },
          ruleAdherence: sessionFormState.ruleAdherence || [],
          // Rozbor po seancích (Londýn/NY/Asia) — z AI auditu nebo zachovej existující.
          sessionBreakdowns: sessionFormState.sessionBreakdowns || existing?.sessionBreakdowns || [],
          completed: true
        };
        await storageService.saveSingleReview(review);
        
      } else if (activeSessionMode === 'post_session') {
        const reviews = await storageService.getDailyReviews();
        let review = reviews.find(r => r.date === todayStr);
        if (!review) {
          review = {
            id: `review-${todayStr}`,
            date: todayStr,
            mainTakeaway: '',
            lessons: '',
            mistakes: [],
            rating: 3,
            completed: false
          };
        }
        
        const sessionLabel = sessionFormState.sessionId === 'london' 
          ? 'London' 
          : sessionFormState.sessionId === 'ny' 
          ? 'New York (NY)' 
          : 'Asia';
          
        const breakdown = {
          sessionId: sessionFormState.sessionId || 'ny',
          sessionLabel,
          notes: sessionFormState.notes || ''
        };
        
        review.sessionBreakdowns = [
          ...(review.sessionBreakdowns || []).filter(b => b.sessionId !== breakdown.sessionId),
          breakdown
        ];
        
        await storageService.saveSingleReview(review);
      }
      
      const modeLabel = COACH_SESSIONS[activeSessionMode]?.label || 'Seance';
      const confirmationMsg: ExtendedMessage = {
        role: 'assistant',
        content: '',
        isSystemEvent: true,
        systemEventText: `✅ ${modeLabel} byla úspěšně dokončena a uložena do tvého deníku.`
      };
      
      setMessages(prev => [...prev, confirmationMsg]);
      setActiveSessionMode(null);
      setSessionFormState(null);
    } catch (e) {
      console.error('[AICoachPage] Failed to save session:', e);
      alert('Chyba při ukládání seance do deníku.');
    } finally {
      setIsSavingSession(false);
    }
  };

  // Real-time parsing of form_state comments
  useEffect(() => {
    if (messages.length === 0 || !activeSessionMode) return;
    const lastMsg = messages[messages.length - 1];
    if (lastMsg && lastMsg.role === 'assistant') {
      const match = lastMsg.content.match(/<!--\s*form_state:\s*([\s\S]*?)\s*-->/);
      if (match && match[1]) {
        try {
          const parsed = JSON.parse(match[1].trim());
          setSessionFormState((prev: any) => {
            if (!prev) return parsed;
            const isDifferent = JSON.stringify(prev) !== JSON.stringify({ ...prev, ...parsed });
            return isDifferent ? { ...prev, ...parsed } : prev;
          });
        } catch (e) {
          // Incomplete JSON during stream typing — ignore
        }
      }
    }
  }, [messages, activeSessionMode]);

  // ─── Stick-to-bottom scroll chování (jako Claude.ai / ChatGPT) ───────────
  // Když je user "u dna" (< 80px od konce), auto-scroll je aktivní.
  // Když odscroluje nahoru, auto-scroll se vypne — user může číst v klidu.
  // Když znovu doscroluje na konec, auto-scroll se obnoví.
  const STICK_THRESHOLD_PX = 80;
  const isAtBottomRef = useRef(true); // tracking flag — má auto-scroll sledovat dno?
  const lastScrollTopRef = useRef(0); // poslední scrollTop — pro detekci směru scrollu
  const [showScrollToBottom, setShowScrollToBottom] = useState(false); // UI state pro floating tlačítko

  const isNearBottom = useCallback((el: HTMLElement | null): boolean => {
    if (!el) return true;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    return distanceFromBottom <= STICK_THRESHOLD_PX;
  }, []);

  // User scroll handler — sledování dna vypneme JEN když user reálně odscrolluje
  // NAHORU (scrollTop klesl). Když obsah jen roste / lerp dohání (scrollTop stoupá
  // nebo stojí), sledování NEvypínáme — jinak by se to po odeslání zprávy nezaseklo.
  const handleScroll = useCallback(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    const st = el.scrollTop;
    const scrolledUp = st < lastScrollTopRef.current - 2;
    lastScrollTopRef.current = st;
    if (isNearBottom(el)) {
      isAtBottomRef.current = true;   // zpět u dna → zase sleduj
      setShowScrollToBottom(false);
    } else if (scrolledUp) {
      isAtBottomRef.current = false;  // user odscroloval nahoru → přestaň sledovat
      setShowScrollToBottom(true);
    }
  }, [isNearBottom]);

  // Direct scroll — respektuje stick-to-bottom flag (force=true vynutí scroll i když user není u dna)
  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth', force: boolean = false) => {
    const el = messagesContainerRef.current;
    if (!el) return;
    // Pokud user odscroloval a nepřinutíme force, scroll skip
    if (!force && !isAtBottomRef.current) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
    isAtBottomRef.current = true;
  }, []);

  // Whether the first user message has been sent (for auto-titling)
  const firstMessageSentRef = useRef(false);

  // Conversation IDs we just created locally — skip the DB load effect for these to avoid race with streaming
  const justCreatedConvIdsRef = useRef<Set<string>>(new Set());

  // Tracking for auto-summarization on conversation switch / unmount
  const prevConvIdRef = useRef<string | null>(null);
  const prevMessagesRef = useRef<ExtendedMessage[]>([]);
  const summarizedConvsRef = useRef<Set<string>>(new Set());

  // Chunk batching — accumulate streaming chunks and flush to state every ~50ms
  // Reduces React re-renders during streaming (less frame-drop interference with RAF)
  const chunkBufferRef = useRef('');
  const chunkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Notify rodiče (App.tsx) o streaming stavu — používá se pro warning modal
  // při pokusu odejít z AI stránky během streamu (ztratil bys odpověď).
  useEffect(() => {
    onStreamingChange?.(isStreaming);
  }, [isStreaming, onStreamingChange]);

  // ── Scope mentora: live (default) vs backtest ────────────────────────────
  // Tvrdá přepážka — live coach NIKDY nevidí backtest data. Scope se automaticky
  // derivuje z dashboardMode (backtesting → backtest scope) nebo ručně přes /backtest /live.
  const [coachScope, setCoachScope] = useState<'live' | 'backtest'>(
    () => dashboardMode === 'backtesting' ? 'backtest' : 'live'
  );
  // Zrcadlo aktuálního scope pro sync effect — drží poslední hodnotu bez stale closure
  // a bez nutnosti dávat coachScope do deps (jinak by reset proběhl i u manuálního /backtest).
  const coachScopeRef = useRef(coachScope);
  useEffect(() => { coachScopeRef.current = coachScope; }, [coachScope]);

  // Sync scope při přepnutí dashboardMode v Sidebar.
  // setState updater zůstává ČISTÝ; resety + porovnání jsou v těle effectu (ne v updateru),
  // takže se pod StrictMode/concurrent nespustí vedlejší efekty víckrát.
  useEffect(() => {
    const newScope = dashboardMode === 'backtesting' ? 'backtest' : 'live';
    if (coachScopeRef.current === newScope) return;
    coachScopeRef.current = newScope;
    setCoachScope(newScope);
    // Scope se reálně mění (přechod mezi světy) → resetuj aktivní konverzaci.
    setActiveConvId(null);
    setMessages([]);
    firstMessageSentRef.current = false;
  }, [dashboardMode]);
  const backtestAccountIds = React.useMemo(
    () => new Set(accounts.filter(a => a.type === 'Backtest').map(a => String(a.id))),
    [accounts],
  );
  const scopedTrades = React.useMemo(
    () => coachScope === 'backtest'
      ? trades.filter(t => backtestAccountIds.has(String(t.accountId)))
      : trades.filter(t => !backtestAccountIds.has(String(t.accountId))),
    [trades, coachScope, backtestAccountIds],
  );
  const scopedAccounts = React.useMemo(
    () => coachScope === 'backtest'
      ? accounts.filter(a => backtestAccountIds.has(String(a.id)))
      : accounts.filter(a => !backtestAccountIds.has(String(a.id))),
    [accounts, coachScope, backtestAccountIds],
  );
  // daily_preps/daily_reviews = LIVE deník (globální, ne per-account). V backtest
  // scope je coachovi NEdáváme — backtest má vlastní poznámky v backtest_sessions.
  const scopedPreps = coachScope === 'backtest' ? [] : dailyPreps;
  const scopedReviews = coachScope === 'backtest' ? [] : dailyReviews;

  const traderContext = React.useMemo(
    () => buildTraderContext({ trades: scopedTrades, accounts: scopedAccounts, ironRules, playbookItems, dailyPreps: scopedPreps, dailyReviews: scopedReviews }),
    [scopedTrades, scopedAccounts, ironRules, playbookItems, scopedPreps, scopedReviews],
  );

  // Načti backtest session poznámky (bias/pre/post) a naformátuj do bloku pro prompt.
  // Voláno ČERSTVĚ při odeslání zprávy (ne přes effect) — žádný timing race po /backtest.
  const fetchBacktestSessionsText = useCallback(async (): Promise<string> => {
    const accIds = scopedAccounts.map(a => String(a.id));
    if (!accIds.length) return '';
    const sessions = await storageService.getBacktestSessions(accIds);
    if (!sessions.length) return '';
    const lines = sessions
      .sort((a, b) => (a.date + a.block).localeCompare(b.date + b.block))
      .map(s => `${s.date} ${s.block} | bias: ${s.bias || '–'} | pre: ${s.preNotes || '–'} | post: ${s.postNotes || '–'}`);
    return `=== BACKTEST SESSIONS (tvoje pre/post přípravy a audity pro backtest, ${sessions.length}) ===\n${lines.join('\n')}`;
  }, [scopedAccounts]);

  /** Sada labelů již existujících pravidel + cílů — pro ActionPanel "applied" detekci.
   *  Když se label akce shoduje s existujícím pravidlem, tlačítko ukáže ✓ Přidáno
   *  (i po reloadu / přepnutí konverzace). */
  const existingActionLabels = React.useMemo(() => {
    const set = new Set<string>();
    (ironRules || []).forEach(r => { if (r.label) set.add(r.label); });
    (standardGoals || []).forEach(g => set.add(g));
    return set;
  }, [ironRules, standardGoals]);

  // Load conversations on mount
  useEffect(() => {
    storageService.getConversations().then(setConversations);
  }, []);

  // Load messages when active conversation changes
  useEffect(() => {
    if (!activeConvId) {
      setMessages([]);
      firstMessageSentRef.current = false;
      return;
    }
    // Skip DB load for conversations we just created locally — startWithPrompt is already populating messages
    if (justCreatedConvIdsRef.current.has(activeConvId)) {
      justCreatedConvIdsRef.current.delete(activeConvId);
      return;
    }
    setLoadingConv(true);
    storageService.getMessages(activeConvId).then(dbMessages => {
      const mapped: ExtendedMessage[] = dbMessages.map(m => {
        const base: ExtendedMessage = {
          role: m.role as 'user' | 'assistant',
          content: m.content,
        };
        // Rehydratuj karty z markerů v contentu (assistant zprávy)
        if (m.role === 'assistant') {
          const isFast = m.content.includes('<!-- model:fast -->');
          const isAnalytical = m.content.includes('<!-- model:analytical  -->') || m.content.includes('<!-- model:analytical -->');
          base.aiModel = isFast ? 'fast' : (isAnalytical ? 'analytical' : 'analytical');
          const refs = parseAllRefs(m.content);
          if (refs.tradeIds.length) {
            base.tradeCards = refs.tradeIds
              .map(id => trades.find(t => String(t.id) === id))
              .filter(Boolean) as Trade[];
          }
          if (refs.prepDates.length) {
            base.prepCards = refs.prepDates
              .map(d => dailyPreps.find(p => p.date === d))
              .filter(Boolean) as DailyPrep[];
          }
          if (refs.reviewDates.length) {
            base.reviewCards = refs.reviewDates
              .map(d => dailyReviews.find(r => r.date === d))
              .filter(Boolean) as DailyReview[];
          }
          if (refs.charts.length) {
            base.chartSpecs = refs.charts;
          }
          if (refs.followups.length) {
            base.followups = refs.followups;
          }
          if (refs.actions.length) {
            base.actions = refs.actions;
          }
        }
        return base;
      });
      setMessages(mapped);
      if (mapped.length > 0) firstMessageSentRef.current = true;
      setLoadingConv(false);
    });
  }, [activeConvId, trades, dailyPreps, dailyReviews]);

  // Scroll to bottom when a new message is added.
  // FORCE pokud poslední zpráva je od usera (právě poslal) — chceme ho posunout k odpovědi.
  // Jinak respektujeme stick flag — pokud user skroluje historií, neruším ho.
  const lastMsgRole = messages[messages.length - 1]?.role;
  useEffect(() => {
    const isUserMessage = lastMsgRole === 'user';
    scrollToBottom('smooth', isUserMessage);
  }, [messages.length, lastMsgRole, scrollToBottom]);

  // Plynulé sledování dna během streamování — pinuje scroll na konec KAŽDÝ frame
  // (RAF), takže view hladce sleduje rostoucí text (typewriter ~60fps) místo cukání
  // po 50ms dávkách. Respektuje stick flag: když user odscroluje nahoru číst, pin
  // se vypne (isAtBottomRef=false) a obnoví se, až znovu doscroluje na konec.
  useEffect(() => {
    if (!isStreaming) return;
    // Start streamu = user právě poslal zprávu → vždy sleduj odpověď ke dnu.
    isAtBottomRef.current = true;
    setShowScrollToBottom(false);
    let raf = 0;
    const pin = () => {
      const el = messagesContainerRef.current;
      if (el && isAtBottomRef.current) {
        // PLYNULÉ doklouzání ke dnu místo skoku. Když naskočí markdown blok
        // (+100px), `scrollTop = scrollHeight` by celý view cuknul nahoru o 100px
        // naráz (to bylo to "hrozné skákání"). Místo toho vezmeme jen ~22% rozdílu
        // za frame → velký skok se rozloží do ~12 framů (plynulý glide jako Claude).
        const target = el.scrollHeight - el.clientHeight;
        const diff = target - el.scrollTop;
        if (diff > 0) {
          el.scrollTop += diff < 2 ? diff : diff * 0.12;
        }
      }
      raf = requestAnimationFrame(pin);
    };
    raf = requestAnimationFrame(pin);
    return () => cancelAnimationFrame(raf);
  }, [isStreaming]);

  // Scroll to bottom when cards are added below the last message (respektuje stick)
  const lastMsg = messages[messages.length - 1];
  const cardCount =
    (lastMsg?.tradeCards?.length ?? 0) +
    (lastMsg?.prepCards?.length ?? 0) +
    (lastMsg?.reviewCards?.length ?? 0) +
    (lastMsg?.chartSpecs?.length ?? 0);
  useEffect(() => {
    if (cardCount > 0) scrollToBottom('smooth');
  }, [cardCount, scrollToBottom]);

  // ─── Auto-summarize on conversation switch / unmount ──────────────────────
  // Keep refs of the latest active conversation + its messages so when the user
  // navigates away, we can distill the chat into a memory entry. Idempotent —
  // each conversation gets summarized at most once per visit.
  useEffect(() => {
    prevMessagesRef.current = messages;
  }, [messages]);

  const flushSummaryFor = useCallback((convId: string, msgs: ExtendedMessage[]) => {
    if (!convId) return;
    const filteredMsgs = msgs.filter(m => !m.isSystemEvent);
    if (filteredMsgs.length < 4) return; // too short to be worth summarizing
    if (summarizedConvsRef.current.has(convId)) return; // already done this session
    summarizedConvsRef.current.add(convId);
    // Fire-and-forget — silent on failure
    summarizeConversation({
      conversation_id: convId,
      messages: filteredMsgs.map(m => ({ role: m.role, content: m.content })),
    }).catch(() => {});
  }, []);

  // When activeConvId changes from a non-null value, summarize the previous one.
  useEffect(() => {
    const prev = prevConvIdRef.current;
    if (prev && prev !== activeConvId) {
      flushSummaryFor(prev, prevMessagesRef.current);
    }
    prevConvIdRef.current = activeConvId;
  }, [activeConvId, flushSummaryFor]);

  // On unmount, summarize whatever's currently active.
  useEffect(() => {
    return () => {
      if (prevConvIdRef.current) {
        flushSummaryFor(prevConvIdRef.current, prevMessagesRef.current);
      }
    };
  }, [flushSummaryFor]);

  // ─── Proactive greeting ───────────────────────────────────────────────────
  // When user opens AI Coach without an active conversation, fetch a personalized
  // greeting + 3 suggested topics. Cached for the session.
  useEffect(() => {
    if (activeConvId) return;
    if (proactiveFetchedRef.current) return;
    proactiveFetchedRef.current = true;
    setLoadingProactive(true);
    (async () => {
      try {
        const { supabase } = await import('../services/supabase');
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) return;
        const baseUrl = (supabase as any).supabaseUrl || (import.meta as any).env?.VITE_SUPABASE_URL || '';
        const res = await fetch(`${baseUrl}/functions/v1/proactive-greeting`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${session.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({}),
        });
        const data = await res.json();
        if (res.ok && data.greeting && Array.isArray(data.suggestions)) {
          setProactive({ greeting: data.greeting, suggestions: data.suggestions });
        }
      } catch (e) {
        console.warn('[AICoachPage] proactive greeting failed:', e);
      } finally {
        setLoadingProactive(false);
      }
    })();
  }, [activeConvId]);

  // ─── Create new conversation ───────────────────────────────────────────────

  const handleNewConversation = useCallback(async () => {
    // Stream-guard — stejně jako u přepnutí konverzace.
    if (isStreaming) {
      setPendingConvAction(() => () => { handleNewConversation(); });
      return;
    }
    setCreateError(null);
    try {
      const conv = await storageService.createConversation('Nová konverzace', coachScope);
      if (!conv) return;
      setConversations(prev => [conv, ...prev]);
      setActiveConvId(conv.id);
      setMessages([]);
      firstMessageSentRef.current = false;
      setMobileView('chat');
      setTimeout(() => inputRef.current?.focus(), 100);
    } catch (e: any) {
      setCreateError(e?.message ?? 'Nepodařilo se vytvořit konverzaci');
    }
  }, [isStreaming]);

  // ─── Select conversation ───────────────────────────────────────────────────

  const handleSelectConversation = useCallback((id: string) => {
    if (id === activeConvId) return;
    const doIt = () => {
      setActiveConvId(id);
      setMobileView('chat');
    };
    // Pokud coach pořád streamuje, vyvolej warning modal — přepnutí by stream
    // odpojilo a odpověď by se ztratila.
    if (isStreaming) {
      setPendingConvAction(() => doIt);
      return;
    }
    doIt();
  }, [activeConvId, isStreaming]);

  // ─── Delete conversation ───────────────────────────────────────────────────

  const handleDeleteConversation = useCallback(async (id: string) => {
    await storageService.deleteConversation(id);
    setConversations(prev => prev.filter(c => c.id !== id));
    if (activeConvId === id) {
      setActiveConvId(null);
      setMessages([]);
      setMobileView('list');
    }
    setDeleteConfirmId(null);
  }, [activeConvId]);

  // ─── Rename conversation ──────────────────────────────────────────────────

  const handleStartRename = useCallback((conv: AIConversation) => {
    setRenamingId(conv.id);
    setRenameValue(conv.title);
  }, []);

  const handleSaveRename = useCallback(async () => {
    if (!renamingId) return;
    const trimmed = renameValue.trim();
    if (trimmed) {
      await storageService.updateConversation(renamingId, { title: trimmed });
      setConversations(prev => prev.map(c => c.id === renamingId ? { ...c, title: trimmed } : c));
    }
    setRenamingId(null);
  }, [renamingId, renameValue]);

  // ─── Send message ──────────────────────────────────────────────────────────

  // hideUserMsg = true → user zpráva jde do API (kontext), ale NEzobrazí se ani neukládá.
  // Používá se pro proaktivní otvírák seance (skrytý "kickoff", coach začne sám z dat).
  const sendMessage = useCallback(async (text: string, overrideConvId?: string, voiceMode = false, hideUserMsg = false): Promise<string> => {
    if (!text.trim() || isStreaming) return '';
    const convId = overrideConvId ?? activeConvId;
    if (!convId) return '';

    // ── Slash příkazy pro scope mentora — nejdou do AI, jen přepnou zdroj dat ──
    const cmd = text.trim().toLowerCase();
    if (cmd === '/backtest' || cmd === '/live') {
      const newScope: 'live' | 'backtest' = cmd === '/backtest' ? 'backtest' : 'live';
      setCoachScope(newScope);
      const info: ExtendedMessage = {
        role: 'assistant',
        content: newScope === 'backtest'
          ? '🧪 Přepnuto na **backtest data**. Od teď čtu jen z backtest účtů. Zpět na živá data: `/live`.'
          : '✅ Přepnuto zpět na **živá data**. Backtest je opět skrytý.',
      };
      setMessages(prev => [...prev, info]);
      setInput('');
      return '';
    }

    const isFirstMessage = !firstMessageSentRef.current;
    firstMessageSentRef.current = true;

    const userMsg: ExtendedMessage = { role: 'user', content: text.trim() };
    const assistantMsg: ExtendedMessage = { role: 'assistant', content: '', aiModel: voiceMode ? 'fast' : aiModel };

    // Skrytý kickoff → do UI jen prázdná asistentova bublina (user zpráva neviditelná).
    setMessages(prev => hideUserMsg ? [...prev, assistantMsg] : [...prev, userMsg, assistantMsg]);
    setInput('');
    setIsStreaming(true);

    // Save user message to DB — fire-and-forget. Skrytý kickoff neukládáme (jen otvírák).
    if (!hideUserMsg) {
      storageService.appendMessage(convId, 'user', text.trim())
        .catch(err => console.error('[AICoachPage] appendMessage failed:', err));
    }

    // If this is the first message, auto-update conversation title (taky fire-and-forget).
    // U skrytého kickoffu titulek NEpřepisujeme — nastavil ho handleStartSession (název seance).
    if (isFirstMessage && !hideUserMsg) {
      // Strip hidden [CONTEXT]...[/CONTEXT] block so the title reflects the visible question, not the context.
      const visible = text.trim().replace(/\[CONTEXT\][\s\S]*?\[\/CONTEXT\]\s*/g, '').trim();
      const titleSource = visible || text.trim();
      const autoTitle = titleSource.slice(0, 50).replace(/\n/g, ' ');
      const titleCapitalized = autoTitle.charAt(0).toUpperCase() + autoTitle.slice(1);
      const category = detectCategory(text.trim());
      storageService.updateConversation(convId, { title: titleCapitalized, category })
        .catch(err => console.error('[AICoachPage] updateConversation failed:', err));
      setConversations(prev => prev.map(c =>
        c.id === convId
          ? { ...c, title: titleCapitalized, category, updated_at: new Date().toISOString() }
          : c,
      ));
    }

    const history: AIMessage[] = [...messages, userMsg]
      .filter(m => !m.isSystemEvent)
      .map(m => ({ role: m.role, content: m.content }));

    let finalContent = '';

    // Voice mód: streamuj TTS po větách. Jakmile coach dopíše větu, hned ji pošli
    // k přečtení (zatímco píše dál) → zvuk začne hrát skoro okamžitě, ne až po celé odpovědi.
    let voiceBuf = '';
    if (voiceMode) cancelSpeech(); // vyčisti případný zbytek z minula
    const flushVoiceSentences = (final = false) => {
      if (!voiceMode) return;
      // Rozsekej na věty: ender ([.!?] následovaný mezerou, nebo nový řádek).
      // Tečka uvnitř čísla ("2.5") se NEsplitne (není za ní mezera).
      const re = /[.!?]+(?=\s)|\n+/g;
      let lastCut = 0; let m: RegExpExecArray | null;
      while ((m = re.exec(voiceBuf)) !== null) {
        const end = m.index + m[0].length;
        const spoken = cleanForSpeech(voiceBuf.slice(lastCut, end));
        if (spoken) enqueueSpeak(spoken);
        lastCut = end;
      }
      voiceBuf = voiceBuf.slice(lastCut);
      if (final && voiceBuf.trim()) {
        const spoken = cleanForSpeech(voiceBuf);
        if (spoken) enqueueSpeak(spoken);
        voiceBuf = '';
      }
    };

    // Backtest session poznámky — čerstvě, ať je prompt má i hned po /backtest.
    const btSessionsText = coachScope === 'backtest' ? await fetchBacktestSessionsText() : '';

    await streamAIResponse(
      history,
      traderContext,
      scopedTrades,
      // onChunk — buffer chunks, flush to React state every 50ms
      // This reduces re-renders from ~100/sec → ~20/sec during streaming,
      // which prevents React from dropping RAF animation frames.
      (chunk) => {
        finalContent += chunk;
        chunkBufferRef.current += chunk;
        if (voiceMode) { voiceBuf += chunk; flushVoiceSentences(); }

        if (!chunkTimerRef.current) {
          chunkTimerRef.current = setTimeout(() => {
            const buffered = chunkBufferRef.current;
            chunkBufferRef.current = '';
            chunkTimerRef.current = null;
            if (!buffered) return;
            setMessages(prev => {
              const updated = [...prev];
              const last = updated[updated.length - 1];
              if (last.role === 'assistant') {
                updated[updated.length - 1] = { ...last, content: last.content + buffered };
              }
              return updated;
            });
            // Scroll řeší plynulá RAF pin smyčka (viz useEffect na isStreaming),
            // takže tady už scrollovat nemusíme — jinak by to cukalo po 50ms.
          }, 50);
        }
      },
      // onRefs
      ({ tradeIds, prepDates, reviewDates, charts, followups, actions }) => {
        const foundTrades = tradeIds.map(id => trades.find(t => String(t.id) === id)).filter(Boolean) as Trade[];
        const foundPreps = prepDates.map(d => dailyPreps.find(p => p.date === d)).filter(Boolean) as DailyPrep[];
        const foundReviews = reviewDates.map(d => dailyReviews.find(r => r.date === d)).filter(Boolean) as DailyReview[];

        if (foundTrades.length || foundPreps.length || foundReviews.length || (charts && charts.length > 0) || (followups && followups.length > 0) || (actions && actions.length > 0)) {
          setMessages(prev => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last.role === 'assistant') {
              updated[updated.length - 1] = {
                ...last,
                tradeCards: foundTrades.length ? [...(last.tradeCards || []), ...foundTrades] : last.tradeCards,
                prepCards: foundPreps.length ? [...(last.prepCards || []), ...foundPreps] : last.prepCards,
                reviewCards: foundReviews.length ? [...(last.reviewCards || []), ...foundReviews] : last.reviewCards,
                chartSpecs: charts && charts.length > 0 ? [...(last.chartSpecs || []), ...charts] : last.chartSpecs,
                followups: followups && followups.length > 0 ? followups : last.followups,
                actions: actions && actions.length > 0 ? actions : last.actions,
              };
            }
            return updated;
          });
        }
      },
      // onDone
      async () => {
        // Voice mód: dořekni zbytek (poslední věta bez koncové mezery).
        flushVoiceSentences(true);
        // Flush any remaining buffered chunks before finishing
        if (chunkTimerRef.current) {
          clearTimeout(chunkTimerRef.current);
          chunkTimerRef.current = null;
        }
        if (chunkBufferRef.current) {
          const buffered = chunkBufferRef.current;
          chunkBufferRef.current = '';
          setMessages(prev => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last.role === 'assistant') {
              updated[updated.length - 1] = { ...last, content: last.content + buffered };
            }
            return updated;
          });
        }
        setIsStreaming(false);
        setToolStatus(null);
        if (finalContent) {
          const modelTag = `\n<!-- model:${voiceMode ? 'fast' : aiModel} -->`;
          await storageService.appendMessage(convId, 'assistant', finalContent + modelTag);
        } else {
          // Stream skončil bez textu (samé tool calls). Ukaž chybu místo prázdné bubliny.
          setMessages(prev => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last?.role === 'assistant' && !last.content) {
              updated[updated.length - 1] = {
                ...last,
                content: '⚠️ Agent skončil bez odpovědi (možná příliš mnoho tool volání). Zkus dotaz jinak nebo konkrétněji.',
              };
            }
            return updated;
          });
        }
        // Update conversation's updated_at in local state
        setConversations(prev => {
          const updated = prev.map(c =>
            c.id === convId
              ? { ...c, updated_at: new Date().toISOString() }
              : c,
          );
          // Re-sort by updated_at
          return [...updated].sort((a, b) =>
            new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
          );
        });
      },
      // onError
      (err) => {
        console.error('[AICoachPage] stream error:', err);
        if (voiceMode) cancelSpeech(); // zastav rozečtené věty při chybě
        setIsStreaming(false);
        setToolStatus(null);
        // Ukaž chybu v bublině místo tichého smazání — user ví, co se stalo.
        setMessages(prev => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last?.role === 'assistant' && !last.content) {
            updated[updated.length - 1] = { ...last, content: `⚠️ Chyba: ${err}` };
          }
          return updated;
        });
      },
      // options — tool-use mode
      {
        preps: scopedPreps,
        reviews: scopedReviews,
        // Rozsah dat — coach v promptu ví, jestli čte live nebo backtest.
        scope: coachScope,
        // Backtest session poznámky (jen v backtest scope) — kvalitativní kontext.
        backtestSessions: btSessionsText || undefined,
        // Účty v aktuálním scope (live/backtest) — tools filtrují a reportují jen v rámci scope.
        accounts: scopedAccounts,
        // Sum of active account starting balances — Coach uses for $ → % conversion when user prefers %.
        initialBalance: scopedAccounts
          .filter(a => a.status !== 'Archived')
          .reduce((sum, a) => sum + (a.initialBalance || 0), 0) || undefined,
        onToolUse: (label) => setToolStatus(label),
        voiceMode,
        aiModel: voiceMode ? 'fast' : aiModel,
        // Vyřeš personu: 'auto' → dle kontextu (seance, tilt/série ztrát), jinak ručně zvolená.
        coachPersona: resolvePersona(coachPersona, {
          sessionMode: activeSessionMode,
          trades,
          todayISO: new Date().toISOString().slice(0, 10),
        }),
        sessionPrompt: activeSessionMode ? buildDynamicSessionPrompt(activeSessionMode, ironRules, sessions || []) : undefined,
      },
    );

    // Vrať finální text — voice mód ho přečte nahlas.
    return finalContent;
  }, [messages, traderContext, trades, scopedTrades, scopedAccounts, coachScope, fetchBacktestSessionsText, dailyPreps, dailyReviews, isStreaming, activeConvId, aiModel, coachPersona, activeSessionMode, ironRules, sessions]);

  // ─── Start with quick prompt (declared after sendMessage to avoid TDZ) ──────

  const startWithPrompt = useCallback(async (prompt: string) => {
    setCreateError(null);
    try {
      const conv = await storageService.createConversation('Nová konverzace', coachScope);
      if (!conv) return;
      // Mark BEFORE setActiveConvId so the [activeConvId] effect skips the DB load
      justCreatedConvIdsRef.current.add(conv.id);
      setConversations(prev => [conv, ...prev]);
      setActiveConvId(conv.id);
      setMessages([]);
      firstMessageSentRef.current = false;
      setMobileView('chat');
      // Pass conv.id explicitly — sendMessage's `activeConvId` closure is still null at this point
      sendMessage(prompt, conv.id);
    } catch (e: any) {
      setCreateError(e?.message ?? 'Nepodařilo se vytvořit konverzaci');
    }
  }, [sendMessage]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Auto-start with externally provided prompt (e.g. from "Analyze with AI" button) ──
  const initialPromptHandledRef = useRef(false);
  useEffect(() => {
    if (initialPrompt && !initialConversationId && !initialPromptHandledRef.current) {
      initialPromptHandledRef.current = true;
      startWithPrompt(initialPrompt);
      onInitialPromptConsumed?.();
    }
  }, [initialPrompt, initialConversationId, startWithPrompt, onInitialPromptConsumed]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  // ─── Group conversations (filtrovano podle coachScope) ─────────────────────

  const scopedConversations = React.useMemo(
    () => conversations.filter(c => (c.scope ?? 'live') === coachScope),
    [conversations, coachScope],
  );

  const groupedConversations = React.useMemo(() => {
    const groups: Record<string, AIConversation[]> = {};
    const ORDER = ['Dnes', 'Včera', 'Tento týden', 'Starší'];
    for (const conv of scopedConversations) {
      const group = getDateGroup(conv.updated_at);
      if (!groups[group]) groups[group] = [];
      groups[group].push(conv);
    }
    return ORDER.filter(g => groups[g]).map(g => ({ label: g, items: groups[g] }));
  }, [scopedConversations]);

  // ─── Sidebar ───────────────────────────────────────────────────────────────

  const Sidebar = (
    <div className="flex flex-col h-full w-full min-w-0 bg-theme-page">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-4 border-b border-[var(--border-subtle)] flex-shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-blue-600/15 border border-blue-500/25 flex items-center justify-center">
            <Sparkles size={13} className="text-blue-400" />
          </div>
          <span className="text-sm font-black uppercase tracking-widest text-[var(--text-primary)]">AI Coach</span>
          {coachScope === 'backtest' && (
            <span className="px-1.5 py-0.5 rounded-md bg-emerald-500/15 text-emerald-400 text-[9px] font-black uppercase tracking-wider border border-emerald-500/20">
              BT
            </span>
          )}
        </div>
        <button
          onClick={handleNewConversation}
          className="p-1.5 rounded-lg bg-[var(--bg-card)] hover:bg-[var(--bg-card)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-all"
          title="Nová konverzace"
        >
          <Plus size={14} />
        </button>
      </div>

      {/* Error banner */}
      {createError && (
        <div className="mx-3 mt-2 px-3 py-2 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-400 text-[10px] flex items-center justify-between gap-2">
          <span className="truncate">{createError}</span>
          <button onClick={() => setCreateError(null)} className="flex-shrink-0 text-rose-400/60 hover:text-rose-400">✕</button>
        </div>
      )}

      {/* Conversation list */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden py-2 scrollbar-thin min-w-0 w-full">
        {scopedConversations.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 px-4 text-center">
            <Bot size={28} className="text-[var(--text-secondary)]" />
            <p className="text-xs text-[var(--text-secondary)]">
              {coachScope === 'backtest' ? 'Žádné backtest konverzace' : 'Zatím žádné konverzace'}
            </p>
            <button
              onClick={handleNewConversation}
              className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold transition-all"
            >
              Začít novou
            </button>
          </div>
        ) : (
          groupedConversations.map(group => (
            <div key={group.label}>
              <div className="px-4 py-1.5 text-[9px] font-black uppercase tracking-widest text-[var(--text-secondary)]">
                {group.label}
              </div>
              {group.items.map(conv => (
                <div
                  key={conv.id}
                  className={`group relative flex items-center gap-2 px-3 py-2 mx-2 rounded-lg cursor-pointer transition-all ${
                    activeConvId === conv.id
                      ? 'bg-[var(--bg-card)] text-[var(--text-primary)]'
                      : 'text-[var(--text-secondary)] hover:bg-[var(--bg-card)] hover:text-[var(--text-primary)]'
                  }`}
                  onClick={() => handleSelectConversation(conv.id)}
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                      CATEGORY_COLORS[conv.category]?.includes('blue') ? 'bg-blue-400' :
                      CATEGORY_COLORS[conv.category]?.includes('amber') ? 'bg-amber-400' :
                      CATEGORY_COLORS[conv.category]?.includes('emerald') ? 'bg-emerald-400' :
                      CATEGORY_COLORS[conv.category]?.includes('violet') ? 'bg-violet-400' :
                      'bg-slate-400'
                    }`}
                    title={CATEGORY_LABELS[conv.category]}
                  />
                  <div className="flex-1 min-w-0">
                    {renamingId === conv.id ? (
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={e => setRenameValue(e.target.value)}
                        onBlur={handleSaveRename}
                        onKeyDown={e => {
                          if (e.key === 'Enter') handleSaveRename();
                          if (e.key === 'Escape') setRenamingId(null);
                        }}
                        className="w-full bg-[var(--bg-card)] text-[var(--text-primary)] text-xs rounded px-1.5 py-0.5 outline-none border border-blue-500/50"
                        onClick={e => e.stopPropagation()}
                      />
                    ) : (
                      <div
                        className="text-[11px] font-medium truncate leading-tight"
                        onDoubleClick={() => handleStartRename(conv)}
                        title={`${conv.title} · ${CATEGORY_LABELS[conv.category]} · ${formatRelativeDate(conv.updated_at)}`}
                      >
                        {conv.title}
                      </div>
                    )}
                  </div>
                  {/* Delete button — shown on hover */}
                  {deleteConfirmId === conv.id ? (
                    <div className="flex items-center gap-1 flex-shrink-0" onClick={e => e.stopPropagation()}>
                      <button
                        onClick={() => handleDeleteConversation(conv.id)}
                        className="text-[9px] px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-400 hover:bg-rose-500/30 transition-all font-bold"
                      >
                        Smazat
                      </button>
                      <button
                        onClick={() => setDeleteConfirmId(null)}
                        className="p-0.5 rounded hover:bg-[var(--bg-card)] text-[var(--text-secondary)] transition-all"
                      >
                        <X size={10} />
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={e => { e.stopPropagation(); setDeleteConfirmId(conv.id); }}
                      className="flex-shrink-0 p-1 rounded text-slate-400 hover:text-rose-500 hover:bg-rose-500/10 transition-all"
                      title="Smazat konverzaci"
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );

  // ─── Chat area ─────────────────────────────────────────────────────────────

  const ChatArea = (
    <div className="relative flex flex-col h-full w-full bg-theme-page">
      {/* Chat header — visible on both mobile and desktop */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border-subtle)] flex-shrink-0">
        {/* Back button — only on mobile (desktop has permanent sidebar) */}
        <button
          onClick={() => setMobileView('list')}
          className="lg:hidden p-1.5 rounded-lg hover:bg-[var(--bg-card)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-all"
        >
          <ChevronLeft size={18} />
        </button>
        {/* Sidebar toggle — only on desktop */}
        <button
          onClick={() => setSidebarCollapsed(prev => !prev)}
          className="hidden lg:flex p-1.5 rounded-lg hover:bg-[var(--bg-card)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-all items-center justify-center"
          title={sidebarCollapsed ? 'Zobrazit seznam konverzací' : 'Skrýt seznam konverzací'}
        >
          {sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
        </button>
        <div className="flex-1 min-w-0">
          {activeSessionMode ? (
            <div className="flex items-center gap-2">
              <span className="text-xs px-2 py-0.5 rounded-lg bg-red-500/10 border border-red-500/25 text-red-400 font-bold flex items-center gap-1 flex-shrink-0">
                <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
                Live Seance
              </span>
              <button
                onClick={() => {
                  if (confirm('Opravdu chceš ukončit aktivní seanci? Všechny neuložené změny budou ztraceny.')) {
                    setActiveSessionMode(null);
                    setSessionFormState(null);
                  }
                }}
                className="text-[10px] text-rose-400 hover:text-rose-300 font-bold flex items-center gap-0.5 px-2 py-1 rounded-lg bg-rose-500/5 hover:bg-rose-500/10 transition-all border border-rose-500/10 cursor-pointer"
                title="Zrušit a zahodit aktivní seanci"
              >
                <X size={10} />
                <span>Zrušit seanci</span>
              </button>
            </div>
          ) : activeConvId ? (
            <span className="text-sm font-bold text-[var(--text-primary)] truncate block">
              {conversations.find(c => c.id === activeConvId)?.title ?? 'Konverzace'}
            </span>
          ) : (
            <span className="text-sm font-bold text-[var(--text-primary)]">AI Coach</span>
          )}
        </div>

        {/* Persona Selector Dropdown — osobnost/tón coache (nezávislé na modelu) */}
        <div ref={personaDropdownRef} className="relative flex-shrink-0">
          <button
            onClick={() => setShowPersonaDropdown(prev => !prev)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-semibold bg-[var(--bg-page)] border border-[var(--border-subtle)] text-[var(--text-primary)] hover:border-[var(--text-secondary)] transition-all cursor-pointer select-none"
            title="Vyber osobnost kouče"
          >
            {coachPersona === 'auto' ? (
              <><Sparkles size={14} className="text-violet-400" /><span>Auto</span></>
            ) : (
              <><span className="text-sm leading-none">{COACH_PERSONAS[coachPersona].emoji}</span><span>{COACH_PERSONAS[coachPersona].label}</span></>
            )}
            <ChevronDown size={14} className={`text-[var(--text-secondary)] transition-transform duration-200 ${showPersonaDropdown ? 'rotate-180' : ''}`} />
          </button>

          {showPersonaDropdown && (
            <div className="absolute right-0 top-full mt-1.5 w-64 bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl shadow-xl p-1.5 z-50 flex flex-col gap-1 animate-in fade-in duration-100">
              <button
                onClick={() => { setCoachPersona('auto'); setShowPersonaDropdown(false); }}
                className={`flex items-start gap-2.5 p-2.5 rounded-lg text-left transition-all cursor-pointer ${
                  coachPersona === 'auto'
                    ? 'bg-violet-600/10 text-violet-400 border border-violet-500/20'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--bg-page)] hover:text-[var(--text-primary)] border border-transparent'
                }`}
              >
                <Sparkles size={16} className={`mt-0.5 flex-shrink-0 ${coachPersona === 'auto' ? 'text-violet-400' : 'text-[var(--text-secondary)]'}`} />
                <div className="flex flex-col min-w-0">
                  <span className="text-xs font-bold">Auto</span>
                  <span className="text-[10px] text-[var(--text-secondary)] leading-normal mt-0.5">
                    Persona se přizpůsobí kontextu — ráno hecuje, večer reflektuje, po sérii ztrát podrží.
                  </span>
                </div>
              </button>

              {(Object.values(COACH_PERSONAS)).map(p => (
                <button
                  key={p.id}
                  onClick={() => { setCoachPersona(p.id); setShowPersonaDropdown(false); }}
                  className={`flex items-start gap-2.5 p-2.5 rounded-lg text-left transition-all cursor-pointer ${
                    coachPersona === p.id
                      ? 'bg-[var(--bg-page)] text-[var(--text-primary)] border border-[var(--border-subtle)]'
                      : 'text-[var(--text-secondary)] hover:bg-[var(--bg-page)] hover:text-[var(--text-primary)] border border-transparent'
                  }`}
                >
                  <span className="text-base leading-none mt-0.5 flex-shrink-0">{p.emoji}</span>
                  <div className="flex flex-col min-w-0">
                    <span className="text-xs font-bold">{p.label}</span>
                    <span className="text-[10px] text-[var(--text-secondary)] leading-normal mt-0.5">{p.tagline}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Model Selector Dropdown */}
        <div ref={modelDropdownRef} className="relative flex-shrink-0">
          <button
            onClick={() => setShowModelDropdown(prev => !prev)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-semibold bg-[var(--bg-page)] border border-[var(--border-subtle)] text-[var(--text-primary)] hover:border-[var(--text-secondary)] transition-all cursor-pointer select-none"
            title="Vyber AI kouče"
          >
            {aiModel === 'analytical' ? (
              <>
                <Brain size={14} className="text-blue-400" />
                <span>Analytik</span>
              </>
            ) : (
              <>
                <Zap size={14} className="text-amber-400" />
                <span>Rychlý</span>
              </>
            )}
            <ChevronDown size={14} className={`text-[var(--text-secondary)] transition-transform duration-200 ${showModelDropdown ? 'rotate-180' : ''}`} />
          </button>

          {showModelDropdown && (
            <div className="absolute right-0 top-full mt-1.5 w-60 bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-xl shadow-xl p-1.5 z-50 flex flex-col gap-1 animate-in fade-in duration-100">
              <button
                onClick={() => {
                  handleModelChange('analytical');
                  setShowModelDropdown(false);
                }}
                className={`flex items-start gap-2.5 p-2.5 rounded-lg text-left transition-all cursor-pointer ${
                  aiModel === 'analytical'
                    ? 'bg-blue-600/10 text-blue-400 border border-blue-500/20'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--bg-page)] hover:text-[var(--text-primary)] border border-transparent'
                }`}
              >
                <Brain size={16} className={`mt-0.5 flex-shrink-0 ${aiModel === 'analytical' ? 'text-blue-400' : 'text-[var(--text-secondary)]'}`} />
                <div className="flex flex-col min-w-0">
                  <span className="text-xs font-bold">Analytik</span>
                  <span className="text-[10px] text-[var(--text-secondary)] leading-normal mt-0.5">
                    Hluboká analýza s Claude 4.5. Ideální pro post-session debriefy a psychologii.
                  </span>
                </div>
              </button>

              <button
                onClick={() => {
                  handleModelChange('fast');
                  setShowModelDropdown(false);
                }}
                className={`flex items-start gap-2.5 p-2.5 rounded-lg text-left transition-all cursor-pointer ${
                  aiModel === 'fast'
                    ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--bg-page)] hover:text-[var(--text-primary)] border border-transparent'
                }`}
              >
                <Zap size={16} className={`mt-0.5 flex-shrink-0 ${aiModel === 'fast' ? 'text-amber-400' : 'text-[var(--text-secondary)]'}`} />
                <div className="flex flex-col min-w-0">
                  <span className="text-xs font-bold">Rychlý</span>
                  <span className="text-[10px] text-[var(--text-secondary)] leading-normal mt-0.5">
                    Bleskově rychlé odpovědi s Claude Haiku 4.5. Skvělé pro ranní přípravu a rychlé dotazy.
                  </span>
                </div>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Messages */}
      <div ref={messagesContainerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-4 py-6 space-y-4 scrollbar-thin">
        {!activeConvId ? (
          // No conversation selected — show empty state with quick prompts
          <div className="flex flex-col items-center justify-center h-full gap-6 max-w-sm mx-auto py-6">
            <div className="text-center">
              <div className="w-14 h-14 rounded-2xl bg-blue-600/10 border border-blue-500/20 flex items-center justify-center mx-auto mb-4">
                <Bot size={24} className="text-blue-400" />
              </div>
              <p className="text-base font-black text-[var(--text-primary)]">Ahoj! Jsem tvůj AI Coach.</p>
              <p className="text-sm text-[var(--text-secondary)] mt-1">Vyber konverzaci nebo začni novou.</p>
            </div>

            {/* guided session triggers */}
            <div className="w-full">
              {isTodayWeekend ? (
                <div className="p-4 text-center border border-[var(--border-subtle)] bg-[var(--bg-card)] rounded-xl">
                  <p className="text-[10px] font-black uppercase tracking-widest text-amber-500 mb-1">
                    ☕ Víkendový režim
                  </p>
                  <p className="text-[9px] text-[var(--text-secondary)] leading-relaxed">
                    Trhy jsou zavřené a seance jsou neaktivní. Můžeš ale analyzovat minulý týden, studovat statistiky nebo si popovídat s koučem o psychologii.
                  </p>
                </div>
              ) : (
                <SessionStartCards onStart={handleStartSession} />
              )}
            </div>

            <div className="w-full space-y-2">
              <div className="text-[10px] font-black uppercase tracking-widest text-[var(--text-secondary)] text-center mb-1">Rychlé dotazy</div>
              {QUICK_PROMPTS.map(q => (
                <button
                  key={q}
                  onClick={() => startWithPrompt(q)}
                  className="w-full text-left px-4 py-2.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] hover:opacity-80 text-xs text-[var(--text-primary)] transition-all cursor-pointer"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        ) : loadingConv ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 size={20} className="text-[var(--text-secondary)] animate-spin" />
          </div>
        ) : (
          <>
            {messages.filter(m => !m.isSystemEvent).length === 0 && (
              <div className="flex flex-col items-center justify-center h-full gap-5 max-w-md mx-auto px-2 py-4">
                <div className="text-center w-full">
                  <div className="w-12 h-12 rounded-2xl bg-blue-600/10 border border-blue-500/20 flex items-center justify-center mx-auto mb-3">
                    <Sparkles size={20} className="text-blue-400" />
                  </div>
                  {loadingProactive ? (
                    <p className="text-xs text-[var(--text-secondary)] italic flex items-center gap-2 justify-center">
                      <Loader2 size={12} className="animate-spin" />
                      Coach se na tebe chystá…
                    </p>
                  ) : proactive ? (
                    <p className="text-sm text-[var(--text-primary)] leading-relaxed text-left bg-blue-500/5 border border-blue-500/20 rounded-2xl p-4">
                      {proactive.greeting}
                    </p>
                  ) : (
                    <>
                      <p className="text-sm font-black text-[var(--text-primary)]">Nová konverzace</p>
                      <p className="text-xs text-[var(--text-secondary)] mt-1">Napiš cokoliv nebo použij rychlý prompt.</p>
                    </>
                  )}
                </div>

                {/* guided session triggers */}
                <div className="w-full">
                  {isTodayWeekend ? (
                    <div className="p-4 text-center border border-[var(--border-subtle)] bg-[var(--bg-card)] rounded-xl">
                      <p className="text-[10px] font-black uppercase tracking-widest text-amber-500 mb-1">
                        ☕ Víkendový režim
                      </p>
                      <p className="text-[9px] text-[var(--text-secondary)] leading-relaxed">
                        Trhy jsou zavřené a seance jsou neaktivní. Můžeš ale analyzovat minulý týden, studovat statistiky nebo si popovídat s koučem o psychologii.
                      </p>
                    </div>
                  ) : (
                    <SessionStartCards onStart={handleStartSession} />
                  )}
                </div>

                <div className="w-full space-y-2">
                  <div className="text-[10px] font-black uppercase tracking-widest text-[var(--text-secondary)] text-center mb-1">Rychlé dotazy</div>
                  {(proactive?.suggestions && proactive.suggestions.length > 0 ? proactive.suggestions : QUICK_PROMPTS).map(q => (
                    <button
                      key={q}
                      onClick={() => sendMessage(q)}
                      className="w-full text-left px-4 py-2.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] hover:border-blue-500/40 hover:bg-blue-500/5 text-xs text-[var(--text-primary)] transition-all active:scale-[0.98] cursor-pointer"
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((msg, i) => {
              const isLastStreaming = isStreaming && i === messages.length - 1 && msg.role === 'assistant';
              return (
                <MessageBubble
                  key={i}
                  msg={msg}
                  trades={trades}
                  dailyPreps={dailyPreps}
                  dailyReviews={dailyReviews}
                  isStreaming={isLastStreaming}
                  toolStatus={isLastStreaming ? toolStatus : null}
                  onOpenTrade={onOpenTrade ?? (trade => setOpenTrade(trade))}
                  onOpenJournal={onOpenJournal}
                  onFollowup={(text) => { setInput(''); sendMessage(text); }}
                  messageIndex={i}
                  existingActionLabels={existingActionLabels}
                  onApplyAction={onApplyAction ? (action, msgIdx, actionIdx) => {
                    onApplyAction(action);
                    // Označ akci jako aplikovanou (vizuální feedback)
                    setMessages(prev => {
                      const updated = [...prev];
                      const m = updated[msgIdx];
                      if (m) {
                        updated[msgIdx] = {
                          ...m,
                          appliedActionIds: [...(m.appliedActionIds || []), actionIdx]
                        };
                      }
                      return updated;
                    });
                  } : undefined}
                />
              );
            })}
          </>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Floating "Skoč dolů" — zobrazí se když user odscroluje nahoru.
          Klik = force scroll k poslednímu chunku + obnoví auto-scroll behavior. */}
      {showScrollToBottom && (
        <button
          onClick={() => scrollToBottom('smooth', true)}
          className="absolute right-6 bottom-24 z-20 flex items-center gap-1.5 px-3 py-2 rounded-full bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-600/30 transition-all text-[10px] font-black uppercase tracking-widest"
          title="Skočit na poslední zprávu"
        >
          <ChevronDown size={14} strokeWidth={3} />
          Dolů
        </button>
      )}

      {/* Input area */}
      {activeConvId && (
        <div className="px-4 py-3 border-t border-[var(--border-subtle)] flex-shrink-0">
          {voiceModeOpen ? (
            /* Hlasový mód — input se promění v živou vlnu reagující na hlas (nezasahuje do chatu). */
            <VoiceModeOverlay
              onClose={() => setVoiceModeOpen(false)}
              onSend={(text) => sendMessage(text, undefined, true)}
            />
          ) : (
            <div className="flex items-end gap-2 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] px-4 py-3">
              <textarea
                ref={inputRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Napiš zprávu... (Enter = odeslat)"
                rows={1}
                disabled={isStreaming}
                className="flex-1 bg-transparent text-sm text-[var(--text-primary)] placeholder-slate-500 resize-none outline-none max-h-[50vh] overflow-y-auto scrollbar-thin disabled:opacity-50"
                style={{ lineHeight: '1.5' }}
              />
              <VoiceMemoButton
                size="sm"
                disabled={isStreaming}
                title="Nadiktovat dotaz (Whisper, česky)"
                onTranscribed={(text) => {
                  // Append to input so user can edit / append more before sending
                  setInput(prev => (prev.trim() ? prev.trim() + ' ' : '') + text);
                  setTimeout(() => inputRef.current?.focus(), 50);
                }}
              />
              {/* Voice mód — hands-free konverzace (coach mluví a poslouchá ve smyčce) */}
              <button
                onClick={() => {
                  setVoiceModeOpen(true);
                  // Aktivovat (odemknout) Web Speech API v prohlížeči přehráním prázdné promluvy.
                  // Chrome/Safari blokují asynchronní řeč spuštěnou po síťovém volání,
                  // pokud předtím v rámci stejného kliknutí neproběhl přímý synchronní speak().
                  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
                    try {
                      const utter = new SpeechSynthesisUtterance('');
                      window.speechSynthesis.speak(utter);
                    } catch (e) {
                      console.warn('[Speech] Synchronous unlock failed:', e);
                    }
                  }
                }}
                disabled={isStreaming}
                title="Hlasový mód — mluv s coachem"
                className="w-8 h-8 rounded-xl bg-emerald-500/10 hover:bg-emerald-500 text-emerald-500 hover:text-white border border-emerald-500/30 hover:border-emerald-500 disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center flex-shrink-0 transition-all active:scale-95"
              >
                <Headphones size={14} />
              </button>
              <button
                onClick={() => sendMessage(input)}
                disabled={!input.trim() || isStreaming}
                className="w-8 h-8 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center flex-shrink-0 transition-all active:scale-95"
              >
                {isStreaming
                  ? <Loader2 size={14} className="text-white animate-spin" />
                  : <Send size={14} className="text-white" />
                }
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      {/*
        Jeden unified layout — Sidebar a ChatArea jsou vždy max. jednou v DOM.
        Na desktopu jsou oba viditelné. Na mobilu se přepínají přes CSS/conditional.
        Důvod: pokud by byly dvě kopie ChatArea (hidden + visible), messagesContainerRef
        by ukazoval na špatný (skrytý) element a auto-scroll by nefungoval.
      */}
      <div className="flex h-full w-full">
        {/* Sidebar — na desktopu fixed 240px (skrytelný přes toggle), na mobilu fullwidth */}
        <div className={`
          flex-shrink-0 h-full overflow-hidden transition-all duration-200
          ${mobileView === 'chat' ? 'hidden lg:flex' : 'flex'}
          ${sidebarCollapsed
            ? 'w-0 lg:w-0 border-r-0'
            : 'w-full lg:w-60 lg:border-r lg:border-[var(--border-subtle)]'
          }
        `}>
          {Sidebar}
        </div>

        {/* Chat area — na desktopu vždy viditelný, na mobilu jen v chat view */}
        <div className={`
          flex-1 h-full overflow-hidden min-w-0
          ${mobileView === 'list' && !sidebarCollapsed ? 'hidden lg:flex' : 'flex'}
        `}>
          {activeSessionMode ? (
            <div className="flex flex-col lg:flex-row h-full w-full overflow-hidden p-2 lg:p-4 gap-4 bg-[var(--bg-page)]">
              {/* Mobile Tab Toggle */}
              <div className="lg:hidden flex bg-[var(--bg-card)] border border-[var(--border-subtle)] p-1 rounded-xl w-full flex-shrink-0 mb-2">
                <button
                  onClick={() => setActiveSessionTab('chat')}
                  className={`flex-1 py-2 rounded-lg text-xs font-bold text-center transition-all ${
                    activeSessionTab === 'chat'
                      ? 'bg-blue-600/15 text-blue-400 border border-blue-500/20'
                      : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  Chat s koučem
                </button>
                <button
                  onClick={() => setActiveSessionTab('preview')}
                  className={`flex-1 py-2 rounded-lg text-xs font-bold text-center transition-all ${
                    activeSessionTab === 'preview'
                      ? 'bg-blue-600/15 text-blue-400 border border-blue-500/20'
                      : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  Náhled formuláře
                </button>
              </div>

              {/* Left Panel: Chat Area */}
              <div className={`flex-1 h-full overflow-hidden min-w-0 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)]/30 ${
                activeSessionTab === 'chat' ? 'flex flex-col' : 'hidden lg:flex lg:flex-col'
              }`}>
                {ChatArea}
              </div>

              {/* Right Panel: Live Bento Preview */}
              <div className={`w-full lg:w-1/2 xl:w-[45%] h-full overflow-hidden flex-shrink-0 min-w-0 ${
                activeSessionTab === 'preview' ? 'flex flex-col' : 'hidden lg:flex lg:flex-col'
              }`}>
                <CoachSessionPreview
                  mode={activeSessionMode}
                  state={sessionFormState}
                  onChange={setSessionFormState}
                  onSave={handleSaveSession}
                  isSaving={isSavingSession}
                  coachType={aiModel}
                  sessions={sessions}
                  ironRules={ironRules}
                />
              </div>
            </div>
          ) : (
            ChatArea
          )}
        </div>
      </div>

      {/* Trade detail modal (internal fallback if no onOpenTrade prop) */}
      {openTrade && !onOpenTrade && (
        <TradeDetailModal
          trade={openTrade}
          accountName={accounts.find(a => String(a.id) === String(openTrade.accountId))?.name ?? ''}
          theme={(theme as 'dark' | 'light' | 'oled') ?? 'dark'}
          onClose={() => setOpenTrade(null)}
          onDelete={() => setOpenTrade(null)}
          onUpdateTrade={() => {}}
          accounts={accounts}
          emotions={[]}
        />
      )}

      {/* Warning modal — pokud user mění konverzaci (nebo zakládá novou) během streamu. */}
      <ConfirmationModal
        isOpen={!!pendingConvAction}
        onClose={() => setPendingConvAction(null)}
        onConfirm={() => {
          const fn = pendingConvAction;
          setPendingConvAction(null);
          if (fn) fn();
        }}
        title="Coach pořád pracuje"
        message="Mentor analyzuje data a píše odpověď. Pokud teď přepneš konverzaci, ztratíš ji a budeš muset poslat dotaz znovu. Chceš počkat nebo přepnout přesto?"
        confirmText="Přepnout přesto"
        cancelText="Počkat"
        theme={theme as 'dark' | 'light' | 'oled'}
      />
    </>
  );
};

export default AICoachPage;
