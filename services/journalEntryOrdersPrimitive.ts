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
 * Najetí na linku nebo cedulku (animovaně): linka zesílí, bracket SL/TP je
 * jedna souvislá čára od zadání po výsledek, u zrušeného příkazu se dokreslí
 * „kdybys ho nezrušil“ (vyplnění, slabý box pozice, výsledek) a bublina.
 */
const FILL_COLOR = '#10b981';
const CANCEL_COLOR = '#94a3b8';
const AMBER = '#f59e0b';
const FONT = 'Inter, system-ui, sans-serif';
const CHIP = { height: 16, padX: 5, gap: 4, font: `700 9.5px ${FONT}`, radius: 3 };
const HIT_Y = 5;
/** Délka nástupní animace po najetí (ms). */
const ANIM_MS = 900;

export function entryOrderLabel(order: Pick<TradeEntryOrder, 'side' | 'type' | 'quantity'>): string {
  return `${order.side === 'Buy' ? 'BUY' : 'SELL'} ${order.type === 'Limit' ? 'LMT' : 'STP'}${order.quantity != null ? ` ${order.quantity}` : ''}`;
}

const priceText = (value: number) => value.toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const timeText = (at: number) => new Date(at).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const clockText = (at: number) => new Date(at).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
const pointsText = (value: number) => value.toLocaleString('cs-CZ', { maximumFractionDigits: 2 });
const moneyText = (value: number) => `${value >= 0 ? '+' : '−'}$${Math.abs(value).toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const durationText = (ms: number) => {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return h ? `${h} h ${m} min` : m ? `${m} min ${s} s` : `${s} s`;
};
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const easeOut = (t: number) => 1 - (1 - t) ** 3;
const backOut = (t: number) => { const c = 1.7; return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2; };
/** Podíl animace mezi `from` a `to` (0–1 z celé doby). */
const phase = (t: number, from: number, to: number) => clamp01((t - from) / (to - from));

/** Karta „Kdybys nezrušil“: tón, velký údaj a podtitulek. */
export function entryOrderOutcomeCard(outcome: EntryOrderOutcome, quantity: number | null, pointValue: number) {
  if (outcome.kind === 'nofill') {
    return { tone: 'amber' as const, value: `chybělo ${pointsText(outcome.missBy)} b.`, sub: `nevyplnil by se · nejblíž ${priceText(outcome.closestPrice)} v ${clockText(outcome.closestAt)}` };
  }
  const filled = `vyplnil by se ${clockText(outcome.fillAt)}`;
  if (outcome.result === 'ambiguous') return { tone: 'slate' as const, value: 'SL i TP v jedné svíčce', sub: `${filled} · výsledek nelze určit` };
  if (outcome.result === 'open') return { tone: 'slate' as const, value: 'bez výsledku', sub: `${filled} · SL ani TP nepadl` };
  const usd = outcome.points != null && quantity != null ? moneyText(outcome.points * quantity * pointValue) : `${outcome.points! >= 0 ? '+' : '−'}${pointsText(Math.abs(outcome.points ?? 0))} b.`;
  return { tone: outcome.result === 'tp' ? 'green' as const : 'red' as const, value: usd,
    sub: `${filled} → ${outcome.result === 'tp' ? 'TP' : 'SL'} ${clockText(outcome.resultAt!)} · ${outcome.points! >= 0 ? '+' : '−'}${pointsText(Math.abs(outcome.points!))} b.` };
}

const TONES = {
  green: { light: { bg: '#ecfdf5', border: '#a7f3d0', ink: '#047857' }, dark: { bg: 'rgba(16,185,129,.12)', border: 'rgba(16,185,129,.35)', ink: '#34d399' } },
  red: { light: { bg: '#fff1f2', border: '#fecdd3', ink: '#be123c' }, dark: { bg: 'rgba(244,63,94,.12)', border: 'rgba(244,63,94,.35)', ink: '#fb7185' } },
  amber: { light: { bg: '#fffbeb', border: '#fde68a', ink: '#b45309' }, dark: { bg: 'rgba(245,158,11,.12)', border: 'rgba(245,158,11,.35)', ink: '#fbbf24' } },
  slate: { light: { bg: '#f8fafc', border: '#e2e8f0', ink: '#334155' }, dark: { bg: 'rgba(148,163,184,.10)', border: 'rgba(148,163,184,.25)', ink: '#cbd5e1' } },
};

export function createEntryOrdersPrimitive(orders: readonly TradeEntryOrder[], candles: readonly MarketCandle[], intervalSeconds: number,
  chart: IChartApi, series: ISeriesApi<'Candlestick'>, coverage?: JournalCandleCoverage, options: { isDark?: boolean; pointValue?: number } = {}): ISeriesPrimitive<Time> {
  const projection = createJournalTimeProjection(candles, intervalSeconds, coverage);
  const lastAt = candles.length ? (candles[candles.length - 1].time + intervalSeconds) * 1000 - 1 : 0;
  const dark = Boolean(options.isDark);
  const pointValue = options.pointValue ?? 2;
  // Pokrytí nese 1m svíčky grafu (typově jen časy) — s cenami je přesnější.
  const coverageCandles = coverage?.candles as readonly Partial<OutcomeCandle>[] | undefined;
  const outcomeCandles: readonly OutcomeCandle[] = coverageCandles?.length && coverageCandles.every(candle => typeof candle.high === 'number' && typeof candle.low === 'number')
    ? coverageCandles as readonly OutcomeCandle[] : candles;
  const shapes = orders.map(order => {
    const until = order.end?.at ?? lastAt;
    const outcome = cancelledOrderOutcome(order, outcomeCandles);
    // Bracket je jedna čára od zadání po výsledek „co by se stalo“ (nebo konec příkazu).
    const bracketEnd = outcome?.kind === 'fill' ? (outcome.resultAt != null ? outcome.resultAt + intervalSeconds * 1000 - 1 : lastAt)
      : outcome?.kind === 'nofill' ? Math.max(until, outcome.closestAt + intervalSeconds * 1000 - 1) : until;
    return {
      order,
      outcome,
      bracketSpans: projection.spans(order.placedAt, Math.max(order.placedAt, bracketEnd)),
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
  let hoverStart = 0;
  let pointer: { x: number; y: number } | null = null;
  // Oblast najetého příkazu a jeho „co by se stalo“ — bublina ji nesmí zakrýt.
  let avoid: Rect | null = null;
  let requestUpdate: (() => void) | null = null;
  let frame: number | null = null;

  const animate = () => {
    if (frame != null || typeof requestAnimationFrame !== 'function') { requestUpdate?.(); return; }
    const tick = () => {
      frame = null;
      requestUpdate?.();
      if (hovered != null && performance.now() - hoverStart < ANIM_MS) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
  };

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
    if (next !== hovered) {
      hovered = next;
      hoverStart = performance.now();
      animate();
    } else if (moved) requestUpdate?.();
  };

  const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const progress = () => reducedMotion() ? 1 : clamp01((performance.now() - hoverStart) / ANIM_MS);

  const renderer: IPrimitivePaneRenderer = { draw: target => {
    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      const coordinate = (index: number) => chart.timeScale().logicalToCoordinate(index as Logical);
      const x = (at: number) => journalLogicalCoordinate(projection.point(at), coordinate);
      const bg = dark ? '#0b1017' : '#ffffff';
      const t = progress();
      hitLines.length = 0;
      hitChips.length = 0;
      context.save();

      const active = hovered != null ? shapes[hovered] : null;
      if (active) {
        const order = active.order;
        const price = order.legs[order.legs.length - 1].price;
        const py = series.priceToCoordinate(price);
        const outcome = active.outcome;
        const fx = outcome?.kind === 'fill' ? x(outcome.fillAt) : null;
        const rx = outcome?.kind === 'fill' && outcome.resultAt != null ? x(outcome.resultAt) : null;

        // Slabý box hypotetické pozice (jen výplň — hrany tvoří čáry bracketu).
        if (outcome?.kind === 'fill' && order.bracket && py != null && fx != null && rx != null) {
          context.globalAlpha = easeOut(phase(t, 0.3, 0.6));
          for (const [level, fill] of [[order.bracket.sl, 'rgba(239,68,68,.11)'], [order.bracket.tp, 'rgba(16,185,129,.11)']] as const) {
            const ly = level == null ? null : series.priceToCoordinate(level);
            if (ly == null) continue;
            context.fillStyle = fill;
            context.fillRect(fx, Math.min(py, ly), Math.max(1, rx - fx), Math.abs(ly - py));
          }
        }

        // Bracket: jedna čára SL a jedna TP od zadání po výsledek, popisek jednou na konci.
        if (order.bracket) {
          const reveal = easeOut(phase(t, 0, 0.45));
          for (const [level, color, label] of [[order.bracket.sl, JOURNAL_SL_COLOR, 'SL'], [order.bracket.tp, JOURNAL_TP_COLOR, 'TP']] as const) {
            if (level == null) continue;
            const y = series.priceToCoordinate(level);
            if (y == null) continue;
            const spans = active.bracketSpans.map(span => journalVisibleSpanCoordinates(span, coordinate)).filter((b): b is { left: number; right: number } => b != null);
            if (!spans.length) continue;
            const start = spans[0].left, end = spans[spans.length - 1].right;
            const cut = start + (end - start) * reveal;
            context.globalAlpha = 0.85; context.strokeStyle = color; context.lineWidth = 1.1; context.setLineDash([4, 3]);
            for (const span of spans) {
              if (span.left >= cut) break;
              context.beginPath(); context.moveTo(span.left, y); context.lineTo(Math.min(span.right, cut), y); context.stroke();
            }
            // Úroveň, kterou výsledek trefil, už popisuje štítek výsledku.
            const hitHere = outcome?.kind === 'fill' && outcome.result === (label === 'SL' ? 'sl' : 'tp');
            if (reveal > 0.6 && !hitHere) {
              context.globalAlpha = clamp01((reveal - 0.6) / 0.4);
              context.setLineDash([]);
              context.font = `700 9.5px ${FONT}`;
              const text = `${label} ${priceText(level)}`;
              const w = context.measureText(text).width + 10;
              const left = Math.min(end + 4, mediaSize.width - w - 2);
              context.fillStyle = dark ? '#0f172a' : '#ffffff'; context.strokeStyle = color; context.lineWidth = 1;
              context.beginPath(); context.roundRect(left, y - 8, w, 16, 8); context.fill(); context.stroke();
              context.fillStyle = color; context.textBaseline = 'middle'; context.fillText(text, left + 5, y + 0.5);
            }
          }
        }

        // „Kdybys nezrušil“: tečkovaná dráha od ✕ → vyplnění → výsledek.
        const cx = order.end?.kind === 'cancel' ? x(order.end.at) : null;
        if (outcome && py != null && cx != null) {
          const pathEnd = outcome.kind === 'fill' ? fx : x(outcome.closestAt);
          if (pathEnd != null) {
            const reach = cx + (pathEnd - cx) * easeOut(phase(t, 0.05, 0.4));
            context.globalAlpha = 0.9; context.strokeStyle = CANCEL_COLOR; context.lineWidth = 1.3; context.setLineDash([1, 4]); context.lineCap = 'round';
            context.beginPath(); context.moveTo(cx, py); context.lineTo(reach, py); context.stroke();
          }
          if (outcome.kind === 'nofill') {
            const kx = x(outcome.closestAt), ky = series.priceToCoordinate(outcome.closestPrice);
            const grow = easeOut(phase(t, 0.4, 0.7));
            if (kx != null && ky != null && grow > 0) {
              context.setLineDash([]); context.globalAlpha = 1; context.strokeStyle = AMBER; context.lineWidth = 1.5;
              const tipY = py + (ky - py) * grow;
              context.beginPath(); context.moveTo(kx, py); context.lineTo(kx, tipY); context.stroke();
              for (const [ay, dir] of [[py, Math.sign(ky - py)], [tipY, -Math.sign(ky - py)]] as const) {
                context.beginPath(); context.moveTo(kx - 3.5, ay + dir * 4.5); context.lineTo(kx, ay); context.lineTo(kx + 3.5, ay + dir * 4.5); context.stroke();
              }
              drawBadge(context, mediaSize.width, `chybělo ${pointsText(outcome.missBy)} b.`, kx + 9, (py + ky) / 2, TONES.amber[dark ? 'dark' : 'light'], easeOut(phase(t, 0.6, 0.85)));
            }
          } else if (fx != null) {
            const pop = phase(t, 0.35, 0.55);
            if (pop > 0) {
              context.setLineDash([]); context.globalAlpha = 1;
              context.fillStyle = bg; context.strokeStyle = dark ? '#cbd5e1' : '#475569'; context.lineWidth = 1.6;
              context.beginPath(); context.arc(fx, py, 4.5 * backOut(pop), 0, Math.PI * 2); context.fill(); context.stroke();
            }
            if (rx != null && outcome.exitPrice != null) {
              const ey = series.priceToCoordinate(outcome.exitPrice);
              const win = outcome.result === 'tp';
              const color = win ? FILL_COLOR : JOURNAL_SL_COLOR;
              if (ey != null) {
                const run = easeOut(phase(t, 0.45, 0.75));
                if (run > 0) {
                  context.globalAlpha = 0.95; context.strokeStyle = color; context.lineWidth = 1.5; context.setLineDash([5, 4]);
                  context.beginPath(); context.moveTo(fx, py); context.lineTo(fx + (rx - fx) * run, py + (ey - py) * run); context.stroke();
                }
                const mark = phase(t, 0.72, 0.9);
                if (mark > 0) {
                  const r = 7.5 * backOut(mark);
                  context.setLineDash([]); context.globalAlpha = 1;
                  context.fillStyle = color; context.strokeStyle = bg; context.lineWidth = 2;
                  context.beginPath(); context.arc(rx, ey, r, 0, Math.PI * 2); context.fill(); context.stroke();
                  context.strokeStyle = '#ffffff'; context.lineWidth = 1.8; context.lineCap = 'round'; context.beginPath();
                  const k = r / 7.5;
                  if (win) { context.moveTo(rx - 3 * k, ey); context.lineTo(rx - 0.8 * k, ey + 2.4 * k); context.lineTo(rx + 3.2 * k, ey - 2.4 * k); }
                  else { context.moveTo(rx - 2.5 * k, ey - 2.5 * k); context.lineTo(rx + 2.5 * k, ey + 2.5 * k); context.moveTo(rx + 2.5 * k, ey - 2.5 * k); context.lineTo(rx - 2.5 * k, ey + 2.5 * k); }
                  context.stroke();
                }
                const card = entryOrderOutcomeCard(outcome, order.quantity, pointValue);
                drawBadge(context, mediaSize.width, `${win ? 'TP' : 'SL'} ${clockText(outcome.resultAt!)} · ${card.value}`, rx + 12, ey,
                  TONES[win ? 'green' : 'red'][dark ? 'dark' : 'light'], easeOut(phase(t, 0.8, 1)));
              }
            } else {
              drawBadge(context, mediaSize.width, outcome.result === 'ambiguous' ? 'SL i TP v jedné svíčce' : `vyplnil by se ${clockText(outcome.fillAt)}`, fx + 9, py - 16,
                TONES.slate[dark ? 'dark' : 'light'], easeOut(phase(t, 0.5, 0.8)));
            }
          }
        }
      }

      // Linky příkazů a cedulky.
      context.font = CHIP.font;
      context.lineCap = 'butt';
      const chips: Array<{ left: number; right: number; top: number; bottom: number }> = [];
      const dimOthers = hovered != null ? easeOut(phase(t, 0, 0.3)) : 0;
      shapes.forEach(({ order, color, legs }, index) => {
        const cancelled = order.end?.kind === 'cancel';
        const isHot = hovered === index;
        const baseAlpha = cancelled ? 0.85 : 1;
        const alpha = isHot ? 1 : baseAlpha * (1 - 0.65 * dimOthers);
        context.globalAlpha = alpha;
        context.strokeStyle = color;
        context.lineWidth = isHot ? 1.5 + 0.9 * easeOut(phase(t, 0, 0.3)) : 1.5;
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
            context.globalAlpha = isHot ? 1 : 1 - 0.55 * dimOthers;
            context.fillStyle = cancelled ? (dark ? '#1e293b' : '#f1f5f9') : color;
            context.strokeStyle = cancelled ? (isHot ? '#64748b' : dark ? '#334155' : '#cbd5e1') : color;
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
          context.globalAlpha = isHot ? 1 : 1 - 0.55 * dimOthers;
          if (order.end.kind === 'fill') {
            context.fillStyle = FILL_COLOR; context.strokeStyle = bg; context.lineWidth = 1.5;
            context.beginPath(); context.arc(lastPoint.x, lastPoint.y, 4.5, 0, Math.PI * 2); context.fill(); context.stroke();
          } else {
            context.fillStyle = bg; context.strokeStyle = dark ? '#475569' : '#cbd5e1'; context.lineWidth = 1;
            context.beginPath(); context.arc(lastPoint.x, lastPoint.y, 6, 0, Math.PI * 2); context.fill(); context.stroke();
            context.strokeStyle = '#64748b'; context.lineWidth = 1.5; context.lineCap = 'round';
            context.beginPath();
            context.moveTo(lastPoint.x - 2.6, lastPoint.y - 2.6); context.lineTo(lastPoint.x + 2.6, lastPoint.y + 2.6);
            context.moveTo(lastPoint.x + 2.6, lastPoint.y - 2.6); context.lineTo(lastPoint.x - 2.6, lastPoint.y + 2.6);
            context.stroke();
            context.lineCap = 'butt';
          }
        }
      });

      // Co bublina nesmí zakrýt: cedulka, linka příkazu, bracket, dráha a výsledek.
      avoid = null;
      if (active) {
        const order = active.order;
        const xs: number[] = [], ys: number[] = [];
        const addX = (value: number | null | undefined) => { if (value != null && Number.isFinite(value)) xs.push(value); };
        const addY = (value: number | null | undefined) => { if (value != null && Number.isFinite(value)) ys.push(value); };
        const chip = hitChips.find(box => box.index === hovered);
        if (chip) { addX(chip.left); addX(chip.right); addY(chip.top); addY(chip.bottom); }
        for (const leg of order.legs) { addX(x(leg.at)); addY(series.priceToCoordinate(leg.price)); }
        addX(order.end ? x(order.end.at) : null);
        if (order.bracket) { addY(order.bracket.sl == null ? null : series.priceToCoordinate(order.bracket.sl)); addY(order.bracket.tp == null ? null : series.priceToCoordinate(order.bracket.tp)); }
        const outcome = active.outcome;
        let badgeRight = 0;
        if (outcome?.kind === 'fill') {
          addX(x(outcome.fillAt));
          const rx = outcome.resultAt != null ? x(outcome.resultAt) : null;
          addX(rx); addY(outcome.exitPrice == null ? null : series.priceToCoordinate(outcome.exitPrice));
          if (rx != null) badgeRight = rx + 170;
        } else if (outcome?.kind === 'nofill') {
          const kx = x(outcome.closestAt);
          addX(kx); addY(series.priceToCoordinate(outcome.closestPrice));
          if (kx != null) badgeRight = kx + 110;
        }
        if (badgeRight) xs.push(badgeRight);
        if (xs.length && ys.length) {
          avoid = { left: Math.min(...xs) - 8, right: Math.min(mediaSize.width, Math.max(...xs) + 8), top: Math.min(...ys) - 12, bottom: Math.max(...ys) + 12 };
        }
      }
      context.restore();
    });
  } };

  // Bublina má vlastní vrstvu nad vším (i nad šipkami obchodu); linky jsou pod nimi.
  const tooltipRenderer: IPrimitivePaneRenderer = { draw: target => {
    const active = hovered != null ? shapes[hovered] : null;
    if (!active || !pointer) return;
    const at = pointer;
    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      context.save();
      drawTooltip(context, mediaSize, at, avoid, active.order, active.outcome, active.color, dark, pointValue, easeOut(clamp01((reducedMotion() ? ANIM_MS : performance.now() - hoverStart) / 200)));
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
    detached: () => {
      chart.unsubscribeCrosshairMove(onCrosshair);
      if (frame != null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
      frame = null; requestUpdate = null; hovered = null; pointer = null;
    },
    paneViews: () => views,
    priceAxisViews: axisViews,
  };
}

type Tone = { bg: string; border: string; ink: string };
type Rect = { left: number; right: number; top: number; bottom: number };

/**
 * Místo pro bublinu: u kurzoru, nebo vedle/nad/pod oblastí příkazu — tam,
 * kde nejméně zakryje příkaz a jeho „co by se stalo“, a co nejblíž kurzoru.
 */
export function placeTooltip(size: { width: number; height: number }, at: { x: number; y: number }, avoid: Rect | null, width: number, height: number) {
  const M = 6, G = 14;
  const clampX = (value: number) => Math.min(Math.max(M, value), Math.max(M, size.width - width - M));
  const clampY = (value: number) => Math.min(Math.max(M, value), Math.max(M, size.height - height - M));
  const candidates: Array<{ left: number; top: number }> = [
    { left: at.x + G, top: at.y + G }, { left: at.x - G - width, top: at.y + G },
    { left: at.x + G, top: at.y - G - height }, { left: at.x - G - width, top: at.y - G - height },
  ];
  if (avoid) {
    candidates.push(
      { left: avoid.left - G - width, top: at.y - height / 2 }, { left: avoid.right + G, top: at.y - height / 2 },
      { left: at.x - width / 2, top: avoid.top - G - height }, { left: at.x - width / 2, top: avoid.bottom + G },
    );
  }
  let best: { left: number; top: number; score: number } | null = null;
  // Pořadí kandidátů je preference (vpravo dole od kurzoru první); rozhoduje překryv.
  for (const [index, candidate] of candidates.entries()) {
    const left = clampX(candidate.left), top = clampY(candidate.top);
    const overlap = avoid ? Math.max(0, Math.min(left + width, avoid.right) - Math.max(left, avoid.left))
      * Math.max(0, Math.min(top + height, avoid.bottom) - Math.max(top, avoid.top)) : 0;
    // Kurzor pod bublinou by bránil dalšímu najetí — také penalizovat.
    const coversPointer = at.x >= left && at.x <= left + width && at.y >= top && at.y <= top + height ? 1 : 0;
    const score = overlap * 10 + coversPointer * 1e6 + index;
    if (!best || score < best.score) best = { left, top, score };
  }
  return { left: best!.left, top: best!.top };
}

function drawBadge(context: CanvasRenderingContext2D, width: number, text: string, bx: number, by: number, tone: Tone, alpha: number) {
  if (alpha <= 0) return;
  context.save();
  context.setLineDash([]); context.globalAlpha = alpha;
  context.font = `800 10px ${FONT}`;
  const w = context.measureText(text).width + 14;
  const left = Math.min(Math.max(2, bx), width - w - 2);
  const top = by - 10 + (1 - alpha) * 4;
  context.fillStyle = tone.bg; context.strokeStyle = tone.border; context.lineWidth = 1;
  context.beginPath(); context.roundRect(left, top, w, 20, 10); context.fill(); context.stroke();
  context.fillStyle = tone.ink; context.textBaseline = 'middle'; context.fillText(text, left + 7, top + 10.5);
  context.restore();
}

/** Bublina příkazu: hlavička, časová osa, bracket a karta „Kdybys nezrušil“. */
function drawTooltip(context: CanvasRenderingContext2D, size: { width: number; height: number }, at: { x: number; y: number }, avoid: Rect | null,
  order: TradeEntryOrder, outcome: EntryOrderOutcome | null, color: string, dark: boolean, pointValue: number, appear: number) {
  const ink = dark ? '#f1f5f9' : '#0f172a', muted = dark ? '#94a3b8' : '#64748b', line = dark ? 'rgba(255,255,255,.08)' : '#e2e8f0';
  const W = 252, PAD = 12;
  const steps: Array<{ label: string; time: string; price?: string; dot: string }> = order.legs.map((leg, index) => ({
    label: index ? 'Posunut' : 'Zadán', time: timeText(leg.at), price: priceText(leg.price), dot: index ? '#a855f7' : color === CANCEL_COLOR ? '#64748b' : color,
  }));
  if (order.end) steps.push({ label: order.end.kind === 'fill' ? 'Vyplněn' : 'Zrušen', time: timeText(order.end.at), dot: order.end.kind === 'fill' ? FILL_COLOR : CANCEL_COLOR });
  else steps.push({ label: 'Stále čeká', time: '', dot: AMBER });
  const card = outcome ? entryOrderOutcomeCard(outcome, order.quantity, pointValue) : null;
  const bracket = order.bracket && (order.bracket.sl != null || order.bracket.tp != null) ? order.bracket : null;
  const height = PAD + 22 + 8 + steps.length * 19 + (order.end ? 16 : 0) + (bracket ? 10 + 22 : 0) + (card ? 12 + 58 : 0) + PAD;

  const place = placeTooltip(size, at, avoid, W, height);
  const left = place.left;
  const top = place.top + (1 - appear) * 6;
  context.globalAlpha = appear;

  // Karta
  context.shadowColor = dark ? 'rgba(0,0,0,.55)' : 'rgba(15,23,42,.18)'; context.shadowBlur = 24; context.shadowOffsetY = 8;
  context.fillStyle = dark ? '#0f172a' : '#ffffff';
  context.beginPath(); context.roundRect(left, top, W, height, 12); context.fill();
  context.shadowColor = 'transparent'; context.shadowBlur = 0; context.shadowOffsetY = 0;
  context.strokeStyle = line; context.lineWidth = 1; context.stroke();
  context.textBaseline = 'middle';

  // Hlavička: pilulka strany a typu, kusy, stav
  let y = top + PAD + 11;
  context.font = `800 10px ${FONT}`;
  const pill = `${order.side === 'Buy' ? 'BUY' : 'SELL'} ${order.type === 'Limit' ? 'LIMIT' : 'STOP'}`;
  const pw = context.measureText(pill).width + 14;
  const pillColor = order.side === 'Buy' ? JOURNAL_BUY_COLOR : JOURNAL_SELL_COLOR;
  context.fillStyle = pillColor; context.beginPath(); context.roundRect(left + PAD, y - 10, pw, 20, 10); context.fill();
  context.fillStyle = '#ffffff'; context.fillText(pill, left + PAD + 7, y + 0.5);
  if (order.quantity != null) { context.font = `700 11.5px ${FONT}`; context.fillStyle = ink; context.fillText(`${order.quantity} ks`, left + PAD + pw + 8, y + 0.5); }
  const status = order.end?.kind === 'fill' ? ['Vyplněn', TONES.green] : order.end ? ['Zrušen', TONES.slate] : ['Čeká', TONES.amber];
  const tone = (status[1] as typeof TONES.green)[dark ? 'dark' : 'light'];
  context.font = `800 9.5px ${FONT}`;
  const sw = context.measureText(String(status[0])).width + 14;
  context.fillStyle = tone.bg; context.strokeStyle = tone.border;
  context.beginPath(); context.roundRect(left + W - PAD - sw, y - 9, sw, 18, 9); context.fill(); context.stroke();
  context.fillStyle = tone.ink; context.fillText(String(status[0]), left + W - PAD - sw + 7, y + 0.5);
  y += 11 + 8;

  // Časová osa příkazu
  const railX = left + PAD + 4;
  steps.forEach((step, index) => {
    const cy = y + 9.5 + index * 19;
    if (index < steps.length - 1) { context.strokeStyle = line; context.lineWidth = 1.5; context.beginPath(); context.moveTo(railX, cy + 4); context.lineTo(railX, cy + 15); context.stroke(); }
    context.fillStyle = step.dot; context.beginPath(); context.arc(railX, cy, 3.5, 0, Math.PI * 2); context.fill();
    context.font = `600 11px ${FONT}`; context.fillStyle = ink; context.fillText(step.label, railX + 11, cy + 0.5);
    const labelW = context.measureText(step.label).width;
    context.font = `500 10.5px ${FONT}`; context.fillStyle = muted;
    context.fillText(step.time, railX + 11 + labelW + 8, cy + 0.5);
    if (step.price) {
      context.font = `700 11px ${FONT}`; context.fillStyle = ink;
      context.fillText(step.price, left + W - PAD - context.measureText(step.price).width, cy + 0.5);
    }
  });
  y += steps.length * 19;
  if (order.end) {
    context.font = `500 10.5px ${FONT}`; context.fillStyle = muted;
    context.fillText(`${order.end.kind === 'fill' ? 'Čekal na vyplnění' : 'Stál'} ${durationText(order.end.at - order.placedAt)}`, railX + 11, y + 6);
    y += 16;
  }

  // Bracket
  if (bracket) {
    y += 10;
    let bx = left + PAD;
    for (const [label, value, tone2] of [['SL', bracket.sl, TONES.red], ['TP', bracket.tp, TONES.green]] as const) {
      if (value == null) continue;
      const tn = tone2[dark ? 'dark' : 'light'];
      const text = `${label} ${priceText(value)}`;
      context.font = `800 10.5px ${FONT}`;
      const w = context.measureText(text).width + 16;
      context.fillStyle = tn.bg; context.strokeStyle = tn.border;
      context.beginPath(); context.roundRect(bx, y, w, 22, 6); context.fill(); context.stroke();
      context.fillStyle = tn.ink; context.fillText(text, bx + 8, y + 11.5);
      bx += w + 6;
    }
    y += 22;
  }

  // Kdybys nezrušil
  if (card) {
    y += 12;
    const tn = TONES[card.tone][dark ? 'dark' : 'light'];
    context.fillStyle = tn.bg; context.strokeStyle = tn.border;
    context.beginPath(); context.roundRect(left + PAD, y, W - PAD * 2, 58, 9); context.fill(); context.stroke();
    context.font = `900 8.5px ${FONT}`; context.fillStyle = tn.ink; context.globalAlpha = appear * 0.8;
    context.fillText('KDYBYS NEZRUŠIL', left + PAD + 10, y + 13);
    context.globalAlpha = appear;
    context.font = `800 17px ${FONT}`; context.fillStyle = tn.ink;
    context.fillText(card.value, left + PAD + 10, y + 31);
    context.font = `500 10px ${FONT}`; context.fillStyle = muted;
    let sub = card.sub;
    while (context.measureText(sub).width > W - PAD * 2 - 20 && sub.length > 4) sub = `${sub.slice(0, -2)}…`;
    context.fillText(sub, left + PAD + 10, y + 47);
  }
}
