import React, { useMemo } from 'react';
import { groupProtectionMarkers, type TradeExecutionHistory } from '../lib/tradeExecutionHistory';
import { createJournalTimeProjection, type JournalCandleCoverage } from '../services/journalChartTime';

const exactTime = (at: number) => new Intl.DateTimeFormat('cs-CZ', {
  timeZone: 'Europe/Prague', hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3,
}).format(at);
const money = (value: number | null) => value == null ? '—' : new Intl.NumberFormat('cs-CZ', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value);
const status = { confirmed: 'Potvrzeno', pending: 'Bez potvrzení', rejected: 'Odmítnuto', cancelled: 'Zrušeno', uncertain: 'Rozporné potvrzení' };

export default function TradeExecutionTimeline({ history, isDark, candleCoverage }: { history?: TradeExecutionHistory; isDark: boolean; candleCoverage?: JournalCandleCoverage }) {
  const outsideCandles = useMemo(() => {
    if (!history || !candleCoverage) return 0;
    const projection = createJournalTimeProjection(candleCoverage.candles, candleCoverage.intervalSeconds);
    return [...history.fills, ...history.protection].filter(event => projection.point(event.at) == null).length;
  }, [history, candleCoverage]);
  const border = isDark ? 'border-white/10' : 'border-slate-200';
  if (!history) return <div className={`shrink-0 border-t ${border} px-3 py-2 text-[10px] text-slate-500`}>Historie SL/TP u tohoto obchodu zatím není doložená.</div>;
  const groups = groupProtectionMarkers(history.protection);
  return <div className={`shrink-0 max-h-[35%] overflow-y-auto border-t ${border} px-3 py-2 text-[10px] ${isDark ? 'bg-theme-card text-slate-300' : 'bg-white text-slate-600'}`}>
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 mb-2 tabular-nums">
      <span>Hrubé P&L <strong>{money(history.grossPnl)}</strong></span>
      <span>Poplatky <strong>{money(history.fees)}</strong></span>
      <span>Čisté P&L <strong className={history.netPnl == null ? '' : history.netPnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}>{money(history.netPnl)}</strong></span>
    </div>
    {history.position?.status === 'open' && <p className="mb-2 text-slate-500">Pozice je otevřená · zbývá {history.position.openQuantity} kontraktů. Konečné P&L bude dostupné po uzavření.</p>}
    {history.position?.status === 'incomplete' && <p className="mb-2 text-slate-500">Průběh pozice není úplný. Poslední zaznamenaný výstup nepovažujeme za potvrzené uzavření.</p>}
    {history.fees == null && <p className="mb-2 text-slate-500">Poplatky nejsou úplné; čisté P&L proto zatím neuvádíme.</p>}
    {history.gaps.length > 0 && <p className="mb-2 text-slate-500">Část událostí může chybět kvůli výpadku záznamu. Čáry přes výpadek nepokračují.</p>}
    <p className="mb-2 text-[var(--text-secondary)]">Box: první doložené SL/TP vůči prvnímu vstupu. Čáry: potvrzené změny. Tečky: plnění.</p>
    {outsideCandles > 0 && <p className="mb-2 text-amber-500">Události mimo načtené svíčky: {outsideCandles}. V grafu je neposouváme na jinou svíčku; přesné časy zůstávají níže.</p>}
    <div className="space-y-1">
      {groups.map(group => <details key={`${group.at}:${group.kind}`} className={`rounded-lg border ${border} px-2 py-1`}>
        <summary className="cursor-pointer font-semibold">{exactTime(group.at).slice(0, 5)} · {group.kind.toUpperCase()} · {group.events.length} {group.events.length === 1 ? 'událost' : group.events.length < 5 ? 'události' : 'událostí'}</summary>
        <ol className="mt-1 space-y-1">
          {group.events.map(event => <li key={event.id} className="flex flex-wrap items-baseline gap-x-3 tabular-nums">
            <time dateTime={new Date(event.at).toISOString()} className="font-mono">{exactTime(event.at)}</time>
            <span>{event.price == null ? '—' : event.price.toLocaleString('cs-CZ', { maximumFractionDigits: 5 })}</span>
            <span className={event.status === 'rejected' ? 'text-rose-500' : event.status === 'confirmed' ? 'text-emerald-500' : 'text-slate-500'}>{status[event.status]}</span>
            {event.timeSource === 'received' && <span className="text-slate-500">čas přijetí</span>}
            {event.reason && <span className="text-slate-500">{event.reason}</span>}
          </li>)}
        </ol>
      </details>)}
      <details className={`rounded-lg border ${border} px-2 py-1`}>
        <summary className="cursor-pointer font-semibold">Jednotlivá plnění · {history.fills.length}</summary>
        <ol className="mt-1 space-y-1">
          {history.fills.map(fill => <li key={`${fill.id}:${fill.role}`} className="flex flex-wrap gap-x-3 tabular-nums">
            <time dateTime={new Date(fill.at).toISOString()} className="font-mono">{exactTime(fill.at)}</time>
            <span>{fill.role === 'entry' ? 'Vstup' : 'Výstup'} · {fill.allocatedQuantity} × {fill.price.toLocaleString('cs-CZ')}</span>
            {fill.timeSource === 'received' && <span className="text-slate-500">čas přijetí</span>}
          </li>)}
        </ol>
      </details>
    </div>
  </div>;
}
