import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import type { ChartViewApi } from '@getcandlekit/charts/react';
import type { LiveChartPosition } from '../lib/liveChartPosition';
import { createLivePositionBoxFollower, type LiveBoxEngine, type LiveBoxLink } from '../lib/livePositionBox';
import { withoutChartHistory } from '../services/chartWorkspaceHistory';
import { getLiveChartAutomation, subscribeLiveChartAutomation } from '../services/liveChartAutomation';

const LINK_KEY = 'at:live:position-box-link';
const TICK_MS = 5_000;

const readLink = (): LiveBoxLink | null => {
  try {
    const value = JSON.parse(window.localStorage.getItem(LINK_KEY) ?? 'null') as LiveBoxLink | null;
    return value?.id && value.target && value.side ? value : null;
  } catch {
    return null;
  }
};
const writeLink = (link: LiveBoxLink | null) => {
  try {
    if (link) window.localStorage.setItem(LINK_KEY, JSON.stringify(link));
    else window.localStorage.removeItem(LINK_KEY);
  } catch { /* vazba platí jen do zavření */ }
};

/**
 * Drží position box s otevřenou pozicí a ukončí ho s ní (logika v
 * `lib/livePositionBox.ts`). Jen zobrazení. Vrací stabilní `register` pro okna grafu.
 */
export function useLivePositionBoxFollow(options: {
  position: LiveChartPosition | null | undefined;
  target: string;
  events: readonly { kind: string; at: number }[] | null | undefined;
}): (api: ChartViewApi) => () => void {
  const enabled = useSyncExternalStore(subscribeLiveChartAutomation, () => getLiveChartAutomation().boxFollow, () => false);
  const latest = useRef(options);
  latest.current = options;
  const apis = useRef(new Map<ChartViewApi, number>());
  const follower = useRef<ReturnType<typeof createLivePositionBoxFollower> | null>(null);
  follower.current ??= createLivePositionBoxFollower({ readLink, writeLink, silently: withoutChartHistory });

  const run = useCallback(() => {
    const panes = [...apis.current.entries()].flatMap(([api, since]) => {
      const engine = api.drawing?.engine as unknown as LiveBoxEngine | null | undefined;
      return engine ? [{ engine, since }] : [];
    });
    follower.current!.step({ ...latest.current, now: Date.now(), panes });
  }, []);

  const positionKey = options.position?.key ?? null;
  useEffect(() => {
    if (!enabled) return undefined;
    run();
    const timer = window.setInterval(run, TICK_MS);
    return () => window.clearInterval(timer);
  }, [enabled, positionKey, options.target, run]);

  return useCallback((api: ChartViewApi) => {
    apis.current.set(api, Date.now());
    return () => { apis.current.delete(api); };
  }, []);
}
