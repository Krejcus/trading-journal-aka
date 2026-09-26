import type { IChartApi, ISeriesApi, ISeriesPrimitive, IPrimitivePaneRenderer, Logical, Time } from 'lightweight-charts';
import type { TradeExecutionHistory } from '../lib/tradeExecutionHistory';
import type { MarketCandle } from './marketData';
import { ALPHATRADE_CHART_STYLE as style } from './chartVisualStyle';
import { journalProtectionSegments } from '../lib/journalProtectionSegments';
import { protectionValueAt, tradeFillGroups } from '../lib/tradeReplay';
import { createJournalTimeProjection, journalLogicalCoordinate, journalSpanCoordinates, type JournalCandleCoverage } from './journalChartTime';
export { journalTimeLogical, journalLogicalCoordinate } from './journalChartTime';
export const JOURNAL_SL_COLOR = '#ef4444';
export const JOURNAL_TP_COLOR = '#10b981';
/** Šipky nákupu a prodeje jako u obchodů v TradingView. */
export const JOURNAL_BUY_COLOR = '#2962ff';
export const JOURNAL_SELL_COLOR = '#f23645';

export interface JournalChartOptions {
  /** Pro starší plnění bez strany: vstup Long = Buy, výstup opačně. */
  direction?: string;
  /** Detail: cenová osa zahrne i SL/TP a plnění v záběru, ať je obchod celý vidět. */
  autoscaleLevels?: boolean;
  /** USD za bod (MNQ 2, NQ 20) — pro hodnotu SL/TP po najetí na čáru. */
  pointValue?: number;
  /** Název kontraktu do štítku („9 MNQ“). */
  instrument?: string;
}

/** Tenká šipka; po najetí myší se plynule zvětší a ukáže, co je zač. */
const ARROW = { gap: 3, stem: 13, head: 4, headDepth: 4.5, width: 1.6, hoverScale: 1.3, hitX: 8, animMs: 140 } as const;
/** Čáry SL/TP: tenké, po najetí se celá linie zesílí a ukáže hodnotu v místě kurzoru. */
// Zásah: ±10 px nad/pod čárou a 4 px přes konce úseku (rohy schodů) — na
// tenkou čáru se jinak musí trefit přesně.
const LEVEL = { width: 1, hoverWidth: 2.2, hitY: 10, hitX: 4 } as const;
const signed = (value: number, digits = 2) => `${value >= 0 ? '+' : '−'}${Math.abs(value).toLocaleString('cs-CZ', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
const priceText = (value: number) => value.toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const timeText = (at: number) => new Date(at).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });

export function createJournalChartPrimitive(history: TradeExecutionHistory, candles: readonly MarketCandle[], intervalSeconds: number,
  chart: IChartApi, series: ISeriesApi<'Candlestick'>, coverage?: JournalCandleCoverage, options: JournalChartOptions = {}): ISeriesPrimitive<Time> {
  const projection = createJournalTimeProjection(candles, intervalSeconds, coverage);
  const segments = journalProtectionSegments(history).map(segment => ({ ...segment, spans: projection.spans(segment.from, segment.to) }));
  const long = String(options.direction ?? '').toLowerCase() !== 'short';
  // Dílčí plnění jednoho příkazu = jedna šipka (výstup 1 + 1 + 11 → „Buy 13“).
  const groups = tradeFillGroups(history);
  const lastExit = groups.map(group => group.role).lastIndexOf('exit');
  const closed = history.position?.status !== 'open';
  // Obchod bez SL/TP: výsledkový box od vstupu po výstup (čas) a od průměrného
  // vstupu po průměrný výstup (cena) — ať se obchod v grafu neztratí jen se
  // šipkami. Otevřená pozice (přehrávání) končí na poslední odkryté svíčce.
  const resultBox = (() => {
    if (segments.length) return null;
    const entries = history.fills.filter(fill => fill.role === 'entry');
    const exits = history.fills.filter(fill => fill.role === 'exit');
    if (!entries.length) return null;
    const average = (rows: typeof entries) => rows.reduce((sum, fill) => sum + fill.price * fill.allocatedQuantity, 0)
      / rows.reduce((sum, fill) => sum + fill.allocatedQuantity, 0);
    const from = entries[0].at;
    const openEnd = history.position?.observedThrough ?? null;
    const to = closed && exits.length ? Math.max(...exits.map(fill => fill.at)) : openEnd;
    if (to == null || to <= from) return null;
    const lastCandle = [...candles].reverse().find(candle => candle.time * 1000 <= to);
    const entry = average(entries);
    const exit = closed && exits.length ? average(exits) : lastCandle?.close;
    if (exit == null || !Number.isFinite(exit)) return null;
    const firstSide = entries[0].side;
    const direction = firstSide ? (firstSide === 'Buy' ? 1 : -1) : long ? 1 : -1;
    const points = (exit - entry) * direction;
    const quantity = entries.reduce((sum, fill) => sum + fill.allocatedQuantity, 0);
    // Uzavřený obchod má přesný hrubý výsledek od brokera; jinak odhad z průměrů.
    const usd = closed && history.grossPnl != null ? history.grossPnl : points * (options.pointValue ?? 2) * quantity;
    return { from, to, entry, exit, win: points >= 0, label: `${signed(points)} b. · ${signed(usd)} $`, spans: projection.spans(from, to) };
  })();
  const arrows = groups.map((group, index) => {
    const buy = history.fills.some(fill => fill.side != null) ? group.side === 'Buy' : (group.role === 'entry') === long;
    const role = group.role === 'entry' ? (index === groups.findIndex(item => item.role === 'entry') ? 'Vstup' : 'Přikoupeno')
      : index === lastExit && closed ? 'Výstup' : 'Částečný výstup';
    return { ...group, buy, label: `${role} · ${buy ? 'Buy' : 'Sell'} ${group.quantity} · ${priceText(group.price)} · ${timeText(group.at)}` };
  });
  // Hover: poslední vykreslená poloha šipek, cílová šipka a průběh animace (0–1).
  const hitBoxes: Array<{ x: number; top: number; bottom: number } | null> = [];
  // Průběh animace: šipky podle indexu, čáry podle druhu (`sl`, `tp`).
  const progress = new Map<string, number>();
  const progressOf = (key: string) => progress.get(key) ?? 0;
  let hovered = -1;
  // Čára pod kurzorem: druh, poloha kurzoru a hodnota v tom okamžiku.
  type LineHit = { kind: 'sl' | 'tp'; left: number; right: number; y: number; from: number; to: number; logicalFrom: number; logicalTo: number; price: number };
  const lineHits: LineHit[] = [];
  // Svislé úseky = okamžik posunu SL/TP (z `price` na `nextPrice`).
  type MoveHit = { kind: 'sl' | 'tp'; x: number; top: number; bottom: number; at: number; price: number; nextPrice: number };
  const moveHits: MoveHit[] = [];
  let hoveredLine: { kind: 'sl' | 'tp'; x: number; y: number; at: number; price: number; nextPrice?: number } | null = null;
  let requestUpdate: (() => void) | null = null;
  let frame: number | null = null;
  let lastTick = 0;
  const animate = () => {
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null;
    const settle = (dt: number) => {
      let moving = false;
      const keys = [...arrows.map((_, index) => `a${index}`), 'sl', 'tp'];
      for (const key of keys) {
        const value = progressOf(key);
        const target = key === `a${hovered}` || key === hoveredLine?.kind ? 1 : 0;
        const next = value + Math.sign(target - value) * Math.min(Math.abs(target - value), dt / ARROW.animMs);
        progress.set(key, next);
        if (next !== target) moving = true;
      }
      requestUpdate?.();
      return moving;
    };
    if (!raf) { settle(Infinity); return; }
    if (frame != null) return;
    lastTick = performance.now();
    const step = (now: number) => {
      const dt = now - lastTick; lastTick = now;
      frame = settle(dt) ? raf(step) : null;
    };
    frame = raf(step);
  };
  const onCrosshair = (param: { point?: { x: number; y: number } }) => {
    const point = param.point;
    const next = !point ? -1 : hitBoxes.findIndex(box => box != null
      && Math.abs(point.x - box.x) <= ARROW.hitX && point.y >= box.top - 4 && point.y <= box.bottom + 4);
    // Šipka má přednost; jinak nejbližší úsek SL/TP pod kurzorem — vodorovný
    // (úroveň) nebo svislý (posun), podle toho, ke kterému je kurzor blíž.
    const hit = !point || next >= 0 ? null : lineHits
      .filter(line => point.x >= line.left - LEVEL.hitX && point.x <= line.right + LEVEL.hitX && Math.abs(point.y - line.y) <= LEVEL.hitY)
      .sort((a, b) => Math.abs(point.y - a.y) - Math.abs(point.y - b.y))[0] ?? null;
    const move = !point || next >= 0 ? null : moveHits
      .filter(item => Math.abs(point.x - item.x) <= LEVEL.hitY && point.y >= item.top - LEVEL.hitX && point.y <= item.bottom + LEVEL.hitX)
      .sort((a, b) => Math.abs(point.x - a.x) - Math.abs(point.x - b.x))[0] ?? null;
    const previousKind = hoveredLine?.kind ?? null;
    // Svislý úsek vyhrává, když je kurzor v jeho výšce a těsně u něj — jinak
    // by krátký posun o pár ticků přebily vodorovné čáry kolem něj.
    const moveCloser = move && point && (!hit
      || (point.y > move.top && point.y < move.bottom && Math.abs(point.x - move.x) <= 6)
      || Math.abs(point.x - move.x) < Math.abs(point.y - hit.y));
    hoveredLine = moveCloser && move && point ? {
      kind: move.kind, x: move.x, y: Math.min(move.bottom, Math.max(move.top, point.y)), at: move.at, price: move.price, nextPrice: move.nextPrice,
    } : hit && point ? {
      kind: hit.kind, x: point.x, y: hit.y, price: hit.price,
      // Čas pod kurzorem: lineárně v rámci úseku (logické souřadnice → čas).
      at: hit.logicalTo > hit.logicalFrom
        ? hit.from + (hit.to - hit.from) * Math.min(1, Math.max(0, ((chart.timeScale().coordinateToLogical(point.x) ?? hit.logicalFrom) - hit.logicalFrom) / (hit.logicalTo - hit.logicalFrom)))
        : hit.from,
    } : null;
    if (next === hovered && (hoveredLine?.kind ?? null) === previousKind) {
      // Kurzor se posouvá po téže čáře — štítek jde s ním.
      if (hoveredLine) requestUpdate?.();
      return;
    }
    hovered = next;
    animate();
  };

  const renderer: IPrimitivePaneRenderer = { draw: target => {
    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      const coordinate = (index: number) => chart.timeScale().logicalToCoordinate(index as Logical);
      const x = (at: number) => journalLogicalCoordinate(projection.point(at), coordinate);
      const levelWidth = (kind: 'sl' | 'tp') => { const t = progressOf(kind); return LEVEL.width + (LEVEL.hoverWidth - LEVEL.width) * (1 - (1 - t) ** 3); };
      const line = (left: number, right: number, price: number, color: string, width: number, dashed = false) => {
        const y = series.priceToCoordinate(price);
        if (y == null || !Number.isFinite(y)) return null;
        context.strokeStyle = color; context.lineWidth = width; context.setLineDash(dashed ? [3, 3] : []);
        context.beginPath(); context.moveTo(left, y); context.lineTo(right, y); context.stroke();
        return y;
      };
      context.save();
      lineHits.length = 0;
      moveHits.length = 0;
      for (const segment of segments) {
        // SL červeně, TP zeleně — stejně jako štítky na ose a box pozice.
        const color = segment.kind === 'sl' ? JOURNAL_SL_COLOR : JOURNAL_TP_COLOR;
        const width = levelWidth(segment.kind);
        for (const span of segment.spans) {
          const bounds = journalSpanCoordinates(span, coordinate);
          if (!bounds) continue;
          const y = line(bounds.left, bounds.right, segment.price, color, width, segment.receivedTime);
          const logicalFrom = projection.point(span.from); const logicalTo = projection.point(span.to);
          if (y != null && logicalFrom != null && logicalTo != null) lineHits.push({ kind: segment.kind, left: bounds.left, right: bounds.right, y,
            from: span.from, to: span.to, logicalFrom, logicalTo, price: segment.price });
        }
        if (segment.nextPrice != null && segment.spans.at(-1)?.to === segment.to && projection.point(segment.to) != null) {
          const xx = x(segment.to); const y1 = series.priceToCoordinate(segment.price); const y2 = series.priceToCoordinate(segment.nextPrice);
          if (xx != null && y1 != null && y2 != null) {
            context.strokeStyle = color; context.lineWidth = width; context.setLineDash(segment.receivedTime ? [3, 3] : []);
            context.beginPath(); context.moveTo(xx, y1); context.lineTo(xx, y2); context.stroke();
            moveHits.push({ kind: segment.kind, x: xx, top: Math.min(y1, y2), bottom: Math.max(y1, y2), at: segment.to,
              price: segment.price, nextPrice: segment.nextPrice });
          }
        }
      }
      context.setLineDash([]);
      if (resultBox) {
        const yEntry = series.priceToCoordinate(resultBox.entry); const yExit = series.priceToCoordinate(resultBox.exit);
        if (yEntry != null && yExit != null) {
          const tone = resultBox.win ? JOURNAL_TP_COLOR : JOURNAL_SL_COLOR;
          const top = Math.min(yEntry, yExit); const height = Math.max(1, Math.abs(yEntry - yExit));
          let labelLeft: number | null = null; let labelRight: number | null = null;
          for (const span of resultBox.spans) {
            const bounds = journalSpanCoordinates(span, coordinate);
            if (!bounds) continue;
            context.globalAlpha = 0.16; context.fillStyle = tone; context.fillRect(bounds.left, top, bounds.right - bounds.left, height);
            context.globalAlpha = 0.55; context.strokeStyle = tone; context.lineWidth = 1;
            context.strokeRect(bounds.left + 0.5, top + 0.5, bounds.right - bounds.left - 1, height - 1);
            context.globalAlpha = 1; context.strokeStyle = '#94a3b8'; context.setLineDash([3, 3]);
            context.beginPath(); context.moveTo(bounds.left, yEntry); context.lineTo(bounds.right, yEntry); context.stroke();
            context.setLineDash([]);
            labelLeft = labelLeft == null ? bounds.left : Math.min(labelLeft, bounds.left);
            labelRight = labelRight == null ? bounds.right : Math.max(labelRight, bounds.right);
          }
          if (labelLeft != null && labelRight != null) {
            context.font = '600 10.5px Inter, sans-serif';
            const width = context.measureText?.(resultBox.label)?.width ?? resultBox.label.length * 5.5;
            const pillW = width + 14; const pillH = 19;
            const paneW = mediaSize?.width ?? Infinity;
            const left = Math.max(4, Math.min((labelLeft + labelRight) / 2 - pillW / 2, paneW - pillW - 4));
            const labelTop = top - 6 - pillH < 4 ? top + height + 6 : top - 6 - pillH;
            context.fillStyle = tone;
            context.beginPath();
            if (context.roundRect) context.roundRect(left, labelTop, pillW, pillH, 4); else context.rect(left, labelTop, pillW, pillH);
            context.fill();
            context.fillStyle = '#ffffff'; context.textAlign = 'left'; context.textBaseline = 'middle';
            context.fillText(resultBox.label, left + 7, labelTop + pillH / 2 + 0.5);
          }
        }
      }
      context.lineCap = 'round'; context.lineJoin = 'round';
      // Šipka hrotem na ceně plnění: nákup zespodu nahoru, prodej shora dolů.
      // Zvětšená (hover) se kreslí až nakonec, aby ji ostatní nepřekryly.
      const order = arrows.map((_, index) => index).sort((a, b) => progressOf(`a${a}`) - progressOf(`a${b}`));
      for (const index of order) {
        const arrow = arrows[index];
        const xx = x(arrow.at); const yy = series.priceToCoordinate(arrow.price);
        if (xx == null || yy == null) { hitBoxes[index] = null; continue; }
        const dir = arrow.buy ? 1 : -1;
        const t = progressOf(`a${index}`);
        const ease = 1 - (1 - t) ** 3;
        const scale = 1 + (ARROW.hoverScale - 1) * ease;
        const tip = yy + dir * ARROW.gap;
        const tail = tip + dir * ARROW.stem * scale;
        hitBoxes[index] = { x: xx, top: Math.min(tip, tail), bottom: Math.max(tip, tail) };
        const color = arrow.buy ? JOURNAL_BUY_COLOR : JOURNAL_SELL_COLOR;
        context.strokeStyle = color;
        context.lineWidth = ARROW.width + 0.6 * ease;
        context.shadowColor = color; context.shadowBlur = 8 * ease;
        context.beginPath();
        context.moveTo(xx - ARROW.head * scale, tip + dir * ARROW.headDepth * scale);
        context.lineTo(xx, tip);
        context.lineTo(xx + ARROW.head * scale, tip + dir * ARROW.headDepth * scale);
        context.moveTo(xx, tip);
        context.lineTo(xx, tail);
        context.stroke();
        context.shadowBlur = 0;
        if (t <= 0) continue;
        // Přesná cena plnění a štítek za koncem šipky.
        context.globalAlpha = ease;
        context.fillStyle = color;
        context.beginPath(); context.arc(xx, yy, 2.5, 0, Math.PI * 2); context.fill();
        context.font = '600 10.5px Inter, sans-serif';
        const width = context.measureText?.(arrow.label)?.width ?? arrow.label.length * 5.5;
        const pillW = width + 14; const pillH = 19;
        const paneW = mediaSize?.width ?? Infinity;
        const left = Math.max(4, Math.min(xx - pillW / 2, paneW - pillW - 4));
        const slide = (1 - ease) * 4;
        const top = arrow.buy ? tail + 5 - slide : tail - 5 - pillH + slide;
        context.beginPath();
        if (context.roundRect) context.roundRect(left, top, pillW, pillH, 4); else context.rect(left, top, pillW, pillH);
        context.fill();
        context.fillStyle = '#ffffff'; context.textAlign = 'left'; context.textBaseline = 'middle';
        context.fillText(arrow.label, left + 7, top + pillH / 2 + 0.5);
        context.globalAlpha = 1;
      }
      // Štítek čáry pod kurzorem: úroveň, body a USD pro pozici otevřenou v tu chvíli.
      const lineT = hoveredLine ? progressOf(hoveredLine.kind) : 0;
      if (hoveredLine && lineT > 0) {
        const value = protectionValueAt(history, hoveredLine.price, hoveredLine.at, options.pointValue ?? 2, options.direction);
        const name = hoveredLine.kind === 'sl' ? 'SL' : 'TP';
        // Posun: o kolik se úroveň pohnula ve směru obchodu (+ = ve prospěch).
        const moved = hoveredLine.nextPrice != null
          ? protectionValueAt(history, hoveredLine.nextPrice, hoveredLine.at, options.pointValue ?? 2, options.direction) : null;
        const text = hoveredLine.nextPrice != null ? [
          `${name} ${priceText(hoveredLine.price)} → ${priceText(hoveredLine.nextPrice)}`,
          value && moved ? `${signed(moved.points - value.points)} b.` : null,
          value && moved ? `${signed(moved.usd - value.usd)} $` : null,
          timeText(hoveredLine.at),
        ].filter(Boolean).join(' · ') : [
          `${name} ${priceText(hoveredLine.price)}`,
          value ? `${signed(value.points)} b.` : null,
          value ? `${signed(value.usd)} $` : null,
          value ? `${value.quantity}${options.instrument ? ` ${options.instrument}` : ''}${value.planned ? ' · plán' : ''}` : null,
        ].filter(Boolean).join(' · ');
        const ease = 1 - (1 - lineT) ** 3;
        context.globalAlpha = ease;
        context.font = '600 10.5px Inter, sans-serif';
        const width = context.measureText?.(text)?.width ?? text.length * 5.5;
        const pillW = width + 14; const pillH = 19;
        const paneW = mediaSize?.width ?? Infinity;
        const left = Math.max(4, Math.min(hoveredLine.x - pillW / 2, paneW - pillW - 4));
        const above = hoveredLine.y - 8 - pillH;
        const top = (above < 4 ? hoveredLine.y + 8 : above) + (1 - ease) * 3;
        context.fillStyle = hoveredLine.kind === 'sl' ? JOURNAL_SL_COLOR : JOURNAL_TP_COLOR;
        context.beginPath();
        if (context.roundRect) context.roundRect(left, top, pillW, pillH, 4); else context.rect(left, top, pillW, pillH);
        context.fill();
        context.beginPath(); context.arc(hoveredLine.x, hoveredLine.y, 2.5, 0, Math.PI * 2); context.fill();
        context.fillStyle = '#ffffff'; context.textAlign = 'left'; context.textBaseline = 'middle';
        context.fillText(text, left + 7, top + pillH / 2 + 0.5);
        context.globalAlpha = 1;
      }
      context.restore();
    });
  } };
  const views = [{ zOrder: () => 'top' as const, renderer: () => renderer }];
  return {
    attached: params => {
      requestUpdate = params.requestUpdate;
      chart.subscribeCrosshairMove?.(onCrosshair);
      params.requestUpdate();
    },
    detached: () => {
      chart.unsubscribeCrosshairMove?.(onCrosshair);
      if (frame != null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
      frame = null; requestUpdate = null;
    },
    paneViews: () => views,
    autoscaleInfo: options.autoscaleLevels ? (start: Logical, end: Logical) => {
      const prices: number[] = [];
      const inView = (at: number) => { const point = projection.point(at); return point != null && point >= start && point <= end; };
      for (const segment of segments) {
        if (segment.spans.some(span => {
          const from = projection.point(span.from); const to = projection.point(span.to);
          return from != null && to != null && from <= end && to >= start;
        })) prices.push(segment.price);
      }
      for (const arrow of arrows) if (inView(arrow.at)) prices.push(arrow.price);
      if (resultBox && (inView(resultBox.from) || inView(resultBox.to))) prices.push(resultBox.entry, resultBox.exit);
      if (!prices.length) return null;
      return { priceRange: { minValue: Math.min(...prices), maxValue: Math.max(...prices) } };
    } : undefined,
  };
}
