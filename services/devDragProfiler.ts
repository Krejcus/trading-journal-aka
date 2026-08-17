/**
 * Dev-only profiler tažení. Sekání při úpravě kreseb se nedá spolehlivě
 * reprodukovat syntetickými událostmi (CandleKit drag se na ně nechytí),
 * takže se měří skutečné tažení uživatele: od pointerdown do pointerup se
 * sbírají long tasky, pomalé události z Event Timing API a délky React
 * commitů. Výsledek se ukládá do localStorage — origin je sdílený, takže
 * jde záznam přečíst i z jiné záložky (diagnostika bez zásahu uživatele).
 *
 * Instaluje se jen v dev buildu; v produkci modul nikdo neimportuje za běhu.
 */

const STORAGE_KEY = 'at:dev:drag-profile';
const MAX_RECORDS = 5;

export interface DragProfileRecord {
  startedAt: string;
  durationMs: number;
  moves: number;
  longTasks: number[];
  /** Události s duration ≥ 24 ms: [název, celková duration, čistý processing]. */
  slowEvents: Array<[string, number, number]>;
  reactCommits: number;
  reactCommitMsTotal: number;
  worstCommitMs: number;
}

interface ActiveRecording {
  startedAt: number;
  moves: number;
  longTasks: number[];
  slowEvents: Array<[string, number, number]>;
  reactCommits: number;
  reactCommitMsTotal: number;
  worstCommitMs: number;
}

let active: ActiveRecording | null = null;
let installed = false;

/** React Profiler callback — commit se přičte jen během aktivního tažení. */
export const recordDragProfilerCommit = (actualDuration: number): void => {
  if (!active) return;
  active.reactCommits += 1;
  active.reactCommitMsTotal += actualDuration;
  active.worstCommitMs = Math.max(active.worstCommitMs, actualDuration);
};

const persist = (record: DragProfileRecord) => {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as DragProfileRecord[] : [];
    const next = [...parsed.slice(-(MAX_RECORDS - 1)), record];
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch { /* plná/blokovaná storage nesmí nic rozbít */ }
};

export const installDevDragProfiler = (): void => {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  const longTaskObserver = new PerformanceObserver(list => {
    if (!active) return;
    list.getEntries().forEach(entry => active!.longTasks.push(Math.round(entry.duration)));
  });
  try { longTaskObserver.observe({ entryTypes: ['longtask'] }); } catch { /* nepodporováno */ }

  const eventObserver = new PerformanceObserver(list => {
    if (!active) return;
    list.getEntries().forEach(entry => {
      const timing = entry as PerformanceEventTiming;
      if (active!.slowEvents.length < 40) {
        active!.slowEvents.push([
          entry.name,
          Math.round(entry.duration),
          Math.round(timing.processingEnd - timing.processingStart),
        ]);
      }
    });
  });
  try { eventObserver.observe({ type: 'event', durationThreshold: 24 } as PerformanceObserverInit); } catch { /* nepodporováno */ }

  window.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    active = {
      startedAt: performance.now(),
      moves: 0,
      longTasks: [],
      slowEvents: [],
      reactCommits: 0,
      reactCommitMsTotal: 0,
      worstCommitMs: 0,
    };
  }, { capture: true, passive: true });

  window.addEventListener('pointermove', () => {
    if (active) active.moves += 1;
  }, { capture: true, passive: true });

  const finish = () => {
    if (!active) return;
    const recording = active;
    active = null;
    // Klik bez tažení nezajímá — záznam jen pro skutečné tahy.
    if (recording.moves < 8) return;
    persist({
      startedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - recording.startedAt),
      moves: recording.moves,
      longTasks: recording.longTasks,
      slowEvents: recording.slowEvents,
      reactCommits: recording.reactCommits,
      reactCommitMsTotal: Math.round(recording.reactCommitMsTotal),
      worstCommitMs: Math.round(recording.worstCommitMs),
    });
  };
  window.addEventListener('pointerup', finish, { capture: true, passive: true });
  window.addEventListener('pointercancel', finish, { capture: true, passive: true });
};
