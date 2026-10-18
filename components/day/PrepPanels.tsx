import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, Mic, PenLine, Plus, X } from 'lucide-react';
import { DAY_RULE_PRESETS, pragueClock, prepReady, type DayNote, type DaySession } from '../../lib/dayJournal';
import { sessionStage } from '../../lib/dayJournalView';
import { BiasPicker, BigSaveButton, MicButton, SESSION_STYLE, Waveform, priceText, recordingStatus } from './DayPrimitives';
import { dayTitle, LiveChip } from './DayPanels';
import type { DayController } from './useDayController';
import type { DayPinPoint } from './DayNotesLayer';

const clock = (ms: number) => pragueClock(ms);
export const prepPins = (ctl: DayController, session: DaySession): DayNote[] =>
  ctl.journal.notes.filter(note => note.session === session && note.origin === 'prep');

export function prepSessionStatus(ctl: DayController, active: DaySession): Record<DaySession, { text: string; tone: 'done' | 'active' | 'idle' }> {
  const out = {} as Record<DaySession, { text: string; tone: 'done' | 'active' | 'idle' }>;
  for (const session of ['london', 'ny'] as const) {
    const saved = ctl.journal.preps[session];
    const draft = ctl.prepDraft(session);
    out[session] = saved && !draft.touched ? { text: '✓ uloženo', tone: 'done' }
      : session === active ? { text: 'rozpracováno', tone: 'active' }
        : { text: `čeká · ${clock(ctl.windows[session].start)}`, tone: 'idle' };
  }
  return out;
}

/** Časovač přípravy: kroužek se během první minuty zaplní, pak zežloutne. */
export function PrepTimer({ openedAt }: { openedAt: number }) {
  const [seconds, setSeconds] = useState(() => Math.floor((Date.now() - openedAt) / 1000));
  useEffect(() => {
    setSeconds(Math.floor((Date.now() - openedAt) / 1000));
    const timer = window.setInterval(() => setSeconds(Math.floor((Date.now() - openedAt) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [openedAt]);
  const color = seconds <= 60 ? 'var(--dj-indigo)' : 'var(--dj-amber)';
  const capped = Math.min(seconds, 99 * 60);
  return (
    <div title="Jak dlouho připravuješ" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 11px 5px 5px', borderRadius: 12, border: '1px solid var(--dj-line)', background: 'var(--dj-chip)' }}>
      <svg width="30" height="30" viewBox="0 0 36 36" aria-hidden="true">
        <circle cx="18" cy="18" r="15" fill="none" stroke="var(--dj-line)" strokeWidth="3" />
        <circle cx="18" cy="18" r="15" fill="none" strokeWidth="3" strokeLinecap="round" strokeDasharray="94.25" strokeDashoffset={(94.25 * (1 - Math.min(1, seconds / 60))).toFixed(2)} transform="rotate(-90 18 18)" style={{ stroke: color, transition: 'stroke-dashoffset 1s linear' }} />
      </svg>
      <span className="dj-mono" style={{ fontSize: 14, fontWeight: 700, color }}>{Math.floor(capped / 60)}:{String(capped % 60).padStart(2, '0')}</span>
    </div>
  );
}

export function PrepHeaderBar({ ctl, session, onSwitch }: { ctl: DayController; session: DaySession; onSwitch: (session: DaySession) => void }) {
  const draft = ctl.prepDraft(session);
  const before = sessionStage(session, ctl.windows, ctl.now) === 'upcoming' ? `před ${SESSION_STYLE[session].name} ${clock(ctl.windows[session].start)}` : `${SESSION_STYLE[session].name} od ${clock(ctl.windows[session].start)}`;
  // Na užší šířce se štítek stavu dat schová, ať se řádek vejde.
  const headerRef = useRef<HTMLElement>(null);
  const [tight, setTight] = useState(false);
  useLayoutEffect(() => {
    const element = headerRef.current;
    if (!element) return;
    const measure = () => setTight(element.clientWidth < 1260);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    // Deník B+: jeden řádek (nápověda k biasu je v tooltipu).
    <header ref={headerRef} className="dj" style={{ display: 'flex', flexWrap: 'nowrap', alignItems: 'center', gap: 12, padding: '8px 14px', overflowX: 'auto', scrollbarWidth: 'none', whiteSpace: 'nowrap', borderBottom: '1px solid var(--dj-line)', background: 'var(--dj-card)' }}>
      <button type="button" className="dj-btn" onClick={ctl.backToDay} aria-label="Zpět na den" style={{ height: 34, width: 34, flex: 'none', borderRadius: 10, display: 'grid', placeItems: 'center', cursor: 'pointer', color: 'var(--dj-text-2)', border: '1px solid var(--dj-line)', background: 'transparent' }}><ArrowLeft size={16} /></button>
      <div style={{ minWidth: 0, flex: 'none' }}>
        <p style={{ margin: 0, fontSize: 10.5, fontWeight: 600, color: 'var(--dj-muted)' }}>{dayTitle(ctl.day)} · {before}</p>
        <h1 style={{ margin: 0, fontSize: 16, fontWeight: 800, letterSpacing: '-0.02em' }}>Příprava {SESSION_STYLE[session].name}</h1>
      </div>
      <span style={{ flex: 1 }} />
      <span title={draft.bias ? 'Klikni jinam a změníš ho.' : 'Jedním klikem. Bez biasu se plán neuloží.'} style={{ flex: 'none' }}><BiasPicker value={draft.bias} onChange={bias => ctl.updatePrepDraft(session, { bias })} /></span>
      {!tight && <LiveChip status={ctl.chart.liveStatus} capturedAt={ctl.chart.liveCapturedAt} weekendMarketDay={ctl.weekendMarketDay} compact />}
      <PrepTimer openedAt={draft.openedAt} />
    </header>
  );
}

/** Tlačítka „Napsat / Nadiktovat do grafu“. */
export function PinModeButtons({ ctl, onVoice }: { ctl: DayController; onVoice: () => void }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      <button type="button" className="dj-btn" aria-pressed={ctl.placing === 'note'} onClick={() => { ctl.setPendingPoint(null); ctl.setPlacing(ctl.placing === 'note' ? null : 'note'); }} style={{ height: 34, padding: '0 12px', borderRadius: 9, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 7, font: '700 12px Inter, sans-serif', ...(ctl.placing === 'note' ? { color: '#1e1b4b', background: '#a5b4fc', border: '1px solid #a5b4fc' } : { color: 'var(--dj-indigo-text)', background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.35)' }) }}>
        <PenLine size={14} /> Napsat do grafu
      </button>
      <button type="button" className="dj-btn" aria-pressed={ctl.placing === 'voice'} onClick={onVoice} style={{ height: 34, padding: '0 13px', borderRadius: 9, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 7, font: '700 12px Inter, sans-serif', color: '#fff', ...(ctl.placing === 'voice' ? { background: '#f43f5e', border: '1px solid #f43f5e' } : { background: 'linear-gradient(180deg,#6366f1,#4f46e5)', border: '1px solid #6366f1' }) }}>
        <Mic size={14} /> Nadiktovat do grafu
      </button>
    </div>
  );
}

/**
 * Bublina nad vybraným místem v grafu: nahrávání → přepis do pole →
 * Připíchnout. Text je čistý přepis, jde ho před uložením opravit.
 */
export function PinPopover({ ctl, point, autoRecord, onClose, accent = 'indigo' }: { ctl: DayController; point: DayPinPoint; autoRecord: boolean; onClose: () => void; accent?: 'indigo' | 'amber' }) {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- jen při otevření
  }, []);
  const recording = dictation.phase === 'recording';
  const status = recordingStatus(dictation.phase, dictation.seconds, dictation.error);
  const save = () => {
    if (!draft.trim()) return;
    ctl.createNote(draft, point, voice);
    onClose();
  };
  const border = accent === 'amber' ? 'rgba(251,191,36,0.55)' : 'rgba(129,140,248,0.55)';
  return (
    <div className="dj" onClick={event => event.stopPropagation()} style={{ width: 290, borderRadius: 12, border: `1px solid ${border}`, background: 'var(--dj-card)', color: 'var(--dj-text)', boxShadow: '0 24px 50px -16px rgba(0,0,0,0.55)', padding: '11px 12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span className="dj-mono" style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--dj-indigo)' }}>{clock(point.time * 1000)} · {priceText(point.price)}</span>
        <span style={{ flex: 1 }} />
        <span className="dj-mono" style={{ fontSize: 10, fontWeight: 600, color: 'var(--dj-muted)' }}>zapíše se {clock(ctl.now)}</span>
      </div>
      {recording || dictation.phase === 'transcribing' ? (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
            <MicButton phase={dictation.phase} onStart={() => void record()} onStop={() => void dictation.stop()} size={40} />
            {recording ? <Waveform levels={dictation.levels.slice(-18)} /> : <span style={{ fontSize: 12, color: 'var(--dj-indigo)' }}>Přepisuji…</span>}
          </div>
          <p style={{ margin: '8px 0 0', fontSize: 11.5, color: 'var(--dj-muted)' }}>{recording ? 'Mluv. Klepnutím zastavíš, text se objeví tady.' : 'Za chvíli tu bude přesný přepis.'}</p>
        </>
      ) : (
        <>
          <textarea className="dj-input" autoFocus rows={3} value={draft} onChange={event => setDraft(event.target.value)} placeholder="Co tady čekáš? Kde vstoupíš, kde se mýlíš…" aria-label="Text poznámky v grafu" style={{ marginTop: 8, fontSize: 12.5 }}
            onKeyDown={event => { event.stopPropagation(); if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); save(); } if (event.key === 'Escape' && !draft.trim()) onClose(); }} />
          {status && dictation.phase === 'error' && <p role="alert" style={{ margin: '6px 0 0', fontSize: 11.5, color: status.color }}>{status.text}{dictation.canRetry && <> · <button type="button" onClick={() => { void dictation.retry().then(text => { if (text) { setDraft(current => (current.trim() ? `${current.trim()} ${text}` : text)); setVoice(true); } }); }} style={{ border: 0, background: 'none', padding: 0, color: 'var(--dj-indigo)', fontWeight: 700, cursor: 'pointer', font: 'inherit' }}>zkusit přepis znovu</button></>}</p>}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
            <button type="button" className="dj-btn" onClick={() => void record()} aria-label="Nadiktovat" style={{ height: 32, width: 32, borderRadius: 8, cursor: 'pointer', display: 'grid', placeItems: 'center', color: 'var(--dj-indigo-strong)', background: 'rgba(99,102,241,0.16)', border: '1px solid rgba(99,102,241,0.4)' }}><Mic size={14} /></button>
            <span style={{ flex: 1 }} />
            <button type="button" className="dj-btn" onClick={() => { dictation.cancel(); onClose(); }} style={{ height: 32, padding: '0 10px', borderRadius: 8, cursor: 'pointer', font: '600 12px Inter, sans-serif', color: 'var(--dj-text-2)', background: 'transparent', border: '1px solid var(--dj-line)' }}>Zrušit</button>
            <button type="button" className="dj-btn" onClick={save} disabled={!draft.trim()} style={{ height: 32, padding: '0 12px', borderRadius: 8, cursor: draft.trim() ? 'pointer' : 'not-allowed', opacity: draft.trim() ? 1 : 0.5, font: '700 12px Inter, sans-serif', color: '#1e1b4b', background: '#a5b4fc', border: 0 }}>Připíchnout</button>
          </div>
        </>
      )}
    </div>
  );
}

export function RuleChips({ ctl, session }: { ctl: DayController; session: DaySession }) {
  const draft = ctl.prepDraft(session);
  const [adding, setAdding] = useState<string | null>(null);
  const options = [...DAY_RULE_PRESETS, ...draft.rules.filter(rule => !DAY_RULE_PRESETS.includes(rule))];
  const toggle = (rule: string) => ctl.updatePrepDraft(session, { rules: draft.rules.includes(rule) ? draft.rules.filter(item => item !== rule) : [...draft.rules, rule] });
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
      {options.map(rule => {
        const on = draft.rules.includes(rule);
        return (
          <button key={rule} type="button" className="dj-btn" aria-pressed={on} onClick={() => toggle(rule)} style={{ height: 27, padding: '0 9px', borderRadius: 7, cursor: 'pointer', font: '600 11.5px Inter, sans-serif', ...(on ? { color: 'var(--dj-rose-soft)', background: 'rgba(244,63,94,0.12)', border: '1px solid rgba(244,63,94,0.45)' } : { color: 'var(--dj-muted)', background: 'transparent', border: '1px dashed var(--dj-line)' }) }}>{rule}</button>
        );
      })}
      {adding == null ? (
        <button type="button" className="dj-btn" onClick={() => setAdding('')} aria-label="Přidat vlastní pravidlo" style={{ height: 27, width: 27, borderRadius: 7, cursor: 'pointer', display: 'grid', placeItems: 'center', color: 'var(--dj-muted)', background: 'transparent', border: '1px dashed var(--dj-line)' }}><Plus size={13} /></button>
      ) : (
        <input autoFocus className="dj-input" value={adding} maxLength={60} placeholder="vlastní pravidlo…" aria-label="Vlastní pravidlo" onChange={event => setAdding(event.target.value)}
          onBlur={() => { const rule = adding.trim(); if (rule && !draft.rules.includes(rule)) ctl.updatePrepDraft(session, { rules: [...draft.rules, rule] }); setAdding(null); }}
          onKeyDown={event => { event.stopPropagation(); if (event.key === 'Enter') (event.target as HTMLInputElement).blur(); if (event.key === 'Escape') setAdding(null); }}
          style={{ width: 150, height: 27, padding: '0 8px', fontSize: 11.5, borderRadius: 7 }} />
      )}
    </div>
  );
}

export function ScenarioField({ ctl, session, rows }: { ctl: DayController; session: DaySession; rows?: number }) {
  const draft = ctl.prepDraft(session);
  const { dictation } = ctl;
  const [fieldRecording, setFieldRecording] = useState(false);
  const recording = fieldRecording && dictation.phase === 'recording';
  const busy = fieldRecording && dictation.phase === 'transcribing';
  const record = async () => {
    setFieldRecording(true);
    const text = await dictation.start();
    setFieldRecording(false);
    if (text) ctl.updatePrepDraft(session, current => ({ scenario: current.scenario.trim() ? `${current.scenario.trim()} ${text}` : text }));
  };
  return (
    <div style={{ flex: 1.1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <label htmlFor={`prep-scenario-${session}`} style={{ fontSize: 12, fontWeight: 700 }}>Scénář</label>
        <span style={{ fontSize: 11, color: 'var(--dj-muted)', minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>jedna věta, nebo připíchni do grafu</span>
        <span style={{ flex: 1 }} />
        <button type="button" className="dj-btn" onClick={() => (recording ? void dictation.stop() : busy ? undefined : void record())} aria-label={recording ? 'Zastavit nahrávání' : 'Nadiktovat scénář do kolonky'} style={{ height: 28, padding: '0 9px', borderRadius: 7, cursor: busy ? 'progress' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5, font: '700 11px Inter, sans-serif', ...(recording ? { color: '#fff', background: '#f43f5e', border: '1px solid #f43f5e', animation: 'dj-rec 1.4s ease-out infinite' } : { color: 'var(--dj-indigo-strong)', background: 'rgba(99,102,241,0.16)', border: '1px solid rgba(99,102,241,0.4)' }) }}>
          <Mic size={12} /> {recording ? 'Nahrávám… stop' : busy ? 'Přepisuji…' : 'Nadiktovat'}
        </button>
      </div>
      <textarea id={`prep-scenario-${session}`} className="dj-input" rows={rows} value={draft.scenario} onChange={event => ctl.updatePrepDraft(session, { scenario: event.target.value })} placeholder="Co musí trh udělat, abys vstoupil? Kde je cíl, kde se mýlíš?" style={{ flex: rows ? undefined : 1, minHeight: 0, fontSize: 13 }} />
      {fieldRecording && dictation.phase === 'error' && <p role="alert" style={{ margin: '4px 0 0', fontSize: 11.5, color: 'var(--dj-rose)' }}>{dictation.error}</p>}
    </div>
  );
}

export function PinList({ ctl, session }: { ctl: DayController; session: DaySession }) {
  const pins = prepPins(ctl, session);
  const [error, setError] = useState<string | null>(null);
  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      <p style={{ margin: '0 0 6px', fontSize: 12, fontWeight: 700 }}>V grafu <span style={{ fontWeight: 600, color: 'var(--dj-muted)' }}>· {pins.length}</span></p>
      <div className="dj-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 5 }}>
        {[...pins].reverse().map(pin => (
          <div key={pin.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '6px 8px', borderRadius: 8, border: `1px solid ${ctl.failedNotes.has(pin.id) ? 'rgba(244,63,94,0.5)' : 'rgba(129,140,248,0.25)'}`, background: 'var(--dj-indigo-bg-soft)', animation: 'dj-rise .2s ease both' }}>
            <span className="dj-mono" style={{ fontSize: 10, fontWeight: 700, color: 'var(--dj-indigo)', whiteSpace: 'nowrap', paddingTop: 2 }}>zapsáno {clock(Date.parse(pin.writtenAt))}</span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 12, color: 'var(--dj-indigo-strong)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={pin.text}>{pin.text}</span>
              {pin.time != null && pin.price != null && <span className="dj-mono" style={{ display: 'block', fontSize: 10, fontWeight: 500, color: 'var(--dj-muted)' }}>→ {clock(pin.time * 1000)} · {priceText(pin.price)}</span>}
            </span>
            <button type="button" className="dj-btn" onClick={() => { ctl.removeNote(pin.id).then(() => setError(null), reason => setError(reason instanceof Error ? reason.message : 'Smazání se nepodařilo.')); }} aria-label="Odebrat poznámku" style={{ width: 24, height: 24, flex: 'none', borderRadius: 6, cursor: 'pointer', border: 0, background: 'transparent', color: 'var(--dj-muted)', display: 'grid', placeItems: 'center' }}><X size={12} strokeWidth={2.4} /></button>
          </div>
        ))}
        {!pins.length && <p style={{ margin: 0, padding: 10, borderRadius: 8, border: '1px dashed rgba(129,140,248,0.35)', fontSize: 12, color: 'var(--dj-muted)' }}>Klikni „Nadiktovat do grafu“ a pak na místo, kde něco čekáš.</p>}
        {error && <p role="alert" style={{ margin: 0, fontSize: 11.5, color: 'var(--dj-rose)' }}>{error}</p>}
      </div>
    </div>
  );
}

export function prepRequirements(ctl: DayController, session: DaySession) {
  const draft = ctl.prepDraft(session);
  const pins = prepPins(ctl, session).length;
  const { ready, missing } = prepReady(draft, pins);
  return { ready, missing, items: [{ label: 'Bias', ok: !missing.includes('bias') }, { label: 'Scénář', ok: !missing.includes('scenario') }] };
}

export function RequirementChips({ items }: { items: { label: string; ok: boolean }[] }) {
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      {items.map(item => (
        <span key={item.label} style={{ height: 24, padding: '0 9px', display: 'inline-flex', alignItems: 'center', gap: 6, borderRadius: 7, fontSize: 11.5, fontWeight: 700, transition: 'all .25s ease', ...(item.ok ? { color: 'var(--dj-green-text)', background: 'rgba(16,185,129,0.12)' } : { color: 'var(--dj-muted)', background: 'var(--dj-line-soft)' }) }}>
          <span style={{ width: 14, height: 14, borderRadius: 9, display: 'grid', placeItems: 'center', ...(item.ok ? { background: '#34d399' } : { border: '1.5px dashed var(--dj-line)' }) }}>
            {item.ok && <span style={{ fontSize: 9, fontWeight: 900, color: '#052e16', animation: 'dj-check .3s ease both' }}>✓</span>}
          </span>
          {item.label}
        </span>
      ))}
    </div>
  );
}

export const missingLabel = (missing: ('bias' | 'scenario')[]) => `Chybí ${missing.map(item => (item === 'bias' ? 'bias' : 'scénář')).join(' a ')}`;

export function PrepBottom({ ctl, session, saving, error, onSave, onVoice }: { ctl: DayController; session: DaySession; saving: boolean; error: string | null; onSave: () => void; onVoice: () => void }) {
  const req = prepRequirements(ctl, session);
  const saved = ctl.journal.preps[session];
  const draft = ctl.prepDraft(session);
  return (
    // Deník B+: jeden plochý pás bez vnořených karet — scénář, body v grafu,
    // pravidla a uložení vedle sebe; graf nad ním má víc výšky.
    <section className="dj" style={{ display: 'flex', gap: 16, height: 196, padding: '10px 14px', borderTop: '1px solid var(--dj-line)', background: 'var(--dj-card)' }}>
      <ScenarioField ctl={ctl} session={session} />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <PinList ctl={ctl} session={session} />
        <PinModeButtons ctl={ctl} onVoice={onVoice} />
      </div>
      <div style={{ flex: '0 0 clamp(220px, 22%, 300px)', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <p style={{ margin: '0 0 6px', fontSize: 12, fontWeight: 700 }}>Neobchoduju, pokud…</p>
        <div className="dj-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}><RuleChips ctl={ctl} session={session} /></div>
      </div>
      <div style={{ flex: '0 0 230px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8, justifyContent: 'flex-end' }}>
        <RequirementChips items={req.items} />
        <BigSaveButton height={46} ready={req.ready} saving={saving} label={missingLabel(req.missing)} readyLabel={saved && !draft.touched ? 'Plán je uložený · znovu' : 'Uložit plán'} onClick={onSave} error={error} />
      </div>
    </section>
  );
}
