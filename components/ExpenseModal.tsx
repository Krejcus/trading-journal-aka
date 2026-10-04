import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Minus, Plus, X } from 'lucide-react';
import type { Account, BusinessExpense } from '../types';
import FirmMark from './FirmMark';
import { firmDisplayName, selectableFirms } from '../lib/businessFirms';
import { SettingsSegment, btnGhost, btnPrimary, field } from './SettingsUi';

type ExpenseKind = 'challenge' | 'activation' | 'software' | 'education' | 'other';
const KIND_CATEGORY: Record<ExpenseKind, string> = {
  challenge: 'Challenges', activation: 'Challenges', software: 'Software', education: 'Education', other: 'Other',
};
const SIZES = ['25k', '50k', '100k', '150k'] as const;
const today = () => new Date().toISOString().split('T')[0];

/**
 * Nový náklad. U challenge/aktivace se popis skládá z firmy, počtu a velikosti
 * („5× Tradeify 50k“) — z popisu pak Byznys pozná firmu (náklad nemá vlastní pole).
 */
export default function ExpenseModal({ isOpen, onClose, onSave, accounts }: {
  isOpen: boolean;
  onClose: () => void;
  onSave: (expense: BusinessExpense) => void;
  accounts: Account[];
}) {
  const firms = useMemo(() => selectableFirms(accounts), [accounts]);
  const [kind, setKind] = useState<ExpenseKind>('challenge');
  const [firm, setFirm] = useState<string>('');
  const [customFirm, setCustomFirm] = useState('');
  const [count, setCount] = useState(1);
  const [size, setSize] = useState<(typeof SIZES)[number]>('50k');
  const [amount, setAmount] = useState('');
  const [label, setLabel] = useState('');
  const [labelEdited, setLabelEdited] = useState(false);
  const [date, setDate] = useState(today);
  const [recurring, setRecurring] = useState<'one-time' | 'monthly' | 'yearly'>('one-time');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setKind('challenge'); setFirm(firms[0] ?? ''); setCustomFirm(''); setCount(1); setSize('50k');
    setAmount(''); setLabel(''); setLabelEdited(false); setDate(today()); setRecurring('one-time'); setError(null);
  }, [isOpen, firms]);

  const accountPurchase = kind === 'challenge' || kind === 'activation';
  const firmName = firm === 'custom' ? customFirm.trim() : firmDisplayName(firm);
  useEffect(() => {
    if (!accountPurchase || labelEdited) return;
    setLabel(firmName ? `${count}× ${firmName} ${size}${kind === 'activation' ? ' aktivace' : ''}` : '');
  }, [accountPurchase, count, firmName, kind, labelEdited, size]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;
  const value = Number(amount.replace(',', '.')) || 0;

  const save = () => {
    if (!label.trim()) { setError('Doplň popis nákladu.'); return; }
    if (!value) { setError('Zadej částku.'); return; }
    onSave({
      id: crypto.randomUUID(),
      label: label.trim(),
      category: KIND_CATEGORY[kind],
      amount: value,
      date: date || today(),
      recurring,
    });
    onClose();
  };

  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-start justify-center overflow-y-auto bg-black/50 p-4 pt-[7vh]" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Nový náklad" className="glass-modal w-full max-w-[520px] overflow-hidden" onMouseDown={event => event.stopPropagation()}>
        <header className="flex items-center border-b border-[var(--border-subtle)] px-4 py-3">
          <h2 className="text-[15px] font-bold text-[var(--text-primary)]">Nový náklad</h2>
          <button type="button" onClick={onClose} aria-label="Zavřít" className={`${btnGhost} ml-auto w-[30px] px-0`}><X size={16} /></button>
        </header>

        <div className="grid gap-3.5 px-4 py-3.5">
          <div className="grid gap-1.5">
            <span className="text-[11.5px] font-semibold text-[var(--text-secondary)]">Typ</span>
            <div className="overflow-x-auto no-scrollbar">
              <SettingsSegment label="Typ nákladu" value={kind} onChange={setKind}
                options={[{ value: 'challenge', label: 'Challenge' }, { value: 'activation', label: 'Aktivace' }, { value: 'software', label: 'Software' }, { value: 'education', label: 'Vzdělávání' }, { value: 'other', label: 'Ostatní' }]} />
            </div>
          </div>

          {accountPurchase && <>
            <div className="grid gap-1.5">
              <span className="text-[11.5px] font-semibold text-[var(--text-secondary)]">Firma</span>
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                {firms.map(key => (
                  <button key={key} type="button" onClick={() => setFirm(key)} aria-pressed={firm === key}
                    className={`flex min-w-0 items-center gap-2 rounded-md border bg-[var(--bg-input)] px-2 py-1.5 text-left text-xs font-semibold text-[var(--text-primary)] transition-shadow ${firm === key ? 'border-indigo-500 ring-2 ring-indigo-500/20' : 'border-[var(--border-subtle)]'}`}>
                    <FirmMark firm={key} size={20} /><span className="truncate">{firmDisplayName(key)}</span>
                  </button>
                ))}
                <button type="button" onClick={() => setFirm('custom')} aria-pressed={firm === 'custom'}
                  className={`rounded-md border bg-[var(--bg-input)] px-2 py-1.5 text-left text-xs font-semibold text-[var(--text-secondary)] ${firm === 'custom' ? 'border-indigo-500 ring-2 ring-indigo-500/20' : 'border-[var(--border-subtle)]'}`}>
                  Jiná…
                </button>
              </div>
              {firm === 'custom' && <input autoFocus value={customFirm} onChange={event => setCustomFirm(event.target.value)} placeholder="Název firmy" className={field} />}
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <span className="text-[11.5px] font-semibold text-[var(--text-secondary)]">Počet účtů</span>
                <div className="inline-flex w-fit items-center overflow-hidden rounded-md border border-[var(--border-subtle)] bg-[var(--bg-input)]">
                  <button type="button" onClick={() => setCount(c => Math.max(1, c - 1))} aria-label="Méně" className="grid h-[30px] w-[30px] place-items-center text-[var(--text-secondary)]"><Minus size={13} /></button>
                  <span className="min-w-[34px] text-center font-mono text-[13px] font-bold">{count}</span>
                  <button type="button" onClick={() => setCount(c => Math.min(20, c + 1))} aria-label="Více" className="grid h-[30px] w-[30px] place-items-center text-[var(--text-secondary)]"><Plus size={13} /></button>
                </div>
              </div>
              <div className="grid gap-1.5">
                <span className="text-[11.5px] font-semibold text-[var(--text-secondary)]">Velikost účtu</span>
                <SettingsSegment label="Velikost účtu" value={size} onChange={setSize} options={SIZES.map(s => ({ value: s, label: s }))} />
              </div>
            </div>
          </>}

          <div className="grid gap-1.5">
            <label htmlFor="expense-amount" className="text-[11.5px] font-semibold text-[var(--text-secondary)]">Částka celkem</label>
            <div className="flex items-baseline gap-1 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-input)] px-3 py-1.5 focus-within:border-indigo-500 focus-within:ring-2 focus-within:ring-indigo-500/20">
              <span className="font-mono text-xl font-bold text-[var(--text-muted)]">$</span>
              <input id="expense-amount" autoFocus inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') save(); }} placeholder="0"
                className="w-full min-w-0 bg-transparent py-0.5 font-mono text-2xl font-bold text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]" />
            </div>
            {accountPurchase && count > 1 && value > 0 && <span className="text-[11.5px] text-[var(--text-muted)]">= ${(value / count).toFixed(2).replace('.', ',')} za účet</span>}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <label htmlFor="expense-label" className="text-[11.5px] font-semibold text-[var(--text-secondary)]">Popis</label>
              <input id="expense-label" value={label} onChange={event => { setLabel(event.target.value); setLabelEdited(true); }} placeholder="např. TradingView předplatné" className={field} />
            </div>
            <div className="grid gap-1.5">
              <label htmlFor="expense-date" className="text-[11.5px] font-semibold text-[var(--text-secondary)]">Datum</label>
              <input id="expense-date" type="date" value={date} onChange={event => setDate(event.target.value)} className={field} />
            </div>
          </div>

          <div className="grid gap-1.5">
            <span className="text-[11.5px] font-semibold text-[var(--text-secondary)]">Opakování</span>
            <SettingsSegment label="Opakování" value={recurring} onChange={setRecurring}
              options={[{ value: 'one-time', label: 'Jednorázově' }, { value: 'monthly', label: 'Měsíčně' }, { value: 'yearly', label: 'Ročně' }]} />
          </div>
          {error && <p role="alert" className="text-xs font-semibold text-rose-500">{error}</p>}
        </div>

        <footer className="flex justify-end gap-1.5 border-t border-[var(--border-subtle)] bg-[var(--bg-page)]/40 px-4 py-3">
          <button type="button" onClick={onClose} className={btnGhost}>Zrušit</button>
          <button type="button" onClick={save} className={btnPrimary}>Přidat náklad</button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
