import type { TradeExecutionHistory } from './tradeExecutionHistory.js';

/**
 * Průběh obchodu pro detail: čitelné události z historie brokera a stav
 * historie k libovolnému okamžiku pro přehrávání. Všechno je odvozené jen
 * z doložených plnění a potvrzených změn SL/TP — nic se nedopočítává.
 */

export type TradeTimelineKind = 'order' | 'entry' | 'add' | 'partial' | 'exit' | 'sl' | 'tp';

export interface TradeTimelineEvent {
  id: string;
  at: number;
  kind: TradeTimelineKind;
  title: string;
  detail: string;
  price: number | null;
  /** Posuny SL těsně za sebou tvoří sérii, kterou seznam i bublina sbalí. */
  seriesKey?: string;
}

type Fill = TradeExecutionHistory['fills'][number];

const price = (value: number) => value.toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const points = (value: number) => value.toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Dílčí plnění jednoho příkazu přicházejí v rozmezí milisekund — jde o jednu událost. */
const FILL_GROUP_MS = 2_000;
/** Tolik posunů SL za sebou (bez jiné události mezi nimi) už je série. */
export const SL_SERIES_MIN = 3;
const TICK = 0.25;

function groupFills(fills: readonly Fill[]): Fill[][] {
  const sorted = [...fills].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const groups: Fill[][] = [];
  for (const fill of sorted) {
    const last = groups.at(-1);
    if (last && last[0].role === fill.role && last[0].side === fill.side && fill.at - last.at(-1)!.at <= FILL_GROUP_MS) last.push(fill);
    else groups.push([fill]);
  }
  return groups;
}

const quantityOf = (group: readonly Fill[]) => group.reduce((sum, fill) => sum + fill.allocatedQuantity, 0);
const averagePrice = (group: readonly Fill[]) => {
  const quantity = quantityOf(group);
  return quantity > 0 ? group.reduce((sum, fill) => sum + fill.price * fill.allocatedQuantity, 0) / quantity : group[0].price;
};

/** Úroveň SL/TP platná v daný okamžik (poslední potvrzená, případně odeslaná před vstupem). */
function levelAt(history: TradeExecutionHistory, kind: 'sl' | 'tp', at: number): number | null {
  let level: number | null = null;
  for (const event of [...history.protection].sort((a, b) => a.at - b.at)) {
    if (event.at > at) break;
    if (event.kind !== kind || event.price == null) continue;
    if (event.status === 'confirmed' || (event.status === 'pending' && event.operation === 'new')) level = event.price;
    if (event.status === 'cancelled') level = null;
  }
  return level;
}

/** Plnění sloučená po příkazech — pro šipky vstupu a výstupu v grafu. */
export interface TradeFillGroup { at: number; role: 'entry' | 'exit'; side: 'Buy' | 'Sell'; quantity: number; price: number }
export function tradeFillGroups(history: TradeExecutionHistory | undefined): TradeFillGroup[] {
  if (!history) return [];
  return groupFills(history.fills).map(group => ({
    at: group[0].at, role: group[0].role, side: group[0].side === 'Buy' ? 'Buy' : 'Sell', quantity: quantityOf(group), price: averagePrice(group),
  }));
}

/** SL a TP platné v okamžiku `at` (pro štítky na cenové ose). */
export function protectionLevelsAt(history: TradeExecutionHistory | undefined, at: number): { sl: number | null; tp: number | null } {
  if (!history) return { sl: null, tp: null };
  return { sl: levelAt(history, 'sl', at), tp: levelAt(history, 'tp', at) };
}

/** Riziko v bodech: vzdálenost prvního vstupu od SL platného při vstupu. */
export function initialRiskPoints(history: TradeExecutionHistory | undefined): number | null {
  if (!history) return null;
  const entry = history.fills.filter(fill => fill.role === 'entry').sort((a, b) => a.at - b.at)[0];
  if (!entry) return null;
  // Příkaz odejde s SL těsně před plněním; potvrzení může dorazit ve stejné ms.
  const stop = levelAt(history, 'sl', entry.at + FILL_GROUP_MS);
  if (stop == null) return null;
  const risk = Math.abs(entry.price - stop);
  return risk > 0 ? risk : null;
}

export function tradeTimelineEvents(history: TradeExecutionHistory | undefined): TradeTimelineEvent[] {
  if (!history) return [];
  const events: TradeTimelineEvent[] = [];
  const groups = groupFills(history.fills);
  const firstEntry = groups.find(group => group[0].role === 'entry');
  const exits = groups.filter(group => group[0].role === 'exit');
  const lastExit = exits.at(-1);
  const riskPts = initialRiskPoints(history);

  // Příkaz odeslaný před vstupem (SL/TP přiložené k objednávce).
  if (firstEntry) {
    const before = history.protection.filter(event => event.at < firstEntry[0].at && event.operation === 'new' && event.price != null
      && event.status !== 'rejected' && event.status !== 'cancelled');
    if (before.length) {
      const sl = before.filter(event => event.kind === 'sl').at(-1);
      const tp = before.filter(event => event.kind === 'tp').at(-1);
      events.push({ id: `order:${before[0].id}`, at: Math.min(...before.map(event => event.at)), kind: 'order', title: 'Příkaz odeslán',
        detail: [sl ? `SL ${price(sl.price!)}` : null, tp ? `TP ${price(tp.price!)}` : null].filter(Boolean).join(' · '), price: sl?.price ?? tp?.price ?? null });
    }
  }

  for (const group of groups) {
    const quantity = quantityOf(group);
    const avg = averagePrice(group);
    const side = group[0].side === 'Buy' ? 'Buy' : 'Sell';
    const at = group[0].at;
    if (group === firstEntry) {
      events.push({ id: `fill:${group[0].id}`, at, kind: 'entry', title: `Vstup · ${side} ${quantity}`,
        detail: `${price(avg)}${riskPts != null ? ` · riziko ${points(riskPts)} b.` : ''}`, price: avg });
    } else if (group[0].role === 'entry') {
      events.push({ id: `fill:${group[0].id}`, at, kind: 'add', title: `Přikoupeno · ${side} ${quantity}`, detail: price(avg), price: avg });
    } else {
      const closing = group === lastExit && history.position?.status !== 'open';
      const stop = levelAt(history, 'sl', at);
      const target = levelAt(history, 'tp', at);
      const reason = !closing ? null
        : stop != null && Math.abs(avg - stop) <= TICK * 2 ? 'stop'
          : target != null && Math.abs(avg - target) <= TICK * 2 ? 'cíl' : 'ručně';
      events.push({ id: `fill:${group[0].id}`, at, kind: closing ? 'exit' : 'partial',
        title: closing ? `Výstup · ${reason}` : `Částečný výstup · ${side} ${quantity}`,
        detail: `${side} ${quantity} · ${group.length > 1 ? 'Ø ' : ''}${price(avg)}${group.length > 1 ? ` · ${group.length} plnění` : ''}`, price: avg });
    }
  }

  // Změny SL/TP po vstupu — jen potvrzené a jen když se cena opravdu pohnula.
  const entryAt = firstEntry?.[0].at ?? -Infinity;
  const endAt = lastExit && history.position?.status !== 'open' ? lastExit[0].at : Infinity;
  const last: Record<'sl' | 'tp', number | null> = { sl: levelAt(history, 'sl', entryAt + FILL_GROUP_MS), tp: levelAt(history, 'tp', entryAt + FILL_GROUP_MS) };
  for (const event of [...history.protection].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))) {
    if (event.at <= entryAt + FILL_GROUP_MS || event.at > endAt || event.status !== 'confirmed' || event.price == null) continue;
    const before = last[event.kind];
    if (before === event.price) continue;
    last[event.kind] = event.price;
    const label = event.kind === 'sl' ? 'SL' : 'TP';
    events.push({ id: `prot:${event.id}`, at: event.at, kind: event.kind, title: `${label} posunut`,
      detail: before == null ? price(event.price) : `${price(before)} → ${price(event.price)}`, price: event.price });
  }

  events.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));

  // Série: SL_SERIES_MIN a víc posunů SL bez jiné události mezi nimi.
  for (let index = 0; index < events.length;) {
    if (events[index].kind !== 'sl') { index++; continue; }
    let end = index;
    while (end + 1 < events.length && events[end + 1].kind === 'sl') end++;
    if (end - index + 1 >= SL_SERIES_MIN) {
      const key = `sl-series:${events[index].id}`;
      for (let k = index; k <= end; k++) {
        const event = events[k];
        events[k] = { ...event, seriesKey: key, title: `SL ${price(event.price!)}` };
      }
    }
    index = end + 1;
  }
  return events;
}

/**
 * Historie tak, jak vypadala v okamžiku `at` — pro přehrávání. Pozdější plnění
 * a změny SL/TP zmizí; pozice, která ještě nebyla uzavřená, je otevřená
 * a čáry SL/TP končí právě v `at`.
 */
export function historyAt(history: TradeExecutionHistory, at: number): TradeExecutionHistory {
  const fills = history.fills.filter(fill => fill.at <= at);
  const closedAt = history.position?.closedAt ?? null;
  const closed = closedAt != null && closedAt <= at;
  return {
    ...history,
    fills,
    protection: history.protection.filter(event => event.at <= at),
    gaps: history.gaps.filter(gap => gap.from <= at).map(gap => ({ ...gap, to: gap.to != null && gap.to > at ? at : gap.to })),
    grossPnl: closed ? history.grossPnl : null,
    fees: closed ? history.fees : null,
    netPnl: closed ? history.netPnl : null,
    complete: closed && history.complete,
    position: history.position ? {
      ...history.position,
      status: closed ? history.position.status : 'open',
      closedAt: closed ? closedAt : null,
      openQuantity: closed ? history.position.openQuantity : null,
      observedThrough: closed ? history.position.observedThrough : Math.min(at, history.position.observedThrough ?? at),
    } : openWithoutPosition(history, fills, at),
  };
}

/** Starší historie nemá údaj o pozici — čáry SL/TP by pak neměly kde skončit. */
function openWithoutPosition(history: TradeExecutionHistory, fills: TradeExecutionHistory['fills'], at: number): TradeExecutionHistory['position'] {
  const lastExitAt = Math.max(...history.fills.filter(fill => fill.role === 'exit').map(fill => fill.at));
  if (!Number.isFinite(lastExitAt) || lastExitAt <= at) return undefined;
  const entry = fills.find(fill => fill.role === 'entry');
  if (!entry) return undefined;
  return { id: 'replay', status: 'open', openedAt: entry.at, closedAt: null, openQuantity: null, peakQuantity: 0, observedThrough: at };
}

/** Kolik událostí už proběhlo do okamžiku `at` (pro počítadlo na tlačítku Průběh). */
export const eventsDoneAt = (events: readonly TradeTimelineEvent[], at: number | null) =>
  at == null ? events.length : events.filter(event => event.at <= at).length;

/** Kolik by SL/TP na dané ceně v okamžiku `at` reálně stál/vynesl. */
export interface ProtectionValue {
  /** Kontraktů otevřených v tom okamžiku (před vstupem: velikost prvního vstupu). */
  quantity: number;
  /** Průměrná cena otevřené pozice. */
  averageEntry: number;
  /** Body od průměrného vstupu ve směru obchodu (záporné = ztráta). */
  points: number;
  /** Hrubě v USD pro otevřenou velikost (bez poplatků). */
  usd: number;
  /** Příkaz odeslaný před vstupem — počítá se s velikostí prvního vstupu. */
  planned: boolean;
}

export function protectionValueAt(history: TradeExecutionHistory, price: number, at: number, pointValue: number,
  direction?: string): ProtectionValue | null {
  const fills = [...history.fills].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const firstEntry = fills.find(fill => fill.role === 'entry');
  if (!firstEntry || !Number.isFinite(price)) return null;
  const long = firstEntry.side ? firstEntry.side === 'Buy' : String(direction ?? '').toLowerCase() !== 'short';
  // Průměrná cena otevřené pozice: přikoupení ji mění, částečný výstup ne.
  let quantity = 0; let cost = 0;
  for (const fill of fills) {
    if (fill.at > at) break;
    if (fill.role === 'entry') { cost += fill.price * fill.allocatedQuantity; quantity += fill.allocatedQuantity; continue; }
    const average = quantity > 0 ? cost / quantity : 0;
    quantity = Math.max(0, quantity - fill.allocatedQuantity);
    cost = average * quantity;
  }
  let planned = false;
  if (quantity <= 0) {
    // Po uzavření nic neriskuje; před vstupem ukážeme plán prvního příkazu.
    if (at >= firstEntry.at) return null;
    const group = groupFills(fills).find(item => item[0].role === 'entry')!;
    quantity = quantityOf(group); cost = averagePrice(group) * quantity; planned = true;
  }
  const averageEntry = cost / quantity;
  const points = (price - averageEntry) * (long ? 1 : -1);
  return { quantity, averageEntry, points, usd: points * pointValue * quantity, planned };
}
