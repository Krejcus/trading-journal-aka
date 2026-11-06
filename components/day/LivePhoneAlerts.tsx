import React, { useEffect, useRef, useState } from 'react';
import { Bell, X } from 'lucide-react';
import type { ChartViewApi } from '@getcandlekit/charts/react';
import {
  PRICE_ALERT_COLORS, PRICE_ALERT_COLOR_NAMES, alertConditionText, alertLineCss,
  type PriceAlert, type PriceAlertCondition, type PriceAlertExpiry, type PriceAlertFrequency,
  type PriceAlertLineStyle, type PriceAlertLineWidth,
} from '../../lib/priceAlerts';
import { formatLivePrice } from './LivePhoneTrade';
import { clickedOrderType } from '../../lib/liveOrderTicket';
import SheetGrip from './SheetGrip';

/**
 * Upozornění na cenu v LIVE grafu telefonu (náhled EkQateEvNCynqk8rLyQUrr):
 * tenká čára s tlumeným zvonečkem u osy, bez štítku s cenou. Klepnutí čáru
 * jemně zvýrazní (styl zůstane), ukáže cenu na ose a × na zrušení; vybraná
 * jde táhnout (jen v ploše grafu); dvojklep otevře nastavení. Jen UI —
 * hlídání a doručení napojí datová vrstva, nic odsud neobchoduje.
 */

const TICK = 0.25;
const DOUBLE_TAP_MS = 380;
const DRAG_PX = 6;

const rgba = (hex: string, alpha: number) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${alpha})`;
};

/** Pozice čar sleduje graf po snímcích (posun, zoom i autoscale s novou cenou). */
function usePaneTracking(api: ChartViewApi | null, prices: readonly number[]) {
  const [layout, setLayout] = useState<{ ys: (number | null)[]; paneWidth: number; paneHeight: number; scaleWidth: number }>({ ys: [], paneWidth: 0, paneHeight: 0, scaleWidth: 64 });
  const pricesRef = useRef(prices);
  pricesRef.current = prices;
  useEffect(() => {
    if (!api) return undefined;
    let frame = 0;
    let last = '';
    const tick = () => {
      frame = window.requestAnimationFrame(tick);
      try {
        const chart = api.controller.getChart();
        const series = api.controller.getSeries();
        const element = chart.chartElement();
        const scaleWidth = chart.priceScale('right').width();
        const width = element.clientWidth - scaleWidth;
        const height = element.clientHeight - chart.timeScale().height();
        const ys = pricesRef.current.map(price => {
          const y = series.priceToCoordinate(price);
          return y == null ? null : Math.round(y * 2) / 2;
        });
        const key = `${width}|${height}|${scaleWidth}|${ys.join(',')}`;
        if (key !== last) { last = key; setLayout({ ys, paneWidth: width, paneHeight: height, scaleWidth }); }
      } catch { /* graf se přepíná */ }
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [api]);
  return layout;
}

export function LivePhoneAlertLines({ api, alerts, selectedId, flashIds, onSelect, onEdit, onMove, onRemove }: {
  api: ChartViewApi | null;
  alerts: readonly PriceAlert[];
  selectedId: string | null;
  /** Právě spuštěná upozornění: čára a zvoneček krátce zablikají. */
  flashIds: ReadonlySet<string>;
  onSelect: (id: string | null) => void;
  onEdit: (id: string) => void;
  onMove: (id: string, price: number) => void;
  onRemove: (id: string) => void;
}) {
  const [drag, setDrag] = useState<{ id: string; price: number } | null>(null);
  // Při tažení se kreslí cena pod prstem; uložená cena (`alert.price`) zůstává do puštění.
  const shownPrice = (alert: PriceAlert) => (drag?.id === alert.id ? drag.price : alert.price);
  const { ys, paneWidth, paneHeight, scaleWidth } = usePaneTracking(api, alerts.map(shownPrice));
  const pressRef = useRef<{ id: string; y0: number; moved: boolean } | null>(null);
  const lastTapRef = useRef<{ id: string; at: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Klepnutí mimo vybranou čáru výběr zruší.
  useEffect(() => {
    if (!selectedId) return undefined;
    const clear = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target?.closest?.(`[data-alert-line="${selectedId}"]`)) onSelect(null);
    };
    window.addEventListener('pointerdown', clear, true);
    return () => window.removeEventListener('pointerdown', clear, true);
  }, [onSelect, selectedId]);

  if (!api || paneWidth <= 0) return null;
  const priceAt = (clientY: number): number | null => {
    const root = rootRef.current;
    if (!root) return null;
    const rect = root.getBoundingClientRect();
    const y = Math.max(6, Math.min(paneHeight - 6, clientY - rect.top));
    const raw = api.controller.getSeries().coordinateToPrice(y);
    return raw == null || !Number.isFinite(raw) ? null : Math.round(raw / TICK) * TICK;
  };

  return (
    <div ref={rootRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden', zIndex: 14 }} data-price-alert-lines>
      {alerts.map((alert, index) => {
        const y = ys[index];
        if (y == null || y < 0 || y > paneHeight) return null;
        const selected = selectedId === alert.id;
        const flash = flashIds.has(alert.id);
        // Spuštěné „jednou“ už nehlídá nikdo: tlumeně, ať čára netvrdí, že hlídá (posun ho znovu zapne).
        const spent = alert.status === 'triggered';
        const color = alert.line.color;
        const css = alertLineCss(alert.line, selected);
        const showLine = alert.line.width !== 'none' || selected;
        return (
          <div key={alert.id} data-alert-line={alert.id} data-alert-spent={spent ? '' : undefined} style={{ position: 'absolute', left: 0, top: y, width: paneWidth, height: 0, opacity: spent && !selected && !flash ? 0.4 : 1 }}>
            {showLine && <div style={{
              position: 'absolute', left: 0, right: selected ? 52 : 22, top: 0, transform: 'translateY(-50%)',
              borderTop: `${css.width}px ${css.style} ${rgba(color, selected ? 0.9 : 0.55)}`,
              animation: flash ? 'dj-alert-flash .45s ease-in-out 5' : undefined,
            }} />}
            <span aria-hidden style={{ position: 'absolute', right: 6, top: 0, transform: 'translateY(-50%)', width: 16, height: 16, borderRadius: 8, display: 'grid', placeItems: 'center', color: rgba(color, flash || selected ? 1 : 0.45), background: selected ? 'rgba(20,22,36,.72)' : 'transparent', boxShadow: selected ? `0 0 0 1px ${rgba(color, 0.55)}` : undefined, animation: flash ? 'dj-alert-flash .45s ease-in-out 5' : undefined }}>
              <Bell size={10} strokeWidth={2.2} />
            </span>
            {/* Nevybrané upozornění bere dotyk jen na zvonečku (přes čáru jde graf posouvat,
                jako u kreseb); vybrané celou čárou (tah). */}
            <div
              role="button"
              aria-label={`Upozornění ${alertConditionText(alert.condition).toLowerCase()} ${formatLivePrice(alert.price)}${spent ? ' (spuštěno)' : ''}`}
              style={{ position: 'absolute', left: selected ? 0 : undefined, right: 0, width: selected ? undefined : 30, top: selected ? -9 : -12, height: selected ? 18 : 24, pointerEvents: 'auto', touchAction: 'none', cursor: selected ? 'ns-resize' : 'pointer' }}
              onPointerDown={event => {
                event.stopPropagation();
                pressRef.current = { id: alert.id, y0: event.clientY, moved: false };
                try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* syntetická událost */ }
              }}
              onPointerMove={event => {
                const press = pressRef.current;
                if (!press || press.id !== alert.id) return;
                if (Math.abs(event.clientY - press.y0) > DRAG_PX) press.moved = true;
                if (!press.moved || selectedId !== alert.id) return;
                const price = priceAt(event.clientY);
                if (price != null) setDrag({ id: alert.id, price });
              }}
              onPointerUp={() => {
                const press = pressRef.current;
                pressRef.current = null;
                if (!press) return;
                if (drag?.id === alert.id) {
                  const to = drag.price;
                  setDrag(null);
                  if (to !== alert.price) onMove(alert.id, to);
                  return;
                }
                if (press.moved) return;
                const now = Date.now();
                const last = lastTapRef.current;
                if (last && last.id === alert.id && now - last.at < DOUBLE_TAP_MS) { lastTapRef.current = null; onEdit(alert.id); return; }
                lastTapRef.current = { id: alert.id, at: now };
                onSelect(alert.id);
              }}
              onPointerCancel={() => { pressRef.current = null; setDrag(null); }}
            />
            {selected && <>
              <button type="button" className="dj-btn" aria-label="Zrušit upozornění" onPointerDown={event => event.stopPropagation()} onClick={() => onRemove(alert.id)}
                style={{ position: 'absolute', right: 28, top: 0, transform: 'translateY(-50%)', width: 18, height: 18, borderRadius: 9, border: '1px solid rgba(251,113,133,.5)', background: 'rgba(239,70,85,.28)', color: '#fecaca', display: 'grid', placeItems: 'center', padding: 0, pointerEvents: 'auto', cursor: 'pointer' }}>
                <X size={11} />
              </button>
              <span style={{ position: 'absolute', left: paneWidth + 2, top: 0, transform: 'translateY(-50%)', width: scaleWidth - 4, height: 18, borderRadius: 4, display: 'grid', placeItems: 'center', background: rgba(color, 0.8), color: '#fff', fontSize: 9.5, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>
                {formatLivePrice(shownPrice(alert))}
              </span>
            </>}
          </div>
        );
      })}
    </div>
  );
}

/** Malé průsvitné plusko u cenové osy, když je vidět crosshair. */
export function LivePhoneCrosshairPlus({ api, onPlus }: { api: ChartViewApi | null; onPlus: (price: number) => void }) {
  const [point, setPoint] = useState<{ y: number; x: number } | null>(null);
  useEffect(() => {
    if (!api) return undefined;
    const chart = api.controller.getChart();
    const handler = (param: { point?: { x: number; y: number } }) => setPoint(param.point ? { x: param.point.x, y: param.point.y } : null);
    chart.subscribeCrosshairMove(handler);
    return () => chart.unsubscribeCrosshairMove(handler);
  }, [api]);
  if (!api || !point) return null;
  let paneWidth = 0;
  try { paneWidth = api.controller.getChart().chartElement().clientWidth - api.controller.getChart().priceScale('right').width(); } catch { return null; }
  return (
    <button
      type="button"
      aria-label="Akce na ceně crosshairu"
      className="dj-btn"
      onPointerDown={event => event.stopPropagation()}
      onClick={() => {
        const raw = api.controller.getSeries().coordinateToPrice(point.y);
        if (raw != null && Number.isFinite(raw)) onPlus(Math.round(raw / TICK) * TICK);
      }}
      style={{ position: 'absolute', left: paneWidth - 22, top: point.y, transform: 'translateY(-50%)', zIndex: 130, pointerEvents: 'auto', width: 16, height: 16, borderRadius: 5, padding: 0, display: 'grid', placeItems: 'center', fontSize: 12, lineHeight: 1, color: 'rgba(232,236,246,.9)', background: 'rgba(255,255,255,.07)', border: '1px solid rgba(190,200,255,.28)', backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)', cursor: 'pointer' }}
    >
      +
      <span aria-hidden style={{ position: 'absolute', inset: -12 }} />
    </button>
  );
}

const sheetSection: React.CSSProperties = { position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '88%', overflowY: 'auto', borderRadius: '20px 20px 0 0', background: 'var(--dj-sheet, var(--dj-card))', borderTop: '1px solid var(--dj-line)', padding: '8px 0 calc(16px + var(--dj-safe-bottom, env(safe-area-inset-bottom, 0px)))', animation: 'dj-sheet .26s cubic-bezier(.2,.9,.25,1) both' };

function Sheet({ label, onClose, children }: { label: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 46 }}>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)', animation: 'dj-fade .18s ease both' }} />
      <section aria-label={label} className="dj-scroll" style={sheetSection}>
        <div style={{ padding: '0 16px' }}><SheetGrip onClose={onClose} gap={6} /></div>
        {children}
      </section>
    </div>
  );
}

function Seg<T extends string>({ value, options, onChange }: { value: T; options: ReadonlyArray<[T, string]>; onChange: (value: T) => void }) {
  return (
    <div style={{ display: 'flex', gap: 4, padding: 3, borderRadius: 11, border: '1px solid var(--dj-line)', background: 'rgba(255,255,255,.04)' }}>
      {options.map(([key, label]) => (
        <button key={key} type="button" className="dj-btn" aria-pressed={value === key} onClick={() => onChange(key)}
          style={{ flex: 1, minHeight: 32, borderRadius: 8, border: 0, cursor: 'pointer', fontSize: 12, fontWeight: 650, color: value === key ? 'var(--dj-text)' : 'var(--dj-muted)', background: value === key ? 'rgba(143,163,255,.16)' : 'transparent' }}>{label}</button>
      ))}
    </div>
  );
}

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div style={{ display: 'grid', gap: 6, padding: '7px 16px' }}>
    <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--dj-muted)' }}>{label}</span>
    {children}
  </div>
);

function Toggle({ on, label, sub, onChange }: { on: boolean; label: string; sub: string; onChange: (on: boolean) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--dj-line)', fontSize: 13.5 }}>
      <div>{label}<small style={{ display: 'block', fontSize: 11, color: 'var(--dj-muted)' }}>{sub}</small></div>
      <button type="button" role="switch" aria-checked={on} aria-label={label} className="dj-btn" onClick={() => onChange(!on)}
        style={{ position: 'relative', flex: 'none', width: 44, height: 26, borderRadius: 13, border: 0, padding: 0, cursor: 'pointer', background: on ? '#22c55e' : 'rgba(255,255,255,.16)', transition: 'background .2s' }}>
        <span style={{ position: 'absolute', top: 3, left: 3, width: 20, height: 20, borderRadius: 10, background: '#fff', transform: on ? 'translateX(18px)' : 'none', transition: 'transform .2s' }} />
      </button>
    </div>
  );
}

/** Nastavení upozornění (dvojklep na čáru). Uložené nastavení dostanou i další nová upozornění. */
export function LivePhoneAlertSheet({ alert, market, onSave, onDelete, onClose }: {
  alert: PriceAlert;
  market: number | null;
  onSave: (alert: PriceAlert) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<PriceAlert>(alert);
  const set = (patch: Partial<PriceAlert>) => setDraft(current => ({ ...current, ...patch }));
  const distance = market == null ? null : draft.price - market;
  const anyChannel = draft.channels.phone || draft.channels.voice || draft.channels.pc;
  return (
    <Sheet label="Upozornění" onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', padding: '2px 16px 6px' }}>
        <b style={{ fontSize: 16 }}>Upozornění</b>
        <span style={{ fontSize: 12, color: 'var(--dj-muted)' }}>{draft.symbol}</span>
      </div>
      <Field label="Cena">
        <div style={{ display: 'grid', gridTemplateColumns: '42px minmax(0,1fr) 42px', gap: 6 }}>
          <button type="button" className="dj-btn" aria-label="O tick níž" onClick={() => set({ price: draft.price - TICK })} style={{ height: 38, borderRadius: 10, border: 0, background: 'rgba(255,255,255,.07)', color: 'var(--dj-text)', fontSize: 18, cursor: 'pointer' }}>−</button>
          <output className="dj-mono" style={{ height: 38, borderRadius: 10, border: '1px solid var(--dj-line)', display: 'grid', placeItems: 'center', fontSize: 16, fontWeight: 700 }}>{formatLivePrice(draft.price)}</output>
          <button type="button" className="dj-btn" aria-label="O tick výš" onClick={() => set({ price: draft.price + TICK })} style={{ height: 38, borderRadius: 10, border: 0, background: 'rgba(255,255,255,.07)', color: 'var(--dj-text)', fontSize: 18, cursor: 'pointer' }}>+</button>
        </div>
        {distance != null && <span className="dj-mono" style={{ fontSize: 11.5, color: 'var(--dj-muted)' }}>{Math.abs(distance) < TICK / 2 ? 'na trhu' : `${Math.abs(distance).toFixed(2)} b ${distance > 0 ? 'nad' : 'pod'} trhem`}</span>}
      </Field>
      <Field label="Podmínka"><Seg<PriceAlertCondition> value={draft.condition} onChange={condition => set({ condition, conditionAuto: false })} options={[['cross', 'Překročí'], ['up', 'Nahoru přes'], ['down', 'Dolů přes']]} /></Field>
      <Field label="Spustit"><Seg<PriceAlertFrequency> value={draft.frequency} onChange={frequency => set({ frequency })} options={[['once', 'Jednou'], ['every', 'Pokaždé, max 1×/min']]} /></Field>
      <Field label="Čára · tloušťka"><Seg<PriceAlertLineWidth> value={draft.line.width} onChange={width => set({ line: { ...draft.line, width } })} options={[['thin', 'Tenká'], ['thick', 'Tlustá'], ['none', 'Jen zvoneček']]} /></Field>
      <Field label="Čára · styl"><Seg<PriceAlertLineStyle> value={draft.line.style} onChange={style => set({ line: { ...draft.line, style } })} options={[['solid', 'Plná'], ['dashed', 'Čárkovaná'], ['dotted', 'Tečkovaná']]} /></Field>
      <Field label="Barva">
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {PRICE_ALERT_COLORS.map(color => (
            <button key={color} type="button" className="dj-btn" aria-label={PRICE_ALERT_COLOR_NAMES[color]} aria-pressed={draft.line.color === color} onClick={() => set({ line: { ...draft.line, color } })}
              style={{ width: 28, height: 28, borderRadius: 14, padding: 0, cursor: 'pointer', background: color, border: `2px solid ${draft.line.color === color ? '#fff' : 'transparent'}`, boxShadow: 'inset 0 0 0 2px rgba(0,0,0,.35)' }} />
          ))}
        </div>
      </Field>
      <Field label="Platnost"><Seg<PriceAlertExpiry> value={draft.expiry} onChange={expiry => set({ expiry })} options={[['session', 'Do konce seance'], ['gtc', 'Do zrušení']]} /></Field>
      <Field label="Kam poslat">
        <div>
          <Toggle on={draft.channels.phone} label="Notifikace do iPhonu" sub="běžná notifikace, i při zamčeném telefonu" onChange={phone => set({ channels: { ...draft.channels, phone } })} />
          <Toggle on={draft.channels.voice} label="Hlasem" sub="telefon i PC přečtou upozornění nahlas" onChange={voice => set({ channels: { ...draft.channels, voice } })} />
          <Toggle on={draft.channels.pc} label="Na PC" sub="karta vlevo dole jako u obchodů" onChange={pc => set({ channels: { ...draft.channels, pc } })} />
          <Toggle on={draft.channels.sound} label="Zvuk" sub="telefon i PC" onChange={sound => set({ channels: { ...draft.channels, sound } })} />
        </div>
      </Field>
      <Field label="Poznámka">
        <input value={draft.note} maxLength={60} placeholder="např. retest dHigh, čekám na BoS" onChange={event => set({ note: event.target.value })}
          style={{ height: 38, borderRadius: 10, border: '1px solid var(--dj-line)', background: 'rgba(255,255,255,.04)', color: 'var(--dj-text)', padding: '0 10px', fontSize: 13.5 }} />
      </Field>
      {!anyChannel && <p style={{ margin: '4px 16px 0', fontSize: 12, color: '#fbbf24' }}>Zapni aspoň telefon, hlas, nebo PC.</p>}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.6fr', gap: 8, padding: '10px 16px 0' }}>
        <button type="button" className="dj-btn" onClick={() => onDelete(alert.id)} style={{ height: 46, borderRadius: 13, border: 0, cursor: 'pointer', fontWeight: 750, fontSize: 14.5, color: '#fb7185', background: 'rgba(255,255,255,.08)' }}>Smazat</button>
        <button type="button" className="dj-btn" disabled={!anyChannel} onClick={() => onSave(draft)} style={{ height: 46, borderRadius: 13, border: 0, cursor: 'pointer', fontWeight: 750, fontSize: 14.5, color: '#1b1203', background: 'linear-gradient(180deg,#f5b53d,#e89a12)', opacity: anyChannel ? 1 : 0.5 }}>Uložit</button>
      </div>
    </Sheet>
  );
}

/** Seznam upozornění (zvonek ve spodní liště). */
export function LivePhoneAlertList({ alerts, watching, error, onEdit, onRemove, onClose }: {
  alerts: readonly PriceAlert[];
  /** Poslední trvalá chyba uložení na server (operace zahozená). */
  error?: string | null;
  /** Kdo upozornění hlídá — text od datové vrstvy; null = zatím nikdo (jen v tomto zařízení). */
  watching: string | null;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
  onClose: () => void;
}) {
  const activeCount = alerts.filter(alert => alert.status !== 'triggered').length;
  return (
    <Sheet label="Upozornění" onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', padding: '2px 16px 10px' }}>
        <b style={{ fontSize: 16 }}>Upozornění</b>
        <span style={{ fontSize: 12, color: 'var(--dj-muted)' }}>{activeCount} {activeCount === 1 ? 'aktivní' : 'aktivních'}</span>
      </div>
      <div style={{ margin: '0 16px 10px', padding: '9px 11px', borderRadius: 11, fontSize: 12, display: 'flex', gap: 8, alignItems: 'center', background: watching ? 'rgba(34,197,94,.1)' : 'rgba(242,166,35,.12)', color: watching ? '#86efac' : '#fcd34d' }}>
        <i style={{ width: 7, height: 7, borderRadius: 4, flex: 'none', background: watching ? '#22c55e' : '#f2a623' }} />
        {watching ?? 'Upozornění teď nikdo nehlídá — Mac worker neběží nebo nemá cenu z IBKR. Křížení mezitím se nedoženou.'}
      </div>
      {error && <div role="alert" style={{ margin: '0 16px 10px', padding: '9px 11px', borderRadius: 11, fontSize: 12, background: 'rgba(239,70,85,.12)', color: '#fda4af' }}>{error}</div>}
      {alerts.length === 0 && <p style={{ margin: 0, padding: '6px 16px 0', fontSize: 13, color: 'var(--dj-muted)' }}>Žádné upozornění. Podrž prst na grafu a klepni na +.</p>}
      {alerts.map(alert => {
        const channels = [alert.channels.phone && 'iPhone', alert.channels.voice && 'hlas', alert.channels.pc && 'PC'].filter(Boolean).join(' + ');
        const spent = alert.status === 'triggered';
        return (
          <div key={alert.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: 8, alignItems: 'center', padding: '10px 16px', borderBottom: '1px solid var(--dj-line)' }}>
            <button type="button" className="dj-btn" onClick={() => onEdit(alert.id)} style={{ minWidth: 0, textAlign: 'left', border: 0, background: 'transparent', color: 'var(--dj-text)', padding: 0, cursor: 'pointer' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13.5, fontWeight: 700 }}>
                <span style={{ width: 8, height: 8, borderRadius: 4, background: alert.line.color, flex: 'none' }} />
                <span className="dj-mono">{alertConditionText(alert.condition)} {formatLivePrice(alert.price)}</span>
              </div>
              <div style={{ marginTop: 3, fontSize: 11.5, color: 'var(--dj-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {spent ? 'spuštěno — nehlídá se, posun nebo změna podmínky ho znovu zapne · ' : ''}{alert.frequency === 'once' ? 'jednou' : 'pokaždé'} · {alert.expiry === 'session' ? 'do konce seance' : 'do zrušení'} · {channels || 'bez kanálu'}{alert.note ? ` · ${alert.note}` : ''}
              </div>
            </button>
            <button type="button" className="dj-btn" onClick={() => onRemove(alert.id)} style={{ height: 30, padding: '0 10px', borderRadius: 9, border: 0, cursor: 'pointer', fontSize: 12, fontWeight: 700, background: 'rgba(239,70,85,.14)', color: '#fb7185' }}>Smazat</button>
          </div>
        );
      })}
      <p style={{ margin: 0, padding: '10px 16px 0', fontSize: 11, color: 'var(--dj-muted)', opacity: 0.8 }}>Upozornění jen hlásí, nikdy nic neobchoduje.</p>
    </Sheet>
  );
}

/** Menu plusu u crosshairu: limit/stop na ceně, upozornění, vodorovná čára. */
export function LivePhonePlusSheet({ price, market, quote, quantity, onOrder, onAlert, onLine, onClose }: {
  price: number;
  market: number | null;
  /** Čerstvá kotace (≤ 3 s); typ příkazu podle ní jako na PC. null = příkaz z plusu teď nejde. */
  quote: { bid: number; ask: number } | null;
  quantity: number;
  onOrder: (side: 'buy' | 'sell', type: 'market' | 'limit' | 'stop') => void;
  onAlert: () => void;
  onLine: () => void;
  onClose: () => void;
}) {
  const above = market != null && price > market;
  const distance = market == null ? null : Math.abs(price - market);
  const buyType = quote ? clickedOrderType('buy', price, quote, TICK) : null;
  const sellType = quote ? clickedOrderType('sell', price, quote, TICK) : null;
  const typeHint = (side: 'buy' | 'sell', type: string | null) => (type == null ? 'cena trhu není čerstvá — příkaz teď nejde'
    : type === 'market' ? 'na trhu' : type === 'limit' ? (side === 'buy' ? 'vstup long pod trhem' : 'vstup short nad trhem')
      : side === 'buy' ? 'vstup long při průrazu nahoru' : 'vstup short při průrazu dolů');
  const row = (key: string, icon: React.ReactNode, iconStyle: React.CSSProperties, title: string, sub: string, onClick: () => void) => (
    <button key={key} type="button" className="dj-btn" onClick={onClick} style={{ width: '100%', display: 'grid', gridTemplateColumns: '32px minmax(0,1fr) auto', gap: 10, alignItems: 'center', padding: '11px 16px', border: 0, borderBottom: '1px solid var(--dj-line)', background: 'transparent', color: 'var(--dj-text)', textAlign: 'left', cursor: 'pointer' }}>
      <span style={{ width: 30, height: 30, borderRadius: 9, display: 'grid', placeItems: 'center', fontSize: 12, fontWeight: 800, ...iconStyle }}>{icon}</span>
      <span><b style={{ display: 'block', fontSize: 14.5, fontWeight: 650 }}>{title}</b><small style={{ fontSize: 11.5, color: 'var(--dj-muted)' }}>{sub}</small></span>
      <span className="dj-mono" style={{ fontSize: 12, color: 'var(--dj-muted)' }}>{formatLivePrice(price)}</span>
    </button>
  );
  return (
    <Sheet label="Akce na ceně" onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', padding: '2px 16px 8px' }}>
        <b className="dj-mono" style={{ fontSize: 16 }}>{formatLivePrice(price)}</b>
        <span style={{ fontSize: 12, color: 'var(--dj-muted)' }}>{distance == null ? '' : distance < TICK / 2 ? 'na trhu' : `${distance.toFixed(2)} b ${above ? 'nad' : 'pod'} trhem`}</span>
      </div>
      {row('buy', 'B', { background: 'rgba(37,99,235,.2)', color: '#93b4ff', opacity: buyType ? 1 : 0.45 }, `Koupit ${quantity}${buyType ? ` ${buyType}` : ''}`, typeHint('buy', buyType), () => { if (buyType) onOrder('buy', buyType); })}
      {row('sell', 'S', { background: 'rgba(225,29,72,.2)', color: '#fda4af', opacity: sellType ? 1 : 0.45 }, `Prodat ${quantity}${sellType ? ` ${sellType}` : ''}`, typeHint('sell', sellType), () => { if (sellType) onOrder('sell', sellType); })}
      {row('alert', <Bell size={16} />, { background: 'rgba(245,181,61,.18)', color: '#fcd34d' }, 'Přidat upozornění', 'hned, podle tvého nastavení', onAlert)}
      {row('line', '—', { background: 'rgba(148,163,184,.16)', color: '#cbd5e1' }, 'Vodorovná čára', 'kresba do grafu', onLine)}
    </Sheet>
  );
}

/** Zvonek ve spodní liště grafu (seznam upozornění). */
export function LivePhoneAlertsButton({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <button type="button" className="dj-btn" aria-label={`Upozornění (${count})`} onClick={onClick}
      style={{ position: 'relative', width: 36, height: 36, borderRadius: 10, border: 0, padding: 0, display: 'grid', placeItems: 'center', background: 'transparent', color: 'var(--dj-text)', cursor: 'pointer' }}>
      <Bell size={18} />
      {count > 0 && <span style={{ position: 'absolute', top: 4, right: 4, minWidth: 14, height: 14, borderRadius: 7, padding: '0 3px', boxSizing: 'border-box', fontSize: 9, fontWeight: 800, lineHeight: '14px', textAlign: 'center', color: '#1b1203', background: '#f5b53d' }}>{count}</span>}
    </button>
  );
}
