import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Brain, Check, ChevronLeft, ChevronRight, Mic, PenLine } from 'lucide-react';
import type { Trade } from '../../types';
import { DAY_BIAS_LABEL, DAY_EXECUTION_LABEL, carryForward, pragueClock, type DaySession } from '../../lib/dayJournal';
import { sessionStage, type StreakDay } from '../../lib/dayJournalView';
import { planChoiceOf, tradeTimeMs } from '../../lib/weeklyReview';
import { tradeRMultiple } from '../../utils/tradeRisk';
import DayCompactChart from './DayCompactChart';
import DictationDialog from './DictationDialog';
import { BiasPicker, BigSaveButton, ExecutionPicker, MicButton, NoteKindToggle, SESSION_STYLE, SaveCelebration, SessionSwitch, Waveform, money, priceText, rText, recordingStatus, tone } from './DayPrimitives';
import { DayMoreMenu, FeedList, NoteFilterSwitch, ScopeSwitch, SessionSwitchFx, TradeRating, WeekPlanInput, dayTitle, primaryAction, scopeSwitchFxSub, sessionSwitchFxSub, streakStyle, LiveChip } from './DayPanels';
import { PinList, PrepTimer, RuleChips, ScenarioField, missingLabel, prepPins, prepRequirements } from './PrepPanels';
import { CloseSide, SummaryBar, closeRequirements, closeSessionStatus } from './ClosePanels';
import { focusRange, sessionBands } from './dayFocus';
import type { DayPinPoint } from './DayNotesLayer';
import type { DayController } from './useDayController';
import DayFullscreenChart from './DayFullscreenChart';
import type { MarketTimeframe } from '../../services/marketData';
import { readStoredDayChartTimeframe, writeStoredDayChartTimeframe } from '../../lib/dayChartTools';
import { playNativeHapticIfAvailable } from '../../services/nativeCapabilities';

const clock = (ms: number) => pragueClock(ms);
const bottomOffset = 'calc(var(--native-shell-tab-bar-height, 0px) + 12px)';

function Sheet({ children, onClose, label, dismissable = true }: { children: React.ReactNode; onClose: () => void; label: string; dismissable?: boolean }) {
  return (
    <div className="dj" style={{ position: 'fixed', inset: 0, zIndex: 900 }}>
      <div onClick={dismissable ? onClose : undefined} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)', animation: 'dj-fade .2s ease both' }} />
      <section aria-label={label} style={{ position: 'absolute', left: 0, right: 0, bottom: 0, borderRadius: '22px 22px 0 0', borderTop: '1px solid var(--dj-line)', background: 'var(--dj-card)', padding: '10px 18px calc(var(--native-shell-tab-bar-height, 0px) + 24px)', animation: 'dj-sheet .28s cubic-bezier(.2,.9,.25,1) both', maxHeight: '86vh', overflowY: 'auto' }}>
        <span style={{ display: 'block', width: 38, height: 5, borderRadius: 9, background: 'var(--dj-line)', margin: '0 auto 14px' }} />
        {children}
      </section>
    </div>
  );
}

/** Poznámka do grafu na telefonu: nahrávání → přepis → Připíchnout. */
/** Potvrzení po uložení poznámky: fajfka s textem nad spodní lištou + jemná vibrace. */
type SavedNote = { key: number; kind: 'market' | 'mind'; pinned: boolean };
function NoteSavedToast({ saved }: { saved: SavedNote }) {
  const mind = saved.kind === 'mind';
  const text = mind ? 'Uloženo do Hlavy' : saved.pinned ? 'Připíchnuto do grafu' : 'Uloženo do časové osy';
  return (
    <div role="status" aria-live="polite" className="dj" style={{ position: 'fixed', left: '50%', bottom: 'calc(var(--native-shell-tab-bar-height, 0px) + 96px)', zIndex: 910, display: 'flex', alignItems: 'center', gap: 10, padding: '10px 18px 10px 10px', borderRadius: 999, background: 'var(--dj-card)', border: `1px solid ${mind ? 'rgba(168,85,247,0.45)' : 'rgba(16,185,129,0.45)'}`, boxShadow: `0 16px 40px -14px ${mind ? 'rgba(147,51,234,0.55)' : 'rgba(16,185,129,0.5)'}`, animation: 'dj-saved 1.7s cubic-bezier(.2,.9,.3,1) both', pointerEvents: 'none', whiteSpace: 'nowrap' }}>
      <span style={{ width: 30, height: 30, borderRadius: 99, display: 'grid', placeItems: 'center', background: mind ? 'linear-gradient(180deg,#a855f7,#9333ea)' : 'linear-gradient(180deg,#34d399,#10b981)', color: '#fff', animation: 'dj-check .45s .08s cubic-bezier(.34,1.56,.64,1) both' }}><Check size={18} strokeWidth={3} /></span>
      <span style={{ font: '700 14px Inter, sans-serif', color: 'var(--dj-text)' }}>{text}</span>
    </div>
  );
}

function PinSheet({ ctl, point, autoRecord, onClose, onSaved }: { ctl: DayController; point: DayPinPoint | null; autoRecord: boolean; onClose: () => void; onSaved: (saved: Omit<SavedNote, 'key'>) => void }) {
  const { dictation } = ctl;
  const [draft, setDraft] = useState('');
  const [voice, setVoice] = useState(autoRecord);
  const record = async () => {
    const text = await dictation.start();
    if (text) { setDraft(current => (current.trim() ? `${current.trim()} ${text}` : text)); setVoice(true); }
  };
  const startedRef = useRef(false);
  useEffect(() => {
    if (!autoRecord || startedRef.current) return;
    startedRef.current = true;
    void record();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nahrávání jen při otevření
  }, []);
  const status = recordingStatus(dictation.phase, dictation.seconds, dictation.error);
  const busy = dictation.phase === 'recording' || dictation.phase === 'transcribing';
  const save = () => { if (!draft.trim()) return; const kind = ctl.mode === 'day' ? ctl.noteKind : 'market'; ctl.createNote(draft, point, voice, kind); onSaved({ kind: kind === 'mind' ? 'mind' : 'market', pinned: Boolean(point) && kind !== 'mind' }); onClose(); };
  return (
    <Sheet label={point ? "Poznámka do grafu" : "Poznámka"} dismissable={!draft.trim() && dictation.phase !== 'recording' && dictation.phase !== 'transcribing'} onClose={() => { dictation.cancel(); onClose(); }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="dj-mono" style={{ fontSize: 11, fontWeight: 700, color: 'var(--dj-indigo)' }}>{point ? `${clock(point.time * 1000)} · ${priceText(point.price)}` : 'do časové osy'}</span>
        {ctl.mode === 'day' && <NoteKindToggle value={ctl.noteKind} onChange={ctl.setNoteKind} size="md" />}
        <span style={{ flex: 1 }} />
        <span className="dj-mono" style={{ fontSize: 11, fontWeight: 600, color: 'var(--dj-muted)' }}>zapíše se {clock(ctl.now)}</span>
      </div>
      <textarea className="dj-input" autoFocus={!autoRecord} rows={3} value={draft} onChange={event => setDraft(event.target.value)} placeholder={busy ? '' : 'Mluv, nebo piš…'} aria-label="Text poznámky" style={{ marginTop: 10, fontSize: 16, minHeight: 66 }} />
      {status && <p style={{ margin: '6px 0 0', fontSize: 12, color: status.color }}>{status.text}{dictation.canRetry && <> · <button type="button" onClick={() => { void dictation.retry().then(text => { if (text) { setDraft(current => (current.trim() ? `${current.trim()} ${text}` : text)); setVoice(true); } }); }} style={{ border: 0, background: 'none', padding: 0, color: 'var(--dj-indigo)', fontWeight: 700, cursor: 'pointer', font: 'inherit' }}>zkusit přepis znovu</button></>}</p>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 14 }}>
        <MicButton phase={dictation.phase} onStart={() => void record()} onStop={() => void dictation.stop()} size={60} />
        {dictation.phase === 'recording' ? <span style={{ flex: 1 }}><Waveform levels={dictation.levels.slice(-20)} height={34} /></span> : (
          <>
            <span style={{ flex: 1 }} />
            <button type="button" className="dj-btn" onClick={() => { dictation.cancel(); onClose(); }} style={{ height: 48, padding: '0 16px', borderRadius: 14, font: '600 14px Inter, sans-serif', color: 'var(--dj-text-2)', background: 'var(--dj-chip)', border: 0 }}>Zahodit</button>
            <button type="button" className="dj-btn" disabled={!draft.trim()} onClick={save} style={{ height: 48, padding: '0 18px', borderRadius: 14, font: '800 14px Inter, sans-serif', color: '#1e1b4b', background: '#a5b4fc', border: 0, opacity: draft.trim() ? 1 : 0.5 }}>{point ? 'Připíchnout' : 'Uložit'}</button>
          </>
        )}
      </div>
    </Sheet>
  );
}

function TradeSheet({ ctl, trade, onClose, onOpenTrade }: { ctl: DayController; trade: Trade; onClose: () => void; onOpenTrade?: (trade: Trade) => void }) {
  const r = tradeRMultiple(trade);
  const [error, setError] = useState<string | null>(null);
  return (
    <Sheet label="Obchod" onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 16, fontWeight: 800 }}>{trade.symbol || trade.instrument || 'MNQ'}</span>
        <span style={{ fontSize: 12, fontWeight: 700, color: trade.direction === 'Long' ? '#10b981' : '#f43f5e' }}>{trade.direction === 'Long' ? '↗ Long' : '↘ Short'}</span>
        <span style={{ fontSize: 12, color: 'var(--dj-text-2)' }}>{clock(tradeTimeMs(trade))}</span>
      </div>
      <p style={{ margin: '10px 0 0', fontSize: 34, fontWeight: 300, letterSpacing: '-0.04em', color: tone(trade.pnl) }}>{money(trade.pnl)}</p>
      <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--dj-text-2)' }}>{[r != null ? rText(r) : null, trade.signal || null].filter(Boolean).join(' · ')}</p>
      <div style={{ marginTop: 16 }}><TradeRating size="lg" trade={trade} onRate={choice => { ctl.rateTrade(trade, choice).then(() => setError(null), reason => setError(reason instanceof Error ? reason.message : 'Neuloženo.')); }} /></div>
      {error && <p role="alert" style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--dj-rose)' }}>{error}</p>}
      {trade.notes?.trim() && <p style={{ margin: '14px 0 0', padding: '10px 12px', borderRadius: 10, border: '1px solid rgba(251,191,36,0.3)', background: 'var(--dj-amber-bg-soft)', fontSize: 12.5 }}>„{trade.notes}“</p>}
      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        {onOpenTrade && <button type="button" className="dj-btn" onClick={() => onOpenTrade(trade)} style={{ flex: 1, height: 46, borderRadius: 12, font: '700 13px Inter, sans-serif', color: 'var(--dj-text)', background: 'var(--dj-chip)', border: 0 }}>Detail</button>}
        <button type="button" className="dj-btn" onClick={onClose} style={{ flex: 2, height: 46, borderRadius: 12, font: '700 13px Inter, sans-serif', color: '#fff', background: 'linear-gradient(180deg,#6366f1,#4f46e5)', border: 0 }}>Hotovo</button>
      </div>
    </Sheet>
  );
}

function PhoneHeader({ title, subtitle, onBack, right }: { title: string; subtitle: string; onBack?: () => void; right?: React.ReactNode }) {
  return (
    <div style={{ padding: '0 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
      {onBack && <button type="button" className="dj-btn" onClick={onBack} aria-label="Zpět na den" style={{ width: 36, height: 36, borderRadius: 99, border: 0, background: 'var(--dj-chip)', color: 'var(--dj-text-2)', display: 'grid', placeItems: 'center', flex: 'none' }}><ArrowLeft size={16} /></button>}
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ margin: 0, fontSize: 11, fontWeight: 600, color: 'var(--dj-muted)' }}>{subtitle}</p>
        <h1 style={{ margin: '1px 0 0', fontSize: 21, fontWeight: 800, letterSpacing: '-0.02em' }}>{title}</h1>
      </div>
      {right}
    </div>
  );
}

const WEEKDAY_SHORT = new Intl.DateTimeFormat('cs-CZ', { weekday: 'short', timeZone: 'UTC' });
const dayMonth = (day: string) => { const [, m, d] = day.split('-').map(Number); return `${d}. ${m}.`; };
const tradesWord = (count: number) => (count === 1 ? 'obchod' : count > 1 && count < 5 ? 'obchody' : 'obchodů');

/** Karta na telefonu: jednotný rámeček sekcí pod grafem. */
function PhoneCard({ title, aside, tone: cardTone, children }: { title: string; aside?: React.ReactNode; tone?: 'mind'; children: React.ReactNode }) {
  return (
    <section style={{ borderRadius: 16, border: `1px solid ${cardTone === 'mind' ? 'rgba(168,85,247,0.32)' : 'var(--dj-line)'}`, background: cardTone === 'mind' ? 'linear-gradient(var(--dj-mind-bg), var(--dj-mind-bg)), var(--dj-card)' : 'var(--dj-card-soft)', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 20 }}>
        <p style={{ margin: 0, fontSize: 13, fontWeight: 800, color: cardTone === 'mind' ? 'var(--dj-mind-text)' : 'var(--dj-text)' }}>{title}</p>
        <span style={{ flex: 1 }} />
        {aside}
      </div>
      {children}
    </section>
  );
}

export default function DayPhone({ ctl, isDark, streak, onOpenTrade, onOpenWeek, onOpenArchive, onOpenLegacy, onOpenMind }: {
  ctl: DayController;
  isDark: boolean;
  streak: StreakDay[];
  onOpenTrade?: (trade: Trade) => void;
  onOpenWeek?: () => void;
  onOpenArchive?: () => void;
  onOpenLegacy?: () => void;
  onOpenMind?: () => void;
}) {
  const [sheet, setSheet] = useState<{ kind: 'pin'; point: DayPinPoint | null; record: boolean } | { kind: 'dictate' } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [celebration, setCelebration] = useState<{ kind: 'prep' | 'close'; session: DaySession; seconds?: number } | null>(null);
  const { mode, modeSession: session } = ctl;
  // Timeframe sdílí kompaktní i celoobrazovkový graf a přežije reload.
  const [timeframe, setTimeframeState] = useState<MarketTimeframe>(() => readStoredDayChartTimeframe(typeof window === 'undefined' ? null : window.localStorage));
  const setTimeframe = (next: MarketTimeframe) => { setTimeframeState(next); writeStoredDayChartTimeframe(window.localStorage, next); };
  const [fullscreen, setFullscreen] = useState(false);
  // Otočení na šířku otevře celou obrazovku; zpět na výšku ji nezavře
  // (rozdělaná kresba nebo poznámka by se ztratila) — zavírá tlačítko.
  useEffect(() => {
    const media = window.matchMedia?.('(orientation: landscape)');
    if (!media) return;
    const update = () => { if (media.matches) setFullscreen(true); };
    media.addEventListener?.('change', update);
    return () => media.removeEventListener?.('change', update);
  }, []);
  const screenKey = `${ctl.day}:${mode}:${session}`;
  const screenRef = useRef(screenKey);
  screenRef.current = screenKey;
  useEffect(() => { setSheet(null); setSaveError(null); setCelebration(null); }, [mode, session, ctl.day]);
  // Nový režim nebo den začíná nahoře (hlavička přípravy/uzavření nesmí zůstat mimo obrazovku).
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => { rootRef.current?.scrollIntoView({ block: 'start' }); }, [mode, ctl.day]);

  // Záblesk s nápisem přes graf při přepnutí rozsahu (deník) nebo seance
  // (příprava/uzavření) — stejný jako na PC. Jen po klepnutí na přepínač;
  // návrat rozsahu na „Celý den“ při změně dne ho nespouští.
  const [savedNote, setSavedNote] = useState<SavedNote | null>(null);
  const noteSaved = (saved: Omit<SavedNote, 'key'>) => { setSavedNote({ ...saved, key: Date.now() }); playNativeHapticIfAvailable('success'); };
  useEffect(() => {
    if (!savedNote) return;
    const timer = window.setTimeout(() => setSavedNote(null), 1800);
    return () => window.clearTimeout(timer);
  }, [savedNote]);
  const [fx, setFx] = useState<{ key: number; session: DaySession | 'day'; sub: string } | null>(null);
  const pickScope = (next: DayController['scope']) => {
    if (next === ctl.scope) return;
    ctl.setScope(next);
    setFx({ key: Date.now(), session: next, sub: scopeSwitchFxSub(ctl, next) });
  };
  const pickSession = (next: DaySession) => {
    if (next === session || mode === 'day') return;
    ctl.setModeSession(next);
    setFx({ key: Date.now(), session: next, sub: sessionSwitchFxSub(ctl, mode, next) });
  };
  useEffect(() => {
    if (!fx) return;
    const timer = window.setTimeout(() => setFx(null), 1000);
    return () => window.clearTimeout(timer);
  }, [fx]);

  const range = focusRange({ mode, session, scope: ctl.scope, windows: ctl.chartWindows, now: ctl.now, isToday: ctl.isToday });
  const bands = useMemo(() => sessionBands(ctl.chartWindows, mode, null), [ctl.chartWindows, mode]);
  const pins = mode === 'prep'
    ? ctl.pinViews(note => note.origin === 'prep' && note.session === session, note => note.origin === 'prep' && note.session !== session)
    : mode === 'close' ? ctl.pinViews(note => note.session === session) : ctl.pinViews(note => ctl.scope === 'day' || note.session === ctl.scope || note.session === 'day');
  const selectedChartTrade = mode === 'day' && ctl.selectedTrade ? ctl.chart.chartTrades.find(trade => String(trade.id) === String(ctl.selectedTrade!.id)) ?? null : null;
  const pick = (point: DayPinPoint) => { const record = ctl.placing === 'voice'; ctl.setPlacing(null); ctl.setPendingPoint(point); setSheet({ kind: 'pin', point, record }); };
  // Při celé obrazovce se kompaktní graf odpojí: oba grafy sdílí jeden klíč
  // kreseb a skrytý graf by při překreslení překryvů přepsal úložiště starým
  // stavem. Po zavření se znovu připojí a načte kresby z celé obrazovky.
  const chart = (height: number) => fullscreen ? (
    <div className="dj" style={{ height: height + 37, display: 'grid', placeItems: 'center', borderTop: '1px solid var(--dj-line)', borderBottom: '1px solid var(--dj-line)', fontSize: 12, color: 'var(--dj-muted)' }}>Graf je otevřený na celou obrazovku</div>
  ) : (
    <div style={{ position: 'relative' }}>
    <DayCompactChart
      ctl={ctl} isDark={isDark} height={height} range={range} focusKeyPrefix={`${mode}:${session}:${ctl.scope}`}
      selectedTrade={selectedChartTrade} pins={pins} bubbles={mode === 'prep' ? 'all' : 'selected'}
      placing={ctl.placing} onPick={pick} onCancelPlacing={() => ctl.setPlacing(null)} pending={ctl.pendingPoint}
      nowTime={mode === 'prep' && ctl.isToday ? Math.floor(ctl.now / 1000) : null} bands={bands}
      timeframe={timeframe} onTimeframe={setTimeframe} onExpand={() => setFullscreen(true)}
    />
    {fx && <SessionSwitchFx key={fx.key} session={fx.session} sub={fx.sub} />}
    </div>
  );
  const toggleVoice = () => { ctl.setPendingPoint(null); ctl.setPlacing(ctl.placing === 'voice' ? null : 'voice'); };
  const closeSheet = () => { setSheet(null); ctl.setPendingPoint(null); };

  const save = async (kind: 'prep' | 'close') => {
    setSaving(true); setSaveError(null);
    const started = ctl.prepDraft(session).openedAt;
    try {
      if (kind === 'prep') await ctl.savePrep(session); else await ctl.saveClose(session);
      const origin = screenKey;
      window.setTimeout(() => { setSaving(false); if (screenRef.current === origin) setCelebration({ kind, session, seconds: Math.round((Date.now() - started) / 1000) }); }, 720);
    } catch (reason) {
      setSaving(false);
      setSaveError(reason instanceof Error ? reason.message : 'Uložení se nepodařilo.');
    }
  };

  let content: React.ReactNode;
  let bottom: React.ReactNode;
  if (mode === 'prep') {
    const draft = ctl.prepDraft(session);
    const req = prepRequirements(ctl, session);
    const before = sessionStage(session, ctl.windows, ctl.now) === 'upcoming' ? `před ${SESSION_STYLE[session].name} ${clock(ctl.windows[session].start)}` : SESSION_STYLE[session].name;
    content = (
      <>
        <PhoneHeader onBack={ctl.backToDay} title="Příprava" subtitle={`${dayTitle(ctl.day)} · ${before}`} right={<PrepTimer openedAt={draft.openedAt} />} />
        <div style={{ margin: '10px 16px 0' }}><BiasPicker fill height={52} value={draft.bias} onChange={bias => ctl.updatePrepDraft(session, { bias })} /></div>
        <div style={{ marginTop: 12 }}>{chart(300)}</div>
        <div style={{ padding: '10px 16px 0', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="dj-btn" onClick={() => { ctl.setPendingPoint(null); ctl.setPlacing(ctl.placing === 'note' ? null : 'note'); }} style={{ flex: 1, height: 48, borderRadius: 14, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, font: '800 13.5px Inter, sans-serif', cursor: 'pointer', ...(ctl.placing === 'note' ? { color: '#1e1b4b', background: '#a5b4fc', border: 0 } : { color: 'var(--dj-indigo-text)', background: 'linear-gradient(var(--dj-indigo-bg-soft), var(--dj-indigo-bg-soft)), var(--dj-card)', border: '1px solid rgba(99,102,241,0.4)' }) }}>
              <PenLine size={17} /> {ctl.placing === 'note' ? 'Ťukni do grafu' : 'Napsat'}
            </button>
            <button type="button" className="dj-btn" onClick={() => { ctl.setPendingPoint(null); ctl.setPlacing(ctl.placing === 'voice' ? null : 'voice'); }} style={{ flex: 2, height: 48, borderRadius: 14, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 9, font: '800 14px Inter, sans-serif', border: 0, cursor: 'pointer', color: '#fff', background: ctl.placing === 'voice' ? '#f43f5e' : 'linear-gradient(180deg,#6366f1,#4f46e5)' }}>
              <Mic size={18} /> {ctl.placing === 'voice' ? 'Ťukni do grafu, kam to patří' : 'Nadiktovat do grafu'}
            </button>
          </div>
          <div style={{ maxHeight: 260, display: 'flex', minHeight: 0 }}><PinList ctl={ctl} session={session} /></div>
          <ScenarioField ctl={ctl} session={session} rows={3} />
          <div><p style={{ margin: '0 0 7px', fontSize: 13, fontWeight: 700 }}>Neobchoduju, pokud…</p><RuleChips ctl={ctl} session={session} /></div>
        </div>
      </>
    );
    bottom = <BigSaveButton ready={req.ready} saving={saving} error={saveError} label={missingLabel(req.missing)} readyLabel={`Uložit plán ${SESSION_STYLE[session].name}`} onClick={() => void save('prep')} />;
  } else if (mode === 'close') {
    const draft = ctl.closeDraft(session);
    const req = closeRequirements(ctl, session);
    content = (
      <>
        <PhoneHeader onBack={ctl.backToDay} title="Uzavření" subtitle={`${dayTitle(ctl.day)} · ${clock(ctl.windows[session].start)}–${clock(ctl.windows[session].end)}`} />
        <div style={{ margin: '14px 16px 0' }}><SessionSwitch fill value={session} onChange={pickSession} status={closeSessionStatus(ctl)} /></div>
        <div style={{ marginTop: 12 }}>{chart(220)}</div>
        <div style={{ display: 'flex', flexDirection: 'column', padding: '0 4px' }}><CloseSide ctl={ctl} session={session} /></div>
        <div style={{ padding: '0 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <SummaryBar ctl={ctl} session={session} compact />
          <p style={{ margin: 0, fontSize: 13, fontWeight: 700 }}>Exekuce <span style={{ fontWeight: 500, color: 'var(--dj-muted)' }}>· podle plánu, ne podle P&amp;L</span></p>
          <ExecutionPicker fill height={48} value={draft.execution} onChange={execution => ctl.updateCloseDraft(session, { execution })} />
        </div>
      </>
    );
    bottom = <BigSaveButton ready={req.ready} saving={saving} error={saveError} accent={session === 'ny' ? 'orange' : 'indigo'} label={`Chybí ${req.missing.join(' a ')}`} readyLabel={`Uzavřít ${SESSION_STYLE[session].name}`} savingLabel="Uzavírám…" onClick={() => void save('close')} />;
  } else {
    const action = ctl.weekend ? null : primaryAction(ctl);
    const done = ctl.checklist.filter(item => item.done).length;
    const headline = ctl.weekend ? ctl.weekStats : ctl.stats;
    const glow = headline.pnl > 0 ? 'rgba(16,185,129,0.22)' : headline.pnl < 0 ? 'rgba(244,63,94,0.22)' : 'transparent';
    const reviewed = ctl.weekTrades.filter(trade => planChoiceOf(trade)).length;
    const winRate = headline.winRate == null ? null : Math.round(headline.winRate * 100);
    content = (
      <>
        <div style={{ padding: '0 16px', display: 'flex', alignItems: 'center', gap: 8 }}>
          <button type="button" aria-label="Předchozí den" onClick={() => ctl.shiftDay(-1)} style={roundNav}><ChevronLeft size={16} /></button>
          <div style={{ flex: 1, minWidth: 0, textAlign: 'center' }}>
            <p style={{ margin: 0, fontSize: 16, fontWeight: 800 }}>{dayTitle(ctl.day)}</p>
            <div style={{ display: 'flex', justifyContent: 'center', marginTop: 2 }}><LiveChip status={ctl.chart.liveStatus} capturedAt={ctl.chart.liveCapturedAt} weekendMarketDay={ctl.weekendMarketDay} restartable /></div>
          </div>
          <button type="button" aria-label="Další den" disabled={ctl.isToday} onClick={() => ctl.shiftDay(1)} style={{ ...roundNav, opacity: ctl.isToday ? 0.3 : 1 }}><ChevronRight size={16} /></button>
          <DayMoreMenu ctl={ctl} onOpenWeek={onOpenWeek} onOpenArchive={onOpenArchive} onOpenLegacy={onOpenLegacy} onOpenMind={onOpenMind} />
        </div>
        <div style={{ padding: '16px 16px 0', background: `radial-gradient(80% 70% at 10% 0%, ${glow}, transparent 70%)` }}>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ margin: 0, fontSize: 11, fontWeight: 600, color: 'var(--dj-muted)' }}>{ctl.weekend ? `Týden ${dayMonth(ctl.week.monday)}–${dayMonth(ctl.week.friday)}` : ctl.scope === 'day' ? 'Celý den' : SESSION_STYLE[ctl.scope].name}</p>
              <p style={{ margin: '4px 0 0', fontSize: 38, fontWeight: 300, letterSpacing: '-0.04em', lineHeight: 1, color: tone(headline.pnl) }}>{money(headline.pnl)}</p>
              <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--dj-text-2)' }}>
                {headline.count
                  ? `${headline.count} ${tradesWord(headline.count)}${headline.rSum != null ? ` · ${rText(headline.rSum)}` : ''}${winRate != null ? ` · ${winRate} % win` : ''}`
                  : ctl.weekend ? 'Týden bez obchodů' : 'Zatím bez obchodů'}
              </p>
            </div>
            {action && (
              <button type="button" className="dj-btn" onClick={() => (action.kind === 'prep' ? ctl.openPrep(action.session) : ctl.openClose(action.session))} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, padding: '8px 10px', borderRadius: 12, cursor: 'pointer', ...(action.kind === 'prep' ? { border: '1px solid rgba(99,102,241,0.45)', background: 'rgba(99,102,241,0.12)' } : { border: '1px solid rgba(245,158,11,0.45)', background: 'rgba(245,158,11,0.1)' }) }}>
                <span className="dj-mono" style={{ fontSize: 15, fontWeight: 800, color: action.kind === 'prep' ? 'var(--dj-indigo)' : 'var(--dj-amber)' }}>{done}/{ctl.checklist.length}</span>
                <span style={{ fontSize: 10.5, fontWeight: 700, color: action.kind === 'prep' ? 'var(--dj-indigo-text)' : 'var(--dj-amber-text)' }}>{action.label}</span>
              </button>
            )}
          </div>
        </div>
        {!ctl.weekend && <div style={{ margin: '14px 16px 0' }}><ScopeSwitch ctl={ctl} fill onPick={pickScope} /></div>}
        <div style={{ marginTop: 12 }}>{chart(ctl.weekend ? 230 : 250)}</div>
        <div style={{ padding: '14px 16px 0', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {ctl.weekend ? (
            <>
              <PhoneCard title="Projít týden" aside={<span style={{ fontSize: 12, color: 'var(--dj-text-2)' }}>{ctl.weekTrades.length ? <><b style={{ color: reviewed === ctl.weekTrades.length ? 'var(--dj-green)' : 'var(--dj-amber-text)' }}>{reviewed}/{ctl.weekTrades.length}</b> ohodnoceno</> : 'bez obchodů'}</span>}>
                {onOpenWeek && <button type="button" className="dj-btn" onClick={onOpenWeek} style={{ height: 42, borderRadius: 12, border: 0, cursor: 'pointer', font: '800 13.5px Inter, sans-serif', color: '#fff', background: 'linear-gradient(180deg,#6366f1,#4f46e5)' }}>Otevřít review týdne</button>}
              </PhoneCard>
              <PhoneCard title="Plán na týden" aside={<span style={{ fontSize: 11, color: 'var(--dj-muted)' }}>ukáže se v pondělí v přípravě</span>}>
                {ctl.weekPlans.map(note => (
                  <p key={note.id} style={{ margin: 0, padding: '8px 10px', borderRadius: 10, border: '1px solid rgba(99,102,241,0.25)', background: 'var(--dj-indigo-bg-soft)', color: 'var(--dj-indigo-text)', fontSize: 13.5 }}>→ {note.text}</p>
                ))}
                <WeekPlanInput ctl={ctl} />
              </PhoneCard>
              <PhoneCard tone="mind" title={`Hlava · tento týden ${ctl.weekMindNotes.length}`} aside={onOpenMind && <button type="button" className="dj-btn" onClick={onOpenMind} style={{ border: 0, background: 'none', padding: 0, cursor: 'pointer', font: '700 12px Inter, sans-serif', color: 'var(--dj-mind-text)' }}>Přehled ›</button>}>
                {ctl.weekMindNotes.slice(0, 5).map(({ day: noteDay, note }) => (
                  <div key={note.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                    <span className="dj-mono" style={{ fontSize: 11, fontWeight: 700, color: 'var(--dj-muted)', flex: 'none', width: 22 }}>{WEEKDAY_SHORT.format(new Date(`${noteDay}T12:00:00Z`))}</span>
                    <span style={{ fontSize: 13, minWidth: 0, color: 'var(--dj-mind-text)' }}>{note.text}</span>
                  </div>
                ))}
                {!ctl.weekMindNotes.length && <p style={{ margin: 0, fontSize: 12.5, color: 'var(--dj-muted)' }}>Co tě drží i mimo trading — rodina, jídlo, pohyb, spánek…</p>}
              </PhoneCard>
            </>
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.max(1, streak.length)}, minmax(0, 1fr))`, gap: 4 }}>
                {streak.map(item => <span key={item.day} title={item.title} style={{ height: 10, borderRadius: 4, boxSizing: 'border-box', ...streakStyle(item.state) }} />)}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                {(['london', 'ny'] as const).map(item => {
                  const prep = ctl.journal.preps[item];
                  const close = ctl.journal.closes[item];
                  const upcoming = ctl.isToday && sessionStage(item, ctl.windows, ctl.now) === 'upcoming';
                  return (
                    <div key={item} style={{ flex: 1, display: 'flex', gap: 6 }}>
                      <button type="button" className="dj-btn" onClick={() => ctl.openPrep(item)} style={{ ...phoneChip, flex: 1.35, color: prep ? 'var(--dj-indigo-text)' : 'var(--dj-text-2)', borderColor: prep ? 'rgba(99,102,241,0.4)' : 'var(--dj-line)' }}>{prep ? '✓ ' : ''}Příprava {item === 'ny' ? 'NY' : 'LDN'}</button>
                      <button type="button" className="dj-btn" disabled={upcoming} onClick={() => ctl.openClose(item)} style={{ ...phoneChip, color: close ? 'var(--dj-blue)' : 'var(--dj-text-2)', borderColor: close ? 'rgba(59,130,246,0.4)' : 'var(--dj-line)', opacity: upcoming ? 0.4 : 1 }}>{close ? '✓ ' : ''}Uzavřít</button>
                    </div>
                  );
                })}
              </div>
            </>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
            <p style={{ margin: 0, fontSize: 13, fontWeight: 800 }}>Časová osa</p>
            <span style={{ flex: 1 }} />
            <div style={{ width: 170 }}><NoteFilterSwitch ctl={ctl} /></div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}><FeedList ctl={ctl} items={ctl.feed} /></div>
        </div>
      </>
    );
    bottom = (
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button type="button" className="dj-btn" onClick={() => setSheet({ kind: 'pin', point: null, record: false })} aria-label="Napsat poznámku" style={{ height: 56, width: 56, borderRadius: 99, display: 'grid', placeItems: 'center', cursor: 'pointer', color: ctl.noteKind === 'mind' ? 'var(--dj-mind-text)' : 'var(--dj-text)', background: 'var(--dj-card)', border: '1px solid var(--dj-line)', boxShadow: '0 12px 30px -10px rgba(0,0,0,0.5)' }}>{ctl.noteKind === 'mind' ? <Brain size={20} /> : <PenLine size={20} />}</button>
        <button type="button" className="dj-btn" onClick={() => setSheet({ kind: 'dictate' })} aria-label="Nadiktovat poznámku" style={{ height: 56, padding: '0 22px 0 18px', borderRadius: 99, border: 0, display: 'flex', alignItems: 'center', gap: 10, color: '#fff', font: '800 14px Inter, sans-serif', background: ctl.noteKind === 'mind' ? 'linear-gradient(180deg,#a855f7,#7e22ce)' : 'linear-gradient(180deg,#6366f1,#4f46e5)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.28), 0 12px 30px -8px rgba(79,70,229,0.8)' }}>
          <Mic size={20} /> {ctl.noteKind === 'mind' ? 'Hlava hlasem' : 'Poznámka hlasem'}
        </button>
      </div>
    );
  }

  const celebrationOrigin = { left: '50%', top: 'calc(100% - 60px)' };
  return (
    <div ref={rootRef} className="dj" style={{ position: 'relative', margin: '0 -16px', paddingBottom: 'calc(var(--native-shell-tab-bar-height, 0px) + 120px)', scrollMarginTop: 120 }}>
      <div style={{ paddingTop: 4 }}>{content}</div>
      <div style={{ position: 'fixed', left: 0, right: 0, bottom: bottomOffset, zIndex: 40, padding: '20px 16px 0', background: 'linear-gradient(180deg, transparent, var(--dj-bg) 40%)', display: 'flex' }}>
        <div style={{ width: '100%', maxWidth: 520, margin: '0 auto', display: 'flex', justifyContent: 'center' }}>{bottom && <div style={{ width: mode === 'day' ? undefined : '100%' }}>{bottom}</div>}</div>
      </div>

      {fullscreen && (
        <DayFullscreenChart
          ctl={ctl} isDark={isDark} timeframe={timeframe} onTimeframe={setTimeframe} range={range} focusKeyPrefix={`${mode}:${session}:${ctl.scope}`}
          selectedTrade={selectedChartTrade} pins={pins} bubbles={mode === 'prep' ? 'all' : 'selected'}
          placing={ctl.placing} onPick={pick} onCancelPlacing={() => ctl.setPlacing(null)} pending={ctl.pendingPoint}
          nowTime={mode === 'prep' && ctl.isToday ? Math.floor(ctl.now / 1000) : null} bands={bands}
          onClose={() => setFullscreen(false)} onVoice={toggleVoice}
        />
      )}
      {sheet?.kind === 'pin' && <PinSheet ctl={ctl} point={sheet.point} autoRecord={sheet.record} onClose={closeSheet} onSaved={noteSaved} />}
      {sheet?.kind === 'dictate' && <DictationDialog ctl={ctl} sheet onClose={() => setSheet(null)} onSaved={noteSaved} />}
      {savedNote && <NoteSavedToast key={savedNote.key} saved={savedNote} />}
      {ctl.selectedTrade && !fullscreen && <TradeSheet ctl={ctl} trade={ctl.selectedTrade} onOpenTrade={onOpenTrade} onClose={() => ctl.setSelected(null)} />}

      {celebration && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 950 }}>
          <SaveCelebration
            origin={celebrationOrigin}
            title={celebration.kind === 'prep' ? `Plán ${SESSION_STYLE[celebration.session].name} uložen` : `${SESSION_STYLE[celebration.session].name} ${celebration.session === 'ny' ? 'uzavřený' : 'uzavřen'}`}
            subtitle={celebration.kind === 'prep'
              ? `Za ${Math.floor((celebration.seconds ?? 0) / 60)}:${String((celebration.seconds ?? 0) % 60).padStart(2, '0')}`
              : `${ctl.journal.closes[celebration.session]?.execution ? DAY_EXECUTION_LABEL[ctl.journal.closes[celebration.session]!.execution!] : ''} · ${money(ctl.sessionStats[celebration.session].pnl)}`}
            rows={celebration.kind === 'prep' ? [
              { label: 'Bias', value: ctl.journal.preps[celebration.session]?.bias ? DAY_BIAS_LABEL[ctl.journal.preps[celebration.session]!.bias!] : '—' },
              { label: 'Scénář', value: ctl.journal.preps[celebration.session]?.scenario.trim() || prepPins(ctl, celebration.session)[0]?.text || '—' },
              { label: 'V grafu', value: `${prepPins(ctl, celebration.session).length}` },
            ] : undefined}
          >
            {celebration.kind === 'close' && ctl.journal.closes[celebration.session]?.summary && (
              <div style={{ marginTop: 14, padding: '10px 12px', borderRadius: 11, textAlign: 'left', background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.3)' }}>
                <span style={{ display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--dj-indigo)' }}>{celebration.session === 'london' ? 'Do New Yorku si ber' : 'Na zítra'}</span>
                <span style={{ display: 'block', marginTop: 3, fontSize: 13 }}>„{carryForward(ctl.journal.closes[celebration.session]!.summary)}“</span>
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
              <button type="button" className="dj-btn" onClick={() => setCelebration(null)} style={{ flex: 1, height: 52, borderRadius: 15, font: '600 14px Inter, sans-serif', color: 'var(--dj-text-2)', background: 'var(--dj-chip)', border: 0 }}>Upravit</button>
              <button type="button" className="dj-btn" onClick={() => { setCelebration(null); ctl.backToDay(); }} style={{ flex: 2, height: 52, borderRadius: 15, font: '800 14.5px Inter, sans-serif', color: '#fff', border: 0, background: 'linear-gradient(180deg,#6366f1,#4f46e5)' }}>Otevřít den</button>
            </div>
          </SaveCelebration>
        </div>
      )}
    </div>
  );
}

const roundNav: React.CSSProperties = { width: 36, height: 36, borderRadius: 99, border: 0, background: 'var(--dj-chip)', color: 'var(--dj-text-2)', display: 'grid', placeItems: 'center', cursor: 'pointer' };
const phoneChip: React.CSSProperties = { flex: 1, minWidth: 0, height: 34, padding: '0 4px', borderRadius: 10, border: '1px solid', background: 'var(--dj-chip)', font: '700 11.5px Inter, sans-serif', cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
