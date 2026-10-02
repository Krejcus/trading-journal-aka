import type { IChartApi, ISeriesApi, ISeriesPrimitive, IPrimitivePaneRenderer, Logical, MouseEventParams, Time } from 'lightweight-charts';
import type { TradeEntryOrder } from '../lib/journalEntryOrders';
import { cancelledOrderOutcome, type EntryOrderOutcome, type OutcomeCandle } from '../lib/entryOrderOutcome';
import type { MarketCandle } from './marketData';
import { createJournalTimeProjection, journalLogicalCoordinate, journalVisibleSpanCoordinates, type JournalCandleCoverage } from './journalChartTime';
import { JOURNAL_BUY_COLOR, JOURNAL_SELL_COLOR, JOURNAL_SL_COLOR, JOURNAL_TP_COLOR } from './journalChartPrimitive';
import {
  ENTRY_ORDER_FOCUS_EVENT, ENTRY_ORDER_HOVER_EVENT, ENTRY_ORDER_SELECT_EVENT, emitEntryOrder, entryOrderHintAllowed, markEntryOrderHint, retireEntryOrderHint,
  type EntryOrderFocusDetail, type EntryOrderHoverDetail, type EntryOrderSelectDetail,
} from './entryOrderEvents';

/**
 * Vstupní příkazy obchodu ve stylu příkazu v TradingView: přerušovaná linka
 * od zadání po vyplnění/zrušení, na začátku cedulka (strana, typ, kusy),
 * posun příkazu = schod. Vyplnění = zelená tečka u šipky vstupu, zrušený
 * příkaz zešedne a končí ✕. Limit čárkovaně, stop tečkovaně.
 *
 * Najetí na linku nebo cedulku (animovaně): linka zesílí, bracket SL/TP je
 * jedna souvislá čára od zadání po výsledek a u zrušeného příkazu se dokreslí
 * „kdybys ho nezrušil“ (vyplnění, slabý box pozice, výsledek). Kurzor ruky,
 * „›“ v cedulce a na začátku nápověda říkají, že jde kliknout: klik příkaz
 * připne a detail ukáže seznam „Průběh obchodu“ (viz entryOrderEvents).
 */
const FILL_COLOR = '#10b981';
const CANCEL_COLOR = '#94a3b8';
const AMBER = '#f59e0b';
const FONT = 'Inter, system-ui, sans-serif';
const CHIP = { height: 16, padX: 5, gap: 4, font: `700 9.5px ${FONT}`, radius: 3 };
const HIT_Y = 5;
/** Délka nástupní animace po najetí (ms). */
const ANIM_MS = 900;
/** Po jak dlouhém najetí se ukáže „Klikni pro detail“. */
const HINT_DELAY_MS = 550;

export function entryOrderLabel(order: Pick<TradeEntryOrder, 'side' | 'type' | 'quantity'>): string {
  return `${order.side === 'Buy' ? 'BUY' : 'SELL'} ${order.type === 'Limit' ? 'LMT' : 'STP'}${order.quantity != null ? ` ${order.quantity}` : ''}`;
}

const priceText = (value: number) => value.toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const clockText = (at: number) => new Date(at).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
const pointsText = (value: number) => value.toLocaleString('cs-CZ', { maximumFractionDigits: 2 });
const moneyText = (value: number) => `${value >= 0 ? '+' : '−'}$${Math.abs(value).toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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
  chart: IChartApi, series: ISeriesApi<'Candlestick'>, coverage?: JournalCandleCoverage, options: { isDark?: boolean; pointValue?: number; autoPin?: 'animate' | 'static' } = {}): ISeriesPrimitive<Time> {
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
  /** Pod kurzorem v grafu. */
  let hovered: number | null = null;
  /** Najetí na řádek v seznamu „Průběh obchodu“. */
  let listHover: number | null = null;
  /** Připnutý klikem (v grafu nebo v seznamu) — drží animaci a detail v seznamu. */
  let pinned: number | null = null;
  let shown: number | null = null;
  let shownSince = 0;
  let hintFor: number | null = null;
  let requestUpdate: (() => void) | null = null;
  let frame: number | null = null;
  const indexOf = (orderId: string | null | undefined) => orderId == null ? null : (() => { const i = shapes.findIndex(shape => shape.order.orderId === orderId); return i < 0 ? null : i; })();

  const animate = () => {
    if (frame != null || typeof requestAnimationFrame !== 'function') { requestUpdate?.(); return; }
    const tick = () => {
      frame = null;
      requestUpdate?.();
      // Doběh animace a nápovědy (ta naskočí po chvilce najetí).
      if (shown != null && performance.now() - shownSince < ANIM_MS + HINT_DELAY_MS + 300) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
  };
  /** Co se právě ukazuje: najetí má přednost před připnutím. */
  const refresh = () => {
    const next = hovered ?? listHover ?? pinned;
    if (next !== shown) {
      // Návrat z najetí na připnutý příkaz už animaci nepřehrává znovu.
      shownSince = next != null && next === pinned && shown != null ? performance.now() - ANIM_MS : performance.now();
      shown = next;
    }
    animate();
  };
  const select = (index: number | null) => {
    pinned = index;
    const shape = index == null ? null : shapes[index];
    emitEntryOrder<EntryOrderSelectDetail>(ENTRY_ORDER_SELECT_EVENT, shape
      ? { orderId: shape.order.orderId, order: shape.order, outcome: shape.outcome, pointValue }
      : { orderId: null });
    refresh();
  };

  const hitAt = (px: number, py: number): { index: number; chip: boolean } | null => {
    const chip = hitChips.find(box => px >= box.left && px <= box.right && py >= box.top - 2 && py <= box.bottom + 2);
    if (chip) return { index: chip.index, chip: true };
    const line = hitLines
      .filter(item => px >= item.left - 4 && px <= item.right + 4 && Math.abs(py - item.y) <= HIT_Y)
      .sort((a, b) => Math.abs(py - a.y) - Math.abs(py - b.y))[0];
    return line ? { index: line.index, chip: false } : null;
  };

  const onCrosshair = (param: MouseEventParams<Time>) => {
    const point = param.point ?? null;
    const next = point ? hitAt(point.x, point.y)?.index ?? null : null;
    if (next === hovered) return;
    hovered = next;
    emitEntryOrder<EntryOrderHoverDetail>(ENTRY_ORDER_HOVER_EVENT, { orderId: next == null ? null : shapes[next].order.orderId });
    refresh();
  };
  const onClick = (param: MouseEventParams<Time>) => {
    const point = param.point ?? null;
    const hit = point ? hitAt(point.x, point.y) : null;
    if (hit) {
      retireEntryOrderHint();
      select(pinned === hit.index ? null : hit.index);
    } else if (pinned != null) select(null);
  };
  const onFocus = (event: Event) => {
    const detail = (event as CustomEvent<EntryOrderFocusDetail>).detail;
    const index = indexOf(detail?.orderId);
    if (detail?.mode === 'pin') {
      if (detail.orderId != null && index == null) return;
      select(index);
    } else {
      listHover = index;
      refresh();
    }
  };
  // Esc odepne. Hodnocení na Esc samo pošle odepnutí (a nezavře se), jinde to dělá tenhle posluchač.
  const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && pinned != null) { event.preventDefault(); select(null); } };

  const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const progress = () => reducedMotion() ? 1 : clamp01((performance.now() - shownSince) / ANIM_MS);

  const renderer: IPrimitivePaneRenderer = { draw: target => {
    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      const coordinate = (index: number) => chart.timeScale().logicalToCoordinate(index as Logical);
      const x = (at: number) => journalLogicalCoordinate(projection.point(at), coordinate);
      const bg = dark ? '#0b1017' : '#ffffff';
      const t = progress();
      hitLines.length = 0;
      hitChips.length = 0;
      context.save();

      const active = shown != null ? shapes[shown] : null;
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
      const dimOthers = shown != null ? easeOut(phase(t, 0, 0.3)) : 0;
      shapes.forEach(({ order, color, legs }, index) => {
        const cancelled = order.end?.kind === 'cancel';
        const isHot = shown === index;
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
          // Najetý/připnutý příkaz má v cedulce „›“ — dá se rozkliknout.
          const open = isHot ? easeOut(phase(t, 0, 0.35)) : 0;
          const text = entryOrderLabel(order);
          const width = context.measureText(text).width + CHIP.padX * 2 + 9 * open;
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
            if (open > 0) {
              context.globalAlpha = (isHot ? 1 : 0.45) * open;
              context.fillText('›', left + width - CHIP.padX - 5, top + CHIP.height / 2);
            }
            // Nápověda na prvních pár najetí (ne u připnutého — to už uživatel zná).
            if (isHot && hovered === index && pinned !== index && (hintFor === index || entryOrderHintAllowed())) {
              const hint = phase(performance.now() - shownSince, HINT_DELAY_MS, HINT_DELAY_MS + 250);
              if (hint > 0) {
                if (hintFor !== index) { hintFor = index; markEntryOrderHint(); }
                const label = 'Klikni pro detail';
                context.font = `700 10px ${FONT}`;
                const hw = context.measureText(label).width + 16;
                const hx = Math.min(Math.max(2, left), mediaSize.width - hw - 2);
                const hy = top + CHIP.height + 6 + (1 - easeOut(hint)) * 4;
                context.globalAlpha = easeOut(hint);
                context.fillStyle = '#6366f1';
                context.beginPath(); context.roundRect(hx, hy, hw, 18, 9); context.fill();
                context.fillStyle = '#ffffff'; context.fillText(label, hx + 8, hy + 9.5);
                context.font = CHIP.font;
              }
            }
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

      context.restore();
    });
  } };

  const views = [{ zOrder: () => 'normal' as const, renderer: () => renderer }];
  // Čekající příkaz (při přehrávání) má štítek na cenové ose.
  const axisViews = () => shapes.filter(shape => !shape.order.end).flatMap(({ order, color }) => {
    const price = order.legs.at(-1)?.price;
    const y = price == null ? null : series.priceToCoordinate(price);
    return y == null ? [] : [{ coordinate: () => y, text: () => `${order.type === 'Limit' ? 'LMT' : 'STP'} ${price!.toFixed(2)}`,
      textColor: () => '#ffffff', backColor: () => color, visible: () => true, tickVisible: () => true }];
  });
  return {
    attached: params => {
      requestUpdate = params.requestUpdate;
      chart.subscribeCrosshairMove(onCrosshair);
      chart.subscribeClick(onClick);
      window.addEventListener(ENTRY_ORDER_FOCUS_EVENT, onFocus);
      window.addEventListener('keydown', onKey);
      // Nevzatý obchod: jediný příkaz je celý obsah grafu — rovnou připnutý
      // s „kdybys nezrušil“. Při překreslení (nové svíčky) bez nové animace.
      if (options.autoPin && shapes.length) {
        select(0);
        if (options.autoPin === 'static') shownSince = performance.now() - ANIM_MS;
      }
    },
    detached: () => {
      chart.unsubscribeCrosshairMove(onCrosshair);
      chart.unsubscribeClick(onClick);
      window.removeEventListener(ENTRY_ORDER_FOCUS_EVENT, onFocus);
      window.removeEventListener('keydown', onKey);
      if (frame != null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
      frame = null; requestUpdate = null; hovered = null; listHover = null; pinned = null; shown = null;
    },
    paneViews: () => views,
    priceAxisViews: axisViews,
    // Kurzor ruky nad cedulkou a linkou příkazu: dá se kliknout.
    hitTest: (px, py) => {
      const hit = hitAt(px, py);
      return hit ? { externalId: `entry-order:${shapes[hit.index].order.orderId}`, cursorStyle: 'pointer', zOrder: 'top', hitTestPriority: hit.chip ? 2 : 1 } : null;
    },
  };
}

type Tone = { bg: string; border: string; ink: string };
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
