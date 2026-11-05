import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Lock, Star, X } from 'lucide-react';
import {
  bracketDisplayValue,
  bracketPriceFromInput,
  limitIsMarketable,
  marketPrice,
  snapToTick,
  ticketEntry,
  ticketMetrics,
  ticketProblems,
  withBracket,
  withEntryPrice,
  withSide,
  type LiveAttachLegs,
  type TicketBracket,
  type TicketBracketUnits,
  type TicketDraft,
  type TicketInstrument,
  type TicketOrderType,
  type TicketQuote,
  type TicketSide,
} from '../lib/liveOrderTicket';
import { leaderManageBasis, type LiveChartPosition, type LiveChartPositionSummary } from '../lib/liveChartPosition';
import { previewSymbolFromChartSource, type LeaderEntryPreviewResult, type LiveEntryPreviewDraft } from '../lib/leaderEntryPreview';
import type { LeaderEntryPlaceResult } from '../lib/leaderEntryPlace';
import type { LeaderOrderManageAction, LeaderOrderManageResult } from '../lib/leaderOrderManage';
import type { LiveTicketScaleIn } from '../lib/liveScaleIn';
import type { LivePhonePosition } from '../lib/livePhoneOrders';
import { hasActiveLiveCommandTrace, markLiveCommandPaint, startLiveCommandTrace } from '../lib/liveCommandPerformance';
import {
  LIVE_PREVIEW_PLACE_BARE,
  isBarePreviewDraft,
  isBareTicketDraft,
  liveAttachDefaults,
  liveAttachIntent,
  liveAttachMarket,
  liveAttachProblem,
    liveBareMarketBlockReason,
  liveBareMarketButtonLabel,
  liveBareConfirmKey,
  liveBareSendClick,
  liveConfirmAsking,
  liveConfirmClick,
  livePreviewPlaceClick,
  liveTicketBareEntry,
  liveTicketBarePosition,
  liveTicketLegsProblem,
  type LiveAttachInput,
  type LiveBareEntryRecord,
  type LiveBareMarketGate,
  type LiveBareQuote,
  type LiveConfirmState,
} from '../lib/liveBareEntry';
import {
  DEFAULT_LIVE_TICKET_PREFS,
  liveTicketDraftBase,
  liveTicketQtyPresets,
  readLiveTicketPrefs,
  updateLiveTicketPrefs,
  type LiveTicketPrefs,
} from '../lib/liveTicketPrefs';
import { LIVE_PREVIEW_FRESH_MS, livePreviewErrorText, livePreviewView } from '../lib/livePreviewView';
import {
  LIVE_BUILTIN_BRACKET_TEMPLATE,
  LIVE_TEMPLATE_NAME_MAX,
  applyLiveBracketTemplate,
  defaultLiveBracketTemplate,
  liveBracketTemplateChoices,
  liveMarketBracketDistanceProblem,
  liveTemplateBracketPrices,
  liveTemplateFromDraft,
  liveTemplateTicketDraft,
  type LiveBracketTemplate,
  type LiveBracketTemplateChoice,
} from '../lib/liveBracketTemplates';
import {
  deleteLiveBracketTemplate,
  readLiveBracketTemplates,
  saveLiveBracketTemplate,
  setDefaultLiveBracketTemplateId,
  subscribeLiveBracketTemplates,
  type LiveBracketTemplatesRead,
} from '../services/liveBracketTemplateStore';
import {
  MANAGE_BE_MAX_TICKS,
  liveManageBasis,
  liveManageBreakEvenOffers,
  manageDisplayValue,
  managePriceFromInput,
  planBreakEven,
  planManageMove,
  type LiveManageBreakEvenVariant,
  type LiveManageIntent,
  type LiveManageLeg,
  type LiveManagePlan,
} from '../lib/liveManagePrices';
import { liveManageErrorNotice, liveManageResultNotice, type LiveManageNotice, type LiveManageOutcome, type LiveManageRunner } from '../hooks/useLiveManageRunner';
import { liveBareCloseLabel, type LiveBareCloseOffer } from '../lib/liveBareCloseUi';
import { LIVE_COMMAND_BUSY_TEXT, createLiveBareClosePanelClick, runWithCommandLock } from '../hooks/liveCommandRuns';
import { useLiveClickGate } from '../hooks/useLiveClickGate';
import { LIVE_ACTION_CHANGED_TEXT, liveMoveClick, liveMoveKey, liveRepeatClick, type LiveClickGate, type LiveClickState } from '../lib/liveClickGate';
import {
  GROUP_TARGET,
  allTradeAccounts,
  followerInCopy,
  limitAccounts,
  participatingFollowers,
  soloTradeBlockReason,
  targetAccount,
  targetMultiplier,
  type LiveTradeAccount,
  type LiveTradeGroup,
  type LiveTradeTarget,
} from '../lib/liveTradeTarget';
import { chartGlassMenu } from '../services/chartGlass';

/**
 * Panel objednávky živého grafu (LIVE → Graf, varianta A z náhledu
 * mockups/chart-order-entry.html). Jen UI: tlačítko odeslání je vypnuté,
 * dokud odesílání neprojde jádrem kopírky (pravidla INV-*).
 */

export type TicketScope = 'account' | 'group' | 'each';

const NB = ' ';
const groupDigits = (text: string) => text.replace(/\B(?=(\d{3})+(?!\d))/g, NB);
export const formatPrice = (value: number) => {
  const [whole, decimals] = Math.abs(value).toFixed(2).split('.');
  return `${value < 0 ? '−' : ''}${groupDigits(whole)}.${decimals}`;
};
export const formatUsd = (value: number | null, signed = true) => {
  if (value == null || !Number.isFinite(value)) return '—';
  const [whole, decimals] = Math.abs(value).toFixed(2).split('.');
  const sign = value < 0 ? '−' : signed && value > 0 ? '+' : '';
  return `${sign}$${groupDigits(whole)}.${decimals}`;
};
const formatPoints = (value: number) => `${Math.abs(value).toFixed(2)} b`;
const TYPE_LABEL: Record<TicketOrderType, string> = { market: 'Market', limit: 'Limit', stop: 'Stop' };
const UNIT_LABEL: Record<TicketBracketUnits, string> = { pts: 'Body', ticks: 'Ticky', usd: '$', price: 'Cena' };
const UNIT_SUFFIX: Record<TicketBracketUnits, string> = { pts: 'b', ticks: 't', usd: '$', price: '' };

/**
 * Živá pozice cíle panelu (jen zobrazení). Otevřené P&L je z brokera, ne
 * z ceny grafu. Správa (SL/TP, BE) je v sekci pod kartou a ve štítcích grafu.
 */
const PositionCard: React.FC<{ isDark: boolean; summary: LiveChartPositionSummary; muted: string; ink: string; field: string }> = ({ isDark, summary, muted, ink, field }) => {
  const [expanded, setExpanded] = useState(false);
  const long = summary.side === 'long';
  const price = (value: number | null) => (value == null ? '—' : formatPrice(value));
  const canExpand = summary.rows.length > 0;
  // Poloha trhu mezi SL a TP (jen zobrazení z marku brokera).
  const progress = summary.kind === 'position' && summary.mark != null && summary.stop != null && summary.target != null && summary.target !== summary.stop
    ? Math.min(1, Math.max(0, (summary.mark - summary.stop) / (summary.target - summary.stop)))
    : null;
  const entryAt = progress != null && summary.entry != null && summary.stop != null && summary.target != null
    ? Math.min(1, Math.max(0, (summary.entry - summary.stop) / (summary.target - summary.stop)))
    : null;
  return <div
    role={canExpand ? 'button' : undefined}
    tabIndex={canExpand ? 0 : undefined}
    aria-expanded={canExpand ? expanded : undefined}
    title={canExpand ? (expanded ? 'Sbalit účty' : 'Ukázat jednotlivé účty') : undefined}
    onClick={() => canExpand && setExpanded(value => !value)}
    onKeyDown={event => { if (canExpand && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); setExpanded(value => !value); } }}
    className={`grid gap-1.5 rounded-[6px] border p-2.5 transition-colors ${field} ${canExpand ? `cursor-pointer ${isDark ? 'hover:border-blue-400/40' : 'hover:border-blue-500/40'}` : ''}`}
  >
    <div className="flex items-baseline gap-2">
      <b className={`text-[11px] font-black uppercase tracking-[0.06em] ${long ? 'text-blue-500' : 'text-rose-500'}`}>
        {summary.kind === 'position' ? `${long ? 'Long' : 'Short'} ${summary.quantity}` : `Čeká ${long ? 'BUY' : 'SELL'} ${summary.entryType ?? ''} ${summary.quantity}`}
      </b>
      <span className={`font-mono text-[10.5px] ${muted}`}>@ {price(summary.entry)}</span>
      <span className="flex-1" />
      {summary.scopeLabel
        ? <span className="rounded border border-violet-500/45 px-1 text-[9px] font-black text-violet-500" title="Kopírka je vypnutá — souhrn jen tohoto účtu, ne celé skupiny">{summary.scopeLabel}</span>
        : summary.accounts > 1 && <span className={`text-[9.5px] font-bold ${muted}`}>{summary.accounts} účty</span>}
      {canExpand && <ChevronDown size={12} className={`${muted} transition-transform duration-300 ${expanded ? 'rotate-180' : ''}`} />}
    </div>
    {summary.kind === 'position' && <div className="flex items-baseline gap-2">
      <b className={`font-mono text-[22px] font-black leading-none ${summary.openPnl == null ? muted : summary.openPnl < 0 ? 'text-rose-500' : 'text-emerald-500'}`}>{formatUsd(summary.openPnl)}</b>
      <span className={`text-[9.5px] font-bold ${muted}`} title="Otevřené P&L z brokera (ne z ceny grafu)">z brokera</span>
    </div>}
    {progress != null && <div className={`relative flex h-1.5 overflow-hidden rounded-full ${isDark ? 'bg-white/[0.06]' : 'bg-slate-900/[0.06]'}`} title="Cena mezi SL a TP">
      <i className="block h-full bg-rose-500/45" style={{ width: `${(entryAt ?? 0) * 100}%` }} />
      <i className="block h-full flex-1 bg-emerald-500/35" />
      <span className={`absolute top-0 h-full w-[2px] rounded transition-[left] duration-500 ${isDark ? 'bg-white' : 'bg-slate-900'}`} style={{ left: `calc(${progress * 100}% - 1px)` }} />
    </div>}
    <div className={`flex gap-3 font-mono text-[10px] ${ink}`}>
      <span className="text-rose-500">SL {price(summary.stop)}</span><span className="text-emerald-500">TP {price(summary.target)}</span>
      <span className={`flex-1 text-right font-sans font-bold ${muted}`}>{summary.protection}</span>
    </div>
    {canExpand && <div className={`live-ticket-accounts ${expanded ? 'is-open' : ''}`}>
      <div>
        {summary.rows.map(row => <div key={row.accountId} className={`grid grid-cols-[8px_minmax(0,1fr)_auto_68px] items-center gap-1.5 border-t py-1.5 text-[10.5px] ${isDark ? 'border-white/[0.08]' : 'border-slate-900/[0.08]'}`}>
          <i className={`h-[7px] w-[7px] rounded-full ${row.protectedFully ? 'bg-emerald-500' : 'bg-amber-500'}`} title={row.protectedFully ? 'SL i TP kryjí celou pozici' : 'Ochrana nekryje celou pozici'} />
          <span className="min-w-0">
            <b className={`block truncate font-extrabold ${ink}`}>{row.name}{row.isLeader && <span className="ml-1 rounded-[3px] border border-indigo-400/45 px-[3px] align-[1px] text-[8px] font-black uppercase tracking-[0.06em] text-indigo-400">leader</span>}</b>
            <small className={`block font-mono text-[9.5px] ${muted}`}>@ {price(row.entry)} · SL {price(row.stop)} · TP {price(row.target)}</small>
          </span>
          <span className={`text-right font-mono text-[10.5px] font-bold ${muted}`}>{row.quantity}×</span>
          <b className={`text-right font-mono text-[11px] font-extrabold ${row.openPnl == null ? muted : row.openPnl < 0 ? 'text-rose-500' : 'text-emerald-500'}`}>{formatUsd(row.openPnl)}</b>
        </div>)}
      </div>
    </div>}
  </div>;
};

/** Text výsledku ručního vstupu (náhled i přímé odeslání). */
const placedResultView = (entry: LeaderEntryPlaceResult): { tone: 'ok' | 'bad' | 'warn'; text: string } => {
  switch (entry.status) {
    case 'acknowledged': return entry.reason
      ? { tone: 'warn', text: `Přijato brokerem (vstup ${entry.entryBrokerOrderId}), ale: ${entry.reason}` }
      : { tone: 'ok', text: `Přijato brokerem (vstup ${entry.entryBrokerOrderId}). Kopie followerům řídí kopírka.` };
    case 'rejected': return { tone: 'bad', text: `Broker odmítl: ${entry.reason ?? 'bez důvodu'}` };
    case 'blocked': return { tone: 'bad', text: `Neodesláno: ${entry.blockers.map(issue => issue.text).join(' ')}` };
    case 'abandoned': return { tone: 'bad', text: entry.reason ?? 'Broker vrátil vstup bez ochrany — vstup se ruší, kopírka je vypnutá.' };
    default: return { tone: 'warn', text: entry.reason ?? 'Výsledek neznámý — zkontroluj leadera v Tradovate.' };
  }
};

/**
 * Chyba odeslání: jen prokazatelně neodeslané je „neodesláno“ (vč. read-only
 * localhostu, 405 před relayí); vše ostatní je neznámý výsledek — nikdy neopakovat naslepo.
 */
/** Velké tlačítko po neznámém výsledku: zamčené do změny návrhu nebo stavu, nikdy opakování naslepo. */
export const liveDirectResultLocks = (result: Pick<LeaderEntryPlaceResult, 'status'>): boolean => (
  !['acknowledged', 'rejected', 'blocked', 'abandoned'].includes(result.status)
);
export const liveDirectErrorLocks = (message: string): boolean => placeErrorView(message).tone === 'warn';

const placeErrorView = (message: string): { tone: 'bad' | 'warn'; text: string } => (
  /entry-busy|entry-daily-cap|manage-daily-cap|entry-conflict|entry-superseded|entry-not-admitted|invalid-relay-command-payload|není čerstvě ověřený|jen přes relay|Chybí cesta k Mac workeru|worker-disconnected|pouze read-only|Přikoupení musí mít SL a TP pozice|nic se neodeslalo/.test(message)
    ? { tone: 'bad', text: /entry-busy/.test(message) ? 'Neodesláno: jiný ruční vstup se právě zpracovává.'
      : /entry-daily-cap/.test(message) ? 'Neodesláno: dosažen denní strop ručních vstupů.'
        : /entry-superseded/.test(message) ? 'Neodesláno: tento pokus zastavila brzda (vypnutí kopírky).'
          : /entry-not-admitted/.test(message) ? 'Neodesláno: tento pokus server nepřijal.'
        : /pouze read-only/.test(message) ? 'Neodesláno: z localhostu se k brokerovi nezapisuje (jen na produkci).' : `Neodesláno: ${message}` }
    : { tone: 'warn', text: `Výsledek neznámý (${message.slice(0, 120)}) — zkontroluj leadera v Tradovate, než to zkusíš znovu.` }
);

/**
 * Market z panelu = skutečný Market u brokera (2. 11. 2026, dřív Limit ±2 b).
 * Cena grafu jde jen jako `referencePrice` (odhad rizika, zobrazení) a musí být
 * mladší než tohle; worker ji znovu porovná s vlastní kotací z IBKR.
 */
export const MARKET_QUOTE_MAX_AGE_MS = 3_000;
/** Krátký štítek typu u brokera (MKT / LMT / STP) — panel i audit ukazují skutečný typ. */
export const brokerOrderTypeLabel = (orderType: string): string => orderType === 'Market' ? 'MKT' : orderType === 'Limit' ? 'LMT' : 'STP';

/** Jak dlouho výsledek náhledu platí jako „aktuální“; pak zešedne (sdílené s telefonem, `lib/livePreviewView`). */
const PREVIEW_FRESH_MS = LIVE_PREVIEW_FRESH_MS;

/**
 * Fáze 1a: „Zkontrolovat u workeru“ — worker projde brány a vrátí, co by
 * poslal. Nikdy nic neodešle a nikdy netvrdí „připraveno“; Odeslat zůstává
 * vypnuté. Výsledek se zahodí při změně návrhu a po 15 s zešedne.
 * Zobrazení (texty, riziko v $, holý Market „bez SL/TP“) je `livePreviewView`.
 */
const PreviewSection: React.FC<{
  isDark: boolean; muted: string; field: string;
  previewDraft: LiveEntryPreviewDraft | null;
  /** Změna stavu kopírky (zapnutí / vypnutí) výsledek zahodí. */
  resetKey: string;
  blockedReason: string | null;
  /** $ za bod a kontrakt (riziko náhledu, jen odhad). */
  pointValue: number;
  onPreview: (draft: LiveEntryPreviewDraft) => Promise<LeaderEntryPreviewResult>;
  /** Fáze 1b: odeslání po čerstvém náhledu bez blockerů; chybí = worker odeslání neumí. */
  onPlace?: (draft: LiveEntryPreviewDraft, operationId: string) => Promise<LeaderEntryPlaceResult>;
  /** Přijatý vstup — návrh se zavře, zůstane živý příkaz. */
  onAcknowledged?: () => void;
}> = ({ isDark, muted, field, previewDraft, resetKey, blockedReason, pointValue, onPreview, onPlace, onAcknowledged }) => {
  const [state, setState] = useState<{ key: string; receivedAt?: number; result?: LeaderEntryPreviewResult; error?: string; operationId?: string } | null>(null);
  const [placing, setPlacing] = useState(false);
  // Ref kvůli dvěma klikům v jednom snímku: dvojklik nic dalšího nepošle.
  const placeClickRef = useRef<LiveClickState | null>(null);
  const placingRef = useRef(false);
  const [placed, setPlaced] = useState<{
    key: string; result?: LeaderEntryPlaceResult; error?: string; unknown?: string;
    operationId?: string; receivedPerformanceAt?: number;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [now, setNow] = useState(() => Date.now());
  const key = previewDraft ? `${resetKey}|${JSON.stringify(previewDraft)}` : '';
  // Výsledek zahodit, ne jen skrýt: po OFF→ON do 15 s by se jinak starý
  // výsledek z předchozího zapnutí ukázal znovu jako čerstvý.
  useEffect(() => { setState(null); }, [resetKey]);
  useEffect(() => {
    if (!state?.result) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [state?.result]);
  const shown = state && state.key === key ? state : null;
  const run = async () => {
    if (!previewDraft || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const result = await onPreview(previewDraft);
      // Stáří od přijetí v tomto prohlížeči — hodiny telefonu a Macu se můžou lišit.
      // Jedno id odeslání na jeden náhled: dvojklik / opakování = tentýž vstup (relay dedup).
      setState({ key, result, receivedAt: Date.now(), operationId: `entry:${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}` });
      setPlaced(null);
      setNow(Date.now());
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Náhled se nepodařil.';
      setState({ key, error: livePreviewErrorText(message) });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const result = shown?.result;
  const receivedAt = shown?.receivedAt ?? now;
  // Holý Market (bez SL/TP) se z Náhledu nikdy neodesílá — jen velkým tlačítkem panelu
  // s vlastní branou při kliku (oponentura vlny B, P2).
  const barePreview = previewDraft != null && isBarePreviewDraft(previewDraft);
  const placeFn = barePreview ? undefined : onPlace;
  const view = result ? livePreviewView({ result, receivedAt, now, blockedReason, placeSupported: Boolean(placeFn), operationId: shown?.operationId, pointValue }) : null;
  const stale = view ? view.stale : false;
  const canSend = Boolean(view?.canSend && previewDraft && result?.wouldPlace && now - receivedAt <= PREVIEW_FRESH_MS);
  const shownPlaced = placed && placed.key === key ? placed : null;
  useEffect(() => {
    if (shownPlaced?.result?.status !== 'acknowledged' || !shownPlaced.operationId
      || shownPlaced.receivedPerformanceAt == null) return undefined;
    const operationId = shownPlaced.operationId;
    const receivedPerformanceAt = shownPlaced.receivedPerformanceAt;
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        if (!hasActiveLiveCommandTrace(operationId)) return;
        markLiveCommandPaint({ operationId, stage: 'order', receivedPerformanceAt });
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
    };
  }, [shownPlaced?.operationId, shownPlaced?.receivedPerformanceAt, shownPlaced?.result?.status]);
  const send = async () => {
    if (!canSend || !previewDraft || !placeFn || placingRef.current || !result?.wouldPlace) return;
    // První klik odesílá (Filip 5. 11. 2026); čerstvost a brána se ověří v okamžiku kliku.
    const at = Date.now();
    const step = livePreviewPlaceClick({
      last: placeClickRef.current, draft: previewDraft, operationId: shown?.operationId, previewKey: key,
      receivedAt: shown?.receivedAt, blockedReason, freshMs: PREVIEW_FRESH_MS, now: at,
    });
    placeClickRef.current = step.next;
    setNow(at);
    if (step.reason) { setPlaced({ key, error: step.reason }); return; }
    if (!step.send) return;
    // Přesná kotva klik → pixel. Jen lokální diagnostika; do příkazu ani bran nevstupuje.
    startLiveCommandTrace(shown!.operationId!, { kind: 'place-leader-entry' });
    placingRef.current = true;
    setPlacing(true);
    try {
      const placedResult = await placeFn(previewDraft, shown!.operationId!);
      setPlaced({ key, result: placedResult, operationId: shown!.operationId!, receivedPerformanceAt: performance.now() });
      if (placedResult.status === 'acknowledged') onAcknowledged?.();
    } catch (reason) {
      const view = placeErrorView(reason instanceof Error ? reason.message : 'Odeslání se nepodařilo.');
      setPlaced({ key, ...(view.tone === 'bad' ? { error: view.text.replace(/^Neodesláno: /, '') } : { unknown: view.text }) });
    } finally {
      placingRef.current = false;
      setPlacing(false);
    }
  };
  const placedText = placedResultView;
  const bareLeader = result?.wouldPlace ? result.wouldPlace.leader.stopLoss == null || result.wouldPlace.leader.takeProfit == null : false;
  return <div className="grid gap-1.5">
    <button
      type="button"
      disabled={!previewDraft || blockedReason != null || busy}
      onClick={() => void run()}
      title={blockedReason ?? 'Worker projde všechna pravidla kopírky a ukáže, co by poslal. Nic se neodešle.'}
      className={`h-8 rounded-[9px] border text-[11px] font-extrabold disabled:cursor-not-allowed disabled:opacity-50 ${isDark ? 'border-white/15 hover:bg-white/[0.06]' : 'border-slate-900/15 hover:bg-white/70'}`}
    >{busy ? 'Ověřuji u workeru…' : 'Zkontrolovat u workeru (nic se neodešle)'}</button>
    {blockedReason && <div className={`text-[10px] ${muted}`}>{blockedReason}</div>}
    {previewDraft && <div className={`text-[10px] ${muted}`}>Kontrakt podle grafu: <b>{previewDraft.symbol}</b></div>}
    {shown?.error && <div className="rounded-[7px] bg-rose-500/10 px-2 py-1.5 text-[10.5px] font-bold text-rose-500">Náhled: {shown.error}</div>}
    {view && <div className={`grid gap-1 rounded-[9px] border p-2 text-[10.5px] ${field} ${stale ? 'opacity-50' : ''}`}>
      <div className={`flex justify-between text-[9.5px] font-black uppercase tracking-[0.06em] ${muted}`}>
        <span>{view.header}</span><span>{view.ageText}</span>
      </div>
      <div className={`font-bold ${view.tone === 'blocked' ? 'text-rose-500' : ''}`}>{view.headline}</div>
      {view.leaderLine && <div className="font-mono text-[10px]">{view.leaderLine}</div>}
      {view.followerLines.map((line, index) => <div key={`f${index}`} className="font-mono text-[10px]">{line}</div>)}
      {view.risk && <div className={view.risk.unbounded ? 'font-bold text-rose-500' : muted}>{view.risk.text}</div>}
      {view.blockers.map((text, index) => <div key={`b${index}`} className="text-rose-500">• {text}</div>)}
      {view.notes.map((text, index) => <div key={`n${index}`} className={muted}>· {text}</div>)}
    </div>}
    {placeFn && result?.wouldPlace && <button
      type="button"
      disabled={!canSend || placing || shownPlaced?.result != null || shownPlaced?.unknown != null}
      // Fokus nesmí zůstat na tlačítku: Enter / mezerník by jinak odeslal bez myši (oponentura vlny B).
      onClick={event => { event.currentTarget.blur(); void send(); }}
      title={canSend ? 'Pošle OSO na leadera; followerům ho rozkopíruje kopírka.' : 'Odeslat jde jen do 15 s po náhledu bez blokací.'}
      className="h-8 rounded-[9px] bg-blue-600 text-[11px] font-extrabold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
    >{placing ? 'Odesílám…' : `Odeslat ${result.wouldPlace.leader.quantity} kontrakt na leadera${bareLeader ? ' · BEZ SL/TP' : ''}`}</button>}
    {placeFn && result?.wouldPlace && !canSend && !shownPlaced && <div className={`text-[10px] ${muted}`}>
      {view?.sendHint ?? 'Odeslat teď nejde — zkontroluj znovu.'}
    </div>}
    {barePreview && result?.wouldPlace && <div className={`text-[10px] font-bold ${muted}`}>{LIVE_PREVIEW_PLACE_BARE}</div>}
    {shownPlaced?.error && <div className="rounded-[7px] bg-rose-500/10 px-2 py-1.5 text-[10.5px] font-bold text-rose-500">Neodesláno: {shownPlaced.error}</div>}
    {shownPlaced?.unknown && <div className="rounded-[7px] bg-amber-500/10 px-2 py-1.5 text-[10.5px] font-bold text-amber-600">{shownPlaced.unknown}</div>}
    {shownPlaced?.result && (() => {
      const view = placedText(shownPlaced.result);
      return <div className={`rounded-[7px] px-2 py-1.5 text-[10.5px] font-bold ${view.tone === 'ok' ? 'bg-emerald-500/10 text-emerald-600' : view.tone === 'bad' ? 'bg-rose-500/10 text-rose-500' : 'bg-amber-500/10 text-amber-600'}`}>{view.text}</div>;
    })()}
  </div>;
};

// ── Předvolby, šablony a výchozí návrh (U4/U8, 3. 11. 2026) ─────────────────
// Jen předvyplnění panelu: nic z toho neodesílá a nic neautorizuje (INV-UI-01).
// Odchází se dál jen tlačítkem panelu („⚡ v live jen vyplní panel“).

/** localStorage předvoleb panelu; SSR / soukromé okno / zákaz = null (platí výchozí hodnoty). */
export const liveTicketPrefsStorage = (): Pick<Storage, 'getItem' | 'setItem'> | null => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage ?? null;
  } catch {
    return null;
  }
};

/** Knihovna ATM šablon uživatele na tomto zařízení (změny z této i jiných karet). Bez uživatele jen vestavěná. */
export function useLiveBracketTemplateLibrary(userId: string | null | undefined): LiveBracketTemplatesRead {
  const [read, setRead] = useState<LiveBracketTemplatesRead>(() => readLiveBracketTemplates(userId));
  useEffect(() => {
    setRead(readLiveBracketTemplates(userId));
    return subscribeLiveBracketTemplates(userId, setRead);
  }, [userId]);
  return read;
}

/**
 * Nový návrh panelu (tlačítko strany, pravý klik, Shift+B/S): velikost z předvoleb
 * zařízení (do stropu skupiny). Otevře se vždy BEZ SL/TP (Filip 5. 11.: nohy si natáhne
 * z „+ SL“ / „+ TP“ na lince nebo vybere šablonu v panelu). Přikoupení SL/TP nechá
 * (SL/TP pozice dosadí panel). `base` = výslovná velikost volajícího (např. počet
 * z menu grafu) — má přednost a šablona pak velikost nemění. Jen předvyplnění.
 */
export function liveTicketNewDraft(input: {
  side: TicketSide;
  type: TicketOrderType;
  price: number;
  instrument: TicketInstrument;
  quote: TicketQuote;
  /** `readLiveTicketPrefs(liveTicketPrefsStorage())`; null = výchozí (1 kontrakt). */
  prefs?: LiveTicketPrefs | null;
  /** Strop ručního vstupu skupiny (`entryMaxContracts`). */
  maxContracts: number;
  /** `defaultLiveBracketTemplate(library)`; null = vestavěná 12 b / 2R. */
  template?: LiveBracketTemplate | null;
  scaleIn?: LiveTicketScaleIn | null;
  base?: Partial<Pick<TicketDraft, 'sizing' | 'quantity' | 'riskUsd'>> | null;
}): { draft: TicketDraft; notes: string[] } {
  const fromPrefs = liveTicketDraftBase(input.prefs ?? DEFAULT_LIVE_TICKET_PREFS, input.maxContracts);
  const explicit = input.base ?? null;
  const base = {
    sizing: explicit?.sizing ?? fromPrefs.sizing,
    quantity: explicit?.quantity ?? fromPrefs.quantity,
    riskUsd: explicit?.riskUsd ?? fromPrefs.riskUsd,
  };
  const result = liveTemplateTicketDraft(input.side, input.type, input.price, input.instrument, input.quote,
    input.template ?? LIVE_BUILTIN_BRACKET_TEMPLATE, base, {
      scaleIn: input.scaleIn ?? null,
      maxContracts: input.maxContracts,
      // Výslovně zadaná velikost (menu grafu) se šablonou nepřepisuje.
      applySizing: explicit?.quantity == null && explicit?.sizing == null && explicit?.riskUsd == null,
    });
  if (input.scaleIn) return { draft: result.draft, notes: result.notes };
  return { draft: { ...result.draft, stopLoss: null, takeProfit: null }, notes: result.notes };
}

/**
 * Výchozí nohy „Přidat SL/TP“: vlastní výchozí šablona (★) od průměru vstupu
 * (bez průměru od trhu), jinak 10 / 20 b od trhu (jako list telefonu). Šablona
 * bez TP = TP 20 b od trhu. Jen předvyplnění formuláře — odeslání tlačítkem.
 */
export function liveAttachDefaultLegs(
  side: 'long' | 'short',
  market: number,
  reference: number | null,
  tickSize: number,
  template: LiveBracketTemplate | null,
): { stopLoss: number; takeProfit: number } {
  const fallback = liveAttachDefaults(side, market, tickSize);
  if (!template) return fallback;
  const prices = liveTemplateBracketPrices(template, side === 'long' ? 'buy' : 'sell', reference ?? market, tickSize);
  if (!prices) return fallback;
  return { stopLoss: prices.stopLoss, takeProfit: prices.takeProfit ?? fallback.takeProfit };
}

/** Chyba `attachBrackets`: prokazatelně neodeslané = „Neodesláno“, jinak neznámé (nikdy neopakovat naslepo). */
export const attachErrorNotice = (reason: unknown, at: number): LiveManageNotice => {
  const notice = liveManageErrorNotice(reason, at);
  if (notice.tone === 'bad') return notice;
  const place = placeErrorView(reason instanceof Error ? reason.message : 'chyba');
  return place.tone === 'bad' ? { tone: 'bad', text: place.text, at } : { ...notice, text: `${notice.text} Nic neopakuj.` };
};

const noticeTone = (tone: LiveManageNotice['tone']) => (tone === 'ok' ? 'bg-emerald-500/10 text-emerald-600' : tone === 'bad' ? 'bg-rose-500/10 text-rose-500' : 'bg-amber-500/10 text-amber-600');
const unitValue = (units: TicketBracketUnits) => (value: number) => (units === 'ticks' ? String(Math.round(value)) : value.toFixed(2));

/**
 * Čipy ATM šablon (U8): klik = jen předvyplní SL/TP (a velikost šablony) v návrhu,
 * ★ = výchozí pro nové návrhy, × = smazat (šablona, dvoukrokově). „Uložit jako šablonu“
 * uloží jen vzdálenosti aktuálního návrhu (žádnou cenu, INV-UI-04). Nic neodesílá.
 */
const TemplateBar: React.FC<{
  isDark: boolean; muted: string; field: string; line: string;
  choices: LiveBracketTemplateChoice[];
  /** Návrh je Market (čip s SL/TP pod 16 ticků varuje). */
  market: boolean;
  /** Proč šablonu teď nejde použít (přikoupení); null = jde. */
  applyBlocked: string | null;
  /** Ukládat jde (přihlášený uživatel, čitelné úložiště); jinak proč ne. */
  saveBlocked: string | null;
  onApply: (template: LiveBracketTemplate) => void;
  onDefault: (id: string | null) => void;
  onDelete: (id: string) => void;
  deleteAsking: (id: string) => boolean;
  onSave: (name: string, includeSizing: boolean) => string | null;
  notice: LiveManageNotice | null;
}> = ({ isDark, muted, field, line, choices, market, applyBlocked, saveBlocked, onApply, onDefault, onDelete, deleteAsking, onSave, notice }) => {
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [withSize, setWithSize] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chip = `inline-flex h-[22px] items-center rounded-[7px] border text-[10px] font-bold ${field}`;
  const hover = isDark ? 'hover:bg-white/[0.08]' : 'hover:bg-white/80';
  return <div className="grid gap-1">
    <div className="flex flex-wrap items-center gap-1">
      {choices.map(choice => {
        const warn = market && choice.marketWarning != null;
        return <span key={choice.template.id} className={`${chip} ${warn ? '!border-amber-500/60' : ''}`}>
          <button
            type="button"
            disabled={applyBlocked != null}
            onClick={() => onApply(choice.template)}
            title={applyBlocked ?? (warn ? choice.marketWarning! : 'Vyplní SL/TP podle šablony — nic se neodešle')}
            className={`h-full rounded-l-[6px] px-1.5 disabled:cursor-not-allowed disabled:opacity-45 ${hover}`}
          >{choice.label}{choice.sizingLabel ? <span className={`ml-1 ${muted}`}>· {choice.sizingLabel}</span> : null}{warn ? <span className="ml-1 text-amber-600">⚠</span> : null}</button>
          <button
            type="button"
            disabled={saveBlocked != null}
            onClick={() => onDefault(choice.isDefault ? null : choice.template.id)}
            aria-label={choice.isDefault ? 'Výchozí šablona' : 'Nastavit jako výchozí'}
            title={saveBlocked ?? (choice.isDefault ? 'Výchozí pro nový návrh (klik = zpět na vestavěnou)' : 'Nastavit jako výchozí pro nový návrh')}
            className={`grid h-full w-[18px] place-items-center disabled:cursor-not-allowed ${choice.builtIn ? 'rounded-r-[6px]' : ''} ${hover}`}
          ><Star size={10} className={choice.isDefault ? 'fill-amber-400 text-amber-500' : muted} /></button>
          {!choice.builtIn && <button
            type="button"
            disabled={saveBlocked != null}
            onClick={() => onDelete(choice.template.id)}
            aria-label={`Smazat šablonu ${choice.template.name}`}
            title={deleteAsking(choice.template.id) ? 'Klikni znovu — šablona se smaže' : 'Smazat šablonu'}
            className={`h-full rounded-r-[6px] px-1 disabled:cursor-not-allowed ${deleteAsking(choice.template.id) ? 'bg-rose-500/15 text-rose-500' : muted} ${hover}`}
          >{deleteAsking(choice.template.id) ? 'Smazat?' : <X size={10} />}</button>}
        </span>;
      })}
      {!saving && <button
        type="button"
        disabled={saveBlocked != null}
        onClick={() => { setSaving(true); setError(null); }}
        title={saveBlocked ?? 'Uloží vzdálenost SL/TP od vstupu (ne ceny)'}
        className={`h-[22px] rounded-[7px] border border-dashed px-1.5 text-[10px] font-bold disabled:cursor-not-allowed disabled:opacity-45 ${line} ${muted} ${hover}`}
      >+ Uložit jako šablonu</button>}
    </div>
    {saving && <div className={`grid gap-1 rounded-[8px] border p-1.5 ${field}`}>
      <div className="flex items-center gap-1">
        <input
          aria-label="Název šablony"
          value={name}
          maxLength={LIVE_TEMPLATE_NAME_MAX}
          placeholder="Název (např. Scalp)"
          onChange={event => setName(event.target.value)}
          onKeyDown={event => { if (event.key === 'Escape') setSaving(false); }}
          className="h-[24px] min-w-0 flex-1 rounded-[6px] bg-transparent px-1.5 text-[11px] outline-none"
        />
        <button
          type="button"
          onClick={() => { const failed = onSave(name, withSize); setError(failed); if (!failed) { setSaving(false); setName(''); } }}
          className="h-[24px] rounded-[6px] bg-blue-600 px-2 text-[10.5px] font-extrabold text-white hover:bg-blue-700"
        >Uložit</button>
        <button type="button" onClick={() => setSaving(false)} aria-label="Zrušit ukládání" className={`grid h-[24px] w-[24px] place-items-center rounded-[6px] ${muted} ${hover}`}><X size={12} /></button>
      </div>
      <label className={`flex items-center gap-1.5 text-[10px] ${muted}`}>
        <input type="checkbox" checked={withSize} onChange={event => setWithSize(event.target.checked)} />
        uložit i velikost (kontrakty / riziko $)
      </label>
      {error && <div className="text-[10px] font-bold text-rose-500">{error}</div>}
    </div>}
    {notice && <div className={`rounded-[7px] px-2 py-1 text-[10px] font-bold ${noticeTone(notice.tone)}`}>{notice.text}</div>}
  </div>;
};

/**
 * „Přidat SL/TP“ k vlastnímu holému Marketu (U4): pozice je BEZ ochrany.
 * Pole v jednotkách panelu od průměru vstupu; odeslání jedním klikem (snižuje
 * riziko) přes deskový `attachBrackets`, worker nohy ověří znovu (≥ 8 ticků od
 * své ceny IBKR). Neznámý výsledek = nic se neopakuje.
 */
const AttachSection: React.FC<{
  muted: string; field: string; ink: string;
  side: 'long' | 'short';
  quantity: number;
  units: TicketBracketUnits;
  legs: LiveAttachLegs | null;
  /** Cena, od které jsou jednotky (průměr vstupu); null = jen cena. */
  reference: number | null;
  market: number | null;
  problem: string | null;
  sendBlocked: string | null;
  busy: boolean;
  notice: LiveManageNotice | null;
  displayValue: (leg: LiveManageLeg, price: number | null) => number | null;
  onCommit: (leg: LiveManageLeg, value: number) => void;
  onSend: () => void;
  /** C8: × zavřít tuto holou pozici; chybí = jen Flatten. */
  close?: React.ReactNode;
}> = ({ muted, field, ink, side, quantity, units, legs, reference, market, problem, sendBlocked, busy, notice, displayValue, onCommit, onSend, close }) => (
  <div className="grid gap-1.5 rounded-[9px] border border-rose-500/45 bg-rose-500/[0.06] p-2.5">
    <div className="flex items-baseline gap-2">
      <b className="text-[11px] font-black uppercase tracking-[0.06em] text-rose-500">{`${side === 'long' ? 'Long' : 'Short'} ${quantity} · BEZ SL/TP`}</b>
      <span className="flex-1" />
      <span className={`text-[9.5px] font-bold ${muted}`}>{market != null ? `trh ${formatPrice(market)}` : 'trh —'}</span>
    </div>
    <div className={`text-[10px] ${muted}`}>Ztráta nemá strop (jen Flatten). Doplň SL a TP — {units === 'price' || reference == null ? 'cena' : `${UNIT_LABEL[units].toLowerCase()} od průměru ${formatPrice(reference)}`}.</div>
    <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 gap-y-1.5">
      {(['takeProfit', 'stopLoss'] as const).map(leg => <React.Fragment key={leg}>
        <span className={`text-[11px] font-extrabold ${leg === 'stopLoss' ? 'text-rose-500' : 'text-emerald-500'}`}>{leg === 'stopLoss' ? 'Stop loss' : 'Take profit'}</span>
        <div className={`flex h-[30px] items-center rounded-[9px] border ${field}`}>
          <NumberField
            ariaLabel={leg === 'stopLoss' ? 'Přidat stop loss' : 'Přidat take profit'}
            value={displayValue(leg, legs ? (leg === 'stopLoss' ? legs.stopLoss : legs.takeProfit) : null)}
            format={unitValue(reference == null ? 'price' : units)}
            onCommit={value => onCommit(leg, value)}
            className={`min-w-0 flex-1 bg-transparent px-2 text-center font-mono text-[13px] outline-none ${ink}`}
          />
          <span className={`pr-2 text-[10px] font-bold ${muted}`}>{reference == null ? '' : UNIT_SUFFIX[units]}</span>
        </div>
      </React.Fragment>)}
    </div>
    {problem && <div className="text-[10px] font-bold text-amber-600">{problem}</div>}
    <button
      type="button"
      disabled={sendBlocked != null || busy}
      onClick={onSend}
      title={sendBlocked ?? 'Pošle SL a TP k pozici leadera; worker je ověří proti své ceně IBKR.'}
      className="h-[34px] rounded-[9px] bg-indigo-600 text-[11.5px] font-extrabold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-45"
    >{busy ? 'Odesílám…' : `Odeslat SL a TP${legs?.stopLoss != null && legs.takeProfit != null ? ` · ${formatPrice(legs.stopLoss)} / ${formatPrice(legs.takeProfit)}` : ''}`}</button>
    {notice && <div className={`rounded-[7px] px-2 py-1.5 text-[10.5px] font-bold ${noticeTone(notice.tone)}`}>{notice.text}</div>}
    {close}
  </div>
);

/**
 * C8 (4. 11. 2026): × zavřít vlastní holý Market z panelu — prvním klikem, tatáž funkce obrazovky jako × na čáře (jeden zámek).
 * Neaktivní s důvodem nad zastaralým stavem / mimo zapnutou kopírku; po kliku pouští fokus.
 */
export const BareCloseButton: React.FC<{
  offer: LiveBareCloseOffer;
  busy: boolean;
  notice: LiveManageNotice | null;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
}> = ({ offer, busy, notice, onClick }) => <div className="grid gap-1">
  <button
    type="button"
    data-live-bare-close
    disabled={!offer.enabled || busy}
    onClick={onClick}
    title={offer.reason ?? 'Zavře holou pozici leadera (close-position); worker ji před zavřením ověří u brokera.'}
    className={`h-[30px] rounded-[9px] border text-[11px] font-extrabold disabled:cursor-not-allowed disabled:opacity-45 border-rose-500/50 text-rose-500 hover:bg-rose-500/10`}
  >{busy ? 'Zavírám…' : liveBareCloseLabel(offer.trade)}</button>
  {offer.reason && <div className="text-[10px] font-bold text-amber-600">{offer.reason}</div>}
  {notice && <div role="status" className={`rounded-[7px] px-2 py-1.5 text-[10.5px] font-bold ${noticeTone(notice.tone)}`}>{notice.text}</div>}
</div>;

/** Plán tlačítka správy pro vykreslení: popisek a stav. */
interface ManageButtonView { label: string; disabled: boolean; title: string }

/**
 * Správa otevřené pozice leadera z panelu (U10, řeší N3): SL/TP zadáním čísla,
 * BE, BE + n ticků, BE + odhad poplatků. Jen záměr pro sdílený runner správy
 * (`useLiveManageRunner` z LiveTradingScreen — jeden zámek s čarami grafu);
 * „co jsem viděl“ je cena nohy z read modelu, průměr ze stavu pollu workeru
 * (INV-UI-01). První klik odesílá (Filip 5. 11. 2026).
 */
const ManageSection: React.FC<{
  muted: string; field: string; ink: string; line: string;
  units: TicketBracketUnits;
  displayValue: (leg: LiveManageLeg) => number | null;
  onCommit: (leg: LiveManageLeg, value: number) => void;
  move: Record<LiveManageLeg, ManageButtonView>;
  onMove: (leg: LiveManageLeg) => void;
  breakEven: { be: ManageButtonView; plus: ManageButtonView; fees: ManageButtonView | null };
  onBreakEven: (variant: LiveManageBreakEvenVariant) => void;
  plusTicks: number;
  /** Cena SL pro BE + n (jen zobrazení vedle pole n); null = nejde spočítat. */
  plusPrice: number | null;
  onPlusTicks: (ticks: number) => void;
  notice: LiveManageNotice | null;
}> = ({ muted, field, ink, line, units, displayValue, onCommit, move, onMove, breakEven, onBreakEven, plusTicks, plusPrice, onPlusTicks, notice }) => {
  const action = (view: ManageButtonView, onClick: () => void, extra = '') => <button
    type="button"
    disabled={view.disabled}
    onClick={event => { event.currentTarget.blur(); onClick(); }}
    title={view.title}
    className={`h-[26px] rounded-[7px] border px-2 text-[10.5px] font-extrabold disabled:cursor-not-allowed disabled:opacity-45 ${line} ${ink} ${extra}`}
  >{view.label}</button>;
  return <div className={`grid gap-1.5 rounded-[9px] border p-2.5 ${field}`}>
    <div className={`text-[9px] font-black uppercase tracking-[0.1em] ${muted}`}>Správa pozice · leader</div>
    <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-1.5 gap-y-1.5">
      {(['stopLoss', 'takeProfit'] as const).map(leg => <React.Fragment key={leg}>
        <span className={`text-[11px] font-extrabold ${leg === 'stopLoss' ? 'text-rose-500' : 'text-emerald-500'}`}>{leg === 'stopLoss' ? 'SL' : 'TP'}</span>
        <div className={`flex h-[28px] items-center rounded-[8px] border ${field}`}>
          <NumberField
            ariaLabel={leg === 'stopLoss' ? 'Nový stop loss' : 'Nový take profit'}
            value={displayValue(leg)}
            format={unitValue(units)}
            onCommit={value => onCommit(leg, value)}
            className={`min-w-0 flex-1 bg-transparent px-1.5 text-center font-mono text-[12.5px] outline-none ${ink}`}
          />
          <span className={`pr-1.5 text-[10px] font-bold ${muted}`}>{UNIT_SUFFIX[units]}</span>
        </div>
        {action(move[leg], () => onMove(leg))}
      </React.Fragment>)}
    </div>
    <div className="flex flex-wrap items-center gap-1">
      {action(breakEven.be, () => onBreakEven({ kind: 'be' }))}
      <span className={`inline-flex h-[26px] items-center gap-0.5 rounded-[7px] border pr-0.5 ${line}`}>
        {action(breakEven.plus, () => onBreakEven({ kind: 'be-plus', ticks: plusTicks }), '!border-0')}
        <NumberField
          ariaLabel="BE plus ticků"
          value={plusTicks}
          format={value => String(Math.round(value))}
          onCommit={value => onPlusTicks(Math.min(MANAGE_BE_MAX_TICKS, Math.max(1, Math.round(value))))}
          className={`h-[20px] w-[30px] rounded-[5px] bg-transparent text-center font-mono text-[11px] outline-none ${ink}`}
        />
        <span className={`pr-1 text-[9.5px] font-bold ${muted}`}>t{plusPrice != null ? ` · ${formatPrice(plusPrice)}` : ''}</span>
      </span>
      {breakEven.fees && action(breakEven.fees, () => onBreakEven({ kind: 'be-fees' }))}
    </div>
    {notice && <div className={`rounded-[7px] px-2 py-1.5 text-[10.5px] font-bold ${noticeTone(notice.tone)}`}>{notice.text}</div>}
  </div>;
};

interface Props {
  isDark: boolean;
  instrument: TicketInstrument;
  quote: TicketQuote | null;
  draft: TicketDraft | null;
  onDraft: (next: TicketDraft | null) => void;
  /** Návrh vznikl ⚡ z position boxu (štítek v hlavičce). */
  fromBox: boolean;
  units: TicketBracketUnits;
  onUnits: (units: TicketBracketUnits) => void;
  scope: TicketScope;
  onScope: (scope: TicketScope) => void;
  /** Účty skupiny; `null` = ještě nenapojené (produkce bez ukázkových dat). */
  group: LiveTradeGroup | null;
  target: LiveTradeTarget;
  onTarget: (target: LiveTradeTarget) => void;
  /** Odkud a jak stará je orientační cena (data grafu, ne kotace brokera). */
  quoteInfo: { source: string | null; capturedAt: number | null; stale: boolean };
  /** Živá pozice cíle panelu (z brokera); null = bez dat. */
  position?: LiveChartPosition | null;
  /** Fáze 1a: náhled u workeru — worker vyhodnotí brány, nic neodešle. */
  onPreviewEntry?: (draft: LiveEntryPreviewDraft) => Promise<LeaderEntryPreviewResult>;
  /** Fáze 1b: odeslání ručního vstupu na leadera (jen worker s `manual-entry-v1`). */
  onPlaceEntry?: (draft: LiveEntryPreviewDraft, operationId: string) => Promise<LeaderEntryPlaceResult>;
  /** Fáze 2a: správa vlastního ručního vstupu na symbolu grafu (jen worker s `manual-order-manage-v1`). */
  onManageEntry?: (action: LeaderOrderManageAction, expectPrice: number, newPrice?: number) => Promise<LeaderOrderManageResult>;
  /** Průměrný vstup spravovaného obchodu leadera od workeru (SL na BE). */
  manageEntryAvgPrice?: number | null;
  /** Worker umí nativní Market (`manual-entry-market-v1`); bez něj Market nejde odeslat. */
  entryMarketSupported?: boolean;
  /** Strop kontraktů ručního vstupu skupiny workeru (výchozí 1). */
  entryMaxContracts?: number;
  /** Front kontrakt podle brokera (čerstvý) — jen pro Limit/Stop, když graf nejede z IBKR. */
  entryFrontContract?: string | null;
  /**
   * Přikoupení do otevřené pozice (3. 11. 2026): návrh na stranu pozice přebírá společné
   * SL/TP pozice (zamčené) a strop platí na celou pozici. Jen zobrazení — rozhoduje worker.
   */
  entryScaleIn?: LiveTicketScaleIn | null;
  // ── U4/U8/U10 (3. 11. 2026): výchozí hodnoty = dnešní chování panelu ──
  /** Worker inzeruje holý Market a „Přidat SL/TP“ (`manual-entry-bare-v1`); výchozí false = holý Market se nenabídne. */
  entryBareSupported?: boolean;
  /** Vlastní přijatý holý Market bez nohou (desk `newestOpenBareEntry`); výchozí null = „Přidat SL/TP“ se neukáže. */
  entryBareEntry?: LiveBareEntryRecord | null;
  /** Pozice leadera skupiny workeru na symbolu grafu (`liveAttachIntent.position`); výchozí null. */
  entryLeaderPosition?: LivePhonePosition | null;
  /** Deskový `attachBrackets`; chybí = „Přidat SL/TP“ se nenabídne. */
  onAttachBrackets?: (input: LiveAttachInput) => Promise<LeaderOrderManageResult>;
  /** Brána desku (čerstvý stav, ARM, rozpracovaný vstup, relay) — uplatní se na holý Market; výchozí null. */
  entryBlockedReason?: string | null;
  /**
   * Rozpracované nohy „Přidat SL/TP“ (čáry „· přidat“ kreslí LiveTradingScreen). S `onAttachLegs`
   * je stav řízený zvenku; bez něj si ho panel drží sám.
   */
  attachLegs?: LiveAttachLegs | null;
  onAttachLegs?: (next: LiveAttachLegs | null) => void;
  /** Leader execution skupiny workeru (`liveManageBasis`); výchozí null = sekce Správa se nenabídne. */
  manageLeaderAccountId?: number | null;
  /** Pojistkový souhrn v okamžiku akce (LiveTradingScreen `guardSummaryAt`); chybí = `position.summary`. */
  manageGuardAt?: (at: number) => LiveChartPositionSummary | null;
  /**
   * Sdílený runner správy z LiveTradingScreen (`useLiveManageRunner`, jeden zámek
   * s čarami grafu). Chybí = sekce Správa se nenabídne (vlastní zámek by se s čarami nesdílel).
   */
  manageRunner?: LiveManageRunner | null;
  /** Worker umí TP blíž k trhu (`manual-order-pending-legs-v1`). */
  managePendingLegs?: boolean;
  /** Přihlášený uživatel — klíč knihovny šablon na zařízení; chybí = jen vestavěná šablona, nic se neukládá. */
  userId?: string | null;
  /** C8: nabídka × u vlastní holé pozice (jen zobrazení); výchozí null = tlačítko se neukáže. */
  bareClose?: LiveBareCloseOffer | null;
  /** C8: × holé pozice obrazovky (`closeBare`, sdílený zámek s čarou); chybí = tlačítko se neukáže. */
  onBareClose?: (entryOperationId: string) => Promise<LiveManageOutcome | null>;
  /**
   * Sdílený zámek jednoho příkazu obrazovky / desku (LiveTradingScreen `manageState.busyRef` =
   * `liveCommandLockRef`): vstup (velké tlačítko i Náhled → Odeslat), „Přidat SL/TP“ i × holé
   * pozice z panelu jdou tímtéž zámkem jako čáry, zkratky, lišta „Zrušit čekající“ a Dashboard.
   * Chybí = vlastní zámek panelu.
   */
  commandLockRef?: { current: boolean } | null;
  onNewDraft: (side: TicketSide) => void;
  onClose: () => void;
}

/** Číselné pole: při psaní drží text, potvrzuje se Enterem nebo opuštěním (i panel backtestu). */
export const NumberField: React.FC<{
  value: number | null;
  format: (value: number) => string;
  onCommit: (value: number) => void;
  disabled?: boolean;
  className: string;
  ariaLabel: string;
}> = ({ value, format, onCommit, disabled = false, className, ariaLabel }) => {
  const [text, setText] = useState<string | null>(null);
  const commit = () => {
    if (text == null) return;
    const parsed = Number(text.replace(/\s/g, '').replace(',', '.'));
    setText(null);
    if (Number.isFinite(parsed)) onCommit(parsed);
  };
  return <input
    aria-label={ariaLabel}
    inputMode="decimal"
    disabled={disabled}
    className={className}
    value={text ?? (value == null ? '' : format(value))}
    onFocus={event => { setText(value == null ? '' : format(value).replace(/\s/g, '')); event.currentTarget.select(); }}
    onChange={event => setText(event.target.value)}
    onBlur={commit}
    onKeyDown={event => { if (event.key === 'Enter') { commit(); event.currentTarget.blur(); } if (event.key === 'Escape') { setText(null); event.currentTarget.blur(); } }}
  />;
};

const LiveOrderTicket: React.FC<Props> = ({
  isDark, instrument, quote, draft, onDraft, fromBox, units, onUnits, scope, onScope,
  group, target, onTarget, quoteInfo, position = null, onPreviewEntry, onPlaceEntry, onManageEntry, manageEntryAvgPrice = null,
  entryMarketSupported = false, entryMaxContracts = 1, entryFrontContract = null, entryScaleIn = null,
  entryBareSupported = false, entryBareEntry = null, entryLeaderPosition = null, onAttachBrackets, entryBlockedReason = null,
  attachLegs = null, onAttachLegs, manageLeaderAccountId = null, manageGuardAt, manageRunner = null, managePendingLegs = false, userId = null,
  bareClose = null, onBareClose, commandLockRef = null, onNewDraft, onClose,
}) => {
  const ownCommandLockRef = useRef(false);
  const lockRef = commandLockRef ?? ownCommandLockRef;
  // Vstup z panelu (velké tlačítko i Náhled → Odeslat) jen pod sdíleným zámkem jednoho příkazu.
  const placeEntryLocked = onPlaceEntry
    ? (entryDraft: LiveEntryPreviewDraft, operationId: string) => runWithCommandLock(lockRef, () => onPlaceEntry(entryDraft, operationId))
    : undefined;
  // Přikoupení: návrh na stranu otevřené pozice drží SL/TP pozice (čáry návrhu se k nim vrátí).
  const scaleIn = entryScaleIn && draft && draft.side === entryScaleIn.side ? entryScaleIn : null;
  useEffect(() => {
    if (!scaleIn || !draft || scaleIn.stopLoss == null || scaleIn.targetPrice == null) return;
    if (draft.stopLoss !== scaleIn.stopLoss || draft.takeProfit !== scaleIn.targetPrice) {
      onDraft({ ...draft, stopLoss: scaleIn.stopLoss, takeProfit: scaleIn.targetPrice });
    }
  }, [scaleIn, draft, onDraft]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pickerOpen) return;
    const close = (event: PointerEvent) => { if (!pickerRef.current?.contains(event.target as Node)) setPickerOpen(false); };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [pickerOpen]);

  const single = target.kind === 'account';
  const picked = group ? targetAccount(group, target) : null;
  const tone = {
    // Panel je přilepený ke grafu: plný podklad hlavičky LIVE, jen levá hrana.
    dock: isDark ? 'border-white/10 bg-[#0d1219] text-slate-200' : 'border-slate-200 bg-white text-slate-800',
    field: isDark ? 'border-white/10 bg-white/[0.04]' : 'border-slate-900/10 bg-white/70',
    muted: isDark ? 'text-slate-400' : 'text-slate-500',
    ink: isDark ? 'text-slate-100' : 'text-slate-900',
    line: isDark ? 'border-white/[0.08]' : 'border-slate-900/[0.08]',
    seg: isDark ? 'border-white/10 bg-white/[0.04]' : 'border-slate-900/10 bg-white/70',
    segOn: isDark ? 'bg-white/10 text-white' : 'bg-white text-slate-950 shadow-[0_1px_3px_rgba(15,23,42,0.14),0_0_0_1px_rgba(15,23,42,0.06)]',
    segOff: isDark ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-800',
  };
  const seg = (on: boolean) => `h-full flex-1 rounded-[7px] px-1.5 text-[10.5px] font-bold transition-colors ${on ? tone.segOn : tone.segOff}`;
  const label = `text-[9px] font-black uppercase tracking-[0.1em] ${tone.muted}`;

  const tick = instrument.tickSize;
  const m = draft && quote ? ticketMetrics(draft, instrument, quote) : null;
  // Předvolby zařízení (U4): počet, velikost a jednotky — jen předvyplnění, nikdy cena.
  const [prefs, setPrefs] = useState<LiveTicketPrefs>(() => readLiveTicketPrefs(liveTicketPrefsStorage()));
  const remember = (patch: Partial<LiveTicketPrefs>) => setPrefs(updateLiveTicketPrefs(liveTicketPrefsStorage(), patch));
  // ATM šablony (U8): knihovna na zařízení; výchozí (★) jen vlastní — bez ní dosavadní 12 b / 2R.
  const templates = useLiveBracketTemplateLibrary(userId);
  const customDefault = templates.library.defaultId != null ? defaultLiveBracketTemplate(templates.library) : null;
  // Otevřený panel bez návrhu ukazuje celý formulář (ztlumený, neaktivní) —
  // ožije až výběrem Koupit / Prodat. Nic z něj nejde do grafu ani k odeslání.
  const restingDraft = !draft && quote
    ? liveTicketNewDraft({ side: 'buy', type: 'limit', price: quote.ask - 10, instrument, quote, prefs, maxContracts: entryMaxContracts, template: customDefault }).draft
    : null;
  const formDraft = draft ?? restingDraft;
  const formMetrics = formDraft && quote ? (draft ? m : ticketMetrics(formDraft, instrument, quote)) : null;
  const limits = group ? limitAccounts(group, target).map(({ account, multiplier }) => ({
    name: account.name, remainingUsd: account.dayRemaining.value, stale: account.dayRemaining.stale, multiplier,
  })) : null;
  // U Marketu se SL/TP blíž než 16 ticků od ceny jen varuje (rozhoduje worker proti IBKR).
  const marketDistance = draft && quote ? liveMarketBracketDistanceProblem(draft, instrument, quote) : null;
  const problems = draft && quote ? [...ticketProblems(draft, instrument, quote, limits), ...(marketDistance ? [marketDistance] : [])] : [];
  const groupMultiplier = group ? targetMultiplier(group, target) : 1;
  // Fáze 1a: co by panel poslal workeru k náhledu (jen Limit/Stop se SL i TP, skupina).
  // Kontrakt bere náhled ze zdroje ceny grafu — v týdnu rollu nikdy odhadem.
  // Kontrakt: ze zdroje IBKR; u Limit/Stop jinak front podle brokera (2. 11.) — Market jen z IBKR.
  const previewSymbol = previewSymbolFromChartSource(quoteInfo.source) ?? (draft && draft.type === 'limit' ? entryFrontContract : null);
  // Market (2. 11. 2026) = skutečný Market u brokera bez ceny příkazu. Cena, kterou
  // uživatel vidí (Buy = ask, Sell = bid), a čas kotace jdou jen k odhadu rizika.
  const marketReference = draft && quote && draft.type === 'market' ? (draft.side === 'buy' ? quote.ask : quote.bid) : null;
  // Holý Market (U4, 3. 11. 2026): Market bez SL i TP jen s capability `manual-entry-bare-v1`
  // (manual-only DEMO). Stejný payload jako list a lišta telefonu; kontrakt jen z IBKR.
  const bareDraft = draft != null && entryBareSupported && isBareTicketDraft(draft);
  const bareQuote: LiveBareQuote | null = quote && quoteInfo.capturedAt != null
    ? { symbol: previewSymbolFromChartSource(quoteInfo.source), bid: quote.bid, ask: quote.ask, at: quoteInfo.capturedAt }
    : null;
  // Pozice i čekající vstup = ne flat (worker `account-not-flat`); neověřené čtení nebo
  // chybějící data = neznámo, tedy taky ne flat (unknown ≠ flat). UI přísnější, nikdy volnější.
  const barePosition = liveTicketBarePosition(position, entryLeaderPosition);
  /** Brána holého Marketu: PC důvody (odeslání, cíl, cena, neověřená pozice) + brána desku; vyhodnotí se znovu při kliku. */
  const bareGateAt = (now: number): LiveBareMarketGate => ({
    blockedReason: !onPlaceEntry ? 'Worker odeslání z grafu neumí.'
      : single ? 'Holý Market jen pro skupinu (vstup na leadera).'
        : quoteInfo.stale ? 'Cena grafu je zastaralá — holý Market teď nejde.'
          : entryBlockedReason ?? barePosition.reason,
    marketSupported: entryMarketSupported,
    bareSupported: entryBareSupported,
    maxContracts: entryMaxContracts,
    quote: bareQuote,
    positionOpen: barePosition.open,
    now,
  });
  const bareEntryDraft = bareDraft && draft && quote && bareQuote && previewSymbol
    ? liveTicketBareEntry(draft, instrument, { ...bareQuote, symbol: previewSymbol })
    : null;
  const previewDraft: LiveEntryPreviewDraft | null = bareDraft
    ? (bareEntryDraft && !('error' in bareEntryDraft) ? bareEntryDraft : null)
    : previewSymbol && draft && m && draft.stopLoss != null && draft.takeProfit != null && m.quantity >= 1
    && (draft.type !== 'market' || (marketReference != null && quoteInfo.capturedAt != null))
    ? { symbol: previewSymbol, side: draft.side === 'buy' ? 'Buy' : 'Sell', quantity: m.quantity,
      ...(draft.type === 'market'
        ? { orderType: 'Market' as const, referencePrice: marketReference!, quoteReceivedAt: Math.round(quoteInfo.capturedAt!) }
        : { orderType: draft.type === 'stop' ? 'Stop' as const : 'Limit' as const, price: draft.price }),
      stopLoss: draft.stopLoss, takeProfit: draft.takeProfit }
    : null;
  const previewBlockedReason = !draft ? null
    : !previewSymbol ? (draft.type === 'market'
      ? 'Market potřebuje cenu z IBKR (graf teď jede z TradingView / kontinuální řady) — použij Limit.'
      : draft.type === 'stop' ? 'Stop potřebuje cenu z IBKR — bez ní jen Limit.'
      : 'Kontrakt není ověřený (IBKR ani broker) — náhled teď nejde.')
    : quoteInfo.stale ? 'Cena grafu je zastaralá — náhled ani odeslání teď nejde.'
    // Market bere cenu grafu jako strop ceny příkazu — jen čerstvou (oponentura 2d/C).
    : draft.type === 'market' && !entryMarketSupported ? 'Worker zatím neumí nativní Market — použij Limit.'
    : draft.type === 'market' && (quoteInfo.capturedAt == null || Date.now() - quoteInfo.capturedAt > MARKET_QUOTE_MAX_AGE_MS) ? 'Cena grafu je starší než 3 s — Market teď nejde (zkus Limit).'
    : entryScaleIn && draft.side !== entryScaleIn.side ? 'V pozici jde jen přikoupit na její stranu — zmenšit / otočit ji z panelu nejde (zavři ×).'
    : scaleIn && scaleIn.pendingAdd ? 'Předchozí přikoupení ještě čeká — nejdřív ať se vyplní, nebo ho zruš.'
    : scaleIn && (draft.stopLoss !== scaleIn.stopLoss || draft.takeProfit !== scaleIn.targetPrice) ? 'Přikoupení musí mít SL a TP pozice — nic se neodešle, dokud nesedí.'
    : scaleIn && draft.type !== 'market' && m && m.quantity > 1 ? 'Čekající přikoupení (Limit/Stop) jde zatím jen po 1 kontraktu — větší množství Marketem.'
    : scaleIn && m && scaleIn.quantity + m.quantity > entryMaxContracts ? `Pozice by měla ${scaleIn.quantity + m.quantity} kontraktů — strop účtu je ${entryMaxContracts}.`
    : scaleIn && !scaleIn.canAdd ? scaleIn.reason ?? 'Přikoupení teď nejde.'
    : m && m.quantity > entryMaxContracts ? `Ruční vstup je omezený na ${entryMaxContracts} ${entryMaxContracts === 1 ? 'kontrakt' : entryMaxContracts < 5 ? 'kontrakty' : 'kontraktů'} (strop skupiny).`
      // Jedna noha nikdy; Limit/Stop obě; Market bez obou jen s capability (U4).
      : liveTicketLegsProblem(draft, entryBareSupported) ?? (bareDraft
        ? (draft.sizing !== 'qty' ? 'Holý Market jen v kontraktech — bez SL nejde velikost podle rizika.'
          : liveBareMarketBlockReason(bareGateAt(Date.now()), m?.quantity ?? 0))
        : null) ?? (single ? 'Náhled zatím jen pro skupinu (vstup na leadera).'
          : problems.some(problem => problem.level === 'error') ? 'Nejdřív oprav chyby v panelu.' : null);
  // Přímé odeslání velkým tlačítkem (Filip 30. 10.: jedním kliknutím, bez náhledu).
  // Worker při odeslání znovu vyhodnotí všechny brány náhledu; při problému nic nepošle.
  const [direct, setDirect] = useState<{ key: string; view: { tone: 'ok' | 'bad' | 'warn'; text: string } } | null>(null);
  const [directBusy, setDirectBusy] = useState(false);
  const directBusyRef = useRef(false);
  // Po přijetí se návrh hned maže (nic nejde poslat podruhé); zelené „Přijato“
  // je jen chvilková ozvěna místo tlačítka, ne tlačítko.
  const [sentFlash, setSentFlash] = useState<{
    text: string; operationId: string; receivedPerformanceAt: number;
  } | null>(null);
  useEffect(() => {
    if (!sentFlash) return undefined;
    const timer = window.setTimeout(() => setSentFlash(null), 1600);
    return () => window.clearTimeout(timer);
  }, [sentFlash]);
  useEffect(() => {
    if (!sentFlash) return undefined;
    const { operationId, receivedPerformanceAt } = sentFlash;
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        if (!hasActiveLiveCommandTrace(operationId)) return;
        markLiveCommandPaint({ operationId, stage: 'order', receivedPerformanceAt });
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
    };
  }, [sentFlash]);
  // U Marketu se cena mění s každým tickem — výsledek odeslání nesmí s tickem zmizet.
  // U Marketu klíčuje vzdálenost SL/TP od vstupu (ceny jedou s tickem), ne absolutní ceny.
  // Přikoupení: SL/TP jsou zamčené na cenách pozice — klíčuje absolutní cena, ne vzdálenost od ticku.
  const directKey = previewDraft ? JSON.stringify(previewDraft.orderType === 'Market'
    ? { ...previewDraft, referencePrice: 'market', quoteReceivedAt: 'market',
      ...(scaleIn || previewDraft.stopLoss == null || previewDraft.takeProfit == null ? {} : { stopLoss: previewDraft.stopLoss - previewDraft.referencePrice!, takeProfit: previewDraft.takeProfit - previewDraft.referencePrice! }) }
    : previewDraft) : '';
  const shownDirect = direct && direct.key === directKey ? direct : null;
  const directBlocked = !onPlaceEntry ? 'Worker odeslání z grafu neumí.'
    : previewBlockedReason ?? (!previewDraft ? 'Doplň cenu, SL i TP.' : null);
  // Po neznámém výsledku zamčeno do změny návrhu nebo stavu (`armed`), jako Náhled.
  const directLockKey = `${String(group?.armed)}|${directKey}`;
  const [directLock, setDirectLock] = useState<string | null>(null);
  const directLocked = directLock === directLockKey;
  // Holý Market z panelu (U4): první klik odesílá, jen dvojklik se spolkne.
  // Klíč = akce + kontrakt + strana + počet (cena jede s tickem, worker ji ověří proti IBKR).
  const bareSend = bareDraft && previewDraft != null && previewDraft.stopLoss === undefined && previewDraft.takeProfit === undefined;
  const directClickRef = useRef<LiveClickState | null>(null);
  const sendDirect = async () => {
    if (directBlocked != null || directLocked) return;
    if (!previewDraft || !placeEntryLocked || directBusyRef.current) return;
    // Jiný příkaz (× / posun z čáry, Zrušit čekající, Dashboard) právě letí — nic neodejde.
    if (lockRef.current) { setDirect({ key: directKey, view: { tone: 'warn', text: LIVE_COMMAND_BUSY_TEXT } }); return; }
    if (bareSend) {
      // Brána znovu v okamžiku kliku (kotace ≤ 3 s, flat, strop) — render mohl být starší.
      const step = liveBareSendClick({ gate: bareGateAt(Date.now()), last: directClickRef.current, draft: previewDraft });
      directClickRef.current = step.next;
      if (step.blocked) { setDirect({ key: directKey, view: { tone: 'bad', text: `Neodesláno: ${step.blocked}` } }); return; }
      if (!step.send) return;
    } else {
      // Rychlý ACK nesmí z dvojkliku udělat druhý vstup; klíč bez ceny (jede s tickem).
      const step = liveRepeatClick(directClickRef.current, liveBareConfirmKey(previewDraft), Date.now());
      directClickRef.current = step.next;
      if (!step.send) return;
    }
    directBusyRef.current = true;
    setDirectBusy(true);
    const sentKey = directKey;
    const sentLockKey = directLockKey;
    try {
      const operationId = `entry:${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
      const result = await placeEntryLocked(previewDraft, operationId);
      setDirect({ key: sentKey, view: placedResultView(result) });
      if (liveDirectResultLocks(result)) setDirectLock(sentLockKey);
      // Přijatý vstup: návrh se „promění“ v živý příkaz (štítek pozice v grafu, karta „Zadáno“).
      if (result.status === 'acknowledged') {
        setSentFlash({
          text: `${draft?.side === 'sell' ? 'Prodat' : 'Koupit'} ${previewDraft.quantity} ${instrument.symbol}`,
          operationId,
          receivedPerformanceAt: performance.now(),
        });
        onDraft(null);
      }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Odeslání se nepodařilo.';
      setDirect({ key: sentKey, view: placeErrorView(message) });
      if (liveDirectErrorLocks(message)) setDirectLock(sentLockKey);
    } finally {
      directBusyRef.current = false;
      setDirectBusy(false);
    }
  };
  const multiplier = single || scope === 'account' ? 1 : groupMultiplier;
  // Holý Market = výstražné tlačítko (pozice bez ochrany).
  const sideColor = bareSend ? '#d97706' : draft?.side === 'sell' ? '#e11d48' : '#2563eb';

  const setType = (type: TicketOrderType) => {
    if (!draft || !quote) return;
    if (type === draft.type) return;
    const market = marketPrice(draft.side, quote);
    const d = draft.side === 'buy' ? 1 : -1;
    // Limit pod trhem (long) / nad trhem (short), stop opačně — 10 bodů od trhu.
    const price = type === 'market' ? market : snapToTick(market + (type === 'limit' ? -d : d) * 10, instrument.tickSize);
    onDraft({ ...draft, type, price: draft.type === 'market' ? price : draft.price });
  };
  const toggleBracket = (which: TicketBracket) => {
    if (!draft || !quote) return;
    const current = which === 'sl' ? draft.stopLoss : draft.takeProfit;
    if (current != null) { onDraft(which === 'sl' ? { ...draft, stopLoss: null } : { ...draft, takeProfit: null }); return; }
    // Zapnutá noha: vzdálenost z vlastní výchozí šablony (TP v R k SL návrhu), jinak dosavadních 12 b / 2R.
    const entry = ticketEntry(draft, quote);
    const d = draft.side === 'buy' ? 1 : -1;
    const keptStopTicks = draft.stopLoss != null && (entry - draft.stopLoss) * d > 0 ? Math.max(1, Math.round(((entry - draft.stopLoss) * d) / tick)) : undefined;
    const fromTemplate = customDefault ? liveTemplateBracketPrices(customDefault, draft.side, entry, tick, keptStopTicks) : null;
    const requested = fromTemplate ? (which === 'sl' ? fromTemplate.stopLoss : fromTemplate.takeProfit ?? undefined) : undefined;
    onDraft(withBracket(draft, which, instrument, quote, requested));
  };
  const commitBracket = (which: TicketBracket, value: number) => {
    if (!draft || !quote) return;
    const price = bracketPriceFromInput(draft, which, units, value, instrument, quote);
    if (price == null) return;
    onDraft(which === 'sl' ? { ...draft, stopLoss: price } : { ...draft, takeProfit: price });
  };
  const stepQuantity = (step: number) => {
    if (!draft) return;
    const next = draft.sizing === 'risk'
      ? { ...draft, riskUsd: Math.max(25, draft.riskUsd + step * 25) }
      : { ...draft, quantity: Math.max(1, draft.quantity + step) };
    onDraft(next);
    remember({ sizing: next.sizing, quantity: next.quantity, riskUsd: next.riskUsd });
  };
  /** Velikost zvolená uživatelem: do návrhu a do předvoleb zařízení (příští návrh). */
  const pickSize = (next: TicketDraft) => {
    onDraft(next);
    remember({ sizing: next.sizing, quantity: next.quantity, riskUsd: next.riskUsd });
  };
  const pickUnits = (unit: TicketBracketUnits) => {
    onUnits(unit);
    remember({ units: unit });
  };
  const qtyPresets = liveTicketQtyPresets(entryMaxContracts);

  // ── ATM šablony (U8): jen předvyplnění návrhu, nic se neodesílá ──
  const [templateNotice, setTemplateNotice] = useState<LiveManageNotice | null>(null);
  useEffect(() => {
    if (!templateNotice) return undefined;
    const timer = window.setTimeout(() => setTemplateNotice(null), 6_000);
    return () => window.clearTimeout(timer);
  }, [templateNotice]);
  const [templateDelete, setTemplateDelete] = useState<LiveConfirmState | null>(null);
  const templateDeleteRef = useRef<LiveConfirmState | null>(null);
  const templateChoices = liveBracketTemplateChoices(templates.library, tick);
  const templateSaveBlocked = !userId ? 'Šablony se ukládají jen přihlášenému uživateli.'
    : !templates.writable ? (templates.status === 'newer-version' ? 'Šablony uložila novější verze appky — tady je jen čtu.' : 'Úložiště šablon teď nejde přečíst.')
      : null;
  const templateApplyBlocked = scaleIn ? 'Přikoupení drží SL/TP pozice — šablona se nepoužije.' : null;
  const applyTemplate = (template: LiveBracketTemplate) => {
    if (!draft || !quote) return;
    const applied = applyLiveBracketTemplate(draft, template, instrument, quote, { scaleIn: entryScaleIn, maxContracts: entryMaxContracts });
    if (applied.skipped) {
      setTemplateNotice({ tone: 'warn', at: Date.now(), text: applied.skipped === 'scale-in' ? 'Přikoupení drží SL/TP pozice — šablona se nepoužila.' : applied.notes.join(' ') || 'Šablonu teď nejde použít.' });
      return;
    }
    onDraft(applied.draft);
    setTemplateNotice(applied.notes.length ? { tone: 'warn', at: Date.now(), text: applied.notes.join(' ') } : null);
  };
  const storeNotice = (write: ReturnType<typeof saveLiveBracketTemplate>, ok: string) => {
    setTemplateNotice('error' in write ? { tone: 'bad', at: Date.now(), text: write.error } : { tone: 'ok', at: Date.now(), text: ok });
  };
  const saveTemplate = (name: string, includeSizing: boolean): string | null => {
    if (!draft || !quote) return 'Nejdřív vyber Koupit nebo Prodat.';
    // Šablona ukládá jen vzdálenost (ticky / body), nikdy cenu ani $ (INV-UI-04).
    const unit = units === 'pts' ? 'pts' : 'ticks';
    const created = liveTemplateFromDraft(draft, instrument, quote, { name, stopUnit: unit, targetUnit: unit, includeSizing });
    if ('errors' in created) return created.errors.join(' ');
    const write = saveLiveBracketTemplate(userId, created.template);
    if ('error' in write) return write.error;
    storeNotice(write, `Šablona „${created.template.name}“ uložena.`);
    return null;
  };
  const deleteTemplate = (id: string) => {
    const step = liveConfirmClick(templateDeleteRef.current, `template-delete:${id}`, Date.now());
    templateDeleteRef.current = step.next;
    setTemplateDelete(step.next);
    if (step.send) storeNotice(deleteLiveBracketTemplate(userId, id), 'Šablona smazána.');
  };
  const templateDeleteAsking = (id: string) => liveConfirmAsking(templateDelete, `template-delete:${id}`, Date.now());

  // ── „Přidat SL/TP“ k vlastnímu holému Marketu (U4) ──
  const attachEntry = entryBareSupported && onAttachBrackets ? entryBareEntry : null;
  const attachSide: 'long' | 'short' | null = attachEntry?.side === 'Buy' ? 'long' : attachEntry?.side === 'Sell' ? 'short' : null;
  const attachMarket = attachSide && quote ? liveAttachMarket(attachSide, quote) : null;
  const attachMarketRef = useRef(attachMarket);
  attachMarketRef.current = attachMarket;
  // Jednotky polí od průměru vstupu (poll workeru, jinak čtení brokera); bez něj jen cena.
  const attachReference = manageEntryAvgPrice ?? position?.summary?.entry ?? null;
  const [ownAttachLegs, setOwnAttachLegs] = useState<LiveAttachLegs | null>(null);
  const attachControlled = onAttachLegs != null;
  const legsNow = attachControlled ? attachLegs : ownAttachLegs;
  const setLegs = (next: LiveAttachLegs | null) => (attachControlled ? onAttachLegs!(next) : setOwnAttachLegs(next));
  const setLegsRef = useRef(setLegs);
  setLegsRef.current = setLegs;
  const attachOperationId = attachEntry?.operationId ?? null;
  const attachReady = attachMarket != null;
  // Výchozí nohy jednou na holý vstup (šablona ★, jinak 10 / 20 b od trhu); zmizelý vstup = nohy pryč.
  useEffect(() => {
    if (!attachOperationId) {
      if (legsNow) setLegsRef.current(null);
      return;
    }
    if (legsNow?.entryOperationId === attachOperationId || !attachSide || !attachReady || attachMarketRef.current == null) return;
    const defaults = liveAttachDefaultLegs(attachSide, attachMarketRef.current, attachReference, tick, customDefault);
    setLegsRef.current({ entryOperationId: attachOperationId, ...defaults });
  }, [attachOperationId, attachSide, attachReady, attachReference, customDefault, legsNow, tick]);
  const shownLegs = legsNow && legsNow.entryOperationId === attachOperationId ? legsNow : null;
  const attachQuantity = attachEntry?.quantity ?? entryLeaderPosition?.quantity ?? 0;
  const attachDisplay = (leg: LiveManageLeg, price: number | null) => (attachSide ? manageDisplayValue({
    side: attachSide, leg, units: attachReference == null ? 'price' : units, price, entryAvg: attachReference, quantity: attachQuantity, pointValue: instrument.pointValue, tick,
  }) : null);
  const [attachNotice, setAttachNotice] = useState<{ entryOperationId: string; notice: LiveManageNotice; final: boolean } | null>(null);
  const shownAttachNotice = attachNotice && attachNotice.entryOperationId === attachOperationId ? attachNotice : null;
  const commitAttach = (leg: LiveManageLeg, value: number) => {
    if (!attachSide || !shownLegs) return;
    const converted = managePriceFromInput({
      side: attachSide, leg, units: attachReference == null ? 'price' : units, value, entryAvg: attachReference, quantity: attachQuantity, pointValue: instrument.pointValue, tick,
    });
    if ('blocked' in converted) { setAttachNotice({ entryOperationId: shownLegs.entryOperationId, notice: { tone: 'bad', text: converted.blocked, at: Date.now() }, final: false }); return; }
    setLegs(leg === 'stopLoss' ? { ...shownLegs, stopLoss: converted.price } : { ...shownLegs, takeProfit: converted.price });
  };
  const attachProblem = attachSide && attachMarket != null && shownLegs?.stopLoss != null && shownLegs.takeProfit != null
    ? liveAttachProblem(attachSide, attachMarket, shownLegs.stopLoss, shownLegs.takeProfit, tick)
    : null;
  const [attachBusy, setAttachBusy] = useState(false);
  const attachBusyRef = useRef(false);
  const attachSendBlocked = !shownLegs || shownLegs.stopLoss == null || shownLegs.takeProfit == null ? 'Vyplň SL i TP.'
    : shownAttachNotice?.final ? 'Výsledek už přišel (nebo je neznámý) — nic se neopakuje.'
      : attachProblem;
  const sendAttach = async () => {
    if (!attachEntry || !onAttachBrackets || !shownLegs || attachBusyRef.current || directBusyRef.current) return;
    if (shownAttachNotice?.final) return;
    const operationId = attachEntry.operationId;
    // Jiný příkaz pod sdíleným zámkem (× holé pozice z čáry, Zrušit čekající, Dashboard) — attach neodejde.
    if (lockRef.current) { setAttachNotice({ entryOperationId: operationId, notice: { tone: 'warn', text: LIVE_COMMAND_BUSY_TEXT, at: Date.now() }, final: false }); return; }
    // Záměr se skládá až při kliku: čerstvá kotace IBKR téhož kontraktu, pozice = holý vstup, ≥ 8 ticků.
    const intent = liveAttachIntent({
      bareEntry: attachEntry, position: entryLeaderPosition, quote: bareQuote,
      stopLoss: shownLegs.stopLoss, takeProfit: shownLegs.takeProfit, tickSize: tick, now: Date.now(),
    });
    if ('error' in intent) { setAttachNotice({ entryOperationId: operationId, notice: { tone: 'bad', text: intent.error, at: Date.now() }, final: false }); return; }
    attachBusyRef.current = true;
    setAttachBusy(true);
    try {
      const result = await runWithCommandLock(lockRef, () => onAttachBrackets(intent.attach));
      const notice = liveManageResultNotice('attach-brackets', result, Date.now());
      // Přijato nebo neznámé = konec (nic se neopakuje); blokace / odmítnutí = jde opravit a zkusit znovu.
      const final = result.status === 'acknowledged' || result.status === 'unknown';
      setAttachNotice({ entryOperationId: operationId, notice: result.status === 'unknown' ? { ...notice, text: `${notice.text} Nic neopakuj.` } : notice, final });
    } catch (reason) {
      const notice = attachErrorNotice(reason, Date.now());
      setAttachNotice({ entryOperationId: operationId, notice, final: notice.tone !== 'bad' });
    } finally {
      attachBusyRef.current = false;
      setAttachBusy(false);
    }
  };

  // ── C8: × zavřít vlastní holý Market z panelu (tatáž funkce jako čára) ──
  const bareCloseOffer = bareClose && onBareClose ? bareClose : null;
  // Dvojklik a právě změněná nabídka se spolknou (`lib/liveClickGate`).
  const bareCloseGate = useLiveClickGate([bareCloseOffer]);
  const [bareCloseBusy, setBareCloseBusy] = useState(false);
  const [bareCloseNotice, setBareCloseNotice] = useState<{ entryOperationId: string; notice: LiveManageNotice } | null>(null);
  const shownBareCloseNotice = bareCloseOffer && bareCloseNotice?.entryOperationId === bareCloseOffer.trade.entryOperationId ? bareCloseNotice.notice : null;
  const onBareCloseRef = useRef(onBareClose);
  onBareCloseRef.current = onBareClose;
  const bareClosePanelClick = useMemo(() => createLiveBareClosePanelClick({
    gate: bareCloseGate,
    // Sdílený zámek (čáry, zkratky, C7, Dashboard) + vstup / attach panelu právě letí = nic.
    busy: () => lockRef.current || attachBusyRef.current || directBusyRef.current,
    close: () => onBareCloseRef.current,
    report: (entryOperationId, notice) => setBareCloseNotice({ entryOperationId, notice }),
  }), [bareCloseGate, lockRef]);
  const clickBareClose = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.currentTarget.blur();
    const target = bareCloseOffer?.trade.entryOperationId ?? null;
    const sent = bareClosePanelClick(bareCloseOffer);
    if (!sent || !target) return;
    setBareCloseBusy(true);
    void sent
      .then(outcome => { if (outcome) setBareCloseNotice({ entryOperationId: target, notice: outcome.notice }); })
      .finally(() => setBareCloseBusy(false));
  };
  const bareCloseInAttach = Boolean(attachEntry && attachSide && bareCloseOffer && attachEntry.operationId === bareCloseOffer.trade.entryOperationId);
  const bareCloseView = bareCloseOffer ? <BareCloseButton
    offer={bareCloseOffer}
    busy={bareCloseBusy}
    notice={shownBareCloseNotice}
    onClick={clickBareClose}
  /> : null;

  // ── Správa pozice leadera z panelu (U10): jen záměr pro sdílený runner ──
  const manageSummary = position?.summary ?? null;
  const manageOn = Boolean(onManageEntry && manageRunner && manageSummary?.kind === 'position'
    && leaderManageBasis(manageSummary, manageLeaderAccountId) != null && !attachEntry);
  const manageBasis = liveManageBasis(manageSummary, manageLeaderAccountId, manageEntryAvgPrice, instrument.pointValue, tick);
  /** Pojistkový souhrn TEĎ (kotace IBKR pro utažení); vyhodnotí se znovu při každém kliku. */
  const guardNow = (): LiveChartPositionSummary | null => (manageGuardAt ? manageGuardAt(Date.now()) : null) ?? manageSummary;
  const manageInputKey = `${units}:${manageSummary?.side}:${manageSummary?.stop}:${manageSummary?.target}`;
  const [manageInput, setManageInput] = useState<{ key: string; stopLoss: number | null; takeProfit: number | null } | null>(null);
  const shownManageInput = manageInput && manageInput.key === manageInputKey ? manageInput : null;
  /** Zadané číslo jedné nohy (v jednotkách panelu); jiný klíč (jednotky, SL/TP pozice) = začít znovu. */
  const withManageInput = (current: typeof manageInput, leg: LiveManageLeg, value: number | null) => {
    const base = current && current.key === manageInputKey ? current : { key: manageInputKey, stopLoss: null, takeProfit: null };
    return leg === 'stopLoss' ? { ...base, stopLoss: value } : { ...base, takeProfit: value };
  };
  const [plusTicks, setPlusTicks] = useState(2);
  const [manageNotice, setManageNotice] = useState<LiveManageNotice | null>(null);
  useEffect(() => {
    if (!manageNotice) return undefined;
    const timer = window.setTimeout(() => setManageNotice(null), 8_000);
    return () => window.clearTimeout(timer);
  }, [manageNotice]);
  const manageDisplay = (leg: LiveManageLeg): number | null => {
    const typed = shownManageInput ? shownManageInput[leg] : null;
    if (typed != null) return typed;
    if (!manageSummary) return null;
    return manageDisplayValue({
      side: manageSummary.side, leg, units, price: leg === 'stopLoss' ? manageSummary.stop : manageSummary.target,
      entryAvg: manageBasis.entryAvg, quantity: manageBasis.quantity, pointValue: instrument.pointValue, tick,
    });
  };
  /** Plán posunu zadaným číslem; jedním klikem jako tah čáry. */
  const manageMovePlan = (summary: LiveChartPositionSummary | null, leg: LiveManageLeg): LiveManagePlan => {
    const value = shownManageInput ? shownManageInput[leg] : null;
    if (value == null) return { ok: false, reason: `Zadej nový ${leg === 'stopLoss' ? 'SL' : 'TP'} a potvrď Enterem.`, price: null };
    if (!summary) return { ok: false, reason: 'Pozice leadera není známá.', price: null };
    const converted = managePriceFromInput({
      side: summary.side, leg, units, value, entryAvg: manageBasis.entryAvg, quantity: manageBasis.quantity, pointValue: instrument.pointValue, tick,
    });
    if ('blocked' in converted) return { ok: false, reason: converted.blocked, price: null };
    return planManageMove(summary, leg, converted.price, { tick, pendingLegs: managePendingLegs === true });
  };
  const requestManage = (intent: LiveManageIntent, onSent?: () => void) => {
    if (!manageRunner) return;
    const step = manageRunner.request(intent);
    if ('outcome' in step) {
      onSent?.();
      void step.outcome.then(outcome => setManageNotice(outcome.notice));
    }
  };
  const moveLeg = (leg: LiveManageLeg) => {
    const at = Date.now();
    const plan = manageMovePlan(guardNow(), leg);
    if ('reason' in plan) { setManageNotice({ tone: 'bad', text: plan.reason, at }); return; }
    // Odejde jen cena z tlačítka: změna průměru nebo zadání těsně před klikem = nic, uživatel vidí novou cenu.
    const step = liveMoveClick(moveGates[leg], leg, moveShownPrices[leg], plan.intent.newPrice);
    if (step.kind === 'changed') { setManageNotice({ tone: 'warn', text: LIVE_ACTION_CHANGED_TEXT, at }); return; }
    if (step.kind !== 'send') return;
    requestManage(plan.intent, () => setManageInput(current => withManageInput(current, leg, null)));
  };
  const runBreakEven = (variant: LiveManageBreakEvenVariant) => {
    const plan = planBreakEven(guardNow(), manageBasis, variant);
    if ('reason' in plan) { setManageNotice({ tone: 'bad', text: plan.reason, at: Date.now() }); return; }
    requestManage(plan.intent);
  };
  const manageButton = (plan: LiveManagePlan, idle: string): ManageButtonView => {
    const busy = manageRunner?.busy === true;
    if ('reason' in plan) return { label: idle, disabled: true, title: plan.reason };
    return {
      label: idle,
      disabled: busy,
      title: busy ? 'Čeká se na výsledek předchozí změny — zavřít jde hned Flattenem.' : plan.intent.label,
    };
  };
  const guardRender = manageOn ? guardNow() : null;
  const manageOffers = manageOn ? liveManageBreakEvenOffers(guardRender, manageBasis, plusTicks) : null;
  const priceOf = (plan: LiveManagePlan | null) => (plan ? ('intent' in plan ? plan.intent.newPrice : plan.price) : null);
  // „Posunout“ ukazuje absolutní cenu, která odejde (INV-UI-03/04) — i když se zadává v bodech, ticích nebo $.
  const movePlans = manageOn ? { stopLoss: manageMovePlan(guardRender, 'stopLoss'), takeProfit: manageMovePlan(guardRender, 'takeProfit') } : null;
  const moveShownPrices: Record<LiveManageLeg, number | null> = {
    stopLoss: movePlans && 'intent' in movePlans.stopLoss ? movePlans.stopLoss.intent.newPrice : null,
    takeProfit: movePlans && 'intent' in movePlans.takeProfit ? movePlans.takeProfit.intent.newPrice : null,
  };
  const moveTarget = (leg: LiveManageLeg) => {
    const price = moveShownPrices[leg];
    return price == null ? null : { key: liveMoveKey(leg, price), enabled: true };
  };
  const moveGates: Record<LiveManageLeg, LiveClickGate> = {
    stopLoss: useLiveClickGate([moveTarget('stopLoss')]),
    takeProfit: useLiveClickGate([moveTarget('takeProfit')]),
  };
  const moveLabel = (plan: LiveManagePlan) => ('intent' in plan ? `Posunout → ${formatPrice(plan.intent.newPrice)}` : 'Posunout');
  const manageView = manageOn && manageOffers && movePlans ? {
    move: {
      stopLoss: manageButton(movePlans.stopLoss, moveLabel(movePlans.stopLoss)),
      takeProfit: manageButton(movePlans.takeProfit, moveLabel(movePlans.takeProfit)),
    },
    breakEven: {
      be: manageButton(manageOffers.be, `BE${priceOf(manageOffers.be) != null ? ` · ${formatPrice(priceOf(manageOffers.be)!)}` : ''}`),
      plus: manageButton(manageOffers.plus, 'BE +'),
      // Poplatky jsou odhad z poslední sazby brokera (posledních fillů) × kusy, ne skutečné poplatky pozice.
      fees: manageOffers.fees ? manageButton(manageOffers.fees, `BE + odhad poplatků${priceOf(manageOffers.fees) != null ? ` · ${formatPrice(priceOf(manageOffers.fees)!)}` : ''}`) : null,
    },
    plusPrice: priceOf(manageOffers.plus),
  } : null;

  const headerTitle = 'Objednávka';
  const pickerText = !group
    ? 'Skupina (leader → followeři)'
    : single && picked
      ? `Jen ${picked.name}`
      : group.armed === false ? `Skupina · ${group.leader.name} (kopírka vypnutá)` : `Skupina · ${group.leader.name} → ${participatingFollowers(group).length}`;
  const sampleTag = <span className="rounded bg-amber-500/20 px-1.5 py-px text-[9px] font-black uppercase tracking-[0.06em] text-amber-600">ukázka</span>;
  const quoteAge = quoteInfo.capturedAt != null ? Math.max(0, Math.round((Date.now() - quoteInfo.capturedAt) / 1000)) : null;

  const dayValue = (account: LiveTradeAccount) => (account.dayPnl.value == null
    ? <span className={`font-mono text-[9.5px] ${tone.muted}`} title="Dnešní výsledek neznámý">—</span>
    : <span
      className={`font-mono text-[9.5px] font-semibold ${account.dayPnl.stale ? 'opacity-55' : ''} ${account.dayPnl.value < 0 ? 'text-rose-500' : 'text-emerald-500'}`}
      title={account.dayPnl.stale ? 'Poslední známá hodnota, ne čerstvá' : undefined}
    >{formatUsd(account.dayPnl.value)}</span>);
  const accountTag = (account: LiveTradeAccount) => {
    const text = account.role === 'leader' ? 'leader' : account.role === 'outside' ? 'mimo skupinu' : account.excluded ? 'vyřazen' : account.inactiveReason ? 'nekopíruje' : 've skupině';
    const accent = account.role === 'outside' || account.excluded;
    return <em className={`rounded border px-1 text-[7.5px] font-black not-italic uppercase leading-[13px] tracking-[0.07em] ${accent ? 'border-violet-500/45 text-violet-500' : `${tone.line} ${tone.muted}`}`}>{text}</em>;
  };
  const pickerMenu = pickerOpen && group ? (
    <div role="menu" className={`absolute left-0 right-0 top-[calc(100%+4px)] z-30 grid max-h-[60vh] overflow-auto rounded-xl p-[3px] ${chartGlassMenu(isDark)}`}>
      <div className={`px-2 pb-0.5 pt-1.5 ${label} !text-[8px]`}>Skupina</div>
      <button
        type="button"
        role="menuitemradio"
        aria-checked={!single}
        title={group.armed === false ? 'Kopírka vypnutá — půjde jen na leadera' : 'Příkaz na leadera, kopírka ho rozkopíruje'}
        onClick={() => { onTarget(GROUP_TARGET); setPickerOpen(false); }}
        className={`flex h-[26px] items-center justify-between gap-2 rounded-[7px] px-2 text-left ${!single ? tone.segOn : isDark ? 'hover:bg-white/[0.08]' : 'hover:bg-white/70'}`}
      ><b className="truncate text-[10.5px] font-extrabold">{group.leader.name} → {participatingFollowers(group).length} followeři</b>{dayValue(group.leader)}</button>
      <div className={`px-2 pb-0.5 pt-1.5 ${label} !text-[8px]`}>Jen jeden účet</div>
      {allTradeAccounts(group).map(account => {
        const reason = soloTradeBlockReason(account, group.armed);
        const on = single && target.kind === 'account' && target.accountId === account.id;
        const tip = reason ?? (account.role === 'leader'
          ? 'Kopírka vypnutá — obchod jde jen na leadera, kopírka si ho jen zapíše'
          : account.role === 'outside' ? 'Samostatný účet, kopírka ho nezná'
            : account.excluded ? 'Vyřazený z kopírování — nic se nekopíruje' : 'Kopírka vypnutá — účet jde obchodovat samostatně');
        return <button
          key={account.id}
          type="button"
          role="menuitemradio"
          aria-checked={on}
          disabled={reason != null}
          title={tip}
          onClick={() => { onTarget({ kind: 'account', accountId: account.id }); setPickerOpen(false); }}
          className={`flex h-[26px] items-center justify-between gap-2 rounded-[7px] px-2 text-left disabled:cursor-not-allowed ${on ? tone.segOn : isDark ? 'enabled:hover:bg-white/[0.08]' : 'enabled:hover:bg-white/70'}`}
        >
          <b className={`flex min-w-0 items-center gap-1.5 truncate text-[10.5px] font-extrabold ${reason ? 'opacity-45' : ''}`}>{account.name}{accountTag(account)}</b>
          <span className={reason ? 'opacity-45' : ''}>{dayValue(account)}</span>
        </button>;
      })}
      <div className={`mt-1 border-t px-2 pb-1 pt-1.5 text-[9px] leading-snug ${tone.line} ${tone.muted}`}>
        {group.sample && <div className="mb-1 font-bold text-amber-600">Účty jsou ukázka; stav kopírky je skutečný.</div>}
        {group.armed === false
          ? 'Kopírka vypnutá — každý účet jde obchodovat samostatně. Než ji zapneš, musí být skupina flat.'
          : group.armed == null
            ? 'Stav kopírky není ověřený — počítám se zapnutou, účty ve skupině jsou šedé.'
            : 'Šedé = účet ve skupině při zapnuté kopírce. Ruční pozice by se lišila od leadera a kopírka by zastavila celou skupinu — vypni ji, nebo účet vyřaď na LIVE.'}
      </div>
    </div>
  ) : null;

  const accountRows = () => {
    if (!group) return null;
    const accounts = [group.leader, ...group.followers];
    let total = 0;
    const rows = accounts.map(account => {
      const gets = account.role === 'leader' || (group.armed !== false && followerInCopy(account));
      // Kopírka bere násobek dolů (floor) — stejně jako `copierEngine.followerQuantity`.
      const qty = m && gets ? (account.role === 'leader' ? m.quantity : Math.floor(m.quantity * account.multiplier)) : null;
      const value = m?.stopLossUsd != null && gets && qty != null && m.quantity > 0 ? m.stopLossUsd * (qty / m.quantity) : null;
      if (value != null) total += value;
      const status = account.role === 'leader' ? 'bg-blue-500' : account.excluded || group.armed === false ? 'bg-slate-400' : 'bg-emerald-500';
      return <div key={account.id} className="grid grid-cols-[8px_minmax(0,1fr)_auto_72px] items-center gap-1.5 py-[3px] text-[10.5px]">
        <i className={`h-[7px] w-[7px] rounded-full ${status}`} />
        <span className={`truncate font-bold ${tone.muted}`}>{account.name}</span>
        <span className={`font-mono text-[10px] ${tone.muted}`}>{account.excluded ? 'vyřazen' : account.inactiveReason ? 'nekopíruje' : qty != null ? `${qty} ks` : '—'}</span>
        <b className={`text-right font-mono text-[10.5px] ${value == null ? tone.muted : value < 0 ? 'text-rose-500' : 'text-emerald-500'}`}>{formatUsd(value)}</b>
      </div>;
    });
    return <div className="grid">
      <div className={`grid grid-cols-[8px_minmax(0,1fr)_auto_72px] gap-1.5 pb-0.5 ${label} !text-[8.5px]`}><span /><span>Účet</span><span>Kontrakty</span><span className="text-right">Stop loss</span></div>
      {rows}
      <div className={`mt-0.5 grid grid-cols-[8px_minmax(0,1fr)_auto_72px] gap-1.5 border-t pt-1.5 text-[10.5px] ${tone.line}`}>
        <span /><span className={`font-black ${tone.ink}`}>Celkem</span><span />
        <b className={`text-right font-mono ${total < 0 ? 'text-rose-500' : 'text-emerald-500'}`}>{formatUsd(total)}</b>
      </div>
    </div>;
  };

  return <div className={`flex h-full min-h-0 flex-col gap-2.5 overflow-hidden border-l p-2.5 ${tone.dock} ${single ? '!border-violet-500/60' : ''}`}>
    <div className="flex items-center gap-1.5">
      <h3 className={`m-0 flex-1 truncate text-[12.5px] font-black ${tone.ink}`}>
        {headerTitle}<small className={`ml-1.5 font-bold ${tone.muted}`}>{instrument.symbol}</small>
        {fromBox && <span className="ml-1.5 rounded border border-blue-500/45 px-1 align-[1px] text-[8.5px] font-black uppercase tracking-[0.06em] text-blue-500">z position boxu</span>}
        {scaleIn && <span className="ml-1.5 rounded border border-emerald-500/45 px-1 align-[1px] text-[8.5px] font-black uppercase tracking-[0.06em] text-emerald-500">přikoupení · SL/TP pozice</span>}
      </h3>
      <button type="button" onClick={onClose} title="Skrýt panel" aria-label="Skrýt panel objednávky" className={`flex h-7 w-7 items-center justify-center rounded-lg ${isDark ? 'text-slate-400 hover:bg-white/[0.08] hover:text-white' : 'text-slate-500 hover:bg-white/70 hover:text-slate-900'}`}><X size={14} /></button>
    </div>

    <div ref={pickerRef} className="relative shrink-0">
      <button
        type="button"
        disabled={!group}
        title={group ? undefined : 'Výběr jednoho účtu přijde s napojením na stav workeru'}
        onClick={() => setPickerOpen(open => !open)}
        aria-haspopup="menu"
        aria-expanded={pickerOpen}
        className={`flex h-[40px] w-full items-center gap-2 rounded-[9px] border px-2.5 text-left ${single ? 'border-violet-500/60 bg-violet-500/10' : tone.field}`}
      >
        <span className="grid min-w-0 flex-1 leading-tight">
          <small className={`${label} flex items-center gap-1.5`}>Obchodovat na{group?.sample && sampleTag}</small>
          <b className={`truncate text-[11.5px] font-extrabold ${single ? 'text-violet-500' : tone.ink}`}>{pickerText}</b>
        </span>
        {group && <ChevronDown size={12} className={tone.muted} />}
      </button>
      {pickerMenu}
    </div>

    <div className="live-ticket-stagger -mx-2.5 flex min-h-0 flex-1 flex-col gap-2.5 overflow-auto px-2.5 pb-0.5">
      {position?.summary && <PositionCard isDark={isDark} summary={position.summary} muted={tone.muted} ink={tone.ink} field={tone.field} />}
      {attachEntry && attachSide && <AttachSection
        muted={tone.muted}
        field={tone.field}
        ink={tone.ink}
        side={attachSide}
        quantity={attachQuantity}
        units={units}
        legs={shownLegs}
        reference={attachReference}
        market={attachMarket}
        problem={attachProblem}
        sendBlocked={attachSendBlocked}
        busy={attachBusy}
        notice={shownAttachNotice?.notice ?? null}
        displayValue={attachDisplay}
        onCommit={commitAttach}
        onSend={() => void sendAttach()}
        close={bareCloseInAttach ? bareCloseView : null}
      />}
      {/* Holá pozice bez (téže) sekce „Přidat SL/TP“ — worker attach nenabízí: × zavřít samostatně. */}
      {!bareCloseInAttach && bareCloseView}
      {manageView && <ManageSection
        muted={tone.muted}
        field={tone.field}
        ink={tone.ink}
        line={tone.line}
        units={units}
        displayValue={manageDisplay}
        onCommit={(leg, value) => setManageInput(current => withManageInput(current, leg, value))}
        move={manageView.move}
        onMove={moveLeg}
        breakEven={manageView.breakEven}
        onBreakEven={runBreakEven}
        plusTicks={plusTicks}
        plusPrice={manageView.plusPrice}
        onPlusTicks={setPlusTicks}
        notice={manageNotice}
      />}
      {position?.issue &&<div className={`rounded-[9px] border px-2.5 py-2 text-[10.5px] font-bold ${tone.field} ${tone.muted}`}>{position.issue}</div>}
      {!quote ? (
        <p className={`m-0 py-6 text-center text-[11px] ${tone.muted}`}>Čekám na cenu z grafu…</p>
      ) : <>
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-1.5">
          {(['sell', 'buy'] as const).map((side, index) => {
            const on = draft?.side === side;
            const color = side === 'sell' ? 'rose' : 'blue';
            const tile = <button
              key={side}
              type="button"
              onClick={() => (draft ? onDraft(withSide(draft, side, quote, instrument)) : onNewDraft(side))}
              className={`live-ticket-side ${on ? 'is-on' : ''} grid h-[52px] content-center rounded-[10px] border px-2.5 ${quoteInfo.stale ? 'opacity-60' : ''} ${side === 'buy' ? 'justify-items-end text-right' : 'justify-items-start text-left'} ${on
                ? color === 'rose' ? 'border-rose-500/60 bg-rose-500/[0.14] text-rose-500' : 'border-blue-500/60 bg-blue-500/[0.14] text-blue-500'
                : `${tone.field} ${tone.ink}`}`}
            >
              <small className={`text-[9px] font-black uppercase tracking-[0.08em] ${on ? '' : tone.muted}`}>{side === 'sell' ? 'Prodat' : 'Koupit'}</small>
              <b className="font-mono text-[14px] font-bold">{formatPrice(side === 'sell' ? quote.bid : quote.ask)}</b>
            </button>;
            return index === 0
              ? <React.Fragment key={side}>{tile}<span className={`font-mono text-[9.5px] ${tone.muted}`} title="Rozpětí — orientačně z poslední ceny grafu">{(quote.ask - quote.bid).toFixed(2)}</span></React.Fragment>
              : tile;
          })}
        </div>
        <div className={`-mt-1.5 text-center text-[9.5px] ${quoteInfo.stale ? 'font-bold text-amber-600' : tone.muted}`} title="Orientačně z poslední svíčky grafu, ne kotace brokera. Typ, počet kontraktů i cenu Market před odesláním přepočítá kotace brokera.">
          {quoteInfo.stale ? 'Cena z grafu je stará — ' : 'Orientačně z grafu · '}{quoteInfo.source ?? 'zdroj neznámý'}{quoteAge != null ? ` · před ${quoteAge} s` : ''}
        </div>

        {formDraft && formMetrics ? <div className={draft ? 'contents' : 'pointer-events-none flex select-none flex-col gap-2.5 opacity-45'} inert={!draft} aria-hidden={!draft || undefined}>{((draft: TicketDraft, m: NonNullable<typeof formMetrics>) => <>
          <div className={`flex h-[30px] rounded-[9px] border p-0.5 ${tone.seg}`}>
            {(['market', 'limit', 'stop'] as const).map(type => <button key={type} type="button" onClick={() => setType(type)} className={seg(draft.type === type)}>{TYPE_LABEL[type]}</button>)}
          </div>

          <div className="grid gap-1">
            <div className="flex items-center justify-between">
              <span className={label}>Cena</span>
              <span className={`text-[10px] ${tone.muted}`}>{draft.type === 'market'
                ? 'Vyplní se za aktuální cenu'
                : <><b className={`font-mono ${tone.ink}`}>{formatPoints(draft.price - marketPrice(draft.side, quote))}</b> {draft.price < marketPrice(draft.side, quote) ? 'pod' : 'nad'} trhem</>}</span>
            </div>
            <div className={`flex h-[34px] items-center rounded-[9px] border ${tone.field}`}>
              <button type="button" disabled={draft.type === 'market'} onClick={() => onDraft(withEntryPrice(draft, draft.price - instrument.tickSize, instrument, true))} className={`h-full w-8 text-[15px] disabled:opacity-30 ${tone.muted}`}>−</button>
              {draft.type === 'market'
                ? <span className={`flex-1 text-center font-mono text-[13px] ${tone.muted}`}>Market</span>
                : <NumberField ariaLabel="Cena" value={draft.price} format={value => value.toFixed(2)} onCommit={value => onDraft(withEntryPrice(draft, value, instrument, true))} className={`min-w-0 flex-1 bg-transparent text-center font-mono text-[13px] outline-none ${tone.ink}`} />}
              <button type="button" disabled={draft.type === 'market'} onClick={() => onDraft(withEntryPrice(draft, draft.price + instrument.tickSize, instrument, true))} className={`h-full w-8 text-[15px] disabled:opacity-30 ${tone.muted}`}>+</button>
            </div>
          </div>

          <div className="grid gap-1">
            <div className="flex items-center justify-between">
              <span className={label}>Množství</span>
              <div className={`flex h-[24px] w-[150px] rounded-[8px] border p-0.5 ${tone.seg}`}>
                <button type="button" onClick={() => pickSize({ ...draft, sizing: 'qty', quantity: Math.max(1, m.quantity || draft.quantity) })} className={seg(draft.sizing === 'qty')}>Kontrakty</button>
                <button type="button" onClick={() => pickSize(draft.stopLoss == null ? withBracket({ ...draft, sizing: 'risk' }, 'sl', instrument, quote) : { ...draft, sizing: 'risk' })} className={seg(draft.sizing === 'risk')}>Riziko $</button>
              </div>
            </div>
            <div className={`flex h-[34px] items-center rounded-[9px] border ${tone.field}`}>
              <button type="button" onClick={() => stepQuantity(-1)} className={`h-full w-8 text-[15px] ${tone.muted}`}>−</button>
              <NumberField
                ariaLabel={draft.sizing === 'risk' ? 'Riziko v dolarech' : 'Počet kontraktů'}
                value={draft.sizing === 'risk' ? draft.riskUsd : draft.quantity}
                format={value => String(Math.round(value))}
                onCommit={value => pickSize(draft.sizing === 'risk' ? { ...draft, riskUsd: Math.max(0, value) } : { ...draft, quantity: Math.max(1, Math.round(value)) })}
                className={`min-w-0 flex-1 bg-transparent text-center font-mono text-[13px] outline-none ${tone.ink}`}
              />
              <span className={`pr-1 text-[10px] font-bold ${tone.muted}`}>{draft.sizing === 'risk' ? '$' : instrument.symbol}</span>
              <button type="button" onClick={() => stepQuantity(1)} className={`h-full w-8 text-[15px] ${tone.muted}`}>+</button>
            </div>
            {/* Předvolby qty (U4): jen do stropu ručního vstupu skupiny; jen vyplní pole. */}
            {draft.sizing === 'qty' && qtyPresets.length > 1 && <div className="flex gap-1" role="group" aria-label="Rychlá volba počtu kontraktů">
              {qtyPresets.map(qty => <button
                key={qty}
                type="button"
                aria-pressed={draft.quantity === qty}
                onClick={() => pickSize({ ...draft, sizing: 'qty', quantity: qty })}
                className={`h-[22px] flex-1 rounded-[7px] border font-mono text-[10.5px] font-bold ${draft.quantity === qty ? `${tone.segOn} border-transparent` : `${tone.field} ${tone.muted}`}`}
              >{qty}</button>)}
            </div>}
            {draft.sizing === 'risk' && <div className={`text-[10.5px] ${tone.muted}`}>→ <b className={`font-mono ${tone.ink}`}>{m.quantity}</b> kontraktů · skutečné riziko <b className={`font-mono ${tone.ink}`}>{formatUsd(m.stopLossUsd)}</b></div>}
          </div>

          <div className="grid gap-1.5">
            <div className="flex items-center justify-between">
              <span className={label}>Závorky</span>
              <div className={`flex h-[24px] w-[170px] rounded-[8px] border p-0.5 ${tone.seg}`}>
                {(['pts', 'ticks', 'usd', 'price'] as const).map(unit => <button key={unit} type="button" onClick={() => pickUnits(unit)} className={seg(units === unit)}>{UNIT_LABEL[unit]}</button>)}
              </div>
            </div>
            <TemplateBar
              isDark={isDark}
              muted={tone.muted}
              field={tone.field}
              line={tone.line}
              choices={templateChoices}
              market={draft.type === 'market'}
              applyBlocked={templateApplyBlocked}
              saveBlocked={templateSaveBlocked}
              onApply={applyTemplate}
              onDefault={id => storeNotice(setDefaultLiveBracketTemplateId(userId, id), id && id !== LIVE_BUILTIN_BRACKET_TEMPLATE.id ? 'Výchozí šablona nastavena (★).' : 'Výchozí je vestavěná 12 b / 2R.')}
              onDelete={deleteTemplate}
              deleteAsking={templateDeleteAsking}
              onSave={saveTemplate}
              notice={templateNotice}
            />
            <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 gap-y-1.5">
              {(['tp', 'sl'] as const).map(which => {
                const on = (which === 'sl' ? draft.stopLoss : draft.takeProfit) != null;
                const color = which === 'sl' ? 'text-rose-500' : 'text-emerald-500';
                const box = which === 'sl' ? 'border-rose-500 bg-rose-500' : 'border-emerald-500 bg-emerald-500';
                return <React.Fragment key={which}>
                  <button type="button" onClick={() => toggleBracket(which)} className={`inline-flex items-center gap-1.5 whitespace-nowrap text-[11px] font-extrabold ${color}`}>
                    <i className={`grid h-[15px] w-[15px] place-items-center rounded-[4px] border-[1.5px] text-[10px] not-italic text-white ${on ? box : tone.field}`}>{on ? '✓' : ''}</i>
                    {which === 'tp' ? 'Take profit' : 'Stop loss'}
                  </button>
                  <div className={`flex h-[30px] items-center rounded-[9px] border ${tone.field} ${on ? '' : 'opacity-50'}`}>
                    <NumberField
                      ariaLabel={which === 'tp' ? 'Take profit' : 'Stop loss'}
                      disabled={!on}
                      value={bracketDisplayValue(draft, which, units, instrument, quote)}
                      format={value => (units === 'ticks' ? String(Math.round(value)) : value.toFixed(2))}
                      onCommit={value => commitBracket(which, value)}
                      className={`min-w-0 flex-1 bg-transparent px-2 text-center font-mono text-[13px] outline-none ${tone.ink}`}
                    />
                    <span className={`pr-2 text-[10px] font-bold ${tone.muted}`}>{UNIT_SUFFIX[units]}</span>
                  </div>
                </React.Fragment>;
              })}
            </div>
          </div>

          <div className={`grid gap-1.5 rounded-[10px] border px-2.5 py-2 ${tone.field}`}>
            {!single && group && <div className={`flex h-[24px] rounded-[8px] border p-0.5 ${tone.seg}`}>
              <button type="button" onClick={() => onScope('account')} className={seg(scope === 'account')}>Na účet</button>
              <button type="button" onClick={() => onScope('group')} className={seg(scope === 'group')}>Skupina ×{groupMultiplier}</button>
              <button type="button" onClick={() => onScope('each')} className={seg(scope === 'each')}>Po účtech</button>
            </div>}
            {!single && scope === 'each' ? accountRows() : <>
              <div className={`flex items-baseline justify-between text-[11px] ${tone.muted}`}><span>Stop loss</span><b className="font-mono text-[12px] text-rose-500">{formatUsd(m.stopLossUsd == null ? null : m.stopLossUsd * multiplier)}</b></div>
              <div className={`flex items-baseline justify-between text-[11px] ${tone.muted}`}><span>Take profit</span><b className="font-mono text-[12px] text-emerald-500">{formatUsd(m.takeProfitUsd == null ? null : m.takeProfitUsd * multiplier)}</b></div>
            </>}
            <div className={`flex items-baseline justify-between text-[11px] ${tone.muted}`}><span>Poměr R:R</span><b className={`font-mono text-[12px] ${tone.ink}`}>{m.riskReward != null ? `1 : ${m.riskReward.toFixed(2)}` : '—'}</b></div>
            {group?.sample && !single && scope !== 'account' && <div className="text-[9.5px] font-bold text-amber-600">Účty jsou ukázka — napojení na worker přijde zvlášť.</div>}
          </div>
        </>)(formDraft, formMetrics)}</div> : null}
      </>}
    </div>

    {draft && m && quote && <div className={`grid shrink-0 gap-1.5 border-t pt-2 ${tone.line}`}>
      {onPreviewEntry && <PreviewSection
        isDark={isDark}
        muted={tone.muted}
        field={tone.field}
        previewDraft={previewDraft}
        resetKey={String(group?.armed)}
        blockedReason={previewBlockedReason}
        pointValue={instrument.pointValue}
        onPreview={onPreviewEntry}
        // Holý Market (bez SL/TP) nikdy přes Náhled → Odeslat: jen velké tlačítko (sendDirect,
        // brána při kliku). Oponentura vlny B, P2.
        {...(placeEntryLocked && !bareDraft ? { onPlace: placeEntryLocked } : {})}
        onAcknowledged={() => onDraft(null)}
      />}
      {problems.length > 0 && <div className="grid gap-1">
        {problems.map(problem => <div key={problem.text} className={`rounded-[7px] px-2 py-1.5 text-[10.5px] font-bold ${problem.level === 'error' ? 'bg-rose-500/10 text-rose-500' : 'bg-amber-500/10 text-amber-600'}`}>{problem.text}</div>)}
      </div>}
      <button
        type="button"
        disabled={directBlocked != null || directBusy || directLocked}
        title={directBlocked ?? (directLocked ? 'Výsledek minulého odeslání není známý — zkontroluj leadera v Tradovate. Odeslat jde až po změně návrhu.' : undefined) ?? 'Odešle hned — worker znovu ověří všechny pojistky a při problému nic nepošle.'}
        // Fokus nesmí zůstat na tlačítku: Enter / mezerník by jinak po zkratce (Shift+B/S) poslal
        // nový návrh bez myši — žádná klávesa neodešle vstup (oponentura vlny B).
        onClick={event => { event.currentTarget.blur(); void sendDirect(); }}
        className={`live-ticket-send ${directBusy ? 'is-sending' : ''} grid h-[44px] content-center rounded-[8px] text-[12px] font-extrabold leading-tight text-white disabled:cursor-not-allowed disabled:opacity-60`}
        style={{ background: `linear-gradient(180deg, color-mix(in srgb, ${sideColor} 82%, #fff), ${sideColor})`, boxShadow: `0 10px 22px -12px ${sideColor}` }}
      >
        <span className="inline-flex items-center justify-center gap-1.5">{directBlocked != null && <Lock size={11} />}{directBusy ? <><span className="live-ticket-spinner" aria-hidden="true" />Odesílám…</> : bareSend
          ? liveBareMarketButtonLabel(draft.side, m.quantity)
          : `${draft.side === 'buy' ? 'Koupit' : 'Prodat'} ${m.quantity} ${instrument.symbol}`}</span>
        <small className="font-mono text-[10px] font-semibold opacity-85">
          {draft.type === 'market' ? `MKT · ~${marketReference != null ? formatPrice(marketReference) : '—'}` : `${draft.type === 'stop' ? 'STP' : 'LMT'} @ ${formatPrice(draft.price)}`}{previewSymbol ? ` · ${previewSymbol}` : ''}
          {' · '}{single && picked ? `jen ${picked.short}` : group?.armed === false ? 'jen leader' : group ? `skupina ×${groupMultiplier}` : 'leader + kopírka'}
          {limitIsMarketable(draft, quote) ? ' · hned' : ''}
          {bareSend ? ' · BEZ SL/TP' : ''}
        </small>
      </button>
      {bareSend && <div className={`text-[10px] font-bold ${tone.muted}`}>
        Market bez SL/TP: odešle se hned, ztráta nemá strop. SL a TP pak doplníš „Přidat SL/TP“.
      </div>}
      {shownDirect &&<div className={`rounded-[7px] px-2 py-1.5 text-[10.5px] font-bold ${shownDirect.view.tone === 'ok' ? 'bg-emerald-500/10 text-emerald-600' : shownDirect.view.tone === 'bad' ? 'bg-rose-500/10 text-rose-500' : 'bg-amber-500/10 text-amber-600'}`}>{shownDirect.view.text}</div>}
    </div>}
    {!draft && !sentFlash && quote && <div className={`grid shrink-0 gap-1.5 border-t pt-2 ${tone.line}`}>
      <div className={`grid h-[44px] place-items-center rounded-[8px] border border-dashed text-[11.5px] font-bold ${tone.field} ${tone.muted}`}>
        Vyber Koupit nebo Prodat
      </div>
    </div>}
    {!draft && sentFlash && <div className={`grid shrink-0 gap-1.5 border-t pt-2 ${tone.line}`}>
      <div role="status" className="live-ticket-send is-ok grid h-[44px] place-items-center rounded-[8px] text-[12px] font-extrabold text-white">
        <span className="live-ticket-ring" aria-hidden="true" />
        <span className="inline-flex items-center gap-2">
          <svg className="live-ticket-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5 10 17.5 19 7" /></svg>
          Přijato · {sentFlash.text}
        </span>
      </div>
    </div>}
  </div>;
};

export default LiveOrderTicket;
