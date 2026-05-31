import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Bot, Plus, Trash2, MessageSquare, ChevronLeft, ChevronDown, Send, Loader2, Sparkles, X, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import type { Trade, Account, IronRule, PlaybookItem, DailyPrep, DailyReview, AIConversation } from '../types';
import { streamAIResponse, buildTraderContext, parseAllRefs, type AIMessage } from '../services/aiService';
import { storageService } from '../services/storageService';
import { summarizeConversation } from '../services/coachMemoryService';
import { MessageBubble, type ExtendedMessage } from './AICards';
import TradeDetailModal from './TradeDetailModal';
import VoiceMemoButton from './VoiceMemoButton';

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
}

// ─── Main component ───────────────────────────────────────────────────────────

const AICoachPage: React.FC<Props> = ({
  trades, accounts, ironRules, standardGoals, playbookItems,
  dailyPreps, dailyReviews, theme,
  onOpenTrade, onOpenJournal, onApplyAction,
  initialConversationId, initialPrompt, onInitialPromptConsumed,
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
  const [mobileView, setMobileView] = useState<'list' | 'chat'>(initialConversationId ? 'chat' : 'list');
  const [loadingConv, setLoadingConv] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [openTrade, setOpenTrade] = useState<Trade | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // Proactive greeting state: Coach generates a personalized greeting + 3 suggested topics
  // when user opens AI Coach without an active conversation.
  const [proactive, setProactive] = useState<{ greeting: string; suggestions: string[] } | null>(null);
  const [loadingProactive, setLoadingProactive] = useState(false);
  const proactiveFetchedRef = useRef(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // ─── Stick-to-bottom scroll chování (jako Claude.ai / ChatGPT) ───────────
  // Když je user "u dna" (< 80px od konce), auto-scroll je aktivní.
  // Když odscroluje nahoru, auto-scroll se vypne — user může číst v klidu.
  // Když znovu doscroluje na konec, auto-scroll se obnoví.
  const STICK_THRESHOLD_PX = 80;
  const isAtBottomRef = useRef(true); // tracking flag — synchronní s aktuálním scroll pozicí
  const [showScrollToBottom, setShowScrollToBottom] = useState(false); // UI state pro floating tlačítko

  const isNearBottom = useCallback((el: HTMLElement | null): boolean => {
    if (!el) return true;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    return distanceFromBottom <= STICK_THRESHOLD_PX;
  }, []);

  // User scroll handler — aktualizuje isAtBottomRef pri každém scroll eventu.
  // React si pri setState s nezměněnou hodnotou interně skipne re-render, takže
  // tlačítko se rerenderuje jen když user opravdu překročí threshold.
  const handleScroll = useCallback(() => {
    const atBottom = isNearBottom(messagesContainerRef.current);
    isAtBottomRef.current = atBottom;
    setShowScrollToBottom(!atBottom);
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

  const traderContext = React.useMemo(
    () => buildTraderContext({ trades, accounts, ironRules, playbookItems, dailyPreps, dailyReviews }),
    [trades, accounts, ironRules, playbookItems, dailyPreps, dailyReviews],
  );

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

  // Scroll to bottom during streaming — respektuje stick flag (NEFORCE).
  // Když user odscroluje nahoru číst, scroll-down se vypne. Když znovu doscroluje
  // na konec, isAtBottomRef se obnoví v handleScroll a auto-scroll se zapne zpátky.
  useEffect(() => {
    if (isStreaming) scrollToBottom('instant');
  }, [messages[messages.length - 1]?.content, isStreaming, scrollToBottom]); // eslint-disable-line react-hooks/exhaustive-deps

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
    if (msgs.length < 4) return; // too short to be worth summarizing
    if (summarizedConvsRef.current.has(convId)) return; // already done this session
    summarizedConvsRef.current.add(convId);
    // Fire-and-forget — silent on failure
    summarizeConversation({
      conversation_id: convId,
      messages: msgs.map(m => ({ role: m.role, content: m.content })),
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
    setCreateError(null);
    try {
      const conv = await storageService.createConversation();
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
  }, []);

  // ─── Select conversation ───────────────────────────────────────────────────

  const handleSelectConversation = useCallback((id: string) => {
    setActiveConvId(id);
    setMobileView('chat');
  }, []);

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

  const sendMessage = useCallback(async (text: string, overrideConvId?: string) => {
    if (!text.trim() || isStreaming) return;
    const convId = overrideConvId ?? activeConvId;
    if (!convId) return;

    const isFirstMessage = !firstMessageSentRef.current;
    firstMessageSentRef.current = true;

    const userMsg: ExtendedMessage = { role: 'user', content: text.trim() };
    const assistantMsg: ExtendedMessage = { role: 'assistant', content: '' };

    setMessages(prev => [...prev, userMsg, assistantMsg]);
    setInput('');
    setIsStreaming(true);

    // Save user message to DB
    await storageService.appendMessage(convId, 'user', text.trim());

    // If this is the first message, auto-update conversation title
    if (isFirstMessage) {
      // Strip hidden [CONTEXT]...[/CONTEXT] block so the title reflects the visible question, not the context.
      const visible = text.trim().replace(/\[CONTEXT\][\s\S]*?\[\/CONTEXT\]\s*/g, '').trim();
      const titleSource = visible || text.trim();
      const autoTitle = titleSource.slice(0, 50).replace(/\n/g, ' ');
      const titleCapitalized = autoTitle.charAt(0).toUpperCase() + autoTitle.slice(1);
      const category = detectCategory(text.trim());
      await storageService.updateConversation(convId, { title: titleCapitalized, category });
      setConversations(prev => prev.map(c =>
        c.id === convId
          ? { ...c, title: titleCapitalized, category, updated_at: new Date().toISOString() }
          : c,
      ));
    }

    const history: AIMessage[] = [...messages, userMsg].map(m => ({ role: m.role, content: m.content }));

    let finalContent = '';

    await streamAIResponse(
      history,
      traderContext,
      trades,
      // onChunk — buffer chunks, flush to React state every 50ms
      // This reduces re-renders from ~100/sec → ~20/sec during streaming,
      // which prevents React from dropping RAF animation frames.
      (chunk) => {
        finalContent += chunk;
        chunkBufferRef.current += chunk;

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
            // Scroll to bottom s každým batch chunk — ale respektuje stick flag
            // (pokud user skroluje historií, scroll se nepřeruší)
            if (isAtBottomRef.current) {
              const el = messagesContainerRef.current;
              if (el) el.scrollTop = el.scrollHeight;
            }
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
        // Save assistant message to DB
        if (finalContent) {
          await storageService.appendMessage(convId, 'assistant', finalContent);
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
        setIsStreaming(false);
        setToolStatus(null);
        setMessages(prev => prev.slice(0, -1));
      },
      // options — tool-use mode
      {
        preps: dailyPreps,
        reviews: dailyReviews,
        // Všechny účty (i spálené) — tools umí filtrovat a reportovat per účet.
        accounts,
        // Sum of active account starting balances — Coach uses for $ → % conversion when user prefers %.
        initialBalance: accounts
          .filter(a => a.status !== 'Archived')
          .reduce((sum, a) => sum + (a.initialBalance || 0), 0) || undefined,
        onToolUse: (label) => setToolStatus(label),
      },
    );
  }, [messages, traderContext, trades, dailyPreps, dailyReviews, isStreaming, activeConvId]);

  // ─── Start with quick prompt (declared after sendMessage to avoid TDZ) ──────

  const startWithPrompt = useCallback(async (prompt: string) => {
    setCreateError(null);
    try {
      const conv = await storageService.createConversation();
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

  // ─── Group conversations ───────────────────────────────────────────────────

  const groupedConversations = React.useMemo(() => {
    const groups: Record<string, AIConversation[]> = {};
    const ORDER = ['Dnes', 'Včera', 'Tento týden', 'Starší'];
    for (const conv of conversations) {
      const group = getDateGroup(conv.updated_at);
      if (!groups[group]) groups[group] = [];
      groups[group].push(conv);
    }
    return ORDER.filter(g => groups[g]).map(g => ({ label: g, items: groups[g] }));
  }, [conversations]);

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
        {conversations.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 px-4 text-center">
            <Bot size={28} className="text-[var(--text-secondary)]" />
            <p className="text-xs text-[var(--text-secondary)]">Zatím žádné konverzace</p>
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
          {activeConvId ? (
            <span className="text-sm font-bold text-[var(--text-primary)] truncate block">
              {conversations.find(c => c.id === activeConvId)?.title ?? 'Konverzace'}
            </span>
          ) : (
            <span className="text-sm font-bold text-[var(--text-primary)]">AI Coach</span>
          )}
        </div>
      </div>

      {/* Messages */}
      <div ref={messagesContainerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-4 py-6 space-y-4 scrollbar-thin">
        {!activeConvId ? (
          // No conversation selected — show empty state with quick prompts
          <div className="flex flex-col items-center justify-center h-full gap-6 max-w-sm mx-auto">
            <div className="text-center">
              <div className="w-14 h-14 rounded-2xl bg-blue-600/10 border border-blue-500/20 flex items-center justify-center mx-auto mb-4">
                <Bot size={24} className="text-blue-400" />
              </div>
              <p className="text-base font-black text-[var(--text-primary)]">Ahoj! Jsem tvůj AI Coach.</p>
              <p className="text-sm text-[var(--text-secondary)] mt-1">Vyber konverzaci nebo začni novou.</p>
            </div>
            <div className="w-full space-y-2">
              {QUICK_PROMPTS.map(q => (
                <button
                  key={q}
                  onClick={() => startWithPrompt(q)}
                  className="w-full text-left px-4 py-2.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] hover:opacity-80 text-xs text-[var(--text-primary)] transition-all"
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
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full gap-5 max-w-md mx-auto px-2">
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
                <div className="w-full space-y-2">
                  {(proactive?.suggestions && proactive.suggestions.length > 0 ? proactive.suggestions : QUICK_PROMPTS).map(q => (
                    <button
                      key={q}
                      onClick={() => sendMessage(q)}
                      className="w-full text-left px-4 py-2.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] hover:border-blue-500/40 hover:bg-blue-500/5 text-xs text-[var(--text-primary)] transition-all active:scale-[0.98]"
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
          <div className="flex items-end gap-2 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] px-4 py-3">
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Napiš zprávu... (Enter = odeslat)"
              rows={1}
              disabled={isStreaming}
              className="flex-1 bg-transparent text-sm text-[var(--text-primary)] placeholder-slate-500 resize-none outline-none max-h-32 scrollbar-thin disabled:opacity-50"
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
          {ChatArea}
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
    </>
  );
};

export default AICoachPage;
