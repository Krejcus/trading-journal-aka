import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle, Brackets, Check, ChevronDown, ChevronLeft, ChevronRight, Clock, Droplet, Flame, GitCompare, Loader2, Lock,
  LogOut, Meh, Moon, MoveVertical, RotateCcw, Smile, Square, Tag, TrendingDown, TrendingUp, X, Zap,
} from 'lucide-react';
import type { Account, CustomEmotion, Trade } from '../types';
import AccountExecutionChart from './AccountExecutionChart';
import { REVIEW_FOCUS_EVENT, REVIEW_POINT_EVENT } from './CandleKitTradeChart';
import type { ReviewSlotElements } from './AlphaTradeChartWorkspace';
import ConfirmationModal from './ConfirmationModal';
import { QuantumSpinner } from './QuantumLoader';
import { shotTargetIds } from './HistoryScreenshotSlot';
import { storageService } from '../services/storageService';
import { isEvidenceJournalTrade } from '../lib/journalTradeFacts';
import { aggregateHistoryTrades, explicitTradeMaster, isCombinedTrade, tradeDetailMembers, tradeDetailSource } from '../lib/tradeHistoryPresentation';
import { chartNotesOf, type ChartNote } from '../lib/chartNotes';
import { loadReviewWeekCandles, tradeChartDataAvailable, tradeChartTiming } from '../services/tradeChartData';
import { loadProvisionalCandles } from '../services/provisionalCandles';
import type { MarketCandleResponse } from '../services/marketData';
import { planChoiceOf, planPatch } from '../lib/weeklyReview';
import { REVIEW_INVALID_REASONS, monthlyInvalidSummary, planSideError, reviewFacts, reviewR, undoPatch, type ReviewStep } from '../lib/tradeReviewFacts';
import { FIRM_LOGOS, firmColor, firmInitials, firmLabel, firmOf } from '../utils/accountFirm';

/**
 * Hodnocení obchodů z Tradovate (fronta „k revizi“). Fakta z brokera jsou
 * zamčená; upravuje se jen plán (plánovaný SL/TP → R), validita s důvodem,
 * štítky a poznámka. Desktop: workspace grafu se sloty (hlavička, panel
 * vlevo a vpravo), mobil: vložený graf a panely pod sebou.
 */
export default function TradeReview({
  queue, allTrades, accounts, isDark, emotions, htfOptions, ltfOptions, mistakeOptions,
  initialTradeId, initialNote, onUpdateTrade, onSaveChartNotes, onAttachScreenshot, onDirtyChange, onClose,
}: {
  queue: readonly Trade[];
  allTrades: readonly Trade[];
  accounts: readonly Account[];
  isDark: boolean;
  emotions: CustomEmotion[];
  htfOptions: string[];
  ltfOptions: string[];
  mistakeOptions: string[];
  initialTradeId?: string;
  initialNote?: string;
  onUpdateTrade: (tradeId: string | number, updates: Partial<Trade>) => unknown;
  onSaveChartNotes?: (tradeIds: readonly string[], notes: ChartNote[]) => Promise<boolean>;
  onAttachScreenshot?: (tradeIds: readonly string[], url: string) => Promise<boolean>;
  onDirtyChange?: (dirty: boolean) => void;
  onClose: () => void;
}) {
  // Aktuální podoba každého obchodu (po uložení se přepíše), fronta se ale
  // drží z okamžiku otevření — ohodnocené obchody z ní nemizí pod rukama.
  const display = useMemo(() => aggregateHistoryTrades(allTrades), [allTrades]);
  const displayById = useMemo(() => new Map(display.map(trade => [String(trade.id), trade])), [display]);
  const [ids] = useState<string[]>(() => {
    const list = [...queue].sort((a, b) => (b.timestamp || Date.parse(b.date)) - (a.timestamp || Date.parse(a.date))).map(trade => String(trade.id));
    if (!initialTradeId) return list;
    const target = display.find(trade => String(trade.id) === initialTradeId || trade.combinedTradeIds?.map(String).includes(initialTradeId));
    const id = target ? String(target.id) : initialTradeId;
    return [id, ...list.filter(other => other !== id)];
  });
  const items = useMemo(() => ids.map(id => displayById.get(id) ?? queue.find(trade => String(trade.id) === id)).filter((trade): trade is Trade => Boolean(trade)), [displayById, ids, queue]);
  const [index, setIndex] = useState(0);
  const current = items[Math.min(index, items.length - 1)] ?? null;
  // Graf převezme obchod až po dojetí přejezdu (animace 520 ms) — panely se
  // přepnou hned, těžké překreslení grafu nepřijde během pohybu.
  const [chartIndex, setChartIndex] = useState(0);
  const chartTimerRef = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(chartTimerRef.current), []);
  const [reviewed, setReviewed] = useState<{ id: string; net: number; valid: 'ok' | 'bad'; reasons: string[] }[]>([]);
  const [finished, setFinished] = useState(false);

  // Úzká obrazovka (telefon): bez workspace, graf vložený jako v detailu.
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < 1024);
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 1024);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // ── Historie plnění (celá skupina: leader i kopie) ────────────────────────
  const membersOf = useCallback((trade: Trade) => isCombinedTrade(trade) ? tradeDetailMembers(trade, allTrades) : [trade], [allTrades]);
  const [details, setDetails] = useState<Map<string, Trade>>(new Map());
  const requested = useRef(new Set<string>());
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  // Načítá se až po ustálení výběru (rychlé listování šipkami nespouští
  // desítky dotazů) a rozběhnutý dotaz se neruší — jen se po zavření zahodí.
  const [settledIndex, setSettledIndex] = useState(0);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettledIndex(index), 220);
    return () => window.clearTimeout(timer);
  }, [index]);
  const [detailRetry, setDetailRetry] = useState(0);
  useEffect(() => {
    const wanted = [items[settledIndex], items[settledIndex + 1]].filter((trade): trade is Trade => Boolean(trade))
      .flatMap(membersOf).filter(isEvidenceJournalTrade).map(trade => String(trade.id))
      .filter(id => !requested.current.has(id));
    if (!wanted.length) return;
    wanted.forEach(id => requested.current.add(id));
    storageService.getJournalTradeDetails(wanted)
      .then(rows => { if (mountedRef.current) setDetails(previous => { const next = new Map(previous); rows.forEach(row => next.set(String(row.id), row)); return next; }); })
      .catch(() => {
        wanted.forEach(id => requested.current.delete(id));
        if (mountedRef.current) window.setTimeout(() => setDetailRetry(n => n + 1), 1500);
      });
  }, [detailRetry, items, membersOf, settledIndex]);

  // ── Svíčky pro všechny obchody fronty (kontrakt ověřený pro každý zvlášť) ─
  const sources = useMemo(() => items.map(trade => tradeDetailSource(trade, allTrades) ?? trade), [allTrades, items]);
  const chartTrades = useMemo(() => sources.map(source => details.get(String(source.id)) ?? source), [details, sources]);
  // Svíčky po jednotlivých obchodech (aktuální + další): fronta může mít
  // stovky obchodů přes měsíce, jedno společné okno by bylo obří.
  const [candleMap, setCandleMap] = useState<Map<string, MarketCandleResponse | null>>(new Map());
  const candleRequested = useRef(new Set<string>());
  const candleRetryTimers = useRef(new Map<string, number>());
  const [candleRetry, setCandleRetry] = useState(0);
  useEffect(() => () => { for (const timer of candleRetryTimers.current.values()) window.clearTimeout(timer); }, []);
  useEffect(() => {
    if (narrow) return;
    for (const i of [settledIndex, settledIndex + 1]) {
      const source = sources[i];
      const trade = chartTrades[i];
      if (!source || !trade) continue;
      const id = String(trade.id);
      // Journal obchod čeká na historii plnění — z ní se volí kontrakt (rollover).
      if (candleRequested.current.has(id) || (isEvidenceJournalTrade(source) && !details.has(String(source.id)))) continue;
      candleRequested.current.add(id);
      loadReviewWeekCandles([trade])
        // Databento data ještě nemá (~24 h) → předběžné svíčky z TradingView.
        .then(async byTrade => {
          const timing = tradeChartTiming(trade);
          return byTrade.get(id) ?? (tradeChartDataAvailable(timing) ? null : await loadProvisionalCandles(trade, timing));
        })
        .then(data => {
          if (!mountedRef.current) return;
          setCandleMap(map => new Map(map).set(id, data));
          // Čerstvý obchod: worker čte svíčky 65 s a 20 min po výstupu — zkusit znovu.
          const { exitMs } = tradeChartTiming(trade);
          const retryAt = !data ? Date.now() + 45_000 : data.provider === 'tradingview' ? exitMs + 21 * 60_000 : 0;
          if (retryAt > Date.now() && Date.now() - exitMs < 24 * 3_600_000) {
            window.clearTimeout(candleRetryTimers.current.get(id));
            candleRetryTimers.current.set(id, window.setTimeout(() => {
              candleRequested.current.delete(id);
              setCandleRetry(value => value + 1);
            }, retryAt - Date.now()));
          }
        })
        .catch(() => { if (mountedRef.current) setCandleMap(map => new Map(map).set(id, null)); });
    }
  }, [candleRetry, chartTrades, details, narrow, settledIndex, sources]);
  const candleOf = (trade: Trade | null | undefined) => trade ? candleMap.get(String(trade.id)) ?? undefined : undefined;
  const currentChartTrade = chartTrades[Math.min(chartIndex, chartTrades.length - 1)] ?? null;
  const panelChartTrade = current ? chartTrades[items.indexOf(current)] ?? null : null;
  const candlesReady = panelChartTrade ? candleMap.has(String(panelChartTrade.id)) : false;
  const chartData = candleOf(currentChartTrade);
  const contextTrades = useMemo(() => currentChartTrade && chartData ? [currentChartTrade] : [], [chartData, currentChartTrade]);

  // ── Rozepsané hodnocení ───────────────────────────────────────────────────
  const [draftState, setDraftState] = useState<{ id: string; draft: ReviewDraft } | null>(null);
  // Sloučená skupina nese v `notes` pomocný text „(Kombinováno z N účtů)“ —
  // poznámka se proto bere ze skutečného řádku (leader / zdroj detailu).
  const noteSource = current ? sources[items.indexOf(current)] ?? current : null;
  const baseDraft = useMemo(() => current ? draftOf(current, noteSource, current === items[0] ? initialNote : undefined) : null, [current, initialNote, items, noteSource]);
  const draft = current && draftState?.id === String(current.id) ? draftState.draft : baseDraft;
  const setDraft = useCallback((update: (d: ReviewDraft) => ReviewDraft) => {
    if (!current || !baseDraft) return;
    setDraftState(previous => ({ id: String(current.id), draft: update(previous?.id === String(current.id) ? previous.draft : baseDraft) }));
  }, [baseDraft, current]);
  const dirty = Boolean(current && draft && baseDraft && JSON.stringify(draft) !== JSON.stringify(draftOf(current, noteSource)));
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  // ── Přepínání a ukládání ──────────────────────────────────────────────────
  const [phase, setPhase] = useState<'idle' | 'saving' | 'saved' | 'leaving'>('idle');
  const [enterKey, setEnterKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ key: number; text: string; undo: () => void } | null>(null);
  const [confirmClose, setConfirmClose] = useState<null | (() => void)>(null);

  const onUpdateRef = useRef(onUpdateTrade);
  onUpdateRef.current = onUpdateTrade;
  // Animace po Hotovo: šipka nebo zavření v jejím průběhu ji zruší.
  const doneTimers = useRef<number[]>([]);
  const clearDoneTimers = useCallback(() => {
    for (const timer of doneTimers.current) window.clearTimeout(timer);
    doneTimers.current = [];
  }, []);
  useEffect(() => clearDoneTimers, [clearDoneTimers]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 8_000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const go = useCallback((nextIndex: number) => {
    const target = items[nextIndex];
    if (!target) return;
    const chartTarget = chartTrades[nextIndex];
    if (chartTarget) {
      const timing = tradeChartTiming(chartTarget);
      window.dispatchEvent(new CustomEvent(REVIEW_FOCUS_EVENT, { detail: { entryMs: timing.entryMs, exitMs: timing.exitMs, id: String(chartTarget.id) } }));
    }
    window.dispatchEvent(new CustomEvent(REVIEW_POINT_EVENT, { detail: null }));
    setIndex(nextIndex); setError(null); setDraftState(null); setEnterKey(key => key + 1);
    window.clearTimeout(chartTimerRef.current);
    chartTimerRef.current = window.setTimeout(() => setChartIndex(nextIndex), 540);
  }, [chartTrades, items]);
  const guarded = useCallback((action: () => void) => { if (dirty) setConfirmClose(() => action); else action(); }, [dirty]);
  const move = useCallback((delta: number) => guarded(() => {
    if (phase === 'saving') return;
    clearDoneTimers(); setPhase('idle');
    go((index + delta + items.length) % items.length);
  }), [clearDoneTimers, go, guarded, index, items.length, phase]);
  const close = useCallback(() => guarded(() => { clearDoneTimers(); onClose(); }), [clearDoneTimers, guarded, onClose]);

  const blocked = draft?.valid === 'bad' && (!draft.reasons.length || draft.why.trim().length < 5);
  const markDone = useCallback(async () => {
    if (!current || !draft || phase !== 'idle' || blocked) return;
    const planFacts = reviewFacts(current, (details.get(String((sources[index] ?? current).id)) ?? current).executionHistory);
    if (planSideError(planFacts, numberOrNull(draft.plannedSL), numberOrNull(draft.plannedTP))) {
      setError('Plánovaný SL nebo TP je na špatné straně vstupu.');
      return;
    }
    setPhase('saving'); setError(null);
    const bad = draft.valid === 'bad';
    const patch = {
      ...planPatch(bad ? 'no' : 'yes'),
      invalidReasons: bad ? draft.reasons : [],
      invalidNote: bad ? draft.why.trim() : '',
      plannedStopLoss: numberOrNull(draft.plannedSL),
      plannedTakeProfit: numberOrNull(draft.plannedTP),
      htfConfluence: draft.htf, ltfConfluence: draft.ltf, emotions: draft.emotions,
      mistakes: bad ? current.mistakes ?? [] : draft.mistakes,
      notes: draft.notes,
    } as unknown as Partial<Trade>;
    const previous = undoPatch(current, patch);
    const wasPending = current.needsReview === true;
    try {
      const result = await onUpdateTrade(current.id, patch);
      if (result === false) throw new Error('Hodnocení se nepodařilo uložit.');
    } catch (reason) {
      setPhase('idle');
      setError(reason instanceof Error ? reason.message : 'Hodnocení se nepodařilo uložit.');
      return;
    }
    const facts = planFacts;
    setReviewed(list => [...list.filter(item => item.id !== String(current.id)), { id: String(current.id), net: Number(current.pnl) || 0, valid: bad ? 'bad' : 'ok', reasons: bad ? draft.reasons : [] }]);
    setDraftState(null);
    setPhase('saved');
    const tradeId = current.id;
    setToast({
      key: Date.now(),
      text: `${current.instrument || ''} ${clock(facts.entryAt)} · ${money(Number(current.pnl) || 0)} · ${bad ? 'mimo plán' : 'podle plánu'}`,
      // Aktuální handler: ten zachycený při Hotovo porovnává se stavem před uložením.
      undo: () => {
        setToast(null);
        setReviewed(list => list.filter(item => item.id !== String(tradeId)));
        void Promise.resolve(onUpdateRef.current(tradeId, { ...previous, needsReview: wasPending })).then(result => {
          if (result === false && mountedRef.current) setError('Vrácení se nepodařilo uložit.');
        });
      },
    });
    clearDoneTimers();
    doneTimers.current.push(window.setTimeout(() => setPhase('leaving'), 460));
    doneTimers.current.push(window.setTimeout(() => {
      setPhase('idle');
      const next = items.findIndex((trade, i) => i > index && trade.needsReview === true);
      const wrap = items.findIndex((trade, i) => i !== index && trade.needsReview === true);
      const target = next >= 0 ? next : wrap;
      if (target < 0) setFinished(true);
      else go(target);
    }, 700));
  }, [blocked, clearDoneTimers, current, details, draft, go, index, items, onUpdateTrade, phase, sources]);

  // Klávesy: ← → mimo pole, ⌘↵ hotovo, Esc zavřít.
  const keysRef = useRef({ move, markDone, close });
  keysRef.current = { move, markDone, close };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void keysRef.current.markDone(); return; }
      const target = event.target as HTMLElement | null;
      if (target?.closest?.('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
      if (event.key === 'ArrowRight') { event.preventDefault(); keysRef.current.move(1); }
      if (event.key === 'ArrowLeft') { event.preventDefault(); keysRef.current.move(-1); }
      if (event.key === 'Escape' && narrow) { event.preventDefault(); keysRef.current.close(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [narrow]);

  // ── Graf (desktop): workspace s místy pro panely ──────────────────────────
  const [slots, setSlots] = useState<ReviewSlotElements | null>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  const stableClose = useCallback(() => closeRef.current(), []);
  const review = useMemo(() => chartData ? { onSlotsReady: setSlots, onClose: stableClose, trades: contextTrades, drawingKey: 'review-queue', data: chartData } : null,
    [chartData, contextTrades, stableClose]);
  const [notesOverride, setNotesOverride] = useState<Map<string, ChartNote[]>>(new Map());
  const chartNotes = useMemo(() => currentChartTrade ? notesOverride.get(String(currentChartTrade.id)) ?? chartNotesOf(currentChartTrade) : [], [currentChartTrade, notesOverride]);
  const notesChange = useMemo(() => onSaveChartNotes && current && currentChartTrade ? (next: ChartNote[]) => {
    const id = String(currentChartTrade.id);
    setNotesOverride(map => new Map(map).set(id, next));
    void onSaveChartNotes(shotTargetIds(current), next).then(ok => { if (!ok) setNotesOverride(map => { const copy = new Map(map); copy.delete(id); return copy; }); });
  } : undefined, [current, currentChartTrade, onSaveChartNotes]);
  const snapshotSave = useMemo(() => onAttachScreenshot && current ? async (image: Blob) => {
    const ids = shotTargetIds(current);
    if (!ids.length) return false;
    const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(image); });
    const url = await storageService.uploadScreenshot(dataUrl, ids[0]);
    return onAttachScreenshot(ids, url);
  } : undefined, [current, onAttachScreenshot]);
  const chartElement = useMemo(() => !narrow && currentChartTrade && review ? (
    <AccountExecutionChart trade={currentChartTrade} verifiedDetail={currentChartTrade.executionHistory ? currentChartTrade : undefined}
      isDark={isDark} variant="detail" chartNotes={chartNotes} onChartNotesChange={notesChange} onSaveSnapshot={snapshotSave} review={review} />
  ) : null, [chartNotes, currentChartTrade, isDark, narrow, notesChange, review, snapshotSave]);

  // ── Panely ────────────────────────────────────────────────────────────────
  const [openFold, setOpenFold] = useState<{ steps: boolean; accounts: boolean }>({ steps: false, accounts: false });
  const [openTag, setOpenTag] = useState<string | null>(null);
  const invalidMonth = useMemo(() => monthlyInvalidSummary(display), [display]);

  if (!items.length) {
    return <Shell isDark={isDark}><Empty isDark={isDark} text="Nic nečeká na hodnocení. Všechny obchody z Tradovate jsou ohodnocené." onClose={onClose} /></Shell>;
  }
  if (finished || !current || !draft) {
    return <Shell isDark={isDark}><DoneScreen isDark={isDark} reviewed={reviewed} total={items.length} onClose={onClose} /></Shell>;
  }

  const members = membersOf(current);
  const source = sources[items.indexOf(current)] ?? current;
  const sourceDetail = details.get(String(source.id)) ?? source;
  const facts = reviewFacts(source, sourceDetail.executionHistory);
  const { r, rr } = reviewR(facts, numberOrNull(draft.plannedSL), numberOrNull(draft.plannedTP));
  const net = Number(current.pnl) || 0;
  const feeTotal = members.reduce((sum, member) => sum + (details.get(String(member.id))?.executionHistory?.fees ?? 0), 0);
  const hasFees = members.some(member => details.get(String(member.id))?.executionHistory?.fees != null);
  const leader = explicitTradeMaster(members) ?? members[0];
  const leaderEntry = reviewFacts(leader, details.get(String(leader.id))?.executionHistory).entryAt;
  const accountRows = members.map(member => {
    const account = accounts.find(item => item.id === member.accountId);
    const memberFacts = reviewFacts(member, details.get(String(member.id))?.executionHistory);
    return {
      id: String(member.id), name: account?.name ?? String(member.accountId), firm: account ? firmOf(account) : 'OSTATNÍ',
      leader: member === leader, latency: member === leader ? null : Math.max(0, memberFacts.entryAt - leaderEntry), pnl: Number(member.pnl) || 0,
    };
  });
  const maxLatency = accountRows.reduce((max, row) => Math.max(max, row.latency ?? 0), 0);
  const noSL = facts.brokerSL == null && numberOrNull(draft.plannedSL) == null;
  const sideError = planSideError(facts, numberOrNull(draft.plannedSL), numberOrNull(draft.plannedTP));
  const line = isDark ? 'border-white/[0.07]' : 'border-slate-200';
  const muted = isDark ? 'text-slate-500' : 'text-slate-500';
  const ink = isDark ? 'text-slate-100' : 'text-slate-900';
  const cellBg = isDark ? 'bg-white/[0.02]' : 'bg-white';
  const label = 'text-[9px] font-black uppercase tracking-[0.12em] text-slate-500';
  const tone = (v: number | null) => v == null ? '' : v > 0 ? 'text-emerald-500' : v < 0 ? 'text-rose-500' : ink;
  const long = facts.long;
  const leaving = phase === 'leaving';
  const pointOf = (step: ReviewStep) => ({ atMs: step.at, price: step.price, color: STEP_COLOR[step.kind] });

  const header = (
    <div className={`shrink-0 flex flex-wrap items-center gap-2 px-4 py-2 border-b ${line} ${isDark ? 'bg-[#0b1017]' : 'bg-white'}`}>
      <span className={`text-[13.5px] font-extrabold mr-1 ${ink}`}>{narrow ? 'Hodnocení' : 'Hodnocení obchodu'}</span>
      <Pill className={long ? 'text-emerald-500 bg-emerald-500/10 border-emerald-500/30' : 'text-rose-500 bg-rose-500/10 border-rose-500/30'}>{long ? '↗ Long' : '↘ Short'}</Pill>
      <Pill isDark={isDark}>{current.instrument || '—'}</Pill>
      <Pill isDark={isDark}>{new Date(facts.entryAt).toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric' })} · {clock(facts.entryAt)}–{clock(facts.exitAt)}</Pill>
      {noSL && <Pill className="text-amber-600 bg-amber-500/10 border-amber-500/40">⚠ Bez SL</Pill>}
      {!narrow && <Pill isDark={isDark}><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />Tradovate</Pill>}
      {!narrow && chartData?.provider === 'tradingview' && (
        <span title="Svíčky z TradingView přečtené po výstupu. Databento je nahradí zhruba 24 h po trhu.">
          <Pill className="text-amber-600 bg-amber-500/10 border-amber-500/40">Předběžný graf · TradingView</Pill>
        </span>
      )}
      <span className="flex-1" />
      {narrow && <button type="button" onClick={close} aria-label="Zavřít hodnocení" className={`h-8 w-8 -mr-1.5 grid place-items-center rounded-md ${muted}`}><X size={17} /></button>}
      {narrow && <span className="basis-full h-0" />}
      <div className={`flex items-center overflow-hidden rounded-md border ${line} h-8 ${narrow ? 'flex-1 justify-between' : ''}`}>
        <button type="button" onClick={() => move(-1)} disabled={items.length < 2} aria-label="Předchozí obchod" className={`h-full w-8 grid place-items-center disabled:opacity-30 ${isDark ? 'hover:bg-white/5' : 'hover:bg-slate-50'}`}><ChevronLeft size={15} /></button>
        <span className={`h-full px-2.5 flex items-center border-x text-[11.5px] font-semibold tabular-nums ${line} ${muted}`}>
          <b key={index} className={`tr-flip mr-1 ${ink}`}>{index + 1}</b>/ {items.length} k revizi</span>
        <button type="button" onClick={() => move(1)} disabled={items.length < 2} aria-label="Další obchod" className={`h-full w-8 grid place-items-center disabled:opacity-30 ${isDark ? 'hover:bg-white/5' : 'hover:bg-slate-50'}`}><ChevronRight size={15} /></button>
      </div>
      {!narrow && <button type="button" onClick={() => move(1)} className={`h-8 px-3 rounded-md border text-[12px] font-bold ${line} ${muted} ${isDark ? 'hover:bg-white/5' : 'hover:bg-slate-50'}`}>Přeskočit</button>}
      <DoneButton phase={phase} blocked={blocked} last={items.filter(trade => trade.needsReview === true).length <= 1} onClick={() => { void markDone(); }} />
    </div>
  );

  const progress = (
    <div className={`h-[2px] ${isDark ? 'bg-white/[0.06]' : 'bg-slate-200'}`}>
      <div className="h-full bg-indigo-500 transition-[width] duration-500" style={{ width: `${reviewed.length / items.length * 100}%` }} />
    </div>
  );

  const left = (
    <aside key={`l${enterKey}`} className={`w-full lg:w-[272px] shrink-0 lg:border-r flex flex-col min-h-0 overflow-y-auto ${line} ${isDark ? 'bg-[#0b1017]' : 'bg-slate-50/70'} ${leaving ? 'tr-leave' : 'tr-enter'}`}>
      <div className={`px-4 pt-3.5 pb-3 border-b ${line}`}>
        <p className={label}>Čistý výsledek{members.length > 1 ? ` · skupina ${members.length} účty` : ''}</p>
        <p className={`mt-1.5 text-[32px] font-light tracking-[-0.04em] leading-none tabular-nums ${tone(net)}`}>{money(net)}</p>
        {hasFees && <p className={`mt-2 text-[11.5px] ${muted}`}>Hrubě <b className={`font-medium tabular-nums ${ink}`}>{money(net + feeTotal)}</b> · poplatky <b className={`font-medium tabular-nums ${ink}`}>${fmt(feeTotal)}</b></p>}
        {draft.valid === 'bad' && <span className="mt-2 inline-flex h-[22px] items-center whitespace-nowrap rounded border border-rose-500/30 bg-rose-500/10 px-2 text-[9.5px] font-black uppercase tracking-[0.07em] text-rose-500">✕ Mimo plán · mimo statistiky</span>}
      </div>
      <Section title="Plnění" aux={<><Lock size={10} /> z Tradovate</>} />
      <Cells isDark={isDark}>
        <Cell label="Vstup" value={price(facts.entryPrice)} sub={clockS(facts.entryAt)} />
        <Cell label="Výstup" value={price(facts.exitPrice)} sub={clockS(facts.exitAt)} />
        <Cell label="Pohyb" value={facts.move == null ? '—' : `${facts.move >= 0 ? '+' : '−'}${fmt(Math.abs(facts.move))} b.`} className={tone(facts.move)} />
        <Cell label="Držení" value={holdText(facts.exitAt - facts.entryAt)} />
        <Cell wide label="Velikost · výstup" value={`${source.positionSize || 1} ks${members.length > 1 ? ` × ${members.length} účty` : ''}`} sub={facts.exitKind === 'sl' ? 'Stop loss' : facts.exitKind === 'tp' ? 'Take profit' : 'Ruční výstup'} inline />
      </Cells>
      {noSL && <p className="mx-3 mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-[11px] leading-snug"><b className="text-amber-600">Bez stop lossu.</b> R nejde spočítat, doplň plánovaný SL.</p>}
      <Section title="Tvůj plán" aux="jen R, ne P&L" />
      <Cells isDark={isDark}>
        <InputCell label="Plán SL" value={draft.plannedSL} placeholder={facts.brokerSL != null ? price(facts.brokerSL) : 'doplň'} onChange={value => setDraft(d => ({ ...d, plannedSL: value }))} />
        <InputCell label="Plán TP" value={draft.plannedTP} placeholder={facts.brokerTP != null ? price(facts.brokerTP) : 'doplň'} onChange={value => setDraft(d => ({ ...d, plannedTP: value }))} />
        <Cell wide label="Výsledek" value={r == null ? '— R' : `${r >= 0 ? '+' : '−'}${fmt(Math.abs(r))} R`} sub={`plán ${rr == null ? '—' : `1 : ${rr.toLocaleString('cs-CZ', { maximumFractionDigits: 1, minimumFractionDigits: 1 })}`}`} inline className={r == null ? 'text-amber-600' : tone(r)} />
      </Cells>
      {sideError && <p className="mx-3 mt-1.5 text-[10.5px] font-semibold text-rose-500" role="alert">
        {sideError === 'sl' ? `SL musí být ${facts.long ? 'pod' : 'nad'} vstupem` : `TP musí být ${facts.long ? 'nad' : 'pod'} vstupem`} ({price(facts.entryPrice ?? 0)}).
      </p>}
      <Section title="Průběh obchodu" aux={<><Lock size={10} /> objednávky</>} />
      <Fold open={openFold.steps} onToggle={() => setOpenFold(state => ({ ...state, steps: !state.steps }))} line={line} bg={cellBg}
        summary={<>{facts.steps.length} kroků · {noSL ? <b className="text-amber-600">bez SL</b> : facts.steps.some(step => step.label === 'SL posunut') ? 'SL posunut' : 'SL beze změny'} · {facts.exitKind === 'tp' ? 'TP' : facts.exitKind === 'sl' ? 'stop loss' : 'ruční výstup'} {clock(facts.exitAt)}</>}>
        <ol className="tr-row-in -mx-1.5 py-1" onMouseLeave={() => window.dispatchEvent(new CustomEvent(REVIEW_POINT_EVENT, { detail: null }))}>
          {facts.steps.map((step, i) => (
            <li key={i} onMouseEnter={() => window.dispatchEvent(new CustomEvent(REVIEW_POINT_EVENT, { detail: pointOf(step) }))}
              className={`grid grid-cols-[56px_1fr_auto] items-center h-6 px-1.5 rounded text-[11px] transition-colors ${isDark ? 'hover:bg-white/5' : 'hover:bg-slate-100'}`}>
              <time className={`text-[10px] tabular-nums ${muted}`}>{clockS(step.at)}</time>
              <span className={isDark ? 'text-slate-300' : 'text-slate-600'}>{step.label}</span>
              <b className="font-semibold tabular-nums" style={{ color: STEP_COLOR[step.kind] }}>{price(step.price)}</b>
            </li>
          ))}
        </ol>
      </Fold>
      <Section title="Účty" aux={<><Lock size={10} /> kopírka</>} />
      <Fold open={openFold.accounts} onToggle={() => setOpenFold(state => ({ ...state, accounts: !state.accounts }))} line={line} bg={cellBg}
        summary={<span className="flex flex-wrap items-center gap-1.5"><b className={ink}>{members.length} {members.length === 1 ? 'účet' : members.length < 5 ? 'účty' : 'účtů'}</b>
          {firmGroups(accountRows).map(group => <span key={group.firm} className={`inline-flex h-[22px] items-center gap-1 rounded-full border pl-0.5 pr-2 text-[10.5px] font-semibold ${line} ${isDark ? 'bg-white/[0.03]' : 'bg-white'}`}><FirmMark firm={group.firm} size={18} />{firmLabel(group.firm)}{group.count > 1 ? ` ×${group.count}` : ''}</span>)}
          {maxLatency > 0 && <span className={muted}>· kopie do {maxLatency} ms</span>}</span>}>
        <div className="tr-row-in py-1">
          {accountRows.map(row => (
            <div key={row.id} className={`grid grid-cols-[auto_1fr_auto] items-center gap-2 h-[30px] text-[11.5px] border-b border-dashed last:border-0 ${line}`}>
              <FirmMark firm={row.firm} size={22} />
              <span className={`flex items-center gap-1.5 min-w-0 font-semibold whitespace-nowrap ${ink}`}><span className="truncate">{row.name}</span>
                <span className={`rounded border px-1 text-[8px] font-black uppercase tracking-[0.08em] leading-[14px] ${row.leader ? 'border-blue-500/30 bg-blue-500/10 text-blue-500' : `${line} ${muted}`}`}>{row.leader ? 'Leader' : 'Follower'}</span></span>
              <b className={`font-semibold tabular-nums ${tone(row.pnl)}`} title={row.latency != null ? `kopie +${row.latency} ms` : 'leader'}>{money(row.pnl)}</b>
            </div>
          ))}
        </div>
      </Fold>
      <div className="h-3 shrink-0" />
    </aside>
  );

  const tagGroups: { id: string; title: string; color: string; options: string[]; value: string[]; set: (next: string[]) => void; labelOf?: (id: string) => string }[] = [
    { id: 'htf', title: 'HTF kontext', color: isDark ? '#60a5fa' : '#2563eb', options: htfOptions, value: draft.htf, set: htf => setDraft(d => ({ ...d, htf })) },
    { id: 'ltf', title: 'LTF trigger', color: isDark ? '#f59e0b' : '#b45309', options: ltfOptions, value: draft.ltf, set: ltf => setDraft(d => ({ ...d, ltf })) },
    { id: 'emotions', title: 'Emoce', color: isDark ? '#a78bfa' : '#7c3aed', options: emotions.map(e => e.id), value: draft.emotions, set: next => setDraft(d => ({ ...d, emotions: next })), labelOf: id => emotions.find(e => e.id === id)?.label ?? id },
    ...(draft.valid === 'bad' ? [] : [{ id: 'mistakes', title: 'Drobné chyby', color: isDark ? '#fb7185' : '#e11d48', options: mistakeOptions, value: draft.mistakes, set: (mistakes: string[]) => setDraft(d => ({ ...d, mistakes })) }]),
  ];

  const right = (
    <aside key={`r${enterKey}`} className={`w-full lg:w-[264px] shrink-0 lg:border-l flex flex-col min-h-0 overflow-y-auto ${line} ${isDark ? 'bg-[#0b1017]' : 'bg-slate-50/70'} ${leaving ? 'tr-leave' : 'tr-enter'}`}>
      <Section title="Validita" aux="P / M" />
      <div className={`mx-3 grid grid-cols-2 overflow-hidden rounded-md border ${line}`} role="radiogroup" aria-label="Validita">
        {(['ok', 'bad'] as const).map(value => (
          <button key={value} type="button" role="radio" aria-checked={draft.valid === value} onClick={() => setDraft(d => ({ ...d, valid: value }))}
            className={`h-8 text-[11.5px] font-bold transition-colors ${value === 'bad' ? `border-l ${line}` : ''} ${draft.valid === value
              ? value === 'ok' ? 'bg-emerald-500/10 text-emerald-500 shadow-[inset_0_-2px_0_#10b981]' : 'bg-rose-500/10 text-rose-500 shadow-[inset_0_-2px_0_#f43f5e]'
              : muted}`}>{value === 'ok' ? '✓ Podle plánu' : '✕ Mimo plán'}</button>
        ))}
      </div>
      {draft.valid === 'bad' ? (
        <div className="mx-3 mt-2 rounded-md border border-rose-500/30 bg-rose-500/[0.06] p-2">
          <p className={`mb-1.5 text-[11.5px] font-bold ${ink}`}>Proč to nebylo podle plánu?</p>
          <div className="flex flex-wrap gap-1">
            {REVIEW_INVALID_REASONS.map(reason => {
              const on = draft.reasons.includes(reason);
              return <button key={reason} type="button" onClick={() => setDraft(d => ({ ...d, reasons: on ? d.reasons.filter(x => x !== reason) : [...d.reasons, reason] }))}
                className={`h-[22px] rounded-full border px-2 text-[10.5px] font-semibold transition-colors ${on ? 'border-rose-500 bg-rose-500 text-white' : `${line} ${isDark ? 'bg-white/[0.03] text-slate-400' : 'bg-white text-slate-500'}`}`}>{reason}</button>;
            })}
          </div>
          <textarea value={draft.why} onChange={event => setDraft(d => ({ ...d, why: event.target.value }))} rows={2} placeholder="Co se stalo a co příště udělám jinak… (povinné)"
            className={`mt-1.5 w-full resize-y rounded-md border px-2 py-1.5 text-[11.5px] outline-none ${draft.why.trim().length < 5 ? 'border-rose-500/40' : line} ${isDark ? 'bg-white/[0.03] text-slate-200' : 'bg-white text-slate-800'}`} />
          <div className="mt-1 flex flex-col gap-0.5 border-t border-dashed border-rose-500/30 pt-1.5 text-[10.5px]">
            <p className="flex justify-between gap-2"><span className={muted}>Statistiky strategie</span><b className="text-rose-500">nepočítá se</b></p>
            <p className="flex justify-between gap-2"><span className={muted}>P&amp;L účtu a výplaty</span><b className="text-emerald-500">počítá se</b></p>
            {invalidMonth.count > 0 && <p className="flex justify-between gap-2"><span className={muted}>Tento měsíc mimo plán</span><b className="tabular-nums">{invalidMonth.count} · {money(invalidMonth.pnl)}</b></p>}
          </div>
        </div>
      ) : <p className={`mx-3 mt-1.5 text-[10.5px] ${muted}`}>Počítá se do statistik strategie i do P&amp;L účtu.</p>}
      <div className="flex flex-col gap-1.5 mt-1">
        {tagGroups.map(group => (
          <TagGroup key={group.id} {...group} isDark={isDark} line={line} open={openTag === group.id}
            onToggle={() => setOpenTag(openTag === group.id ? null : group.id)} />
        ))}
      </div>
      <Section title="Poznámka" />
      <textarea value={draft.notes} onChange={event => setDraft(d => ({ ...d, notes: event.target.value }))} rows={4} placeholder="Co se dělo, proč vstup, co příště jinak…"
        className={`mx-3 mb-3 resize-y rounded-md border px-2.5 py-2 text-[12px] leading-relaxed outline-none focus:border-indigo-500/50 ${line} ${isDark ? 'bg-white/[0.03] text-slate-200' : 'bg-white text-slate-800'}`} />
      {error && <p className="mx-3 mb-3 text-[11px] font-semibold text-rose-500" role="alert">{error}</p>}
    </aside>
  );

  const toastEl = toast && (
    <div key={toast.key} className={`tr-toast native-fixed-above-tab-bar fixed left-5 bottom-5 z-[320] flex items-center gap-3 h-10 pl-3 pr-2 rounded-md text-[12px] shadow-xl ${isDark ? 'bg-slate-100 text-slate-900' : 'bg-slate-900 text-white'}`}>
      <span className="grid h-[18px] w-[18px] place-items-center rounded-full bg-emerald-500 text-white"><Check size={11} strokeWidth={4} /></span>
      <span>Uloženo · <b>{toast.text}</b></span>
      <button type="button" onClick={toast.undo} className="h-[26px] rounded px-2 text-[11.5px] font-bold bg-black/10">Vrátit</button>
    </div>
  );
  const confirm = (
    <ConfirmationModal isOpen={confirmClose !== null} onClose={() => setConfirmClose(null)}
      onConfirm={() => { const action = confirmClose; setConfirmClose(null); setDraftState(null); onDirtyChange?.(false); action?.(); }}
      title="Zahodit rozepsané hodnocení?" message="Hodnocení tohoto obchodu ještě není uložené. Když odejdeš, ztratí se."
      confirmText="Zahodit" cancelText="Pokračovat v hodnocení" variant="warning" theme={isDark ? 'dark' : 'light'} />
  );

  // Telefon: vložený graf a panely pod sebou, Hotovo dole.
  if (narrow) {
    return (
      <Shell isDark={isDark}>
        <div className="absolute inset-0 flex flex-col">
          {header}{progress}
          {/* Konec panelů (poznámka) musí jít odscrollovat nad nativní lištu. */}
          <div className="native-page-scroll-content flex-1 min-h-0 overflow-y-auto pb-[max(1rem,env(safe-area-inset-bottom))]">
            <div className="h-[46vh] min-h-[260px]">
              {currentChartTrade && <AccountExecutionChart key={String(currentChartTrade.id)} trade={currentChartTrade} verifiedDetail={currentChartTrade.executionHistory ? currentChartTrade : undefined}
                isDark={isDark} variant="detail" chartNotes={chartNotes} onChartNotesChange={notesChange} />}
            </div>
            {left}{right}
          </div>
        </div>
        {toastEl}{confirm}
      </Shell>
    );
  }

  return (
    <Shell isDark={isDark}>
      {chartElement ? (
        <div className="absolute inset-0">
          {chartElement}
          {slots && createPortal(<>{header}{progress}</>, slots.header)}
          {slots && createPortal(left, slots.left)}
          {slots && createPortal(right, slots.side)}
        </div>
      ) : (
        <div className="absolute inset-0 flex flex-col">
          {header}{progress}
          <div className="flex flex-1 min-h-0">
            {left}
            <div className="relative flex-1 min-w-0 grid place-items-center">
              {!candlesReady ? <QuantumSpinner /> : (
                <div className={`w-[340px] rounded-lg border p-4 shadow-lg ${line} ${isDark ? 'bg-[#0b1017]' : 'bg-white'}`}>
                  <p className={`text-[13px] font-bold ${ink}`}>Graf dorazí zítra v {clock(facts.exitAt)}</p>
                  <p className={`mt-1 text-[11.5px] leading-relaxed ${muted}`}>K tomuto obchodu zatím nejsou svíčky. Doplní je přesná data z Databentu (zpoždění 24 h). Hodnotit můžeš hned, poznámky do grafu až zítra.</p>
                </div>
              )}
              <button type="button" onClick={close} aria-label="Zavřít hodnocení" className={`absolute right-3 top-3 h-8 w-8 grid place-items-center rounded-md ${muted}`}><X size={17} /></button>
            </div>
            {right}
          </div>
        </div>
      )}
      {toastEl}{confirm}
    </Shell>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

interface ReviewDraft {
  valid: 'ok' | 'bad';
  reasons: string[];
  why: string;
  plannedSL: string;
  plannedTP: string;
  htf: string[];
  ltf: string[];
  emotions: string[];
  mistakes: string[];
  notes: string;
}

function draftOf(trade: Trade, noteSource?: Trade | null, initialNote?: string): ReviewDraft {
  const note = (isCombinedTrade(trade) ? noteSource?.notes : trade.notes) ?? '';
  return {
    valid: planChoiceOf(trade) === 'no' ? 'bad' : 'ok',
    reasons: [...(trade.invalidReasons ?? [])],
    why: trade.invalidNote ?? '',
    plannedSL: trade.plannedStopLoss != null ? String(trade.plannedStopLoss) : '',
    plannedTP: trade.plannedTakeProfit != null ? String(trade.plannedTakeProfit) : '',
    htf: [...(trade.htfConfluence ?? [])],
    ltf: [...(trade.ltfConfluence ?? [])],
    emotions: [...(trade.emotions ?? [])],
    mistakes: [...(trade.mistakes ?? [])],
    notes: initialNote ? [note, initialNote].filter(Boolean).join('\n\n') : note,
  };
}

const STEP_COLOR: Record<ReviewStep['kind'], string> = { entry: '#3b82f6', sl: '#f43f5e', tp: '#10b981', exit: '#64748b' };

const numberOrNull = (value: string): number | null => {
  const n = Number(String(value).replace(',', '.').replace(/\s/g, ''));
  return value.trim() && Number.isFinite(n) && n > 0 ? n : null;
};
const fmt = (value: number, digits = 2) => value.toLocaleString('cs-CZ', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const money = (value: number) => `${value < 0 ? '−' : value > 0 ? '+' : ''}$${fmt(Math.abs(value))}`;
const price = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? '—' : fmt(value);
const clock = (ms: number) => new Date(ms).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
const clockS = (ms: number) => new Date(ms).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const holdText = (ms: number) => {
  if (!(ms > 0)) return '—';
  const total = Math.round(ms / 1000), h = Math.floor(total / 3600), m = Math.floor(total % 3600 / 60), s = total % 60;
  return h ? `${h} h ${m} min` : m ? `${m} min ${s} s` : `${s} s`;
};
const firmGroups = (rows: readonly { firm: string }[]) => {
  const counts = new Map<string, number>();
  rows.forEach(row => counts.set(row.firm, (counts.get(row.firm) ?? 0) + 1));
  return [...counts.entries()].map(([firm, count]) => ({ firm, count }));
};

/** Ikona štítku podle jeho názvu (vlastní štítky nemají pevnou sadu). */
function tagIcon(text: string) {
  const t = text.toLowerCase();
  const pick = (Icon: typeof Tag) => <Icon size={11} strokeWidth={2.2} className="shrink-0" />;
  if (/(↑|bull|long|up\b|nahoru|býč)/.test(t)) return pick(TrendingUp);
  if (/(↓|bear|short|down|dolů|medv)/.test(t)) return pick(TrendingDown);
  if (/sweep|likvid|liquid/.test(t)) return pick(Droplet);
  if (/fvg|gap|imbal/.test(t)) return pick(Square);
  if (/\bib\b|range|rozsah/.test(t)) return pick(Brackets);
  if (/bos|choch|mss|struktur/.test(t)) return pick(TrendingUp);
  if (/smt|diverg/.test(t)) return pick(GitCompare);
  if (/retest|návrat/.test(t)) return pick(RotateCcw);
  if (/klid|calm|zen|focus/.test(t)) return pick(Smile);
  if (/fomo|chamt|greed/.test(t)) return pick(Zap);
  if (/strach|fear|nerv|anx/.test(t)) return pick(AlertTriangle);
  if (/reveng|pomst|tilt|vztek|anger/.test(t)) return pick(Flame);
  if (/nuda|bored/.test(t)) return pick(Meh);
  if (/pozd|late|brzy|early/.test(t)) return pick(Clock);
  if (/\bsl\b|stop/.test(t)) return pick(MoveVertical);
  if (/výstup|exit|předčas/.test(t)) return pick(LogOut);
  if (/seanc|session|noc/.test(t)) return pick(Moon);
  return pick(Tag);
}

function Shell({ isDark, children }: { isDark: boolean; children: React.ReactNode }) {
  return <div className={`fixed inset-0 z-[290] ${isDark ? 'bg-[#070a0f] text-slate-400' : 'bg-[#f4f6f8] text-slate-500'}`}>{children}</div>;
}

function Empty({ isDark, text, onClose }: { isDark: boolean; text: string; onClose: () => void }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-[12.5px]">
      <p className={isDark ? 'text-slate-300' : 'text-slate-600'}>{text}</p>
      <button type="button" onClick={onClose} className="text-[11.5px] font-bold underline">Zavřít</button>
    </div>
  );
}

function DoneScreen({ isDark, reviewed, total, onClose }: { isDark: boolean; reviewed: { net: number; valid: 'ok' | 'bad'; reasons: string[] }[]; total: number; onClose: () => void }) {
  const ok = reviewed.filter(item => item.valid === 'ok').length;
  const net = reviewed.reduce((sum, item) => sum + item.net, 0);
  const reasons = reviewed.flatMap(item => item.reasons);
  const top = [...new Set(reasons)].sort((a, b) => reasons.filter(x => x === b).length - reasons.filter(x => x === a).length)[0] ?? '—';
  const line = isDark ? 'border-white/10' : 'border-slate-200';
  const cells: [string, React.ReactNode][] = [
    ['Podle plánu', <span className="text-emerald-500">{ok}</span>],
    ['Mimo plán', <span className={reviewed.length - ok ? 'text-rose-500' : ''}>{reviewed.length - ok}</span>],
    ['Čistý P&L', <span className={net > 0 ? 'text-emerald-500' : net < 0 ? 'text-rose-500' : ''}>{money(net)}</span>],
    ['Nejčastější důvod', <span className="text-[14px]">{top}</span>],
  ];
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3.5 tr-enter px-4">
      <svg className="tr-done-ring" width="76" height="76" viewBox="0 0 76 76" fill="none">
        <circle cx="38" cy="38" r="35" stroke="#10b981" strokeWidth="3" transform="rotate(-90 38 38)" />
        <path d="M24 39l9.5 9.5L53 29" stroke="#10b981" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <h2 className={`text-[22px] font-bold tracking-tight ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{reviewed.length >= total ? 'Všechny obchody ohodnocené' : `Ohodnoceno ${reviewed.length} z ${total}`}</h2>
      <p className="text-[13px]">Fronta je prázdná, statistiky se přepočítaly.</p>
      <div className={`grid grid-cols-2 sm:grid-cols-4 overflow-hidden rounded-md border ${line}`}>
        {cells.map(([name, value], i) => (
          <div key={name} className={`tr-rise px-3.5 py-2.5 sm:min-w-[150px] border-r last:border-r-0 ${line}`} style={{ animationDelay: `${0.5 + i * 0.08}s` }}>
            <p className="text-[9px] font-black uppercase tracking-[0.12em] text-slate-500">{name}</p>
            <p className={`mt-0.5 text-[17px] font-medium tabular-nums ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{value}</p>
          </div>
        ))}
      </div>
      <button type="button" onClick={onClose} className={`mt-2 h-8 px-4 rounded-md text-[12px] font-bold ${isDark ? 'bg-slate-100 text-slate-900' : 'bg-slate-900 text-white'}`}>Zavřít</button>
    </div>
  );
}

function DoneButton({ phase, blocked, last, onClick }: { phase: 'idle' | 'saving' | 'saved' | 'leaving'; blocked: boolean; last: boolean; onClick: () => void }) {
  if (blocked) return <button type="button" disabled title="Doplň důvod a popis" className="h-8 px-3 rounded-md bg-slate-500/15 text-[12px] font-bold text-slate-500 cursor-not-allowed">Doplň důvod</button>;
  const saved = phase === 'saved' || phase === 'leaving';
  return (
    <button type="button" onClick={onClick} disabled={phase !== 'idle'}
      className={`h-8 px-3 inline-flex items-center gap-1.5 rounded-md text-[12px] font-bold text-white transition-colors ${saved ? 'bg-emerald-500' : 'bg-indigo-600 hover:bg-indigo-500'}`}>
      {phase === 'saving' ? <><Loader2 size={13} className="animate-spin" />Ukládám</>
        : saved ? <><svg className="tr-check" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>Uloženo</>
        : <>{last ? 'Hotovo' : 'Hotovo → další'}<kbd className="hidden lg:inline rounded border border-white/35 px-1 text-[10px] font-semibold leading-[15px] opacity-80">⌘↵</kbd></>}
    </button>
  );
}

function Pill({ children, className, isDark }: { children: React.ReactNode; className?: string; isDark?: boolean }) {
  return <span className={`inline-flex h-[22px] items-center gap-1.5 rounded border px-2 text-[9.5px] font-black uppercase tracking-[0.07em] whitespace-nowrap ${className ?? (isDark ? 'border-white/10 text-slate-400' : 'border-slate-200 text-slate-500')}`}>{children}</span>;
}

function Section({ title, aux }: { title: string; aux?: React.ReactNode }) {
  return <div className="flex items-center justify-between gap-2 px-4 pt-2.5 pb-1.5"><span className="text-[9px] font-black uppercase tracking-[0.12em] text-slate-500">{title}</span>{aux && <span className="flex items-center gap-1 text-[10px] text-slate-500">{aux}</span>}</div>;
}

/** Mřížka buněk s vlasovými linkami (mezera 1 px na podkladu barvy linky). */
function Cells({ children, isDark }: { children: React.ReactNode; isDark: boolean }) {
  return <div className={`grid grid-cols-2 gap-px border-y ${isDark ? 'bg-white/[0.07] border-white/[0.07]' : 'bg-slate-200 border-slate-200'}`}
    style={{ ['--tr-cell' as string]: isDark ? '#0d1219' : '#ffffff' }}>{children}</div>;
}

function Cell({ label, value, sub, wide, inline, className }: { label: string; value: React.ReactNode; sub?: string; wide?: boolean; inline?: boolean; className?: string }) {
  return (
    <div className={`px-3.5 py-1.5 bg-[var(--tr-cell)] ${wide ? 'col-span-2' : ''}`}>
      <p className="text-[9px] font-black uppercase tracking-[0.12em] text-slate-500">{label}</p>
      <p className={`mt-px text-[13px] font-medium tabular-nums whitespace-nowrap ${className || ''}`}>{value}
        {sub && (inline ? <span className="ml-1.5 text-[10.5px] font-normal text-slate-500">{sub}</span> : <span className="block text-[10px] font-normal text-slate-500">{sub}</span>)}</p>
    </div>
  );
}

function InputCell({ label, value, placeholder, onChange }: { label: string; value: string; placeholder: string; onChange: (value: string) => void }) {
  return (
    <label className="block px-3.5 py-1.5 bg-[var(--tr-cell)] shadow-[inset_2px_0_0_#6366f1]">
      <span className="block text-[9px] font-black uppercase tracking-[0.12em] text-slate-500">{label}</span>
      <input inputMode="decimal" value={value} placeholder={placeholder} onChange={event => onChange(event.target.value)}
        className="mt-px w-full bg-transparent text-[13px] font-medium tabular-nums outline-none placeholder:text-slate-400/70" />
    </label>
  );
}

function Fold({ open, onToggle, summary, children, line, bg }: { open: boolean; onToggle: () => void; summary: React.ReactNode; children: React.ReactNode; line: string; bg: string }) {
  return (
    <div className={`mx-3 overflow-hidden rounded-md border ${line} ${bg}`}>
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full items-center gap-2 px-2.5 py-2 text-left text-[11.5px]">
        <span className="flex-1 min-w-0 leading-snug">{summary}</span>
        <ChevronDown size={13} className={`shrink-0 text-slate-400 transition-transform duration-300 ${open ? 'rotate-180' : ''}`} />
      </button>
      <div className="review-section-body" data-open={open} inert={!open}>
        <div><div className={`border-t px-2.5 ${line}`}>{open && children}</div></div>
      </div>
    </div>
  );
}

function FirmMark({ firm, size }: { firm: string; size: number }) {
  const key = firm.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const logo = FIRM_LOGOS[key];
  const style = { width: size, height: size };
  return logo
    ? <img src={logo} alt="" style={style} className="shrink-0 rounded-full border border-black/10 bg-white object-cover" />
    : <span style={{ ...style, background: firmColor(key || firm).bg }} className="grid shrink-0 place-items-center rounded-full text-[8px] font-black text-white">{firmInitials(firm)}</span>;
}

/** Skupina štítků: zavřená ukazuje vybrané (× při najetí), klik kamkoli ji otevře. */
function TagGroup({ title, color, options, value, set, labelOf = (id: string) => id, open, onToggle, isDark, line }: {
  title: string; color: string; options: string[]; value: string[]; set: (next: string[]) => void; labelOf?: (id: string) => string;
  open: boolean; onToggle: () => void; isDark: boolean; line: string;
}) {
  const all = [...options, ...value.filter(item => !options.includes(item))];
  const toggle = (item: string) => set(value.includes(item) ? value.filter(x => x !== item) : [...value, item]);
  const pill = (item: string, on: boolean) => `inline-flex h-6 items-center gap-1.5 rounded-full border pl-2 pr-2.5 text-[10.5px] font-semibold transition-colors ${on ? '' : isDark ? 'border-white/10 bg-white/[0.03] text-slate-400 hover:text-slate-200' : 'border-slate-200 bg-white text-slate-500 hover:text-slate-800'}`;
  const onStyle = { color, borderColor: `${color}73`, background: `${color}1f` };
  return (
    <div onClick={open ? undefined : onToggle} role={open ? undefined : 'button'}
      className={`mx-3 rounded-[10px] border transition-[border-color,box-shadow] ${open ? '' : 'cursor-pointer'} ${isDark ? 'bg-white/[0.02]' : 'bg-white'} ${line}`}
      style={open ? { borderColor: `${color}73`, boxShadow: `0 0 0 3px ${color}1a` } : undefined}>
      <button type="button" onClick={event => { event.stopPropagation(); onToggle(); }} className="flex w-full items-center gap-1.5 px-2.5 pt-2 pb-1.5 text-left">
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
        <span className="flex-1 text-[8.5px] font-black uppercase tracking-[0.11em] text-slate-500">{title}</span>
        {value.length > 0 && <span className="text-[10px] font-bold" style={{ color }}>{value.length}</span>}
        <ChevronDown size={12} className={`text-slate-400 transition-transform duration-300 ${open ? 'rotate-180' : ''}`} />
      </button>
      {!open && (
        <div className="flex flex-wrap gap-1 px-2 pb-2">
          {value.length ? value.map(item => (
            <span key={item} className={`tr-pill relative ${pill(item, true)}`} style={onStyle}>
              {tagIcon(labelOf(item))}{labelOf(item)}
              <button type="button" onClick={event => { event.stopPropagation(); toggle(item); }} title="Odebrat" aria-label={`Odebrat ${labelOf(item)}`}
                className={`tr-pill-x absolute -right-1.5 -top-1.5 h-[15px] w-[15px] place-items-center rounded-full text-[10px] leading-none shadow ${isDark ? 'bg-slate-100 text-slate-900' : 'bg-slate-900 text-white'} hover:bg-rose-500 hover:text-white`}>×</button>
            </span>
          )) : <span className="px-0.5 text-[11px] text-slate-400">Klikni a vyber</span>}
        </div>
      )}
      <div className="review-section-body" data-open={open} inert={!open}>
        <div>
          <div className="flex flex-wrap gap-1 px-2 pb-2">
            {all.map(item => (
              <button key={item} type="button" onClick={() => toggle(item)} aria-pressed={value.includes(item)} className={pill(item, value.includes(item))} style={value.includes(item) ? onStyle : undefined}>
                {tagIcon(labelOf(item))}{labelOf(item)}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
