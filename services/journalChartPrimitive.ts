import type { IChartApi, ISeriesApi, ISeriesPrimitive, IPrimitivePaneRenderer, Logical, Time } from 'lightweight-charts';
import type { TradeExecutionHistory } from '../lib/tradeExecutionHistory';
import type { MarketCandle } from './marketData';
import { ALPHATRADE_CHART_STYLE as style } from './chartVisualStyle';
import { journalProtectionSegments } from '../lib/journalProtectionSegments';
import { protectionValueAt, tradeFillGroups } from '../lib/tradeReplay';
import { createJournalTimeProjection, journalLogicalCoordinate, journalVisibleSpanCoordinates, type JournalCandleCoverage } from './journalChartTime';
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
  /** Review týdne: ostatní obchody — bez najetí, bez popisku výsledku a bez vlivu na osu. */
  muted?: boolean;
  /** Průhlednost celé kresby (výchozí 1). */
  alpha?: number;
  /** Dočasně nekreslit (review: obchod je právě vybraný a kreslí ho hlavní vrstva). */
  isHidden?: () => boolean;
  /**
   * Review: po připojení se šipky na tolik ms ukážou jako při najetí myší
   * (zvětšené, rozsvícené, s popiskem) — ať je vidět, který obchod je aktuální.
   */
  highlightMs?: number;
  /**
   * Review: sdílené skládání šipek všech obchodů na grafu. Každý obchod je
   * vlastní vrstva — bez toho by šipky dvou obchodů v jedné svíčce ležely přes sebe.
   */
  arrowStacks?: { registry: JournalArrowStacks; key: string; order: number };
}

type StackedArrow = { candle: number | null; buy: boolean };
export interface JournalArrowStacks {
  register(key: string, order: number, arrows: readonly StackedArrow[]): void;
  /** Kolik šipek stejné strany v téže svíčce mají obchody před tímto (podle pořadí). */
  before(key: string, candle: number, buy: boolean): number;
}

export function createJournalArrowStacks(): JournalArrowStacks {
  const entries = new Map<string, { order: number; arrows: readonly StackedArrow[] }>();
  // Index svíčka+strana → obchody v pořadí; staví se líně po každé registraci.
  let index: Map<string, Array<{ key: string; order: number; count: number }>> | null = null;
  const build = () => {
    const next = new Map<string, Array<{ key: string; order: number; count: number }>>();
    for (const [key, entry] of entries) {
      const counts = new Map<string, number>();
      for (const arrow of entry.arrows) if (arrow.candle != null) {
        const slot = `${arrow.candle}:${arrow.buy ? 1 : 0}`;
        counts.set(slot, (counts.get(slot) ?? 0) + 1);
      }
      for (const [slot, count] of counts) {
        const list = next.get(slot) ?? [];
        list.push({ key, order: entry.order, count });
        next.set(slot, list);
      }
    }
    for (const list of next.values()) list.sort((a, b) => a.order - b.order || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return next;
  };
  return {
    register: (key, order, arrows) => { entries.set(key, { order, arrows }); index = null; },
    before: (key, candle, buy) => {
      index ??= build();
      let count = 0;
      for (const item of index.get(`${candle}:${buy ? 1 : 0}`) ?? []) {
        if (item.key === key) return count;
        count += item.count;
      }
      return 0;
    },
  };
}

/** Tenká šipka; po najetí myší se plynule zvětší a ukáže, co je zač. */
const ARROW = { gap: 3, stem: 13, head: 4, headDepth: 4.5, width: 1.6, hoverScale: 1.3, hitX: 8, animMs: 140 } as const;
/** Čáry SL/TP: tenké, po najetí se celá linie zesílí a ukáže hodnotu v místě kurzoru. */
// Zásah: ±10 px nad/pod čárou a 4 px přes konce úseku (rohy schodů) — na
// tenkou čáru se jinak musí trefit přesně.
const LEVEL = { width: 1, hoverWidth: 2.2, hitY: 10, hitX: 4 } as const;
const signed = (value: number, digits = 2) => `${value >= 0 ? '+' : '−'}${Math.abs(value).toLocaleString('cs-CZ', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
const priceText = (value: number) => value.toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const timeText = (at: number) => new Date(at).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function createJournalChartPrimitive(history: TradeExecutionHistory, candles: readonly MarketCandle[], intervalSeconds: number,
  chart: IChartApi, series: ISeriesApi<'Candlestick'>, coverage?: JournalCandleCoverage, options: JournalChartOptions = {}): ISeriesPrimitive<Time> {
  const projection = createJournalTimeProjection(candles, intervalSeconds, coverage);
  const baseAlpha = options.alpha ?? 1;
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
  // Šipky stojí jako v TradingView nad/pod svíčkou plnění (nákup pod low,
  // prodej nad high); víc šipek stejné strany v jedné svíčce se vyskládá.
  const arrowCandle = arrows.map(arrow => { const point = projection.point(arrow.at); return point == null ? null : Math.floor(point); });
  const arrowStack = arrows.map((arrow, index) => arrows.slice(0, index)
    .filter((other, otherIndex) => other.buy === arrow.buy && arrowCandle[otherIndex] != null && arrowCandle[otherIndex] === arrowCandle[index]).length);
  const stacks = options.arrowStacks;
  stacks?.registry.register(stacks.key, stacks.order, arrows.map((arrow, index) => ({ candle: arrowCandle[index], buy: arrow.buy })));
  // Pod šipky dřívějších obchodů v téže svíčce (review); počítá se při kreslení,
  // protože ostatní obchody se registrují až po tomto.
  const stackOf = (index: number, candle: number) => arrowStack[index] + (stacks ? stacks.registry.before(stacks.key, candle, arrows[index].buy) : 0);
  // Hover: poslední vykreslená poloha šipek, cílová šipka a průběh animace (0–1).
  const hitBoxes: Array<{ x: number; top: number; bottom: number } | null> = [];
  // Sloupec svíčky se šipkami: najetím kamkoli do něj se ukáže přesné plnění.
  const columnBoxes = new Map<number, { left: number; right: number; top: number; bottom: number }>();
  // Průběh animace: šipky podle indexu, čáry podle druhu (`sl`, `tp`).
  const progress = new Map<string, number>();
  const progressOf = (key: string) => progress.get(key) ?? 0;
  let hovered = new Set<number>();
  // Čára pod kurzorem: druh, poloha kurzoru a hodnota v tom okamžiku.
  type LineHit = { kind: 'sl' | 'tp'; left: number; right: number; y: number; from: number; to: number; logicalFrom: number; logicalTo: number; price: number };
  const lineHits: LineHit[] = [];
  // Svislé úseky = okamžik posunu SL/TP (z `price` na `nextPrice`).
  type MoveHit = { kind: 'sl' | 'tp'; x: number; top: number; bottom: number; at: number; price: number; nextPrice: number };
  const moveHits: MoveHit[] = [];
  let hoveredLine: { kind: 'sl' | 'tp'; x: number; y: number; at: number; price: number; nextPrice?: number } | null = null;
  let requestUpdate: (() => void) | null = null;
  // Zvýraznění po připojení (review): šipky ve stavu „najeto“, dokud neuplyne
  // čas nebo nepřevezme skutečné najetí myší.
  let highlightActive = false;
  // Během zvýraznění (a jeho doznění) bez štítků u šipek — jen šipky a čáry
  // k cenové ose. Štítky vrátí až skutečné najetí myší.
  let labelsQuiet = false;
  let highlightTimer: ReturnType<typeof setTimeout> | null = null;
  let frame: number | null = null;
  let lastTick = 0;
  const animate = () => {
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null;
    const settle = (dt: number) => {
      let moving = false;
      const keys = [...arrows.map((_, index) => `a${index}`), 'sl', 'tp'];
      for (const key of keys) {
        const value = progressOf(key);
        const target = (key.startsWith('a') && hovered.has(Number(key.slice(1)))) || key === hoveredLine?.kind ? 1 : 0;
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
    // Zvýraznění po přepnutí drží, dokud myš nad grafem nic nenajede.
    if (highlightActive) {
      if (!point) return;
      highlightActive = false;
    }
    const arrowHit = !point ? -1 : hitBoxes.findIndex(box => box != null
      && Math.abs(point.x - box.x) <= ARROW.hitX && point.y >= box.top - 4 && point.y <= box.bottom + 4);
    // Mimo šipku: sloupec svíčky s plněním (od šipek nad ní po šipky pod ní).
    const column = !point || arrowHit >= 0 ? null
      : [...columnBoxes.entries()].find(([, box]) => point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom)?.[0] ?? null;
    let nextSet = arrowHit >= 0 ? new Set([arrowHit])
      : column != null ? new Set(arrows.map((_, index) => index).filter(index => arrowCandle[index] === column)) : new Set<number>();
    // Šipka a svíčka s plněním mají přednost; jinak nejbližší úsek SL/TP — vodorovný
    // (úroveň) nebo svislý (posun), podle toho, ke kterému je kurzor blíž.
    const lineHit = !point || arrowHit >= 0 ? null : lineHits
      .filter(line => point.x >= line.left - LEVEL.hitX && point.x <= line.right + LEVEL.hitX && Math.abs(point.y - line.y) <= LEVEL.hitY)
      .sort((a, b) => Math.abs(point.y - a.y) - Math.abs(point.y - b.y))[0] ?? null;
    const moveHit = !point || arrowHit >= 0 ? null : moveHits
      .filter(item => Math.abs(point.x - item.x) <= LEVEL.hitY && point.y >= item.top - LEVEL.hitX && point.y <= item.bottom + LEVEL.hitX)
      .sort((a, b) => Math.abs(point.x - a.x) - Math.abs(point.x - b.x))[0] ?? null;
    // Ve svíčce s plněním vyhraje čára jen tehdy, když je kurzor přímo na ní.
    const hit = lineHit && (column == null || Math.abs(point!.y - lineHit.y) <= 3) ? lineHit : null;
    const move = moveHit && (column == null || Math.abs(point!.x - moveHit.x) <= 5) ? moveHit : null;
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
    if (hoveredLine && arrowHit < 0) nextSet = new Set<number>();
    const sameSet = nextSet.size === hovered.size && [...nextSet].every(index => hovered.has(index));
    if (sameSet && (hoveredLine?.kind ?? null) === previousKind) {
      // Kurzor se posouvá po téže čáře — štítek jde s ním.
      if (hoveredLine) requestUpdate?.();
      return;
    }
    hovered = nextSet;
    if (nextSet.size) labelsQuiet = false;
    animate();
  };

  const renderer: IPrimitivePaneRenderer = { draw: target => {
    if (options.isHidden?.()) return;
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
      context.globalAlpha = baseAlpha;
      lineHits.length = 0;
      moveHits.length = 0;
      for (const segment of segments) {
        // SL červeně, TP zeleně — stejně jako štítky na ose a box pozice.
        const color = segment.kind === 'sl' ? JOURNAL_SL_COLOR : JOURNAL_TP_COLOR;
        const width = levelWidth(segment.kind);
        for (const span of segment.spans) {
          const bounds = journalVisibleSpanCoordinates(span, coordinate);
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
            const bounds = journalVisibleSpanCoordinates(span, coordinate);
            if (!bounds) continue;
            context.globalAlpha = 0.16 * baseAlpha; context.fillStyle = tone; context.fillRect(bounds.left, top, bounds.right - bounds.left, height);
            context.globalAlpha = 0.55 * baseAlpha; context.strokeStyle = tone; context.lineWidth = 1;
            context.strokeRect(bounds.left + 0.5, top + 0.5, bounds.right - bounds.left - 1, height - 1);
            context.globalAlpha = baseAlpha; context.strokeStyle = '#94a3b8'; context.setLineDash([3, 3]);
            context.beginPath(); context.moveTo(bounds.left, yEntry); context.lineTo(bounds.right, yEntry); context.stroke();
            context.setLineDash([]);
            labelLeft = labelLeft == null ? bounds.left : Math.min(labelLeft, bounds.left);
            labelRight = labelRight == null ? bounds.right : Math.max(labelRight, bounds.right);
          }
          if (labelLeft != null && labelRight != null && !options.muted) {
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
      // Šipka nad/pod svíčkou plnění: nákup pod low hrotem nahoru, prodej nad
      // high hrotem dolů. Zvětšená (hover) se kreslí až nakonec.
      columnBoxes.clear();
      const order = arrows.map((_, index) => index).sort((a, b) => progressOf(`a${a}`) - progressOf(`a${b}`));
      for (const index of order) {
        const arrow = arrows[index];
        const candleIndex = arrowCandle[index];
        const candle = candleIndex == null ? undefined : candles[candleIndex];
        const xx = candleIndex == null ? null : coordinate(candleIndex);
        const yy = series.priceToCoordinate(arrow.price);
        const edge = candle ? series.priceToCoordinate(arrow.buy ? candle.low : candle.high) : null;
        if (xx == null || yy == null || edge == null || !candle || candleIndex == null) { hitBoxes[index] = null; continue; }
        const dir = arrow.buy ? 1 : -1;
        const t = progressOf(`a${index}`);
        const ease = 1 - (1 - t) ** 3;
        const scale = 1 + (ARROW.hoverScale - 1) * ease;
        const tip = edge + dir * (ARROW.gap + stackOf(index, candleIndex) * (ARROW.stem + ARROW.gap + 2));
        const tail = tip + dir * ARROW.stem * scale;
        hitBoxes[index] = { x: xx, top: Math.min(tip, tail), bottom: Math.max(tip, tail) };
        const next = coordinate(candleIndex + 1);
        const half = Math.max(4, next != null ? Math.abs(next - xx) / 2 : 4);
        const high = series.priceToCoordinate(candle.high); const low = series.priceToCoordinate(candle.low);
        // Jen šířka těla svíčky — mezera mezi svíčkami patří čarám SL/TP.
        const body = Math.max(3, half * 0.75);
        const box = columnBoxes.get(candleIndex) ?? { left: xx - body, right: xx + body, top: Infinity, bottom: -Infinity };
        box.top = Math.min(box.top, tip, tail, high ?? tip); box.bottom = Math.max(box.bottom, tip, tail, low ?? tail);
        columnBoxes.set(candleIndex, box);
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
        // Přesné plnění uvnitř svíčky: značka na ceně a tečkovaná spojnice
        // k šipce, štítek s cenou a časem na vteřiny za koncem šipky.
        context.globalAlpha = ease;
        context.lineWidth = 1;
        context.setLineDash([2, 2]);
        context.beginPath(); context.moveTo(xx, yy); context.lineTo(xx, tip); context.stroke();
        context.setLineDash([]);
        const tick = Math.min(9, half * 0.9);
        context.lineWidth = 1.6;
        context.beginPath(); context.moveTo(xx - tick, yy); context.lineTo(xx + tick, yy); context.stroke();
        // Tenká čára od plnění k cenové ose (tam štítek s cenou, priceAxisViews).
        context.globalAlpha = ease * 0.7;
        context.lineWidth = 1;
        context.setLineDash([3, 3]);
        context.beginPath(); context.moveTo(xx + tick, yy); context.lineTo(mediaSize?.width ?? xx + tick, yy); context.stroke();
        context.setLineDash([]);
        context.globalAlpha = ease;
        context.fillStyle = color;
        context.beginPath(); context.arc(xx, yy, 2.5, 0, Math.PI * 2); context.fill();
        if (labelsQuiet) { context.globalAlpha = 1; continue; }
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
        // Posun: hodnota NOVÉ úrovně pro tehdejší pozici (stejně jako na
        // vodorovné čáře — jinak „+20 b.“ u SL, který je pořád v mínusu, mate)
        // a na konci samotný posun ve směru obchodu (+ = ve prospěch).
        const moved = hoveredLine.nextPrice != null
          ? protectionValueAt(history, hoveredLine.nextPrice, hoveredLine.at, options.pointValue ?? 2, options.direction) : null;
        const text = hoveredLine.nextPrice != null ? [
          `${name} ${priceText(hoveredLine.price)} → ${priceText(hoveredLine.nextPrice)}`,
          moved ? `${signed(moved.points)} b.` : null,
          moved ? `${signed(moved.usd)} $` : null,
          value && moved ? `posun ${signed(moved.points - value.points)} b.` : null,
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
      if (options.highlightMs && options.highlightMs > 0 && arrows.length) {
        highlightActive = true;
        labelsQuiet = true;
        hovered = new Set(arrows.map((_, index) => index));
        animate();
        highlightTimer = setTimeout(() => {
          highlightTimer = null;
          if (!highlightActive) return;
          highlightActive = false;
          hovered = new Set();
          animate();
        }, options.highlightMs);
      }
      if (!options.muted) chart.subscribeCrosshairMove?.(onCrosshair);
      params.requestUpdate();
    },
    detached: () => {
      chart.unsubscribeCrosshairMove?.(onCrosshair);
      if (frame != null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
      if (highlightTimer != null) clearTimeout(highlightTimer);
      highlightTimer = null; highlightActive = false;
      frame = null; requestUpdate = null;
    },
    paneViews: () => views,
    // Cena plnění pod kurzorem i na cenové ose (barva šipky).
    priceAxisViews: () => arrows.flatMap((arrow, index) => {
      if (progressOf(`a${index}`) < 0.5 || hitBoxes[index] == null) return [];
      const y = series.priceToCoordinate(arrow.price);
      if (y == null) return [];
      const color = arrow.buy ? JOURNAL_BUY_COLOR : JOURNAL_SELL_COLOR;
      return [{ coordinate: () => y, text: () => arrow.price.toFixed(2), textColor: () => '#ffffff', backColor: () => color, visible: () => true, tickVisible: () => true }];
    }),
    autoscaleInfo: options.autoscaleLevels && !options.muted ? (start: Logical, end: Logical) => {
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
