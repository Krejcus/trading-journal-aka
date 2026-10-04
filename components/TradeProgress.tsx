import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, ListOrdered } from 'lucide-react';
import type { TradeTimelineEvent } from '../lib/tradeReplay';
import EntryOrderDetail from './EntryOrderDetail';
import {
  ENTRY_ORDER_FOCUS_EVENT, ENTRY_ORDER_SELECT_EVENT, emitEntryOrder, type EntryOrderFocusDetail, type EntryOrderSelectDetail,
} from '../services/entryOrderEvents';

export const EVENT_COLOR: Record<TradeTimelineEvent['kind'], string> = {
  order: '#94a3b8', entry: '#2563eb', add: '#2563eb', partial: '#f97316', exit: '#f97316', sl: '#ef4444', tp: '#10b981',
};
/** Jak dlouho odjíždí předchozí událost, než ji nahradí nová. */
const ISLAND_OUT_MS = 260;

/** Šířka seznamu Průběhu — řádky jsou jednořádkové, detail se vejde vedle názvu. */
const LIST_WIDTH = 300;

const clock = (at: number) => new Intl.DateTimeFormat('cs-CZ', {
  timeZone: 'Europe/Prague', hour: 'numeric', minute: '2-digit', second: '2-digit',
}).format(at);

interface IslandItem { key: number; event: TradeTimelineEvent; leaving: boolean }

/**
 * Tlačítko „Průběh“ v liště grafu. Při přehrávání se vlevo od něj ukazuje
 * poslední proběhlá událost (nová vyjede zespodu, stará odjede nahoru) —
 * do plochy grafu nic nevyskakuje. Kliknutím se otevře celý seznam.
 * Kurzor přehrávání `cursorMs` = null znamená celý obchod bez přehrávání.
 */
export default function TradeProgress({ events, cursorMs, isDark, orderDetails = false }: {
  events: readonly TradeTimelineEvent[];
  cursorMs: number | null;
  isDark: boolean;
  /** Klik na vstupní příkaz v grafu otevře seznam s jeho detailem. */
  orderDetails?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [order, setOrder] = useState<EntryOrderSelectDetail | null>(null);
  const orderRef = useRef(order);
  orderRef.current = order;
  useEffect(() => {
    if (!orderDetails) return;
    const onSelect = (event: Event) => {
      const detail = (event as CustomEvent<EntryOrderSelectDetail>).detail;
      if (detail?.orderId && detail.order) { setOrder(detail); setOpen(true); } else setOrder(null);
    };
    window.addEventListener(ENTRY_ORDER_SELECT_EVENT, onSelect);
    return () => window.removeEventListener(ENTRY_ORDER_SELECT_EVENT, onSelect);
  }, [orderDetails]);
  /** Zavření seznamu odepne i příkaz v grafu. */
  const closeList = useCallback(() => {
    setOpen(false);
    if (orderRef.current) emitEntryOrder<EntryOrderFocusDetail>(ENTRY_ORDER_FOCUS_EVENT, { orderId: null, mode: 'pin' });
  }, []);
  const [island, setIsland] = useState<IslandItem[]>([]);
  const [ping, setPing] = useState(0);
  const [seriesOpen, setSeriesOpen] = useState<Record<string, boolean>>({});
  const previousCursor = useRef<number | null>(cursorMs);
  const islandKey = useRef(0);
  const rootRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // Seznam se otevírá doprava, ale nesmí přetéct okraj grafu.
  const [listShift, setListShift] = useState(0);
  useLayoutEffect(() => {
    const button = buttonRef.current;
    const bounds = button?.closest('[data-trade-chart]')?.getBoundingClientRect();
    if (!open || !button || !bounds) return;
    setListShift(Math.min(0, bounds.right - 8 - (button.getBoundingClientRect().left + LIST_WIDTH)));
  }, [open]);

  const done = cursorMs == null ? events.length : events.filter(event => event.at <= cursorMs).length;
  const currentId = cursorMs == null ? null : [...events].reverse().find(event => event.at <= cursorMs)?.id ?? null;

  // Počítadlo na tlačítku blikne, když přehrávání přejde přes novou událost.
  useEffect(() => {
    const before = previousCursor.current;
    previousCursor.current = cursorMs;
    if (cursorMs == null) return;
    const from = before == null || cursorMs < before ? -Infinity : before;
    if (events.some(event => event.at > from && event.at <= cursorMs)) setPing(value => value + 1);
  }, [cursorMs, events]);

  // Vedle tlačítka drží poslední proběhlou událost; při změně stará odjede.
  const currentEvent = currentId ? events.find(event => event.id === currentId) ?? null : null;
  useEffect(() => {
    if (!currentEvent) { setIsland([]); return; }
    setIsland(current => current.some(item => !item.leaving && item.event.id === currentEvent.id) ? current : [
      ...current.filter(item => !item.leaving).map(item => ({ ...item, leaving: true })),
      { key: ++islandKey.current, event: currentEvent, leaving: false },
    ]);
    const timer = window.setTimeout(() => setIsland(current => current.filter(item => !item.leaving)), ISLAND_OUT_MS);
    return () => window.clearTimeout(timer);
  }, [currentEvent]);

  // Série se při přehrávání sama rozbalí, když do ní kurzor vstoupí.
  const currentSeries = currentId ? events.find(event => event.id === currentId)?.seriesKey : undefined;
  useEffect(() => {
    if (currentSeries) setSeriesOpen(current => current[currentSeries] ? current : { ...current, [currentSeries]: true });
  }, [currentSeries]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!rootRef.current?.contains(event.target as Node)) closeList(); };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [closeList, open]);

  const rows = useMemo(() => {
    const out: Array<{ type: 'event'; event: TradeTimelineEvent } | { type: 'series'; key: string; items: TradeTimelineEvent[] }> = [];
    for (const event of events) {
      if (!event.seriesKey) { out.push({ type: 'event', event }); continue; }
      const last = out.at(-1);
      if (last?.type === 'series' && last.key === event.seriesKey) last.items.push(event);
      else out.push({ type: 'series', key: event.seriesKey, items: [event] });
    }
    return out;
  }, [events]);

  if (events.length === 0) return null;
  // Seznam je skleněná vrstva nad grafem (graf pod ním prosvítá rozmazaně).
  const surface = isDark
    ? 'bg-[#0c1222]/70 border-white/10 backdrop-blur-xl backdrop-saturate-150 shadow-[0_24px_50px_-24px_rgba(0,0,0,0.8),inset_0_1px_0_rgba(255,255,255,0.06)]'
    : 'bg-white/75 border-white/80 backdrop-blur-xl backdrop-saturate-150 shadow-[0_24px_50px_-24px_rgba(15,23,42,0.45),0_0_0_1px_rgba(15,23,42,0.06),inset_0_1px_0_rgba(255,255,255,0.95)]';
  const future = (event: TradeTimelineEvent) => cursorMs != null && event.at > cursorMs;
  const rowCurrent = isDark ? 'bg-emerald-500/10 shadow-[inset_2px_0_0_#10b981]' : 'bg-emerald-50/80 shadow-[inset_2px_0_0_#059669]';
  const titleCls = `shrink-0 whitespace-nowrap font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`;
  const toggleList = () => { if (open) closeList(); else setOpen(true); };

  return (
    <span ref={rootRef} className="relative inline-flex items-center">
      {/* Poslední událost přehrávání — vyjede vlevo od tlačítka, graf nezakrývá. */}
      <span
        aria-live="polite"
        onClick={island.length ? toggleList : undefined}
        className={`relative inline-flex h-7 min-w-0 items-center overflow-hidden rounded-md transition-[max-width,opacity] duration-500 ease-[cubic-bezier(.22,.61,.36,1)] ${island.length ? 'max-w-[340px] cursor-pointer opacity-100' : 'max-w-0 opacity-0'} ${isDark ? 'hover:bg-white/5' : 'hover:bg-slate-100'}`}
      >
        {island.map(item => {
          const series = item.event.seriesKey ? events.filter(event => event.seriesKey === item.event.seriesKey) : null;
          return (
            <span key={item.key} title={`${clock(item.event.at)} · ${item.event.detail}`} style={{ '--c': EVENT_COLOR[item.event.kind] } as React.CSSProperties}
              className={`flex h-7 min-w-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-[11.5px] ${item.leaving ? 'trade-island-out absolute right-0' : 'trade-island-in'}`}>
              <i className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: EVENT_COLOR[item.event.kind] }} />
              <b className={`min-w-0 truncate font-bold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{item.event.title}</b>
              {series && <span className="shrink-0 text-[10px] font-extrabold tabular-nums text-slate-400">{series.indexOf(item.event) + 1}/{series.length}</span>}
            </span>
          );
        })}
      </span>
      <button
        ref={buttonRef}
        type="button"
        onClick={toggleList}
        className={`h-7 inline-flex items-center gap-1.5 px-2 rounded-md text-[11px] font-bold transition-colors ${open
          ? isDark ? 'bg-white/10 text-white' : 'bg-slate-100 text-slate-950'
          : isDark ? 'text-slate-300 hover:bg-white/5 hover:text-white' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-950'}`}
        aria-expanded={open}
        title="Průběh obchodu — plnění a změny SL/TP"
      >
        <ListOrdered size={13} /> Průběh
        <span key={ping} className={`rounded px-1 text-[10px] tabular-nums ${cursorMs != null ? 'trade-progress-ping bg-emerald-600 text-white' : isDark ? 'bg-white/5 text-slate-400' : 'bg-slate-100 text-slate-500'}`}>
          {cursorMs != null ? `${done}/${events.length}` : events.length}
        </span>
      </button>

      {/* Celý seznam — pod tlačítkem, směrem doprava; řádky jsou jednořádkové. */}
      {open && (
        <div style={{ left: (buttonRef.current?.offsetLeft ?? 0) + listShift, width: LIST_WIDTH }}
          className={`trade-progress-list absolute top-[calc(100%+6px)] z-50 max-h-[380px] overflow-y-auto rounded-xl border ${surface}`}>
          <div className={`sticky top-0 z-10 flex items-center justify-between border-b px-3 py-1.5 backdrop-blur-xl ${isDark ? 'border-white/10 bg-[#0c1222]/80' : 'border-slate-900/[0.06] bg-white/80'}`}>
            <b className={`text-[12px] ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>Průběh</b>
            <span className="text-[10.5px] text-slate-400">{events.length} událostí</span>
          </div>
          {order?.order && (
            <div data-entry-order-detail className="tr-order-detail px-2 pt-2">
              <EntryOrderDetail order={order.order} outcome={order.outcome} pointValue={order.pointValue} isDark={isDark} onClose={closeList} />
            </div>
          )}
          <div className="py-0.5">
            {rows.map(row => {
              if (row.type === 'event') {
                const event = row.event;
                return (
                  <div key={event.id} title={event.detail}
                    className={`grid grid-cols-[50px_1fr] items-baseline gap-1.5 px-3 py-1 text-[11.5px] transition-opacity ${future(event) ? 'opacity-40' : ''} ${currentId === event.id ? rowCurrent : ''}`}>
                    <time className="text-[10.5px] tabular-nums text-slate-400">{clock(event.at)}</time>
                    <div className="flex min-w-0 items-baseline gap-1.5">
                      <span className={titleCls}><span className="mr-1.5 inline-block h-[7px] w-[7px] rounded-full align-[1px]" style={{ background: EVENT_COLOR[event.kind] }} />{event.title}</span>
                      <span className="min-w-0 truncate text-[10.5px] text-slate-400">{event.detail}</span>
                    </div>
                  </div>
                );
              }
              const first = row.items[0], last = row.items.at(-1)!;
              const isOpen = !!seriesOpen[row.key];
              const inside = row.items.some(item => item.id === currentId);
              const passed = cursorMs == null ? row.items.length : row.items.filter(item => item.at <= cursorMs).length;
              return (
                <div key={row.key}>
                  <button type="button" onClick={() => setSeriesOpen(current => ({ ...current, [row.key]: !current[row.key] }))} aria-expanded={isOpen}
                    className={`grid w-full grid-cols-[50px_1fr] items-baseline gap-1.5 px-3 py-1 text-left text-[11.5px] ${future(first) ? 'opacity-40' : ''} ${inside ? rowCurrent : ''}`}>
                    <time className="text-[10.5px] tabular-nums text-slate-400">{clock(first.at)}</time>
                    <div className="flex min-w-0 items-baseline gap-1.5">
                      <span className={`${titleCls} inline-flex items-center`}>
                        <span className="mr-1.5 inline-block h-[7px] w-[7px] rounded-full" style={{ background: EVENT_COLOR.sl }} />SL posunut {row.items.length}×
                        <ChevronRight size={12} className={`ml-0.5 text-slate-400 transition-transform duration-300 ${isOpen ? 'rotate-90' : ''}`} />
                      </span>
                      <span className="min-w-0 truncate text-[10.5px] text-slate-400">do {clock(last.at)}{cursorMs != null && passed > 0 && passed < row.items.length ? ` · ${passed}/${row.items.length}` : ''}</span>
                    </div>
                  </button>
                  <div className={`grid transition-[grid-template-rows] duration-[450ms] ease-[cubic-bezier(.22,.61,.36,1)] ${isOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
                    <div className="overflow-hidden">
                      {row.items.map(item => (
                        <div key={item.id} className={`grid grid-cols-[50px_1fr] items-baseline gap-1.5 px-3 py-0.5 text-[11px] ${future(item) ? 'opacity-40' : ''} ${currentId === item.id ? isDark ? 'bg-emerald-500/10' : 'bg-emerald-50/80' : ''}`}>
                          <time className="text-[10px] tabular-nums text-slate-400">{clock(item.at)}</time>
                          <span className={`truncate pl-[13px] tabular-nums ${currentId === item.id ? isDark ? 'font-bold text-white' : 'font-bold text-slate-900' : 'text-slate-500'}`}>{item.title}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </span>
  );
}
