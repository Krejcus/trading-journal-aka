import React, { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { X } from 'lucide-react';
import BacktestWorkspace from './BacktestWorkspace';
import type { BacktestWorkspaceState } from '../services/backtestTypes';
import type { ChartReplaySpeed, ChartReplayState } from '../services/chartReplay';
import {
  addBlindMark, answerBlindCase, blindCasePhase, blindModelChoice, blindModelText, blindReplayStop, blindResultLabel,
  blindReviewProgress, buildBlindScratchRun, nextOpenBlindCase,
  type BlindReviewCase, type BlindReviewChoice, type BlindReviewDoc,
} from '../services/backtestBlindReview';
import { saveBlindReviewProgress } from '../services/backtestBlindReviewStore';

const WORKSPACE_KEY = 'at:blind-review:workspace';
const formatPrice = (value: number | null | undefined) => value == null ? '—'
  : value.toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const formatR = (value: number) => `${value >= 0 ? '+' : '−'}${Math.abs(value).toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} R`;
const formatDay = (day: string) => { const [y, m, d] = day.split('-'); return `${Number(d)}. ${Number(m)}. ${y}`; };
const formatTime = (seconds: number) => new Date(seconds * 1_000).toLocaleTimeString('cs-CZ', { timeZone: 'Europe/Prague', hour: '2-digit', minute: '2-digit' });
const loadWorkspace = (): BacktestWorkspaceState | null => {
  try { return JSON.parse(localStorage.getItem(WORKSPACE_KEY) ?? 'null'); } catch { return null; }
};

interface CursorStore { get: () => number | null; set: (value: number | null) => void; subscribe: (listener: () => void) => () => void }
const createCursorStore = (initial: number | null): CursorStore => {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: next => { if (next !== value) { value = next; listeners.forEach(listener => listener()); } },
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
  };
};

const BTN = 'rounded-lg border border-[var(--border-subtle)] px-3 py-2 text-xs font-bold transition-colors hover:bg-slate-500/10 disabled:opacity-40 disabled:hover:bg-transparent';
const PRIMARY = 'rounded-lg bg-violet-600 px-3 py-2 text-xs font-black text-white transition-colors hover:bg-violet-500 disabled:opacity-40 disabled:hover:bg-violet-600';
const FIELD = 'min-h-24 w-full resize-y rounded-lg border border-[var(--border-subtle)] bg-transparent p-2 text-xs leading-relaxed outline-none focus:border-violet-500';
const BOX = 'rounded-lg border border-[var(--border-subtle)] p-3 text-xs leading-relaxed';

const Choice: React.FC<{ value: BlindReviewChoice; picked: BlindReviewChoice | null; onPick: (value: BlindReviewChoice) => void }> = ({ value, picked, onPick }) => (
  <button aria-pressed={picked === value} onClick={() => onPick(value)} className={`${BTN} ${picked === value ? 'border-violet-500 bg-violet-500/20' : ''}`}>{value}</button>
);

const Reveal: React.FC<{ item: BlindReviewCase; doc: BlindReviewDoc; cursor: number | null; onNext: () => void; hasNext: boolean }> = ({ item, doc, cursor, onNext, hasNext }) => {
  const answer = doc.answers[item.id];
  const model = item.model;
  const modelChoice = blindModelChoice(item);
  const finished = model?.endMs != null && cursor !== null && cursor * 1_000 >= model.endMs;
  return <>
    <h3 className="text-sm font-bold">{formatDay(item.day)}</h3>
    <div className={BOX}>
      <p className="font-semibold text-slate-500">Tvoje odpověď</p>
      <p><b>{answer.answer}</b>{answer.answer !== 'Nevím' && <span className={answer.answer === modelChoice ? 'text-emerald-500' : 'text-rose-400'}> · {answer.answer === modelChoice ? 'shoda s modelem' : 'neshoda s modelem'}</span>}</p>
      {answer.text && <p className="mt-1 whitespace-pre-wrap">{answer.text}</p>}
    </div>
    <div className={BOX}>
      <p className="font-semibold text-slate-500">Model</p>
      <p>{blindModelText(item)}</p>
      {model?.entry != null && <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-[11px]">
        <dt className="text-slate-500">Vstup</dt><dd className="text-right">{formatPrice(model.entry)}</dd>
        <dt className="text-slate-500">SL</dt><dd className="text-right">{formatPrice(model.sl)}{model.risk != null ? ` (${formatPrice(model.risk)} b)` : ''}</dd>
        {model.tp != null && <><dt className="text-slate-500">TP</dt><dd className="text-right">{model.tpName} {formatPrice(model.tp)}</dd></>}
        {model.fillMs != null && <><dt className="text-slate-500">Výsledek</dt><dd className="text-right">{finished && model.r != null ? `${blindResultLabel(model)} ${formatR(model.r)}` : 'pusť replay dál'}</dd></>}
        {finished && model.net != null && <><dt className="text-slate-500">Po poplatcích</dt><dd className="text-right">{formatR(model.net)}</dd></>}
      </dl>}
    </div>
    <div className={BOX}>
      <p className="font-semibold text-slate-500">Claude hlasoval naslepo</p>
      <p><b>{item.vote.answer}</b></p>
      <p className="mt-1">{item.vote.why}</p>
    </div>
    <button onClick={onNext} className={PRIMARY}>{hasNext ? 'Další případ' : 'Dokončit sadu'}</button>
  </>;
};

const Panel: React.FC<{
  doc: BlindReviewDoc;
  item: BlindReviewCase;
  cursorStore: CursorStore;
  manualOpen: boolean;
  onManualOpen: (time: number | null) => void;
  onSave: (next: BlindReviewDoc) => Promise<void>;
  onNext: () => void;
  onClose: () => void;
}> = ({ doc, item, cursorStore, manualOpen, onManualOpen, onSave, onNext, onClose }) => {
  const cursor = useSyncExternalStore(cursorStore.subscribe, cursorStore.get);
  const [picked, setPicked] = useState<BlindReviewChoice | null>(null);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answered = Boolean(doc.answers[item.id]);
  const phase = blindCasePhase(item, answered, cursor);
  const progress = blindReviewProgress(doc);
  const marks = doc.marks[item.id] ?? [];
  const hasNext = doc.cases.some(other => other.id !== item.id && !doc.answers[other.id]);

  const persist = async (build: () => BlindReviewDoc, after: () => void) => {
    setSaving(true); setError(null);
    try { await onSave(build()); after(); }
    catch (reason) { setError(reason instanceof Error ? `Neuloženo: ${reason.message}` : 'Neuloženo, zkus to znovu.'); }
    finally { setSaving(false); }
  };
  const reset = () => { setPicked(null); setText(''); };

  let body: React.ReactNode;
  if (phase === 'reveal') {
    body = <Reveal item={item} doc={doc} cursor={cursor} hasNext={hasNext} onNext={onNext} />;
  } else if (manualOpen) {
    body = <>
      <h3 className="text-sm font-bold">Tady bych vzal</h3>
      <p className="text-xs text-slate-500">{cursor !== null ? formatTime(cursor) : ''}</p>
      <div className="grid grid-cols-2 gap-2">
        <Choice value="Long" picked={picked} onPick={setPicked} />
        <Choice value="Short" picked={picked} onPick={setPicked} />
      </div>
      <textarea aria-label="Proč tady" value={text} onChange={event => setText(event.target.value)} placeholder="Proč tady?" className={FIELD} />
      <div className="grid grid-cols-2 gap-2">
        <button className={BTN} onClick={() => { reset(); onManualOpen(null); }}>Zrušit</button>
        <button className={PRIMARY} disabled={saving || (picked !== 'Long' && picked !== 'Short') || cursor === null} onClick={() => void persist(
          () => addBlindMark(doc, item.id, { time: cursor!, price: null, dir: picked as 'Long' | 'Short', text, at: Date.now() }),
          () => { reset(); onManualOpen(null); },
        )}>Uložit značku</button>
      </div>
    </>;
  } else if (phase === 'ask') {
    body = <>
      <h3 className="text-sm font-bold">Zastaveno. Co teď?</h3>
      <p className="text-xs text-slate-500">Můžeš si přepnout časový rámec nebo posunout graf. Svíčky dál neběží.</p>
      <div className="grid grid-cols-2 gap-2">
        {(['Long', 'Short', 'Nebral', 'Nevím'] as const).map(value => <Choice key={value} value={value} picked={picked} onPick={setPicked} />)}
      </div>
      <textarea aria-label="Důvod odpovědi" value={text} onChange={event => setText(event.target.value)} placeholder="Proč? Co vidíš na levelu, na 5m, co ti vadí." className={FIELD} />
      <button className={PRIMARY} disabled={!picked || saving} onClick={() => void persist(
        () => answerBlindCase(doc, item.id, picked!, text, Date.now()), reset,
      )}>{saving ? 'Ukládám…' : 'Potvrdit a ukázat dál'}</button>
      <p className="text-[11px] text-slate-500">Po potvrzení už odpověď nejde změnit.</p>
    </>;
  } else {
    body = <>
      <h3 className="text-sm font-bold">Pusť replay</h3>
      <p className="text-xs leading-relaxed text-slate-500">Přehrávej jako obvykle. Graf se sám zastaví, část zastavení je náhodná. Když bys vzal něco dřív, klikni níž.</p>
      <button className={BTN} disabled={cursor === null} onClick={() => onManualOpen(cursor)}>Tady bych vzal</button>
      {marks.length > 0 && <div className={BOX}>
        <p className="font-semibold text-slate-500">Tvoje značky</p>
        {marks.map(mark => <p key={mark.at}>{formatTime(mark.time)} {mark.dir}{mark.text ? `: ${mark.text}` : ''}</p>)}
      </div>}
    </>;
  }
  return (
    <aside aria-label="Slepé hodnocení" className="flex h-full w-80 shrink-0 flex-col gap-3 overflow-y-auto border-l border-[var(--border-subtle)] p-4">
      <header className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold">Případ {Math.min(progress.answered + (answered ? 0 : 1), progress.total)} z {progress.total}</p>
          <div className="mt-1 h-1 overflow-hidden rounded bg-slate-500/20"><div className="h-full bg-violet-500" style={{ width: `${100 * progress.answered / progress.total}%` }} /></div>
        </div>
        <button aria-label="Zavřít slepé hodnocení" onClick={onClose} className="rounded p-1 hover:bg-slate-500/10"><X size={16} /></button>
      </header>
      {body}
      {error && <p role="alert" className="text-xs font-semibold text-rose-400">{error}</p>}
      <p className="mt-auto text-[11px] leading-relaxed text-slate-500">Příkazy zadané tady se neukládají. Výzkum na historii, ne doporučení k obchodům.</p>
    </aside>
  );
};

const BacktestBlindReview: React.FC<{ doc: BlindReviewDoc; isDark: boolean; onClose: () => void }> = ({ doc: initialDoc, isDark, onClose }) => {
  const [doc, setDoc] = useState(initialDoc);
  const [caseId, setCaseId] = useState(() => nextOpenBlindCase(initialDoc)?.id ?? null);
  const [manualStop, setManualStop] = useState<number | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const item = caseId ? doc.cases.find(entry => entry.id === caseId) ?? null : null;
  const workspaceRef = useRef<BacktestWorkspaceState | null>(loadWorkspace());
  const speedRef = useRef<ChartReplaySpeed>(3);
  const cursorStore = useMemo(() => createCursorStore(item ? item.openMs / 1_000 : null), [item?.id]);
  const run = useMemo(() => item ? buildBlindScratchRun(item, workspaceRef.current, speedRef.current) : null, [item?.id]);

  const onReplay = useCallback((replay: ChartReplayState) => {
    speedRef.current = replay.speed;
    cursorStore.set(replay.cursorTime);
  }, [cursorStore]);
  const onWorkspaceState = useCallback((state: BacktestWorkspaceState) => {
    workspaceRef.current = state;
    try { localStorage.setItem(WORKSPACE_KEY, JSON.stringify(state)); } catch { /* jen pohodlí, odpovědi jsou jinde */ }
  }, []);
  const answered = item ? Boolean(doc.answers[item.id]) : false;
  const replayStopAt = item ? blindReplayStop(item, answered, manualStop) : undefined;
  const scratch = useMemo(() => ({ replayStopAt, onReplay, onWorkspaceState }), [replayStopAt, onReplay, onWorkspaceState]);

  const save = useCallback(async (next: BlindReviewDoc) => {
    await saveBlindReviewProgress(next);
    setDoc(next);
  }, []);
  const toggleManual = useCallback((time: number | null) => {
    setManualOpen(time !== null);
    setManualStop(time);
  }, []);
  const next = useCallback(() => {
    setManualStop(null); setManualOpen(false);
    setCaseId(nextOpenBlindCase(doc)?.id ?? null);
  }, [doc]);

  const progress = blindReviewProgress(doc);
  return (
    <div className={`fixed inset-0 z-[300] flex ${isDark ? 'bg-slate-950 text-slate-100' : 'bg-white text-slate-900'}`}>
      {item && run ? <>
        <div className="relative min-w-0 flex-1">
          <BacktestWorkspace key={run.id} run={run} isDark={isDark} onClose={onClose} scratch={scratch} />
        </div>
        <Panel doc={doc} item={item} cursorStore={cursorStore} manualOpen={manualOpen}
          onManualOpen={toggleManual} onSave={save} onNext={next} onClose={onClose} />
      </> : <div className="m-auto max-w-md p-6 text-center">
        <h3 className="text-lg font-bold">Sada je hotová</h3>
        <p className="mt-2 text-sm text-slate-500">Odpovězeno {progress.answered} z {progress.total}. Odpovědi mám uložené, stačí mi napsat, ať je vyhodnotím.</p>
        <button onClick={onClose} className={`${PRIMARY} mt-4`}>Zavřít</button>
      </div>}
    </div>
  );
};

export default BacktestBlindReview;
