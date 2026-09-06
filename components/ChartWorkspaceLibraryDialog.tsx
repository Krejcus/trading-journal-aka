import React, { useMemo, useState } from 'react';
import { X, Save, LayoutGrid, Star } from 'lucide-react';
import { useWorkspaceLibrary } from '../hooks/useWorkspaceLibrary';
import { chartAppearanceUserId } from '../services/chartAppearanceScope';
import { setDefaultWorkspaceTemplate, type WorkspaceTemplate } from '../services/chartWorkspaceLibrary';
import { summarizeWorkspaceDocument } from '../services/chartWorkspaceDocument';

interface Props {
  mode: 'save' | 'load';
  isDark: boolean;
  onClose: () => void;
  onSave: (input: { id?: string; name: string; makeDefault: boolean }) => Promise<void>;
  onLoadCheckpoint: () => void;
  onLoad: (template: WorkspaceTemplate) => void;
}
export const ChartWorkspaceLibraryDialog: React.FC<Props> = ({ mode, isDark, onClose, onSave, onLoad, onLoadCheckpoint }) => {
  const { owner, library, error } = useWorkspaceLibrary();
  const [openedOwner] = useState(() => chartAppearanceUserId());
  const [selected, setSelected] = useState('');
  const [name, setName] = useState('');
  const [makeDefault, setMakeDefault] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const summaries = useMemo(() => new Map(library.templates.map(item => [item.id, summarizeWorkspaceDocument(item.document)])), [library.templates]);
  const current = library.templates.find(item => item.id === selected);
  const safeOwner = owner !== undefined && owner === openedOwner && owner === chartAppearanceUserId();
  const run = async (action: () => void | Promise<void>) => {
    if (!safeOwner) { setMessage('Uživatel se změnil. Zavři knihovnu a otevři ji znovu.'); return; }
    setBusy(true); setMessage(null);
    try { await action(); } catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Operace se nezdařila.'); }
    finally { setBusy(false); }
  };
  return <div className="fixed inset-0 z-[220] flex items-center justify-center bg-black/45 p-4" onKeyDown={event => { if (event.key === 'Escape' && !busy) onClose(); }}>
    <section role="dialog" aria-modal="true" aria-label="Knihovna workspace šablon" className={`w-full max-w-lg rounded-xl border p-4 shadow-2xl ${isDark ? 'border-slate-700 bg-[#11161f] text-slate-100' : 'border-slate-200 bg-white text-slate-900'}`}>
      <header className="mb-3 flex items-center justify-between"><h2 className="text-sm font-bold">{mode === 'save' ? 'Uložit workspace šablonu' : 'Načíst workspace šablonu'}</h2><button aria-label="Zavřít knihovnu" disabled={busy} onClick={onClose}><X size={17} /></button></header>
      <p className="mb-3 text-[11px] text-slate-500">Knihovna tohoto uživatele v tomto prohlížeči. Výchozí šablona je dostupná při vytvoření nové session.</p>
      <div className="max-h-56 space-y-1 overflow-auto">
        {library.templates.length === 0 && <p className="py-4 text-xs text-slate-500">Zatím nejsou uložené žádné šablony.</p>}
        {library.templates.map(item => {
          const summary = summaries.get(item.id)!;
          return <button key={item.id} disabled={busy} onClick={() => { setSelected(item.id); setName(item.name); setMakeDefault(library.defaultId === item.id); }} className={`flex w-full items-center justify-between rounded-md border px-3 py-2 text-left ${selected === item.id ? 'border-violet-500 bg-violet-500/10' : 'border-slate-500/20 hover:bg-slate-500/10'}`}>
            <span><span className="text-xs font-semibold">{item.name}</span><span className="mt-0.5 block text-[10px] text-slate-500">{summary.roots.join(' + ')} · {summary.panels} grafy · {summary.drawings} kresby · {summary.indicators} indikátory</span></span>{library.defaultId === item.id && <Star size={13} className="text-violet-400" />}
          </button>;
        })}
      </div>
      {mode === 'save' && <div className="mt-3 space-y-2"><div className="flex gap-2"><input autoFocus aria-label="Název workspace šablony" maxLength={100} value={name} onChange={event => setName(event.target.value)} placeholder="Např. NY – 3 grafy" className="min-w-0 flex-1 rounded-md border border-slate-500/30 bg-transparent px-3 py-2 text-xs outline-none focus:border-violet-500" /><button className="text-[11px] text-violet-400" onClick={() => { setSelected(''); setName(''); }}>Nová šablona</button></div><label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={makeDefault} onChange={event => setMakeDefault(event.target.checked)} /> Výchozí pro nové sessions</label>{current && <p className="text-[11px] text-amber-500">Přepíše šablonu „{current.name}“. Předchozí verze zůstane dostupná.</p>}</div>}
      {(message || error || !safeOwner) && <p role="alert" className="mt-3 text-xs text-rose-500">{message || error || 'Čekám na ověření uživatele; při změně účtu knihovnu otevři znovu.'}</p>}
      <footer className="mt-4 flex flex-wrap justify-end gap-2">
        {mode === 'load' && <button disabled={busy || !safeOwner} className="mr-auto px-2 text-[11px] text-slate-500" onClick={() => void run(onLoadCheckpoint)}>Checkpoint této session</button>}
        {mode === 'load' && current && <><button disabled={busy || !safeOwner} className="px-2 text-[11px] text-violet-400" onClick={() => void run(() => setDefaultWorkspaceTemplate(owner, current.id))}>Nastavit jako výchozí</button>{current.previous && <button disabled={busy || !safeOwner} className="px-2 text-[11px] text-amber-500" onClick={() => void run(() => onLoad({ ...current, document: current.previous! }))}>Předchozí verze</button>}</>}
        <button disabled={busy || !safeOwner || Boolean(error) || (mode === 'save' ? !name.trim() : !current)} onClick={() => void run(() => mode === 'save' ? onSave({ id: current?.id, name, makeDefault }) : onLoad(current!))} className="flex items-center gap-2 rounded-md bg-violet-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-40">{mode === 'save' ? <Save size={14} /> : <LayoutGrid size={14} />}{busy ? 'Ukládám…' : mode === 'save' ? 'Uložit šablonu' : 'Zobrazit náhled'}</button>
      </footer>
    </section>
  </div>;
};

export const WorkspaceImportPreview: React.FC<{ input: unknown; error?: string; isDark: boolean; busy: boolean; onCancel: () => void; onApply: () => void }> = ({ input, error, isDark, busy, onCancel, onApply }) => {
  const summary = useMemo(() => summarizeWorkspaceDocument(input), [input]);
  return <div className="fixed inset-0 z-[230] flex items-center justify-center bg-black/45 p-4" onKeyDown={event => { if (event.key === 'Escape' && !busy) onCancel(); }}><section role="dialog" aria-modal="true" aria-label="Náhled importu workspace" className={`w-full max-w-md rounded-xl border p-4 shadow-2xl ${isDark ? 'border-slate-700 bg-[#11161f] text-slate-100' : 'border-slate-200 bg-white text-slate-900'}`}>
    <h2 className="text-sm font-bold">Náhled workspace</h2><p className="my-3 text-xs">{summary.roots.join(' + ')} · {summary.panels} grafy · {summary.drawings} kresby · {summary.indicators} indikátory</p>
    <p className="text-[11px] text-slate-500">{summary.kind === 'complete' ? 'Obnoví rozložení, kresby, indikátory, vzhled i synchronizaci.' : 'Starší soubor obsahuje pouze rozložení grafů; neobsahuje kresby ani vzhled.'} Aktuální workspace bude před použitím uložen jako návratová kopie.</p>
    {error && <p role="alert" className="mt-3 text-xs text-rose-500">{error}</p>}
    <footer className="mt-4 flex justify-end gap-2"><button disabled={busy} onClick={onCancel} className="rounded-md px-3 py-2 text-xs">Zrušit</button><button disabled={busy || Boolean(error)} onClick={onApply} className="rounded-md bg-violet-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-40">{busy ? 'Obnovuji…' : 'Použít workspace'}</button></footer>
  </section></div>;
};
