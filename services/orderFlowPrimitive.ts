/**
 * Kreslení order flow do grafu: Volume profil (pod svíčkami) a Bubliny velkých obchodů (nad nimi).
 * Dvě series primitivy připojené jednou; data čtou z úložiště mimo React a nastavení přes funkce,
 * takže se s tickem ani se změnou nastavení nepřestavují. Kreslí se jen to, co je vidět.
 *
 * JEN ZOBRAZENÍ: nic odsud nevrací cenu, kotaci ani stav použitelný pro příkaz.
 */
import type { IChartApi, IPrimitivePaneRenderer, ISeriesApi, ISeriesPrimitive, Time, UTCTimestamp } from 'lightweight-charts';
import type { OrderFlowStore } from '../lib/orderFlowStore';
import type { BubblesIndicatorSettings, LevelsIndicatorSettings, VolumeProfileIndicatorSettings } from './chartIndicatorSettings';
import { timeframeBucketStart, type MarketTimeframe } from './marketDataCalculations';
import { orderFlowBubbleRadius, orderFlowSizeLabel, selectOrderFlowBubbles } from './orderFlowBubbles';
import { autoRowTicks, buildOrderFlowProfile, orderFlowProfileSegments, type OrderFlowProfile, type ProfileSegment } from './orderFlowProfile';

export interface OrderFlowRange { id: string; from: number; to: number; selected?: boolean }

export interface OrderFlowLayerInputs {
  chart: IChartApi;
  series: ISeriesApi<'Candlestick'>;
  store: OrderFlowStore;
  bubbles: () => BubblesIndicatorSettings;
  profile: () => VolumeProfileIndicatorSettings;
  levels: () => LevelsIndicatorSettings;
  timeframe: () => MarketTimeframe;
  showBubbles: () => boolean;
  showProfile: () => boolean;
  /** Svíčky aktuálního timeframu (čas, high, low) — pro neotestované POC. */
  candles: () => ReadonlyArray<{ time: number; high: number; low: number }>;
  /** Natažené profily (kreslicí nástroj): úseky v sekundách. */
  ranges?: () => readonly OrderFlowRange[];
  isDark: () => boolean;
}

export interface OrderFlowPrimitives {
  profile: ISeriesPrimitive<Time>;
  bubbles: ISeriesPrimitive<Time>;
  /** Data nebo nastavení se změnily — překreslit (nejvýš jednou za snímek). */
  invalidate(): void;
  dispose(): void;
}

const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const PULSE_MS = 700;

const rgba = (hex: string, alpha: number): string => {
  const value = hex.trim().replace('#', '');
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value.slice(0, 6);
  const n = Number.parseInt(full, 16);
  if (!Number.isFinite(n) || full.length !== 6) return `rgba(142,162,196,${alpha})`;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.min(1, Math.max(0, alpha))})`;
};

export const timeframeSecondsOf = (timeframe: MarketTimeframe): number => {
  if (timeframe.endsWith('m')) return Math.max(1, Number(timeframe.slice(0, -1)) || 1) * 60;
  if (timeframe.endsWith('h')) return Math.max(1, Number(timeframe.slice(0, -1)) || 1) * 3_600;
  return 86_400;
};

const compact = (value: number): string => {
  const abs = Math.abs(Math.round(value));
  return abs < 1_000 ? String(abs) : abs < 1_000_000 ? `${(abs / 1_000).toFixed(abs < 10_000 ? 1 : 0).replace('.', ',')} tis.` : `${(abs / 1_000_000).toFixed(1).replace('.', ',')} mil.`;
};
const signed = (value: number): string => `${value > 0 ? '+' : value < 0 ? '−' : ''}${compact(value)}`;

export function createOrderFlowPrimitives(inputs: OrderFlowLayerInputs): OrderFlowPrimitives {
  const { chart, series, store } = inputs;
  let requestProfile: (() => void) | null = null;
  let requestBubbles: (() => void) | null = null;
  let frame: number | null = null;
  let disposed = false;

  const invalidate = (): void => {
    if (disposed || frame !== null) return;
    frame = requestAnimationFrame(() => { frame = null; requestProfile?.(); requestBubbles?.(); });
  };

  // ── Čas → x: svíčka, do které čas patří; když v grafu chybí, nejbližší další ve směru hledání ──
  const xOfTime = (timeSec: number, direction: 1 | -1, timeframe: MarketTimeframe, stepSec: number): number | null => {
    const scale = chart.timeScale();
    let bucket = timeframeBucketStart(timeSec, timeframe);
    for (let attempt = 0; attempt < 90; attempt += 1) {
      const x = scale.timeToCoordinate(bucket as UTCTimestamp);
      if (x !== null) return x;
      bucket = timeframeBucketStart(bucket + direction * stepSec, timeframe);
    }
    return null;
  };

  // ── Úseky a profily (cache) ──
  let segmentCache: { key: string; segments: ProfileSegment[] } | null = null;
  const profileCache = new Map<string, { profile: OrderFlowProfile | null; rev: number; from: number; to: number; params: string }>();
  const touchCache = new Map<string, { length: number; touched: boolean }>();

  const segments = (settings: VolumeProfileIndicatorSettings, levels: LevelsIndicatorSettings): ProfileSegment[] => {
    const minutes = store.minutes();
    const sessions = [
      { name: 'Asie', start: levels.asiaStart, end: levels.asiaEnd },
      { name: 'Londýn', start: levels.londonStart, end: levels.londonEnd },
      { name: 'New York', start: levels.newYorkStart, end: levels.newYorkEnd },
    ];
    const key = `${store.symbol}|${minutes.length}|${minutes[0] ?? 0}|${minutes[minutes.length - 1] ?? 0}|${settings.period}|${levels.timezone}|${sessions.map((s) => `${s.start}-${s.end}`).join(',')}`;
    if (segmentCache?.key !== key) segmentCache = { key, segments: orderFlowProfileSegments(minutes, settings.period, sessions, levels.timezone) };
    return segmentCache.segments;
  };

  const profileFor = (id: string, from: number, to: number, rowTicks: number, valueAreaPercent: number): OrderFlowProfile | null => {
    const params = `${rowTicks}|${valueAreaPercent}|${store.symbol}`;
    const cached = profileCache.get(id);
    if (cached && cached.params === params && cached.from === from && cached.to === to && !store.changedSince(cached.rev, from, to)) return cached.profile;
    const profile = buildOrderFlowProfile(store.minutes(from, to).map((minute) => store.minuteCells(minute)), rowTicks, valueAreaPercent);
    if (profileCache.size > 400) profileCache.clear();
    profileCache.set(id, { profile, rev: store.rev, from, to, params });
    return profile;
  };

  const pocTouched = (id: string, pocPrice: number, afterSec: number): boolean => {
    const candles = inputs.candles();
    const cached = touchCache.get(id);
    if (cached?.touched) return true;
    let start = cached ? Math.max(0, cached.length - 1) : 0;
    if (!cached) {
      let lo = 0; let hi = candles.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (candles[mid].time < afterSec) lo = mid + 1; else hi = mid; }
      start = lo;
    }
    let touched = false;
    for (let i = start; i < candles.length; i += 1) {
      const candle = candles[i];
      if (candle.time >= afterSec && candle.low <= pocPrice && candle.high >= pocPrice) { touched = true; break; }
    }
    if (touchCache.size > 400) touchCache.clear();
    touchCache.set(id, { length: candles.length, touched });
    return touched;
  };

  const drawProfile = (
    context: CanvasRenderingContext2D, profile: OrderFlowProfile, settings: VolumeProfileIndicatorSettings,
    left: number, width: number, height: number, tickSize: number,
  ): { top: number; bottom: number; pocY: number | null } => {
    const alpha = Math.min(1, Math.max(0.05, settings.opacity / 100));
    const deltaMode = settings.display === 'delta';
    const gap = 4;
    const deltaWidth = deltaMode ? Math.max(28, width * 0.32) : 0;
    const volumeWidth = deltaMode ? Math.max(16, width - deltaWidth - gap) : width;
    const deltaCenter = left + volumeWidth + gap + deltaWidth / 2;
    let top = Infinity; let bottom = -Infinity; let pocY: number | null = null;
    for (let row = 0; row < profile.buy.length; row += 1) {
      const buy = profile.buy[row]; const sell = profile.sell[row]; const other = profile.other[row];
      const volume = buy + sell + other;
      if (volume <= 0) continue;
      const low = (profile.rowMin + row) * profile.rowTicks * tickSize;
      const yBottom = series.priceToCoordinate(low - tickSize / 2);
      const yTop = series.priceToCoordinate(low + (profile.rowTicks - 0.5) * tickSize);
      if (yBottom === null || yTop === null) continue;
      if (yTop < top) top = yTop;
      if (yBottom > bottom) bottom = yBottom;
      if (yBottom < 0 || yTop > height) continue;
      const rowHeight = Math.max(1, yBottom - yTop - (yBottom - yTop > 4 ? 1 : 0));
      const isPoc = row === profile.poc;
      const inValueArea = !settings.valueArea || (row >= profile.val && row <= profile.vah);
      const rowAlpha = isPoc ? Math.min(1, alpha + 0.4) : inValueArea ? alpha : alpha * 0.5;
      if (isPoc) pocY = yTop + rowHeight / 2;
      if (settings.display === 'split') {
        const sellLength = sell / profile.maxVolume * volumeWidth;
        const buyLength = buy / profile.maxVolume * volumeWidth;
        const otherLength = other / profile.maxVolume * volumeWidth;
        context.fillStyle = rgba(settings.sellColor, rowAlpha); context.fillRect(left, yTop, sellLength, rowHeight);
        context.fillStyle = rgba(settings.buyColor, rowAlpha); context.fillRect(left + sellLength, yTop, buyLength, rowHeight);
        if (otherLength > 0) { context.fillStyle = rgba(settings.volumeColor, rowAlpha); context.fillRect(left + sellLength + buyLength, yTop, otherLength, rowHeight); }
      } else {
        context.fillStyle = isPoc ? rgba(settings.pocColor, rowAlpha) : rgba(settings.volumeColor, rowAlpha);
        context.fillRect(left, yTop, volume / profile.maxVolume * volumeWidth, rowHeight);
      }
      if (deltaMode && profile.maxAbsDelta > 0) {
        const delta = buy - sell;
        const length = Math.abs(delta) / profile.maxAbsDelta * (deltaWidth / 2);
        context.fillStyle = rgba(delta >= 0 ? settings.buyColor : settings.sellColor, Math.min(1, rowAlpha + 0.25));
        context.fillRect(delta >= 0 ? deltaCenter : deltaCenter - length, yTop, length, rowHeight);
      }
    }
    if (!Number.isFinite(top)) return { top: 0, bottom: 0, pocY: null };
    if (deltaMode) {
      context.strokeStyle = rgba(settings.volumeColor, 0.4); context.lineWidth = 1; context.beginPath();
      context.moveTo(Math.round(deltaCenter) + 0.5, Math.max(0, top)); context.lineTo(Math.round(deltaCenter) + 0.5, Math.min(height, bottom)); context.stroke();
    }
    if (settings.valueArea) {
      context.save(); context.setLineDash([3, 3]); context.strokeStyle = rgba(settings.volumeColor, 0.75); context.lineWidth = 1;
      const vahY = series.priceToCoordinate(((profile.rowMin + profile.vah) * profile.rowTicks + profile.rowTicks - 0.5) * tickSize);
      const valY = series.priceToCoordinate(((profile.rowMin + profile.val) * profile.rowTicks - 0.5) * tickSize);
      for (const y of [vahY, valY]) if (y !== null) { context.beginPath(); context.moveTo(left, Math.round(y) + 0.5); context.lineTo(left + volumeWidth, Math.round(y) + 0.5); context.stroke(); }
      context.restore();
    }
    if (pocY !== null) {
      context.strokeStyle = rgba(settings.pocColor, 0.95); context.lineWidth = 1.5; context.beginPath();
      context.moveTo(left, Math.round(pocY) + 0.5); context.lineTo(left + volumeWidth, Math.round(pocY) + 0.5); context.stroke();
    }
    return { top, bottom, pocY };
  };

  const profileRenderer: IPrimitivePaneRenderer = {
    draw: (target) => {
      target.useMediaCoordinateSpace(({ context, mediaSize }) => {
        const showPeriodic = inputs.showProfile();
        const ranges = inputs.ranges?.() ?? [];
        if ((!showPeriodic && ranges.length === 0) || !store.symbol) return;
        const settings = inputs.profile();
        const timeframe = inputs.timeframe();
        const stepSec = timeframeSecondsOf(timeframe);
        const tickSize = store.tickSize;
        const visible = chart.timeScale().getVisibleRange();
        if (!visible) return;
        const visibleFrom = Number(visible.from); const visibleTo = Number(visible.to) + stepSec;
        const middle = series.coordinateToPrice(mediaSize.height / 2);
        if (middle === null) return;
        const yA = series.priceToCoordinate(middle); const yB = series.priceToCoordinate(Number(middle) + tickSize * 100);
        if (yA === null || yB === null) return;
        const pixelsPerTick = Math.abs(yB - yA) / 100;
        const rowTicks = settings.rowSize === 'auto' ? autoRowTicks(pixelsPerTick, 3) : settings.rowSize;
        const barSpacing = chart.timeScale().options().barSpacing;
        const textColor = inputs.isDark() ? 'rgba(170,182,202,.95)' : 'rgba(71,85,105,.95)';
        context.save();
        context.font = `11px ${FONT}`;
        context.textBaseline = 'alphabetic';

        const drawOne = (id: string, label: string, from: number, to: number, nominalFrom: number, closed: boolean, boxed: boolean, selected: boolean) => {
          const xFrom = xOfTime(from, 1, timeframe, stepSec);
          const xTo = xOfTime(to - 60, -1, timeframe, stepSec);
          if (xFrom === null || xTo === null) return;
          const left = xFrom - barSpacing / 2; const right = Math.max(xTo + barSpacing / 2, left + barSpacing);
          const profile = profileFor(id, from, to, rowTicks, settings.valueAreaPercent);
          if (!profile) {
            if (boxed) {
              context.strokeStyle = 'rgba(41,98,255,.6)'; context.setLineDash([4, 3]); context.strokeRect(Math.round(left) + 0.5, 8.5, Math.round(right - left), mediaSize.height - 17); context.setLineDash([]);
              context.fillStyle = textColor; context.fillText('Pro tento úsek nejsou data order flow', left + 6, 24);
            }
            return;
          }
          const width = Math.max(24, Math.min(280, (right - left) * settings.widthPercent / 100));
          const span = drawProfile(context, profile, settings, left + 1, width, mediaSize.height, tickSize);
          if (boxed) {
            context.fillStyle = `rgba(41,98,255,${selected ? 0.08 : 0.04})`; context.fillRect(left, span.top, right - left, span.bottom - span.top);
            context.strokeStyle = `rgba(41,98,255,${selected ? 0.95 : 0.5})`; context.lineWidth = selected ? 1.5 : 1;
            context.strokeRect(Math.round(left) + 0.5, Math.round(span.top) + 0.5, Math.round(right - left), Math.round(span.bottom - span.top));
          }
          const complete = store.covered(nominalFrom, Math.max(nominalFrom, to - 60));
          if (settings.showLabels || boxed) {
            const pocPrice = ((profile.rowMin + profile.poc) * profile.rowTicks) * tickSize;
            const text = `${label}  Δ ${signed(profile.delta)} · ${compact(profile.total)}${boxed ? ` · POC ${pocPrice.toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : ''}${complete ? '' : ' · neúplný'}`;
            context.fillStyle = complete ? textColor : 'rgba(245,176,65,.95)';
            context.fillText(text, Math.max(4, left + 4), Math.max(12, span.top - 6));
          }
          if (closed && settings.extendPoc && span.pocY !== null && !boxed) {
            const pocPrice = ((profile.rowMin + profile.poc) * profile.rowTicks + (profile.rowTicks - 1) / 2) * tickSize;
            if (!pocTouched(`${id}|${rowTicks}`, pocPrice, to)) {
              const y = Math.round(span.pocY) + 0.5;
              context.save(); context.setLineDash([6, 4]); context.strokeStyle = rgba(settings.pocColor, 0.75); context.lineWidth = 1;
              context.beginPath(); context.moveTo(Math.max(0, right), y); context.lineTo(mediaSize.width, y); context.stroke(); context.restore();
              if (settings.showLabels) {
                context.fillStyle = rgba(settings.pocColor, 0.95); context.font = `10px ${FONT}`;
                const text = `nPOC ${label}`; context.fillText(text, mediaSize.width - context.measureText(text).width - 6, y - 4);
                context.font = `11px ${FONT}`;
              }
            }
          }
        };

        if (showPeriodic) {
          const all = segments(settings, inputs.levels());
          for (let i = 0; i < all.length; i += 1) {
            const segment = all[i];
            const closed = i < all.length - 1;
            const inView = segment.to >= visibleFrom && segment.from <= visibleTo;
            // Úsek mimo záběr se kreslí jen kvůli neotestovanému POC, které do záběru zasahuje zleva.
            if (!inView && !(closed && settings.extendPoc && segment.to < visibleFrom)) continue;
            drawOne(`s:${segment.key}`, segment.label, segment.from, segment.to, segment.nominalFrom, closed, false, false);
          }
        }
        for (const range of ranges) {
          if (range.to < visibleFrom || range.from > visibleTo) continue;
          const from = Math.floor(Math.min(range.from, range.to) / 60) * 60; const to = Math.floor(Math.max(range.from, range.to) / 60) * 60 + 60;
          drawOne(`r:${range.id}`, 'Profil', from, to, from, false, true, range.selected === true);
        }
        context.restore();
      });
    },
  };

  // ── Bubliny ──
  const pulseStart = new Map<string, number>();
  let newestSeen = 0;
  const notePulses = (): void => {
    if (!store.complete) { newestSeen = 0; pulseStart.clear(); return; }
    const now = Date.now();
    const fresh = store.trades(Math.max(newestSeen, now - 5_000));
    for (const trade of fresh) {
      if (!pulseStart.has(trade.id) && now - trade.at < 5_000) pulseStart.set(trade.id, performance.now());
      if (trade.at > newestSeen) newestSeen = trade.at;
    }
    if (pulseStart.size > 500) pulseStart.clear();
  };

  const bubbleRenderer: IPrimitivePaneRenderer = {
    draw: (target) => {
      target.useMediaCoordinateSpace(({ context, mediaSize }) => {
        if (!inputs.showBubbles() || !store.symbol) return;
        const settings = inputs.bubbles();
        const timeframe = inputs.timeframe();
        const stepSec = timeframeSecondsOf(timeframe);
        const visible = chart.timeScale().getVisibleRange();
        if (!visible) return;
        const minSize = Math.max(settings.minSize, store.floor);
        const picked = selectOrderFlowBubbles(store.trades(Number(visible.from) * 1_000, (Number(visible.to) + stepSec) * 1_000), minSize, settings.maxCount);
        if (picked.length === 0) return;
        const fill = Math.min(1, Math.max(0.05, settings.opacity / 100));
        const now = performance.now();
        let pulsing = false;
        const xCache = new Map<number, number | null>();
        context.save();
        context.textBaseline = 'middle';
        for (const trade of picked) {
          const bucket = timeframeBucketStart(Math.floor(trade.at / 1_000), timeframe);
          let x = xCache.get(bucket);
          if (x === undefined) { x = chart.timeScale().timeToCoordinate(bucket as UTCTimestamp); xCache.set(bucket, x); }
          const y = series.priceToCoordinate(trade.price * store.tickSize);
          if (x === null || y === null || x < -40 || x > mediaSize.width + 40 || y < -40 || y > mediaSize.height + 40) continue;
          const color = trade.side > 0 ? settings.buyColor : settings.sellColor;
          const started = pulseStart.get(trade.id);
          const age = started === undefined ? Infinity : now - started;
          const radius = orderFlowBubbleRadius(trade.size, minSize, settings.scale) * (age < 220 ? 0.55 + 0.45 * age / 220 : 1);
          if (age < PULSE_MS) {
            pulsing = true;
            const q = age / PULSE_MS;
            context.strokeStyle = rgba(color, 0.85 * (1 - q)); context.lineWidth = 2;
            context.beginPath(); context.arc(x, y, radius + 3 + q * 18, 0, Math.PI * 2); context.stroke();
          } else if (started !== undefined) pulseStart.delete(trade.id);
          context.fillStyle = rgba(color, fill); context.beginPath(); context.arc(x, y, radius, 0, Math.PI * 2); context.fill();
          context.strokeStyle = rgba(color, 0.95); context.lineWidth = 1; context.stroke();
          if (settings.showSize && radius >= 10) {
            const text = orderFlowSizeLabel(trade.size);
            context.font = `600 10px ${FONT}`; context.fillStyle = 'rgba(255,255,255,.95)';
            context.fillText(text, x - context.measureText(text).width / 2, y + 0.5);
          }
        }
        context.restore();
        if (pulsing) invalidate();
      });
    },
  };

  const unsubscribe = store.subscribe(() => { notePulses(); invalidate(); });
  notePulses();

  const profileViews = [{ zOrder: () => 'bottom' as const, renderer: () => profileRenderer }];
  const bubbleViews = [{ zOrder: () => 'top' as const, renderer: () => bubbleRenderer }];
  return {
    profile: {
      attached: (params) => { requestProfile = params.requestUpdate; params.requestUpdate(); },
      detached: () => { requestProfile = null; },
      updateAllViews: () => undefined,
      paneViews: () => profileViews,
    },
    bubbles: {
      attached: (params) => { requestBubbles = params.requestUpdate; params.requestUpdate(); },
      detached: () => { requestBubbles = null; },
      updateAllViews: () => undefined,
      paneViews: () => bubbleViews,
    },
    invalidate,
    dispose: () => {
      disposed = true;
      unsubscribe();
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null; requestProfile = null; requestBubbles = null;
    },
  };
}
