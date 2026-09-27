import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ChartViewApi } from '@getcandlekit/charts/react';
import type { ISeriesPrimitive, MismatchDirection, SeriesAttachedParameter, Time, UTCTimestamp } from 'lightweight-charts';
import {
  CHART_NOTE_MAX_LENGTH,
  DEFAULT_NOTE_OFFSET,
  newChartNoteId,
  visibleChartNotes,
  type ChartNote,
} from '../lib/chartNotes';

/**
 * Poznámky v grafu detailu obchodu (varianta B z mockups/chart-notes.html):
 * bod připíchnutý k času a ceně, bublina s textem odsunutá o pixely, spojená
 * tenkou čárou. Dvojklik (nebo „Přidat poznámku“ v menu grafu) připíchne bod,
 * bublina jede za myší a klikem se položí. Bublinu i bod jde přetáhnout,
 * klik bez tahu na bublinu = úprava.
 *
 * Vrstva leží nad grafem; polohy se přepočítávají přímo v DOM při každém
 * překreslení grafu (prázdný primitiv v sérii), ne přes React state.
 */

interface Point { time: number; price: number }
interface Placing extends Point { dx: number; dy: number }
type Editing = { id: string; draft: string; isNew: boolean };
type Drag = { id: string; kind: 'bubble' | 'anchor'; startX: number; startY: number; moved: boolean; origin: ChartNote; bubble: { x: number; y: number } };

const PLACING_ID = '__placing__';
// Víc grafů (fullscreen): rozdělanou poznámku má vždy jen jeden — ostatní ji zahodí.
const ACTIVE_LAYER_EVENT = 'alphatrade:chart-note-active-layer';
let layerSequence = 0;

/** Čas svíčky, do které `time` patří (poslední s časem ≤ time), jinak null. */
export function containingBarTime(barTimes: readonly number[], time: number): number | null {
  if (barTimes.length === 0 || time < barTimes[0]) return null;
  let low = 0, high = barTimes.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (barTimes[middle] <= time) low = middle; else high = middle - 1;
  }
  const found = barTimes[low];
  // Za poslední svíčkou nejvýš den (denní svíčka) — dál už bod do grafu nepatří.
  return low === barTimes.length - 1 && time - found > 86_400 ? null : found;
}
const DRAG_THRESHOLD = 3;

export interface ChartNoteAddRequest { clientX: number; clientY: number; nonce: number }

export default function ChartNotesLayer({ chartApi, containerRef, notes, barTimes, replayCursor, editable, isDark, addRequest, onChange }: {
  chartApi: ChartViewApi | null;
  /** Obal grafu (position: relative) — vrstva i dvojklik se vztahují k němu. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  notes: readonly ChartNote[];
  /** Časy svíček v grafu (unix s) — bod se k nim přichytí. */
  barTimes: readonly number[];
  replayCursor: number | null;
  editable: boolean;
  isDark: boolean;
  addRequest: ChartNoteAddRequest | null;
  onChange: (next: ChartNote[]) => void;
}) {
  const layerRef = useRef<HTMLDivElement>(null);
  const [layerId] = useState(() => ++layerSequence);
  const svgRef = useRef<SVGSVGElement>(null);
  const [placing, setPlacing] = useState<Placing | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Rozpracovaná poloha při tažení — kreslí se hned, uloží se až po puštění.
  const [dragged, setDraggedState] = useState<ChartNote | null>(null);
  const draggedRef = useRef<ChartNote | null>(null);
  const setDragged = (next: ChartNote | null) => { draggedRef.current = next; setDraggedState(next); };

  const shown = useMemo(() => {
    const list = visibleChartNotes(notes, replayCursor).map(note => (dragged && note.id === dragged.id ? dragged : note));
    if (editing?.isNew && placing) list.push({ id: editing.id, ...placing, text: '' });
    return list;
  }, [dragged, editing, notes, placing, replayCursor]);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const placingRef = useRef(placing);
  placingRef.current = placing;
  const barTimesRef = useRef(barTimes);
  barTimesRef.current = barTimes;

  // ── Převody souřadnic ──────────────────────────────────────────────────
  const geometry = useCallback(() => {
    const container = containerRef.current;
    if (!chartApi || !container) return null;
    try {
      const chart = chartApi.controller.getChart();
      const series = chartApi.controller.getSeries();
      const origin = chart.chartElement().getBoundingClientRect();
      const box = container.getBoundingClientRect();
      const timeScale = chart.timeScale();
      return {
        chart, series, timeScale,
        offsetX: origin.left - box.left,
        offsetY: origin.top - box.top,
        paneWidth: timeScale.width(),
        paneHeight: chart.paneSize(0).height,
        box,
      };
    } catch { return null; }
  }, [chartApi, containerRef]);

  const pointAt = useCallback((clientX: number, clientY: number): Point | null => {
    const geo = geometry();
    const times = barTimesRef.current;
    if (!geo || times.length === 0) return null;
    const x = clientX - geo.box.left - geo.offsetX;
    const y = clientY - geo.box.top - geo.offsetY;
    if (x < 0 || x > geo.paneWidth || y < 0 || y > geo.paneHeight) return null;
    const logical = geo.timeScale.coordinateToLogical(x);
    const price = geo.series.coordinateToPrice(y);
    if (logical == null || price == null) return null;
    // Čas svíčky bere ze série grafu: fullscreen vykresluje jen výřez dat,
    // takže logický index neodpovídá pořadí v celém poli svíček.
    const bar = geo.series.dataByIndex(Math.round(logical as number), -1 as MismatchDirection)
      ?? geo.series.dataByIndex(Math.round(logical as number), 1 as MismatchDirection);
    const time = bar ? Number(bar.time) : NaN;
    if (!Number.isFinite(time)) return null;
    return { time, price: Number(price) };
  }, [geometry]);

  const anchorXY = useCallback((geo: NonNullable<ReturnType<typeof geometry>>, point: Point) => {
    // Vyšší timeframe (fullscreen): bod leží na svíčce, která jeho 1m čas obsahuje.
    const time = containingBarTime(barTimesRef.current, point.time);
    if (time == null) return null;
    const x = geo.timeScale.timeToCoordinate(time as UTCTimestamp as Time);
    const y = geo.series.priceToCoordinate(point.price);
    if (x == null || y == null || x < 0 || x > geo.paneWidth) return null;
    return { x: x + geo.offsetX, y: y + geo.offsetY };
  }, []);

  // ── Poloha v DOM při každém překreslení grafu ──────────────────────────
  const sync = useCallback(() => {
    const layer = layerRef.current;
    const svg = svgRef.current;
    const geo = geometry();
    if (!layer || !svg) return;
    const lines: string[] = [];
    const items = placingRef.current ? [...shownRef.current, { id: PLACING_ID, ...placingRef.current, text: '' }] : shownRef.current;
    for (const note of items) {
      const anchor = layer.querySelector<HTMLElement>(`[data-note-anchor="${note.id}"]`);
      const bubble = layer.querySelector<HTMLElement>(`[data-note-bubble="${note.id}"]`);
      const at = geo ? anchorXY(geo, note) : null;
      for (const element of [anchor, bubble]) if (element) element.style.visibility = at ? 'visible' : 'hidden';
      if (!at) continue;
      if (anchor) { anchor.style.left = `${at.x}px`; anchor.style.top = `${at.y}px`; }
      const bx = at.x + note.dx, by = at.y + note.dy;
      if (bubble) {
        bubble.style.left = `${bx}px`; bubble.style.top = `${by}px`;
        // Čára končí na okraji bubliny, ne v jejím středu.
        const hw = bubble.offsetWidth / 2, hh = bubble.offsetHeight / 2;
        const ratio = Math.min(hw / Math.max(1, Math.abs(bx - at.x)), hh / Math.max(1, Math.abs(by - at.y)));
        const t = Math.max(0, Math.min(1, 1 - ratio));
        if (t > 0) lines.push(`<line x1="${at.x}" y1="${at.y}" x2="${at.x + (bx - at.x) * t}" y2="${at.y + (by - at.y) * t}" />`);
      }
    }
    svg.innerHTML = lines.join('');
  }, [anchorXY, geometry]);
  const syncRef = useRef(sync);
  syncRef.current = sync;

  useEffect(() => {
    if (!chartApi) return;
    let frame = 0;
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(() => { frame = 0; syncRef.current(); }); };
    // Prázdný primitiv: knihovna ho volá při každém překreslení (posun, zoom,
    // změna cenové osy, nová svíčka) — přesně tehdy se poznámky posunou.
    const primitive: ISeriesPrimitive<Time> = {
      attached: (_param: SeriesAttachedParameter<Time>) => schedule(),
      updateAllViews: schedule,
      paneViews: () => [],
    };
    let series: ReturnType<ChartViewApi['controller']['getSeries']> | null = null;
    try {
      series = chartApi.controller.getSeries();
      series.attachPrimitive(primitive);
    } catch { series = null; }
    const observer = new ResizeObserver(schedule);
    if (containerRef.current) observer.observe(containerRef.current);
    schedule();
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      try { series?.detachPrimitive(primitive); } catch { /* graf už je pryč */ }
    };
  }, [chartApi, containerRef]);
  useLayoutEffect(() => { sync(); });

  // ── Přidání: bod → bublina jede za myší → klik → psaní ────────────────
  const startPlacing = useCallback((clientX: number, clientY: number) => {
    if (!editable) return;
    const point = pointAt(clientX, clientY);
    if (!point) return;
    const geo = geometry();
    // Bod mimo vykreslené svíčky by zůstal neviditelný a chytal by kliky.
    if (!geo || !anchorXY(geo, point)) return;
    window.dispatchEvent(new CustomEvent(ACTIVE_LAYER_EVENT, { detail: layerId }));
    setEditing(null);
    setPlacing({ ...point, ...DEFAULT_NOTE_OFFSET });
  }, [anchorXY, editable, geometry, layerId, pointAt]);
  useEffect(() => {
    const other = (event: Event) => {
      if ((event as CustomEvent<number>).detail === layerId) return;
      setPlacing(null);
      setEditing(current => (current?.isNew ? null : current));
    };
    window.addEventListener(ACTIVE_LAYER_EVENT, other);
    return () => window.removeEventListener(ACTIVE_LAYER_EVENT, other);
  }, [layerId]);

  useEffect(() => {
    if (addRequest) startPlacing(addRequest.clientX, addRequest.clientY);
  }, [addRequest, startPlacing]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !editable) return;
    const onDoubleClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest('button, input, textarea, select, [role="dialog"], [role="menu"], [role="toolbar"], [data-chart-note]')) return;
      // Rozkreslený nástroj (fullscreen) si dvojklik nechává pro sebe.
      const tool = (() => { try { return chartApi?.drawing?.engine.getActiveTool() ?? null; } catch { return null; } })();
      if (tool && !/^cursor$/i.test(String(tool))) return;
      startPlacing(event.clientX, event.clientY);
    };
    container.addEventListener('dblclick', onDoubleClick);
    return () => container.removeEventListener('dblclick', onDoubleClick);
  }, [chartApi, containerRef, editable, startPlacing]);

  useEffect(() => {
    if (!placing || editing) return;
    const move = (event: PointerEvent) => {
      const geo = geometry();
      if (!geo) return;
      const at = anchorXY(geo, placing);
      if (!at) return;
      const x = event.clientX - geo.box.left, y = event.clientY - geo.box.top;
      setPlacing(current => current && { ...current, dx: x - at.x, dy: y - at.y });
    };
    const place = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const geo = geometry();
      // Graf mezitím zmizel nebo se posunul tak, že bod není vidět → zrušit.
      if (!geo || !anchorXY(geo, placing)) { setPlacing(null); return; }
      event.preventDefault(); event.stopPropagation();
      setEditing({ id: newChartNoteId(), draft: '', isNew: true });
    };
    const cancel = (event: KeyboardEvent) => { if (event.key === 'Escape') setPlacing(null); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerdown', place, true);
    window.addEventListener('keydown', cancel);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerdown', place, true);
      window.removeEventListener('keydown', cancel);
    };
  }, [anchorXY, editing, geometry, placing]);

  // ── Úprava textu ──────────────────────────────────────────────────────
  const finishEditing = useCallback((save: boolean) => {
    if (!editing) return;
    const text = editing.draft.trim().slice(0, CHART_NOTE_MAX_LENGTH);
    if (editing.isNew) {
      if (save && text && placing) onChange([...notes, { id: editing.id, ...placing, text }]);
      setPlacing(null);
    } else if (save) {
      const current = notes.find(note => note.id === editing.id);
      if (current && text !== current.text) {
        onChange(text ? notes.map(note => (note.id === editing.id ? { ...note, text } : note)) : notes.filter(note => note.id !== editing.id));
      }
    }
    setEditing(null);
  }, [editing, notes, onChange, placing]);
  // Graf (a panel fullscreenu) si po dokončení kliku bere fokus zpět —
  // pole pro psaní se zaměří až potom, jinak by psaní šlo do zkratek grafu.
  const editingId = editing?.id;
  useEffect(() => {
    if (!editingId) return;
    const focus = () => {
      const area = textareaRef.current;
      if (area && document.activeElement !== area) { area.focus(); area.setSelectionRange(area.value.length, area.value.length); }
    };
    const timers = [0, 60, 180].map(delay => window.setTimeout(focus, delay));
    window.addEventListener('pointerup', focus, { once: true });
    return () => { timers.forEach(window.clearTimeout); window.removeEventListener('pointerup', focus); };
  }, [editingId]);
  const finishRef = useRef(finishEditing);
  finishRef.current = finishEditing;
  useEffect(() => {
    if (!editingId) return;
    const outside = (event: PointerEvent) => {
      if ((event.target as HTMLElement).closest?.(`[data-note-bubble="${editingId}"]`)) return;
      finishRef.current(true);
    };
    window.addEventListener('pointerdown', outside, true);
    return () => window.removeEventListener('pointerdown', outside, true);
  }, [editingId]);
  const removeNote = (id: string) => {
    setEditing(null);
    onChange(notes.filter(note => note.id !== id));
  };

  // ── Tažení bubliny (odstup) a bodu (čas + cena, bublina stojí) ────────
  const beginDrag = (event: React.PointerEvent, note: ChartNote, kind: Drag['kind']) => {
    if (!editable || event.button !== 0 || editing?.id === note.id) return;
    event.preventDefault(); event.stopPropagation();
    const geo = geometry();
    const at = geo ? anchorXY(geo, note) : null;
    setDrag({ id: note.id, kind, startX: event.clientX, startY: event.clientY, moved: false, origin: note,
      bubble: at ? { x: at.x + note.dx, y: at.y + note.dy } : { x: 0, y: 0 } });
  };
  useEffect(() => {
    if (!drag) return;
    const move = (event: PointerEvent) => {
      const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
      if (!drag.moved && distance < DRAG_THRESHOLD) return;
      if (!drag.moved) setDrag(current => current && { ...current, moved: true });
      if (drag.kind === 'bubble') {
        setDragged({ ...drag.origin, dx: drag.origin.dx + event.clientX - drag.startX, dy: drag.origin.dy + event.clientY - drag.startY });
        return;
      }
      const point = pointAt(event.clientX, event.clientY);
      const geo = geometry();
      const at = point && geo ? anchorXY(geo, point) : null;
      if (!point || !at) return;
      setDragged({ ...drag.origin, ...point, dx: drag.bubble.x - at.x, dy: drag.bubble.y - at.y });
    };
    const up = () => {
      const moved = draggedRef.current;
      if (moved) {
        onChange(notes.map(note => (note.id === moved.id ? moved : note)));
        setDragged(null);
      } else if (drag.moved) {
        setDragged(null);
      } else if (drag.kind === 'bubble') {
        setEditing({ id: drag.id, draft: drag.origin.text, isNew: false });
      }
      setDrag(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, [anchorXY, drag, geometry, notes, onChange, pointAt]);
  useEffect(() => {
    document.body.classList.toggle('chart-note-dragging', Boolean(drag?.moved));
    return () => document.body.classList.remove('chart-note-dragging');
  }, [drag?.moved]);

  // Jiný obchod: rozdělaná akce se zahodí.
  useEffect(() => { setPlacing(null); setEditing(null); setDrag(null); setDragged(null); }, [chartApi]);

  const bubbleClass = isDark
    ? 'border-amber-400/50 bg-[#101720]/95 text-amber-100 shadow-black/40'
    : 'border-amber-500/60 bg-white/95 text-slate-800 shadow-slate-900/10';

  const renderBubble = (note: ChartNote & { ghost?: boolean }) => {
    const isEditing = editing?.id === note.id;
    return (
      <div
        key={`bubble:${note.id}`}
        data-chart-note
        data-note-bubble={note.id}
        onPointerDown={event => beginDrag(event, note, 'bubble')}
        onDoubleClick={event => event.stopPropagation()}
        className={`group/note ${note.ghost ? 'pointer-events-none' : 'pointer-events-auto'} absolute max-w-[180px] -translate-x-1/2 -translate-y-1/2 select-none rounded-md border px-2 py-1 text-[11px] leading-[1.35] shadow-lg ${bubbleClass} ${
          note.ghost ? 'border-dashed opacity-80' : isEditing ? 'z-20 w-[200px] max-w-none' : `${editable ? 'cursor-pointer' : ''} hover:z-20 hover:max-w-[280px]`}`}
        style={{ visibility: 'hidden' }}
      >
        {isEditing ? (
          <>
            <textarea
              ref={textareaRef}
              autoFocus
              value={editing.draft}
              maxLength={CHART_NOTE_MAX_LENGTH}
              placeholder="Poznámka k tomuhle místu…"
              onChange={event => setEditing(current => current && { ...current, draft: event.target.value })}
              onKeyDown={event => {
                event.stopPropagation();
                if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); finishEditing(true); }
                if (event.key === 'Escape') { event.preventDefault(); finishEditing(false); }
              }}
              // Prázdnou bublinu nezavírá odběr fokusu grafem — jen klik mimo.
              onBlur={() => { if (editing.draft.trim()) finishEditing(true); }}
              onPointerDown={event => event.stopPropagation()}
              rows={Math.min(8, Math.max(2, Math.ceil(editing.draft.length / 30) + 1))}
              className={`block w-full resize-none bg-transparent outline-none ${isDark ? 'placeholder:text-slate-500' : 'placeholder:text-slate-400'}`}
            />
            <div className="mt-1 flex items-center justify-between text-[9.5px] text-slate-500">
              {!editing.isNew
                ? <button type="button" onPointerDown={event => { event.preventDefault(); event.stopPropagation(); removeNote(note.id); }} className="font-semibold text-red-400 hover:text-red-300">Smazat</button>
                : <span />}
              <span>Enter = uložit · Esc = zrušit</span>
            </div>
          </>
        ) : note.ghost ? (
          <span className="text-slate-400">Klikni, kam dát text…</span>
        ) : (
          <>
            <div className="whitespace-pre-wrap break-words line-clamp-4 group-hover/note:line-clamp-none">{note.text}</div>
            {note.text.length > 110 && <div className="mt-0.5 text-[9.5px] text-amber-500/80 group-hover/note:hidden">více…</div>}
          </>
        )}
      </div>
    );
  };

  return (
    <div ref={layerRef} className="pointer-events-none absolute inset-0 z-20 overflow-hidden" aria-label="Poznámky v grafu">
      <svg ref={svgRef} className={`absolute inset-0 h-full w-full overflow-visible ${isDark ? 'stroke-amber-400/60' : 'stroke-amber-500/70'}`} strokeWidth={1} aria-hidden="true" />
      {[...shown, ...(placing && !editing ? [{ id: PLACING_ID, ...placing, text: '', ghost: true }] : [])].map(note => (
        <React.Fragment key={note.id}>
          <div
            data-chart-note
            data-note-anchor={note.id}
            onPointerDown={event => beginDrag(event, note, 'anchor')}
            onDoubleClick={event => event.stopPropagation()}
            className={`group/anchor ${note.id === PLACING_ID ? 'pointer-events-none' : 'pointer-events-auto'} absolute -ml-2 -mt-2 grid h-4 w-4 place-items-center rounded-full ${editable ? 'cursor-pointer' : ''}`}
            style={{ visibility: 'hidden' }}
          >
            <span className={`h-1.5 w-1.5 rounded-full bg-amber-500 transition-transform duration-150 group-hover/anchor:scale-150 group-hover/anchor:shadow-[0_0_0_3px_rgba(245,158,11,0.25)] ${drag?.id === note.id && drag.kind === 'anchor' ? 'scale-150' : ''}`} />
          </div>
          {renderBubble(note)}
        </React.Fragment>
      ))}
    </div>
  );
}
