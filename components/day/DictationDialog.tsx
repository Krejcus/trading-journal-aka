import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { pragueClock } from '../../lib/dayJournal';
import { formatDictationClock } from '../../hooks/useDictation';
import { Waveform } from './DayPrimitives';
import type { DayController } from './useDayController';

/**
 * Rychlé diktování z hlavičky dne: hned nahrává, po zastavení ukáže čistý
 * přepis (jde opravit) a uloží ho jako poznámku. Dnes se připíchne k teď
 * a poslední ceně, jindy jde do časové osy bez kotvy.
 */
export default function DictationDialog({ ctl, onClose, sheet = false }: { ctl: DayController; onClose: () => void; sheet?: boolean }) {
  const { dictation } = ctl;
  const [text, setText] = useState<string | null>(null);
  const [startedAt] = useState(() => Date.now());
  // Jednou za otevření (StrictMode efekt spouští dvakrát, ref přežije).
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void dictation.start().then(result => { if (result) setText(result); });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nahrávání jen při otevření
  }, []);
  const cancel = () => { dictation.cancel(); onClose(); };
  // Hotový přepis zahodí jen tlačítko „Zahodit“ — ne Esc ani klik vedle.
  const hasText = Boolean(text?.trim());
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !hasText && dictation.phase !== 'transcribing') cancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const last = ctl.chart.candles[ctl.chart.candles.length - 1];
  const anchor = ctl.isToday && last && Date.now() / 1000 - last.time < 15 * 60
    ? { time: Math.floor(startedAt / 60_000) * 60, price: last.close } : null;
  const where = anchor ? `připíchnu k ${pragueClock(anchor.time * 1000)}` : 'do časové osy dne';
  const save = () => {
    if (!text?.trim()) return;
    ctl.createNote(text, anchor, true);
    onClose();
  };
  const phase = text != null ? 'done' : dictation.phase === 'transcribing' ? 'proc' : dictation.phase === 'error' ? 'error' : 'rec';

  const body = (
    <section role="dialog" aria-label="Diktování poznámky" className="dj" style={sheet
      ? { position: 'absolute', left: 0, right: 0, bottom: 0, borderRadius: '22px 22px 0 0', borderTop: '1px solid var(--dj-line)', background: 'var(--dj-card)', padding: '10px 18px 30px', animation: 'dj-sheet .28s cubic-bezier(.2,.9,.25,1) both' }
      : { width: '100%', maxWidth: 440, borderRadius: 18, border: '1px solid var(--dj-line)', background: 'var(--dj-card)', boxShadow: '0 50px 120px -30px rgba(0,0,0,0.95)', padding: 22, animation: 'dj-rise .25s ease both' }}>
      {sheet && <span style={{ display: 'block', width: 38, height: 5, borderRadius: 9, background: 'var(--dj-line)', margin: '0 auto 14px' }} />}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <p style={{ margin: 0, fontSize: 14, fontWeight: 800 }}>{phase === 'done' ? 'Přepis' : 'Mluv'}</p>
        <span style={{ flex: 1 }} />
        <span className="dj-mono" style={{ fontSize: 11, fontWeight: 600, color: 'var(--dj-text-2)' }}>zapsáno {pragueClock(startedAt)} · {where}</span>
      </div>
      {phase === 'rec' && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, padding: '22px 0 6px' }}>
          <button type="button" onClick={() => void dictation.stop()} aria-label="Zastavit nahrávání" style={{ width: 76, height: 76, borderRadius: 99, border: 0, cursor: 'pointer', background: '#f43f5e', display: 'grid', placeItems: 'center', animation: 'dj-rec 1.4s ease-out infinite' }}>
            <span style={{ width: 22, height: 22, borderRadius: 5, background: '#fff' }} />
          </button>
          <Waveform levels={dictation.levels} height={34} />
          <p className="dj-mono" style={{ margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--dj-rose-text)' }}>{formatDictationClock(dictation.seconds)}</p>
          <p style={{ margin: 0, fontSize: 12, color: 'var(--dj-muted)', textAlign: 'center' }}>Mluv normálně. Klepnutím zastavíš, uloží se přesný přepis.</p>
        </div>
      )}
      {phase === 'proc' && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: '34px 0 20px' }}>
          <span style={{ width: 34, height: 34, borderRadius: 99, border: '3px solid var(--dj-line)', borderTopColor: '#818cf8', animation: 'dj-spin .8s linear infinite' }} />
          <p style={{ margin: 0, fontSize: 12.5, color: 'var(--dj-text-2)' }}>Přepisuji…</p>
        </div>
      )}
      {phase === 'error' && (
        <div style={{ padding: '18px 0 4px' }}>
          <p role="alert" style={{ margin: 0, fontSize: 13, color: 'var(--dj-rose)' }}>{dictation.error}</p>
          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <button type="button" className="dj-btn" onClick={cancel} style={ghost}>Zavřít</button>
            {dictation.canRetry
              ? <button type="button" className="dj-btn" onClick={() => { void dictation.retry().then(result => { if (result) setText(result); }); }} style={primary}>Zkusit přepis znovu</button>
              : <button type="button" className="dj-btn" onClick={() => { dictation.reset(); void dictation.start().then(result => { if (result) setText(result); }); }} style={primary}>Nahrát znovu</button>}
          </div>
        </div>
      )}
      {phase === 'done' && (
        <div style={{ paddingTop: 12 }}>
          <textarea className="dj-input" autoFocus rows={4} value={text ?? ''} onChange={event => setText(event.target.value)} aria-label="Přepis diktování" style={{ fontSize: 13.5 }}
            onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) save(); }} />
          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <button type="button" className="dj-btn" onClick={cancel} style={ghost}>Zahodit</button>
            <button type="button" className="dj-btn" onClick={save} disabled={!text?.trim()} style={primary}>{anchor ? 'Uložit do grafu' : 'Uložit do časové osy'}</button>
          </div>
        </div>
      )}
    </section>
  );

  return createPortal(
    <div className="dj" onClick={event => { if (event.target === event.currentTarget && phase === 'error' && !dictation.canRetry) cancel(); }} style={{ position: 'fixed', inset: 0, zIndex: 1000, display: sheet ? 'block' : 'grid', placeItems: 'center', padding: sheet ? 0 : 16, background: 'rgba(2,6,23,0.62)', backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)' }}>
      {body}
    </div>,
    document.body,
  );
}

const ghost: React.CSSProperties = { flex: 1, height: 44, borderRadius: 11, cursor: 'pointer', font: '600 13px Inter, sans-serif', color: 'var(--dj-text-2)', background: 'transparent', border: '1px solid var(--dj-line)' };
const primary: React.CSSProperties = { flex: 2, height: 44, borderRadius: 11, cursor: 'pointer', border: 0, font: '700 13px Inter, sans-serif', color: '#fff', background: 'linear-gradient(180deg,#6366f1,#4f46e5)' };
