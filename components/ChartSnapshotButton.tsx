import React, { useEffect, useState } from 'react';
import { AlertTriangle, Camera, Check, Loader2 } from 'lucide-react';
import { snapshotDataUrlToBlob } from '../services/chartSnapshot';

type SnapshotState = { status: 'busy' | 'saved' } | { status: 'error'; message: string } | null;

/**
 * Tlačítko „Snímek“: vyfotí graf tak, jak je vidět (bez ovládání), krátce
 * blikne a uloží obrázek ke Snímkům obchodu. Stav ukazuje přímo na sobě.
 */
export default function ChartSnapshotButton({ className, capture, onSave, flashTarget, compactLabel = false }: {
  className: string;
  /** Vrací PNG data URL zachyceného grafu. */
  capture: () => Promise<string>;
  onSave: (image: Blob) => Promise<boolean>;
  /** Kde bliknout (oblast grafu). */
  flashTarget?: () => HTMLElement | null;
  compactLabel?: boolean;
}) {
  const [state, setState] = useState<SnapshotState>(null);
  useEffect(() => {
    if (!state || state.status === 'busy') return;
    const timer = window.setTimeout(() => setState(null), state.status === 'saved' ? 1800 : 4000);
    return () => window.clearTimeout(timer);
  }, [state]);

  const take = async () => {
    if (state?.status === 'busy') return;
    setState({ status: 'busy' });
    try {
      const dataUrl = await capture();
      flash(flashTarget?.());
      const saved = await onSave(await snapshotDataUrlToBlob(dataUrl));
      setState(saved ? { status: 'saved' } : { status: 'error', message: 'Snímek se nepodařilo uložit k obchodu.' });
    } catch (error) {
      setState({ status: 'error', message: error instanceof Error ? error.message : 'Snímek se nepodařilo vyfotit.' });
    }
  };

  const label = state?.status === 'busy' ? 'Ukládám…' : state?.status === 'saved' ? 'Uloženo' : state?.status === 'error' ? 'Nepovedlo se' : 'Snímek';
  const Icon = state?.status === 'busy' ? Loader2 : state?.status === 'saved' ? Check : state?.status === 'error' ? AlertTriangle : Camera;
  return (
    <button
      type="button"
      className={`${className} ${state?.status === 'saved' ? 'text-emerald-500' : state?.status === 'error' ? 'text-amber-500' : ''}`}
      onClick={() => { void take(); }}
      disabled={state?.status === 'busy'}
      title={state?.status === 'error' ? state.message : 'Vyfotit graf a uložit ke snímkům obchodu'}
      aria-label="Vyfotit graf a uložit ke snímkům obchodu"
      aria-live="polite"
    >
      <Icon size={13} className={state?.status === 'busy' ? 'animate-spin' : ''} />
      <span className={compactLabel ? 'hidden lg:inline' : 'hidden sm:inline'}>{label}</span>
    </button>
  );
}

function flash(target: HTMLElement | null | undefined) {
  if (!target || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const overlay = document.createElement('div');
  overlay.className = 'chart-snapshot-flash';
  overlay.setAttribute('aria-hidden', 'true');
  target.appendChild(overlay);
  overlay.addEventListener('animationend', () => overlay.remove(), { once: true });
  window.setTimeout(() => overlay.remove(), 1000);
}
