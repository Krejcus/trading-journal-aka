import React, { Suspense, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ErrorBoundary } from './ErrorBoundary';
import { QuantumSpinner } from './QuantumLoader';
import type { LiveTradingCopierState, LiveTradingTab } from './LiveTradingScreen';
import type { TradovateLiveTab } from '../lib/tradovateLiveTab';
import type { LiveTradeGroup, LiveTradeTarget } from '../lib/liveTradeTarget';
import type { LiveChartPosition } from '../lib/liveChartPosition';
import type { LiveChartDisarm } from '../lib/liveTradeGroupSource';
import type { LeaderEntryPreviewResult, LiveEntryPreviewDraft } from '../lib/leaderEntryPreview';
import type { LeaderEntryPlaceResult } from '../lib/leaderEntryPlace';
import type { LeaderOrderManageAction, LeaderOrderManageResult } from '../lib/leaderOrderManage';

/**
 * Obálka LIVE → Graf pro desk. Graf s workspace je těžký, a tak se načítá
 * líně — ale s vlastní hranicí Suspense tady, ne v desku: LIVE desk ani
 * přehled nesmí nic suspendovat (studený start LIVE,
 * tests/liveColdStartRegressions.test.ts).
 *
 * Načítání i pád grafu mají vždy cestu na Live Dashboard (DISARM, kill —
 * INV-UI-02). Pád si zapamatuje session, aby po reloadu LIVE neotevřelo
 * znovu graf a nespadlo do kola.
 */
const LiveTradingScreen = React.lazy(() => import('./LiveTradingScreen'));

export const LIVE_CHART_CRASH_KEY = 'at:live-chart-crashed';

export const liveChartCrashedThisSession = (): boolean => {
  try { return typeof window !== 'undefined' && window.sessionStorage.getItem(LIVE_CHART_CRASH_KEY) === '1'; } catch { return false; }
};

const rememberLiveChartCrash = () => {
  try { window.sessionStorage.setItem(LIVE_CHART_CRASH_KEY, '1'); } catch { /* bez úložiště jen bez paměti */ }
};

/** Délka odchodové animace (`.live-chart-leave` v index.css). */
const LEAVE_MS = 280;
const reducedMotion = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

interface Props {
  /** Záložka Graf je vybraná. Po zavření vrstva ještě dohraje odchod. */
  open: boolean;
  isDark: boolean;
  tabs: LiveTradingTab[];
  onNavigate: (tab: TradovateLiveTab) => void;
  navigationBlocked?: boolean;
  copier: LiveTradingCopierState;
  /** Skupina a účty ze stavu workeru; null = žádná skupina (bez čipu a výběru účtu). */
  group?: LiveTradeGroup | null;
  /** Obsahový klíč skupiny (porovnání bez překreslování po každém tiku desku). */
  groupKey?: string;
  position?: LiveChartPosition | null;
  /** Vypnutí kopírky v hlavičce; null = kopírka prokazatelně vypnutá. */
  disarm?: LiveChartDisarm | null;
  /** Stabilní funkce desku (safety cesta). */
  onDisarm?: () => Promise<{ tone: 'info' | 'error'; text: string }>;
  onTargetChange?: (target: LiveTradeTarget) => void;
  onPreviewEntry?: (draft: LiveEntryPreviewDraft) => Promise<LeaderEntryPreviewResult>;
  onPlaceEntry?: (draft: LiveEntryPreviewDraft, operationId: string) => Promise<LeaderEntryPlaceResult>;
  onManageEntry?: (action: LeaderOrderManageAction, expectPrice: number, newPrice?: number) => Promise<LeaderOrderManageResult>;
}

/** Vrstva přes celou obrazovku pro načítání a pád — vždy s cestou na přehled. */
const FallbackLayer: React.FC<{ isDark: boolean; failed: boolean; leaving: boolean; onNavigate: (tab: TradovateLiveTab) => void }> = ({ isDark, failed, leaving, onNavigate }) => createPortal(
  <div
    className={`fixed inset-0 z-[300] grid place-items-center ${leaving ? 'live-chart-leave' : 'live-chart-enter'} ${isDark ? 'bg-[#070a0f] text-slate-100' : 'bg-[#f4f6f8] text-slate-900'}`}
    aria-busy={!failed}
    aria-label={failed ? 'LIVE graf se nepodařilo zobrazit' : 'Načítám LIVE graf'}
  >
    <div className="grid justify-items-center gap-4 text-center">
      {failed
        ? <p className="m-0 max-w-[360px] text-sm font-bold">Graf se nepodařilo zobrazit. Kopírka i přehled fungují dál.</p>
        : <QuantumSpinner />}
      <button
        type="button"
        onClick={() => onNavigate('overview')}
        className={`h-9 rounded-lg border px-4 text-[12px] font-extrabold ${isDark ? 'border-white/15 text-slate-100 hover:bg-white/[0.08]' : 'border-slate-900/15 text-slate-800 hover:bg-white'}`}
      >Live Dashboard →</button>
    </div>
  </div>,
  document.body,
);

const sameTabs = (left: LiveTradingTab[], right: LiveTradingTab[]) => (
  left.length === right.length && left.every((tab, index) => tab.id === right[index].id && tab.label === right[index].label)
);
const sameCopier = (left: LiveTradingCopierState, right: LiveTradingCopierState) => (
  left.status === right.status && left.available === right.available && left.pending === right.pending
  && left.transport === right.transport && left.reconnectRequired === right.reconnectRequired
  && left.journalHealth === right.journalHealth
);

const LiveTradingScreenSlot: React.FC<Props> = ({ open, ...props }) => {
  // Odchod z grafu: vrstva ještě 280 ms dohraje „složení“, ale kliky už
  // nebere (`.live-chart-leave`) — přehled s DISARM je pod ní dostupný hned.
  const [present, setPresent] = useState(open);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (open) { setPresent(true); setLeaving(false); return undefined; }
    if (reducedMotion()) { setPresent(false); setLeaving(false); return undefined; }
    setLeaving(true);
    const timer = window.setTimeout(() => { setPresent(false); setLeaving(false); }, LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [open]);
  if (!open && !present) return null;
  const closing = !open || leaving;
  return (
    <ErrorBoundary name="LiveTradingScreen" onError={rememberLiveChartCrash} fallback={<FallbackLayer isDark={props.isDark} failed leaving={closing} onNavigate={props.onNavigate} />}>
      <Suspense fallback={<FallbackLayer isDark={props.isDark} failed={false} leaving={closing} onNavigate={props.onNavigate} />}>
        <LiveTradingScreen {...props} leaving={closing} />
      </Suspense>
    </ErrorBoundary>
  );
};

// Desk se překresluje každou sekundu (čerstvost stavu) — graf jen při změně vstupu.
export default React.memo(LiveTradingScreenSlot, (left, right) => (
  left.open === right.open && left.isDark === right.isDark && left.onNavigate === right.onNavigate
  && left.navigationBlocked === right.navigationBlocked
  && sameTabs(left.tabs, right.tabs) && sameCopier(left.copier, right.copier)
  && (left.groupKey ?? '') === (right.groupKey ?? '') && (left.position?.key ?? '') === (right.position?.key ?? '')
  && left.disarm?.label === right.disarm?.label && left.disarm?.unverified === right.disarm?.unverified
  && left.onDisarm === right.onDisarm && left.onTargetChange === right.onTargetChange
  && left.onPreviewEntry === right.onPreviewEntry
  && left.onPlaceEntry === right.onPlaceEntry
  && left.onManageEntry === right.onManageEntry
));
