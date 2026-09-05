import React, { useEffect, useState } from 'react';
import { LayoutGrid } from 'lucide-react';
import {
  NATIVE_SHELL_TAB_DESTINATIONS,
  NATIVE_SHELL_TAB_SLOT_COUNT,
  nativeShellTabLayout,
  normalizeNativeShellTabSlots,
  readStoredNativeShellTabSlots,
  replaceNativeShellTabSlot,
} from '../lib/nativeShellTabs';
import { loadNativeShellTabs, saveNativeShellTabs } from '../utils/nativeShell';

const SLOT_LABELS = ['Karta 1', 'Karta 2', 'Karta 3'];

/**
 * Volba tří karet spodního menu nativní iOS appky. „Zapsat" a „Více" zůstávají
 * pevné; ostatní cíle jsou dostupné v menu Více. Uložení přestaví nativní lištu
 * okamžitě, bez restartu appky.
 */
const NativeShellTabsSettings: React.FC = () => {
  const [slots, setSlots] = useState<string[]>(readStoredNativeShellTabSlots);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadNativeShellTabs().then(loaded => {
      if (!cancelled) setSlots(loaded);
    });
    return () => { cancelled = true; };
  }, []);

  const update = async (index: number, id: string) => {
    const next = replaceNativeShellTabSlot(slots, index, id);
    setSlots(next);
    setStatus('saving');
    setError(null);
    try {
      const saved = await saveNativeShellTabs(next);
      setSlots(saved);
      setStatus('saved');
    } catch (reason) {
      setStatus('error');
      setError(reason instanceof Error ? reason.message : 'Nastavení karet se nepodařilo uložit.');
    }
  };

  const layout = nativeShellTabLayout(normalizeNativeShellTabSlots(slots));

  return (
    <div className="rounded-2xl border border-[var(--border-subtle)] p-4" data-testid="native-shell-tabs">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[11px] font-black uppercase tracking-widest text-[var(--text-primary)]">Karty spodního menu</p>
          <p className="mt-1 text-[9px] font-bold text-[var(--text-muted)]">Vyber tři karty. Zapsat a Více zůstávají, zbytek najdeš v menu Více.</p>
        </div>
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-blue-500/10 text-blue-500"><LayoutGrid size={16} /></span>
      </div>

      <div className="mt-3 grid grid-cols-5 gap-1 rounded-xl bg-[var(--bg-page)] p-2" aria-label="Náhled spodního menu">
        {layout.map((item, index) => (
          <span
            key={`${item.id}-${index}`}
            className={`truncate rounded-lg px-1 py-1.5 text-center text-[8px] font-black uppercase tracking-wider ${item.id === 'capture' || item.id === 'more' ? 'text-[var(--text-muted)]' : 'bg-blue-500/10 text-blue-500'}`}
          >
            {item.title}
          </span>
        ))}
      </div>

      <div className="mt-3 space-y-2">
        {Array.from({ length: NATIVE_SHELL_TAB_SLOT_COUNT }, (_, index) => (
          <label key={index} className="flex items-center justify-between gap-3 rounded-xl bg-[var(--bg-page)] px-3 py-2">
            <span className="text-[9px] font-black uppercase tracking-wider text-[var(--text-muted)]">{SLOT_LABELS[index]}</span>
            <select
              value={slots[index]}
              disabled={status === 'saving'}
              onChange={event => void update(index, event.target.value)}
              className="h-9 min-w-[150px] rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] px-2 text-xs font-bold text-[var(--text-primary)] outline-none focus:border-blue-500"
            >
              {NATIVE_SHELL_TAB_DESTINATIONS.map(destination => (
                <option key={destination.id} value={destination.id}>{destination.title}</option>
              ))}
            </select>
          </label>
        ))}
      </div>

      {status === 'saved' ? <p className="mt-2 text-[9px] font-bold text-emerald-500">Uloženo, lišta je přestavěná.</p> : null}
      {status === 'error' && error ? <p className="mt-2 text-[9px] font-bold text-red-500">{error}</p> : null}
    </div>
  );
};

export default NativeShellTabsSettings;
