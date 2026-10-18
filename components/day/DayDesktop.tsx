import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { Trade } from '../../types';
import AlphaTradeChartWorkspace, { type ReviewSlotElements, type WorkspacePanelOverlay } from '../AlphaTradeChartWorkspace';
import { QuantumSpinner } from '../QuantumLoader';
import { chartNotesOfTrades } from '../../lib/chartNotes';
import { onTradeChartIndicatorsChange, readTradeChartIndicators, writeTradeChartIndicators } from '../../services/detailIndicators';
import { MARKET_TIMEFRAME_MINUTES } from '../../services/marketData';
import { tradeChartTiming } from '../../services/tradeChartData';
import { DAY_BIAS_LABEL, DAY_EXECUTION_LABEL, carryForward, sessionWindows, type DaySession } from '../../lib/dayJournal';
import { sessionStage, type StreakDay } from '../../lib/dayJournalView';
import DayNotesLayer, { type DayBand, type DayPinPoint, type DayPinView } from './DayNotesLayer';
import { DayBottomStrip, DayDrawer, DayHeaderBar, DaySidePanel, streakStyle } from './DayPanels';
import { PinPopover, PrepBottom, PrepHeaderBar, prepPins } from './PrepPanels';
import { CloseBottom, CloseHeaderBar, CloseSide } from './ClosePanels';
import DictationDialog from './DictationDialog';
import { SESSION_STYLE, SaveCelebration, money } from './DayPrimitives';
import { dayAnchorTrade, focusRange, focusTarget, sessionBands, useReviewFocus } from './dayFocus';
import type { DayController } from './useDayController';

interface OverlayState {
  pins: DayPinView[];
  selectedId: string | null;
  bubbles: 'all' | 'selected';
  placing: 'note' | 'voice' | null;
  pending: DayPinPoint | null;
  pendingContent: React.ReactNode;
  nowTime: number | null;
  bands: DayBand[];
  onSelect: (id: string | null) => void;
  onPick: (point: DayPinPoint) => void;
  onCancelPlacing: () => void;
  fx: { key: number; session: DaySession | 'day'; sub: string } | null;
}

/** Malý externí store: vrstva poznámek se překreslí bez překreslení workspace. */
function createStore<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: T) { value = next; listeners.forEach(listener => listener()); },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
type OverlayStore = ReturnType<typeof createStore<OverlayState | null>>;

function PanelOverlay({ panel, store }: { panel: WorkspacePanelOverlay; store: OverlayStore }) {
  const state = useSyncExternalStore(store.subscribe, store.get, store.get);
  if (!state) return null;
  return (
    <>
      <DayNotesLayer
        chartApi={panel.chartApi}
        containerRef={panel.containerRef}
        barTimes={panel.barTimes}
        intervalSeconds={MARKET_TIMEFRAME_MINUTES[panel.timeframe] * 60}
        pins={state.pins}
        selectedId={state.selectedId}
        onSelect={state.onSelect}
        bubbles={state.bubbles}
        placing={panel.isActive ? state.placing : null}
        onPick={state.onPick}
        onCancelPlacing={state.onCancelPlacing}
        pending={state.pending}
        pendingContent={panel.isActive ? state.pendingContent : null}
        nowTime={state.nowTime}
        bands={state.bands}
      />
      {/* Záblesk přepnutí seance/rozsahu ve všech grafech rozložení. */}
      {state.fx && <SessionSwitchFx key={state.fx.key} session={state.fx.session} sub={state.fx.sub} />}
    </>
  );
}

/** Přepnutí London ↔ NY: záblesk přes graf a jmenovka session. */
function SessionSwitchFx({ session, sub }: { session: DaySession | 'day'; sub: string }) {
  const tint = SESSION_STYLE[session].tint;
  return (
    <div aria-hidden="true" style={{ position: 'absolute', inset: 0, zIndex: 30, pointerEvents: 'none', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(2,6,23,0.35)', animation: 'dj-dim .8s ease both' }} />
      <div style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: '45%', background: `linear-gradient(90deg,transparent,${tint}0.28),transparent)`, animation: 'dj-wipe .8s cubic-bezier(.4,0,.2,1) both' }} />
      <div className="dj" style={{ position: 'absolute', left: '50%', top: '46%', padding: '12px 22px', borderRadius: 14, textAlign: 'center', animation: 'dj-badge .95s cubic-bezier(.2,.9,.3,1) both', color: session === 'ny' ? '#ffedd5' : session === 'day' ? '#e2e8f0' : 'var(--dj-blue-text)', background: session === 'ny' ? 'rgba(67,20,7,0.85)' : session === 'day' ? 'rgba(15,23,42,0.85)' : 'rgba(23,37,84,0.85)', border: `1px solid ${tint}0.6)`, boxShadow: `0 20px 50px -12px ${tint}0.55)` }}>
        <span style={{ display: 'block', fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em' }}>{SESSION_STYLE[session].name}</span>
        <span className="dj-mono" style={{ display: 'block', marginTop: 2, fontSize: 11.5, fontWeight: 600, opacity: 0.8 }}>{sub}</span>
      </div>
    </div>
  );
}

type Celebration =
  | { kind: 'prep'; session: DaySession; fresh: boolean; seconds: number | null }
  | { kind: 'close'; session: DaySession; fresh: boolean };

export default function DayDesktop({ ctl, isDark, streak, onOpenTrade, onOpenLegacy, onOpenWeek, onOpenArchive, onOpenCoach, height }: {
  ctl: DayController;
  isDark: boolean;
  streak: StreakDay[];
  onOpenTrade?: (trade: Trade) => void;
  onOpenLegacy?: () => void;
  onOpenWeek?: () => void;
  onOpenArchive?: () => void;
  onOpenCoach?: () => void;
  height: string;
}) {
  const [slots, setSlots] = useState<ReviewSlotElements | null>(null);
  const [tradeIndicators, setTradeIndicators] = useState(readTradeChartIndicators);
  useEffect(() => onTradeChartIndicatorsChange(setTradeIndicators), []);
  const [dictating, setDictating] = useState(false);
  const [popover, setPopover] = useState<{ point: DayPinPoint; record: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [celebration, setCelebration] = useState<Celebration | null>(null);
  const [fx, setFx] = useState<OverlayState['fx']>(null);

  const { mode, modeSession: session } = ctl;
  // Oslava patří jen k obrazovce, kde se ukládalo (uživatel mezitím mohl odejít).
  const screenKey = `${ctl.day}:${mode}:${session}`;
  const screenRef = useRef(screenKey);
  screenRef.current = screenKey;
  // Deník B+: graf přes celou šířku, přehled a zápis v pásu dole. Časová osa,
  // obchod a plán (dřív pevný boční panel) vyjedou jen na vyžádání jako
  // skleněný panel nad grafem; v uzavření stejně tak „Plán vs. realita“.
  const rootRef = useRef<HTMLDivElement>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [closeDetailOpen, setCloseDetailOpen] = useState(false);
  useEffect(() => { setPopover(null); setSaveError(null); setCelebration(null); setDrawerOpen(false); setCloseDetailOpen(false); }, [mode, session, ctl.day]);
  // Výběr (obchod, poznámka) nebo bod pro novou poznámku panel otevře a ten
  // pak drží, dokud ho uživatel nezavře (smazání, přepnutí rozsahu ho nezavřou).
  useEffect(() => {
    if (mode === 'day' && (ctl.selected != null || ctl.pendingPoint != null)) setDrawerOpen(true);
  }, [ctl.pendingPoint, ctl.selected, mode]);
  const dayDrawerVisible = mode === 'day' && (drawerOpen || ctl.pendingPoint != null || ctl.selected != null);
  const closeDayDrawer = useCallback(() => {
    setDrawerOpen(false);
    ctl.setSelected(null);
    ctl.setPendingPoint(null);
  }, [ctl]);
  const addNote = useCallback(() => { ctl.setPendingPoint(null); ctl.setPlacing(ctl.placing === 'note' ? null : 'note'); }, [ctl]);

  // ── Záběr grafu ───────────────────────────────────────────────────────
  const range = focusRange({ mode, session, scope: ctl.scope, windows: ctl.chartWindows, now: ctl.now, isToday: ctl.isToday });
  const target = focusTarget(range);
  // Kotva se drží celý den (první záběr); další přesuny jdou událostí.
  const anchorRef = useRef<{ day: string; trade: Trade } | null>(null);
  if (!anchorRef.current || anchorRef.current.day !== ctl.day) anchorRef.current = { day: ctl.day, trade: dayAnchorTrade(ctl.day, target) };
  const anchor = anchorRef.current.trade;
  const selectedChartTrade = ctl.selectedTrade && mode === 'day'
    ? ctl.chart.chartTrades.find(trade => String(trade.id) === String(ctl.selectedTrade!.id)) ?? null
    : null;
  const chartTrade = selectedChartTrade ?? anchor;
  const contextTrades = ctl.chart.chartTrades;
  const tradeNotes = useMemo(() => chartNotesOfTrades(contextTrades), [contextTrades]);
  const focusKey = selectedChartTrade ? `trade:${selectedChartTrade.id}` : `${mode}:${session}:${ctl.scope}:${Math.round(target.entryMs / 60_000)}:${Math.round(target.exitMs / 60_000)}`;
  const focusDetail = selectedChartTrade
    ? { ...tradeChartTiming(selectedChartTrade), id: String(selectedChartTrade.id) }
    : { entryMs: target.entryMs, exitMs: target.exitMs, id: String(anchor.id) };
  useReviewFocus(focusKey, { entryMs: focusDetail.entryMs, exitMs: focusDetail.exitMs, id: focusDetail.id }, Boolean(slots), ctl.day);

  // ── Přepnutí session v přípravě / uzavření ────────────────────────────
  const switchSession = useCallback((next: DaySession) => {
    if (next === session) return;
    ctl.setModeSession(next);
    const opens = ctl.windows[next].start;
    const sub = mode === 'prep'
      ? (sessionStage(next, ctl.windows, ctl.now) === 'upcoming' ? `otevírá ${new Intl.DateTimeFormat('cs-CZ', { timeZone: 'Europe/Prague', hour: '2-digit', minute: '2-digit' }).format(opens)}` : 'session běží')
      : `${money(ctl.sessionStats[next].pnl)} · ${ctl.sessionStats[next].count} obchodů`;
    setFx({ key: Date.now(), session: next, sub });
  }, [ctl, mode, session]);
  // Deník: přepnutí Celý den / London / New York dostane stejný záblesk
  // s nápisem přes graf jako přepnutí seance v přípravě.
  const previousScopeRef = useRef(ctl.scope);
  useEffect(() => {
    const previous = previousScopeRef.current;
    previousScopeRef.current = ctl.scope;
    if (mode !== 'day' || previous === ctl.scope) return;
    const target = ctl.scope;
    const stats = target === 'day'
      ? { pnl: ctl.sessionStats.london.pnl + ctl.sessionStats.ny.pnl, count: ctl.dayTrades.length }
      : ctl.sessionStats[target];
    const count = `${stats.count} ${stats.count === 1 ? 'obchod' : stats.count > 1 && stats.count < 5 ? 'obchody' : 'obchodů'}`;
    const clockText = (ms: number) => new Intl.DateTimeFormat('cs-CZ', { timeZone: 'Europe/Prague', hour: '2-digit', minute: '2-digit' }).format(ms);
    const sub = target === 'day'
      ? `${money(stats.pnl)} · ${count}`
      : `${clockText(ctl.windows[target].start)}–${clockText(ctl.windows[target].end)} · ${money(stats.pnl)} · ${count}`;
    setFx({ key: Date.now(), session: target, sub });
  }, [ctl.dayTrades.length, ctl.scope, ctl.sessionStats, ctl.windows, mode]);
  useEffect(() => {
    if (!fx) return;
    const timer = window.setTimeout(() => setFx(null), 1000);
    return () => window.clearTimeout(timer);
  }, [fx]);

  // ── Vrstva poznámek ───────────────────────────────────────────────────
  const pins = useMemo(() => {
    if (mode === 'prep') return ctl.pinViews(note => note.origin === 'prep' && note.session === session, note => note.origin === 'prep' && note.session !== session);
    if (mode === 'close') return ctl.pinViews(note => note.session === session);
    return ctl.pinViews(note => ctl.scope === 'day' || note.session === ctl.scope || note.session === 'day');
  }, [ctl, mode, session]);
  const previousNy = useMemo(() => {
    const [y, m, d] = ctl.marketDay.split('-').map(Number);
    let date = new Date(Date.UTC(y, m - 1, d - 1));
    while (date.getUTCDay() === 0 || date.getUTCDay() === 6) date = new Date(date.getTime() - 86_400_000);
    return sessionWindows(date.toISOString().slice(0, 10)).ny;
  }, [ctl.marketDay]);
  const bands = useMemo(() => sessionBands(ctl.chartWindows, mode, previousNy), [ctl.chartWindows, mode, previousNy]);

  const store = useMemo(() => createStore<OverlayState | null>(null), []);
  const pick = useCallback((point: DayPinPoint) => {
    const kind = ctl.placing;
    ctl.setPlacing(null);
    if (mode === 'day') ctl.setPendingPoint(point);
    else { ctl.setPendingPoint(point); setPopover({ point, record: kind === 'voice' }); }
  }, [ctl, mode]);
  const closePopover = useCallback(() => { setPopover(null); ctl.setPendingPoint(null); }, [ctl]);
  useLayoutEffect(() => {
    store.set({
      pins,
      selectedId: ctl.selected?.kind === 'note' ? ctl.selected.id : null,
      bubbles: mode === 'prep' ? 'all' : 'selected',
      placing: ctl.placing,
      pending: ctl.pendingPoint,
      pendingContent: popover && mode !== 'day' ? <PinPopover key={`${popover.point.time}:${popover.point.price}`} ctl={ctl} point={popover.point} autoRecord={popover.record} onClose={closePopover} /> : null,
      nowTime: mode === 'prep' && ctl.isToday ? Math.floor(ctl.now / 1000) : null,
      bands,
      onSelect: id => ctl.setSelected(id ? { kind: 'note', id } : null),
      onPick: pick,
      onCancelPlacing: () => ctl.setPlacing(null),
      fx,
    });
  });
  const renderPanelOverlay = useCallback((panel: WorkspacePanelOverlay) => <PanelOverlay panel={panel} store={store} />, [store]);
  // MNQ i NQ: stejná cena, stejné svíčky dne (bez dalšího, případně placeného dotazu).
  const dayCandles = ctl.chart.candles;
  const candlesForRoot = useCallback(() => dayCandles, [dayCandles]);
  const review = useMemo(() => ({ onSlotsReady: setSlots, trades: contextTrades, drawingKey: `day:${ctl.day}`, renderPanelOverlay, candlesForRoot }), [candlesForRoot, contextTrades, ctl.day, renderPanelOverlay]);

  // ── Uložení ───────────────────────────────────────────────────────────
  const onSavePrep = async () => {
    setSaving(true); setSaveError(null);
    const started = ctl.prepDraft(session).openedAt;
    try {
      await ctl.savePrep(session);
      const origin = screenKey;
      window.setTimeout(() => { setSaving(false); if (screenRef.current === origin) setCelebration({ kind: 'prep', session, fresh: true, seconds: Math.round((Date.now() - started) / 1000) }); }, 720);
    } catch (reason) {
      setSaving(false);
      setSaveError(reason instanceof Error ? reason.message : 'Plán se nepodařilo uložit.');
    }
  };
  const onSaveClose = async () => {
    setSaving(true); setSaveError(null);
    try {
      await ctl.saveClose(session);
      const origin = screenKey;
      window.setTimeout(() => { setSaving(false); if (screenRef.current === origin) setCelebration({ kind: 'close', session, fresh: true }); }, 720);
    } catch (reason) {
      setSaving(false);
      setSaveError(reason instanceof Error ? reason.message : 'Uzavření se nepodařilo uložit.');
    }
  };
  const startVoicePin = () => { setPopover(null); ctl.setPendingPoint(null); ctl.setPlacing(ctl.placing === 'voice' ? null : 'voice'); };

  const { candles, loading, error } = ctl.chart;
  const ready = candles.length > 0;

  return (
    <div ref={rootRef} className="dj" style={{ position: 'relative', height, minHeight: 640, borderRadius: 16, overflow: 'hidden', border: '1px solid var(--dj-line)', background: 'var(--dj-bg)', animation: 'dj-enter .5s cubic-bezier(.22,.61,.36,1) both', transition: 'height .5s cubic-bezier(.22,.61,.36,1)' }}>
      {ready ? (
        <AlphaTradeChartWorkspace
          key={ctl.day}
          embedded
          trade={chartTrade}
          entryMs={selectedChartTrade ? tradeChartTiming(selectedChartTrade).entryMs : anchor.entryTime!}
          exitMs={selectedChartTrade ? tradeChartTiming(selectedChartTrade).exitMs : anchor.timestamp}
          initialRoot="MNQ"
          layoutScope="day"
          defaultLayoutId="1"
          initialCandles={candles}
          isDark={isDark}
          tradeIndicators={tradeIndicators}
          onTradeIndicatorsChange={writeTradeChartIndicators}
          // Poznámky k obchodům dne — jen pro čtení (píšou se v detailu obchodu).
          chartNotes={tradeNotes}
          review={review}
          onClose={ctl.backToDay}
        />
      ) : (
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', textAlign: 'center', padding: 24 }}>
          {loading ? <QuantumSpinner /> : (
            <div style={{ maxWidth: 420 }}>
              <p style={{ margin: 0, fontSize: 14, fontWeight: 800 }}>Svíčky pro tenhle den nejsou</p>
              <p style={{ margin: '6px 0 0', fontSize: 12.5, color: 'var(--dj-text-2)' }}>{error ?? 'Databento dnešek ještě nemá a živé čtení z TradingView chybí. Spusť worker s otevřeným 1m grafem MNQ.'}</p>
            </div>
          )}
        </div>
      )}

      {slots && mode === 'day' && createPortal(<DayHeaderBar ctl={ctl} onDictate={() => setDictating(true)} onOpenLegacy={onOpenLegacy} onOpenWeek={onOpenWeek} onOpenArchive={onOpenArchive} onAddNote={addNote} />, slots.header)}
      {slots && mode === 'day' && createPortal(<DayBottomStrip ctl={ctl} streak={streak} onOpenCoach={onOpenCoach} onOpenFeed={() => setDrawerOpen(true)} />, slots.bottom)}
      {slots && dayDrawerVisible && createPortal(
        <DayDrawer title={ctl.pendingPoint ? 'Nová poznámka' : ctl.selectedTrade ? 'Obchod' : 'Deník dne'} onClose={closeDayDrawer} escapeEnabled={!dictating && !ctl.placing && ctl.pendingPoint == null}>
          <DaySidePanel ctl={ctl} inDrawer streak={streak} onOpenCoach={onOpenCoach} onOpenTrade={onOpenTrade} onAddNote={addNote} />
        </DayDrawer>,
        slots.overlay,
      )}

      {slots && mode === 'prep' && createPortal(<PrepHeaderBar ctl={ctl} session={session} onSwitch={switchSession} />, slots.header)}
      {slots && mode === 'prep' && createPortal(<PrepBottom ctl={ctl} session={session} saving={saving} error={saveError} onSave={() => void onSavePrep()} onVoice={startVoicePin} />, slots.bottom)}

      {slots && mode === 'close' && createPortal(<CloseHeaderBar ctl={ctl} session={session} onSwitch={switchSession} />, slots.header)}
      {slots && mode === 'close' && closeDetailOpen && createPortal(
        <DayDrawer title={`Plán vs. realita · ${SESSION_STYLE[session].name}`} onClose={() => setCloseDetailOpen(false)} escapeEnabled={!dictating && !ctl.placing}>
          <div className="dj-scroll" style={{ height: '100%', overflowY: 'auto' }}><CloseSide ctl={ctl} session={session} /></div>
        </DayDrawer>,
        slots.overlay,
      )}
      {slots && mode === 'close' && createPortal(<CloseBottom ctl={ctl} session={session} saving={saving} error={saveError} onClose={() => void onSaveClose()} onOpenDetail={() => setCloseDetailOpen(open => !open)} detailOpen={closeDetailOpen} />, slots.bottom)}

      {dictating && <DictationDialog ctl={ctl} onClose={() => setDictating(false)} />}

      {celebration?.kind === 'prep' && (() => {
        const prep = ctl.journal.preps[celebration.session];
        const pinCount = prepPins(ctl, celebration.session).length;
        const seconds = celebration.seconds ?? prep?.durationSec ?? 0;
        return (
          <SaveCelebration
            fresh={celebration.fresh}
            origin={{ left: 'calc(100% - 210px)', top: 'calc(100% - 59px)' }}
            title="Plán je uložený"
            subtitle={`Za ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}. V review dne ho uvidíš fialově, s časem zápisu.`}
            rows={[
              { label: 'Bias', value: prep?.bias ? `${prep.bias === 'long' ? '↗' : prep.bias === 'short' ? '↘' : '→'} ${DAY_BIAS_LABEL[prep.bias]}` : '—' },
              { label: 'Scénář', value: prep?.scenario.trim() || prepPins(ctl, celebration.session)[0]?.text || '—' },
              { label: 'V grafu', value: `${pinCount} ${pinCount === 1 ? 'poznámka' : pinCount > 1 && pinCount < 5 ? 'poznámky' : 'poznámek'}` },
              { label: 'Pravidla', value: prep?.rules.join(' · ') || 'žádné' },
            ]}
          >
            <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
              <button type="button" className="dj-btn" onClick={() => setCelebration(null)} style={celebrationGhost}>Upravit</button>
              {celebration.session === 'london' && !ctl.journal.preps.ny && ctl.isToday && sessionStage('ny', ctl.windows, ctl.now) === 'upcoming' && (
                <button type="button" className="dj-btn" onClick={() => { setCelebration(null); switchSession('ny'); }} style={{ ...celebrationPrimary, background: 'linear-gradient(180deg,#f97316,#ea580c)' }}>Připravit New York</button>
              )}
              <button type="button" className="dj-btn" onClick={() => { setCelebration(null); ctl.backToDay(); }} style={celebrationPrimary}>Otevřít den</button>
            </div>
          </SaveCelebration>
        );
      })()}

      {celebration?.kind === 'close' && (() => {
        const close = ctl.journal.closes[celebration.session];
        const stats = ctl.sessionStats[celebration.session];
        const carry = close ? carryForward(close.summary) : '';
        const toNy = celebration.session === 'london' && !ctl.journal.preps.ny && ctl.isToday && sessionStage('ny', ctl.windows, ctl.now) === 'upcoming';
        return (
          <SaveCelebration
            fresh={celebration.fresh}
            origin={{ left: 'calc(100% - 170px)', top: 'calc(100% - 46px)' }}
            title={`${SESSION_STYLE[celebration.session].name} ${celebration.session === 'ny' ? 'uzavřený' : 'uzavřen'}`}
            subtitle={`${close?.execution ? DAY_EXECUTION_LABEL[close.execution] : ''} · ${money(stats.pnl)} · ${stats.count} ${stats.count === 1 ? 'obchod' : stats.count > 1 && stats.count < 5 ? 'obchody' : 'obchodů'}`}
          >
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.max(1, streak.length)}, minmax(0, 1fr))`, gap: 5, margin: '16px 0 4px' }}>
              {streak.map(item => <span key={item.day} title={item.title} style={{ height: 22, borderRadius: 6, boxSizing: 'border-box', ...streakStyle(item.day === ctl.day && item.state !== 'full' ? 'part' : item.state) }} />)}
            </div>
            <p style={{ margin: '2px 0 0', fontSize: 11, color: 'var(--dj-muted)', textAlign: 'left' }}>Posledních {streak.length} dní · plný čtverec = připravený i uzavřený den</p>
            {carry && (
              <div style={{ marginTop: 14, padding: '10px 12px', borderRadius: 11, textAlign: 'left', background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.3)' }}>
                <span style={{ display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--dj-indigo)' }}>{celebration.session === 'london' ? 'Do New Yorku si ber' : 'Na zítra'}</span>
                <span style={{ display: 'block', marginTop: 3, fontSize: 13 }}>„{carry}“</span>
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
              <button type="button" className="dj-btn" onClick={() => setCelebration(null)} style={celebrationGhost}>Upravit</button>
              {toNy
                ? <button type="button" className="dj-btn" onClick={() => { setCelebration(null); ctl.openPrep('ny'); }} style={{ ...celebrationPrimary, background: 'linear-gradient(180deg,#f97316,#ea580c)' }}>Připravit New York</button>
                : <button type="button" className="dj-btn" onClick={() => { setCelebration(null); ctl.backToDay(); }} style={celebrationPrimary}>Zpět na den</button>}
            </div>
          </SaveCelebration>
        );
      })()}
    </div>
  );
}

const celebrationGhost: React.CSSProperties = { flex: 1, height: 44, borderRadius: 11, cursor: 'pointer', font: '600 13px Inter, sans-serif', color: 'var(--dj-text-2)', background: 'transparent', border: '1px solid var(--dj-line)' };
const celebrationPrimary: React.CSSProperties = { flex: 2, height: 44, borderRadius: 11, cursor: 'pointer', border: 0, font: '800 13.5px Inter, sans-serif', color: '#fff', background: 'linear-gradient(180deg,#6366f1,#4f46e5)' };
