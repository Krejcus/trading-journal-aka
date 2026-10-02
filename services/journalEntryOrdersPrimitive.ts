import type { IChartApi, ISeriesApi, ISeriesPrimitive, IPrimitivePaneRenderer, Logical, MouseEventParams, Time } from 'lightweight-charts';
import type { TradeEntryOrder } from '../lib/journalEntryOrders';
import { cancelledOrderOutcome, type EntryOrderOutcome, type OutcomeCandle } from '../lib/entryOrderOutcome';
import type { MarketCandle } from './marketData';
import { createJournalTimeProjection, journalLogicalCoordinate, journalVisibleSpanCoordinates, type JournalCandleCoverage } from './journalChartTime';
import { JOURNAL_BUY_COLOR, JOURNAL_SELL_COLOR, JOURNAL_SL_COLOR, JOURNAL_TP_COLOR } from './journalChartPrimitive';

/**
 * Vstupní příkazy obchodu ve stylu příkazu v TradingView: přerušovaná linka
 * od zadání po vyplnění/zrušení, na začátku cedulka (strana, typ, kusy),
 * posun příkazu = schod. Vyplnění = zelená tečka u šipky vstupu, zrušený
 * příkaz zešedne a končí ✕. Limit čárkovaně, stop tečkovaně.
 *
 * Najetí na linku nebo cedulku: linka zesílí, slabě se ukáže zamýšlený
 * bracket (SL/TP) po dobu čekání a bublina s průběhem příkazu.
 */
const FILL_COLOR = '#10b981';
const CANCEL_COLOR = '#94a3b8';
const CHIP = { height: 16, padX: 5, gap: 4, font: '700 9.5px Inter, system-ui, sans-serif', radius: 3 };
const TIP = { font: '600 11px Inter, system-ui, sans-serif', bold: '800 11.5px Inter, system-ui, sans-serif', line: 16, pad: 9, radius: 7 };
const HIT_Y = 5;

export function entryOrderLabel(order: Pick<TradeEntryOrder, 'side' | 'type' | 'quantity'>): string {
  return `${order.side === 'Buy' ? 'BUY' : 'SELL'} ${order.type === 'Limit' ? 'LMT' : 'STP'}${order.quantity != null ? ` ${order.quantity}` : ''}`;
}

const priceText = (value: number) => value.toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const timeText = (at: number) => new Date(at).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const durationText = (ms: number) => {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return h ? `${h} h ${m} min` : m ? `${m} min ${s} s` : `${s} s`;
};

const moneyText = (value: number) => `${value >= 0 ? '+' : '−'}$${Math.abs(value).toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const clockText = (at: number) => new Date(at).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });

/** „Kdybys nezrušil“ jednou větou (bublina i štítek v grafu). */
export function entryOrderOutcomeText(outcome: EntryOrderOutcome, quantity: number | null, pointValue: number): string {
  if (outcome.kind === 'nofill') return `nevyplnil by se · chybělo ${outcome.missBy.toLocaleString('cs-CZ', { maximumFractionDigits: 2 })} b.`;
  const filled = `vyplnil ${clockText(outcome.fillAt)}`;
  if (outcome.result === 'open') return `${filled} · SL/TP nedosaženo`;
  if (outcome.result === 'ambiguous') return `${filled} · SL i TP v jedné svíčce`;
  const usd = outcome.points != null && quantity != null ? ` · ${moneyText(outcome.points * quantity * pointValue)}` : '';
  return `${filled} → ${outcome.result === 'tp' ? 'TP' : 'SL'} ${clockText(outcome.resultAt!)}${usd}`;
}

/** Řádky bubliny: [popisek, hodnota]; první řádek je titulek. */
export function entryOrderTooltip(order: TradeEntryOrder, outcome?: EntryOrderOutcome | null, pointValue = 2): Array<[string, string]> {
  const rows: Array<[string, string]> = [[`${order.side} ${order.type}${order.quantity != null ? ` · ${order.quantity} ks` : ''}`, '']];
  order.legs.forEach((leg, index) => rows.push([`${index ? 'Posunut' : 'Zadán'} ${timeText(leg.at)}`, priceText(leg.price)]));
  if (order.end) rows.push([`${order.end.kind === 'fill' ? 'Vyplněn' : 'Zrušen'} ${timeText(order.end.at)}`, '']);
  else rows.push(['Stále čeká', '']);
  if (order.end) rows.push([order.end.kind === 'fill' ? 'Čekal na vyplnění' : 'Stál', durationText(order.end.at - order.placedAt)]);
  if (order.bracket?.sl != null) rows.push(['Bracket SL', priceText(order.bracket.sl)]);
  if (order.bracket?.tp != null) rows.push(['Bracket TP', priceText(order.bracket.tp)]);
  if (outcome) rows.push(['Kdybys nezrušil', entryOrderOutcomeText(outcome, order.quantity, pointValue)]);
  return rows;
}

export function createEntryOrdersPrimitive(orders: readonly TradeEntryOrder[], candles: readonly MarketCandle[], intervalSeconds: number,
  chart: IChartApi, series: ISeriesApi<'Candlestick'>, coverage?: JournalCandleCoverage, options: { isDark?: boolean; pointValue?: number } = {}): ISeriesPrimitive<Time> {
  const projection = createJournalTimeProjection(candles, intervalSeconds, coverage);
  const lastAt = candles.length ? (candles[candles.length - 1].time + intervalSeconds) * 1000 - 1 : 0;
  // Pokrytí nese 1m svíčky grafu (typově jen časy) — s cenami je přesnější.
  const coverageCandles = coverage?.candles as readonly Partial<OutcomeCandle>[] | undefined;
  const outcomeCandles: readonly OutcomeCandle[] = coverageCandles?.length && coverageCandles.every(candle => typeof candle.high === 'number' && typeof candle.low === 'number')
    ? coverageCandles as readonly OutcomeCandle[] : candles;
  const shapes = orders.map(order => {
    const until = order.end?.at ?? lastAt;
    return {
      order,
      until,
      bracketSpans: projection.spans(order.placedAt, until),
      // 1m svíčky (pokrytí) dávají přesnější „co by se stalo“ než vyšší timeframe.
      outcome: cancelledOrderOutcome(order, outcomeCandles),
      color: order.end?.kind === 'cancel' ? CANCEL_COLOR : order.side === 'Buy' ? JOURNAL_BUY_COLOR : JOURNAL_SELL_COLOR,
      legs: order.legs.map((leg, index) => {
        const to = Math.max(leg.at, index + 1 < order.legs.length ? order.legs[index + 1].at : until);
        return { ...leg, to, spans: projection.spans(leg.at, to) };
      }),
    };
  });
  // Poslední vykreslená geometrie pro najetí: úseky linek a cedulky.
  const hitLines: Array<{ index: number; left: number; right: number; y: number }> = [];
  const hitChips: Array<{ index: number; left: number; right: number; top: number; bottom: number }> = [];
  let hovered: number | null = null;
  let pointer: { x: number; y: number } | null = null;
  let requestUpdate: (() => void) | null = null;

  const onCrosshair = (param: MouseEventParams<Time>) => {
    const point = param.point ?? null;
    let next: number | null = null;
    if (point) {
      const chip = hitChips.find(box => point.x >= box.left && point.x <= box.right && point.y >= box.top - 2 && point.y <= box.bottom + 2);
      const line = chip ? null : hitLines
        .filter(item => point.x >= item.left - 4 && point.x <= item.right + 4 && Math.abs(point.y - item.y) <= HIT_Y)
        .sort((a, b) => Math.abs(point.y - a.y) - Math.abs(point.y - b.y))[0];
      next = chip?.index ?? line?.index ?? null;
    }
    const moved = next != null && (pointer?.x !== point?.x || pointer?.y !== point?.y);
    pointer = point ? { x: point.x, y: point.y } : null;
    if (next !== hovered || moved) { hovered = next; requestUpdate?.(); }
  };

  const renderer: IPrimitivePaneRenderer = { draw: target => {
    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      const coordinate = (index: number) => chart.timeScale().logicalToCoordinate(index as Logical);
      const x = (at: number) => journalLogicalCoordinate(projection.point(at), coordinate);
      const bg = options.isDark ? '#0b1017' : '#ffffff';
      hitLines.length = 0;
      hitChips.length = 0;
      context.save();
      context.font = CHIP.font;

      // Zamýšlený bracket najetého příkazu (pod linkami příkazů).
      const active = hovered != null ? shapes[hovered] : null;
      if (active?.order.bracket) {
        for (const [price, color, label] of [[active.order.bracket.sl, JOURNAL_SL_COLOR, 'SL'], [active.order.bracket.tp, JOURNAL_TP_COLOR, 'TP']] as const) {
          if (price == null) continue;
          const y = series.priceToCoordinate(price);
          if (y == null) continue;
          context.globalAlpha = 0.75; context.strokeStyle = color; context.lineWidth = 1; context.setLineDash([3, 3]);
          let right: number | null = null;
          for (const span of active.bracketSpans) {
            const bounds = journalVisibleSpanCoordinates(span, coordinate);
            if (!bounds) continue;
            context.beginPath(); context.moveTo(bounds.left, y); context.lineTo(bounds.right, y); context.stroke();
            right = Math.max(right ?? bounds.right, bounds.right);
          }
          if (right != null) {
            context.setLineDash([]); context.globalAlpha = 1;
            context.fillStyle = color; context.font = CHIP.font; context.textBaseline = 'middle';
            context.fillText(`${label} ${priceText(price)}`, Math.min(right + 4, mediaSize.width - 70), y);
          }
        }
      }

      // „Kdybys nezrušil“: tečkovaná dráha od zrušení, vyplnění a výsledek bracketu.
      if (active?.outcome && active.order.end) {
        const outcome = active.outcome;
        const price = active.order.legs[active.order.legs.length - 1].price;
        const py = series.priceToCoordinate(price);
        const cx = x(active.order.end.at);
        const pointValue = options.pointValue ?? 2;
        const badge = (text: string, bx: number, by: number, fill: string, stroke: string, color: string) => {
          context.setLineDash([]); context.globalAlpha = 1; context.font = CHIP.font;
          const w = context.measureText(text).width + 12;
          const left = Math.min(Math.max(2, bx), mediaSize.width - w - 2);
          context.fillStyle = fill; context.strokeStyle = stroke; context.lineWidth = 1;
          context.beginPath(); context.roundRect(left, by - 9, w, 18, 9); context.fill(); context.stroke();
          context.fillStyle = color; context.textBaseline = 'middle'; context.fillText(text, left + 6, by + 0.5);
        };
        if (py != null && cx != null) {
          if (outcome.kind === 'nofill') {
            const kx = x(outcome.closestAt), ky = series.priceToCoordinate(outcome.closestPrice);
            if (kx != null && ky != null) {
              context.globalAlpha = 0.8; context.strokeStyle = CANCEL_COLOR; context.lineWidth = 1.2; context.setLineDash([1, 4]);
              context.beginPath(); context.moveTo(cx, py); context.lineTo(kx, py); context.stroke();
              context.setLineDash([]); context.strokeStyle = '#f59e0b'; context.lineWidth = 1.5; context.globalAlpha = 1;
              context.beginPath(); context.moveTo(kx, py); context.lineTo(kx, ky); context.stroke();
              badge(`chybělo ${outcome.missBy.toLocaleString('cs-CZ', { maximumFractionDigits: 2 })} b.`, kx + 8, (py + ky) / 2, '#fffbeb', '#fcd34d', '#b45309');
            }
          } else {
            const fx = x(outcome.fillAt);
            if (fx != null) {
              context.globalAlpha = 0.85; context.strokeStyle = CANCEL_COLOR; context.lineWidth = 1.2; context.setLineDash([1, 4]);
              context.beginPath(); context.moveTo(cx, py); context.lineTo(fx, py); context.stroke();
              const rx = outcome.resultAt != null ? x(outcome.resultAt) : null;
              const bracket = active.order.bracket;
              if (rx != null && bracket) {
                for (const [level, fill, stroke] of [[bracket.sl, 'rgba(239,68,68,.12)', 'rgba(239,68,68,.55)'], [bracket.tp, 'rgba(16,185,129,.12)', 'rgba(16,185,129,.55)']] as const) {
                  const ly = level == null ? null : series.priceToCoordinate(level);
                  if (ly == null) continue;
                  context.globalAlpha = 1; context.fillStyle = fill; context.strokeStyle = stroke; context.lineWidth = 1; context.setLineDash([4, 3]);
                  context.beginPath(); context.rect(fx, Math.min(py, ly), Math.max(1, rx - fx), Math.abs(ly - py)); context.fill(); context.stroke();
                }
              }
              context.setLineDash([]); context.globalAlpha = 1;
              context.fillStyle = bg; context.strokeStyle = '#64748b'; context.lineWidth = 1.6;
              context.beginPath(); context.arc(fx, py, 4.5, 0, Math.PI * 2); context.fill(); context.stroke();
              if (rx != null && outcome.exitPrice != null) {
                const ey = series.priceToCoordinate(outcome.exitPrice);
                const win = outcome.result === 'tp';
                const color = win ? FILL_COLOR : JOURNAL_SL_COLOR;
                if (ey != null) {
                  context.strokeStyle = color; context.lineWidth = 1.4; context.setLineDash([5, 4]);
                  context.beginPath(); context.moveTo(fx, py); context.lineTo(rx, ey); context.stroke();
                  context.setLineDash([]); context.fillStyle = color; context.strokeStyle = bg; context.lineWidth = 2;
                  context.beginPath(); context.arc(rx, ey, 7, 0, Math.PI * 2); context.fill(); context.stroke();
                  context.strokeStyle = '#ffffff'; context.lineWidth = 1.8; context.lineCap = 'round'; context.beginPath();
                  if (win) { context.moveTo(rx - 3, ey); context.lineTo(rx - 0.8, ey + 2.4); context.lineTo(rx + 3.2, ey - 2.4); }
                  else { context.moveTo(rx - 2.5, ey - 2.5); context.lineTo(rx + 2.5, ey + 2.5); context.moveTo(rx + 2.5, ey - 2.5); context.lineTo(rx - 2.5, ey + 2.5); }
                  context.stroke();
                  const usd = outcome.points != null && active.order.quantity != null ? ` · ${moneyText(outcome.points * active.order.quantity * pointValue)}` : '';
                  badge(`${win ? 'TP' : 'SL'} ${clockText(outcome.resultAt!)}${usd}`, rx + 11, ey,
                    win ? '#ecfdf5' : '#fff1f2', win ? '#6ee7b7' : '#fda4af', win ? '#047857' : '#be123c');
                }
              } else {
                badge(outcome.result === 'ambiguous' ? 'SL i TP v jedné svíčce' : `vyplnil by se ${clockText(outcome.fillAt)}`, fx + 8, py - 16, '#ffffff', '#e2e8f0', '#475569');
              }
            }
          }
        }
      }

      const chips: Array<{ left: number; right: number; top: number; bottom: number }> = [];
      shapes.forEach(({ order, color, legs }, index) => {
        const cancelled = order.end?.kind === 'cancel';
        const isHot = hovered === index;
        context.globalAlpha = hovered != null && !isHot ? 0.35 : cancelled ? 0.85 : 1;
        context.strokeStyle = color;
        context.lineWidth = isHot ? 2.4 : 1.5;
        let previous: { x: number; y: number } | null = null;
        let lastPoint: { x: number; y: number } | null = null;
        for (const leg of legs) {
          const y = series.priceToCoordinate(leg.price);
          if (y == null || !Number.isFinite(y)) { previous = null; continue; }
          context.setLineDash(order.type === 'Limit' ? [6, 4] : [2, 3]);
          for (const span of leg.spans) {
            const bounds = journalVisibleSpanCoordinates(span, coordinate);
            if (!bounds) continue;
            context.beginPath(); context.moveTo(bounds.left, y); context.lineTo(bounds.right, y); context.stroke();
            hitLines.push({ index, left: bounds.left, right: bounds.right, y });
          }
          const start = x(leg.at);
          // Posun příkazu: svislý schod a malé kolečko v novém místě.
          if (previous && start != null) {
            context.setLineDash([]);
            context.beginPath(); context.moveTo(start, previous.y); context.lineTo(start, y); context.stroke();
            context.fillStyle = bg;
            context.beginPath(); context.arc(start, y, 2.6, 0, Math.PI * 2); context.fill(); context.stroke();
          }
          const end = x(leg.to);
          if (start != null) previous = { x: start, y };
          if (end != null) lastPoint = { x: end, y };
        }
        // Cedulka u zadání (vlevo od začátku; u levého okraje vpravo).
        const first = legs[0];
        const fy = first ? series.priceToCoordinate(first.price) : null;
        const fx = first ? x(first.at) : null;
        if (first && fy != null && fx != null) {
          context.font = CHIP.font;
          const text = entryOrderLabel(order);
          const width = context.measureText(text).width + CHIP.padX * 2;
          const left = fx - CHIP.gap - width >= 0 ? fx - CHIP.gap - width : fx + CHIP.gap;
          // Cedulky se nevrství: další příkaz na stejné ceně (přezadání) jde nad linku.
          let top = fy - CHIP.height / 2;
          const overlaps = () => chips.some(chip => left < chip.right && left + width > chip.left && top < chip.bottom && top + CHIP.height > chip.top);
          for (let guard = 0; guard < 4 && overlaps(); guard += 1) top -= CHIP.height + 3;
          chips.push({ left, right: left + width, top, bottom: top + CHIP.height });
          hitChips.push({ index, left, right: left + width, top, bottom: top + CHIP.height });
          if (left < mediaSize.width) {
            context.setLineDash([]);
            context.globalAlpha = hovered != null && !isHot ? 0.45 : 1;
            context.fillStyle = cancelled ? (options.isDark ? '#1e293b' : '#f1f5f9') : color;
            context.strokeStyle = cancelled ? (isHot ? '#64748b' : options.isDark ? '#334155' : '#cbd5e1') : color;
            context.lineWidth = isHot ? 1.5 : 1;
            // Posunutá cedulka má krátkou spojku k začátku své linky.
            if (top !== fy - CHIP.height / 2) {
              context.beginPath(); context.moveTo(left + width / 2, top + CHIP.height); context.lineTo(left + width / 2, fy); context.stroke();
            }
            context.beginPath(); context.roundRect(left, top, width, CHIP.height, CHIP.radius); context.fill(); context.stroke();
            context.fillStyle = cancelled ? '#64748b' : '#ffffff';
            context.textBaseline = 'middle';
            context.fillText(text, left + CHIP.padX, top + CHIP.height / 2 + 0.5);
          }
        }
        // Konec: vyplnění (tečka) nebo zrušení (✕). Čekající příkaz bez značky.
        if (order.end && lastPoint) {
          context.setLineDash([]);
          context.globalAlpha = hovered != null && !isHot ? 0.45 : 1;
          if (order.end.kind === 'fill') {
            context.fillStyle = FILL_COLOR; context.strokeStyle = bg; context.lineWidth = 1.5;
            context.beginPath(); context.arc(lastPoint.x, lastPoint.y, 4.5, 0, Math.PI * 2); context.fill(); context.stroke();
          } else {
            context.fillStyle = bg; context.strokeStyle = options.isDark ? '#475569' : '#cbd5e1'; context.lineWidth = 1;
            context.beginPath(); context.arc(lastPoint.x, lastPoint.y, 6, 0, Math.PI * 2); context.fill(); context.stroke();
            context.strokeStyle = '#64748b'; context.lineWidth = 1.5; context.lineCap = 'round';
            context.beginPath();
            context.moveTo(lastPoint.x - 2.6, lastPoint.y - 2.6); context.lineTo(lastPoint.x + 2.6, lastPoint.y + 2.6);
            context.moveTo(lastPoint.x + 2.6, lastPoint.y - 2.6); context.lineTo(lastPoint.x - 2.6, lastPoint.y + 2.6);
            context.stroke();
          }
        }
      });

      context.restore();
    });
  } };
  // Bublina má vlastní vrstvu nad vším (i nad šipkami obchodu); linky jsou pod nimi.
  const tooltipRenderer: IPrimitivePaneRenderer = { draw: target => {
    const active = hovered != null ? shapes[hovered] : null;
    if (!active || !pointer) return;
    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      context.save();
      // Bublina s průběhem najetého příkazu u kurzoru.
      {
        const rows = entryOrderTooltip(active.order, active.outcome, options.pointValue ?? 2);
        context.setLineDash([]); context.globalAlpha = 1;
        context.font = TIP.font;
        const labelWidth = Math.max(...rows.slice(1).map(([label]) => context.measureText(label).width), 0);
        const valueWidth = Math.max(...rows.slice(1).map(([, value]) => context.measureText(value).width), 0);
        context.font = TIP.bold;
        const titleWidth = context.measureText(rows[0][0]).width + 14;
        const width = Math.max(titleWidth, labelWidth + valueWidth + 18) + TIP.pad * 2;
        const height = rows.length * TIP.line + TIP.pad * 2 - 2;
        let left = pointer.x + 14, top = pointer.y + 14;
        if (left + width > mediaSize.width - 4) left = pointer.x - 14 - width;
        if (top + height > mediaSize.height - 4) top = pointer.y - 14 - height;
        left = Math.max(4, left); top = Math.max(4, top);
        context.fillStyle = '#0f172a';
        context.shadowColor = 'rgba(15,23,42,.35)'; context.shadowBlur = 16; context.shadowOffsetY = 6;
        context.beginPath(); context.roundRect(left, top, width, height, TIP.radius); context.fill();
        context.shadowColor = 'transparent'; context.shadowBlur = 0; context.shadowOffsetY = 0;
        context.textBaseline = 'middle';
        rows.forEach(([label, value], row) => {
          const y = top + TIP.pad + row * TIP.line + TIP.line / 2 - 1;
          if (row === 0) {
            context.fillStyle = active.color === CANCEL_COLOR ? '#94a3b8' : active.color;
            context.beginPath(); context.roundRect(left + TIP.pad, y - 4, 8, 8, 2); context.fill();
            context.font = TIP.bold; context.fillStyle = '#ffffff';
            context.fillText(label, left + TIP.pad + 14, y);
            return;
          }
          context.font = TIP.font;
          context.fillStyle = '#cbd5e1';
          context.fillText(label, left + TIP.pad, y);
          if (value) {
            context.fillStyle = '#ffffff';
            context.fillText(value, left + width - TIP.pad - context.measureText(value).width, y);
          }
        });
      }
      context.restore();
    });
  } };
  const views = [
    { zOrder: () => 'normal' as const, renderer: () => renderer },
    { zOrder: () => 'top' as const, renderer: () => tooltipRenderer },
  ];
  // Čekající příkaz (při přehrávání) má štítek na cenové ose.
  const axisViews = () => shapes.filter(shape => !shape.order.end).flatMap(({ order, color }) => {
    const price = order.legs.at(-1)?.price;
    const y = price == null ? null : series.priceToCoordinate(price);
    return y == null ? [] : [{ coordinate: () => y, text: () => `${order.type === 'Limit' ? 'LMT' : 'STP'} ${price!.toFixed(2)}`,
      textColor: () => '#ffffff', backColor: () => color, visible: () => true, tickVisible: () => true }];
  });
  return {
    attached: params => { requestUpdate = params.requestUpdate; chart.subscribeCrosshairMove(onCrosshair); },
    detached: () => { chart.unsubscribeCrosshairMove(onCrosshair); requestUpdate = null; hovered = null; pointer = null; },
    paneViews: () => views,
    priceAxisViews: axisViews,
  };
}
