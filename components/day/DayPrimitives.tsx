import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, Check, Mic, Square } from 'lucide-react';
import { formatDictationClock, type DictationPhase } from '../../hooks/useDictation';
import type { DayBias, DayExecution, DayNotePhase, DaySession } from '../../lib/dayJournal';
import './dayJournal.css';

/** Barvy fáze poznámky z návrhu: příprava fialová, živě jantar, zpětně šedá. */
export const PHASE_STYLE: Record<DayNotePhase, { color: string; label: string; soft: string; line: string; text: string; bg: string }> = {
  prep: { color: '#818cf8', label: 'příprava', soft: 'rgba(99,102,241,0.14)', line: 'rgba(129,140,248,0.55)', text: '#c7d2fe', bg: 'rgba(30,27,75,0.35)' },
  live: { color: '#f59e0b', label: 'živě', soft: 'rgba(245,158,11,0.14)', line: 'rgba(251,191,36,0.5)', text: '#fef3c7', bg: 'rgba(120,53,15,0.14)' },
  later: { color: '#94a3b8', label: 'dopsáno zpětně', soft: 'rgba(148,163,184,0.14)', line: 'rgba(148,163,184,0.5)', text: '#e2e8f0', bg: 'rgba(30,41,59,0.45)' },
};

export const SESSION_STYLE: Record<DaySession | 'day', { color: string; name: string; tint: string }> = {
  london: { color: '#3b82f6', name: 'London', tint: 'rgba(59,130,246,' },
  ny: { color: '#f97316', name: 'New York', tint: 'rgba(249,115,22,' },
  day: { color: '#94a3b8', name: 'Celý den', tint: 'rgba(148,163,184,' },
};

export const BIAS_OPTIONS: { id: DayBias; icon: string; text: string; ink: string; bg: string; glow: string; anim: string }[] = [
  { id: 'long', icon: '↗', text: 'Long', ink: '#052e16', bg: '#34d399', glow: 'rgba(52,211,153,0.55)', anim: 'dj-arrow-up' },
  { id: 'neutral', icon: '→', text: 'Neutrál', ink: '#0b1120', bg: '#e2e8f0', glow: 'rgba(226,232,240,0.4)', anim: 'dj-pop2' },
  { id: 'short', icon: '↘', text: 'Short', ink: '#4c0519', bg: '#fb7185', glow: 'rgba(251,113,133,0.55)', anim: 'dj-arrow-down' },
];

export const EXECUTION_OPTIONS: { id: DayExecution; text: string; ink: string; bg: string; glow: string }[] = [
  { id: 'plan', text: 'Podle plánu', ink: '#052e16', bg: '#34d399', glow: 'rgba(52,211,153,0.55)' },
  { id: 'partial', text: 'Částečně', ink: '#1c1203', bg: '#fbbf24', glow: 'rgba(251,191,36,0.5)' },
  { id: 'off', text: 'Mimo plán', ink: '#4c0519', bg: '#fb7185', glow: 'rgba(251,113,133,0.55)' },
];

export const money = (value: number) => {
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}$${Math.abs(Math.round(value)).toLocaleString('cs-CZ')}`;
};
export const rText = (value: number | null) => value == null ? '— R' : `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(2).replace('.', ',')} R`;
export const tone = (value: number) => value > 0 ? '#10b981' : value < 0 ? '#f43f5e' : 'var(--dj-text)';
export const priceText = (price: number) => price.toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Segmentový přepínač s indikátorem, který na vybranou volbu „doskočí“
 * pružinou, a vlnkou při výběru. Šířka položky je pevná (px), ať indikátor
 * jede po celých krocích.
 */
export function SpringSegmented<T extends string>({ options, value, onChange, itemWidth, height = 40, gap = 4, label, renderItem, indicatorStyle, rippleColor, fill = false }: {
  options: readonly { id: T }[];
  value: T | null;
  onChange: (id: T) => void;
  itemWidth?: number;
  height?: number;
  gap?: number;
  label: string;
  renderItem: (option: T, on: boolean, fx: boolean) => React.ReactNode;
  indicatorStyle: (id: T) => React.CSSProperties;
  rippleColor?: (id: T) => string;
  /** Položky vyplní šířku (telefon) — indikátor se počítá v procentech. */
  fill?: boolean;
}) {
  const index = value == null ? -1 : options.findIndex(option => option.id === value);
  const [fx, setFx] = useState(0);
  const previous = useRef(value);
  useEffect(() => {
    if (previous.current === value) return;
    previous.current = value;
    if (value == null) return;
    setFx(count => count + 1);
  }, [value]);
  const [fxOn, setFxOn] = useState(false);
  useEffect(() => {
    if (!fx) return;
    setFxOn(true);
    const timer = window.setTimeout(() => setFxOn(false), 650);
    return () => window.clearTimeout(timer);
  }, [fx]);
  const n = options.length;
  const width = fill ? `calc((100% - ${gap * 2 + gap * (n - 1)}px) / ${n})` : `${itemWidth}px`;
  const offset = (i: number) => fill ? `calc(${i} * (100% - ${gap * 2 + gap * (n - 1)}px) / ${n} + ${i * gap}px)` : `${i * ((itemWidth ?? 0) + gap)}px`;
  const center = (i: number) => fill ? `calc(${gap}px + ${i} * (100% - ${gap * 2 + gap * (n - 1)}px) / ${n} + ${i * gap}px + (100% - ${gap * 2 + gap * (n - 1)}px) / ${n * 2})` : `${gap + i * ((itemWidth ?? 0) + gap) + (itemWidth ?? 0) / 2}px`;
  return (
    <div role="group" aria-label={label} style={{ position: 'relative', display: 'grid', gridTemplateColumns: `repeat(${n}, ${fill ? 'minmax(0, 1fr)' : `${itemWidth}px`})`, gap, padding: gap, borderRadius: 13, border: '1px solid var(--dj-line)', background: 'var(--dj-seg)', overflow: 'hidden' }}>
      <span
        className="dj-ind"
        aria-hidden="true"
        style={{
          position: 'absolute', top: gap, left: gap, width, height, borderRadius: 9,
          ...(index >= 0
            ? { transform: `translateX(${offset(index)})`, opacity: 1, ...indicatorStyle(options[index].id) }
            : { transform: `translateX(${offset(Math.floor(n / 2))}) scale(.6)`, opacity: 0 }),
        }}
      />
      {fxOn && index >= 0 && rippleColor && (
        <span aria-hidden="true" key={fx} style={{ position: 'absolute', left: center(index), top: gap + height / 2, width: 150, height: 150, borderRadius: 999, pointerEvents: 'none', animation: 'dj-ripple .6s ease-out both', background: `radial-gradient(circle, ${rippleColor(options[index].id)}, transparent 65%)` }} />
      )}
      {options.map(option => {
        const on = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={on}
            className="dj-seg-btn"
            onClick={() => onChange(option.id)}
            style={{ position: 'relative', zIndex: 1, height, padding: 0, border: 0, borderRadius: 9, cursor: 'pointer', background: 'transparent', minWidth: 0 }}
          >
            {renderItem(option.id, on, on && fxOn)}
          </button>
        );
      })}
    </div>
  );
}

export function BiasPicker({ value, onChange, itemWidth = 108, fill = false, height = 40 }: { value: DayBias | null; onChange: (bias: DayBias) => void; itemWidth?: number; fill?: boolean; height?: number }) {
  return (
    <SpringSegmented
      label="Bias"
      options={BIAS_OPTIONS}
      value={value}
      onChange={onChange}
      itemWidth={itemWidth}
      fill={fill}
      height={height}
      indicatorStyle={id => { const o = BIAS_OPTIONS.find(item => item.id === id)!; return { background: o.bg, boxShadow: `0 6px 22px -6px ${o.glow}, inset 0 1px 0 rgba(255,255,255,0.4)` }; }}
      rippleColor={id => BIAS_OPTIONS.find(item => item.id === id)!.glow}
      renderItem={(id, on, fx) => {
        const o = BIAS_OPTIONS.find(item => item.id === id)!;
        return (
          <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, width: '100%', font: '800 13.5px Inter, sans-serif', color: on ? o.ink : 'var(--dj-text-2)' }}>
            <span style={{ display: 'inline-block', animation: fx ? `${o.anim} .5s cubic-bezier(.34,1.56,.64,1) both` : undefined }}>{o.icon}</span>
            <span style={{ display: 'inline-block', animation: fx ? 'dj-pop2 .45s cubic-bezier(.34,1.56,.64,1) both' : undefined }}>{o.text}</span>
          </span>
        );
      }}
    />
  );
}

export function ExecutionPicker({ value, onChange, itemWidth = 126, fill = false, height = 40 }: { value: DayExecution | null; onChange: (value: DayExecution) => void; itemWidth?: number; fill?: boolean; height?: number }) {
  return (
    <SpringSegmented
      label="Exekuce"
      options={EXECUTION_OPTIONS}
      value={value}
      onChange={onChange}
      itemWidth={itemWidth}
      fill={fill}
      height={height}
      indicatorStyle={id => { const o = EXECUTION_OPTIONS.find(item => item.id === id)!; return { background: o.bg, boxShadow: `0 6px 22px -6px ${o.glow}, inset 0 1px 0 rgba(255,255,255,0.4)` }; }}
      rippleColor={id => EXECUTION_OPTIONS.find(item => item.id === id)!.glow}
      renderItem={(id, on, fx) => {
        const o = EXECUTION_OPTIONS.find(item => item.id === id)!;
        return <span style={{ display: 'inline-block', font: '800 12.5px Inter, sans-serif', color: on ? o.ink : 'var(--dj-text-2)', animation: fx ? 'dj-pop2 .45s cubic-bezier(.34,1.56,.64,1) both' : undefined }}>{o.text}</span>;
      }}
    />
  );
}

/** Přepínač London / New York s dvouřádkovými položkami (název + stav). */
export function SessionSwitch({ value, onChange, status, itemWidth = 140, fill = false }: {
  value: DaySession;
  onChange: (session: DaySession) => void;
  status: Record<DaySession, { text: string; tone: 'done' | 'active' | 'idle' }>;
  itemWidth?: number;
  fill?: boolean;
}) {
  return (
    <SpringSegmented
      label="Session"
      options={[{ id: 'london' as DaySession }, { id: 'ny' as DaySession }]}
      value={value}
      onChange={onChange}
      itemWidth={itemWidth}
      fill={fill}
      gap={3}
      indicatorStyle={id => {
        const tint = SESSION_STYLE[id].tint;
        return { background: `linear-gradient(135deg, ${tint}0.32), ${tint}0.14))`, boxShadow: `0 6px 22px -8px ${tint}0.7), inset 0 0 0 1px ${tint}0.55)` };
      }}
      renderItem={(id, on) => {
        const state = status[id];
        return (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, width: '100%', padding: '0 12px', textAlign: 'left', fontFamily: 'Inter, sans-serif', color: on ? 'var(--dj-text)' : 'var(--dj-text-2)' }}>
            <span style={{ width: 8, height: 8, borderRadius: 9, background: SESSION_STYLE[id].color, flex: 'none' }} />
            <span style={{ minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 12.5, fontWeight: 800, lineHeight: 1.15 }}>{SESSION_STYLE[id].name}</span>
              <span style={{ display: 'block', fontSize: 10.5, fontWeight: 600, lineHeight: 1.2, whiteSpace: 'nowrap', color: state.tone === 'done' ? '#34d399' : state.tone === 'active' ? '#a5b4fc' : 'var(--dj-muted)' }}>{state.text}</span>
            </span>
          </span>
        );
      }}
    />
  );
}

/** Výrazné uložení: lesk v klidu, zelená výplň při ukládání. */
export function BigSaveButton({ ready, saving, label, readyLabel, savingLabel = 'Ukládám…', onClick, height = 58, width, accent = 'indigo', error }: {
  ready: boolean; saving: boolean; label: string; readyLabel: string; savingLabel?: string; onClick: () => void; height?: number; width?: number | string; accent?: 'indigo' | 'orange'; error?: string | null;
}) {
  const gradient = accent === 'orange' ? 'linear-gradient(135deg,#fb923c 0%,#f97316 45%,#ea580c 100%)' : 'linear-gradient(135deg,#818cf8 0%,#6366f1 45%,#4f46e5 100%)';
  const style: React.CSSProperties = saving
    ? { cursor: 'default', color: '#ecfdf5', background: '#064e3b', border: 0 }
    : ready
      ? { cursor: 'pointer', color: '#fff', border: 0, background: gradient, animation: 'dj-glow 2.2s ease-in-out infinite' }
      : { cursor: 'not-allowed', color: 'var(--dj-muted)', background: 'var(--dj-chip)', border: '1px dashed var(--dj-line)' };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width }}>
      <button
        type="button"
        className="dj-btn"
        onClick={() => { if (ready && !saving) onClick(); }}
        aria-disabled={!ready || saving}
        style={{ position: 'relative', overflow: 'hidden', height, width: '100%', borderRadius: 14, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 10, font: '800 16px Inter, sans-serif', letterSpacing: '-0.01em', ...style }}
      >
        {saving && <span aria-hidden="true" style={{ position: 'absolute', left: 0, top: 0, bottom: 0, background: 'linear-gradient(90deg,#10b981,#34d399)', animation: 'dj-fill .7s cubic-bezier(.4,0,.2,1) both' }} />}
        {ready && !saving && <span aria-hidden="true" style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: '34%', background: 'linear-gradient(90deg,transparent,rgba(255,255,255,0.28),transparent)', animation: 'dj-sheen 2.2s ease-in-out infinite' }} />}
        <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 10 }}>
          {ready ? <Check size={20} strokeWidth={2.6} /> : <AlertCircle size={18} />}
          {saving ? savingLabel : ready ? readyLabel : label}
        </span>
      </button>
      {error && <p role="alert" style={{ margin: 0, fontSize: 11.5, color: '#fb7185' }}>{error}</p>}
    </div>
  );
}

const PARTICLE_COLORS = ['#34d399', '#a5b4fc', '#818cf8', '#6ee7b7', '#fbbf24', '#e0e7ff'];

/**
 * Oslava uložení: záblesk rámu, kruh a konfety z místa tlačítka, pak karta
 * s kontrolou. Kreslí se do relativního obalu obrazovky.
 */
export function SaveCelebration({ origin, title, subtitle, rows, children, fresh = true }: {
  /** Odkud vyletí konfety (CSS left/top v obalu). */
  origin: { left: string; top: string };
  title: string;
  subtitle?: React.ReactNode;
  rows?: { label: string; value: string }[];
  children?: React.ReactNode;
  /** Jen při právě dokončeném uložení — otevření hotového stavu bez konfet. */
  fresh?: boolean;
}) {
  const particles = Array.from({ length: 26 }, (_, i) => {
    const angle = (i / 26) * Math.PI * 2 + (i % 3) * 0.2;
    const distance = 120 + ((i * 53) % 140);
    const w = 5 + (i % 4) * 2;
    return {
      key: i,
      style: {
        position: 'absolute', borderRadius: 3, left: origin.left, top: origin.top, width: w, height: i % 2 ? w : 3,
        background: PARTICLE_COLORS[i % PARTICLE_COLORS.length], animation: 'dj-burst 1s cubic-bezier(.15,.8,.3,1) both', animationDelay: `${(i % 5) * 0.02}s`,
        ['--dx' as string]: `${Math.round(Math.cos(angle) * distance)}px`, ['--dy' as string]: `${Math.round(Math.sin(angle) * distance - 60)}px`, ['--rot' as string]: `${(i * 47) % 360}deg`,
      } as React.CSSProperties,
    };
  });
  return (
    <>
      {fresh && (
        <>
          <div aria-hidden="true" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 2000, animation: 'dj-frame 1.1s ease-out both', borderRadius: 'inherit' }} />
          <div aria-hidden="true" style={{ position: 'absolute', inset: 0, zIndex: 2001, pointerEvents: 'none', overflow: 'hidden' }}>
            <span style={{ position: 'absolute', width: 520, height: 520, borderRadius: 999, border: '3px solid rgba(52,211,153,0.7)', left: origin.left, top: origin.top, animation: 'dj-ring .9s ease-out both' }} />
            {particles.map(particle => <span key={particle.key} style={particle.style} />)}
          </div>
        </>
      )}
      <div style={{ position: 'absolute', inset: 0, zIndex: 2002, display: 'grid', placeItems: 'center', padding: 16, background: 'var(--dj-overlay)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)', animation: fresh ? 'dj-rise .35s .25s ease both' : 'dj-fade .2s ease both' }}>
        <div role="dialog" aria-label={title} style={{ width: '100%', maxWidth: 500, borderRadius: 20, border: '1px solid rgba(52,211,153,0.45)', background: 'radial-gradient(90% 60% at 50% 0%, rgba(16,185,129,0.18), transparent 70%), var(--dj-card)', padding: '26px 26px 22px', textAlign: 'center', boxShadow: '0 40px 100px -30px rgba(0,0,0,0.95)', animation: fresh ? 'dj-card .6s .3s cubic-bezier(.2,.9,.3,1.1) both' : undefined }}>
          <svg width="74" height="74" viewBox="0 0 64 64" aria-hidden="true">
            <circle cx="32" cy="32" r="29" fill="rgba(16,185,129,0.14)" stroke="#10b981" strokeWidth="2.5" strokeDasharray="183" strokeDashoffset={fresh ? 183 : 0} style={fresh ? { animation: 'dj-draw .5s .45s ease forwards' } : undefined} />
            <path d="M20 33l8 8 16-17" fill="none" stroke="#34d399" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="40" strokeDashoffset={fresh ? 40 : 0} style={fresh ? { animation: 'dj-draw .35s .85s ease forwards' } : undefined} />
          </svg>
          <h2 style={{ margin: '12px 0 0', fontSize: 23, fontWeight: 800, letterSpacing: '-0.02em' }}>{title}</h2>
          {subtitle && <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--dj-text-2)' }}>{subtitle}</p>}
          {rows && rows.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 18, textAlign: 'left' }}>
              {rows.map((row, i) => (
                <div key={row.label} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderRadius: 11, border: '1px solid var(--dj-line)', background: 'var(--dj-chip)', animation: fresh ? `dj-row .35s ${0.75 + i * 0.1}s ease both` : undefined }}>
                  <span style={{ width: 22, height: 22, borderRadius: 99, display: 'grid', placeItems: 'center', background: '#10b981', flex: 'none', animation: fresh ? `dj-check .35s ${0.75 + i * 0.1}s ease both` : undefined }}><Check size={12} strokeWidth={3.5} color="#052e16" /></span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--dj-muted)', width: 76, flex: 'none' }}>{row.label}</span>
                  <span style={{ fontSize: 13, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.value}</span>
                </div>
              ))}
            </div>
          )}
          {children}
        </div>
      </div>
    </>
  );
}

export function Waveform({ levels, height = 26, color = '#fb7185' }: { levels: readonly number[]; height?: number; color?: string }) {
  return (
    <span aria-hidden="true" style={{ display: 'flex', alignItems: 'center', gap: 3, height }}>
      {levels.map((level, i) => (
        <span key={i} style={{ width: 3, height: '100%', borderRadius: 3, background: color, transform: `scaleY(${Math.max(0.12, Math.min(1, level))})`, transition: 'transform 66ms linear' }} />
      ))}
    </span>
  );
}

/** Kulaté tlačítko diktování: mikrofon / stop / přepisuji. */
export function MicButton({ phase, onStart, onStop, size = 52, label = 'Nadiktovat' }: { phase: DictationPhase; onStart: () => void; onStop: () => void; size?: number; label?: string }) {
  const recording = phase === 'recording';
  const busy = phase === 'transcribing';
  return (
    <button
      type="button"
      className="dj-btn"
      onClick={recording ? onStop : busy ? undefined : onStart}
      aria-label={recording ? 'Zastavit nahrávání' : busy ? 'Přepisuji' : label}
      aria-busy={busy}
      style={{
        width: size, height: size, flex: 'none', borderRadius: 99, border: 0, cursor: busy ? 'progress' : 'pointer', display: 'grid', placeItems: 'center', color: '#fff',
        background: recording ? '#f43f5e' : 'linear-gradient(180deg,#6366f1,#4f46e5)',
        boxShadow: recording ? undefined : 'inset 0 1px 0 rgba(255,255,255,0.28), 0 8px 18px -8px rgba(79,70,229,0.75)',
        animation: recording ? 'dj-rec 1.4s ease-out infinite' : undefined,
      }}
    >
      {busy ? <span style={{ width: size * 0.4, height: size * 0.4, borderRadius: 99, border: '3px solid rgba(255,255,255,0.25)', borderTopColor: '#fff', animation: 'dj-spin .8s linear infinite' }} />
        : recording ? <Square size={size * 0.28} fill="#fff" strokeWidth={0} />
          : <Mic size={size * 0.4} />}
    </button>
  );
}

export const recordingStatus = (phase: DictationPhase, seconds: number, error: string | null) =>
  phase === 'recording' ? { text: `Nahrávám ${formatDictationClock(seconds)} · klepnutím zastavíš`, color: '#fda4af' }
    : phase === 'transcribing' ? { text: 'Přepisuji…', color: '#a5b4fc' }
      : phase === 'error' ? { text: error ?? 'Diktování se nepodařilo.', color: '#fb7185' }
        : null;
