import { useEffect, useRef } from 'react';
import type { Bar } from '@getcandlekit/charts';
import type { ChartViewApi } from '@getcandlekit/charts/react';
import { planLiveCandleUpdate, type LiveCandleFeed } from '../lib/liveCandleFeed';
import type { MarketCandle, MarketTimeframe } from '../services/marketData';

/**
 * Napojí živou svíčku na grafy: při každé změně zdroje (nejvýš 1× za snímek)
 * přepíše jejich poslední bar přímo v grafu — mimo React, bez překreslení
 * stránky. Jen zobrazení: data grafu (`rawCandles`) ani nic uloženého se
 * nemění; další obnova dat svíčku přepíše a hook ji hned vrátí. Když živá
 * cena zmizí (stojí, kanál vypnut), graf se vrátí přesně na svá data —
 * stará „živá“ svíčka nesmí zůstat nakreslená jako skutečná (INV-UI-01).
 */

export interface LiveCandleTarget {
  api: ChartViewApi | null;
  root: string;
  timeframe: MarketTimeframe;
  /** 1m svíčky, ze kterých graf skládá svůj timeframe. */
  rawCandles: readonly MarketCandle[];
}

type ChartController = ChartViewApi['controller'];

/** Co živá svíčka v grafu změnila — aby šlo vrátit přesně data grafu. */
export interface LiveCandleDrawn {
  appended: Set<number>;
  originals: Map<number, Bar>;
  last: string | null;
}

/** Vrátí graf na jeho data (odebere připsané bary, obnoví přepsané). */
export function revertLiveCandle(controller: ChartController, drawn: LiveCandleDrawn): void {
  try {
    const bars = controller.getBars()
      .filter(bar => !drawn.appended.has(bar.ts))
      .map(bar => drawn.originals.get(bar.ts) ?? bar);
    controller.setData(bars);
  } catch {
    // Graf už neexistuje.
  }
}

export function applyLiveCandle(feed: LiveCandleFeed, target: LiveCandleTarget, drawnByController: Map<ChartController, LiveCandleDrawn>): void {
  const api = target.api;
  if (!api) return;
  try {
    const controller = api.controller;
    const drawn = drawnByController.get(controller);
    const live = feed.current(target.root);
    if (!live) {
      if (drawn) {
        drawnByController.delete(controller);
        revertLiveCandle(controller, drawn);
      }
      return;
    }
    const lastBar = controller.getBars().at(-1);
    const bar = planLiveCandleUpdate({ lastBar, live, timeframe: target.timeframe, rawCandles: target.rawCandles });
    if (!bar || !lastBar) return;
    // Beze změny baru nic nepřekreslovat (emit storu jen s čítači, heartbeat).
    const signature = `${bar.time}:${bar.open}:${bar.high}:${bar.low}:${bar.close}:${bar.volume}`;
    const state = drawn ?? { appended: new Set<number>(), originals: new Map<number, Bar>(), last: null };
    if (state.last === signature) return;
    const ts = bar.time * 1_000;
    if (lastBar.ts === ts) {
      if (!state.originals.has(ts) && !state.appended.has(ts)) state.originals.set(ts, { ...lastBar });
    } else {
      state.appended.add(ts);
    }
    controller.updateBar({ ts, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume });
    state.last = signature;
    drawnByController.set(controller, state);
  } catch {
    // Graf se právě přestavuje (jiný timeframe, nová data).
  }
}

// Identita grafu a jeho dat: nová data (i se stejnou délkou) graf nastaví znovu.
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

export function useLiveCandleBinding(feed: LiveCandleFeed | null, targets: readonly LiveCandleTarget[]): void {
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  const scheduleRef = useRef<() => void>(() => undefined);
  const drawnRef = useRef(new Map<ChartController, LiveCandleDrawn>());
  useEffect(() => {
    if (!feed) return;
    let frame = 0;
    const apply = () => {
      frame = 0;
      for (const target of targetsRef.current) applyLiveCandle(feed, target, drawnRef.current);
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(apply);
    };
    scheduleRef.current = schedule;
    const unsubscribe = feed.subscribe(schedule);
    schedule();
    return () => {
      unsubscribe();
      if (frame) window.cancelAnimationFrame(frame);
      scheduleRef.current = () => undefined;
      // Feed vypnut (přehrávání, konec dne): grafy zpět na jejich data.
      drawnRef.current.forEach((drawn, controller) => revertLiveCandle(controller, drawn));
      drawnRef.current.clear();
    };
  }, [feed]);
  // Nový graf nebo nová data (graf je nastavil znovu, živou svíčku tím zahodil):
  // záznam změn neplatí — vrátit živou svíčku hned, ne až s další cenou.
  const key = targets.map(target => `${objectId(target.api)}:${target.root}:${target.timeframe}:${objectId(target.rawCandles)}`).join('|');
  useEffect(() => {
    drawnRef.current.clear();
    scheduleRef.current();
  }, [feed, key]);
}
