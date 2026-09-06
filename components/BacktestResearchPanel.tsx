import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Camera, Download, X } from 'lucide-react';
import { backtestDecisionSummary, latestBacktestResearch, type BacktestDecisionAction, type BacktestResearchDraft, type BacktestResearchJournal, type BacktestResearchKind, type BacktestResearchRevision } from '../services/backtestResearchJournal';

interface Props {
  open: boolean; isDark: boolean; runId: string; cursorTime: number | null;
  journal?: BacktestResearchJournal; persistenceError?: string | null;
  onClose: () => void; onCapture?: () => Promise<string>;
  onSave: (draft: BacktestResearchDraft, operation: { id: string; recordedAt: number }, edit?: { id: string; expectedRevisionId: string; archived?: boolean }) => Promise<{ localSaved: boolean; cloudSaved: boolean }>;
}
const actions: Record<BacktestDecisionAction, string> = { taken: 'Vzal jsem', skipped: 'Vynechal jsem', missed: 'Utekl mi', 'no-setup': 'Bez setupu' };
const kinds: Record<BacktestResearchKind, string> = { decision: 'Rozhodnutí', prep: 'Příprava', note: 'Poznámka', bookmark: 'Záložka', debrief: 'Vyhodnocení' };
const time = (seconds: number | null) => seconds === null ? 'Neznámý čas' : `${new Date(seconds * 1000).toISOString().replace('T', ' ').slice(0, 19)} UTC`;
const initialDraft: BacktestResearchDraft = { kind: 'decision', action: 'skipped', title: '', text: '', tags: [] };

async function compactSnapshot(dataUrl: string): Promise<string> {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, 1200 / img.naturalWidth);
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Snapshot není v tomto prohlížeči dostupný.');
  context.drawImage(img, 0, 0, canvas.width, canvas.height);
  const result = canvas.toDataURL('image/jpeg', 0.72);
  if (result.length > 700_000) throw new Error('Snapshot je příliš velký. Zmenši rozložení grafů a zkus to znovu.');
  return result;
}

/** Kept mounted by the workspace so closing this panel does not discard a draft. */
export default function BacktestResearchPanel({ open, isDark, runId, cursorTime, journal, persistenceError, onClose, onSave, onCapture }: Props) {
  const [draft, setDraft] = useState<BacktestResearchDraft>(initialDraft);
  const [editing, setEditing] = useState<BacktestResearchRevision>();
  const [busy, setBusy] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [showArchived, setShowArchived] = useState(false);
  const operation = useRef<{ id: string; recordedAt: number; signature: string } | undefined>(undefined);
  const dialogRef = useRef<HTMLElement | null>(null);
  const snapshotCursorRef = useRef<number | null>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => previous?.focus();
  }, [open]);
  const state = useMemo(() => {
    try { return { records: latestBacktestResearch(journal, showArchived), summary: backtestDecisionSummary(journal), error: undefined }; }
    catch (reason) { return { records: [], summary: undefined, error: reason instanceof Error ? reason.message : 'Deník nelze načíst.' }; }
  }, [journal, showArchived]);
  const change = (patch: Partial<BacktestResearchDraft>) => { setDraft(current => ({ ...current, ...patch })); operation.current = undefined; setNotice(undefined); };
  const draftDirty = editing
    ? draft.title !== editing.title || draft.text !== editing.text || draft.action !== editing.action || JSON.stringify(draft.tags) !== JSON.stringify(editing.tags)
    : Boolean(draft.title || draft.text || draft.screenshotDataUrl || draft.tags?.some(tag => tag.trim()));
  const save = async (action?: BacktestDecisionAction, archive?: boolean) => {
    if (busy || capturing) return;
    setBusy(true); setError(undefined); setNotice(undefined);
    const signature = JSON.stringify({ draft, action, archive, editId: editing?.revisionId });
    const intent = operation.current?.signature === signature ? operation.current : { id: crypto.randomUUID(), recordedAt: Date.now(), signature };
    operation.current = intent;
    try {
      if (draft.screenshotDataUrl && !editing && snapshotCursorRef.current !== cursorTime) {
        throw new Error('Snapshot pochází z jiného času replaye. Odeber ho nebo zachyť aktuální graf znovu.');
      }
      const result = await onSave(action ? { ...draft, action } : draft, intent,
        editing ? { id: editing.id, expectedRevisionId: editing.revisionId, archived: archive } : undefined);
      // The record is already in the run. Checkpoint retry must not append another observation.
      operation.current = undefined; setDraft(initialDraft); setEditing(undefined);
      setNotice(!result.localSaved ? 'Zápis je v otevřené session. Stav průběžného ukládání najdeš níže; při chybě nezavírej session.'
        : result.cloudSaved ? 'Zápis uložen na zařízení i do cloudu.' : 'Zápis uložen na zařízení. Synchronizace do cloudu čeká.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Zápis se nepodařilo uložit.'); }
    finally { setBusy(false); }
  };
  const capture = async () => {
    if (!onCapture) return;
    setCapturing(true); setError(undefined);
    try { const capturedAt = cursorTime; change({ screenshotDataUrl: await compactSnapshot(await onCapture()) }); snapshotCursorRef.current = capturedAt; }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Snapshot selhal.'); }
    finally { setCapturing(false); }
  };
  const exportJournal = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ format: 'alphatrade-research-journal', version: 1, runId, exportedAt: new Date().toISOString(), journal: journal ?? { version: 1, revisions: [] } }, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `backtest-decisions-${runId}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  if (!open) return null;
  const field = `w-full rounded-md border px-3 py-2 text-sm ${isDark ? 'border-white/15 bg-white/5 text-slate-100' : 'border-slate-300 bg-white text-slate-900'}`;
  const muted = isDark ? 'text-slate-400' : 'text-slate-600';
  const disabled = busy || capturing || Boolean(state.error);
  return <div className="fixed inset-0 z-[950] flex justify-end bg-slate-950/45" role="presentation">
    <section ref={dialogRef} tabIndex={-1} onKeyDown={event => {
      event.stopPropagation();
      if (event.key === 'Escape' && !busy && !capturing) { event.preventDefault(); onClose(); }
      if (event.key === 'Tab') {
        const items = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]') ?? [])].filter(item => item.getClientRects().length > 0);
        const first = items[0], last = items[items.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }} role="dialog" aria-modal="true" aria-labelledby="research-journal-title" className={`flex h-full w-full max-w-3xl flex-col shadow-2xl ${isDark ? 'bg-[#10161f] text-slate-100' : 'bg-slate-50 text-slate-900'}`}>
      <header className="flex items-start justify-between gap-4 border-b border-slate-500/20 p-5">
        <div><h2 id="research-journal-title" className="text-lg font-bold">Rozhodovací deník</h2><p className={`mt-1 text-xs ${muted}`}>{time(cursorTime)} · replay je pozastavený</p></div>
        <div className="flex gap-2"><button className="rounded border border-slate-500/30 p-2" onClick={exportJournal} title="Exportovat deník včetně historie" aria-label="Exportovat deník"><Download size={17} /></button><button className="rounded border border-slate-500/30 p-2" onClick={onClose} disabled={busy || capturing} aria-label="Zavřít rozhodovací deník"><X size={17} /></button></div>
      </header>
      <div className="flex-1 space-y-5 overflow-y-auto p-5">
        {state.summary && <div><div className="grid grid-cols-4 gap-2">{Object.entries(actions).map(([key, label]) => <div key={key} className="rounded-md border border-slate-500/20 p-2"><div className={`text-[11px] ${muted}`}>{label}</div><strong className="text-xl">{key === 'no-setup' ? state.summary!.noSetup : state.summary![key as 'taken' | 'skipped' | 'missed']}</strong></div>)}</div><p className={`mt-2 text-xs ${muted}`}>{state.summary.limitation}</p></div>}
        <div className="space-y-3 rounded-lg border border-slate-500/25 p-4">
          <div className="flex items-center gap-3"><label className="text-sm font-semibold" htmlFor="research-kind">{editing ? 'Nová revize' : 'Nový zápis'}</label><select id="research-kind" disabled={disabled || Boolean(editing)} className={`${field} !w-auto`} value={draft.kind} onChange={event => change({ kind: event.target.value as BacktestResearchKind, action: event.target.value === 'decision' ? 'skipped' : undefined, phase: undefined })}>{Object.entries(kinds).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></div>
          {draft.kind === 'note' && <label className={`block text-xs ${muted}`}>Fáze poznámky<select aria-label="Fáze poznámky deníku" disabled={disabled || Boolean(editing)} value={draft.phase ?? ''} onChange={event => change({ phase: (event.target.value || undefined) as BacktestResearchDraft['phase'] })} className={`${field} mt-1`}><option value="">Bez určení fáze</option><option value="before">Před obchodováním</option><option value="during">Během pozice</option><option value="after">Po obchodu</option></select></label>}
          <input aria-label="Název zápisu" placeholder="Situace nebo název setupu (volitelné)" maxLength={120} className={field} value={draft.title ?? ''} onChange={event => change({ title: event.target.value })} disabled={disabled} />
          <textarea aria-label="Text rozhodnutí" placeholder="Co vidím a proč tak rozhoduji…" rows={4} maxLength={20000} className={field} value={draft.text ?? ''} onChange={event => change({ text: event.target.value })} disabled={disabled} />
          <input aria-label="Tagy rozhodnutí" placeholder="Tagy oddělené čárkou" className={field} value={(draft.tags ?? []).join(',')} onChange={event => change({ tags: event.target.value.split(',') })} disabled={disabled} />
          {draft.screenshotDataUrl && !editing && <div><img src={draft.screenshotDataUrl} alt="Náhled přiloženého grafu" className="max-h-36 rounded border border-slate-500/30" /><button className="mt-1 text-xs underline" disabled={disabled} onClick={() => change({ screenshotDataUrl: undefined })}>Odebrat snapshot</button></div>}
          {!editing && onCapture && <button className={`flex items-center gap-2 text-xs ${muted}`} onClick={() => void capture()} disabled={disabled}><Camera size={14} />{capturing ? 'Zachycuji graf…' : 'Přiložit snapshot grafů'}</button>}
          {draft.kind === 'decision' && !editing ? <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{Object.entries(actions).map(([key, label]) => <button key={key} className="rounded-md border border-violet-500/50 bg-violet-500/10 px-2 py-2.5 text-xs font-bold hover:bg-violet-500/25 disabled:opacity-40" disabled={disabled || cursorTime === null} onClick={() => void save(key as BacktestDecisionAction)}>{label}</button>)}</div>
            : <div className="flex flex-wrap gap-2">{editing?.kind === 'decision' && <select aria-label="Výsledek rozhodnutí" className={`${field} !w-auto`} disabled={disabled} value={draft.action} onChange={event => change({ action: event.target.value as BacktestDecisionAction })}>{Object.entries(actions).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>}<button disabled={disabled || cursorTime === null} className="rounded bg-violet-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-40" onClick={() => void save()}>{busy ? 'Ukládám…' : editing ? 'Uložit novou revizi' : 'Uložit zápis'}</button>{editing && <><button disabled={disabled} className="rounded border border-slate-500/30 px-3 py-2 text-sm" onClick={() => void save(undefined, !editing.archived)}>{editing.archived ? 'Obnovit zápis' : 'Archivovat zápis'}</button><button disabled={disabled} className="px-3 py-2 text-sm underline" onClick={() => { setEditing(undefined); setDraft(initialDraft); operation.current = undefined; }}>Zrušit úpravu</button></>}</div>}
          {draftDirty && !editing && <button disabled={disabled} className="text-xs underline" onClick={() => { setDraft(initialDraft); operation.current = undefined; setError(undefined); }}>Zahodit rozepsaný zápis</button>}
          <p className={`text-xs ${muted}`}>{editing ? 'Původní text i kontext zůstanou v historii. Úprava se označí jako zpětná.' : 'Zápis uchová právě známý kontext a čas zařízení. Tlačítko „Vzal jsem“ zaznamená rozhodnutí; objednávku zadáváš obchodním panelem.'}</p>
          {(error || state.error) && <p role="alert" className="text-sm text-rose-500">{error || state.error}</p>}
          {notice && <p role="status" className="text-sm text-blue-500">{notice}</p>}
          {persistenceError && <p role="alert" className="text-xs text-amber-500">Ukládání session: {persistenceError}</p>}
        </div>
        <div className="flex justify-between"><h3 className="font-semibold">Záznamy ({state.records.length})</h3><label className={`flex items-center gap-2 text-xs ${muted}`}><input type="checkbox" checked={showArchived} onChange={event => setShowArchived(event.target.checked)} />Včetně archivu</label></div>
        {state.records.length === 0 && <p className={`text-sm ${muted}`}>Zaznamenej i situace, které neobchoduješ. Postupně uvidíš, proč příležitosti bereš nebo vynecháváš.</p>}
        {[...state.records].reverse().map(record => <article key={record.id} className="space-y-2 rounded-lg border border-slate-500/20 p-4">
          <div className="flex items-start justify-between gap-3"><div><strong>{record.title || (record.kind === 'decision' ? actions[record.action!] : kinds[record.kind])}</strong><p className={`mt-1 text-xs ${muted}`}>{kinds[record.kind]}{record.kind === 'decision' ? ` · ${actions[record.action!]}` : ''} · {time(record.context.marketTime)} · revize {record.revision}{record.archived ? ' · archivováno' : ''}</p></div><button className="text-xs text-violet-500 underline" disabled={disabled} onClick={() => { if (draftDirty) { setError('Nejdřív ulož nebo zruš rozepsaný zápis. Text zůstal zachovaný.'); return; } setEditing(record); setDraft({ kind: record.kind, action: record.action, phase: record.phase, title: record.title, text: record.text, tags: record.tags }); operation.current = undefined; setNotice(undefined); setError(undefined); }}>Upravit</button></div>
          <p className="whitespace-pre-wrap break-words text-sm">{record.text}</p>
          <p className={`text-xs ${muted}`}>{record.retrospective ? 'Zpětný zápis / úprava' : record.phaseVerified ? 'Fáze odpovídá zaznamenanému stavu' : 'Fáze neověřena'} · čas zařízení {new Date(record.recordedAt).toLocaleString('cs-CZ')}</p>
          {record.tags.length > 0 && <p className="text-xs text-violet-400">{record.tags.join(' · ')}</p>}
          <details className={`text-xs ${muted}`}><summary className="cursor-pointer">Kontext a historie</summary><p className="mt-2">Instrument {record.context.instrument} · otevřené pozice {record.context.positionIds.length} · čekající objednávky {record.context.pendingOrderIds.length} · známé uzavřené obchody {record.context.closedTradeIds.length}</p>{journal?.revisions.filter(item => item.id === record.id).map(revision => <div key={revision.revisionId} className="mt-2 border-l border-slate-500/30 pl-3"><p>Revize {revision.revision} · {new Date(revision.recordedAt).toLocaleString('cs-CZ')} · kurzor {time(revision.revisionMarketTime)}</p><p className="whitespace-pre-wrap break-words">{revision.title} {revision.text}</p>{revision.screenshotDataUrl && <img src={revision.screenshotDataUrl} alt="Snapshot při původním rozhodnutí" className="mt-2 max-h-48 rounded" />}</div>)}</details>
        </article>)}
      </div>
    </section>
  </div>;
}
