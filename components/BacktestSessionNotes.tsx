import React, { useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, X } from 'lucide-react';
import type { BacktestOrderSide, BacktestRuntimeState } from '../services/backtestTypes';
import {
  BACKTEST_BIAS_LABELS,
  BACKTEST_DAY_TYPE_LABELS,
  BACKTEST_ENTRY_LEVELS,
  BACKTEST_ENTRY_REACTION_LABELS,
  BACKTEST_MOVE_REASON_LABELS,
  BACKTEST_SESSION_LABELS,
  BACKTEST_SESSION_SHORT,
  BACKTEST_SKIP_REASONS,
  backtestEntryNote,
  backtestEntryNoteLabel,
  backtestMoveField,
  backtestNoteSessionAt,
  backtestSessionPlan,
  buildBacktestJournal,
  createBacktestNoteId,
  summarizeBacktestNotes,
  unexplainedBacktestMoves,
  type BacktestEntryLevel,
  type BacktestEntryReaction,
  type BacktestJournalRow,
  type BacktestSkipOutcome,
  type BacktestMoveReason,
  type BacktestNote,
  type BacktestNoteBias,
  type BacktestNoteDayType,
  type BacktestNoteSession,
} from '../services/backtestSessionNotes';

export interface BacktestNotesUiState {
  plan: boolean;
  skip: boolean;
  journal: boolean;
  /** Otevřený dotaz na popis vstupu; `late` = doplňuje se zpětně z deníku. */
  entry: { orderId: string; late: boolean } | null;
  move: { eventId: string; late: boolean } | null;
}

export const EMPTY_BACKTEST_NOTES_UI: BacktestNotesUiState = { plan: false, skip: false, journal: false, entry: null, move: null };

export interface BacktestNotesPrefs {
  /** Ptát se na popis při vstupu a posunu SL/TP. */
  ask: boolean;
  /** Zastavit replay, dokud je otevřený dotaz na popis vstupu. */
  pauseOnEntry: boolean;
}

const PREFS_KEY = 'at:backtest:notes:prefs';
export const readBacktestNotesPrefs = (): BacktestNotesPrefs => {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<BacktestNotesPrefs>;
    return { ask: saved.ask !== false, pauseOnEntry: saved.pauseOnEntry !== false };
  } catch { return { ask: true, pauseOnEntry: true }; }
};
export const writeBacktestNotesPrefs = (prefs: BacktestNotesPrefs) => {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* jen pohodlí */ }
};

/** Jak dlouho po posunu čáry se bublina s důvodem sama nabízí. */
const MOVE_PROMPT_MS = 20_000;

const priceText = (value: number | undefined) => value === undefined || !Number.isFinite(value)
  ? '—' : value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const clock = (seconds: number, timeZone: string) => new Date(seconds * 1_000)
  .toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', timeZone });
const dayText = (day: string) => { const [, month, date] = day.split('-'); return `${Number(date)}. ${Number(month)}.`; };
const sideLabel = (side: BacktestOrderSide) => side === 'buy' ? 'Long' : 'Short';

const useTheme = (isDark: boolean) => useMemo(() => ({
  card: `rounded-xl border p-3.5 text-[12px] shadow-2xl ${isDark ? 'border-white/15 bg-[#141926] text-slate-100' : 'border-slate-200 bg-white text-slate-900'}`,
  label: 'mb-1.5 mt-2.5 text-[9.5px] font-bold uppercase tracking-[0.08em] text-slate-500',
  input: `w-full rounded-lg border px-2.5 py-1.5 text-[12.5px] outline-none focus:border-violet-500 ${isDark ? 'border-white/15 bg-black/30 text-white placeholder:text-slate-500' : 'border-slate-200 bg-slate-50 text-slate-900 placeholder:text-slate-400'}`,
  chip: (on: boolean, tone: 'violet' | 'long' | 'short' | 'amber' = 'violet') => `rounded-md border px-2 py-1 text-[11.5px] font-semibold transition-colors ${on
    ? tone === 'long' ? 'border-emerald-500 bg-emerald-500/20 text-emerald-500'
      : tone === 'short' ? 'border-rose-500 bg-rose-500/20 text-rose-500'
        : tone === 'amber' ? 'border-amber-500 bg-amber-500/20 text-amber-500'
          : isDark ? 'border-violet-400 bg-violet-500/25 text-white' : 'border-violet-500 bg-violet-100 text-violet-800'
    : isDark ? 'border-white/15 bg-white/[0.04] text-slate-300 hover:bg-white/10' : 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100'}`,
  primary: 'h-8 rounded-lg bg-violet-600 px-3.5 text-[12px] font-bold text-white hover:bg-violet-500 disabled:opacity-40',
  ghost: `h-8 rounded-lg px-2.5 text-[12px] font-semibold ${isDark ? 'text-slate-400 hover:bg-white/10' : 'text-slate-500 hover:bg-slate-100'}`,
  hint: 'mr-auto text-[10.5px] text-slate-500',
  kbd: `rounded border px-1 font-mono text-[10px] ${isDark ? 'border-white/15 text-slate-400' : 'border-slate-300 text-slate-500'}`,
}), [isDark]);

/** Klávesy v polích popisů nesmí spouštět zkratky grafu ani replaye. */
const trapKeys = (onEscape: () => void, onEnter?: () => void) => (event: React.KeyboardEvent) => {
  event.stopPropagation();
  if (event.key === 'Escape') { event.preventDefault(); onEscape(); }
  if (event.key === 'Enter' && onEnter && !(event.target instanceof HTMLTextAreaElement && event.shiftKey)) {
    event.preventDefault(); onEnter();
  }
};

interface ControlsProps {
  runtime: BacktestRuntimeState;
  isDark: boolean;
  ui: BacktestNotesUiState;
  onUi: (patch: Partial<BacktestNotesUiState>) => void;
}

/** Tři tlačítka ve spodní liště: plán session, nevzatý obchod, deník. */
export const BacktestNotesBarControls: React.FC<ControlsProps> = ({ runtime, isDark, ui, onUi }) => {
  const cursor = runtime.replay.cursorTime;
  const scope = cursor === null ? null : backtestNoteSessionAt(cursor);
  const plan = scope ? backtestSessionPlan(runtime.notes, scope.day, scope.session) : null;
  const summary = useMemo(() => summarizeBacktestNotes(runtime), [runtime]);
  const missing = summary.entries - summary.entriesDescribed + summary.moves - summary.movesExplained;
  const base = `flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2 text-[10.5px] font-bold transition-colors disabled:opacity-40 ${isDark ? 'hover:bg-white/10' : 'hover:bg-slate-100'}`;
  const idle = isDark ? 'border-white/10 text-slate-300' : 'border-slate-200 text-slate-600';
  const active = isDark ? 'border-violet-400 bg-violet-500/20 text-white' : 'border-violet-500 bg-violet-100 text-violet-800';
  return (
    <div className="flex shrink-0 items-center gap-1.5" data-backtest-notes-controls>
      <button
        type="button" disabled={!scope} onClick={() => onUi({ plan: !ui.plan, skip: false })}
        title={plan ? 'Plán session — otevřít nebo změnit' : 'Plán session ještě není nastavený'}
        className={`${base} ${ui.plan ? active : plan ? idle : 'border-dashed border-amber-500/70 text-amber-500'}`}
      >
        {plan && <span className={`h-1.5 w-1.5 rounded-full ${plan.bias === 'long' ? 'bg-emerald-500' : plan.bias === 'short' ? 'bg-rose-500' : 'bg-slate-400'}`} />}
        {scope
          ? plan
            ? `${BACKTEST_SESSION_SHORT[scope.session]} · ${BACKTEST_BIAS_LABELS[plan.bias]} · ${BACKTEST_DAY_TYPE_LABELS[plan.dayType]}`
            : `Plán ${BACKTEST_SESSION_SHORT[scope.session]}`
          : 'Plán session'}
      </button>
      <button
        type="button" disabled={!scope} onClick={() => onUi({ skip: !ui.skip, plan: false })}
        title="Viděl jsem obchod a nevzal ho (klávesa N)" className={`${base} ${ui.skip ? active : idle}`}
      >Nevzal</button>
      <button
        type="button" onClick={() => onUi({ journal: !ui.journal })}
        title="Deník session: plány, vstupy, posuny a nevzaté obchody" className={`${base} ${ui.journal ? active : idle}`}
      >
        <BookOpen size={12} />Deník
        {missing > 0 && <span className="rounded bg-amber-500/20 px-1 text-[9.5px] text-amber-500">{missing}</span>}
      </button>
    </div>
  );
};

interface LayerProps extends ControlsProps {
  timeZone: string;
  /** Poslední odkrytá cena exekučního trhu. */
  price?: number;
  /** Rozpracovaný návrh příkazu v grafu — nevzatý obchod z něj převezme ceny. */
  draft?: { side?: BacktestOrderSide; price: number; stopLoss?: number; takeProfit?: number } | null;
  prefs: BacktestNotesPrefs;
  onPrefs: (prefs: BacktestNotesPrefs) => void;
  /** Kam by vzaté obchody došly s původním SL do konce dne (podle id obchodu). */
  tradeReach?: Readonly<Record<string, BacktestSkipOutcome>>;
  /** Průběžný dopočet nevzatých obchodů, dokud není hotový a uložený v zápisu. */
  skipReach?: Readonly<Record<string, BacktestSkipOutcome>>;
  onAdd: (note: BacktestNote) => void;
  onRemove: (id: string) => void;
}

export const BacktestSessionNotesLayer: React.FC<LayerProps> = props => {
  const { runtime, isDark, ui, onUi, prefs } = props;
  const cursor = runtime.replay.cursorTime;
  const [dismissedMoves, setDismissedMoves] = useState<ReadonlySet<string>>(() => new Set());
  const [, setTick] = useState(0);

  // Bublina po posunu čáry: poslední nevysvětlený posun z posledních vteřin.
  const pendingMove = useMemo(() => {
    if (!prefs.ask) return null;
    const missing = unexplainedBacktestMoves(runtime.orderEvents, runtime.notes);
    return missing.length ? missing[missing.length - 1] : null;
  }, [prefs.ask, runtime.notes, runtime.orderEvents]);
  const autoMoveAge = pendingMove?.recordedAt === undefined ? Infinity : Date.now() - pendingMove.recordedAt;
  const autoMove = pendingMove && !dismissedMoves.has(pendingMove.id) && autoMoveAge < MOVE_PROMPT_MS ? pendingMove : null;
  const [moveEngaged, setMoveEngaged] = useState<string | null>(null);
  useEffect(() => {
    if (!autoMove || moveEngaged === autoMove.id) return;
    const timer = window.setTimeout(() => setTick(value => value + 1), Math.max(250, MOVE_PROMPT_MS - autoMoveAge + 50));
    return () => window.clearTimeout(timer);
  }, [autoMove, autoMoveAge, moveEngaged]);
  const engagedMove = moveEngaged && pendingMove?.id === moveEngaged && !dismissedMoves.has(moveEngaged) ? pendingMove : null;
  const moveTarget = ui.move
    ? { event: (runtime.orderEvents ?? []).find(event => event.id === ui.move?.eventId) ?? null, late: ui.move.late }
    : { event: autoMove ?? engagedMove, late: false };

  // Klávesa N = nevzatý obchod. Mimo psaní do polí a jen s odkrytou cenou.
  const uiRef = useRef(ui); uiRef.current = ui;
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'n' || event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
      if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
      if (cursor === null || uiRef.current.entry || uiRef.current.plan) return;
      event.preventDefault();
      onUi({ skip: true });
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [cursor, onUi]);

  const side = ui.journal ? 'right-[332px]' : 'right-3';
  return (
    <div data-backtest-notes-layer>
      {ui.journal && <JournalPanel {...props} />}
      {ui.plan && cursor !== null && (
        <div className={`fixed bottom-[58px] z-[520] w-[340px] max-w-[calc(100vw-24px)] ${side}`}>
          <PlanCard {...props} cursor={cursor} onClose={() => onUi({ plan: false })} />
        </div>
      )}
      {ui.skip && cursor !== null && (
        <div className={`fixed bottom-[58px] z-[520] w-[360px] max-w-[calc(100vw-24px)] ${side}`}>
          <SkipCard {...props} cursor={cursor} onClose={() => onUi({ skip: false })} />
        </div>
      )}
      {ui.entry && (
        <div className="fixed bottom-[112px] left-1/2 z-[530] w-[640px] max-w-[calc(100vw-24px)] -translate-x-1/2">
          <EntryCard key={ui.entry.orderId} {...props} orderId={ui.entry.orderId} late={ui.entry.late} onClose={() => onUi({ entry: null })} />
        </div>
      )}
      {!ui.entry && moveTarget.event && (
        <div className="fixed bottom-[112px] left-1/2 z-[525] w-[460px] max-w-[calc(100vw-24px)] -translate-x-1/2">
          <MoveCard
            key={moveTarget.event.id} {...props} event={moveTarget.event} late={moveTarget.late}
            onEngage={() => setMoveEngaged(moveTarget.event?.id ?? null)}
            onClose={() => {
              const id = moveTarget.event?.id;
              if (id) setDismissedMoves(current => new Set(current).add(id));
              setMoveEngaged(null);
              if (ui.move) onUi({ move: null });
            }}
          />
        </div>
      )}
    </div>
  );
};

const PlanCard: React.FC<LayerProps & { cursor: number; onClose: () => void }> = ({ runtime, isDark, cursor, onAdd, onClose }) => {
  const theme = useTheme(isDark);
  const scope = backtestNoteSessionAt(cursor);
  const [session, setSession] = useState<BacktestNoteSession>(scope.session);
  const existing = backtestSessionPlan(runtime.notes, scope.day, session);
  const [bias, setBias] = useState<BacktestNoteBias | null>(existing?.bias ?? null);
  const [dayType, setDayType] = useState<BacktestNoteDayType>(existing?.dayType ?? 'unknown');
  const [expectation, setExpectation] = useState(existing?.expectation ?? '');
  const [invalidation, setInvalidation] = useState(existing?.invalidation ?? '');
  const [changeReason, setChangeReason] = useState('');
  // Přepnutí LON/NY načte plán té druhé session.
  const loadedFor = useRef(session);
  if (loadedFor.current !== session) {
    loadedFor.current = session;
    setBias(existing?.bias ?? null); setDayType(existing?.dayType ?? 'unknown');
    setExpectation(existing?.expectation ?? ''); setInvalidation(existing?.invalidation ?? ''); setChangeReason('');
  }
  const flipped = Boolean(existing && bias && existing.bias !== bias);
  const canSave = bias !== null && (!flipped || changeReason.trim().length > 0);
  const save = () => {
    if (!bias || !canSave) return;
    onAdd({
      id: createBacktestNoteId(), kind: 'plan', marketTime: cursor, recordedAt: Date.now(), day: scope.day, session,
      bias, dayType, expectation: expectation.trim(), invalidation: invalidation.trim(),
      ...(existing ? { previousBias: existing.bias, changeReason: changeReason.trim() || undefined } : {}),
    });
    onClose();
  };
  return (
    <section role="dialog" aria-label="Plán session" className={theme.card} onKeyDown={trapKeys(onClose)}>
      <header className="flex items-center gap-2">
        <h3 className="text-[13px] font-bold">{existing ? 'Plán session — změna' : 'Plán session'}</h3>
        <span className="text-[11px] text-slate-500">{dayText(scope.day)}</span>
        <button type="button" aria-label="Zavřít" onClick={onClose} className="ml-auto text-slate-500 hover:text-slate-300"><X size={15} /></button>
      </header>
      {existing && <p className="mt-0.5 text-[11px] text-slate-500">Původně {BACKTEST_BIAS_LABELS[existing.bias]} · {BACKTEST_DAY_TYPE_LABELS[existing.dayType]}. Změna se zapíše s časem.</p>}
      <div className={theme.label}>Session</div>
      <div className="flex gap-1.5">
        {(['london', 'ny'] as const).map(option => (
          <button key={option} type="button" onClick={() => setSession(option)} className={theme.chip(session === option)}>{BACKTEST_SESSION_LABELS[option]}</button>
        ))}
      </div>
      <div className={theme.label}>Bias</div>
      <div className="flex gap-1.5">
        <button type="button" autoFocus onClick={() => setBias('long')} className={theme.chip(bias === 'long', 'long')}>Long</button>
        <button type="button" onClick={() => setBias('short')} className={theme.chip(bias === 'short', 'short')}>Short</button>
        <button type="button" onClick={() => setBias('neutral')} className={theme.chip(bias === 'neutral')}>Neutrál</button>
      </div>
      <div className={theme.label}>Typ dne</div>
      <div className="flex gap-1.5">
        {(['trend', 'range', 'unknown'] as const).map(option => (
          <button key={option} type="button" onClick={() => setDayType(option)} className={theme.chip(dayType === option)}>
            {option === 'range' ? 'Range / choppy' : BACKTEST_DAY_TYPE_LABELS[option]}
          </button>
        ))}
      </div>
      <div className={theme.label}>Co čekám</div>
      <textarea rows={2} value={expectation} onChange={event => setExpectation(event.target.value)} placeholder="Kam by cena měla jít a proč" className={`${theme.input} resize-none`} />
      <div className={theme.label}>Co by můj názor změnilo</div>
      <input value={invalidation} onChange={event => setInvalidation(event.target.value)} placeholder="Např. close pod −2σ" className={theme.input} />
      {flipped && <>
        <div className={`${theme.label} !text-amber-500`}>Proč měním názor</div>
        <input value={changeReason} onChange={event => setChangeReason(event.target.value)} placeholder="Povinné při změně biasu" className={theme.input} />
      </>}
      <div className="mt-3 flex items-center gap-2">
        <span className={theme.hint}>{bias === null ? 'Zvol bias' : flipped && !canSave ? 'Doplň důvod změny' : ''}</span>
        <button type="button" disabled={!canSave} onClick={save} className={theme.primary}>{existing ? 'Uložit změnu' : 'Uložit plán'}</button>
      </div>
    </section>
  );
};

const EntryCard: React.FC<LayerProps & { orderId: string; late: boolean; onClose: () => void }> = ({ runtime, isDark, orderId, late, prefs, onAdd, onClose }) => {
  const theme = useTheme(isDark);
  const order = runtime.orders.find(candidate => candidate.id === orderId);
  const existing = backtestEntryNote(runtime.notes, orderId);
  const [reaction, setReaction] = useState<BacktestEntryReaction | undefined>(existing?.reaction);
  const [level, setLevel] = useState<BacktestEntryLevel | undefined>(existing?.level);
  const [text, setText] = useState(existing?.text ?? '');
  if (!order) return null;
  const price = order.limitPrice ?? order.stopPrice ?? runtime.fills.find(fill => fill.orderId === orderId)?.price;
  const save = () => {
    if (!reaction && !level && !text.trim()) { onClose(); return; }
    onAdd({
      id: existing?.id ?? createBacktestNoteId(), kind: 'entry', marketTime: order.createdAt, recordedAt: Date.now(),
      orderId, side: order.side, price, reaction, level, text: text.trim(), ...(late || existing?.late ? { late: true } : {}),
    });
    onClose();
  };
  const typeLabel = order.type === 'market' ? 'Market' : order.type === 'limit' ? 'Limit' : 'Stop';
  return (
    <section role="dialog" aria-label="Popis vstupu" className={theme.card} onKeyDown={trapKeys(onClose, save)}>
      <header className="flex items-center gap-2">
        <h3 className="text-[13px] font-bold">Proč vstupuju?</h3>
        <span className={`rounded px-1.5 py-0.5 text-[10.5px] font-black ${order.side === 'buy' ? 'bg-emerald-500/15 text-emerald-500' : 'bg-rose-500/15 text-rose-500'}`}>
          {sideLabel(order.side)} {order.quantity} · {typeLabel} @ {priceText(price)}
        </span>
        {late && <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-bold text-amber-500">doplněno zpětně</span>}
        {!late && prefs.pauseOnEntry && <span className="ml-auto text-[10.5px] font-semibold text-amber-500">Replay stojí</span>}
      </header>
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        {(Object.keys(BACKTEST_ENTRY_REACTION_LABELS) as BacktestEntryReaction[]).map(option => (
          <button key={option} type="button" onClick={() => setReaction(current => current === option ? undefined : option)} className={theme.chip(reaction === option)}>{BACKTEST_ENTRY_REACTION_LABELS[option]}</button>
        ))}
        <span className={`mx-1 h-5 w-px ${isDark ? 'bg-white/15' : 'bg-slate-200'}`} />
        {BACKTEST_ENTRY_LEVELS.map(option => (
          <button key={option} type="button" onClick={() => setLevel(current => current === option ? undefined : option)} className={theme.chip(level === option, 'amber')}>{option}</button>
        ))}
      </div>
      <input autoFocus value={text} onChange={event => setText(event.target.value)} placeholder="Nepovinné: co vidím a kam mířím…" className={`${theme.input} mt-2`} />
      <div className="mt-2.5 flex items-center gap-2">
        <span className={theme.hint}><kbd className={theme.kbd}>Enter</kbd> uložit a pokračovat · <kbd className={theme.kbd}>Esc</kbd> přeskočit</span>
        <button type="button" onClick={onClose} className={theme.ghost}>Přeskočit</button>
        <button type="button" onClick={save} className={theme.primary}>Uložit</button>
      </div>
    </section>
  );
};

const MoveCard: React.FC<LayerProps & {
  event: NonNullable<BacktestRuntimeState['orderEvents']>[number]; late: boolean; onEngage: () => void; onClose: () => void;
}> = ({ isDark, event, late, onAdd, onEngage, onClose }) => {
  const theme = useTheme(isDark);
  const [text, setText] = useState('');
  const field = backtestMoveField(event) ?? 'stop';
  const save = (reason: BacktestMoveReason) => {
    onAdd({
      id: createBacktestNoteId(), kind: 'move', marketTime: event.marketTime, recordedAt: Date.now(), eventId: event.id,
      orderId: event.orderId, field, from: event.previousPrice, to: event.price, reason, text: text.trim(), ...(late ? { late: true } : {}),
    });
    onClose();
  };
  return (
    <section role="dialog" aria-label="Důvod posunu" className={theme.card} onKeyDown={trapKeys(onClose, () => save('other'))} onFocus={onEngage} onPointerDown={onEngage}>
      <header className="flex items-center gap-2">
        <h3 className="text-[13px] font-bold">{field === 'stop' ? 'SL posunut' : 'TP posunut'}</h3>
        <span className="font-mono text-[11.5px] text-slate-500">{priceText(event.previousPrice)} → {priceText(event.price)}</span>
        {late && <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-bold text-amber-500">doplněno zpětně</span>}
        <button type="button" aria-label="Zavřít" onClick={onClose} className="ml-auto text-slate-500 hover:text-slate-300"><X size={15} /></button>
      </header>
      <input value={text} onChange={event => setText(event.target.value)} placeholder="Nepovinné: co se změnilo (pak zvol důvod)" className={`${theme.input} mt-2`} />
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {(Object.keys(BACKTEST_MOVE_REASON_LABELS) as BacktestMoveReason[]).map(reason => (
          <button key={reason} type="button" onClick={() => save(reason)} className={theme.chip(false, reason === 'fear' ? 'amber' : 'violet')}>{BACKTEST_MOVE_REASON_LABELS[reason]}</button>
        ))}
      </div>
      {!late && <p className="mt-2 text-[10.5px] text-slate-500">Klik na důvod uloží. Bez odpovědi zmizí samo a posun zůstane v deníku bez důvodu.</p>}
    </section>
  );
};

const numberOrUndefined = (value: string): number | undefined => {
  const parsed = Number(value.replace(',', '.'));
  return value.trim() && Number.isFinite(parsed) ? parsed : undefined;
};

const SkipCard: React.FC<LayerProps & { cursor: number; onClose: () => void }> = ({ isDark, cursor, price, draft, timeZone, onAdd, onClose }) => {
  const theme = useTheme(isDark);
  const [side, setSide] = useState<BacktestOrderSide | null>(() => {
    if (draft?.side) return draft.side;
    if (draft?.stopLoss === undefined) return null;
    return draft.stopLoss < draft.price ? 'buy' : 'sell';
  });
  const [entry, setEntry] = useState(String(draft?.price ?? price ?? ''));
  const [stopLoss, setStopLoss] = useState(draft?.stopLoss === undefined ? '' : String(draft.stopLoss));
  const [takeProfit, setTakeProfit] = useState(draft?.takeProfit === undefined ? '' : String(draft.takeProfit));
  const [reasons, setReasons] = useState<string[]>([]);
  const [text, setText] = useState('');
  const entryPrice = numberOrUndefined(entry);
  const canSave = side !== null && entryPrice !== undefined;
  const save = () => {
    if (!side || entryPrice === undefined) return;
    onAdd({
      id: createBacktestNoteId(), kind: 'skip', marketTime: cursor, recordedAt: Date.now(), side, price: entryPrice,
      stopLoss: numberOrUndefined(stopLoss), takeProfit: numberOrUndefined(takeProfit), reasons, text: text.trim(),
    });
    onClose();
  };
  const field = `${theme.input} font-mono tabular-nums`;
  return (
    <section role="dialog" aria-label="Nevzatý obchod" className={theme.card} onKeyDown={trapKeys(onClose, save)}>
      <header className="flex items-center gap-2">
        <h3 className="text-[13px] font-bold">Viděl jsem, nevzal</h3>
        <span className="font-mono text-[11.5px] text-slate-500">{clock(cursor, timeZone)}</span>
        <button type="button" aria-label="Zavřít" onClick={onClose} className="ml-auto text-slate-500 hover:text-slate-300"><X size={15} /></button>
      </header>
      <div className={theme.label}>Směr</div>
      <div className="flex gap-1.5">
        <button type="button" autoFocus onClick={() => setSide('buy')} className={theme.chip(side === 'buy', 'long')}>Long</button>
        <button type="button" onClick={() => setSide('sell')} className={theme.chip(side === 'sell', 'short')}>Short</button>
      </div>
      <div className="mt-2.5 grid grid-cols-3 gap-2">
        <label><span className={`${theme.label} !mt-0 block`}>Vstup</span><input inputMode="decimal" value={entry} onChange={event => setEntry(event.target.value)} className={field} /></label>
        <label><span className={`${theme.label} !mt-0 block`}>SL</span><input inputMode="decimal" value={stopLoss} onChange={event => setStopLoss(event.target.value)} placeholder="cena" className={field} /></label>
        <label><span className={`${theme.label} !mt-0 block`}>Cíl</span><input inputMode="decimal" value={takeProfit} onChange={event => setTakeProfit(event.target.value)} placeholder="cena" className={field} /></label>
      </div>
      <p className="mt-1 text-[10.5px] text-slate-500">{draft ? 'Směr a ceny převzaté z rozpracované objednávky.' : 'SL a cíl jsou potřeba, aby šlo dopočítat, jak by obchod dopadl.'}</p>
      <div className={theme.label}>Proč ne</div>
      <div className="flex flex-wrap gap-1.5">
        {BACKTEST_SKIP_REASONS.map(reason => (
          <button key={reason} type="button" onClick={() => setReasons(current => current.includes(reason) ? current.filter(item => item !== reason) : [...current, reason])} className={theme.chip(reasons.includes(reason))}>{reason}</button>
        ))}
      </div>
      <input value={text} onChange={event => setText(event.target.value)} placeholder="Nepovinné" className={`${theme.input} mt-2`} />
      <div className="mt-3 flex items-center gap-2">
        <span className={theme.hint}>{side === null ? 'Zvol směr' : <><kbd className={theme.kbd}>Enter</kbd> uloží</>}</span>
        <button type="button" disabled={!canSave} onClick={save} className={theme.primary}>Uložit</button>
      </div>
    </section>
  );
};

const JournalPanel: React.FC<LayerProps> = ({ runtime, isDark, timeZone, prefs, onPrefs, onUi, onRemove, tradeReach, skipReach }) => {
  const rows = useMemo(() => buildBacktestJournal(runtime), [runtime]);
  const summary = useMemo(() => summarizeBacktestNotes(runtime), [runtime]);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => { const list = listRef.current; if (list) list.scrollTop = list.scrollHeight; }, [rows.length]);
  const tag = (text: string, tone = '') => <span key={text} className={`rounded border px-1.5 py-px text-[10px] font-bold ${tone || (isDark ? 'border-white/15 text-slate-400' : 'border-slate-200 text-slate-500')}`}>{text}</span>;
  const long = 'border-emerald-500/40 text-emerald-500';
  const short = 'border-rose-500/40 text-rose-500';
  const amber = 'border-amber-500/50 text-amber-500';
  const quote = (text: string) => text ? <p className={`mt-1 text-[11.5px] italic ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>„{text}“</p> : null;
  const fill = (onClick: () => void) => <button type="button" onClick={onClick} className="mt-1 text-[11.5px] font-semibold text-amber-500 underline-offset-2 hover:underline">Doplnit popis (označí se „zpětně“)</button>;
  const lateTag = (late?: boolean) => late ? tag('zpětně', amber) : null;
  const signedR = (value: number) => `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(1)} R`;
  // „Kam by to došlo“ s původním SL: do zásahu SL nebo do konce obchodního dne.
  const reachLine = (reach: BacktestSkipOutcome | undefined, hypothetical: boolean) => {
    if (!reach) return null;
    const far = reach.top ? `${reach.top.label} (${signedR(reach.top.r)})` : reach.mfeR !== null ? signedR(reach.mfeR) : '—';
    const result = !hypothetical ? '' : reach.result === 'tp' ? `Cíl by padl${reach.tpR ? ` (${signedR(reach.tpR)})` : ''}. `
      : reach.result === 'sl' ? 'Skončil by na SL (−1,0 R). ' : reach.result === 'cutoff' ? 'Do konce dne bez SL i cíle. ' : '';
    return <p className={`mt-1 text-[11px] ${reach.complete ? (isDark ? 'text-slate-300' : 'text-slate-600') : 'text-slate-500'}`}>
      {result}{reach.complete ? 'Do konce dne nejdál' : 'Zatím nejdál'}: <b className="font-semibold">{far}</b>{reach.complete ? '' : ' · počítá se dál'}
    </p>;
  };
  const money = (value: number) => `${value >= 0 ? '+' : '−'}$${Math.abs(value).toFixed(0)}`;

  const body = (row: BacktestJournalRow): React.ReactNode => {
    if (row.type === 'plan') return <>
      <div className="flex flex-wrap items-center gap-1.5 font-semibold">
        {row.note.previousBias && row.note.previousBias !== row.note.bias
          ? <>Změna názoru {tag(`${BACKTEST_BIAS_LABELS[row.note.previousBias]} → ${BACKTEST_BIAS_LABELS[row.note.bias]}`, amber)}</>
          : <>{row.note.previousBias ? 'Plán upraven' : 'Plán session'} {tag(BACKTEST_BIAS_LABELS[row.note.bias], row.note.bias === 'long' ? long : row.note.bias === 'short' ? short : '')}</>}
        {tag(BACKTEST_DAY_TYPE_LABELS[row.note.dayType])}
      </div>
      {quote(row.note.changeReason ?? '')}
      {quote([row.note.expectation, row.note.invalidation && `Změním názor: ${row.note.invalidation}`].filter(Boolean).join(' · '))}
    </>;
    if (row.type === 'skip') return <>
      <div className="flex flex-wrap items-center gap-1.5 font-semibold">
        Nevzal {tag(sideLabel(row.note.side), row.note.side === 'buy' ? long : short)}
        <span className="font-mono text-[11px] font-normal text-slate-500">@ {priceText(row.note.price)}</span>
        <button type="button" aria-label="Smazat nevzatý obchod" title="Smazat" onClick={() => onRemove(row.note.id)} className="ml-auto text-slate-500 hover:text-rose-500"><X size={13} /></button>
      </div>
      <div className="mt-1 flex flex-wrap gap-1">{row.note.reasons.map(reason => tag(reason, amber))}</div>
      {(row.note.stopLoss !== undefined || row.note.takeProfit !== undefined) && <p className="mt-1 font-mono text-[10.5px] text-slate-500">SL {priceText(row.note.stopLoss)} · cíl {priceText(row.note.takeProfit)}</p>}
      {quote(row.note.text)}
      {reachLine(row.note.outcome ?? skipReach?.[row.note.id], true)}
      {row.note.stopLoss === undefined && <p className="mt-1 text-[11px] text-slate-500">Bez SL nejde dopočítat, jak by dopadl.</p>}
    </>;
    if (row.type === 'entry') return <>
      <div className="flex flex-wrap items-center gap-1.5 font-semibold">
        Vstup {tag(`${sideLabel(row.side)} ${row.quantity}`, row.side === 'buy' ? long : short)}
        <span className="font-mono text-[11px] font-normal text-slate-500">@ {priceText(row.price)}</span>
        {row.status === 'cancelled' && tag('zrušeno')}
        {row.status === 'pending' && tag('čeká')}
        {lateTag(row.note?.late)}
      </div>
      {row.note ? <>
        {backtestEntryNoteLabel(row.note) && <div className="mt-1 flex flex-wrap gap-1">{tag(backtestEntryNoteLabel(row.note), isDark ? 'border-violet-400/50 text-violet-300' : 'border-violet-300 text-violet-700')}</div>}
        {quote(row.note.text)}
      </> : fill(() => onUi({ entry: { orderId: row.orderId, late: true } }))}
    </>;
    if (row.type === 'move') return <>
      <div className="flex flex-wrap items-center gap-1.5 font-semibold">
        {row.field === 'stop' ? 'SL' : 'TP'}
        <span className="font-mono text-[11px] font-normal text-slate-500">{priceText(row.event.previousPrice)} → {priceText(row.event.price)}</span>
        {row.note?.reason && tag(BACKTEST_MOVE_REASON_LABELS[row.note.reason], row.note.reason === 'fear' ? amber : '')}
        {lateTag(row.note?.late)}
      </div>
      {row.note ? quote(row.note.text) : fill(() => onUi({ move: { eventId: row.event.id, late: true } }))}
    </>;
    if (row.type === 'exit') {
      const r = row.trade.riskAmount ? row.trade.pnl / row.trade.riskAmount : null;
      const reason = { 'stop-loss': 'SL', 'take-profit': 'TP', 'session-close': 'Konec session', manual: 'Ruční výstup', order: 'Výstup', entry: 'Výstup' }[row.trade.reason];
      return <>
        <div className="flex flex-wrap items-center gap-1.5 font-semibold">
          {reason}
          {tag(`${money(row.trade.pnl)}${r === null ? '' : ` · ${signedR(r)}`}`, row.trade.pnl >= 0 ? long : short)}
        </div>
        {reachLine(tradeReach?.[row.trade.id], false)}
      </>;
    }
    return null;
  };

  return (
    <aside
      aria-label="Deník session" onKeyDown={event => event.stopPropagation()}
      className={`fixed bottom-[46px] right-0 top-[46px] z-[510] flex w-[320px] max-w-[90vw] flex-col border-l text-[12px] shadow-2xl ${isDark ? 'border-white/10 bg-[#10141d] text-slate-100' : 'border-slate-200 bg-white text-slate-900'}`}
    >
      <header className={`flex items-center gap-2 border-b px-3.5 py-2.5 ${isDark ? 'border-white/10' : 'border-slate-200'}`}>
        <h3 className="text-[12.5px] font-bold">Deník session</h3>
        <button type="button" aria-label="Zavřít deník" onClick={() => onUi({ journal: false })} className="ml-auto text-slate-500 hover:text-slate-300"><X size={15} /></button>
      </header>
      <p className={`border-b px-3.5 py-1.5 text-[10.5px] text-slate-500 ${isDark ? 'border-white/10' : 'border-slate-200'}`}>
        Popsáno {summary.entriesDescribed}/{summary.entries} vstupů · {summary.movesExplained}/{summary.moves} posunů · {summary.skips} nevzatých
      </p>
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
        {rows.length === 0 && <p className="px-3.5 py-4 text-slate-500">Zatím prázdný. Začni plánem session.</p>}
        {rows.map(row => row.type === 'header' ? (
          <div key={row.key} className={`sticky top-0 flex items-center gap-2 px-3.5 py-1.5 text-[10px] font-bold uppercase tracking-[0.08em] ${isDark ? 'bg-[#161b27] text-slate-400' : 'bg-slate-100 text-slate-500'}`}>
            {dayText(row.day)} · {BACKTEST_SESSION_LABELS[row.session]}
            {!row.hasPlan && <span className="normal-case tracking-normal text-amber-500">bez plánu</span>}
          </div>
        ) : (
          <div key={row.key} className={`grid grid-cols-[40px_1fr] gap-x-2 border-b px-3.5 py-2 ${isDark ? 'border-white/[0.06]' : 'border-slate-100'}`}>
            <time className="pt-px font-mono text-[10.5px] text-slate-500">{clock(row.time, timeZone)}</time>
            <div className="min-w-0">{body(row)}</div>
          </div>
        ))}
      </div>
      <footer className={`space-y-1 border-t px-3.5 py-2 text-[11px] ${isDark ? 'border-white/10 text-slate-400' : 'border-slate-200 text-slate-500'}`}>
        <label className="flex items-center gap-2"><input type="checkbox" checked={prefs.ask} onChange={event => onPrefs({ ...prefs, ask: event.target.checked })} />Ptát se na popis při vstupu a posunu</label>
        <label className="flex items-center gap-2"><input type="checkbox" disabled={!prefs.ask} checked={prefs.pauseOnEntry} onChange={event => onPrefs({ ...prefs, pauseOnEntry: event.target.checked })} />Při popisu vstupu zastavit replay</label>
      </footer>
    </aside>
  );
};
