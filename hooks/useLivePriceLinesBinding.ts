import { useEffect, useRef } from 'react';
import { LineStyle, type IPriceLine, type ISeriesApi } from 'lightweight-charts';
import type { ChartViewApi } from '@getcandlekit/charts/react';
import type { LivePriceLine } from '../lib/journalLivePosition';
import type { LivePriceLinesFeed } from '../lib/livePriceLinesFeed';

/**
 * Nakreslí čáry živé pozice (vstup, SL/TP, čekající vstup) do grafů jako
 * cenové čáry svíčkové řady — drží se ceny při posunu i zoomu. Jen
 * zobrazení: čáry nejdou přetáhnout a nic neodešlou. Mimo React (feed čar),
 * nejvýš jednou za snímek.
 */

export interface LivePriceLinesTarget {
  api: ChartViewApi | null;
  root: string;
}

type Controller = ChartViewApi['controller'];
type Drawn = Map<string, { line: IPriceLine; key: string }>;

const lineKey = (line: LivePriceLine) => `${line.price}|${line.title}|${line.color}|${line.style}`;

function seriesOf(controller: Controller): ISeriesApi<'Candlestick'> | null {
  try { return controller.getSeries() as ISeriesApi<'Candlestick'>; } catch { return null; }
}

export function drawLivePriceLines(controller: Controller, lines: readonly LivePriceLine[], drawn: Drawn): void {
  const series = seriesOf(controller);
  if (!series) return;
  const wanted = new Set(lines.map(line => line.id));
  drawn.forEach((entry, id) => {
    if (wanted.has(id as LivePriceLine['id'])) return;
    try { series.removePriceLine(entry.line); } catch { /* graf zanikl */ }
    drawn.delete(id);
  });
  for (const line of lines) {
    const key = lineKey(line);
    const existing = drawn.get(line.id);
    if (existing?.key === key) continue;
    const options = {
      price: line.price,
      color: line.color,
      lineWidth: 1 as const,
      lineStyle: line.style === 'solid' ? LineStyle.Solid : LineStyle.Dashed,
      axisLabelVisible: true,
      title: line.title,
    };
    try {
      if (existing) existing.line.applyOptions(options);
      else drawn.set(line.id, { line: series.createPriceLine(options), key });
      if (existing) existing.key = key;
    } catch { /* graf se přestavuje */ }
  }
}

export function clearLivePriceLines(controller: Controller, drawn: Drawn): void {
  drawLivePriceLines(controller, [], drawn);
}

export function useLivePriceLinesBinding(linesFeed: LivePriceLinesFeed | null, targets: readonly LivePriceLinesTarget[]): void {
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  const drawnRef = useRef(new Map<Controller, Drawn>());
  const scheduleRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (!linesFeed) return;
    let frame = 0;
    const apply = () => {
      frame = 0;
      const live = new Set<Controller>();
      for (const target of targetsRef.current) {
        const controller = target.api?.controller;
        if (!controller) continue;
        live.add(controller);
        let drawn = drawnRef.current.get(controller);
        if (!drawn) { drawn = new Map(); drawnRef.current.set(controller, drawn); }
        drawLivePriceLines(controller, linesFeed.current(target.root), drawn);
      }
      // Graf, který z cílů vypadl (jiný timeframe, zavřený panel): čáry z něj
      // smazat (pokud ještě žije), ať tam nezůstane stará poloha.
      drawnRef.current.forEach((drawn, controller) => {
        if (live.has(controller)) return;
        clearLivePriceLines(controller, drawn);
        drawnRef.current.delete(controller);
      });
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(apply); };
    scheduleRef.current = schedule;
    const unsubscribe = linesFeed.subscribe(schedule);
    schedule();
    return () => {
      unsubscribe();
      if (frame) window.cancelAnimationFrame(frame);
      scheduleRef.current = () => undefined;
      drawnRef.current.forEach((drawn, controller) => clearLivePriceLines(controller, drawn));
      drawnRef.current.clear();
    };
  }, [linesFeed]);

  // Nový graf nebo jiný kořen panelu: nakreslit hned, ne až s další obnovou.
  const key = targets.map(target => `${objectId(target.api)}:${target.root}`).join('|');
  useEffect(() => { scheduleRef.current(); }, [linesFeed, key]);
}

const objectIds = new WeakMap<object, number>();
let nextObjectId = 1;
const objectId = (value: object | null) => {
  if (!value) return 0;
  let id = objectIds.get(value);
  if (!id) {
    id = nextObjectId++;
    objectIds.set(value, id);
  }
  return id;
};
