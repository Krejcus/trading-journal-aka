import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, ListOrdered } from 'lucide-react';
import type { TradeTimelineEvent } from '../lib/tradeReplay';

const EVENT_COLOR: Record<TradeTimelineEvent['kind'], string> = {
  order: '#94a3b8', entry: '#2563eb', add: '#2563eb', partial: '#f97316', exit: '#f97316', sl: '#ef4444', tp: '#10b981',
};
/** Jak dlouho bublina události zůstane, než zajede zpátky do tlačítka. */
const POP_MS = 2_200;
/** Víc bublin pod sebou už by zakrylo graf — nejstarší odejde dřív. */
const POP_MAX = 6;

const clock = (at: number) => new Intl.DateTimeFormat('cs-CZ', {
  timeZone: 'Europe/Prague', hour: 'numeric', minute: '2-digit', second: '2-digit',
}).format(at);

interface Pop { key: number; event: TradeTimelineEvent; leaving: boolean }

/**
 * Tlačítko „Průběh“ v liště grafu. Při přehrávání z něj vyskakují bubliny
 * s právě proběhlými událostmi (skládají se pod sebe, každá chvilku zůstane);
 * kliknutím se otevře celý seznam. Kurzor přehrávání `cursorMs` = null znamená
 * celý obchod bez přehrávání.
 */
export default function TradeProgress({ events, cursorMs, isDark }: {
  events: readonly TradeTimelineEvent[];
  cursorMs: number | null;
  isDark: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pops, setPops] = useState<Pop[]>([]);
  const [ping, setPing] = useState(0);
  const [seriesOpen, setSeriesOpen] = useState<Record<string, boolean>>({});
  const previousCursor = useRef<number | null>(cursorMs);
  const popKey = useRef(0);
  const rootRef = useRef<HTMLSpanElement>(null);
  const timers = useRef(new Map<number, number>());
  // Bubliny i seznam se otevírají doprava, ale nesmí přetéct okraj grafu.
  const [shift, setShift] = useState({ pops: 0, list: 0 });
  useLayoutEffect(() => {
    const root = rootRef.current;
    const bounds = root?.closest('[data-trade-chart]')?.getBoundingClientRect();
    if (!root || !bounds) return;
    const left = root.getBoundingClientRect().left;
    setShift({ pops: Math.min(0, bounds.right - 8 - (left + 196)), list: Math.min(0, bounds.right - 8 - (left + 250)) });
  }, [open, pops.length]);

  const dismiss = useCallback((key: number) => {
    window.clearTimeout(timers.current.get(key));
    timers.current.delete(key);
    setPops(current => current.map(pop => pop.key === key ? { ...pop, leaving: true } : pop));
    window.setTimeout(() => setPops(current => current.filter(pop => pop.key !== key)), 320);
  }, []);
  useEffect(() => () => { timers.current.forEach(window.clearTimeout); timers.current.clear(); }, []);

  const done = cursorMs == null ? events.length : events.filter(event => event.at <= cursorMs).length;
  const currentId = cursorMs == null ? null : [...events].reverse().find(event => event.at <= cursorMs)?.id ?? null;

  // Události, přes které přehrávání právě přešlo, vyskočí z tlačítka —
  // každá s vlastní dobou života, takže se při sérii skládají pod sebe.
  useEffect(() => {
    const before = previousCursor.current;
    previousCursor.current = cursorMs;
    if (cursorMs == null || open) return;
    const from = before == null || cursorMs < before ? -Infinity : before;
    const fresh = events.filter(event => event.at > from && event.at <= cursorMs).slice(-POP_MAX);
    if (!fresh.length) return;
    setPing(value => value + 1);
    const added = fresh.map(event => ({ key: ++popKey.current, event, leaving: false }));
    added.forEach(pop => timers.current.set(pop.key, window.setTimeout(() => dismiss(pop.key), POP_MS)));
    setPops(current => {
      const alive = [...current, ...added].filter(pop => !pop.leaving);
      alive.slice(0, Math.max(0, alive.length - POP_MAX)).forEach(pop => window.setTimeout(() => dismiss(pop.key), 0));
      return [...current, ...added];
    });
  }, [cursorMs, events, open, dismiss]);

  // Série se při přehrávání sama rozbalí, když do ní kurzor vstoupí.
  const currentSeries = currentId ? events.find(event => event.id === currentId)?.seriesKey : undefined;
  useEffect(() => {
    if (currentSeries) setSeriesOpen(current => current[currentSeries] ? current : { ...current, [currentSeries]: true });
  }, [currentSeries]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

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
  const surface = isDark ? 'bg-[#0d1219] border-white/10' : 'bg-white border-slate-200';
  const future = (event: TradeTimelineEvent) => cursorMs != null && event.at > cursorMs;

  return (
    <span ref={rootRef} className="relative inline-flex">
      <button
        type="button"
        onClick={() => { setOpen(value => !value); timers.current.forEach(window.clearTimeout); timers.current.clear(); setPops([]); }}
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

      {/* Bubliny právě proběhlých událostí — vynoří se z tlačítka a otevírají se doprava. */}
      {!open && pops.length > 0 && (
        <span className="absolute top-[calc(100%+8px)] z-40 flex w-[196px] flex-col gap-1 pointer-events-none" style={{ left: shift.pops }}>
          <span className={`absolute -top-[5px] h-2 w-2 rotate-45 border-l border-t ${surface}`} style={{ left: 22 - shift.pops }} />
          {pops.map(pop => {
            const series = pop.event.seriesKey ? events.filter(event => event.seriesKey === pop.event.seriesKey) : null;
            return (
              <span key={pop.key} className={`relative block overflow-hidden rounded-md border px-2.5 py-1.5 shadow-[0_12px_26px_-16px_rgba(15,23,42,0.45)] ${surface} ${pop.leaving ? 'trade-progress-pop-out' : 'trade-progress-pop-in'}`}>
                <span className="flex items-center gap-1.5 text-[11px]">
                  <i className="h-[7px] w-[7px] shrink-0 rounded-full" style={{ background: EVENT_COLOR[pop.event.kind] }} />
                  <time className="text-[10px] tabular-nums text-slate-400">{clock(pop.event.at)}</time>
                  <b className={`truncate font-bold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{pop.event.title}</b>
                  {series && <span className="ml-auto text-[9.5px] font-extrabold text-slate-400">{series.indexOf(pop.event) + 1}/{series.length}</span>}
                </span>
                {!series && <span className="mt-px block truncate pl-[13px] text-[10px] text-slate-400">{pop.event.detail}</span>}
              </span>
            );
          })}
        </span>
      )}

      {/* Celý seznam — pod tlačítkem, směrem doprava. */}
      {open && (
        <div style={{ left: shift.list }} className={`trade-progress-list absolute top-[calc(100%+6px)] z-50 w-[250px] max-h-[380px] overflow-y-auto rounded-lg border shadow-[0_24px_50px_-24px_rgba(15,23,42,0.45)] ${surface}`}>
          <div className={`sticky top-0 flex items-center justify-between border-b px-3 py-2 ${surface}`}>
            <b className={`text-[12px] ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>Průběh</b>
            <span className="text-[10.5px] text-slate-400">{events.length} událostí</span>
          </div>
          <div className="py-1">
            {rows.map(row => {
              if (row.type === 'event') {
                const event = row.event;
                return (
                  <div key={event.id} className={`grid grid-cols-[52px_1fr] gap-2 px-3 py-1.5 text-[12px] transition-opacity ${future(event) ? 'opacity-40' : ''} ${currentId === event.id ? isDark ? 'bg-emerald-500/10 shadow-[inset_2px_0_0_#10b981]' : 'bg-emerald-50 shadow-[inset_2px_0_0_#059669]' : ''}`}>
                    <time className="pt-px text-[11px] tabular-nums text-slate-400">{clock(event.at)}</time>
                    <div className="min-w-0">
                      <div className={`font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}><span className="mr-1.5 inline-block h-[7px] w-[7px] rounded-full align-[1px]" style={{ background: EVENT_COLOR[event.kind] }} />{event.title}</div>
                      <div className="text-[11px] text-slate-400">{event.detail}</div>
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
                  <button type="button" onClick={() => setSeriesOpen(current => ({ ...current, [row.key]: !current[row.key] }))}
                    className={`grid w-full grid-cols-[52px_1fr] gap-2 px-3 py-1.5 text-left text-[12px] ${future(first) ? 'opacity-40' : ''} ${inside ? isDark ? 'bg-emerald-500/10 shadow-[inset_2px_0_0_#10b981]' : 'bg-emerald-50 shadow-[inset_2px_0_0_#059669]' : ''}`}>
                    <time className="pt-px text-[11px] tabular-nums text-slate-400">{clock(first.at)}</time>
                    <div className="min-w-0">
                      <div className={`flex items-center font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
                        <span className="mr-1.5 inline-block h-[7px] w-[7px] rounded-full" style={{ background: EVENT_COLOR.sl }} />SL posunut {row.items.length}×
                        <ChevronRight size={12} className={`ml-1 text-slate-400 transition-transform duration-300 ${isOpen ? 'rotate-90' : ''}`} />
                      </div>
                      <div className="text-[11px] text-slate-400">do {clock(last.at)}{cursorMs != null && passed > 0 && passed < row.items.length ? ` · ${passed}/${row.items.length}` : ''}</div>
                    </div>
                  </button>
                  <div className={`grid transition-[grid-template-rows] duration-[450ms] ease-[cubic-bezier(.22,.61,.36,1)] ${isOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
                    <div className="overflow-hidden">
                      {row.items.map(item => (
                        <div key={item.id} className={`grid grid-cols-[52px_1fr] gap-2 px-3 py-1 text-[11.5px] ${future(item) ? 'opacity-40' : ''} ${currentId === item.id ? isDark ? 'bg-emerald-500/10' : 'bg-emerald-50' : ''}`}>
                          <time className="text-[10.5px] tabular-nums text-slate-400">{clock(item.at)}</time>
                          <span className={`pl-[13px] tabular-nums ${currentId === item.id ? isDark ? 'font-bold text-white' : 'font-bold text-slate-900' : 'text-slate-500'}`}>{item.title}</span>
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
