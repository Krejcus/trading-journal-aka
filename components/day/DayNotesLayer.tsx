import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChartViewApi } from '@getcandlekit/charts/react';
import type { ISeriesPrimitive, Time, UTCTimestamp } from 'lightweight-charts';
import { Brain, Mic, PenLine } from 'lucide-react';
import { containingBarTime } from '../ChartNotesLayer';
import { pragueClock, type DayNotePhase } from '../../lib/dayJournal';
import { MIND_STYLE, PHASE_STYLE, priceText } from './DayPrimitives';

/**
 * Poznámky deníku dne nad grafem: bod v čase a ceně obarvený fází zápisu
 * (příprava / živě / zpětně), u přípravy přerušovaný paprsek od okamžiku
 * zápisu. V režimu umisťování vrstva chytá klik (vlastní kříž) a vrací čas
 * a cenu — i do budoucnosti vpravo od poslední svíčky (scénář přípravy).
 *
 * Polohy se přepočítávají přímo v DOM při každém překreslení grafu.
 */

export interface DayPinView {
  id: string;
  /** Čas kotvy (unix s) a cena. */
  time: number;
  price: number;
  phase: DayNotePhase;
  voice: boolean;
  text: string;
  /** Řádek nad textem bubliny („zapsáno 07:53 · příprava London“). */
  meta: string;
  /** Paprsek od tohoto času (unix s) k bodu — plán psaný předem. */
  rayFrom?: number | null;
  /** Poznámka jiné session v přípravě: jen obrys, bez kliku. */
  ghost?: boolean;
  /** Ještě neuložená / chyba uložení. */
  status?: 'pending' | 'failed';
  /** Poznámka Hlava (osobní) — fialová. */
  mind?: boolean;
}

/** Hlava bez bodu v grafu: značka na časové ose v čase zápisu (unix s). */
export interface DayAxisTick { id: string; time: number; text: string }

export interface DayPinPoint { time: number; price: number }

/** Pás session v grafu (čas v unix s); budoucí část má přerušovaný okraj. */
export interface DayBand { id: string; start: number; end: number; label: string; color: string; fill: string }

const TICK = 0.25;
const roundPrice = (price: number) => Math.round(price / TICK) * TICK;
const timeLabel = (unix: number) => pragueClock(unix * 1000);

/** Bublina vpravo od bodu, když se nevejde tak vlevo, jinak pod bod (v mezích grafu). */
export function bubbleTransform(x: number, width: number, left: number, right: number): string {
  if (right - x >= width + 20) return 'translate(14px, -50%)';
  if (x - left >= width + 20) return 'translate(calc(-100% - 14px), -50%)';
  const start = Math.max(left + 4, Math.min(right - width - 4, x - width / 2));
  return `translate(${Math.round(start - x)}px, 14px)`;
}

interface Geometry {
  chart: ReturnType<ChartViewApi['controller']['getChart']>;
  series: ReturnType<ChartViewApi['controller']['getSeries']>;
  offsetX: number; offsetY: number; paneWidth: number; paneHeight: number; box: DOMRect;
}

export default function DayNotesLayer({ chartApi, containerRef, barTimes, intervalSeconds, pins, selectedId, onSelect, bubbles, placing, placingHint, onPick, onCancelPlacing, pending, pendingContent, nowTime, bands = [], ticks = [] }: {
  chartApi: ChartViewApi | null;
  containerRef: React.RefObject<HTMLDivElement | null>;
  barTimes: readonly number[];
  intervalSeconds: number;
  pins: readonly DayPinView[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** `all` = bubliny u všech bodů (příprava), `selected` = jen u vybraného (den). */
  bubbles: 'all' | 'selected';
  placing: 'note' | 'voice' | null;
  placingHint?: string;
  onPick: (point: DayPinPoint) => void;
  onCancelPlacing: () => void;
  /** Vybrané místo pro novou poznámku (pulzující bod + obsah vedle). */
  pending: DayPinPoint | null;
  pendingContent?: React.ReactNode;
  /** Svislá čára „teď“ (unix s) — příprava. */
  nowTime?: number | null;
  bands?: readonly DayBand[];
  ticks?: readonly DayAxisTick[];
}) {
  const layerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const barTimesRef = useRef(barTimes);
  barTimesRef.current = barTimes;
  const intervalRef = useRef(intervalSeconds);
  intervalRef.current = intervalSeconds;
  const pinsRef = useRef(pins);
  pinsRef.current = pins;
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const nowRef = useRef(nowTime ?? null);
  nowRef.current = nowTime ?? null;
  const bandsRef = useRef(bands);
  bandsRef.current = bands;
  const ticksRef = useRef(ticks);
  ticksRef.current = ticks;
  const [hover, setHover] = useState<{ x: number; y: number; time: number; price: number } | null>(null);

  const geometry = useCallback((): Geometry | null => {
    const container = containerRef.current;
    if (!chartApi || !container) return null;
    try {
      const chart = chartApi.controller.getChart();
      const series = chartApi.controller.getSeries();
      const origin = chart.chartElement().getBoundingClientRect();
      const box = container.getBoundingClientRect();
      return { chart, series, offsetX: origin.left - box.left, offsetY: origin.top - box.top, paneWidth: chart.timeScale().width(), paneHeight: chart.paneSize(0).height, box };
    } catch { return null; }
  }, [chartApi, containerRef]);

  /** x v rámci vrstvy pro čas (i za poslední svíčkou). */
  const xOf = useCallback((geo: Geometry, time: number): number | null => {
    const times = barTimesRef.current;
    if (!times.length) return null;
    const last = times[times.length - 1];
    const timeScale = geo.chart.timeScale();
    let x: number | null;
    if (time > last + intervalRef.current - 1) {
      // Za poslední svíčkou (budoucnost session): od poslední svíčky po krocích šířky svíčky.
      const lastX = timeScale.timeToCoordinate(last as UTCTimestamp as Time) as number | null;
      x = lastX == null ? null : lastX + ((time - last) / intervalRef.current) * timeScale.options().barSpacing;
    } else {
      const bar = containingBarTime(times, time);
      if (bar == null) return null;
      x = timeScale.timeToCoordinate(bar as UTCTimestamp as Time) as number | null;
    }
    return x == null ? null : x + geo.offsetX;
  }, []);
  const yOf = useCallback((geo: Geometry, price: number): number | null => {
    const y = geo.series.priceToCoordinate(price);
    return y == null ? null : y + geo.offsetY;
  }, []);

  const pointAt = useCallback((clientX: number, clientY: number) => {
    const geo = geometry();
    const times = barTimesRef.current;
    if (!geo || !times.length) return null;
    const x = clientX - geo.box.left - geo.offsetX;
    const y = clientY - geo.box.top - geo.offsetY;
    if (x < 0 || x > geo.paneWidth || y < 0 || y > geo.paneHeight) return null;
    const timeScale = geo.chart.timeScale();
    const logical = timeScale.coordinateToLogical(x) as number | null;
    const price = geo.series.coordinateToPrice(y);
    if (logical == null || price == null) return null;
    const interval = intervalRef.current;
    const lastIndex = times.length - 1;
    const lastX = timeScale.timeToCoordinate(times[lastIndex] as UTCTimestamp as Time) as number | null;
    const spacing = timeScale.options().barSpacing;
    let time: number;
    if (lastX != null && x > lastX + spacing / 2) time = times[lastIndex] + ((x - lastX) / spacing) * interval;
    else {
      const index = Math.max(0, Math.min(lastIndex, Math.round(logical)));
      time = times[index] + Math.max(0, Math.min(0.999, logical - (index - 0.5))) * interval;
    }
    return { x: x + geo.offsetX, y: y + geo.offsetY, time: Math.floor(time / 60) * 60, price: roundPrice(Number(price)) };
  }, [geometry]);

  // ── Polohy v DOM ───────────────────────────────────────────────────────
  const sync = useCallback(() => {
    const layer = layerRef.current;
    const svg = svgRef.current;
    if (!layer || !svg) return;
    const geo = geometry();
    const lines: string[] = [];
    const place = (selector: string, x: number | null, y: number | null) => {
      const element = layer.querySelector<HTMLElement>(selector);
      if (!element) return;
      const visible = geo != null && x != null && y != null && x >= (geo.offsetX - 2) && x <= geo.offsetX + geo.paneWidth + 2 && y >= geo.offsetY - 2 && y <= geo.offsetY + geo.paneHeight + 2;
      element.style.visibility = visible ? 'visible' : 'hidden';
      if (visible) { element.style.left = `${x}px`; element.style.top = `${y}px`; }
    };
    for (const pin of pinsRef.current) {
      const x = geo ? xOf(geo, pin.time) : null;
      const y = geo ? yOf(geo, pin.price) : null;
      place(`[data-day-pin="${pin.id}"]`, x, y);
      place(`[data-day-bubble="${pin.id}"]`, x, y);
      const bubble = layer.querySelector<HTMLElement>(`[data-day-bubble="${pin.id}"]`);
      if (bubble && geo && x != null) bubble.style.transform = bubbleTransform(x, bubble.offsetWidth, geo.offsetX, geo.offsetX + geo.paneWidth);
      if (geo && x != null && y != null && pin.rayFrom != null) {
        const from = xOf(geo, pin.rayFrom);
        const left = Math.max(geo.offsetX, Math.min(x, from ?? geo.offsetX));
        if (x - left > 4) lines.push(`<line x1="${left}" y1="${y}" x2="${x}" y2="${y}" stroke="${(pin.mind ? MIND_STYLE : PHASE_STYLE[pin.phase]).line}" stroke-dasharray="4 4" />`);
      }
    }
    for (const tick of ticksRef.current) {
      const x = geo ? xOf(geo, tick.time) : null;
      place(`[data-day-tick="${tick.id}"]`, x, geo ? geo.offsetY + geo.paneHeight - 7 : null);
    }
    const pendingPoint = pendingRef.current;
    if (pendingPoint) {
      const x = geo ? xOf(geo, pendingPoint.time) : null;
      const y = geo ? yOf(geo, pendingPoint.price) : null;
      place('[data-day-pending]', x, y);
      place('[data-day-pending-pop]', x, y);
      const pop = layer.querySelector<HTMLElement>('[data-day-pending-pop]');
      if (pop && geo && x != null && y != null) {
        const right = x > geo.offsetX + geo.paneWidth * 0.66;
        const ty = y > geo.offsetY + geo.paneHeight * 0.6 ? '-100%' : y < geo.offsetY + geo.paneHeight * 0.25 ? '0%' : '-50%';
        pop.style.transform = `translate(${right ? 'calc(-100% - 16px)' : '16px'}, ${ty})`;
      }
    }
    for (const band of bandsRef.current) {
      const element = layer.querySelector<HTMLElement>(`[data-day-band="${band.id}"]`);
      if (!element) continue;
      const from = geo ? xOf(geo, band.start) : null;
      const to = geo ? xOf(geo, band.end) : null;
      if (!geo || from == null || to == null) { element.style.visibility = 'hidden'; continue; }
      const left = Math.max(geo.offsetX, from);
      const right = Math.min(geo.offsetX + geo.paneWidth, to);
      element.style.visibility = right - left > 2 ? 'visible' : 'hidden';
      element.style.left = `${left}px`; element.style.width = `${Math.max(0, right - left)}px`;
      element.style.top = `${geo.offsetY}px`; element.style.height = `${geo.paneHeight}px`;
      const now = nowRef.current;
      element.style.borderTopStyle = now != null && band.start > now ? 'dashed' : 'solid';
    }
    const now = nowRef.current;
    if (now != null) {
      const x = geo ? xOf(geo, now) : null;
      const element = layer.querySelector<HTMLElement>('[data-day-now]');
      if (element && geo) {
        element.style.visibility = x != null ? 'visible' : 'hidden';
        if (x != null) { element.style.left = `${x}px`; element.style.top = `${geo.offsetY}px`; element.style.height = `${geo.paneHeight}px`; }
      }
    }
    svg.innerHTML = lines.join('');
  }, [geometry, xOf, yOf]);
  const syncRef = useRef(sync);
  syncRef.current = sync;

  useEffect(() => {
    if (!chartApi) return;
    let frame = 0;
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(() => { frame = 0; syncRef.current(); }); };
    const primitive: ISeriesPrimitive<Time> = { attached: () => schedule(), updateAllViews: schedule, paneViews: () => [] };
    let series: ReturnType<ChartViewApi['controller']['getSeries']> | null = null;
    try { series = chartApi.controller.getSeries(); series.attachPrimitive(primitive); } catch { series = null; }
    const observer = new ResizeObserver(schedule);
    if (containerRef.current) observer.observe(containerRef.current);
    schedule();
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      try { series?.detachPrimitive(primitive); } catch { /* graf je pryč */ }
    };
  }, [chartApi, containerRef]);
  useLayoutEffect(() => { sync(); });

  // Esc zruší umisťování.
  useEffect(() => {
    if (!placing) { setHover(null); return; }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onCancelPlacing(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancelPlacing, placing]);

  const geo = placing && hover ? geometry() : null;

  return (
    <div ref={layerRef} className="dj" style={{ position: 'absolute', inset: 0, zIndex: 25, pointerEvents: 'none', overflow: 'hidden' }} aria-label="Poznámky deníku v grafu">
      {bands.map(band => (
        <div key={band.id} data-day-band={band.id} aria-hidden="true" style={{ position: 'absolute', visibility: 'hidden', background: band.fill, borderTop: `2px solid ${band.color}`, pointerEvents: 'none' }}>
          <span style={{ position: 'absolute', bottom: 6, left: 6, fontSize: 10.5, fontWeight: 700, letterSpacing: '.02em', whiteSpace: 'nowrap', color: band.color }}>{band.label}</span>
        </div>
      ))}
      <svg ref={svgRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible' }} strokeWidth={1} aria-hidden="true" />
      {nowTime != null && (
        <div data-day-now style={{ position: 'absolute', width: 0, borderLeft: '1px solid rgba(16,185,129,0.6)', visibility: 'hidden' }}>
          <span className="dj-mono" style={{ position: 'absolute', top: 8, left: 6, padding: '2px 7px', borderRadius: 6, fontSize: 10.5, fontWeight: 700, color: '#052e16', background: '#34d399', whiteSpace: 'nowrap' }}>teď {timeLabel(nowTime)}</span>
        </div>
      )}

      {ticks.map(tick => (
        <button
          key={tick.id}
          type="button"
          data-day-tick={tick.id}
          className="dj-tick"
          aria-label={`Hlava ${timeLabel(tick.time)}`}
          title={`Hlava ${timeLabel(tick.time)} — ${tick.text}`}
          onClick={event => { event.stopPropagation(); onSelect(tick.id === selectedId ? null : tick.id); }}
          style={{
            position: 'absolute', visibility: 'hidden', transform: 'translate(-50%,-50%) rotate(45deg)', width: tick.id === selectedId ? 12 : 9, height: tick.id === selectedId ? 12 : 9,
            padding: 0, borderRadius: 2, background: 'var(--dj-mind)', border: `1.5px solid ${tick.id === selectedId ? '#ffffff' : 'rgba(10,15,29,0.85)'}`,
            pointerEvents: placing ? 'none' : 'auto', cursor: 'pointer', zIndex: 6,
          }}
        />
      ))}
      {pins.map(pin => {
        const style = pin.mind ? MIND_STYLE : PHASE_STYLE[pin.phase];
        const selected = pin.id === selectedId;
        const showBubble = !pin.ghost && (bubbles === 'all' || selected);
        const size = selected ? 22 : 18;
        return (
          <React.Fragment key={pin.id}>
            <button
              type="button"
              data-day-pin={pin.id}
              className="dj-pin"
              aria-label={`Poznámka ${pin.meta}`}
              title={pin.ghost ? pin.text : undefined}
              onClick={event => { event.stopPropagation(); if (!pin.ghost) onSelect(selected ? null : pin.id); }}
              style={{
                position: 'absolute', visibility: 'hidden', transform: 'translate(-50%,-50%)', width: pin.ghost ? 14 : size, height: pin.ghost ? 14 : size, borderRadius: 99, padding: 0,
                pointerEvents: placing ? 'none' : 'auto', cursor: pin.ghost ? 'default' : 'pointer', display: 'grid', placeItems: 'center', zIndex: selected ? 7 : 6,
                background: pin.ghost ? 'rgba(129,140,248,0.35)' : style.color,
                border: pin.ghost ? '1.5px dashed #818cf8' : `2px ${pin.phase === 'later' ? 'dashed' : 'solid'} ${selected ? '#ffffff' : '#0a0f1d'}`,
                boxShadow: pin.status === 'failed' ? '0 0 0 3px rgba(244,63,94,0.6)' : pin.status === 'pending' ? '0 0 0 3px rgba(16,185,129,0.4)' : undefined,
                opacity: pin.status === 'pending' ? 0.8 : 1,
              }}
            >
              {!pin.ghost && (pin.mind ? <Brain size={10} strokeWidth={2.6} color="#ffffff" /> : pin.voice ? <Mic size={10} strokeWidth={3} color="#1c1203" /> : <PenLine size={10} strokeWidth={3} color="#1c1203" />)}
            </button>
            {showBubble && (
              <div data-day-bubble={pin.id} style={{ position: 'absolute', visibility: 'hidden', zIndex: selected ? 9 : 5, width: 'max-content', maxWidth: 230, padding: '7px 9px', borderRadius: 8, border: `1px solid ${style.line}`, background: 'rgba(14,16,30,0.95)', color: style.bubble.text, fontSize: 11.5, lineHeight: 1.4, boxShadow: '0 12px 28px -10px rgba(0,0,0,0.8)', pointerEvents: 'none', transform: 'translate(14px, -50%)', animation: 'dj-fade .2s ease both' }}>
                <span className="dj-mono" style={{ display: 'block', fontSize: 9.5, fontWeight: 700, color: style.bubble.accent }}>{pin.meta}</span>
                {bubbles === 'selected' && <span className="dj-mono" style={{ display: 'block', fontSize: 9.5, fontWeight: 500, color: '#8391a7', marginBottom: 3 }}>ukazuje na {timeLabel(pin.time)} · {priceText(pin.price)}</span>}
                <span style={{ display: '-webkit-box', WebkitLineClamp: selected ? 12 : 3, WebkitBoxOrient: 'vertical', overflow: 'hidden', whiteSpace: 'pre-wrap' }}>{pin.text}</span>
                {pin.status === 'failed' && <span style={{ display: 'block', marginTop: 3, fontSize: 10, fontWeight: 700, color: 'var(--dj-rose)' }}>Neuloženo — zkusím znovu</span>}
              </div>
            )}
          </React.Fragment>
        );
      })}

      {pending && (
        <>
          <span data-day-pending aria-hidden="true" style={{ position: 'absolute', visibility: 'hidden', width: 14, height: 14, borderRadius: 99, background: '#818cf8', border: '2px solid #eef2ff', transform: 'translate(-50%,-50%)', zIndex: 9, animation: 'dj-pulse 1.4s ease-out infinite' }} />
          {pendingContent && (
            <div data-day-pending-pop style={{ position: 'absolute', visibility: 'hidden', zIndex: 10, pointerEvents: 'auto', animation: 'dj-fade .18s ease both' }} onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
              {pendingContent}
            </div>
          )}
        </>
      )}

      {placing && (
        <div
          role="application"
          aria-label={placingHint ?? 'Klikni do grafu na čas a cenu'}
          onPointerMove={event => setHover(pointAt(event.clientX, event.clientY))}
          onPointerLeave={() => setHover(null)}
          onClick={event => { const point = pointAt(event.clientX, event.clientY); if (point) onPick({ time: point.time, price: point.price }); }}
          style={{ position: 'absolute', inset: 0, pointerEvents: 'auto', cursor: 'copy', zIndex: 20 }}
        >
          {hover && geo && (
            <>
              <div style={{ position: 'absolute', left: hover.x, top: geo.offsetY, height: geo.paneHeight, width: 0, borderLeft: '1px dashed rgba(203,213,225,0.45)' }} />
              <div style={{ position: 'absolute', top: hover.y, left: geo.offsetX, width: geo.paneWidth, height: 0, borderTop: '1px dashed rgba(203,213,225,0.45)' }} />
              <span className="dj-mono" style={{ position: 'absolute', left: hover.x + 10, top: hover.y - 24, padding: '2px 7px', borderRadius: 6, fontSize: 10.5, fontWeight: 700, color: '#0b0f19', background: '#e2e8f0', whiteSpace: 'nowrap' }}>{timeLabel(hover.time)} · {priceText(hover.price)}</span>
            </>
          )}
          <div style={{ position: 'absolute', left: '50%', top: 12, transform: 'translateX(-50%)', padding: '7px 12px', borderRadius: 9, fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', pointerEvents: 'none', ...(placing === 'voice'
            ? { color: 'var(--dj-rose-soft)', background: 'rgba(76,5,25,0.92)', border: '1px solid rgba(244,63,94,0.5)' }
            : { color: 'var(--dj-indigo-strong)', background: 'rgba(30,27,75,0.92)', border: '1px solid rgba(129,140,248,0.5)' }) }}>
            {placingHint ?? (placing === 'voice' ? 'Klikni, kam patří to, co nadiktuješ' : 'Klikni na čas a cenu, ke které poznámka patří')} · Esc zruší
          </div>
        </div>
      )}
    </div>
  );
}
