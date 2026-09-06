import React, { useId, useState } from 'react';
import {
  MAX_TRADE_NOTE_TEXT_LENGTH, TRADE_NOTE_PHASES, tradeNoteHeads, validateTradeNoteHistory,
  type TradeNoteCaptureContext, type TradeNoteDrafts, type TradeNoteHistory, type TradeNotePhase,
} from '../services/tradeNoteHistory';

export interface TradeNoteHistoryEditorProps {
  baseHistory?: TradeNoteHistory;
  legacyNotes?: string;
  captureContext: TradeNoteCaptureContext;
  drafts: TradeNoteDrafts;
  onChange: (drafts: TradeNoteDrafts) => void;
  disabled?: boolean;
  isDark?: boolean;
}
const labels: Record<TradeNotePhase, string> = { before: 'Před vstupem', during: 'Během obchodu', after: 'Po obchodu' };
const placeholders: Record<TradeNotePhase, string> = {
  before: 'Plán, scénář a důvod vstupu…', during: 'Co se změnilo a jak jsem obchod řídil…', after: 'Co vyšlo, co jsem přehlédl a co chci ověřit příště…',
};
const capturedTime = (time: number) => new Date(time).toLocaleString('cs-CZ');
const marketTime = (time: number | null) => time === null ? 'nezaznamenán' : new Date(time * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

/** Controlled drafts: no save, event generation or prop-driven reset happens here. */
const TradeNoteHistoryEditor: React.FC<TradeNoteHistoryEditorProps> = ({ baseHistory, legacyNotes, captureContext, drafts, onChange, disabled = false, isDark = false }) => {
  const id = useId();
  const [activePhase, setActivePhase] = useState<TradeNotePhase>('after');
  const [visibleRevisionCount, setVisibleRevisionCount] = useState(20);
  let error: string | null = null;
  let history: TradeNoteHistory | undefined;
  try { history = validateTradeNoteHistory(baseHistory); } catch (reason) { error = reason instanceof Error ? reason.message : 'Historii nelze načíst.'; }
  const heads = history ? tradeNoteHeads(history) : {};
  const revisions = [...(history?.revisions ?? [])].reverse();
  const field = isDark ? 'border-slate-700 bg-slate-900 text-slate-100' : 'border-slate-300 bg-white text-slate-900';
  const muted = isDark ? 'text-slate-400' : 'text-slate-600';
  return <section aria-label="Fázované poznámky" className="space-y-3">
    <div>
      <p className="text-sm font-semibold">Poznámky v průběhu obchodu</p>
      <p className={`mt-1 text-xs ${muted}`}>Uložením přibude nová revize. Předchozí znění zůstane v historii.</p>
    </div>
    {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
    {legacyNotes && <details className={`rounded border p-3 ${field}`}>
      <summary className="cursor-pointer text-xs font-medium">Původní poznámka · fáze a čas neznámé</summary>
      <p className={`mt-2 text-xs ${muted}`}>Tento starší text nemá doloženou fázi ani čas zaznamenání.</p>
      <p className="mt-2 whitespace-pre-wrap break-words text-sm">{legacyNotes}</p>
    </details>}
    <div className="flex flex-wrap gap-1" aria-label="Vyber fázi poznámky">
      {TRADE_NOTE_PHASES.map(phase => <button key={phase} type="button" disabled={disabled || Boolean(error)}
        aria-pressed={activePhase === phase} onClick={() => setActivePhase(phase)}
        className={`rounded border px-3 py-1.5 text-xs ${activePhase === phase ? 'border-blue-500 bg-blue-500/10 text-blue-500' : field}`}>
        {labels[phase]}{drafts[phase] ? ' ·' : ''}
      </button>)}
    </div>
    <div>
      <label htmlFor={`${id}-${activePhase}`} className="mb-1 block text-xs font-medium">{labels[activePhase]}</label>
      <textarea id={`${id}-${activePhase}`} disabled={disabled || Boolean(error)} value={drafts[activePhase]}
        onChange={event => onChange({ ...drafts, [activePhase]: event.target.value })} rows={5}
        placeholder={placeholders[activePhase]} className={`w-full resize-y rounded border px-3 py-2 text-sm outline-none focus:border-blue-500 ${field}`} />
      <p className={`mt-1 text-[11px] ${drafts[activePhase].length > MAX_TRADE_NOTE_TEXT_LENGTH ? 'text-red-500' : muted}`}>
        {drafts[activePhase].length.toLocaleString('cs-CZ')} / {MAX_TRADE_NOTE_TEXT_LENGTH.toLocaleString('cs-CZ')} znaků
        {drafts[activePhase].length > MAX_TRADE_NOTE_TEXT_LENGTH ? ' · Před uložením text zkrať. Rozepsaný obsah zůstane zachovaný.' : ''}
      </p>
      {(captureContext.closedTradeReview || activePhase === 'after') && <p className={`mt-1 text-xs ${muted}`}>
        {activePhase === 'after' ? 'Zpětné hodnocení obchodu.' : 'Doplňuješ text k uzavřenému obchodu. Bude označen jako zpětný, i když popisuje plán před vstupem.'}
      </p>}
      {heads[activePhase] && <p className={`mt-1 text-xs ${muted}`}>Poslední uložená revize {heads[activePhase]!.revision} · {heads[activePhase]!.retrospective ? 'zpětná poznámka' : 'poznámka v průběhu replaye'}</p>}
    </div>
    <details className={`rounded border p-3 ${field}`}>
      <summary className="cursor-pointer text-xs font-medium">Historie · {revisions.length} {revisions.length === 1 ? 'revize' : 'revizí'}</summary>
      <p className={`mt-2 text-xs ${muted}`}>Čas zaznamenání pochází ze zařízení. Tržní čas a nejzazší odhalená svíčka jsou uvedené samostatně.</p>
      {revisions.length === 0 ? <p className={`mt-2 text-xs ${muted}`}>Zatím není uložená žádná fázovaná poznámka.</p>
        : <ol className="mt-3 space-y-3">{revisions.slice(0, visibleRevisionCount).map(revision => <li key={revision.id} className="border-t border-slate-500/20 pt-2">
          <p className="text-xs font-semibold">{labels[revision.phase]} · revize {revision.revision}{revision.retrospective ? ' · zpětná' : ''}</p>
          <p className={`mt-1 text-[11px] ${muted}`}>{capturedTime(revision.clientCapturedAt)} · čas zařízení</p>
          <p className={`text-[11px] ${muted}`}>Trh: {marketTime(revision.marketTime)} · odhaleno do: {marketTime(revision.knowledgeHorizonTime)}</p>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm">{revision.operation === 'clear' ? 'Text vyprázdněn touto revizí; předchozí znění zůstává níže.' : revision.text}</p>
        </li>)}</ol>}
      {revisions.length > visibleRevisionCount && <button type="button" className="mt-3 text-xs text-blue-500 underline"
        onClick={() => setVisibleRevisionCount(count => count + 20)}>
        Zobrazit dalších {Math.min(20, revisions.length - visibleRevisionCount)} revizí ({revisions.length - visibleRevisionCount} zbývá)
      </button>}
    </details>
  </section>;
};
export default TradeNoteHistoryEditor;
