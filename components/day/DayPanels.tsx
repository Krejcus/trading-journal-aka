import React, { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, ExternalLink, History, Mic, PenLine, Plus, RotateCcw, Trash2 } from 'lucide-react';
import type { Trade } from '../../types';
import {
  DAY_BIAS_LABEL, DAY_EXECUTION_LABEL, DAY_SESSIONS, DAY_VERDICT_LABEL, editedAt, pragueClock,
  type DayNote, type DaySession,
} from '../../lib/dayJournal';
import { closeCarry, notesForTrade, prepSummary, sessionStage, type FeedItem } from '../../lib/dayJournalView';
import { planChoiceOf, tradeTimeMs, type PlanChoice } from '../../lib/weeklyReview';
import { tradeRMultiple } from '../../utils/tradeRisk';
import { dayJournalMarkdown } from '../../lib/dayJournalExport';
import { isNativeBuild } from '../../utils/runtimeConfig';
import { PHASE_STYLE, SESSION_STYLE, MicButton, Waveform, money, priceText, rText, recordingStatus, tone } from './DayPrimitives';
import type { DayController } from './useDayController';

const DATE_LABEL = new Intl.DateTimeFormat('cs-CZ', { weekday: 'long', day: 'numeric', month: 'numeric', timeZone: 'UTC' });
export const dayTitle = (day: string) => {
  const text = DATE_LABEL.format(new Date(`${day}T12:00:00Z`));
  return text.charAt(0).toUpperCase() + text.slice(1);
};
const clock = (ms: number) => pragueClock(ms);
const exitMs = (trade: Trade) => (typeof trade.timestamp === 'number' && trade.timestamp > 0 ? trade.timestamp : tradeTimeMs(trade));

export const PLAN_OPTIONS: { id: PlanChoice; label: string; style: React.CSSProperties; on: React.CSSProperties }[] = [
  { id: 'yes', label: 'Podle plánu', style: { color: 'var(--dj-green-text)', background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.3)' }, on: { color: '#052e16', background: '#34d399', border: '1px solid #34d399' } },
  { id: 'partial', label: 'Částečně', style: { color: 'var(--dj-amber-text)', background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)' }, on: { color: '#1c1203', background: '#fbbf24', border: '1px solid #fbbf24' } },
  { id: 'no', label: 'Mimo plán', style: { color: 'var(--dj-rose-text)', background: 'rgba(244,63,94,0.1)', border: '1px solid rgba(244,63,94,0.3)' }, on: { color: '#4c0519', background: '#fb7185', border: '1px solid #fb7185' } },
];
const planLabel = (choice: PlanChoice) => PLAN_OPTIONS.find(option => option.id === choice)!;

const label11: React.CSSProperties = { margin: 0, fontSize: 11, fontWeight: 600, color: 'var(--dj-muted)' };
const sectionTitle: React.CSSProperties = { margin: 0, fontSize: 12.5, fontWeight: 700 };

export function LiveChip({ status, capturedAt }: { status: DayController['chart']['liveStatus']; capturedAt: number | null }) {
  if (!status) return null;
  const live = status === 'live';
  const text = status === 'live' ? `Živě z TradingView${capturedAt ? ` · ${clock(capturedAt)}` : ''}`
    : status === 'loading' ? 'Načítám živé svíčky…'
      : status === 'stale' ? `TradingView stojí${capturedAt ? ` od ${clock(capturedAt)}` : ''}`
        : 'Živé svíčky nejsou — spusť worker s TradingView';
  return (
    <span title="Databento má zpoždění ~24 h; dnešek a včerejší NY jdou z grafu TradingView (jen zobrazení)." style={{ height: 24, padding: '0 8px', display: 'inline-flex', alignItems: 'center', gap: 6, borderRadius: 7, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap', color: live ? 'var(--dj-green-text)' : 'var(--dj-amber-text)', background: live ? 'rgba(16,185,129,0.1)' : 'rgba(245,158,11,0.1)' }}>
      <span style={{ width: 6, height: 6, borderRadius: 9, background: live ? '#10b981' : '#f59e0b', animation: live ? 'dj-blink 2s ease-in-out infinite' : undefined }} />
      {text}
    </span>
  );
}

export function DayNav({ ctl, compact = false }: { ctl: DayController; compact?: boolean }) {
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', border: '1px solid var(--dj-line)', background: 'var(--dj-chip)', borderRadius: 11, padding: 2 }}>
      <button type="button" className="dj-btn" aria-label="Předchozí den" onClick={() => ctl.shiftDay(-1)} style={{ height: 32, width: 32, display: 'grid', placeItems: 'center', border: 0, background: 'transparent', color: 'var(--dj-text-2)', borderRadius: 9, cursor: 'pointer' }}><ChevronLeft size={15} /></button>
      <span style={{ padding: '0 10px', fontSize: compact ? 14 : 15, fontWeight: 800, letterSpacing: '-0.01em', whiteSpace: 'nowrap' }}>{dayTitle(ctl.day)}</span>
      <button type="button" className="dj-btn" aria-label="Další den" disabled={ctl.isToday} onClick={() => ctl.shiftDay(1)} style={{ height: 32, width: 32, display: 'grid', placeItems: 'center', border: 0, background: 'transparent', color: 'var(--dj-text-2)', borderRadius: 9, cursor: ctl.isToday ? 'default' : 'pointer', opacity: ctl.isToday ? 0.3 : 1 }}><ChevronRight size={15} /></button>
      {!ctl.isToday && <button type="button" className="dj-btn" onClick={() => ctl.setDay(ctl.today)} style={{ height: 28, padding: '0 9px', marginRight: 2, borderRadius: 8, border: 0, cursor: 'pointer', fontSize: 11.5, fontWeight: 700, color: 'var(--dj-indigo)', background: 'rgba(99,102,241,0.12)' }}>Dnes</button>}
    </div>
  );
}

/** Export dne jako Markdown: web stáhne soubor, iOS otevře systémové sdílení. */
export async function exportDay(ctl: DayController) {
  const markdown = dayJournalMarkdown(ctl.journal, ctl.dayTrades, ctl.windows);
  if (isNativeBuild) {
    const { shareTextNative } = await import('../../services/nativeShare');
    await shareTextNative({ text: markdown });
    return;
  }
  const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `denik-${ctl.day}.md`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Hlavní výzva dne: chybějící příprava nadcházející session, jinak uzavření. */
export function primaryAction(ctl: DayController): { kind: 'prep' | 'close'; session: DaySession; label: string } | null {
  if (!ctl.isToday) {
    const open = DAY_SESSIONS.find(session => !ctl.journal.closes[session] && ctl.sessionStats[session].count > 0);
    return open ? { kind: 'close', session: open, label: `Uzavřít ${SESSION_STYLE[open].name}` } : null;
  }
  for (const session of DAY_SESSIONS) {
    const stage = sessionStage(session, ctl.windows, ctl.now);
    if (stage === 'upcoming' && !ctl.journal.preps[session]) return { kind: 'prep', session, label: `Připravit ${SESSION_STYLE[session].name}` };
  }
  const toClose = [...DAY_SESSIONS].reverse().find(session => sessionStage(session, ctl.windows, ctl.now) !== 'upcoming' && !ctl.journal.closes[session]);
  if (toClose) return { kind: 'close', session: toClose, label: `Uzavřít ${SESSION_STYLE[toClose].name}` };
  return null;
}

export function ScopeSwitch({ ctl, fill = false }: { ctl: DayController; fill?: boolean }) {
  const scopes: { id: DayController['scope']; label: string }[] = [{ id: 'day', label: 'Celý den' }, { id: 'london', label: 'London' }, { id: 'ny', label: 'New York' }];
  return (
    <div role="group" aria-label="Rozsah grafu" style={{ display: fill ? 'grid' : 'inline-flex', gridTemplateColumns: fill ? 'repeat(3, minmax(0, 1fr))' : undefined, border: '1px solid var(--dj-line)', background: 'var(--dj-chip)', borderRadius: 11, padding: 3, gap: 2 }}>
      {scopes.map(scope => {
        const on = ctl.scope === scope.id;
        return (
          <button key={scope.id} type="button" className="dj-btn" aria-pressed={on} onClick={() => ctl.setScope(scope.id)} style={{ height: 34, padding: '0 12px', borderRadius: 8, border: 0, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7, font: '600 12.5px Inter, sans-serif', background: on ? 'var(--dj-seg-on)' : 'transparent', color: on ? 'var(--dj-seg-on-ink)' : 'var(--dj-text-2)' }}>
            <span style={{ width: 7, height: 7, borderRadius: 9, background: SESSION_STYLE[scope.id].color }} />{scope.label}
          </button>
        );
      })}
    </div>
  );
}

export function DayHeaderBar({ ctl, onDictate, onOpenLegacy }: { ctl: DayController; onDictate: () => void; onOpenLegacy?: () => void }) {
  const action = primaryAction(ctl);
  return (
    <header className="dj" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px 12px', padding: '10px 16px', borderBottom: '1px solid var(--dj-line)', background: 'radial-gradient(40% 180% at 0% 0%, rgba(16,185,129,0.10), transparent 70%), var(--dj-card)' }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--dj-muted)' }}>Deník</span>
      <ChevronRight size={12} color="#475569" />
      <DayNav ctl={ctl} />
      <LiveChip status={ctl.chart.liveStatus} capturedAt={ctl.chart.liveCapturedAt} />
      {ctl.journalStatus === 'error' && <span role="alert" style={{ fontSize: 11.5, color: 'var(--dj-rose)' }}>Deník se nenačetl · <button type="button" onClick={ctl.reload} style={{ border: 0, background: 'none', color: 'var(--dj-rose-text)', textDecoration: 'underline', cursor: 'pointer', padding: 0, font: 'inherit' }}>zkusit znovu</button></span>}
      <span style={{ flex: '1 1 20px' }} />
      <ScopeSwitch ctl={ctl} />
      <button type="button" className="dj-btn" onClick={onDictate} style={{ height: 40, padding: '0 14px 0 12px', borderRadius: 10, border: 0, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 8, color: '#fff', font: '700 13px Inter, sans-serif', background: 'linear-gradient(180deg,#6366f1,#4f46e5)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.28), 0 6px 14px -6px rgba(79,70,229,0.65)' }}>
        <Mic size={16} /> Diktovat
      </button>
      {action && (
        <button type="button" className="dj-btn" onClick={() => (action.kind === 'prep' ? ctl.openPrep(action.session) : ctl.openClose(action.session))} style={{ height: 40, padding: '0 14px', borderRadius: 10, display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer', font: '700 13px Inter, sans-serif', ...(action.kind === 'prep'
          ? { color: 'var(--dj-indigo-text)', border: '1px solid rgba(99,102,241,0.45)', background: 'rgba(99,102,241,0.12)' }
          : { color: 'var(--dj-amber-text)', border: '1px solid rgba(245,158,11,0.45)', background: 'rgba(245,158,11,0.10)' }) }}>
          <span style={{ width: 7, height: 7, borderRadius: 9, background: action.kind === 'prep' ? '#818cf8' : '#f59e0b', animation: 'dj-blink 1.6s ease-in-out infinite' }} />
          {action.label}
        </button>
      )}
      <button type="button" className="dj-btn" onClick={() => { void exportDay(ctl).catch(() => {}); }} title="Exportovat den (Markdown — pro jiné AI nebo archiv)" aria-label="Exportovat den" style={{ height: 40, width: 40, borderRadius: 10, display: 'grid', placeItems: 'center', cursor: 'pointer', color: 'var(--dj-muted)', border: '1px solid var(--dj-line)', background: 'transparent' }}><Download size={16} /></button>
      {onOpenLegacy && <button type="button" className="dj-btn" onClick={onOpenLegacy} title="Původní deník dne (starší přípravy a hodnocení)" style={{ height: 40, width: 40, borderRadius: 10, display: 'grid', placeItems: 'center', cursor: 'pointer', color: 'var(--dj-muted)', border: '1px solid var(--dj-line)', background: 'transparent' }} aria-label="Původní deník dne"><History size={16} /></button>}
    </header>
  );
}

// ── Levý sloupec ───────────────────────────────────────────────────────

export function ResultCard({ ctl, compact = false }: { ctl: DayController; compact?: boolean }) {
  const { stats } = ctl;
  const glow = stats.pnl > 0 ? 'rgba(16,185,129,0.22)' : stats.pnl < 0 ? 'rgba(244,63,94,0.22)' : 'rgba(148,163,184,0.12)';
  const scopeName = ctl.scope === 'day' ? 'celý den' : SESSION_STYLE[ctl.scope].name;
  const tiles = [
    { label: 'Obchody', value: String(stats.count), color: 'var(--dj-text)' },
    { label: 'Win rate', value: stats.winRate == null ? '—' : `${Math.round(stats.winRate * 100)} %`, color: 'var(--dj-text)' },
    { label: 'Součet R', value: stats.count ? rText(stats.rSum) : '—', color: stats.rSum == null ? 'var(--dj-muted)' : tone(stats.rSum) },
    { label: 'Max propad', value: stats.maxDrawdown < 0 ? money(stats.maxDrawdown) : '$0', color: stats.maxDrawdown < 0 ? '#f43f5e' : 'var(--dj-text)' },
    { label: 'Nejlepší', value: stats.best == null ? '—' : money(stats.best), color: stats.best != null && stats.best > 0 ? '#10b981' : 'var(--dj-text)' },
    { label: 'Průměrné držení', value: stats.avgHoldMinutes == null ? '—' : `${Math.round(stats.avgHoldMinutes)} min`, color: 'var(--dj-text)' },
  ];
  return (
    <section className="dj-card" style={{ padding: compact ? '14px 14px 12px' : '18px 16px 14px', background: `radial-gradient(95% 60% at 8% 0%, ${glow}, transparent 72%), radial-gradient(70% 50% at 100% 30%, rgba(6,182,212,0.10), transparent 72%), var(--dj-card-soft)` }}>
      <p style={label11}>Čistý výsledek · {scopeName}</p>
      <p style={{ margin: '8px 0 0', fontSize: compact ? 34 : 40, fontWeight: 300, letterSpacing: '-0.04em', lineHeight: 1, whiteSpace: 'nowrap', color: tone(stats.pnl), textShadow: `0 0 34px ${glow}` }}>{money(stats.pnl)}</p>
      <p style={{ margin: '10px 0 0', fontSize: 12, color: 'var(--dj-text-2)' }}>{stats.count ? `${rText(stats.rSum)} · ${stats.wins}W / ${stats.losses}L` : 'Zatím bez obchodů'}</p>
      {!compact && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 6, marginTop: 14 }}>
          {tiles.map(tile => (
            <div key={tile.label} style={{ borderRadius: 9, border: '1px solid var(--dj-line)', background: 'var(--dj-chip)', padding: '8px 10px' }}>
              <p style={label11}>{tile.label}</p>
              <p style={{ margin: '2px 0 0', fontSize: 13.5, fontWeight: 500, whiteSpace: 'nowrap', color: tile.color }}>{tile.value}</p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function JournalChecklist({ ctl, onOpenCoach }: { ctl: DayController; onOpenCoach?: () => void }) {
  const done = ctl.checklist.filter(item => item.done).length;
  const total = ctl.checklist.length;
  const notes = ctl.journal.notes.length;
  return (
    <section className="dj-card" style={{ padding: '14px 14px 10px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <p style={sectionTitle}>Žurnál dne</p>
        <p style={{ margin: 0, fontSize: 12, fontWeight: 700, color: done === total ? 'var(--dj-green)' : 'var(--dj-amber)' }}>{done}/{total}</p>
      </div>
      <div style={{ height: 5, borderRadius: 9, background: 'var(--dj-line-soft)', margin: '10px 0 8px', overflow: 'hidden' }}>
        <div style={{ height: '100%', borderRadius: 9, transition: 'width .5s cubic-bezier(.22,1,.36,1)', background: 'linear-gradient(90deg,#6366f1,#10b981)', width: `${total ? (done / total) * 100 : 0}%` }} />
      </div>
      {ctl.checklist.map(item => {
        const action = item.action;
        const clickable = !item.done && action && action.kind !== 'rate';
        return (
          <button key={item.id} type="button" disabled={!clickable} onClick={() => { if (action?.kind === 'prep') ctl.openPrep(action.session); else if (action?.kind === 'close') ctl.openClose(action.session); }} style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '7px 0', border: 0, borderTop: '1px solid var(--dj-line-soft)', background: 'transparent', cursor: clickable ? 'pointer' : 'default', textAlign: 'left', fontFamily: 'inherit', color: 'inherit' }}>
            {item.done
              ? <span style={{ width: 18, height: 18, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'rgba(16,185,129,0.16)', color: 'var(--dj-green)', flex: 'none', fontSize: 11, fontWeight: 900 }}>✓</span>
              : <span style={{ width: 18, height: 18, borderRadius: 9, border: '1.5px dashed rgba(245,158,11,0.7)', flex: 'none' }} />}
            <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: item.done ? 'var(--dj-text-2)' : 'var(--dj-amber-text)' }}>{item.label}</span>
            <span style={{ fontSize: 11, color: 'var(--dj-muted)', whiteSpace: 'nowrap' }}>{item.meta}</span>
          </button>
        );
      })}
      {onOpenCoach && (
        <button type="button" className="dj-btn" onClick={onOpenCoach} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, width: '100%', marginTop: 4, padding: '9px 10px', borderRadius: 9, cursor: 'pointer', background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.25)', color: 'var(--dj-indigo-text)', fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit' }}>
          <span>Coach vidí {ctl.dayTrades.length} {ctl.dayTrades.length === 1 ? 'obchod' : ctl.dayTrades.length < 5 && ctl.dayTrades.length > 0 ? 'obchody' : 'obchodů'} · {notes} {notes === 1 ? 'poznámku' : notes < 5 && notes > 0 ? 'poznámky' : 'poznámek'} s časem zápisu</span>
          <ChevronRight size={13} />
        </button>
      )}
    </section>
  );
}

export function DayRules({ ctl }: { ctl: DayController }) {
  const rows = DAY_SESSIONS.flatMap(session => (ctl.journal.preps[session]?.rules ?? []).map(rule => ({ session, rule })));
  return (
    <section className="dj-card" style={{ padding: 14 }}>
      <p style={{ ...sectionTitle, marginBottom: 6 }}>Neobchoduju, pokud…</p>
      {rows.length === 0 && <p style={{ margin: 0, fontSize: 12, color: 'var(--dj-muted)' }}>Pravidla si vybereš v přípravě session.</p>}
      {rows.map(row => (
        <div key={`${row.session}:${row.rule}`} style={{ display: 'flex', gap: 9, alignItems: 'center', padding: '7px 0', borderTop: '1px solid var(--dj-line-soft)' }}>
          <span style={{ width: 8, height: 8, borderRadius: 9, background: SESSION_STYLE[row.session].color, flex: 'none' }} />
          <span style={{ flex: 1, fontSize: 12.5 }}>{row.rule}</span>
          <span style={{ fontSize: 11, color: 'var(--dj-muted)' }}>{SESSION_STYLE[row.session].name}</span>
        </div>
      ))}
    </section>
  );
}

export function StreakStrip({ streak }: { streak: readonly { day: string; state: 'full' | 'part' | 'none' | 'open'; title: string }[] }) {
  return (
    <section className="dj-card" style={{ padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <p style={sectionTitle}>Uzavřené dny</p>
        <p style={{ margin: 0, fontSize: 11, color: 'var(--dj-muted)' }}>posledních {streak.length}</p>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.max(1, streak.length)}, minmax(0, 1fr))`, gap: 4, marginTop: 10 }}>
        {streak.map(item => <span key={item.day} title={`${dayTitle(item.day)} · ${item.title}`} style={{ height: 22, borderRadius: 5, boxSizing: 'border-box', ...streakStyle(item.state) }} />)}
      </div>
      <p style={{ margin: '8px 0 0', fontSize: 11, color: 'var(--dj-muted)' }}>Plný čtverec = obě přípravy a uzavřená každá obchodovaná session.</p>
    </section>
  );
}
export const streakStyle = (state: 'full' | 'part' | 'none' | 'open'): React.CSSProperties =>
  state === 'full' ? { background: '#10b981' } : state === 'part' ? { background: 'rgba(16,185,129,0.35)' }
    : state === 'open' ? { background: 'rgba(245,158,11,0.18)', border: '1.5px dashed rgba(245,158,11,0.8)' } : { background: 'var(--dj-line-soft)' };

export function DayLeftColumn({ ctl, streak, onOpenCoach }: { ctl: DayController; streak: Parameters<typeof StreakStrip>[0]['streak']; onOpenCoach?: () => void }) {
  return (
    <aside className="dj dj-scroll" style={{ width: 280, flex: 'none', display: 'flex', flexDirection: 'column', gap: 12, padding: 12, overflowY: 'auto', borderRight: '1px solid var(--dj-line)', background: 'var(--dj-bg)' }}>
      <ResultCard ctl={ctl} />
      <JournalChecklist ctl={ctl} onOpenCoach={onOpenCoach} />
      <DayRules ctl={ctl} />
      <StreakStrip streak={streak} />
    </aside>
  );
}

// ── Časová osa ─────────────────────────────────────────────────────────

export function TradeRating({ trade, onRate, size = 'md' }: { trade: Trade; onRate: (choice: PlanChoice) => void; size?: 'md' | 'lg' }) {
  const current = planChoiceOf(trade);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 6 }}>
      {PLAN_OPTIONS.map(option => (
        <button key={option.id} type="button" className="dj-btn" aria-pressed={current === option.id} onClick={event => { event.stopPropagation(); onRate(option.id); }} style={{ height: size === 'lg' ? 48 : 34, borderRadius: size === 'lg' ? 12 : 8, cursor: 'pointer', font: `700 ${size === 'lg' ? 13 : 12}px Inter, sans-serif`, ...(current === option.id ? option.on : option.style) }}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

function NoteCard({ ctl, note, phase }: { ctl: DayController; note: DayNote; phase: keyof typeof PHASE_STYLE }) {
  const style = PHASE_STYLE[phase];
  const selected = ctl.selected?.kind === 'note' && ctl.selected.id === note.id;
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (!selected) setEditing(null); }, [selected]);
  const failed = ctl.failedNotes.has(note.id);
  return (
    <div className="dj-feed" style={{ borderRadius: 11, padding: '10px 12px', border: `1px solid ${selected ? style.color : style.soft}`, background: style.bg }}>
      <button type="button" onClick={() => ctl.setSelected(selected ? null : { kind: 'note', id: note.id })} style={{ display: 'block', width: '100%', textAlign: 'left', padding: 0, border: 0, background: 'transparent', cursor: 'pointer', color: 'inherit', fontFamily: 'inherit' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="dj-mono" style={{ fontSize: 10.5, fontWeight: 700, color: style.color }}>{clock(Date.parse(note.writtenAt))}</span>
          <span style={{ width: 18, height: 18, borderRadius: 9, background: style.color, display: 'grid', placeItems: 'center', flex: 'none' }}>{note.voice ? <Mic size={10} strokeWidth={3} color="#1c1203" /> : <PenLine size={10} strokeWidth={3} color="#1c1203" />}</span>
          <span style={{ height: 19, padding: '0 6px', display: 'inline-flex', alignItems: 'center', borderRadius: 5, fontSize: 10.5, fontWeight: 700, color: style.color, background: style.soft }}>{style.label}</span>
          <span style={{ fontSize: 11, color: 'var(--dj-muted)' }}>{note.voice ? 'hlasem' : 'psáno'}</span>
          {editedAt(note.writtenAt, note.updatedAt) && <span style={{ fontSize: 10.5, color: 'var(--dj-muted)' }}>· upraveno {clock(Date.parse(editedAt(note.writtenAt, note.updatedAt)!))}</span>}
          {ctl.pendingNotes.has(note.id) && <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--dj-green)' }}>ukládám…</span>}
        </span>
        {note.time != null && note.price != null && <span className="dj-mono" style={{ display: 'block', marginTop: 4, fontSize: 10.5, color: 'var(--dj-muted)' }}>→ ukazuje na {clock(note.time * 1000)} · {priceText(note.price)}</span>}
        {editing == null && <span style={{ display: 'block', marginTop: 6, fontSize: 12.5, whiteSpace: 'pre-wrap' }}>{note.text}</span>}
      </button>
      {failed && (
        <button type="button" onClick={() => ctl.retryNote(note.id)} style={{ marginTop: 6, display: 'inline-flex', alignItems: 'center', gap: 5, border: 0, background: 'none', padding: 0, cursor: 'pointer', fontSize: 11.5, fontWeight: 700, color: 'var(--dj-rose)', fontFamily: 'inherit' }}><RotateCcw size={12} />Neuloženo — zkusit znovu</button>
      )}
      {selected && editing != null && (
        <div style={{ marginTop: 8 }}>
          <textarea className="dj-input" rows={3} value={editing} onChange={event => setEditing(event.target.value)} aria-label="Upravit poznámku" />
          <div style={{ display: 'flex', gap: 6, marginTop: 6, justifyContent: 'flex-end' }}>
            <button type="button" className="dj-btn" onClick={() => setEditing(null)} style={smallGhost}>Zrušit</button>
            <button type="button" className="dj-btn" onClick={async () => {
              const text = editing.trim(); if (!text) return;
              try { await ctl.updateNote(note.id, { text }); setEditing(null); setError(null); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Nepodařilo se uložit.'); }
            }} style={smallSolid}>Uložit</button>
          </div>
        </div>
      )}
      {selected && editing == null && (
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <button type="button" className="dj-btn" onClick={() => setEditing(note.text)} style={smallGhost}><PenLine size={12} /> Upravit</button>
          <button type="button" className="dj-btn" onClick={async () => {
            try { await ctl.removeNote(note.id); ctl.setSelected(null); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Smazání se nepodařilo.'); }
          }} style={{ ...smallGhost, color: 'var(--dj-rose)' }}><Trash2 size={12} /> Smazat</button>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 10.5, color: 'var(--dj-muted)', alignSelf: 'center' }}>čas zápisu zůstane, úprava se označí</span>
        </div>
      )}
      {error && <p role="alert" style={{ margin: '6px 0 0', fontSize: 11.5, color: 'var(--dj-rose)' }}>{error}</p>}
    </div>
  );
}
const smallGhost: React.CSSProperties = { height: 30, padding: '0 10px', borderRadius: 8, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5, font: '600 12px Inter, sans-serif', color: 'var(--dj-text-2)', background: 'transparent', border: '1px solid var(--dj-line)' };
const smallSolid: React.CSSProperties = { height: 30, padding: '0 12px', borderRadius: 8, cursor: 'pointer', font: '700 12px Inter, sans-serif', color: '#1e1b4b', background: '#a5b4fc', border: 0 };

function TradeCard({ ctl, item }: { ctl: DayController; item: Extract<FeedItem, { kind: 'trade' }> }) {
  const { trade } = item;
  const selected = ctl.selected?.kind === 'trade' && ctl.selected.id === String(trade.id);
  const r = tradeRMultiple(trade);
  const [error, setError] = useState<string | null>(null);
  const note = item.notes[0];
  return (
    <div className="dj-feed" style={{ borderRadius: 11, padding: '10px 12px', border: selected ? '1px solid rgba(226,232,240,0.7)' : item.plan ? '1px solid var(--dj-line)' : '1px solid rgba(245,158,11,0.5)', background: selected ? 'var(--dj-slate-bg)' : 'var(--dj-chip)' }}>
      <button type="button" onClick={() => ctl.setSelected(selected ? null : { kind: 'trade', id: String(trade.id) })} style={{ display: 'block', width: '100%', textAlign: 'left', padding: 0, border: 0, background: 'transparent', cursor: 'pointer', color: 'inherit', fontFamily: 'inherit' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="dj-mono" style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--dj-text-2)' }}>{clock(tradeTimeMs(trade))} → {clock(exitMs(trade))}</span>
          <span style={{ height: 21, padding: '0 7px', display: 'inline-flex', alignItems: 'center', borderRadius: 6, fontSize: 10.5, fontWeight: 700, ...(trade.direction === 'Long' ? { color: '#10b981', background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.25)' } : { color: '#f43f5e', background: 'rgba(244,63,94,0.1)', border: '1px solid rgba(244,63,94,0.25)' }) }}>{trade.direction === 'Long' ? '↗ Long' : '↘ Short'}</span>
          <span style={{ fontSize: 11, color: 'var(--dj-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{trade.symbol || trade.instrument || 'MNQ'}{trade.combinedTradeIds?.length ? ` · ${trade.combinedTradeIds.length} účtů` : ''}</span>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 13, fontWeight: 600, color: tone(trade.pnl) }}>{money(trade.pnl)}</span>
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
          <span className="dj-mono" style={{ fontSize: 11, fontWeight: 600, color: r == null ? 'var(--dj-muted)' : tone(r) }}>{rText(r)}</span>
          {trade.signal && <span style={{ fontSize: 11, color: 'var(--dj-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{trade.signal}</span>}
        </span>
      </button>
      {item.plan ? (
        <span style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 7 }}>
          <span style={{ height: 21, padding: '0 7px', display: 'inline-flex', alignItems: 'center', borderRadius: 6, fontSize: 10.5, fontWeight: 700, ...planLabel(item.plan).style }}>{planLabel(item.plan).label}</span>
          {note && <span style={{ fontSize: 12, color: 'var(--dj-text-2)', flexBasis: '100%', marginTop: 3 }}>„{note.text}“ <span className="dj-mono" style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--dj-amber)', whiteSpace: 'nowrap' }}>zapsáno {clock(Date.parse(note.writtenAt))}</span></span>}
        </span>
      ) : (
        <div style={{ marginTop: 9, paddingTop: 9, borderTop: '1px dashed rgba(245,158,11,0.4)' }}>
          <p style={{ margin: '0 0 7px', fontSize: 11.5, fontWeight: 700, color: 'var(--dj-amber)' }}>Ohodnoť jedním klikem</p>
          <TradeRating trade={trade} onRate={choice => { ctl.rateTrade(trade, choice).then(() => setError(null), reason => setError(reason instanceof Error ? reason.message : 'Hodnocení se neuložilo.')); }} />
        </div>
      )}
      {error && <p role="alert" style={{ margin: '6px 0 0', fontSize: 11.5, color: 'var(--dj-rose)' }}>{error}</p>}
    </div>
  );
}

export function FeedList({ ctl, items }: { ctl: DayController; items: readonly FeedItem[] }) {
  if (!items.length) return <p style={{ margin: '8px 4px', fontSize: 12, color: 'var(--dj-muted)' }}>{ctl.journalStatus === 'loading' ? 'Načítám…' : 'V tomhle rozsahu zatím nic není. Diktuj, co vidíš.'}</p>;
  return (
    <>
      {items.map(item => {
        if (item.kind === 'note') return <NoteCard key={item.key} ctl={ctl} note={item.note} phase={item.phase} />;
        if (item.kind === 'trade') return <TradeCard key={item.key} ctl={ctl} item={item} />;
        if (item.kind === 'prep') return (
          <button key={item.key} type="button" className="dj-btn" onClick={() => ctl.openPrep(item.session)} style={{ display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer', borderRadius: 11, padding: '10px 12px', border: '1px solid rgba(99,102,241,0.3)', background: 'rgba(99,102,241,0.08)', color: 'inherit', fontFamily: 'inherit' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="dj-mono" style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--dj-indigo)' }}>{clock(item.at)}</span>
              <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--dj-indigo-strong)' }}>Příprava {SESSION_STYLE[item.session].name}</span>
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 11, color: 'var(--dj-indigo)' }}>{item.prep.durationSec != null ? `${item.prep.durationSec < 60 ? `${item.prep.durationSec} s` : `${Math.round(item.prep.durationSec / 60)} min`}` : ''}</span>
            </span>
            <span style={{ display: 'block', marginTop: 5, fontSize: 12, color: 'var(--dj-indigo-text)' }}>{prepSummary(item.prep, item.pins)}</span>
          </button>
        );
        return (
          <button key={item.key} type="button" className="dj-btn" onClick={() => ctl.openClose(item.session)} style={{ display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer', borderRadius: 11, padding: '10px 12px', border: '1px solid rgba(59,130,246,0.35)', background: 'var(--dj-blue-bg)', color: 'inherit', fontFamily: 'inherit' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="dj-mono" style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--dj-blue)' }}>{clock(item.at)}</span>
              <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--dj-blue-text)' }}>{SESSION_STYLE[item.session].name} uzavřen</span>
              <span style={{ flex: 1 }} />
              {item.close.execution && <span style={{ fontSize: 11, color: 'var(--dj-blue)' }}>{DAY_EXECUTION_LABEL[item.close.execution]}</span>}
            </span>
            {item.close.summary && <span style={{ display: 'block', marginTop: 5, fontSize: 12, color: 'var(--dj-blue-soft)' }}>„{item.close.summary}“</span>}
          </button>
        );
      })}
    </>
  );
}

// ── Pravý panel ────────────────────────────────────────────────────────

export function NoteComposer({ ctl, point, onDone }: { ctl: DayController; point: { time: number; price: number } | null; onDone: () => void }) {
  const [draft, setDraft] = useState('');
  const [voice, setVoice] = useState(false);
  const { dictation } = ctl;
  const status = recordingStatus(dictation.phase, dictation.seconds, dictation.error);
  const dictate = async () => {
    const text = await dictation.start();
    if (text) { setDraft(current => (current.trim() ? `${current.trim()} ${text}` : text)); setVoice(true); }
  };
  const save = () => {
    if (!draft.trim()) return;
    ctl.createNote(draft, point, voice);
    onDone();
  };
  return (
    <section className="dj" style={{ borderRadius: 14, border: '1px solid rgba(251,191,36,0.45)', background: 'linear-gradient(180deg, var(--dj-amber-bg-soft), var(--dj-card))', padding: 14, animation: 'dj-rise .25s ease both' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: 9, background: '#f59e0b' }} />
        <p style={sectionTitle}>Nová poznámka</p>
        {point && <span className="dj-mono" style={{ fontSize: 11, fontWeight: 600, color: 'var(--dj-amber)' }}>{clock(point.time * 1000)} · {priceText(point.price)}</span>}
        <span style={{ flex: 1 }} />
        <span className="dj-mono" style={{ fontSize: 10.5, color: 'var(--dj-muted)' }}>zapíše se {clock(ctl.now)}</span>
      </div>
      <textarea className="dj-input" autoFocus rows={3} value={draft} onChange={event => setDraft(event.target.value)} placeholder="Co vidíš, co cítíš, co uděláš…" aria-label="Text poznámky" style={{ marginTop: 10 }}
        onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) save(); if (event.key === 'Escape' && !draft.trim()) onDone(); }} />
      {status && <p style={{ margin: '6px 0 0', fontSize: 11.5, color: status.color }}>{status.text}</p>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
        {dictation.phase === 'recording' ? <Waveform levels={dictation.levels.slice(-14)} height={22} /> : null}
        <MicButton phase={dictation.phase} onStart={() => void dictate()} onStop={() => void dictation.stop()} size={36} />
        <span style={{ flex: 1 }} />
        <button type="button" className="dj-btn" onClick={() => { dictation.cancel(); onDone(); }} style={{ ...smallGhost, height: 36 }}>Zrušit</button>
        <button type="button" className="dj-btn" onClick={save} disabled={!draft.trim()} style={{ height: 36, padding: '0 14px', borderRadius: 9, cursor: draft.trim() ? 'pointer' : 'not-allowed', font: '700 12px Inter, sans-serif', color: '#1c1203', background: '#f59e0b', border: 0, opacity: draft.trim() ? 1 : 0.5 }}>Uložit</button>
      </div>
    </section>
  );
}

function TradeTab({ ctl, onOpenTrade }: { ctl: DayController; onOpenTrade?: (trade: Trade) => void }) {
  const trade = ctl.selectedTrade;
  const [error, setError] = useState<string | null>(null);
  if (!trade) return (
    <div style={{ padding: '28px 18px', textAlign: 'center' }}>
      <p style={{ margin: 0, fontSize: 13, fontWeight: 700 }}>Vyber obchod</p>
      <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--dj-muted)' }}>Klikni na obchod v časové ose. Graf na něj zaostří.</p>
    </div>
  );
  const r = tradeRMultiple(trade);
  const notes = notesForTrade(ctl.journal.notes, trade);
  const tiles = [
    { label: 'R', value: rText(r), color: r == null ? 'var(--dj-muted)' : tone(r) },
    { label: 'Držení', value: `${Math.round(Number(trade.durationMinutes) || (exitMs(trade) - tradeTimeMs(trade)) / 60_000)} min`, color: 'var(--dj-text)' },
    { label: 'Vstup', value: trade.entryPrice != null ? priceText(Number(trade.entryPrice)) : '—', color: 'var(--dj-text)' },
    { label: 'Výstup', value: trade.exitPrice != null ? priceText(Number(trade.exitPrice)) : '—', color: 'var(--dj-text)' },
  ];
  const glow = trade.pnl > 0 ? 'rgba(16,185,129,0.18)' : trade.pnl < 0 ? 'rgba(244,63,94,0.18)' : 'transparent';
  return (
    <div style={{ padding: '16px 14px 14px', background: `radial-gradient(95% 40% at 8% 0%, ${glow}, transparent 72%)` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 17, fontWeight: 800 }}>{trade.symbol || trade.instrument || 'MNQ'}</span>
        <span style={{ fontSize: 12, fontWeight: 700, color: trade.direction === 'Long' ? '#10b981' : '#f43f5e' }}>{trade.direction === 'Long' ? '↗ Long' : '↘ Short'}</span>
        <span style={{ fontSize: 12, color: 'var(--dj-text-2)' }}>{clock(tradeTimeMs(trade))} → {clock(exitMs(trade))}</span>
      </div>
      <p style={{ ...label11, marginTop: 12 }}>Čistý výsledek</p>
      <p style={{ margin: '6px 0 0', fontSize: 34, fontWeight: 300, letterSpacing: '-0.04em', lineHeight: 1, color: tone(trade.pnl) }}>{money(trade.pnl)}</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 6, marginTop: 14 }}>
        {tiles.map(tile => (
          <div key={tile.label} style={{ borderRadius: 9, border: '1px solid var(--dj-line)', background: 'var(--dj-chip)', padding: '8px 10px' }}>
            <p style={label11}>{tile.label}</p>
            <p style={{ margin: '2px 0 0', fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap', color: tile.color }}>{tile.value}</p>
          </div>
        ))}
      </div>
      <p style={{ ...label11, margin: '14px 0 7px' }}>Hodnocení</p>
      <TradeRating trade={trade} onRate={choice => { ctl.rateTrade(trade, choice).then(() => setError(null), reason => setError(reason instanceof Error ? reason.message : 'Hodnocení se neuložilo.')); }} />
      {error && <p role="alert" style={{ margin: '6px 0 0', fontSize: 11.5, color: 'var(--dj-rose)' }}>{error}</p>}
      <p style={{ ...label11, margin: '14px 0 7px' }}>Poznámky k obchodu</p>
      {trade.notes?.trim() && <div style={{ borderRadius: 9, border: '1px solid var(--dj-line)', background: 'var(--dj-chip)', padding: '8px 10px', marginBottom: 6, fontSize: 12.5, whiteSpace: 'pre-wrap' }}>{trade.notes}</div>}
      {notes.map(note => (
        <div key={note.id} style={{ borderRadius: 9, border: '1px solid rgba(251,191,36,0.3)', background: 'var(--dj-amber-bg-soft)', padding: '8px 10px', marginBottom: 6 }}>
          <span className="dj-mono" style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--dj-amber)' }}>zapsáno {clock(Date.parse(note.writtenAt))}</span>
          <span style={{ display: 'block', marginTop: 3, fontSize: 12.5 }}>{note.text}</span>
        </div>
      ))}
      {!notes.length && !trade.notes?.trim() && <p style={{ margin: 0, padding: 10, borderRadius: 9, border: '1px dashed var(--dj-line)', fontSize: 12, color: 'var(--dj-muted)' }}>Bez poznámky. Klikni na „+ Poznámka“ a připíchni ji k výstupu.</p>}
      {onOpenTrade && <button type="button" className="dj-btn" onClick={() => onOpenTrade(trade)} style={{ marginTop: 12, width: '100%', height: 38, borderRadius: 9, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, font: '700 12px Inter, sans-serif', color: 'var(--dj-text)', background: 'var(--dj-chip)', border: '1px solid var(--dj-line)' }}><ExternalLink size={13} />Otevřít plný detail obchodu</button>}
    </div>
  );
}

function PlanTab({ ctl }: { ctl: DayController }) {
  return (
    <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
      {DAY_SESSIONS.map(session => {
        const prep = ctl.journal.preps[session];
        const close = ctl.journal.closes[session];
        const pins = ctl.journal.notes.filter(note => note.session === session && note.origin === 'prep');
        return (
          <div key={session} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 8, height: 8, borderRadius: 9, background: SESSION_STYLE[session].color }} />
              <span style={{ fontSize: 13, fontWeight: 700 }}>{SESSION_STYLE[session].name}</span>
              {prep?.bias && <span style={{ height: 22, padding: '0 8px', display: 'inline-flex', alignItems: 'center', borderRadius: 7, fontSize: 11.5, fontWeight: 700, ...(prep.bias === 'long' ? { color: 'var(--dj-green-text)', background: 'rgba(16,185,129,0.12)' } : prep.bias === 'short' ? { color: 'var(--dj-rose-text)', background: 'rgba(244,63,94,0.12)' } : { color: 'var(--dj-text)', background: 'rgba(148,163,184,0.14)' }) }}>{DAY_BIAS_LABEL[prep.bias]}</span>}
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 11, color: 'var(--dj-muted)' }}>{prep ? `zapsáno ${clock(Date.parse(prep.writtenAt))}${editedAt(prep.writtenAt, prep.savedAt) ? ` · upraveno ${clock(Date.parse(prep.savedAt))}` : ''}` : 'bez přípravy'}</span>
            </div>
            {prep?.scenario && <p style={{ margin: 0, fontSize: 12.5, color: 'var(--dj-text-2)', whiteSpace: 'pre-wrap' }}>{prep.scenario}</p>}
            {prep && prep.rules.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {prep.rules.map(rule => <span key={rule} style={{ padding: '4px 8px', borderRadius: 7, fontSize: 11.5, color: 'var(--dj-rose-soft)', background: 'rgba(244,63,94,0.1)', border: '1px solid rgba(244,63,94,0.3)' }}>{rule}</span>)}
              </div>
            )}
            {pins.map(pin => {
              const verdict = close?.verdicts[pin.id];
              return (
                <button key={pin.id} type="button" className="dj-btn" onClick={() => ctl.setSelected({ kind: 'note', id: pin.id })} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px', borderRadius: 9, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--dj-indigo-strong)', background: 'var(--dj-indigo-bg-soft)', border: '1px solid rgba(129,140,248,0.35)' }}>
                  <span className="dj-mono" style={{ display: 'block', fontSize: 10.5, fontWeight: 600, color: 'var(--dj-indigo)' }}>zapsáno {clock(Date.parse(pin.writtenAt))}{pin.time != null ? ` → ${clock(pin.time * 1000)}` : ''}{pin.price != null ? ` · ${priceText(pin.price)}` : ''}</span>
                  <span style={{ display: 'block', marginTop: 3, fontSize: 12.5 }}>{pin.text}</span>
                  {verdict && <span style={{ display: 'block', marginTop: 4, fontSize: 11, fontWeight: 600, color: verdict === 'ok' ? 'var(--dj-green)' : verdict === 'bad' ? 'var(--dj-rose)' : 'var(--dj-muted)' }}>{DAY_VERDICT_LABEL[verdict]}</span>}
                </button>
              );
            })}
            <button type="button" className="dj-btn" onClick={() => ctl.openPrep(session)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 34, borderRadius: 9, cursor: 'pointer', font: '700 12px Inter, sans-serif', color: 'var(--dj-indigo-strong)', background: 'rgba(99,102,241,0.14)', border: '1px solid rgba(99,102,241,0.4)' }}>{prep ? 'Otevřít přípravu' : `Připravit ${SESSION_STYLE[session].name}`}</button>
            {close && closeCarry(close) && <p style={{ margin: 0, fontSize: 11.5, color: 'var(--dj-muted)' }}>Na příště: „{closeCarry(close)}“</p>}
          </div>
        );
      })}
    </div>
  );
}

export function DaySidePanel({ ctl, onOpenTrade, onAddNote, width = 380, compactSummary = false, onOpenCoach }: {
  ctl: DayController;
  onOpenTrade?: (trade: Trade) => void;
  onAddNote: () => void;
  width?: number;
  /** Užší obrazovka bez levého sloupce: výsledek a žurnál nahoře v panelu. */
  compactSummary?: boolean;
  streak?: Parameters<typeof StreakStrip>[0]['streak'];
  onOpenCoach?: () => void;
}) {
  const [tab, setTab] = useState<'feed' | 'trade' | 'plan'>('feed');
  useEffect(() => { if (ctl.selected?.kind === 'trade') setTab('trade'); else if (ctl.selected?.kind === 'note') setTab('feed'); }, [ctl.selected]);
  const unrated = ctl.dayTrades.filter(trade => !planChoiceOf(trade)).length;
  const biasLabel = DAY_SESSIONS.map(session => ctl.journal.preps[session]?.bias).find(Boolean);
  const tabs = [
    { id: 'feed' as const, label: 'Časová osa', badge: String(ctl.feed.length), warn: false },
    { id: 'trade' as const, label: 'Obchod', badge: ctl.dayTrades.length ? (unrated ? `${unrated} k ohodnocení` : `${ctl.dayTrades.length}/${ctl.dayTrades.length}`) : '0', warn: unrated > 0 },
    { id: 'plan' as const, label: 'Plán', badge: biasLabel ? DAY_BIAS_LABEL[biasLabel] : '—', warn: false },
  ];
  return (
    <aside className="dj dj-scroll" style={{ width, flex: 'none', display: 'flex', flexDirection: 'column', gap: 12, padding: 12, overflowY: 'auto', borderLeft: '1px solid var(--dj-line)', background: 'var(--dj-bg)' }}>
      {compactSummary && <ResultCard ctl={ctl} compact />}
      {compactSummary && <JournalChecklist ctl={ctl} onOpenCoach={onOpenCoach} />}
      {ctl.mode === 'day' && ctl.pendingPoint && (
        <NoteComposer ctl={ctl} point={ctl.pendingPoint} onDone={() => ctl.setPendingPoint(null)} />
      )}
      {/* Časová osa vyplní zbytek panelu a roluje uvnitř — nesmí zmizet pod okraj. */}
      <section className="dj-card" style={{ overflow: 'hidden', flex: '1 1 auto', minHeight: 280, display: 'flex', flexDirection: 'column' }}>
        <div role="tablist" aria-label="Panel dne" style={{ display: 'flex', gap: 2, padding: 6, borderBottom: '1px solid var(--dj-line)', flex: 'none' }}>
          {tabs.map(item => (
            <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} className="dj-btn" onClick={() => setTab(item.id)} style={{ flex: 1, height: 34, borderRadius: 8, border: 0, cursor: 'pointer', font: '700 12px Inter, sans-serif', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, background: tab === item.id ? 'var(--dj-tab-on)' : 'transparent', color: tab === item.id ? 'var(--dj-text)' : 'var(--dj-muted)', whiteSpace: 'nowrap' }}>
              {item.label}<span style={{ fontSize: 10.5, fontWeight: 700, padding: '1px 6px', borderRadius: 9, ...(item.warn ? { color: '#1c1203', background: '#f59e0b' } : { color: 'var(--dj-text-2)', background: 'var(--dj-line-soft)' }) }}>{item.badge}</span>
            </button>
          ))}
        </div>
        <div className="dj-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          {tab === 'feed' && (
            <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <button type="button" className="dj-btn" onClick={onAddNote} aria-pressed={ctl.placing === 'note'} style={{ height: 34, borderRadius: 9, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, font: '700 12px Inter, sans-serif', flex: 'none', ...(ctl.placing === 'note' ? { color: '#1c1203', background: '#fbbf24', border: '1px solid #fbbf24' } : { color: 'var(--dj-amber-text)', background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.35)' }) }}>
                <Plus size={14} />{ctl.placing === 'note' ? 'Klikni do grafu…' : 'Poznámka do grafu'}
              </button>
              <FeedList ctl={ctl} items={ctl.feed} />
            </div>
          )}
          {tab === 'trade' && <TradeTab ctl={ctl} onOpenTrade={onOpenTrade} />}
          {tab === 'plan' && <PlanTab ctl={ctl} />}
        </div>
      </section>
    </aside>
  );
}

export function SessionCards({ ctl }: { ctl: DayController }) {
  return (
    <div className="dj" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12, padding: '10px 12px', borderTop: '1px solid var(--dj-line)', background: 'var(--dj-bg)' }}>
      {DAY_SESSIONS.map(session => {
        const stats = ctl.sessionStats[session];
        const close = ctl.journal.closes[session];
        const prep = ctl.journal.preps[session];
        const stage = sessionStage(session, ctl.windows, ctl.isToday ? ctl.now : Infinity);
        const active = ctl.scope === session;
        const color = SESSION_STYLE[session].color;
        const status = close ? { text: 'Uzavřeno', style: { color: 'var(--dj-blue)', background: 'rgba(59,130,246,0.14)' } }
          : stage === 'upcoming' ? { text: prep ? 'Připraveno' : 'Čeká na přípravu', style: { color: 'var(--dj-indigo-text)', background: 'rgba(99,102,241,0.14)' } }
            : stage === 'running' ? { text: 'Běží', style: { color: 'var(--dj-green-text)', background: 'rgba(16,185,129,0.14)' } }
              : { text: 'Neuzavřeno', style: { color: 'var(--dj-amber-text)', background: 'rgba(245,158,11,0.14)' } };
        const quote = close?.summary ? `„${close.summary}“` : stage === 'upcoming' ? (prep ? prepSummary(prep, 0) : 'Připrav bias a scénář před otevřením.') : 'Chybí uzavření · cca 90 s';
        return (
          <div key={session} style={{ display: 'flex', borderRadius: 12, background: 'var(--dj-card-soft)', border: `1px solid ${active ? color : 'var(--dj-line)'}`, boxShadow: active ? `0 0 0 1px ${color}` : undefined, overflow: 'hidden' }}>
            <button type="button" className="dj-btn" onClick={() => ctl.setScope(active ? 'day' : session)} style={{ flex: 1, minWidth: 0, textAlign: 'left', cursor: 'pointer', padding: '10px 14px', border: 0, background: 'transparent', color: 'inherit', fontFamily: 'inherit' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 8, height: 8, borderRadius: 9, background: color }} />
                <span style={{ fontSize: 13, fontWeight: 700 }}>{SESSION_STYLE[session].name}</span>
                <span style={{ fontSize: 11.5, color: 'var(--dj-muted)' }}>{clock(ctl.windows[session].start)}–{clock(ctl.windows[session].end)}</span>
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 7px', borderRadius: 6, ...status.style }}>{status.text}</span>
              </span>
              <span style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 6 }}>
                <span style={{ fontSize: 20, fontWeight: 300, letterSpacing: '-0.03em', color: tone(stats.pnl) }}>{money(stats.pnl)}</span>
                <span style={{ fontSize: 12, color: 'var(--dj-text-2)' }}>{stats.count} {stats.count === 1 ? 'obchod' : stats.count > 1 && stats.count < 5 ? 'obchody' : 'obchodů'} · {rText(stats.rSum)}</span>
              </span>
              <span style={{ display: 'block', marginTop: 4, fontSize: 11.5, color: 'var(--dj-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{quote}</span>
            </button>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 10, borderLeft: '1px solid var(--dj-line)', justifyContent: 'center' }}>
              <button type="button" className="dj-btn" onClick={() => ctl.openPrep(session)} style={{ ...miniAction, color: 'var(--dj-indigo-text)', borderColor: 'rgba(99,102,241,0.4)' }}>{prep ? 'Příprava' : 'Připravit'}</button>
              <button type="button" className="dj-btn" disabled={stage === 'upcoming'} onClick={() => ctl.openClose(session)} style={{ ...miniAction, color: close ? 'var(--dj-blue)' : 'var(--dj-amber-text)', borderColor: close ? 'rgba(59,130,246,0.4)' : 'rgba(245,158,11,0.4)', opacity: stage === 'upcoming' ? 0.4 : 1, cursor: stage === 'upcoming' ? 'default' : 'pointer' }}>{close ? 'Uzavření' : 'Uzavřít'}</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
const miniAction: React.CSSProperties = { height: 30, padding: '0 10px', borderRadius: 8, border: '1px solid', background: 'transparent', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5, font: '700 11.5px Inter, sans-serif', whiteSpace: 'nowrap' };
