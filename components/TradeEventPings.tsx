import React, { useEffect, useRef, useState } from 'react';
import type { ChartViewApi } from '@getcandlekit/charts/react';
import type { Time, UTCTimestamp } from 'lightweight-charts';
import type { TradeTimelineEvent } from '../lib/tradeReplay';
import { containingBarTime } from './ChartNotesLayer';
import { EVENT_COLOR } from './TradeProgress';

/** Jak dlouho kroužek v grafu žije (odpovídá animaci `trade-event-ping`). */
const PING_MS = 950;
/** Krok přehrávání může přejít přes víc událostí — víc kroužků by jen blikalo. */
const PING_MAX = 3;

interface Ping { key: number; x: number; y: number; color: string }

/**
 * Při přehrávání obchodu krátce problikne kroužek přímo v místě události
 * (čas × cena). Nic v grafu nezůstane — text události je vedle tlačítka Průběh.
 */
export default function TradeEventPings({ chartApi, containerRef, events, cutoffMs, barTimes }: {
  chartApi: ChartViewApi | null;
  containerRef: React.RefObject<HTMLDivElement | null>;
  events: readonly TradeTimelineEvent[];
  cutoffMs: number | null;
  barTimes: readonly number[];
}) {
  const [pings, setPings] = useState<Ping[]>([]);
  const previous = useRef<number | null>(cutoffMs);
  const pingKey = useRef(0);
  const timers = useRef(new Set<number>());

  useEffect(() => {
    const before = previous.current;
    previous.current = cutoffMs;
    // Jen dopředný pohyb přehrávání; skok zpět nebo konec přehrávání nic neohlásí.
    if (cutoffMs == null || before == null || cutoffMs <= before) return;
    const container = containerRef.current;
    if (!chartApi || !container) return;
    const fresh = events.filter(event => event.price != null && event.at > before && event.at <= cutoffMs).slice(-PING_MAX);
    if (!fresh.length) return;
    let added: Ping[] = [];
    try {
      const chart = chartApi.controller.getChart();
      const series = chartApi.controller.getSeries();
      const origin = chart.chartElement().getBoundingClientRect();
      const box = container.getBoundingClientRect();
      const timeScale = chart.timeScale();
      const paneWidth = timeScale.width();
      const paneHeight = chart.paneSize(0).height;
      added = fresh.flatMap(event => {
        const time = containingBarTime(barTimes, Math.floor(event.at / 1000));
        if (time == null) return [];
        const x = timeScale.timeToCoordinate(time as UTCTimestamp as Time);
        const y = series.priceToCoordinate(event.price as number);
        if (x == null || y == null || x < 0 || x > paneWidth || y < 0 || y > paneHeight) return [];
        return [{ key: ++pingKey.current, x: x + origin.left - box.left, y: y + origin.top - box.top, color: EVENT_COLOR[event.kind] }];
      });
    } catch { return; }
    if (!added.length) return;
    setPings(current => [...current, ...added]);
    // Časovač nesmí zrušit další krok přehrávání (přijde dřív, než kroužek dobliká).
    const keys = new Set(added.map(ping => ping.key));
    const timer = window.setTimeout(() => {
      timers.current.delete(timer);
      setPings(current => current.filter(ping => !keys.has(ping.key)));
    }, PING_MS);
    timers.current.add(timer);
  }, [barTimes, chartApi, containerRef, cutoffMs, events]);
  useEffect(() => () => { timers.current.forEach(window.clearTimeout); timers.current.clear(); }, []);

  if (!pings.length) return null;
  return (
    <div aria-hidden="true" data-snapshot-hide className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
      {pings.map(ping => (
        <span key={ping.key} className="trade-event-ping absolute h-2.5 w-2.5 rounded-full border-2"
          style={{ left: ping.x, top: ping.y, borderColor: ping.color }} />
      ))}
    </div>
  );
}
