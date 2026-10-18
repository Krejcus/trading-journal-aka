import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Brain, Mic, PenLine, Search, X } from 'lucide-react';
import type { Trade } from '../../types';
import { pragueClock, type DayJournal } from '../../lib/dayJournal';
import { MIND_AREAS, MIND_AREA_ICON, MIND_AREA_LABEL, readMindCoachEnabled, writeMindCoachEnabled, type MindArea } from '../../lib/dayMind';
import { mindAreaCounts, mindCorrelations, mindEntries, type MindEntry, type MindTradeSummary } from '../../lib/dayMindInsights';
import { loadDayJournalRange } from '../../services/dayJournalService';
import { money, rText } from './DayPrimitives';
import { dayTitle } from './DayPanels';

/**
 * Přehled Hlava: osobní zápisy (rodina, jídlo, pohyb, spánek, vztahy, práce,
 * trading hlava) napříč dny, každý s tím, co se ten den a do 2 h po něm dělo
 * v tradingu, a souvislosti po oblastech. Jen čtení a navigace; zápis je
 * v deníku dne. Soukromé: nikdy do exportu ani sdílení.
 */

type Range = 7 | 30 | 365;
const RANGES: { id: Range; label: string }[] = [{ id: 7, label: '7 dní' }, { id: 30, label: '30 dní' }, { id: 365, label: 'Vše' }];

const shift = (day: string, delta: number) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
};
const daysBetween = (from: string, to: string) => {
  const out: string[] = [];
  for (let day = from; day <= to && out.length < 400; day = shift(day, 1)) out.push(day);
  return out;
};
const pct = (value: number | null) => (value == null ? '—' : `${Math.round(value * 100)} %`);
const fold = (value: string) => value.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const tradesWord = (count: number) => (count === 1 ? 'obchod' : count > 1 && count < 5 ? 'obchody' : 'obchodů');
const isWeekend = (day: string) => { const weekday = new Date(`${day}T12:00:00Z`).getUTCDay(); return weekday === 0 || weekday === 6; };

function Chip({ tone, children }: { tone: 'ok' | 'bad' | 'muted'; children: React.ReactNode }) {
  const style = tone === 'ok' ? { color: 'var(--dj-green-text)', background: 'rgba(16,185,129,0.1)' }
    : tone === 'bad' ? { color: 'var(--dj-rose-text)', background: 'rgba(244,63,94,0.1)' }
      : { color: 'var(--dj-muted)', background: 'var(--dj-chip)' };
  return <span style={{ height: 20, padding: '0 7px', display: 'inline-flex', alignItems: 'center', borderRadius: 6, fontSize: 10.5, fontWeight: 700, whiteSpace: 'nowrap', ...style }}>{children}</span>;
}

function contextChips(after: MindTradeSummary, day: MindTradeSummary) {
  const chips: React.ReactNode[] = [];
  if (after.count) {
    chips.push(<Chip key="after" tone={after.offPlan ? 'bad' : 'ok'}>do 2 h: {after.count} {tradesWord(after.count)}{after.offPlan ? `, ${after.offPlan}× mimo plán` : after.rated === after.count ? ', vše podle plánu' : ''}</Chip>);
    if (after.rSum != null) chips.push(<Chip key="r" tone={after.rSum < 0 ? 'bad' : 'ok'}>{rText(after.rSum)}</Chip>);
  } else if (day.count) chips.push(<Chip key="none" tone="muted">do 2 h bez obchodu</Chip>);
  else chips.push(<Chip key="free" tone="muted">bez obchodů</Chip>);
  return chips;
}

function EntryCard({ entry, onOpenDay }: { entry: MindEntry; onOpenDay: (day: string) => void }) {
  const { note } = entry;
  return (
    <div style={{ padding: '10px 12px', borderRadius: 12, border: '1px solid rgba(168,85,247,0.22)', background: 'var(--dj-mind-bg)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
        <span className="dj-mono" style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--dj-mind-text)' }}>{pragueClock(Date.parse(note.writtenAt))}</span>
        {note.voice ? <Mic size={11} color="var(--dj-muted)" /> : <PenLine size={11} color="var(--dj-muted)" />}
        {entry.areas.map(area => <span key={area} style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--dj-mind-text)' }}>{MIND_AREA_ICON[area]} {MIND_AREA_LABEL[area].toLowerCase()}</span>)}
        {note.time != null && <span className="dj-mono" style={{ fontSize: 10.5, color: 'var(--dj-muted)' }}>→ v grafu {pragueClock(note.time * 1000)}</span>}
      </div>
      <p style={{ margin: '6px 0 0', fontSize: 13, lineHeight: 1.45, whiteSpace: 'pre-wrap' }}>{note.text}</p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap', marginTop: 8 }}>
        {contextChips(entry.after, entry.dayTrades)}
        <span style={{ flex: 1 }} />
        <button type="button" className="dj-btn" onClick={() => onOpenDay(entry.day)} style={{ border: 0, background: 'none', padding: 0, cursor: 'pointer', font: '700 11px Inter, sans-serif', color: 'var(--dj-indigo-text)' }}>{note.time != null ? 'Ukázat v grafu ›' : 'Otevřít den ›'}</button>
      </div>
    </div>
  );
}

export default function DayMindOverview({ today, trades, liveJournal, onClose, onOpenDay, onAskCoach }: {
  today: string;
  trades: readonly Trade[];
  /** Právě otevřený den deníku, jen když je načtený (čerstvější než rozsah). */
  liveJournal: DayJournal | null;
  onClose: () => void;
  onOpenDay: (day: string) => void;
  onAskCoach?: (prompt: string) => void;
}) {
  const [range, setRange] = useState<Range>(30);
  const [area, setArea] = useState<MindArea | 'all'>('all');
  const [query, setQuery] = useState('');
  const [coachSees, setCoachSees] = useState(readMindCoachEnabled);
  const [journals, setJournals] = useState<DayJournal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const from = shift(today, -(range - 1));

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setJournals(null);
    loadDayJournalRange(from, today)
      .then(result => { if (!cancelled) setJournals(result); })
      .catch(reason => { if (!cancelled) setError(reason instanceof Error ? reason.message : 'Nepodařilo se načíst.'); });
    return () => { cancelled = true; };
  }, [from, today]);

  useEffect(() => {
    // Zachytí Esc dřív než panel deníku pod přehledem (ten by se zavřel taky).
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      // V hledání Esc nejdřív vymaže dotaz, prázdné hledání pak přehled zavře.
      if (event.target instanceof HTMLInputElement && event.target.value) return;
      if (event.target instanceof Element && event.target.closest('textarea')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const merged = useMemo(() => {
    if (!journals) return null;
    const map = new Map(journals.map(journal => [journal.day, journal]));
    if (liveJournal && liveJournal.day >= from && liveJournal.day <= today) map.set(liveJournal.day, liveJournal);
    return [...map.values()];
  }, [from, journals, liveJournal, today]);
  const entries = useMemo(() => (merged ? mindEntries(merged, trades) : []), [merged, trades]);
  const counts = useMemo(() => mindAreaCounts(entries), [entries]);
  const days = useMemo(() => daysBetween(from, today), [from, today]);
  const insights = useMemo(() => mindCorrelations(entries, trades, days), [days, entries, trades]);
  const visible = useMemo(() => {
    const needle = fold(query.trim());
    return entries.filter(entry => (area === 'all' || entry.areas.includes(area)) && (!needle || fold(entry.note.text).includes(needle)));
  }, [area, entries, query]);
  const groups = useMemo(() => {
    const out: { day: string; entries: MindEntry[] }[] = [];
    for (const entry of visible) {
      const last = out[out.length - 1];
      if (last?.day === entry.day) last.entries.push(entry); else out.push({ day: entry.day, entries: [entry] });
    }
    return out;
  }, [visible]);
  const perDay = useMemo(() => {
    const tail = days.slice(-30);
    const byDay = new Map<string, number>();
    for (const entry of entries) byDay.set(entry.day, (byDay.get(entry.day) ?? 0) + 1);
    const max = Math.max(1, ...tail.map(day => byDay.get(day) ?? 0));
    return tail.map(day => ({ day, count: byDay.get(day) ?? 0, max }));
  }, [days, entries]);

  const toggleCoach = () => { const next = !coachSees; writeMindCoachEnabled(next); setCoachSees(next); };
  const askCoach = () => {
    if (!onAskCoach) return;
    const lines = insights.areas.map(item => `${MIND_AREA_LABEL[item.area]}: ${item.notes} zápisů; mimo plán ve dnech se zápisem ${pct(item.offPlanWith)} vs. bez ${pct(item.offPlanWithout)}; do 2 h po zápisu ${pct(item.offPlanAfter)} (${item.ratedAfter} obchodů)${item.daysWith < 3 ? ' — málo dnů, jen náznak' : ''}`);
    onAskCoach([
      `Podívej se na moje zápisy „Hlava“ (osobní — rodina, jídlo, pohyb, spánek, vztahy, práce, hlava v tradingu) za posledních ${range === 365 ? 'víc než 30' : range} dní a hledej souvislosti s tím, jak obchoduju.`,
      lines.length ? `Spočítané souvislosti z deníku:\n${lines.join('\n')}` : '',
      'Řekni mi konkrétně, co se opakuje, a navrhni jedno malé pravidlo nebo zvyk, který mi pomůže. Mluv o mně celém, ne jen o tradingu.',
    ].filter(Boolean).join('\n\n'));
  };

  const loading = journals == null && !error;
  return createPortal(
    <div className="dj" role="dialog" aria-label="Hlava — přehled" onClick={event => { if (event.target === event.currentTarget) onClose(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'grid', placeItems: 'center', padding: 24, background: 'rgba(2,6,23,0.55)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', animation: 'dj-fade .2s ease both' }}>
      <section style={{ width: 'min(1180px, 100%)', height: 'min(820px, 100%)', display: 'grid', gridTemplateRows: 'auto auto 1fr', overflow: 'hidden', borderRadius: 18, border: '1px solid var(--dj-line)', background: 'var(--dj-bg)', boxShadow: '0 40px 100px -30px rgba(0,0,0,0.75)', animation: 'dj-rise .28s cubic-bezier(.2,.9,.25,1) both' }}>
        <header style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: '1px solid var(--dj-line)', background: 'radial-gradient(40% 200% at 0% 0%, rgba(168,85,247,0.16), transparent 70%), var(--dj-card)' }}>
          <span style={{ width: 30, height: 30, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'var(--dj-mind)', flex: 'none' }}><Brain size={16} color="#fff" /></span>
          <div style={{ minWidth: 0 }}>
            <p style={{ margin: 0, fontSize: 15, fontWeight: 800 }}>Hlava</p>
            <p style={{ margin: 0, fontSize: 11, color: 'var(--dj-muted)' }}>Celý život, ne jen trading — každý zápis s tím, co se ten den dělo v obchodování.</p>
          </div>
          <span style={{ flex: 1 }} />
          <div role="radiogroup" aria-label="Období" style={{ display: 'flex', gap: 2, padding: 2, borderRadius: 9, border: '1px solid var(--dj-line)' }}>
            {RANGES.map(item => (
              <button key={item.id} type="button" role="radio" aria-checked={range === item.id} className="dj-btn" onClick={() => setRange(item.id)} style={{ height: 28, padding: '0 11px', borderRadius: 7, border: 0, cursor: 'pointer', font: '700 11.5px Inter, sans-serif', color: range === item.id ? 'var(--dj-mind-text)' : 'var(--dj-muted)', background: range === item.id ? 'var(--dj-mind-bg)' : 'transparent' }}>{item.label}</button>
            ))}
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, height: 32, padding: '0 10px', borderRadius: 9, border: '1px solid var(--dj-line)', background: 'var(--dj-input)', width: 220 }}>
            <Search size={13} color="var(--dj-muted)" />
            <input value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape' && query) { event.preventDefault(); event.nativeEvent.stopImmediatePropagation(); setQuery(''); } }} placeholder="Hledat v zápisech…" aria-label="Hledat v zápisech" style={{ flex: 1, minWidth: 0, border: 0, outline: 0, background: 'transparent', color: 'var(--dj-text)', font: '500 12px Inter, sans-serif' }} />
          </label>
          <button type="button" className="dj-btn" onClick={onClose} aria-label="Zavřít" title="Zavřít (Esc)" style={{ width: 32, height: 32, borderRadius: 9, border: '1px solid var(--dj-line)', background: 'transparent', cursor: 'pointer', display: 'grid', placeItems: 'center', color: 'var(--dj-muted)' }}><X size={15} /></button>
        </header>

        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', padding: '10px 16px', borderBottom: '1px solid var(--dj-line)' }}>
          {[{ id: 'all' as const, label: 'Vše', count: entries.length }, ...MIND_AREAS.filter(item => counts[item]).map(item => ({ id: item, label: `${MIND_AREA_ICON[item]} ${MIND_AREA_LABEL[item].toLowerCase()}`, count: counts[item]! }))].map(item => {
            const on = area === item.id;
            return (
              <button key={item.id} type="button" className="dj-btn" aria-pressed={on} onClick={() => setArea(item.id)} style={{ height: 28, padding: '0 10px', borderRadius: 8, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, font: '700 11.5px Inter, sans-serif', color: on ? 'var(--dj-mind-text)' : 'var(--dj-text-2)', background: on ? 'var(--dj-mind-bg)' : 'transparent', border: `1px solid ${on ? 'rgba(168,85,247,0.4)' : 'var(--dj-line)'}` }}>
                {item.label}<span style={{ fontSize: 10.5, color: 'var(--dj-muted)' }}>{item.count}</span>
              </button>
            );
          })}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 340px', minHeight: 0 }}>
          <div className="dj-scroll" style={{ overflowY: 'auto', padding: '12px 16px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
            {loading && <p style={{ margin: 0, fontSize: 12.5, color: 'var(--dj-muted)' }}>Načítám…</p>}
            {error && <p role="alert" style={{ margin: 0, fontSize: 12.5, color: 'var(--dj-rose)' }}>{error}</p>}
            {!loading && !error && !groups.length && (
              <div style={{ padding: '40px 20px', textAlign: 'center' }}>
                <p style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>{entries.length ? 'Nic neodpovídá filtru' : 'Zatím žádný zápis Hlava'}</p>
                <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--dj-muted)' }}>V deníku dne přepni u poznámky na „Hlava“ a napiš nebo nadiktuj, co se ti honí hlavou — trading, doma, jídlo, pohyb, spánek.</p>
              </div>
            )}
            {groups.map(group => {
              const first = group.entries[0].dayTrades;
              return (
                <div key={group.day} style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                    <span style={{ fontSize: 12.5, fontWeight: 800 }}>{dayTitle(group.day)}</span>
                    <span style={{ fontSize: 11.5, fontWeight: 600, color: first.count ? (first.pnl < 0 ? 'var(--dj-rose)' : 'var(--dj-green)') : 'var(--dj-muted)' }}>
                      {first.count ? `${money(first.pnl)} · ${first.count} ${tradesWord(first.count)}${first.offPlan ? ` · ${first.offPlan}× mimo plán` : ''}` : isWeekend(group.day) ? 'víkend' : 'bez obchodů'}
                    </span>
                  </div>
                  {group.entries.map(entry => <EntryCard key={entry.note.id} entry={entry} onOpenDay={onOpenDay} />)}
                </div>
              );
            })}
          </div>

          <aside className="dj-scroll" style={{ overflowY: 'auto', borderLeft: '1px solid var(--dj-line)', padding: 14, display: 'flex', flexDirection: 'column', gap: 12, background: 'var(--dj-card)' }}>
            <section>
              <p style={asideTitle}>Souvislosti · mimo plán</p>
              {insights.areas.length === 0 && <p style={{ margin: '6px 0 0', fontSize: 11.5, color: 'var(--dj-muted)' }}>Až přibudou zápisy s oblastmi, uvidíš tu, jak se ti obchoduje ve dnech, kdy řešíš rodinu, jídlo, pohyb…</p>}
              {insights.areas.map(item => (
                <div key={item.area} style={{ padding: '7px 0', borderBottom: '1px solid var(--dj-line-soft)' }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                    <span style={{ fontSize: 12, fontWeight: 700 }}>{MIND_AREA_ICON[item.area]} {MIND_AREA_LABEL[item.area]}</span>
                    <span style={{ fontSize: 10.5, color: 'var(--dj-muted)' }}>{item.notes} zápisů</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 3, fontSize: 11.5, color: 'var(--dj-text-2)' }}>
                    <span>den se zápisem / bez</span>
                    <b><span style={{ color: rateColor(item.offPlanWith, item.offPlanWithout) }}>{pct(item.offPlanWith)}</span> / {pct(item.offPlanWithout)}</b>
                  </div>
                  {item.ratedAfter > 0 && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 2, fontSize: 11.5, color: 'var(--dj-text-2)' }}>
                      <span>do 2 h po zápisu</span><b>{pct(item.offPlanAfter)} <span style={{ fontWeight: 500, color: 'var(--dj-muted)' }}>({item.ratedAfter})</span></b>
                    </div>
                  )}
                  {item.daysWith < 3 && <p style={{ margin: '2px 0 0', fontSize: 10.5, color: 'var(--dj-muted)' }}>Málo dnů ({item.daysWith}) — zatím jen náznak.</p>}
                </div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 11.5, color: 'var(--dj-text-2)' }}>
                <span>Obchodní dny bez zápisu Hlava</span><b>{pct(insights.daysWithoutMind)}</b>
              </div>
              <div title="Zápisy Hlava po dnech (posledních 30)" style={{ display: 'grid', gridTemplateColumns: `repeat(${perDay.length}, minmax(0, 1fr))`, alignItems: 'end', gap: 2, height: 34, marginTop: 10 }}>
                {perDay.map(item => <span key={item.day} title={`${dayTitle(item.day)} · ${item.count}`} style={{ height: `${item.count ? Math.max(18, (item.count / item.max) * 100) : 8}%`, borderRadius: 2, background: item.count ? 'var(--dj-mind)' : 'var(--dj-line)' }} />)}
              </div>
            </section>

            <section style={{ padding: 12, borderRadius: 12, border: '1px solid rgba(168,85,247,0.3)', background: 'var(--dj-mind-bg)' }}>
              <p style={{ ...asideTitle, color: 'var(--dj-mind-text)' }}>AI coach</p>
              <p style={{ margin: '6px 0 0', fontSize: 12, lineHeight: 1.45, color: 'var(--dj-text-2)' }}>{coachSees
                ? 'Coach vidí zápisy Hlava jako osobní vrstvu s časem a obchody okolo. Zeptej se ho, co se opakuje.'
                : 'Coach teď zápisy Hlava nevidí. Zapni to níž, jestli chceš, aby hledal souvislosti.'}</p>
              {onAskCoach && <button type="button" className="dj-btn" disabled={!coachSees} onClick={askCoach} style={{ marginTop: 10, height: 32, padding: '0 12px', borderRadius: 9, border: 0, cursor: coachSees ? 'pointer' : 'not-allowed', opacity: coachSees ? 1 : 0.5, font: '700 12px Inter, sans-serif', color: '#fff', background: 'linear-gradient(180deg,#a855f7,#9333ea)' }}>Zeptat se coache</button>}
            </section>

            <section>
              <p style={asideTitle}>Soukromí</p>
              <button type="button" className="dj-btn" role="switch" aria-checked={coachSees} onClick={toggleCoach} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 0', border: 0, background: 'transparent', cursor: 'pointer', color: 'inherit', fontFamily: 'inherit', textAlign: 'left' }}>
                <span style={{ flex: 1, fontSize: 12 }}>Coach vidí zápisy Hlava</span>
                <span aria-hidden="true" style={{ width: 34, height: 20, borderRadius: 99, padding: 2, boxSizing: 'border-box', background: coachSees ? 'var(--dj-mind)' : 'var(--dj-line)', transition: 'background .2s ease', display: 'flex', justifyContent: coachSees ? 'flex-end' : 'flex-start' }}>
                  <span style={{ width: 16, height: 16, borderRadius: 99, background: '#fff' }} />
                </span>
              </button>
              {[['V exportu dne a sdílení', 'nikdy'], ['V grafu obchodu a snímcích', 'nikdy'], ['Tvůj Claude přes MCP', 'vidí, označeno osobní'], ['Kde jsou uložené', 'jen ve tvém účtu']].map(([label, value]) => (
                <div key={label} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '5px 0', fontSize: 12, color: 'var(--dj-text-2)' }}><span>{label}</span><b>{value}</b></div>
              ))}
              <p style={{ margin: '4px 0 0', fontSize: 10.5, color: 'var(--dj-muted)' }}>Volba coache platí v tomto prohlížeči (MCP se jí neřídí). Oblasti pozná appka z textu přímo u tebe; u zápisu je můžeš opravit.</p>
            </section>
          </aside>
        </div>
      </section>
    </div>,
    document.body,
  );
}

const asideTitle: React.CSSProperties = { margin: 0, fontSize: 10, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--dj-muted)' };
const rateColor = (withArea: number | null, without: number | null) => (withArea == null || without == null ? 'inherit' : withArea > without + 0.05 ? 'var(--dj-rose)' : withArea < without - 0.05 ? 'var(--dj-green)' : 'inherit');
