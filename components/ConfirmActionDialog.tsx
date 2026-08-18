import React, { useEffect } from 'react';
import { AlertTriangle, ShieldQuestion } from 'lucide-react';

/**
 * In-app náhrada za `window.confirm` pro execution akce (ARM, Kill switch,
 * Flatten, day-lock, párování workeru).
 *
 * Nativní dialogy nejsou spolehlivé: WKWebView v iOS shellu je bez
 * WKUIDelegate tiše zahodí a `confirm()` vrátí false — akce pak „nefunguje"
 * bez jakékoliv chyby. U obchodního ovládání je tiché selhání nepřijatelné,
 * proto potvrzení vykresluje aplikace sama.
 */

export interface ConfirmActionOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** `danger` pro jednosměrné/rizikové akce (kill switch, day-lock). */
  tone?: 'primary' | 'danger';
}

interface ConfirmActionDialogProps extends ConfirmActionOptions {
  onResolve: (confirmed: boolean) => void;
}

export default function ConfirmActionDialog({
  title,
  message,
  confirmLabel = 'Potvrdit',
  cancelLabel = 'Zrušit',
  tone = 'primary',
  onResolve,
}: ConfirmActionDialogProps) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onResolve(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onResolve]);

  return (
    <div
      className="fixed inset-0 z-[170] flex items-center justify-center bg-slate-950/45 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={event => { if (event.target === event.currentTarget) onResolve(false); }}
    >
      <div className="w-full max-w-md rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-5 shadow-2xl">
        <div className="flex items-start gap-3">
          <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${tone === 'danger' ? 'bg-rose-500/12 text-rose-500' : 'bg-indigo-500/12 text-indigo-500'}`}>
            {tone === 'danger' ? <AlertTriangle size={19} /> : <ShieldQuestion size={19} />}
          </div>
          <div className="min-w-0">
            <h3 className="text-base font-black text-[var(--text-primary)]">{title}</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-[var(--text-secondary)]">{message}</p>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => onResolve(false)}
            className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-page)] px-4 py-2 text-xs font-black text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            autoFocus
            onClick={() => onResolve(true)}
            className={`rounded-lg px-4 py-2 text-xs font-black text-white ${tone === 'danger' ? 'bg-rose-600 hover:bg-rose-500' : 'bg-indigo-600 hover:bg-indigo-500'}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
