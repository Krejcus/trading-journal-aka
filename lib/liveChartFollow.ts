import type { Bar } from '@getcandlekit/charts';
import type { ChartViewApi } from '@getcandlekit/charts/react';

/**
 * LIVE → Graf: graf stojí a nové svíčky dojíždějí doprava. Až je poslední
 * svíčka blíž než `LIVE_FOLLOW_GAP_BARS` od pravého okraje, graf se s každou
 * další posune tak, aby ten odstup držel (Filip 29. 10.). Kdo se dívá do
 * historie (poslední svíčka mimo záběr), tomu se záběr nehýbe. Jen zobrazení.
 *
 * CandleKit má `shiftVisibleRangeOnNewBar` vypnuté kvůli replayi a za
 * poslední svíčkou leží prázdné body osy budoucnosti — knihovna by sama
 * neposunula nic, proto se posouvá tady.
 */
export const LIVE_FOLLOW_GAP_BARS = 10;
/**
 * Jen pojistka proti nesmyslu. Po návratu ze skryté karty (rAF stál, data
 * běžela dál) přijde naráz i desítky svíček — i pak má graf dojet za nimi.
 */
export const LIVE_FOLLOW_MAX_NEW_BARS = 500;
/** Odstup nejvýš tolik ze šířky záběru — v přiblíženém grafu by svíčka utekla doleva. */
const MAX_GAP_SHARE = 0.4;
/** Větší posun (dohnání po skryté kartě) se neanimuje — skočí rovnou. */
const GLIDE_MAX_BARS = 12;
const GLIDE_MS = 240;

export interface LogicalRangeLike {
  from: number;
  to: number;
}

/** O kolik barů posunout záběr doprava po příchodu nových svíček (0 = nehýbat). */
export function liveFollowShift(input: {
  previousLastIndex: number;
  lastIndex: number;
  range: LogicalRangeLike;
  gapBars?: number;
}): number {
  const { previousLastIndex, lastIndex, range } = input;
  const added = lastIndex - previousLastIndex;
  if (!(added >= 1 && added <= LIVE_FOLLOW_MAX_NEW_BARS)) return 0;
  // Poslední svíčka před příchodem nové nebyla v záběru: uživatel se dívá jinam.
  const tolerance = 0.5;
  if (previousLastIndex < range.from - tolerance || previousLastIndex > range.to + tolerance) return 0;
  const gapBars = Math.min(input.gapBars ?? LIVE_FOLLOW_GAP_BARS, (range.to - range.from) * MAX_GAP_SHARE);
  const shift = gapBars - (range.to - lastIndex);
  // Zbytek po plynulém posunu (9,999999) nemá spouštět další posun.
  return shift > 1e-3 ? shift : 0;
}

type ChartController = ChartViewApi['controller'];
type Chart = ReturnType<ChartController['getChart']>;

/** Naposled viděný poslední bar grafu; jiný timeframe = počítat znovu. */
export type LiveFollowMemory = WeakMap<ChartController, { timeframe: string; lastTs: number }>;

const glides = new WeakMap<Chart, { frame: number; off: () => void }>();

function stopGlide(chart: Chart): void {
  const glide = glides.get(chart);
  if (!glide) return;
  glides.delete(chart);
  window.cancelAnimationFrame(glide.frame);
  glide.off();
}

const reducedMotion = () => typeof window === 'undefined'
  || typeof window.matchMedia !== 'function'
  || window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Posun pravého okraje o `shift` barů. Plynulý jde po přírůstcích — nová
 * svíčka uprostřed posunu mění základ odsazení (knihovna ho hned vyrovná)
 * a absolutní cíl by pak poskočil o bar. Chycení grafu myší nebo kolečko
 * posun zastaví.
 */
function glideBy(chart: Chart, shift: number): void {
  const timeScale = chart.timeScale();
  if (reducedMotion() || shift > GLIDE_MAX_BARS) {
    timeScale.scrollToPosition(timeScale.scrollPosition() + shift, false);
    return;
  }
  const element = chart.chartElement();
  const cancel = () => stopGlide(chart);
  element.addEventListener('pointerdown', cancel, true);
  element.addEventListener('wheel', cancel, { capture: true, passive: true });
  const off = () => {
    element.removeEventListener('pointerdown', cancel, true);
    element.removeEventListener('wheel', cancel, true);
  };
  const startedAt = performance.now();
  let applied = 0;
  const step = (now: number) => {
    const progress = Math.min(1, Math.max(0, (now - startedAt) / GLIDE_MS));
    const wanted = shift * (1 - (1 - progress) ** 3);
    try {
      // Předchozí krok knihovna provedla při kreslení před tímhle snímkem.
      timeScale.scrollToPosition(timeScale.scrollPosition() + (wanted - applied), false);
      applied = wanted;
    } catch {
      stopGlide(chart);
      return;
    }
    if (progress >= 1) {
      glides.delete(chart);
      off();
      return;
    }
    glide.frame = window.requestAnimationFrame(step);
  };
  const glide = { frame: window.requestAnimationFrame(step), off };
  glides.set(chart, glide);
}

/**
 * Po nových svíčkách posune záběr grafu podle `liveFollowShift`. Volá se ve
 * snímku po zápisu živé svíčky nebo obnově dat — až graf provedl svoje
 * odložené změny záběru (knihovna je řadí na vykreslení). `held` = uživatel
 * graf právě drží myší: posun se vynechá a dožene se s další svíčkou.
 */
export function followLiveEdge(
  api: ChartViewApi | null,
  timeframe: string,
  memory: LiveFollowMemory,
  held: (element: HTMLElement) => boolean,
): void {
  const controller = api?.controller;
  if (!controller) return;
  try {
    const last: Bar | undefined = controller.getBars().at(-1);
    if (!last) return;
    const previous = memory.get(controller);
    memory.set(controller, { timeframe, lastTs: last.ts });
    if (!previous || previous.timeframe !== timeframe || last.ts <= previous.lastTs) return;
    const chart = controller.getChart();
    // Rozběhnutý posun zastavit; odstup se měří znovu z toho, co graf ukazuje.
    stopGlide(chart);
    const timeScale = chart.timeScale();
    const range = timeScale.getVisibleLogicalRange();
    const previousLastIndex = timeScale.timeToIndex((previous.lastTs / 1_000) as never, true);
    const lastIndex = timeScale.timeToIndex((last.ts / 1_000) as never, true);
    if (!range || previousLastIndex === null || lastIndex === null) return;
    const shift = liveFollowShift({ previousLastIndex, lastIndex, range });
    if (shift <= 0 || held(chart.chartElement())) return;
    glideBy(chart, shift);
  } catch {
    // Graf se právě přestavuje.
  }
}
