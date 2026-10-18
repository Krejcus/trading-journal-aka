import React from 'react';
import { ArrowLeft } from 'lucide-react';
import type { Trade } from '../../types';
import { DAY_BIAS_LABEL, pragueClock, type DaySession, type DayVerdict } from '../../lib/dayJournal';
import { sessionStage, tradesInScope } from '../../lib/dayJournalView';
import { planChoiceOf, tradeTimeMs } from '../../lib/weeklyReview';
import { tradeRMultiple } from '../../utils/tradeRisk';
import { BigSaveButton, ExecutionPicker, MicButton, SESSION_STYLE, SpringSegmented, Waveform, money, priceText, rText, recordingStatus, tone } from './DayPrimitives';
import { PLAN_OPTIONS, dayTitle } from './DayPanels';
import { prepPins, RequirementChips } from './PrepPanels';
import type { DayController } from './useDayController';

const clock = (ms: number) => pragueClock(ms);
const VERDICTS: { id: DayVerdict; label: string; bg: string; ink: string }[] = [
  { id: 'ok', label: 'Vyšlo', bg: '#34d399', ink: '#052e16' },
  { id: 'bad', label: 'Nevyšlo', bg: '#fb7185', ink: '#4c0519' },
  { id: 'na', label: 'Nenastalo', bg: '#cbd5e1', ink: '#0b1120' },
];

export function closeSessionStatus(ctl: DayController): Record<DaySession, { text: string; tone: 'done' | 'active' | 'idle' }> {
  const out = {} as Record<DaySession, { text: string; tone: 'done' | 'active' | 'idle' }>;
  for (const session of ['london', 'ny'] as const) {
    const close = ctl.journal.closes[session];
    const stage = sessionStage(session, ctl.windows, ctl.isToday ? ctl.now : Infinity);
    out[session] = close && !ctl.closeDraft(session).touched ? { text: `✓ uzavřeno ${clock(Date.parse(close.closedAt))}`, tone: 'done' }
      : stage === 'upcoming' ? { text: `začíná ${clock(ctl.windows[session].start)}`, tone: 'idle' }
        : { text: stage === 'running' ? 'běží' : 'k uzavření', tone: 'active' };
  }
  return out;
}

export function CloseHeaderBar({ ctl, session, onSwitch }: { ctl: DayController; session: DaySession; onSwitch: (session: DaySession) => void }) {
  const prep = ctl.journal.preps[session];
  return (
    <header className="dj" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px 14px', padding: '10px 16px', borderBottom: '1px solid var(--dj-line)', background: 'var(--dj-card)' }}>
      <button type="button" className="dj-btn" onClick={ctl.backToDay} aria-label="Zpět na den" style={{ height: 36, width: 36, borderRadius: 10, display: 'grid', placeItems: 'center', cursor: 'pointer', color: 'var(--dj-text-2)', border: '1px solid var(--dj-line)', background: 'transparent' }}><ArrowLeft size={16} /></button>
      <div style={{ minWidth: 0 }}>
        <p style={{ margin: 0, fontSize: 11, fontWeight: 600, color: 'var(--dj-muted)' }}>{dayTitle(ctl.day)} · {clock(ctl.windows[session].start)}–{clock(ctl.windows[session].end)}</p>
        <h1 style={{ margin: '1px 0 0', fontSize: 19, fontWeight: 800, letterSpacing: '-0.02em' }}>Uzavření {SESSION_STYLE[session].name}</h1>
      </div>
      {prep?.bias && <span style={{ fontSize: 12, color: 'var(--dj-text-2)' }}>Plán: <b style={{ color: prep.bias === 'long' ? 'var(--dj-green)' : prep.bias === 'short' ? 'var(--dj-rose)' : 'var(--dj-text)' }}>{DAY_BIAS_LABEL[prep.bias]}</b> · zapsáno {clock(Date.parse(prep.writtenAt))}</span>}
      {!prep && <span style={{ fontSize: 12, color: 'var(--dj-amber)' }}>K téhle session chybí příprava.</span>}
    </header>
  );
}

/** Nejbližší obchod k bodu plánu (±45 min) — vodítko pro verdikt. */
function nearestTrade(trades: readonly Trade[], time: number | null): Trade | null {
  if (time == null) return null;
  let best: Trade | null = null, distance = Infinity;
  for (const trade of trades) {
    const gap = Math.abs(tradeTimeMs(trade) / 1000 - time);
    if (gap < distance && gap <= 45 * 60) { best = trade; distance = gap; }
  }
  return best;
}

export function CloseSide({ ctl, session, width }: { ctl: DayController; session: DaySession; width?: number }) {
  const trades = tradesInScope(ctl.dayTrades, session, ctl.windows);
  const stats = ctl.sessionStats[session];
  const draft = ctl.closeDraft(session);
  const pins = prepPins(ctl, session);
  const rules = ctl.journal.preps[session]?.rules ?? [];
  const glow = stats.pnl > 0 ? 'rgba(16,185,129,0.22)' : stats.pnl < 0 ? 'rgba(244,63,94,0.22)' : 'rgba(148,163,184,0.12)';
  return (
    <aside className="dj dj-scroll" style={{ width: width ?? '100%', flex: 'none', display: 'flex', flexDirection: 'column', gap: 10, padding: 12, overflowY: width ? 'auto' : 'visible', borderLeft: width ? '1px solid var(--dj-line)' : 0, background: 'var(--dj-bg)', boxSizing: 'border-box' }}>
      <section className="dj-card" style={{ padding: 14, background: `radial-gradient(90% 70% at 8% 0%, ${glow}, transparent 72%), var(--dj-card)` }}>
        <p style={{ margin: 0, fontSize: 11, fontWeight: 600, color: 'var(--dj-muted)' }}>Čistý výsledek · {SESSION_STYLE[session].name}</p>
        <p style={{ margin: '6px 0 0', fontSize: 36, fontWeight: 300, letterSpacing: '-0.04em', lineHeight: 1, color: tone(stats.pnl), transition: 'color .3s ease' }}>{money(stats.pnl)}</p>
        <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--dj-text-2)' }}>{stats.count ? `${stats.count} ${stats.count === 1 ? 'obchod' : stats.count < 5 ? 'obchody' : 'obchodů'} · ${rText(stats.rSum)} · ${stats.wins}W / ${stats.losses}L` : 'Bez obchodů — i to je výsledek.'}</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 12 }}>
          {trades.map((trade, i) => {
            const plan = planChoiceOf(trade);
            const option = plan ? PLAN_OPTIONS.find(item => item.id === plan)! : null;
            const r = tradeRMultiple(trade);
            return (
              <div key={String(trade.id)} style={{ display: 'flex', alignItems: 'center', gap: 7, whiteSpace: 'nowrap', padding: '6px 9px', borderRadius: 8, border: '1px solid var(--dj-line)', background: 'var(--dj-chip)', animation: `dj-rise .35s ${i * 0.05}s ease both` }}>
                <span className="dj-mono" style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--dj-text-2)' }}>{clock(tradeTimeMs(trade))}</span>
                <span style={{ fontSize: 11, fontWeight: 700, color: trade.direction === 'Long' ? '#10b981' : '#f43f5e' }}>{trade.direction === 'Long' ? '↗ L' : '↘ S'}</span>
                {option
                  ? <span style={{ height: 19, padding: '0 6px', display: 'inline-flex', alignItems: 'center', borderRadius: 5, fontSize: 10.5, fontWeight: 700, ...option.style }}>{option.label}</span>
                  : <button type="button" className="dj-btn" onClick={() => ctl.setSelected({ kind: 'trade', id: String(trade.id) })} style={{ height: 19, padding: '0 6px', borderRadius: 5, fontSize: 10.5, fontWeight: 700, cursor: 'pointer', color: '#1c1203', background: '#f59e0b', border: 0 }}>ohodnotit</button>}
                <span style={{ flex: 1 }} />
                <span className="dj-mono" style={{ fontSize: 11, fontWeight: 600, color: r == null ? 'var(--dj-muted)' : tone(r) }}>{rText(r)}</span>
                <span style={{ fontSize: 12, fontWeight: 600, color: tone(trade.pnl), width: 62, textAlign: 'right' }}>{money(trade.pnl)}</span>
              </div>
            );
          })}
        </div>
        {rules.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 10 }}>
            {rules.map(rule => <span key={rule} style={{ height: 22, padding: '0 7px', display: 'inline-flex', alignItems: 'center', borderRadius: 6, fontSize: 11, fontWeight: 600, color: 'var(--dj-rose-soft)', background: 'rgba(244,63,94,0.08)', border: '1px solid rgba(244,63,94,0.25)' }}>{rule}</span>)}
          </div>
        )}
      </section>

      <section style={{ borderRadius: 14, border: '1px solid rgba(129,140,248,0.3)', background: 'var(--dj-indigo-bg-soft)', padding: '12px 14px' }}>
        <p style={{ margin: '0 0 8px', fontSize: 12.5, fontWeight: 700, color: 'var(--dj-indigo-strong)' }}>Plán vs. realita</p>
        {!pins.length && <p style={{ margin: 0, fontSize: 12, color: 'var(--dj-muted)' }}>V přípravě jsi nic nepřipíchl do grafu. Příště tam dej, kde čekáš vstup a kde se mýlíš.</p>}
        {pins.map((pin, i) => {
          const near = nearestTrade(trades, pin.time);
          return (
            <div key={pin.id} style={{ padding: '9px 0', borderTop: '1px solid rgba(129,140,248,0.15)', animation: `dj-rise .35s ${i * 0.06}s ease both` }}>
              <button type="button" onClick={() => ctl.setSelected({ kind: 'note', id: pin.id })} style={{ display: 'block', width: '100%', textAlign: 'left', padding: 0, border: 0, background: 'transparent', cursor: 'pointer', color: 'inherit', fontFamily: 'inherit' }}>
                <span className="dj-mono" style={{ display: 'block', fontSize: 10, fontWeight: 600, color: 'var(--dj-indigo)' }}>zapsáno {clock(Date.parse(pin.writtenAt))}{pin.time != null ? ` → ${clock(pin.time * 1000)}` : ''}{pin.price != null ? ` · ${priceText(pin.price)}` : ''}</span>
                <span style={{ display: 'block', marginTop: 2, fontSize: 12, color: 'var(--dj-indigo-strong)' }}>{pin.text}</span>
              </button>
              <div style={{ marginTop: 7 }}>
                <SpringSegmented
                  label="Verdikt plánu"
                  options={VERDICTS}
                  value={draft.verdicts[pin.id] ?? null}
                  onChange={verdict => ctl.updateCloseDraft(session, current => ({ verdicts: { ...current.verdicts, [pin.id]: verdict } }))}
                  fill
                  gap={3}
                  height={26}
                  indicatorStyle={id => { const v = VERDICTS.find(item => item.id === id)!; return { background: v.bg, borderRadius: 7 }; }}
                  renderItem={(id, on, fx) => { const v = VERDICTS.find(item => item.id === id)!; return <span style={{ display: 'inline-block', font: '700 11px Inter, sans-serif', color: on ? v.ink : 'var(--dj-text-2)', animation: fx ? 'dj-pop2 .4s ease both' : undefined }}>{v.label}</span>; }}
                />
              </div>
              <span style={{ display: 'block', marginTop: 5, fontSize: 11, color: 'var(--dj-muted)' }}>{near ? `Nejbližší obchod ${clock(tradeTimeMs(near))} ${near.direction === 'Long' ? '↗' : '↘'} ${money(near.pnl)}` : 'Kolem tohohle místa žádný obchod.'}</span>
            </div>
          );
        })}
      </section>
    </aside>
  );
}

export function closeRequirements(ctl: DayController, session: DaySession) {
  const draft = ctl.closeDraft(session);
  const items = [{ label: 'Exekuce', ok: Boolean(draft.execution) }, { label: 'Shrnutí', ok: draft.summary.trim().length >= 8 }];
  const missing = items.filter(item => !item.ok).map(item => item.label.toLowerCase());
  return { items, ready: missing.length === 0, missing };
}

export function SummaryBar({ ctl, session, compact = false }: { ctl: DayController; session: DaySession; compact?: boolean }) {
  const draft = ctl.closeDraft(session);
  const { dictation } = ctl;
  const status = recordingStatus(dictation.phase, dictation.seconds, dictation.error);
  const record = async () => {
    const text = await dictation.start();
    if (text) ctl.updateCloseDraft(session, current => ({ summary: current.summary.trim() ? `${current.summary.trim()} ${text}` : text }));
  };
  const recording = dictation.phase === 'recording';
  return (
    <section style={{ display: 'flex', alignItems: 'stretch', gap: 12, padding: '10px 12px 10px 10px', borderRadius: 18, border: `1px solid ${recording ? 'rgba(244,63,94,0.5)' : 'var(--dj-line)'}`, background: 'linear-gradient(180deg, var(--dj-slate-bg), var(--dj-card))', boxShadow: recording ? '0 0 0 3px rgba(244,63,94,0.12)' : 'inset 0 1px 0 rgba(255,255,255,0.05)', transition: 'border-color .3s ease, box-shadow .3s ease' }}>
      <div style={{ alignSelf: 'center' }}><MicButton phase={dictation.phase} onStart={() => void record()} onStop={() => void dictation.stop()} size={compact ? 46 : 52} label="Nadiktovat shrnutí" /></div>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 18 }}>
          <label htmlFor={`close-summary-${session}`} style={{ fontSize: 13, fontWeight: 700 }}>Shrnutí session</label>
          {recording && <Waveform levels={dictation.levels} height={16} />}
          <span style={{ fontSize: 11.5, color: status?.color ?? 'var(--dj-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{status?.text ?? 'Čistý přepis, žádné úpravy. Co šlo, co ne, co příště.'}</span>
        </div>
        <textarea id={`close-summary-${session}`} className="dj-input" rows={compact ? 4 : 2} value={draft.summary} onChange={event => ctl.updateCloseDraft(session, { summary: event.target.value })} placeholder="Co šlo, co ne, co příště. Svými slovy." />
      </div>
    </section>
  );
}

export function CloseBottom({ ctl, session, saving, error, onClose, onOpenDetail, detailOpen = false }: {
  ctl: DayController; session: DaySession; saving: boolean; error: string | null; onClose: () => void;
  /** Deník B+: výsledek a „Plán vs. realita“ v pásu vlevo, detail v panelu nad grafem. */
  onOpenDetail?: () => void;
  detailOpen?: boolean;
}) {
  const draft = ctl.closeDraft(session);
  const req = closeRequirements(ctl, session);
  const saved = ctl.journal.closes[session];
  const stats = ctl.sessionStats[session];
  const pins = prepPins(ctl, session);
  const judged = pins.filter(pin => draft.verdicts[pin.id]).length;
  const unrated = tradesInScope(ctl.dayTrades, session, ctl.windows).filter(trade => !planChoiceOf(trade)).length;
  const summary = onOpenDetail ? (
    <div style={{ width: 210, flex: 'none', display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      <p style={{ margin: 0, fontSize: 9.5, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--dj-muted)' }}>Výsledek · {SESSION_STYLE[session].name}</p>
      <p style={{ margin: 0, fontSize: 24, fontWeight: 300, letterSpacing: '-0.03em', lineHeight: 1.1, color: tone(stats.pnl) }}>{money(stats.pnl)}</p>
      <p style={{ margin: 0, fontSize: 11, color: 'var(--dj-text-2)' }}>{stats.count ? `${stats.count} ${stats.count === 1 ? 'obchod' : stats.count < 5 ? 'obchody' : 'obchodů'} · ${rText(stats.rSum)}${unrated ? ` · ${unrated} k ohodnocení` : ''}` : 'Bez obchodů — i to je výsledek.'}</p>
      <button type="button" className="dj-btn" onClick={onOpenDetail} aria-pressed={detailOpen} style={{ marginTop: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, padding: '6px 9px', borderRadius: 9, cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', font: '600 11px Inter, sans-serif', color: 'var(--dj-indigo-strong)', background: detailOpen ? 'rgba(99,102,241,0.18)' : 'var(--dj-indigo-bg-soft)', border: '1px solid rgba(129,140,248,0.35)' }}>
        <span>Plán vs. realita · {pins.length ? `${judged}/${pins.length} bodů` : 'bez bodů'}</span><span>{detailOpen ? '‹' : '›'}</span>
      </button>
    </div>
  ) : null;
  // Deník B+: jedna řada — výsledek, shrnutí, exekuce + uzavření; graf nad ní má celou výšku.
  if (summary) return (
    <section className="dj" style={{ display: 'flex', alignItems: 'stretch', gap: 14, padding: '10px 12px', borderTop: '1px solid var(--dj-line)', background: 'var(--dj-bg)' }}>
      {summary}
      <div style={{ flex: 1, minWidth: 0 }}><SummaryBar ctl={ctl} session={session} /></div>
      <div style={{ width: 312, flex: 'none', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span title="Jak jsi dodržel plán, ne kolik jsi vydělal." style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--dj-muted)' }}>Exekuce</span>
          <span style={{ flex: 1 }} />
          <RequirementChips items={req.items} />
        </div>
        <ExecutionPicker value={draft.execution} onChange={execution => ctl.updateCloseDraft(session, { execution })} fill height={34} />
        <BigSaveButton width="100%" height={44} accent={session === 'ny' ? 'orange' : 'indigo'} ready={req.ready} saving={saving} error={error}
          label={`Chybí ${req.missing.join(' a ')}`} readyLabel={saved && !draft.touched ? `${SESSION_STYLE[session].name} je uzavřený · znovu` : `Uzavřít ${SESSION_STYLE[session].name}`} savingLabel="Uzavírám…" onClick={onClose} />
      </div>
    </section>
  );
  return (
    <section className="dj" style={{ display: 'flex', gap: 14, padding: 12, borderTop: '1px solid var(--dj-line)', background: 'var(--dj-bg)' }}>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <SummaryBar ctl={ctl} session={session} />
      <footer style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 14 }}>
        <span style={{ fontSize: 12.5, fontWeight: 700 }}>Exekuce</span>
        <ExecutionPicker value={draft.execution} onChange={execution => ctl.updateCloseDraft(session, { execution })} />
        <span style={{ fontSize: 11.5, color: 'var(--dj-muted)', maxWidth: 220 }}>Jak jsi dodržel plán, ne kolik jsi vydělal.</span>
        <span style={{ flex: 1 }} />
        <RequirementChips items={req.items} />
        <BigSaveButton width={300} height={56} accent={session === 'ny' ? 'orange' : 'indigo'} ready={req.ready} saving={saving} error={error}
          label={`Chybí ${req.missing.join(' a ')}`} readyLabel={saved && !draft.touched ? `${SESSION_STYLE[session].name} je uzavřený · znovu` : `Uzavřít ${SESSION_STYLE[session].name}`} savingLabel="Uzavírám…" onClick={onClose} />
      </footer>
      </div>
    </section>
  );
}
