import React, { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { Check, ChevronLeft, ChevronRight, Loader2, X } from 'lucide-react';
import { QuantumSpinner } from './QuantumLoader';
import type { CustomEmotion, Trade } from '../types';
import AccountExecutionChart from './AccountExecutionChart';
import { REVIEW_FOCUS_EVENT } from './CandleKitTradeChart';
import type { ReviewSlotElements } from './AlphaTradeChartWorkspace';
import { createPortal } from 'react-dom';
import { storageService } from '../services/storageService';
import { isEvidenceJournalTrade } from '../lib/journalTradeFacts';
import { tradeDetailSource } from '../lib/tradeHistoryPresentation';
import { chartNotesOf, type ChartNote } from '../lib/chartNotes';
import { formatHoldDuration } from '../lib/holdDuration';
import { loadReviewWeekCandles, tradeChartTiming } from '../services/tradeChartData';
import type { MarketCandleResponse } from '../services/marketData';
import {
  planChoiceOf, planPatch, reviewDays, reviewWeeks, tradeTimeMs, tradesInWeek, weekLabel, weekStartOf, weekStats,
  type PlanChoice,
} from '../lib/weeklyReview';

/**
 * Review týdne: fullscreen graf obchodu (stejný workspace, indikátory,
 * rozložení grafů, poznámky, Snímek) + pás obchodů týdne dole a rychlé
 * hodnocení vpravo. Šipky ← → přepínají obchody, Enter = hotovo a další
 * nezkontrolovaný. Hodnocení ukládá stejná pole jako formulář Zkontrolovat.
 */
export default function WeeklyReview({ trades, allTrades, isDark, emotions, initialTradeId, onUpdateTrade, onSaveChartNotes, onAttachScreenshot, onClose }: {
  /** Obchody z Historie (aktuální filtry). */
  trades: readonly Trade[];
  allTrades: readonly Trade[];
  isDark: boolean;
  emotions: CustomEmotion[];
  initialTradeId?: string;
  onUpdateTrade: (tradeId: string | number, updates: Partial<Trade>) => unknown;
  onSaveChartNotes?: (trade: Trade, notes: ChartNote[]) => Promise<boolean>;
  onAttachScreenshot?: (trade: Trade, image: Blob) => Promise<string | null>;
  onClose: () => void;
}) {
  const weeks = useMemo(() => reviewWeeks(trades), [trades]);
  const [weekStart, setWeekStart] = useState(() => {
    const initial = trades.find(trade => String(trade.id) === initialTradeId);
    return initial ? weekStartOf(tradeTimeMs(initial)) : weeks.at(-1) ?? weekStartOf(Date.now());
  });
  const weekTrades = useMemo(() => tradesInWeek(trades, weekStart), [trades, weekStart]);
  const days = useMemo(() => reviewDays(weekTrades), [weekTrades]);
  const stats = useMemo(() => weekStats(weekTrades), [weekTrades]);
  const [selectedId, setSelectedId] = useState<string | null>(() => initialTradeId ?? null);
  const selected = weekTrades.find(trade => String(trade.id) === selectedId)
    ?? weekTrades.find(trade => trade.needsReview) ?? weekTrades[0] ?? null;
  const selectedIndex = selected ? weekTrades.indexOf(selected) : -1;

  // Detaily (historie plnění) Tradovate obchodů celého týdne jedním dotazem —
  // přepínání obchodů pak graf nenačítá znovu.
  const sources = useMemo(() => weekTrades.map(trade => tradeDetailSource(trade, allTrades) ?? trade), [weekTrades, allTrades]);
  const [details, setDetails] = useState<{ week: number; byId: Map<string, Trade> } | null>(null);
  useEffect(() => {
    const ids = sources.filter(isEvidenceJournalTrade).map(trade => String(trade.id));
    if (!ids.length) { setDetails({ week: weekStart, byId: new Map() }); return; }
    const controller = new AbortController();
    setDetails(null);
    storageService.getJournalTradeDetails(ids, controller.signal)
      .then(rows => { if (!controller.signal.aborted) setDetails({ week: weekStart, byId: new Map(rows.map(row => [String(row.id), row])) }); })
      .catch(() => { if (!controller.signal.aborted) setDetails({ week: weekStart, byId: new Map() }); });
    return () => controller.abort();
  }, [sources, weekStart]);
  const detailsReady = details?.week === weekStart;
  // Obchody týdne pro graf (s historií plnění) a okno svíček přes celý týden.
  const chartTrades = useMemo(() => sources.map(row => (details?.week === weekStart ? details.byId.get(String(row.id)) : undefined) ?? row), [details, sources, weekStart]);
  // Svíčky týdne: kontrakt ověřený pro každý obchod zvlášť (týden přes
  // rollover má obchody na dvou kontraktech s rozdílem ~300 bodů). Stahuje se
  // znovu jen při změně obchodů/vstupů, ne při uložení hodnocení.
  const candleKey = useMemo(() => detailsReady
    ? chartTrades.map(trade => { const t = tradeChartTiming(trade); return `${trade.id}:${t.firstEntry.at}:${t.firstEntry.price}:${t.exitMs}`; }).join('|')
    : '', [chartTrades, detailsReady]);
  const chartTradesRef = useRef(chartTrades);
  chartTradesRef.current = chartTrades;
  const [weekCandles, setWeekCandles] = useState<{ key: string; byTrade: Map<string, MarketCandleResponse>; error?: string } | null>(null);
  useEffect(() => {
    if (!candleKey) return;
    let cancelled = false;
    loadReviewWeekCandles(chartTradesRef.current)
      .then(byTrade => { if (!cancelled) setWeekCandles({ key: candleKey, byTrade }); })
      .catch(reason => { if (!cancelled) setWeekCandles({ key: candleKey, byTrade: new Map(), error: reason instanceof Error ? reason.message : 'Svíčky se nepodařilo načíst.' }); });
    return () => { cancelled = true; };
  }, [candleKey]);
  const candlesReady = weekCandles != null && weekCandles.key === candleKey;
  const candlesOf = (trade: Trade | null | undefined) => trade && weekCandles ? weekCandles.byTrade.get(String(trade.id)) : undefined;
  const chartTradeOfRef = useRef<(trade: Trade) => Trade>(trade => trade);
  chartTradeOfRef.current = trade => {
    const index = weekTrades.indexOf(trade);
    return index >= 0 ? chartTrades[index] : trade;
  };
  // Graf převezme nový obchod až po dojetí přejezdu (viz select) — panel
  // a pás se přepnou hned, těžké překreslení grafu nepřijde během pohybu.
  const [chartSelectedId, setChartSelectedId] = useState<string | null>(null);
  const chartSelected = weekTrades.find(trade => String(trade.id) === chartSelectedId) ?? selected;
  // Při otevření (a po změně týdne) graf převezme výběr hned; dál už jen se zpožděním.
  useEffect(() => {
    if (chartSelectedId == null && selected) setChartSelectedId(String(selected.id));
  }, [chartSelectedId, selected]);
  const chartIndex = chartSelected ? weekTrades.indexOf(chartSelected) : -1;
  const source = chartSelected ? sources[chartIndex] : null;
  const detail = source && details?.week === weekStart ? details.byId.get(String(source.id)) : undefined;
  const selectedChartTrade = detail ?? source;
  // Obchod bez svíček (mladší než ~24 h): graf zůstane na posledním obchodu,
  // který svíčky má; panel ukáže poznámku.
  const lastChartTradeRef = useRef<Trade | null>(null);
  if (selectedChartTrade && candlesOf(selectedChartTrade)) lastChartTradeRef.current = selectedChartTrade;
  const chartTrade = selectedChartTrade && candlesOf(selectedChartTrade) ? selectedChartTrade : lastChartTradeRef.current;
  const chartData = candlesOf(chartTrade);
  const selectedHasChart = Boolean(candlesOf(selected ? chartTradeOfRef.current(selected) : null));
  // Vedle vybraného jen obchody ze stejného kontraktu (jiný by visel o rozdíl cen mimo).
  const contextTrades = useMemo(() => chartData ? chartTrades.filter(trade => candlesOf(trade) === chartData) : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- candlesOf čte weekCandles
    [chartData, chartTrades, weekCandles]);

  // Poznámky v grafu: po úpravě hned odsud (načtený detail je ještě nemá).
  const [notesOverride, setNotesOverride] = useState<Map<string, ChartNote[]>>(new Map());
  const chartNotes = useMemo(() => chartTrade ? notesOverride.get(String(chartTrade.id)) ?? chartNotesOf(chartTrade) : [], [chartTrade, notesOverride]);

  const [prefs, setPrefs] = useState<{ htf: string[]; ltf: string[]; mistakes: string[] }>({ htf: [], ltf: [], mistakes: [] });
  useEffect(() => {
    storageService.getCachedPreferences().then((p: any) => {
      if (p) setPrefs({ htf: p.htfOptions || [], ltf: p.ltfOptions || [], mistakes: p.standardMistakes || [] });
    }).catch(() => {});
  }, []);

  // Sekce hodnocení: které jsou rozbalené (drží se i při přepnutí obchodu).
  const [openSections, setOpenSections] = useState<Set<string>>(() => new Set());
  const toggleSection = useCallback((id: string) => setOpenSections(current => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  }), []);
  const emotionIds = useMemo(() => emotions.map(emotion => emotion.id), [emotions]);
  const emotionLabel = useCallback((id: string) => emotions.find(item => item.id === id)?.label ?? id, [emotions]);

  // Rozepsané hodnocení vybraného obchodu (uloží se „Hotovo“).
  // Odvozené přímo (ne efektem) — přepnutí obchodu = jediný render.
  const draftTradeId = selected ? String(selected.id) : null;
  const [draftState, setDraftState] = useState<{ id: string; draft: ReviewDraft } | null>(null);
  const draft = selected ? (draftState?.id === draftTradeId ? draftState.draft : draftOf(selected)) : null;
  const setDraft = useCallback((update: (current: ReviewDraft | null) => ReviewDraft | null) => {
    if (!selected || !draftTradeId) return;
    setDraftState(previous => {
      const base = previous?.id === draftTradeId ? previous.draft : draftOf(selected);
      const next = update(base);
      return next ? { id: draftTradeId, draft: next } : null;
    });
  }, [draftTradeId, selected]);
  // Vybraná karta v pásu vždy na očích.
  useEffect(() => {
    if (!draftTradeId) return;
    document.querySelector(`[data-review-card="${CSS.escape(draftTradeId)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }, [draftTradeId]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Přepnutí: graf začne přejíždět hned (událost mimo React), výběr a panel
  // se překreslí v transition — po kouscích, bez zastavení animace.
  const [, startSelecting] = useTransition();
  const chartSwitchTimerRef = useRef<number | undefined>(undefined);
  const select = useCallback((trade: Trade | undefined) => {
    if (!trade) return;
    // Graf zná obchody pod id zdroje (sloučený obchod → jeho zdroj), ne pod id ze seznamu.
    const chartTarget = chartTradeOfRef.current(trade);
    const timing = tradeChartTiming(chartTarget);
    window.dispatchEvent(new CustomEvent(REVIEW_FOCUS_EVENT, { detail: { entryMs: timing.entryMs, exitMs: timing.exitMs, id: String(chartTarget.id) } }));
    const id = String(trade.id);
    setSelectedId(id); setSaveError(null);
    window.clearTimeout(chartSwitchTimerRef.current);
    chartSwitchTimerRef.current = window.setTimeout(() => startSelecting(() => setChartSelectedId(id)), CHART_SWITCH_DELAY_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(chartSwitchTimerRef.current), []);
  const move = useCallback((delta: number) => {
    if (!weekTrades.length) return;
    select(weekTrades[(selectedIndex + delta + weekTrades.length) % weekTrades.length]);
  }, [select, selectedIndex, weekTrades]);

  const markDone = useCallback(async () => {
    if (!selected || !draft || saving) return;
    setSaving(true); setSaveError(null);
    const patch: Partial<Trade> = {
      ...(draft.plan ? planPatch(draft.plan) : {}),
      htfConfluence: draft.htf, ltfConfluence: draft.ltf, emotions: draft.emotions, mistakes: draft.mistakes, notes: draft.notes,
    };
    try {
      const result = await onUpdateTrade(selected.id, patch);
      if (result === false) throw new Error('Hodnocení se nepodařilo uložit.');
      const next = weekTrades.find((trade, index) => index > selectedIndex && trade.needsReview)
        ?? weekTrades.find(trade => trade.needsReview && trade !== selected);
      select(next ?? weekTrades[(selectedIndex + 1) % weekTrades.length]);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Hodnocení se nepodařilo uložit.');
    } finally {
      setSaving(false);
    }
  }, [draft, onUpdateTrade, saving, select, selected, selectedIndex, weekTrades]);

  // ← → a Enter mimo pole pro psaní (Bar Replay si šipku bere sám).
  const keysRef = useRef({ move, markDone });
  keysRef.current = { move, markDone };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest?.('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]')) {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void keysRef.current.markDone();
        return;
      }
      if (event.key === 'ArrowRight') { event.preventDefault(); keysRef.current.move(1); }
      if (event.key === 'ArrowLeft') { event.preventDefault(); keysRef.current.move(-1); }
      if (event.key === 'Enter') { event.preventDefault(); void keysRef.current.markDone(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const weekIndex = weeks.indexOf(weekStart);
  const changeWeek = (delta: number) => {
    const next = weeks[weekIndex + delta];
    if (next == null) return;
    setWeekStart(next);
    setSelectedId(null);
    window.clearTimeout(chartSwitchTimerRef.current);
    setChartSelectedId(null);
  };

  const money = (value: number) => `${value >= 0 ? '+' : '−'}$${Math.abs(value).toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const tone = (value: number) => value > 0 ? 'text-emerald-500' : value < 0 ? 'text-rose-500' : isDark ? 'text-slate-300' : 'text-slate-600';
  const line = isDark ? 'border-white/10' : 'border-slate-200';
  const muted = isDark ? 'text-slate-500' : 'text-slate-500';
  const label = 'text-[9px] font-black uppercase tracking-[0.12em] text-slate-500';

  const header = (
    <div className={`shrink-0 flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-2 border-b ${line} ${isDark ? 'bg-[#0b1017]' : 'bg-white'}`}>
      <div className="flex items-center gap-1.5">
        <button type="button" onClick={() => changeWeek(-1)} disabled={weekIndex <= 0} aria-label="Předchozí týden"
          className={`h-7 w-7 grid place-items-center rounded-md border disabled:opacity-30 ${line}`}><ChevronLeft size={14} /></button>
        <span className="min-w-[150px] text-center text-[13px] font-black">{weekLabel(weekStart)}</span>
        <button type="button" onClick={() => changeWeek(1)} disabled={weekIndex < 0 || weekIndex >= weeks.length - 1} aria-label="Další týden"
          className={`h-7 w-7 grid place-items-center rounded-md border disabled:opacity-30 ${line}`}><ChevronRight size={14} /></button>
      </div>
      <div className={`flex items-center overflow-hidden rounded-lg border ${line}`} role="group" aria-label="Přepínání obchodů">
        <button type="button" onClick={() => move(-1)} disabled={weekTrades.length < 2} title="Předchozí obchod (←)" aria-label="Předchozí obchod"
          className={`h-8 w-9 grid place-items-center transition-colors disabled:opacity-30 ${isDark ? 'hover:bg-white/5' : 'hover:bg-slate-100'}`}><ChevronLeft size={16} /></button>
        <span className={`h-8 min-w-[108px] px-2 grid place-items-center border-x text-[11.5px] font-bold tabular-nums ${line}`}>
          Obchod {selectedIndex + 1} / {weekTrades.length}</span>
        <button type="button" onClick={() => move(1)} disabled={weekTrades.length < 2} title="Další obchod (→)" aria-label="Další obchod"
          className={`h-8 w-9 grid place-items-center transition-colors disabled:opacity-30 ${isDark ? 'hover:bg-white/5' : 'hover:bg-slate-100'}`}><ChevronRight size={16} /></button>
      </div>
      {([
        ['Týden', <span className={tone(stats.pnl)}>{money(stats.pnl)}</span>],
        ['Obchody', stats.count],
        ['Win rate', `${Math.round(stats.winRate * 100)} %`],
        ['Nejlepší', <span className="text-emerald-500">{money(stats.best)}</span>],
        ['Nejhorší', <span className="text-rose-500">{money(stats.worst)}</span>],
      ] as Array<[string, React.ReactNode]>).map(([name, value]) => (
        <div key={name}><p className={label}>{name}</p><p className="text-[13.5px] font-bold tabular-nums">{value}</p></div>
      ))}
      <div className="ml-auto flex items-center gap-2.5 text-[11px] text-slate-500">
        Zkontrolováno {stats.reviewed}/{stats.count}
        <span className={`h-1.5 w-32 overflow-hidden rounded-full ${isDark ? 'bg-white/10' : 'bg-slate-200'}`}>
          <span className="block h-full rounded-full bg-emerald-500 transition-[width] duration-300" style={{ width: `${stats.count ? stats.reviewed / stats.count * 100 : 0}%` }} />
        </span>
      </div>
    </div>
  );

  const bottom = (
    <div className={`shrink-0 flex gap-4 overflow-x-auto border-t px-3 py-2.5 ${line} ${isDark ? 'bg-[#0b1017]' : 'bg-white'}`}>
      {days.map(day => (
        <div key={day.key} className="shrink-0">
          <p className={`${label} mb-1.5 ml-0.5`}>{day.label}<span className={`ml-1.5 normal-case tracking-normal font-bold ${tone(day.pnl)}`}>{money(day.pnl)}</span></p>
          <div className="flex gap-1.5">
            {day.trades.map(trade => (
              <ReviewCard key={String(trade.id)} trade={trade} on={trade === selected} isDark={isDark} onSelect={select} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );

  const holdText = selected ? formatHoldDuration(tradeTimeMs(selected), selected.timestamp || Date.parse(selected.date)) ?? '—' : '—';
  const side = (
    <aside className={`w-[252px] shrink-0 border-l flex flex-col min-h-0 ${line} ${isDark ? 'bg-[#0b1017]' : 'bg-white'}`}>
      {selected && draft ? (
        <>
          {/* Děti se nesmí smrsknout (sloupec se posouvá, ne zmenšuje). */}
          <div className="flex-1 min-h-0 overflow-y-auto px-3 pt-3 pb-2 flex flex-col gap-2 [&>*]:shrink-0">
            <div className="flex items-center gap-1.5 text-[11.5px] font-bold">
              <span className="truncate">{new Date(tradeTimeMs(selected)).toLocaleDateString('cs-CZ', { weekday: 'short', day: 'numeric', month: 'numeric' })} · {clock(tradeTimeMs(selected))}</span>
              <span className={`rounded border px-1 py-px text-[8.5px] font-black ${String(selected.direction).toLowerCase() === 'long' ? 'border-emerald-500/30 text-emerald-500' : 'border-rose-500/30 text-rose-500'}`}>
                {String(selected.direction).toUpperCase()}</span>
              <span className={`ml-auto rounded px-1.5 py-0.5 text-[8.5px] font-black uppercase tracking-wide transition-colors ${selected.needsReview ? 'bg-amber-500/10 text-amber-600' : 'bg-emerald-500/10 text-emerald-500'}`}>
                {selected.needsReview ? 'K revizi' : 'Hotovo'}</span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className={`text-[22px] font-semibold tabular-nums leading-none ${tone(Number(selected.pnl) || 0)}`}>{money(Number(selected.pnl) || 0)}</span>
              <span className="text-[11px] tabular-nums text-slate-500">{holdText}</span>
            </div>
            <p className="text-[10.5px] tabular-nums text-slate-500 truncate">
              {fmtPrice(selected.entryPrice)} → <b className={isDark ? 'font-semibold text-slate-300' : 'font-semibold text-slate-700'}>{fmtPrice(selected.exitPrice)}</b> · {selected.positionSize || 1} {selected.instrument || ''}
            </p>
            <div className={`flex overflow-hidden rounded-lg border ${line}`} role="radiogroup" aria-label="Dle plánu">
              {([['yes', 'Ano', 'bg-emerald-500/15 text-emerald-500'], ['partial', 'Částečně', 'bg-amber-500/15 text-amber-500'], ['no', 'Ne', 'bg-rose-500/15 text-rose-500']] as Array<[PlanChoice, string, string]>).map(([value, text, active], index) => (
                <button key={value} type="button" role="radio" aria-checked={draft.plan === value} onClick={() => setDraft(current => current && { ...current, plan: value })}
                  className={`flex-1 py-1.5 text-[11px] font-bold transition-colors duration-150 ${index ? `border-l ${line}` : ''} ${draft.plan === value ? active : 'text-slate-500'}`}>{text}</button>
              ))}
            </div>
            <ReviewSection id="htf" title="Setup · HTF" open={openSections.has('htf')} onToggle={toggleSection} options={prefs.htf} value={draft.htf}
              onChange={htf => setDraft(current => current && { ...current, htf })} isDark={isDark} />
            <ReviewSection id="ltf" title="Setup · LTF" open={openSections.has('ltf')} onToggle={toggleSection} options={prefs.ltf} value={draft.ltf}
              onChange={ltf => setDraft(current => current && { ...current, ltf })} isDark={isDark} />
            <ReviewSection id="emotions" title="Emoce" open={openSections.has('emotions')} onToggle={toggleSection} options={emotionIds} labelOf={emotionLabel}
              value={draft.emotions} onChange={next => setDraft(current => current && { ...current, emotions: next })} isDark={isDark} />
            <ReviewSection id="mistakes" title="Chyby" open={openSections.has('mistakes')} onToggle={toggleSection} options={prefs.mistakes} value={draft.mistakes}
              onChange={mistakes => setDraft(current => current && { ...current, mistakes })} isDark={isDark} bad />
            <textarea value={draft.notes} onChange={event => setDraft(current => current && { ...current, notes: event.target.value })}
              placeholder="Poznámka — co příště jinak…" rows={2}
              className={`w-full resize-y rounded-lg border px-2.5 py-1.5 text-[11.5px] outline-none transition-colors focus:border-amber-500 ${line} ${isDark ? 'bg-white/[0.03] text-slate-200' : 'bg-slate-50 text-slate-800'}`} />
            {candlesReady && !selectedHasChart && <p className="text-[10.5px] font-semibold text-amber-600">Graf tohoto obchodu bude k dispozici zhruba 24 h po obchodu — v grafu zůstává předchozí.</p>}
            {saveError && <p className="text-[11px] font-semibold text-rose-500" role="alert">{saveError}</p>}
          </div>
          <div className={`shrink-0 border-t px-3 py-2.5 ${line}`}>
            <div className="flex gap-2">
              <button type="button" onClick={() => move(1)} className={`h-9 flex-1 rounded-lg border text-[11.5px] font-bold transition-colors ${line} ${isDark ? 'text-slate-400 hover:bg-white/5' : 'text-slate-500 hover:bg-slate-50'}`}>Přeskočit →</button>
              <button type="button" onClick={() => { void markDone(); }} disabled={saving}
                className="h-9 flex-[1.5] inline-flex items-center justify-center gap-1.5 rounded-lg bg-emerald-500 text-[11.5px] font-bold text-emerald-950 transition-colors hover:bg-emerald-400 disabled:opacity-60">
                {saving ? <Loader2 size={13} className="animate-spin" /> : null}{selected.needsReview ? 'Hotovo → další' : 'Uložit → další'}
              </button>
            </div>
            <p className="mt-1.5 text-center text-[9.5px] text-slate-500">← → přepínání · Enter hotovo · Esc zavřít</p>
          </div>
        </>
      ) : <p className="p-4 text-[12px] text-slate-500">V tomhle týdnu nejsou žádné obchody.</p>}
    </aside>
  );

  // Graf je v memo prvku: změna výběru (panel, pás, pruh — kreslené přes
  // portál do míst ve workspace) ho nepřekresluje. Graf se překreslí jen při
  // změně svého obchodu (po dojetí přejezdu), poznámek nebo týdne.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const stableClose = useCallback(() => onCloseRef.current(), []);
  const [slots, setSlots] = useState<ReviewSlotElements | null>(null);
  const drawingKey = `review-${weekStart}`;
  const review = useMemo(() => chartData ? { onSlotsReady: setSlots, onClose: stableClose, trades: contextTrades, drawingKey, data: chartData } : null,
    [chartData, contextTrades, drawingKey, stableClose]);
  const onSaveChartNotesRef = useRef(onSaveChartNotes);
  onSaveChartNotesRef.current = onSaveChartNotes;
  const onAttachScreenshotRef = useRef(onAttachScreenshot);
  onAttachScreenshotRef.current = onAttachScreenshot;
  const canSaveNotes = Boolean(onSaveChartNotes), canSnapshot = Boolean(onAttachScreenshot);
  const notesChange = useMemo(() => canSaveNotes && chartSelected && chartTrade ? (next: ChartNote[]) => {
    const id = String(chartTrade.id);
    setNotesOverride(current => new Map(current).set(id, next));
    void onSaveChartNotesRef.current?.(chartSelected, next).then(ok => { if (!ok) setNotesOverride(current => { const copy = new Map(current); copy.delete(id); return copy; }); });
  } : undefined, [canSaveNotes, chartSelected, chartTrade]);
  const snapshotSave = useMemo(() => canSnapshot && chartSelected
    ? async (image: Blob) => Boolean(await onAttachScreenshotRef.current?.(chartSelected, image)) : undefined, [canSnapshot, chartSelected]);
  const chartElement = useMemo(() => chartTrade && detailsReady && review ? (
    <AccountExecutionChart
      trade={chartTrade}
      verifiedDetail={chartTrade?.executionHistory ? chartTrade : detail}
      isDark={isDark}
      variant="detail"
      chartNotes={chartNotes}
      onChartNotesChange={notesChange}
      onSaveSnapshot={snapshotSave}
      review={review}
    />
  ) : null, [chartNotes, chartTrade, detail, detailsReady, isDark, notesChange, review, snapshotSave]);
  const waitingText = weekCandles?.error ? `Svíčky se nepodařilo načíst: ${weekCandles.error}`
      : 'Graf pro obchody tohoto týdne zatím není — svíčky jsou k dispozici zhruba 24 h po obchodu.';

  return (
    <div className={`fixed inset-0 z-[290] flex items-center justify-center ${isDark ? 'bg-[#070a0f] text-slate-400' : 'bg-[#f4f6f8] text-slate-500'}`}>
      {chartElement ? (
        <div className="absolute inset-0">
          {chartElement}
          {slots && createPortal(header, slots.header)}
          {slots && createPortal(side, slots.side)}
          {slots && createPortal(bottom, slots.bottom)}
        </div>
      ) : (
        weekTrades.length && (!detailsReady || !candlesReady) ? (
          <>
            <QuantumSpinner />
            {/* Při načítání jen spinner; zavřít jde křížkem v rohu. */}
            <button type="button" onClick={onClose} aria-label="Zavřít review" className="absolute right-4 top-4 rounded-lg p-2 opacity-60 transition-opacity hover:opacity-100"><X size={18} /></button>
          </>
        ) : (
          <div className="flex flex-col items-center gap-3 text-[12px]">
            {!weekTrades.length ? 'V tomhle týdnu nejsou žádné obchody.' : <span className="max-w-sm text-center">{waitingText}</span>}
            <button type="button" onClick={onClose} className="text-[11px] font-bold underline">Zavřít</button>
          </div>
        )
      )}
    </div>
  );
}

/** Graf převezme vybraný obchod po dojetí přejezdu (animace 520 ms). */
const CHART_SWITCH_DELAY_MS = 540;

interface ReviewDraft { plan: PlanChoice | null; htf: string[]; ltf: string[]; emotions: string[]; mistakes: string[]; notes: string }
const draftOf = (trade: Trade): ReviewDraft => ({
  plan: planChoiceOf(trade),
  htf: [...(trade.htfConfluence ?? [])], ltf: [...(trade.ltfConfluence ?? [])],
  emotions: [...(trade.emotions ?? [])], mistakes: [...(trade.mistakes ?? [])],
  notes: trade.notes ?? '',
});
const clock = (ms: number) => new Date(ms).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
const fmtPrice = (value: unknown) => { const n = Number(value); return Number.isFinite(n) && n > 0 ? n.toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'; };

/**
 * Sekce hodnocení: sbalená ukazuje vybrané jako dlaždice, rozbalená celou
 * nabídku. Výška se animuje (grid 0fr → 1fr), dlaždice naskočí s pružinkou.
 */
function ReviewSection({ id, title, open, onToggle, options, value, onChange, isDark, bad = false, labelOf = (option: string) => option }: {
  id: string; title: string; open: boolean; onToggle: (id: string) => void;
  options: string[]; value: string[]; onChange: (next: string[]) => void; isDark: boolean; bad?: boolean; labelOf?: (option: string) => string;
}) {
  // Uložené hodnoty mimo aktuální nabídku (starší obchody) se ukážou taky.
  const all = [...options, ...value.filter(item => !options.includes(item))];
  if (!all.length) return null;
  const toggle = (option: string) => onChange(value.includes(option) ? value.filter(item => item !== option) : [...value, option]);
  const tile = (option: string, on: boolean) => `rounded-full border px-2 py-[3px] text-[10.5px] font-semibold transition-[color,background-color,border-color,transform] duration-150 active:scale-95 ${on
    ? bad ? 'border-rose-500 bg-rose-500/15 text-rose-500' : 'border-amber-500 bg-amber-500/15 text-amber-600'
    : isDark ? 'border-white/10 text-slate-400 hover:text-slate-200 hover:border-white/20' : 'border-slate-200 text-slate-500 hover:text-slate-800 hover:border-slate-300'}`;
  return (
    <div className={`rounded-lg border transition-colors ${open ? (isDark ? 'border-white/15' : 'border-slate-300') : isDark ? 'border-white/10' : 'border-slate-200'}`}>
      <button type="button" onClick={() => onToggle(id)} aria-expanded={open}
        className={`flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[10.5px] font-bold ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
        <span>{title}</span>
        {value.length > 0 && <span className={`rounded-full px-1.5 text-[9px] font-black tabular-nums ${bad ? 'bg-rose-500/15 text-rose-500' : 'bg-amber-500/15 text-amber-600'}`}>{value.length}</span>}
        <ChevronRight size={12} className={`ml-auto text-slate-400 transition-transform duration-200 ${open ? 'rotate-90' : ''}`} />
      </button>
      {/* Sbaleno: jen vybrané dlaždice (klik = odebrat). */}
      {!open && value.length > 0 && (
        <div className="flex flex-wrap gap-1 px-2 pb-2">
          {value.map(option => (
            <button key={option} type="button" onClick={() => toggle(option)} title="Odebrat"
              className={`review-tile-in ${tile(option, true)}`}>{labelOf(option)}</button>
          ))}
        </div>
      )}
      <div className="review-section-body" data-open={open} inert={!open}>
        <div>
          <div className="flex flex-wrap gap-1 px-2 pb-2">
            {all.map(option => (
              <button key={option} type="button" onClick={() => toggle(option)} aria-pressed={value.includes(option)} className={tile(option, value.includes(option))}>
                {labelOf(option)}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Karta obchodu v pásu — memo: při přepnutí se překreslí jen stará a nová. */
const ReviewCard = React.memo(function ReviewCard({ trade, on, isDark, onSelect }: {
  trade: Trade; on: boolean; isDark: boolean; onSelect: (trade: Trade) => void;
}) {
  const long = String(trade.direction).toLowerCase() === 'long';
  const pnl = Number(trade.pnl) || 0;
  const line = isDark ? 'border-white/10' : 'border-slate-200';
  return (
    <button type="button" onClick={() => onSelect(trade)} data-review-card={String(trade.id)}
      className={`relative w-[96px] rounded-lg border px-2 py-1.5 text-left transition-[border-color,box-shadow,transform] hover:-translate-y-px ${on ? 'border-amber-500 shadow-[0_0_0_1px_#f59e0b]' : line} ${isDark ? 'bg-white/[0.03]' : 'bg-slate-50'}`}>
      {!trade.needsReview && <span className="absolute right-1.5 top-1.5 grid h-3 w-3 place-items-center rounded-full bg-emerald-500 text-white"><Check size={8} strokeWidth={4} /></span>}
      <span className="block text-[9.5px] tabular-nums text-slate-500">{clock(tradeTimeMs(trade))}</span>
      <span className={`block text-[13px] font-extrabold tabular-nums ${pnl > 0 ? 'text-emerald-500' : pnl < 0 ? 'text-rose-500' : isDark ? 'text-slate-300' : 'text-slate-600'}`}>
        {`${pnl >= 0 ? '+' : '−'}$${Math.abs(pnl).toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}</span>
      <span className={`block text-[9px] font-black tracking-wider ${long ? 'text-emerald-500' : 'text-rose-500'}`}>{long ? 'LONG' : 'SHORT'}</span>
    </button>
  );
});
