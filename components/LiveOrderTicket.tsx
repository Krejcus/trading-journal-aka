import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Lock, X } from 'lucide-react';
import {
  bracketDisplayValue,
  bracketPriceFromInput,
  limitIsMarketable,
  marketPrice,
  snapToTick,
  ticketMetrics,
  ticketProblems,
  withBracket,
  withEntryPrice,
  withSide,
  type TicketBracket,
  type TicketBracketUnits,
  type TicketDraft,
  type TicketInstrument,
  type TicketOrderType,
  type TicketQuote,
  type TicketSide,
} from '../lib/liveOrderTicket';
import type { LiveChartPosition, LiveChartPositionSummary } from '../lib/liveChartPosition';
import { previewSymbolFromChartSource, type LeaderEntryPreviewResult, type LiveEntryPreviewDraft } from '../lib/leaderEntryPreview';
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
 * z ceny grafu. BE a Zavřít pozici zatím nic nedělají — odesílání příkazů
 * je samostatný krok přes jádro kopírky.
 */
const PositionCard: React.FC<{ isDark: boolean; summary: LiveChartPositionSummary; muted: string; ink: string; field: string }> = ({ isDark, summary, muted, ink, field }) => {
  const long = summary.side === 'long';
  const price = (value: number | null) => (value == null ? '—' : formatPrice(value));
  return <div className={`grid gap-1.5 rounded-[11px] border p-2.5 ${field}`}>
    <div className="flex items-baseline gap-2">
      <b className={`text-[11px] font-black uppercase tracking-[0.06em] ${long ? 'text-blue-500' : 'text-rose-500'}`}>
        {summary.kind === 'position' ? `${long ? 'Long' : 'Short'} ${summary.quantity}` : `Čeká ${long ? 'BUY' : 'SELL'} ${summary.entryType ?? ''} ${summary.quantity}`}
      </b>
      <span className={`font-mono text-[10.5px] ${muted}`}>@ {price(summary.entry)}</span>
      <span className="flex-1" />
      {summary.scopeLabel
        ? <span className="rounded border border-violet-500/45 px-1 text-[9px] font-black text-violet-500" title="Kopírka je vypnutá — souhrn jen tohoto účtu, ne celé skupiny">{summary.scopeLabel}</span>
        : summary.accounts > 1 && <span className={`text-[9.5px] font-bold ${muted}`}>{summary.accounts} účty</span>}
    </div>
    {summary.kind === 'position' && <div className="flex items-baseline gap-2">
      <b className={`font-mono text-[22px] font-black leading-none ${summary.openPnl == null ? muted : summary.openPnl < 0 ? 'text-rose-500' : 'text-emerald-500'}`}>{formatUsd(summary.openPnl)}</b>
      <span className={`text-[9.5px] font-bold ${muted}`} title="Otevřené P&L z brokera (ne z ceny grafu)">z brokera</span>
    </div>}
    <div className={`flex gap-3 font-mono text-[10px] ${ink}`}>
      <span>SL {price(summary.stop)}</span><span>TP {price(summary.target)}</span>
      <span className={`flex-1 text-right font-sans font-bold ${muted}`}>{summary.protection}</span>
    </div>
    {summary.kind === 'position' && <div className="grid grid-cols-2 gap-1.5">
      {['SL na BE', 'Zavřít pozici'].map(text => <button
        key={text}
        type="button"
        disabled
        title="Zatím bez akce — odesílání příkazů přijde jako samostatný krok"
        className={`flex h-8 items-center justify-center gap-1 rounded-lg border text-[10.5px] font-extrabold opacity-50 ${isDark ? 'border-white/10' : 'border-slate-900/10'}`}
      ><Lock size={10} />{text}</button>)}
    </div>}
  </div>;
};

/** Jak dlouho výsledek náhledu platí jako „aktuální“; pak zešedne. */
const PREVIEW_FRESH_MS = 15_000;

/**
 * Fáze 1a: „Zkontrolovat u workeru“ — worker projde brány a vrátí, co by
 * poslal. Nikdy nic neodešle a nikdy netvrdí „připraveno“; Odeslat zůstává
 * vypnuté. Výsledek se zahodí při změně návrhu a po 15 s zešedne.
 */
const PreviewSection: React.FC<{
  isDark: boolean; muted: string; field: string;
  previewDraft: LiveEntryPreviewDraft | null;
  /** Změna stavu kopírky (zapnutí / vypnutí) výsledek zahodí. */
  resetKey: string;
  blockedReason: string | null;
  onPreview: (draft: LiveEntryPreviewDraft) => Promise<LeaderEntryPreviewResult>;
}> = ({ isDark, muted, field, previewDraft, resetKey, blockedReason, onPreview }) => {
  const [state, setState] = useState<{ key: string; receivedAt?: number; result?: LeaderEntryPreviewResult; error?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [now, setNow] = useState(() => Date.now());
  const key = previewDraft ? `${resetKey}|${JSON.stringify(previewDraft)}` : '';
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
      setState({ key, result, receivedAt: Date.now() });
      setNow(Date.now());
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Náhled se nepodařil.';
      setState({ key, error: /preview-busy/.test(message) ? 'Náhled už běží, zkus to za 3 s.' : message });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const result = shown?.result;
  const receivedAt = shown?.receivedAt ?? now;
  const age = result ? Math.max(0, Math.round((now - receivedAt) / 1000)) : 0;
  const stale = result ? now - receivedAt > PREVIEW_FRESH_MS : false;
  const order = (entry: { side: string; quantity: number; orderType: string; price: number; stopLoss: number; takeProfit: number }) =>
    `${entry.side === 'Buy' ? 'BUY' : 'SELL'} ${entry.orderType === 'Limit' ? 'LMT' : 'STP'} ${entry.quantity} @ ${formatPrice(entry.price)} · SL ${formatPrice(entry.stopLoss)} · TP ${formatPrice(entry.takeProfit)}`;
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
    {result && <div className={`grid gap-1 rounded-[9px] border p-2 text-[10.5px] ${field} ${stale ? 'opacity-50' : ''}`}>
      <div className={`flex justify-between text-[9.5px] font-black uppercase tracking-[0.06em] ${muted}`}>
        <span>Náhled · nic se neodeslalo</span><span>{stale ? `zastaralé · před ${age} s` : `před ${age} s`}</span>
      </div>
      {result.wouldPlace ? <>
        <div className="font-bold">Worker by poslal ({result.symbol}):</div>
        <div className="font-mono text-[10px]">Leader: {order(result.wouldPlace.leader)}</div>
        {result.wouldPlace.followers.map(follower => <div key={follower.accountId} className="font-mono text-[10px]">Follower {follower.accountId}: {follower.quantity} ks</div>)}
      </> : <div className="font-bold text-rose-500">Worker by teď nic neposlal:</div>}
      {result.blockers.map(issue => <div key={issue.code + issue.text} className="text-rose-500">• {issue.text}</div>)}
      {result.notes.map(issue => <div key={issue.code + issue.text} className={muted}>· {issue.text}</div>)}
    </div>}
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
  onNewDraft: (side: TicketSide) => void;
  onClose: () => void;
}

/** Číselné pole: při psaní drží text, potvrzuje se Enterem nebo opuštěním. */
const NumberField: React.FC<{
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
  group, target, onTarget, quoteInfo, position = null, onPreviewEntry, onNewDraft, onClose,
}) => {
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
    card: isDark ? 'border-white/[0.12] bg-[#101720]/70 text-slate-200' : 'border-white/85 bg-white/70 text-slate-800',
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
  const cardShadow = isDark
    ? 'shadow-[0_22px_40px_-14px_rgba(0,0,0,0.7),inset_0_1px_0_rgba(255,255,255,0.08)]'
    : 'shadow-[0_22px_40px_-18px_rgba(15,23,42,0.4),0_0_0_1px_rgba(15,23,42,0.06),inset_0_1px_0_rgba(255,255,255,0.95)]';

  const m = draft && quote ? ticketMetrics(draft, instrument, quote) : null;
  const limits = group ? limitAccounts(group, target).map(({ account, multiplier }) => ({
    name: account.name, remainingUsd: account.dayRemaining.value, stale: account.dayRemaining.stale, multiplier,
  })) : null;
  const problems = draft && quote ? ticketProblems(draft, instrument, quote, limits) : [];
  const groupMultiplier = group ? targetMultiplier(group, target) : 1;
  // Fáze 1a: co by panel poslal workeru k náhledu (jen Limit/Stop se SL i TP, skupina).
  // Kontrakt bere náhled ze zdroje ceny grafu — v týdnu rollu nikdy odhadem.
  const previewSymbol = previewSymbolFromChartSource(quoteInfo.source);
  const previewDraft: LiveEntryPreviewDraft | null = previewSymbol && draft && m && draft.type !== 'market' && draft.stopLoss != null && draft.takeProfit != null && m.quantity >= 1
    ? { symbol: previewSymbol, side: draft.side === 'buy' ? 'Buy' : 'Sell', quantity: m.quantity, orderType: draft.type === 'limit' ? 'Limit' : 'Stop', price: draft.price, stopLoss: draft.stopLoss, takeProfit: draft.takeProfit }
    : null;
  const previewBlockedReason = !draft ? null
    : !previewSymbol ? 'Kontrakt grafu není známý (kontinuální řada) — náhled teď nejde.'
    : draft.type === 'market' ? 'Náhled jen pro Limit / Stop (Market zatím ne).'
      : draft.stopLoss == null || draft.takeProfit == null ? 'Náhled potřebuje SL i TP.'
        : single ? 'Náhled zatím jen pro skupinu (vstup na leadera).'
          : problems.some(problem => problem.level === 'error') ? 'Nejdřív oprav chyby v panelu.' : null;
  const multiplier = single || scope === 'account' ? 1 : groupMultiplier;
  const sideColor = draft?.side === 'sell' ? '#e11d48' : '#2563eb';

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
    if (current != null) onDraft(which === 'sl' ? { ...draft, stopLoss: null } : { ...draft, takeProfit: null });
    else onDraft(withBracket(draft, which, instrument, quote));
  };
  const commitBracket = (which: TicketBracket, value: number) => {
    if (!draft || !quote) return;
    const price = bracketPriceFromInput(draft, which, units, value, instrument, quote);
    if (price == null) return;
    onDraft(which === 'sl' ? { ...draft, stopLoss: price } : { ...draft, takeProfit: price });
  };
  const stepQuantity = (step: number) => {
    if (!draft) return;
    onDraft(draft.sizing === 'risk'
      ? { ...draft, riskUsd: Math.max(25, draft.riskUsd + step * 25) }
      : { ...draft, quantity: Math.max(1, draft.quantity + step) });
  };

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

  return <div className={`flex h-full min-h-0 flex-col gap-2.5 overflow-hidden rounded-2xl border p-2.5 backdrop-blur-xl ${tone.card} ${cardShadow} ${single ? '!border-violet-500/60' : ''}`}>
    <div className="flex items-center gap-1.5">
      <h3 className={`m-0 flex-1 truncate text-[12.5px] font-black ${tone.ink}`}>
        {headerTitle}<small className={`ml-1.5 font-bold ${tone.muted}`}>{instrument.symbol}</small>
        {fromBox && <span className="ml-1.5 rounded border border-blue-500/45 px-1 align-[1px] text-[8.5px] font-black uppercase tracking-[0.06em] text-blue-500">z position boxu</span>}
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

    <div className="-mx-2.5 flex min-h-0 flex-1 flex-col gap-2.5 overflow-auto px-2.5 pb-0.5">
      {position?.summary && <PositionCard isDark={isDark} summary={position.summary} muted={tone.muted} ink={tone.ink} field={tone.field} />}
      {position?.issue && <div className={`rounded-[9px] border px-2.5 py-2 text-[10.5px] font-bold ${tone.field} ${tone.muted}`}>{position.issue}</div>}
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
              className={`grid h-[52px] content-center rounded-[10px] border px-2.5 ${quoteInfo.stale ? 'opacity-60' : ''} ${side === 'buy' ? 'justify-items-end text-right' : 'justify-items-start text-left'} ${on
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

        {draft && m ? <>
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
              <button type="button" disabled={draft.type === 'market'} onClick={() => onDraft(withEntryPrice(draft, draft.price - instrument.tickSize, instrument))} className={`h-full w-8 text-[15px] disabled:opacity-30 ${tone.muted}`}>−</button>
              {draft.type === 'market'
                ? <span className={`flex-1 text-center font-mono text-[13px] ${tone.muted}`}>Market</span>
                : <NumberField ariaLabel="Cena" value={draft.price} format={value => value.toFixed(2)} onCommit={value => onDraft(withEntryPrice(draft, value, instrument))} className={`min-w-0 flex-1 bg-transparent text-center font-mono text-[13px] outline-none ${tone.ink}`} />}
              <button type="button" disabled={draft.type === 'market'} onClick={() => onDraft(withEntryPrice(draft, draft.price + instrument.tickSize, instrument))} className={`h-full w-8 text-[15px] disabled:opacity-30 ${tone.muted}`}>+</button>
            </div>
          </div>

          <div className="grid gap-1">
            <div className="flex items-center justify-between">
              <span className={label}>Množství</span>
              <div className={`flex h-[24px] w-[150px] rounded-[8px] border p-0.5 ${tone.seg}`}>
                <button type="button" onClick={() => onDraft({ ...draft, sizing: 'qty', quantity: Math.max(1, m.quantity || draft.quantity) })} className={seg(draft.sizing === 'qty')}>Kontrakty</button>
                <button type="button" onClick={() => onDraft(draft.stopLoss == null ? withBracket({ ...draft, sizing: 'risk' }, 'sl', instrument, quote) : { ...draft, sizing: 'risk' })} className={seg(draft.sizing === 'risk')}>Riziko $</button>
              </div>
            </div>
            <div className={`flex h-[34px] items-center rounded-[9px] border ${tone.field}`}>
              <button type="button" onClick={() => stepQuantity(-1)} className={`h-full w-8 text-[15px] ${tone.muted}`}>−</button>
              <NumberField
                ariaLabel={draft.sizing === 'risk' ? 'Riziko v dolarech' : 'Počet kontraktů'}
                value={draft.sizing === 'risk' ? draft.riskUsd : draft.quantity}
                format={value => String(Math.round(value))}
                onCommit={value => onDraft(draft.sizing === 'risk' ? { ...draft, riskUsd: Math.max(0, value) } : { ...draft, quantity: Math.max(1, Math.round(value)) })}
                className={`min-w-0 flex-1 bg-transparent text-center font-mono text-[13px] outline-none ${tone.ink}`}
              />
              <span className={`pr-1 text-[10px] font-bold ${tone.muted}`}>{draft.sizing === 'risk' ? '$' : instrument.symbol}</span>
              <button type="button" onClick={() => stepQuantity(1)} className={`h-full w-8 text-[15px] ${tone.muted}`}>+</button>
            </div>
            {draft.sizing === 'risk' && <div className={`text-[10.5px] ${tone.muted}`}>→ <b className={`font-mono ${tone.ink}`}>{m.quantity}</b> kontraktů · skutečné riziko <b className={`font-mono ${tone.ink}`}>{formatUsd(m.stopLossUsd)}</b></div>}
          </div>

          <div className="grid gap-1.5">
            <div className="flex items-center justify-between">
              <span className={label}>Závorky</span>
              <div className={`flex h-[24px] w-[170px] rounded-[8px] border p-0.5 ${tone.seg}`}>
                {(['pts', 'ticks', 'usd', 'price'] as const).map(unit => <button key={unit} type="button" onClick={() => onUnits(unit)} className={seg(units === unit)}>{UNIT_LABEL[unit]}</button>)}
              </div>
            </div>
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
        </> : <p className={`m-0 text-center text-[11px] ${tone.muted}`}>Klikni na Koupit / Prodat, ⚡ v position boxu, nebo pravým do grafu.</p>}
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
        onPreview={onPreviewEntry}
      />}
      {problems.length > 0 && <div className="grid gap-1">
        {problems.map(problem => <div key={problem.text} className={`rounded-[7px] px-2 py-1.5 text-[10.5px] font-bold ${problem.level === 'error' ? 'bg-rose-500/10 text-rose-500' : 'bg-amber-500/10 text-amber-600'}`}>{problem.text}</div>)}
      </div>}
      <button
        type="button"
        disabled
        title="Odesílání ze grafu zatím není zapojené — přijde přes jádro kopírky (pravidla INV) v samostatném kroku."
        className="grid h-[42px] cursor-not-allowed content-center rounded-[10px] text-[12px] font-extrabold leading-tight text-white opacity-70"
        style={{ background: `linear-gradient(180deg, color-mix(in srgb, ${sideColor} 82%, #fff), ${sideColor})` }}
      >
        <span className="inline-flex items-center justify-center gap-1.5"><Lock size={11} />{draft.side === 'buy' ? 'Koupit' : 'Prodat'} {m.quantity} {instrument.symbol}</span>
        <small className="font-mono text-[10px] font-semibold opacity-85">
          {TYPE_LABEL[draft.type]}{draft.type === 'market' ? ` · ${formatPrice(m.entry)}` : ` @ ${formatPrice(draft.price)}`}
          {' · '}{single && picked ? `jen ${picked.short}` : group?.armed === false ? 'jen leader' : group ? `skupina ×${groupMultiplier}` : 'leader + kopírka'}
          {limitIsMarketable(draft, quote) ? ' · hned' : ''}
        </small>
      </button>
      <div className={`text-center text-[9.5px] font-bold ${tone.muted}`}>Odesílání zatím není zapojené</div>
    </div>}
  </div>;
};

export default LiveOrderTicket;
