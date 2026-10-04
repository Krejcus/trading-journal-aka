import React, { useEffect, useState } from 'react';
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
 * Volba tří karet spodního menu nativní iOS appky. „Hodnotit" a „Více" zůstávají
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
    <div className="border-b border-[var(--border-subtle)] px-4 py-3" data-testid="native-shell-tabs">
      <p className="text-[12.5px] font-semibold text-[var(--text-primary)]">Spodní lišta</p>
      <p className="mt-0.5 text-[11.5px] text-[var(--text-secondary)]">Vyber tři karty. Hodnotit a Více zůstávají, zbytek najdeš v menu Více.</p>

      <div className="mt-2.5 grid grid-cols-5 gap-1 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-page)] p-1" aria-label="Náhled spodního menu">
        {layout.map((item, index) => (
          <span
            key={`${item.id}-${index}`}
            className={`truncate rounded px-1 py-1.5 text-center text-[11px] font-semibold ${item.id === 'review' || item.id === 'more' ? 'text-[var(--text-muted)]' : 'bg-indigo-500/10 text-indigo-500'}`}
          >
            {item.title}
          </span>
        ))}
      </div>

      <div className="mt-2 grid gap-1.5 sm:grid-cols-3">
        {Array.from({ length: NATIVE_SHELL_TAB_SLOT_COUNT }, (_, index) => (
          <label key={index} className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold text-[var(--text-muted)]">{SLOT_LABELS[index]}</span>
            <select
              value={slots[index]}
              disabled={status === 'saving'}
              onChange={event => void update(index, event.target.value)}
              className="h-[30px] rounded-md border border-[var(--border-subtle)] bg-[var(--bg-input)] px-2 text-xs font-semibold text-[var(--text-primary)] outline-none focus:border-indigo-500"
            >
              {NATIVE_SHELL_TAB_DESTINATIONS.map(destination => (
                <option key={destination.id} value={destination.id}>{destination.title}</option>
              ))}
            </select>
          </label>
        ))}
      </div>

      {status === 'saved' ? <p className="mt-2 text-[11px] font-semibold text-emerald-500">Uloženo, lišta je přestavěná.</p> : null}
      {status === 'error' && error ? <p className="mt-2 text-[11px] font-semibold text-red-500">{error}</p> : null}
    </div>
  );
};

export default NativeShellTabsSettings;
