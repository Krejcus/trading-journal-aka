import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight, Mic, Share } from 'lucide-react';
import type { Trade } from '../../types';
import { DAY_BIAS_LABEL, DAY_EXECUTION_LABEL, carryForward, pragueClock, type DaySession } from '../../lib/dayJournal';
import { sessionStage, type StreakDay } from '../../lib/dayJournalView';
import { tradeTimeMs } from '../../lib/weeklyReview';
import { tradeRMultiple } from '../../utils/tradeRisk';
import DayCompactChart from './DayCompactChart';
import DictationDialog from './DictationDialog';
import { BiasPicker, BigSaveButton, ExecutionPicker, MicButton, SESSION_STYLE, SaveCelebration, SessionSwitch, Waveform, money, priceText, rText, recordingStatus, tone } from './DayPrimitives';
import { FeedList, ScopeSwitch, TradeRating, dayTitle, exportDay, primaryAction, streakStyle, LiveChip } from './DayPanels';
import { PinList, PrepTimer, RuleChips, ScenarioField, missingLabel, prepPins, prepRequirements, prepSessionStatus } from './PrepPanels';
import { CloseSide, SummaryBar, closeRequirements, closeSessionStatus } from './ClosePanels';
import { focusRange, sessionBands } from './dayFocus';
import type { DayPinPoint } from './DayNotesLayer';
import type { DayController } from './useDayController';

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
function PinSheet({ ctl, point, autoRecord, onClose }: { ctl: DayController; point: DayPinPoint | null; autoRecord: boolean; onClose: () => void }) {
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
  const save = () => { if (!draft.trim()) return; ctl.createNote(draft, point, voice); onClose(); };
  return (
    <Sheet label="Poznámka do grafu" dismissable={!draft.trim() && dictation.phase !== 'recording' && dictation.phase !== 'transcribing'} onClose={() => { dictation.cancel(); onClose(); }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="dj-mono" style={{ fontSize: 11, fontWeight: 700, color: 'var(--dj-indigo)' }}>{point ? `${clock(point.time * 1000)} · ${priceText(point.price)}` : 'do časové osy'}</span>
        <span style={{ flex: 1 }} />
        <span className="dj-mono" style={{ fontSize: 11, fontWeight: 600, color: 'var(--dj-muted)' }}>zapíše se {clock(ctl.now)}</span>
      </div>
      <textarea className="dj-input" rows={3} value={draft} onChange={event => setDraft(event.target.value)} placeholder={busy ? '' : 'Mluv, nebo piš…'} aria-label="Text poznámky" style={{ marginTop: 10, fontSize: 14.5, minHeight: 66 }} />
      {status && <p style={{ margin: '6px 0 0', fontSize: 12, color: status.color }}>{status.text}{dictation.canRetry && <> · <button type="button" onClick={() => { void dictation.retry().then(text => { if (text) { setDraft(current => (current.trim() ? `${current.trim()} ${text}` : text)); setVoice(true); } }); }} style={{ border: 0, background: 'none', padding: 0, color: 'var(--dj-indigo)', fontWeight: 700, cursor: 'pointer', font: 'inherit' }}>zkusit přepis znovu</button></>}</p>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 14 }}>
        <MicButton phase={dictation.phase} onStart={() => void record()} onStop={() => void dictation.stop()} size={60} />
        {dictation.phase === 'recording' ? <span style={{ flex: 1 }}><Waveform levels={dictation.levels.slice(-20)} height={34} /></span> : (
          <>
            <span style={{ flex: 1 }} />
            <button type="button" className="dj-btn" onClick={() => { dictation.cancel(); onClose(); }} style={{ height: 48, padding: '0 16px', borderRadius: 14, font: '600 14px Inter, sans-serif', color: 'var(--dj-text-2)', background: 'var(--dj-chip)', border: 0 }}>Zahodit</button>
            <button type="button" className="dj-btn" disabled={!draft.trim()} onClick={save} style={{ height: 48, padding: '0 18px', borderRadius: 14, font: '800 14px Inter, sans-serif', color: '#1e1b4b', background: '#a5b4fc', border: 0, opacity: draft.trim() ? 1 : 0.5 }}>Připíchnout</button>
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
      <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--dj-text-2)' }}>{rText(r)}{trade.signal ? ` · ${trade.signal}` : ''}</p>
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

export default function DayPhone({ ctl, isDark, streak, onOpenTrade }: { ctl: DayController; isDark: boolean; streak: StreakDay[]; onOpenTrade?: (trade: Trade) => void }) {
  const [sheet, setSheet] = useState<{ kind: 'pin'; point: DayPinPoint | null; record: boolean } | { kind: 'dictate' } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [celebration, setCelebration] = useState<{ kind: 'prep' | 'close'; session: DaySession; seconds?: number } | null>(null);
  const { mode, modeSession: session } = ctl;
  const screenKey = `${ctl.day}:${mode}:${session}`;
  const screenRef = useRef(screenKey);
  screenRef.current = screenKey;
  useEffect(() => { setSheet(null); setSaveError(null); setCelebration(null); }, [mode, session, ctl.day]);

  const range = focusRange({ mode, session, scope: ctl.scope, windows: ctl.windows, now: ctl.now, isToday: ctl.isToday });
  const bands = useMemo(() => sessionBands(ctl.windows, mode, null), [ctl.windows, mode]);
  const pins = mode === 'prep'
    ? ctl.pinViews(note => note.origin === 'prep' && note.session === session, note => note.origin === 'prep' && note.session !== session)
    : mode === 'close' ? ctl.pinViews(note => note.session === session) : ctl.pinViews(note => ctl.scope === 'day' || note.session === ctl.scope || note.session === 'day');
  const selectedChartTrade = mode === 'day' && ctl.selectedTrade ? ctl.chart.chartTrades.find(trade => String(trade.id) === String(ctl.selectedTrade!.id)) ?? null : null;
  const pick = (point: DayPinPoint) => { const record = ctl.placing === 'voice'; ctl.setPlacing(null); ctl.setPendingPoint(point); setSheet({ kind: 'pin', point, record }); };
  const chart = (height: number) => (
    <DayCompactChart
      ctl={ctl} isDark={isDark} height={height} range={range} focusKeyPrefix={`${mode}:${session}:${ctl.scope}`}
      selectedTrade={selectedChartTrade} pins={pins} bubbles={mode === 'prep' ? 'all' : 'selected'}
      placing={ctl.placing} onPick={pick} onCancelPlacing={() => ctl.setPlacing(null)} pending={ctl.pendingPoint}
      nowTime={mode === 'prep' && ctl.isToday ? Math.floor(ctl.now / 1000) : null} bands={bands}
    />
  );
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
        <div style={{ margin: '14px 16px 0' }}><SessionSwitch fill value={session} onChange={ctl.setModeSession} status={prepSessionStatus(ctl, session)} /></div>
        <div style={{ margin: '10px 16px 0' }}><BiasPicker fill height={52} value={draft.bias} onChange={bias => ctl.updatePrepDraft(session, { bias })} /></div>
        <div style={{ marginTop: 12 }}>{chart(300)}</div>
        <div style={{ padding: '10px 16px 0', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <button type="button" className="dj-btn" onClick={() => { ctl.setPendingPoint(null); ctl.setPlacing(ctl.placing === 'voice' ? null : 'voice'); }} style={{ width: '100%', height: 48, borderRadius: 14, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 9, font: '800 14px Inter, sans-serif', border: 0, color: '#fff', background: ctl.placing === 'voice' ? '#f43f5e' : 'linear-gradient(180deg,#6366f1,#4f46e5)' }}>
            <Mic size={18} /> {ctl.placing === 'voice' ? 'Ťukni do grafu, kam to patří' : 'Nadiktovat do grafu'}
          </button>
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
        <div style={{ margin: '14px 16px 0' }}><SessionSwitch fill value={session} onChange={ctl.setModeSession} status={closeSessionStatus(ctl)} /></div>
        <div style={{ marginTop: 12 }}>{chart(220)}</div>
        <div style={{ display: 'flex', flexDirection: 'column' }}><CloseSide ctl={ctl} session={session} /></div>
        <div style={{ padding: '0 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <SummaryBar ctl={ctl} session={session} compact />
          <p style={{ margin: 0, fontSize: 13, fontWeight: 700 }}>Exekuce <span style={{ fontWeight: 500, color: 'var(--dj-muted)' }}>· podle plánu, ne podle P&amp;L</span></p>
          <ExecutionPicker fill height={48} value={draft.execution} onChange={execution => ctl.updateCloseDraft(session, { execution })} />
        </div>
      </>
    );
    bottom = <BigSaveButton ready={req.ready} saving={saving} error={saveError} accent={session === 'ny' ? 'orange' : 'indigo'} label={`Chybí ${req.missing.join(' a ')}`} readyLabel={`Uzavřít ${SESSION_STYLE[session].name}`} savingLabel="Uzavírám…" onClick={() => void save('close')} />;
  } else {
    const action = primaryAction(ctl);
    const done = ctl.checklist.filter(item => item.done).length;
    const glow = ctl.stats.pnl > 0 ? 'rgba(16,185,129,0.22)' : ctl.stats.pnl < 0 ? 'rgba(244,63,94,0.22)' : 'transparent';
    content = (
      <>
        <div style={{ padding: '0 16px', display: 'flex', alignItems: 'center', gap: 8 }}>
          <button type="button" aria-label="Předchozí den" onClick={() => ctl.shiftDay(-1)} style={roundNav}><ChevronLeft size={16} /></button>
          <div style={{ flex: 1, textAlign: 'center' }}>
            <p style={{ margin: 0, fontSize: 16, fontWeight: 800 }}>{dayTitle(ctl.day)}</p>
            <div style={{ display: 'flex', justifyContent: 'center', marginTop: 2 }}><LiveChip status={ctl.chart.liveStatus} capturedAt={ctl.chart.liveCapturedAt} /></div>
          </div>
          <button type="button" aria-label="Další den" disabled={ctl.isToday} onClick={() => ctl.shiftDay(1)} style={{ ...roundNav, opacity: ctl.isToday ? 0.3 : 1 }}><ChevronRight size={16} /></button>
          <button type="button" aria-label="Sdílet den" onClick={() => { void exportDay(ctl).catch(() => {}); }} style={roundNav}><Share size={15} /></button>
        </div>
        <div style={{ padding: '16px 16px 0', background: `radial-gradient(80% 70% at 10% 0%, ${glow}, transparent 70%)` }}>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10 }}>
            <div style={{ flex: 1 }}>
              <p style={{ margin: 0, fontSize: 11, fontWeight: 600, color: 'var(--dj-muted)' }}>{ctl.scope === 'day' ? 'Celý den' : SESSION_STYLE[ctl.scope].name}</p>
              <p style={{ margin: '4px 0 0', fontSize: 38, fontWeight: 300, letterSpacing: '-0.04em', lineHeight: 1, color: tone(ctl.stats.pnl) }}>{money(ctl.stats.pnl)}</p>
              <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--dj-text-2)' }}>{ctl.stats.count ? `${ctl.stats.count} obchodů · ${rText(ctl.stats.rSum)}` : 'Zatím bez obchodů'}</p>
            </div>
            {action && (
              <button type="button" className="dj-btn" onClick={() => (action.kind === 'prep' ? ctl.openPrep(action.session) : ctl.openClose(action.session))} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, padding: '8px 10px', borderRadius: 12, cursor: 'pointer', ...(action.kind === 'prep' ? { border: '1px solid rgba(99,102,241,0.45)', background: 'rgba(99,102,241,0.12)' } : { border: '1px solid rgba(245,158,11,0.45)', background: 'rgba(245,158,11,0.1)' }) }}>
                <span className="dj-mono" style={{ fontSize: 15, fontWeight: 800, color: action.kind === 'prep' ? 'var(--dj-indigo)' : 'var(--dj-amber)' }}>{done}/{ctl.checklist.length}</span>
                <span style={{ fontSize: 10.5, fontWeight: 700, color: action.kind === 'prep' ? 'var(--dj-indigo-text)' : 'var(--dj-amber-text)' }}>{action.label}</span>
              </button>
            )}
          </div>
        </div>
        <div style={{ margin: '14px 16px 0' }}><ScopeSwitch ctl={ctl} fill /></div>
        <div style={{ marginTop: 12 }}>{chart(250)}</div>
        <div style={{ padding: '14px 16px 0' }}>
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.max(1, streak.length)}, minmax(0, 1fr))`, gap: 4, marginBottom: 12 }}>
            {streak.map(item => <span key={item.day} title={item.title} style={{ height: 10, borderRadius: 4, boxSizing: 'border-box', ...streakStyle(item.state) }} />)}
          </div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            {(['london', 'ny'] as const).map(item => {
              const prep = ctl.journal.preps[item];
              const close = ctl.journal.closes[item];
              return (
                <div key={item} style={{ flex: 1, display: 'flex', gap: 6 }}>
                  <button type="button" className="dj-btn" onClick={() => ctl.openPrep(item)} style={{ ...phoneChip, color: prep ? 'var(--dj-indigo-text)' : 'var(--dj-text-2)', borderColor: prep ? 'rgba(99,102,241,0.4)' : 'var(--dj-line)' }}>{prep ? '✓ ' : ''}Příprava {item === 'ny' ? 'NY' : 'LDN'}</button>
                  <button type="button" className="dj-btn" disabled={ctl.isToday && sessionStage(item, ctl.windows, ctl.now) === 'upcoming'} onClick={() => ctl.openClose(item)} style={{ ...phoneChip, color: close ? 'var(--dj-blue)' : 'var(--dj-text-2)', borderColor: close ? 'rgba(59,130,246,0.4)' : 'var(--dj-line)', opacity: ctl.isToday && sessionStage(item, ctl.windows, ctl.now) === 'upcoming' ? 0.4 : 1 }}>{close ? '✓ ' : ''}Uzavřít</button>
                </div>
              );
            })}
          </div>
          <p style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 700 }}>Časová osa</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}><FeedList ctl={ctl} items={ctl.feed} /></div>
        </div>
      </>
    );
    bottom = (
      <button type="button" className="dj-btn" onClick={() => setSheet({ kind: 'dictate' })} aria-label="Nadiktovat poznámku" style={{ margin: '0 auto', height: 56, padding: '0 22px 0 18px', borderRadius: 99, border: 0, display: 'flex', alignItems: 'center', gap: 10, color: '#fff', font: '800 14px Inter, sans-serif', background: 'linear-gradient(180deg,#6366f1,#4f46e5)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.28), 0 12px 30px -8px rgba(79,70,229,0.8)' }}>
        <Mic size={20} /> Poznámka hlasem
      </button>
    );
  }

  const celebrationOrigin = { left: '50%', top: 'calc(100% - 60px)' };
  return (
    <div className="dj" style={{ position: 'relative', margin: '0 -16px', paddingBottom: 110 }}>
      <div style={{ paddingTop: 4 }}>{content}</div>
      <div style={{ position: 'fixed', left: 0, right: 0, bottom: bottomOffset, zIndex: 40, padding: '20px 16px 0', background: 'linear-gradient(180deg, transparent, var(--dj-bg) 40%)', display: 'flex' }}>
        <div style={{ width: '100%', maxWidth: 520, margin: '0 auto', display: 'flex', justifyContent: 'center' }}>{bottom && <div style={{ width: mode === 'day' ? undefined : '100%' }}>{bottom}</div>}</div>
      </div>

      {sheet?.kind === 'pin' && <PinSheet ctl={ctl} point={sheet.point} autoRecord={sheet.record} onClose={closeSheet} />}
      {sheet?.kind === 'dictate' && <DictationDialog ctl={ctl} sheet onClose={() => setSheet(null)} />}
      {mode === 'day' && ctl.selectedTrade && <TradeSheet ctl={ctl} trade={ctl.selectedTrade} onOpenTrade={onOpenTrade} onClose={() => ctl.setSelected(null)} />}

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
const phoneChip: React.CSSProperties = { flex: 1, height: 34, borderRadius: 10, border: '1px solid', background: 'var(--dj-chip)', font: '700 11.5px Inter, sans-serif', cursor: 'pointer', whiteSpace: 'nowrap' };
