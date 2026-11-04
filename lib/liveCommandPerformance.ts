/**
 * End-to-end diagnostika ručních LIVE příkazů. Záznam je čistě lokální a
 * nikdy nevstupuje do admission, freshness ani execution rozhodnutí.
 *
 * Jedna stopa je svázaná `operationId`: poslední potvrzovací klik → relay →
 * výsledek → zašifrovaná expozice workeru → první paint grafu. Platný vzorek
 * pro porovnání musí zůstat po celou dobu v popředí.
 */

export const LIVE_COMMAND_PERF_KEY = 'at:dev:live-command-traces-v1';
const MAX_TRACES = 60;

export type LiveCommandTraceStage = 'order' | 'fill' | 'position';

export interface LiveCommandWorkerTiming {
  queuedAt?: number;
  startedAt?: number;
  dispatchAt?: number;
  ackAt?: number;
  orderAt?: number;
  filledOrderAt?: number;
  fillAt?: number;
  positionAt?: number;
}

export interface LiveCommandTrace {
  operationId: string;
  kind: 'place-leader-entry' | 'manage-leader-order';
  action?: string;
  startedAt: string;
  startedEpochMs: number;
  startedPerformanceMs: number;
  startVisible: boolean;
  startFocused: boolean;
  stayedForeground: boolean;
  relayStartedMs?: number;
  relayCompletedMs?: number;
  resultMs?: number;
  resultStatus?: string;
  via?: 'inline' | 'poll' | 'error';
  serverTiming?: Record<string, number>;
  workerTiming?: LiveCommandWorkerTiming;
  stages?: Partial<Record<LiveCommandTraceStage, {
    receivedMs: number;
    paintedMs: number;
    receiveToPaintMs: number;
    clickToPaintMs: number;
    visible: boolean;
    focused: boolean;
  }>>;
  completedAt?: string;
  validForeground?: boolean;
}

const active = new Map<string, LiveCommandTrace>();
let visibilityListenerInstalled = false;
const pendingPersist = new Map<string, LiveCommandTrace>();
let persistTimer: ReturnType<typeof setTimeout> | null = null;

const browserState = () => ({
  visible: typeof document !== 'undefined' && document.visibilityState === 'visible',
  focused: typeof document !== 'undefined' && typeof document.hasFocus === 'function' && document.hasFocus(),
});

const flushPersist = () => {
  persistTimer = null;
  if (typeof window === 'undefined') return;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(LIVE_COMMAND_PERF_KEY) ?? '[]') as unknown;
    const ids = new Set(pendingPersist.keys());
    const rows = Array.isArray(parsed) ? parsed.filter(row => row && typeof row === 'object'
      && !ids.has(String((row as { operationId?: unknown }).operationId ?? ''))) : [];
    rows.push(...pendingPersist.values());
    pendingPersist.clear();
    window.localStorage.setItem(LIVE_COMMAND_PERF_KEY, JSON.stringify(rows.slice(-MAX_TRACES)));
  } catch {
    // Diagnostika nesmí ovlivnit obchodní příkaz ani vykreslení.
  }
};

/** Synchronous localStorage nikdy neběží v click/relay/paint hot path. */
const persist = (trace: LiveCommandTrace) => {
  if (typeof window === 'undefined') return;
  pendingPersist.set(trace.operationId, trace);
  if (!persistTimer) persistTimer = setTimeout(flushPersist, 750);
};

const installVisibilityListener = () => {
  if (visibilityListenerInstalled || typeof document === 'undefined') return;
  visibilityListenerInstalled = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') return;
    for (const trace of active.values()) {
      trace.stayedForeground = false;
      persist(trace);
    }
  });
  window.addEventListener('blur', () => {
    for (const trace of active.values()) {
      trace.stayedForeground = false;
      persist(trace);
    }
  });
  window.addEventListener('pagehide', flushPersist);
};

export function startLiveCommandTrace(
  operationId: string,
  input: { kind?: LiveCommandTrace['kind']; action?: string } = {},
): LiveCommandTrace | null {
  if (!operationId.startsWith('entry:') && !operationId.startsWith('manage:')) return null;
  const existing = active.get(operationId);
  if (existing) return existing;
  installVisibilityListener();
  const state = browserState();
  const trace: LiveCommandTrace = {
    operationId,
    kind: input.kind ?? (operationId.startsWith('manage:') ? 'manage-leader-order' : 'place-leader-entry'),
    ...(input.action ? { action: input.action } : {}),
    startedAt: new Date().toISOString(),
    startedEpochMs: Date.now(),
    startedPerformanceMs: performance.now(),
    startVisible: state.visible,
    startFocused: state.focused,
    stayedForeground: state.visible && state.focused,
  };
  if (active.size >= MAX_TRACES) active.delete(active.keys().next().value as string);
  active.set(operationId, trace);
  persist(trace);
  return trace;
}

const update = (operationId: string, mutate: (trace: LiveCommandTrace) => void): LiveCommandTrace | null => {
  const trace = active.get(operationId) ?? startLiveCommandTrace(operationId);
  if (!trace) return null;
  mutate(trace);
  persist(trace);
  return trace;
};

export function markLiveCommandRelayStart(operationId: string): void {
  update(operationId, trace => { trace.relayStartedMs = performance.now() - trace.startedPerformanceMs; });
}

export function markLiveCommandRelayResult(
  operationId: string,
  input: { via: 'inline' | 'poll' | 'error'; status?: string; serverTiming?: Record<string, number> },
): void {
  update(operationId, trace => {
    trace.relayCompletedMs = performance.now() - trace.startedPerformanceMs;
    trace.via = input.via;
    if (input.status) trace.resultStatus = input.status;
    if (input.serverTiming && Object.keys(input.serverTiming).length > 0) trace.serverTiming = input.serverTiming;
  });
}

export function markLiveCommandResult(operationId: string, status: string): void {
  update(operationId, trace => {
    trace.resultMs = performance.now() - trace.startedPerformanceMs;
    trace.resultStatus = status;
  });
}

export function hasActiveLiveCommandTrace(operationId: string): boolean {
  return active.has(operationId);
}

export function markLiveCommandPaint(input: {
  operationId: string;
  stage: LiveCommandTraceStage;
  receivedPerformanceAt: number;
  workerTiming?: LiveCommandWorkerTiming;
}): void {
  update(input.operationId, trace => {
    const paintedAt = performance.now();
    const state = browserState();
    trace.workerTiming = input.workerTiming;
    trace.stages = {
      ...(trace.stages ?? {}),
      [input.stage]: {
        receivedMs: input.receivedPerformanceAt - trace.startedPerformanceMs,
        paintedMs: paintedAt - trace.startedPerformanceMs,
        receiveToPaintMs: paintedAt - input.receivedPerformanceAt,
        clickToPaintMs: paintedAt - trace.startedPerformanceMs,
        visible: state.visible,
        focused: state.focused,
      },
    };
    if (!state.visible || !state.focused) trace.stayedForeground = false;
    if (input.stage === 'position') {
      trace.completedAt = new Date().toISOString();
      trace.validForeground = trace.startVisible && trace.startFocused && trace.stayedForeground && state.visible && state.focused;
      active.delete(input.operationId);
    }
  });
}

export function liveCommandWorkerStage(timing: LiveCommandWorkerTiming | undefined): LiveCommandTraceStage {
  if (timing?.positionAt != null) return 'position';
  if (timing?.fillAt != null || timing?.filledOrderAt != null) return 'fill';
  return 'order';
}

/** Pure helper pro report: délky uvnitř workeru/brokera, bez míchání hodin prohlížeče a workeru. */
export function liveCommandWorkerDurations(timing: LiveCommandWorkerTiming | undefined): Record<string, number> {
  if (!timing) return {};
  const duration = (from: number | undefined, to: number | undefined) => from != null && to != null && to >= from ? to - from : null;
  return Object.fromEntries([
    ['queuedToStartedMs', duration(timing.queuedAt, timing.startedAt)],
    ['startedToDispatchMs', duration(timing.startedAt, timing.dispatchAt)],
    ['dispatchToAckMs', duration(timing.dispatchAt, timing.ackAt)],
    ['ackToFillMs', duration(timing.ackAt, timing.fillAt ?? timing.filledOrderAt)],
    ['fillToPositionMs', duration(timing.fillAt ?? timing.filledOrderAt, timing.positionAt)],
  ].filter((row): row is [string, number] => row[1] != null));
}
