import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

/** Okno pro doplňkové přehledy Historie (podklady, archiv), otevírané z menu ⋯. */
export default function HistoryPanelModal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div className="fixed inset-0 z-[9998] flex items-start justify-center overflow-y-auto bg-black/50 p-4 pt-[8vh]" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-label={title} className="theme-card w-full max-w-4xl rounded-lg shadow-2xl" onMouseDown={event => event.stopPropagation()}>
        <header className="flex items-center gap-3 border-b border-[var(--border-subtle)] px-4 py-3">
          <h2 className="text-sm font-bold text-[var(--text-primary)]">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Zavřít" className="ml-auto grid h-8 w-8 place-items-center rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-page)] hover:text-[var(--text-primary)]"><X size={16} /></button>
        </header>
        <div className="p-3 [&>section]:mb-0">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
