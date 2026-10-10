import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, Plus, Trash2, Upload } from 'lucide-react';
import { Account, BusinessPayout, User } from '../types';
import FirmMark from './FirmMark';
import { accountFirmKey, firmDisplayName } from '../lib/businessFirms';
import { btnGhost, btnPrimary, field } from './SettingsUi';

/** Cokoliv datumového → "YYYY-MM-DD" pro <input type="date">. Prázdné vstupy
 *  nechává prázdné (ať se nepodstrčí dnešek tam, kde datum chybí). */
const toDateInput = (value?: string): string => {
    if (!value) return '';
    const s = String(value);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const m = s.match(/^(\d{4}-\d{2}-\d{2})T/);
    if (m) return m[1];
    const d = new Date(s);
    return isNaN(d.getTime()) ? '' : d.toISOString().split('T')[0];
};

interface PayoutModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSave: (payout: BusinessPayout) => boolean | void | Promise<boolean | void>;
    accounts: Account[];
    payout?: BusinessPayout | null;
    initialAccountId?: string;
    theme: 'dark' | 'light' | 'oled';
    user: User;
}

const PayoutModal: React.FC<PayoutModalProps> = ({
    isOpen,
    onClose,
    onSave,
    accounts,
    payout,
    initialAccountId,
}) => {
    const [error, setError] = useState<string | null>(null);
    const [isSaving, setIsSaving] = useState(false);
    const [dragging, setDragging] = useState(false);
    const [formData, setFormData] = useState<Partial<BusinessPayout>>({
        amount: 0,
        grossAmount: 0,
        profitSplitUsed: 90,
        date: new Date().toISOString().split('T')[0],
        accountId: initialAccountId || '',
        notes: '',
        image: ''
    });

    useEffect(() => {
        if (payout) {
            setFormData({
                ...payout,
                // Starší poškozené payouty mají v DB accountId=null. React select
                // očekává string; prázdná hodnota dovolí účet bezpečně přiřadit znovu.
                accountId: payout.accountId || '',
                notes: payout.notes || '',
                // <input type="date"> umí jen YYYY-MM-DD. Z DB chodí i plné ISO
                // ("2026-07-24T00:00:00") → pole se tvářilo prázdné a při uložení
                // se datum přepsalo na DNEŠEK (výplata pak v seznamu „zmizela" jinam).
                date: toDateInput(payout.date),
                grossAmount: payout.grossAmount || payout.amount,
                profitSplitUsed: payout.profitSplitUsed || 90
            });
        } else if (initialAccountId) {
            const acc = accounts.find(a => a.id === initialAccountId);
            setFormData(prev => ({
                ...prev,
                accountId: initialAccountId,
                profitSplitUsed: acc?.profitSplit || 90,
                amount: 0,
                grossAmount: 0,
                date: new Date().toISOString().split('T')[0],
                notes: '',
                image: ''
            }));
        } else {
            setFormData({
                amount: 0,
                grossAmount: 0,
                profitSplitUsed: 90,
                date: new Date().toISOString().split('T')[0],
                accountId: '',
                notes: '',
                image: ''
            });
        }
    }, [payout, initialAccountId, accounts, isOpen]);

    useEffect(() => {
        if (!isOpen) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [isOpen, onClose]);

    if (!isOpen) return null;

    const handleSave = async () => {
        // Dřív tu bylo tiché `return` → klik na Uložit nic neudělal a nedal důvod.
        if (!formData.accountId) { setError('Vyber účet, ke kterému výplata patří.'); return; }
        if (!formData.amount) { setError('Zadej částku výplaty.'); return; }
        setError(null);
        // U editace nikdy nepodstrkuj dnešek — radši nech původní datum výplaty.
        const safeDate = formData.date || toDateInput(payout?.date) || new Date().toISOString().split('T')[0];
        setIsSaving(true);
        try {
            const saved = await onSave({
                ...(formData as BusinessPayout),
                id: formData.id || `payout_${Date.now()}`,
                // Status jen doplň, nepřepisuj — editace Pending výplaty ji dřív
                // natvrdo překlopila na Received.
                status: formData.status || payout?.status || 'Received',
                date: safeDate
            });
            if (saved !== false) onClose();
            else setError('Výplatu se nepodařilo uložit. Zkus to prosím znovu.');
        } catch {
            setError('Výplatu se nepodařilo uložit. Zkus to prosím znovu.');
        } finally {
            setIsSaving(false);
        }
    };

    const loadImageFile = (file?: File | null) => {
        if (!file || !file.type.startsWith('image/')) return;
        const reader = new FileReader();
        reader.onloadend = () => setFormData(prev => ({ ...prev, image: reader.result as string }));
        reader.readAsDataURL(file);
    };
    const handlePaste = (event: React.ClipboardEvent) => {
        const file = Array.from(event.clipboardData.files).find(item => item.type.startsWith('image/'));
        if (file) { event.preventDefault(); loadImageFile(file); }
    };

    const setGross = (gross: number) => {
        const split = Number(formData.profitSplitUsed) || 90;
        setFormData({ ...formData, grossAmount: gross, amount: gross * (split / 100) });
    };
    const setSplit = (split: number) => {
        const gross = Number(formData.grossAmount) || 0;
        setFormData({ ...formData, profitSplitUsed: split, amount: gross * (split / 100) });
    };
    const pickAccount = (accId: string) => {
        const acc = accounts.find(a => a.id === accId);
        const split = acc?.profitSplit || 90;
        const gross = Number(formData.grossAmount) || 0;
        setFormData({ ...formData, accountId: accId, profitSplitUsed: split, amount: gross * (split / 100) });
    };

    // Účty seskupené podle firmy; archivované (spálené) až na konci — výplata může
    // patřit účtu, který mezitím padl, a u editace by se jinak ztratil.
    // Funded účty první — výplaty chodí z nich.
    const usable = accounts.filter(a => a.type !== 'Backtest').sort((a, b) => Number(b.type === 'Funded') - Number(a.type === 'Funded'));
    const groups = [
        ...Array.from(new Set(usable.filter(a => a.status === 'Active').map(a => accountFirmKey(a)))).map(firm => ({
            firm, archived: false, list: usable.filter(a => a.status === 'Active' && accountFirmKey(a) === firm),
        })),
        { firm: '', archived: true, list: usable.filter(a => a.status !== 'Active') },
    ].filter(group => group.list.length > 0);

    const lab = 'text-[11.5px] font-semibold text-[var(--text-secondary)]';
    const bigInput = 'w-full min-w-0 bg-transparent py-0.5 font-mono text-2xl font-bold text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]';
    const bigBox = 'flex items-baseline gap-1 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-input)] px-3 py-1.5 focus-within:border-indigo-500 focus-within:ring-2 focus-within:ring-indigo-500/20';

    return createPortal(
        <div className="fixed inset-0 z-[200] flex items-start justify-center overflow-y-auto bg-black/50 p-4 pt-[6vh]" onMouseDown={onClose}>
            <div role="dialog" aria-modal="true" aria-label={payout ? 'Upravit výplatu' : 'Nová výplata'} onPaste={handlePaste}
                className="glass-modal flex max-h-full w-full max-w-[520px] flex-col overflow-hidden" onMouseDown={(e) => e.stopPropagation()}>
                <header className="flex shrink-0 items-center border-b border-[var(--border-subtle)] px-4 py-3">
                    <h2 className="text-[15px] font-bold text-[var(--text-primary)]">{payout ? 'Upravit výplatu' : 'Nová výplata'}</h2>
                    <button type="button" onClick={onClose} aria-label="Zavřít" className={`${btnGhost} ml-auto w-[30px] px-0`}><X size={16} /></button>
                </header>

                <div className="grid min-h-0 gap-3.5 overflow-y-auto overscroll-contain px-4 py-3.5">
                    <div className="grid gap-1.5">
                        <span className={lab}>Důkaz výplaty</span>
                        <label
                            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                            onDragLeave={() => setDragging(false)}
                            onDrop={(e) => { e.preventDefault(); setDragging(false); loadImageFile(e.dataTransfer.files?.[0]); }}
                            className={`relative grid cursor-pointer place-items-center gap-1 overflow-hidden rounded-lg border-[1.5px] text-center text-xs text-[var(--text-secondary)] transition-colors ${formData.image ? 'border-solid border-[var(--border-subtle)] p-1.5' : `border-dashed p-5 ${dragging ? 'border-indigo-500 bg-indigo-500/5' : 'border-[var(--border-subtle)] bg-[var(--bg-page)]/50'}`}`}
                        >
                            {formData.image ? (
                                <>
                                    <img src={formData.image} alt="Náhled důkazu" className="block max-h-56 w-full rounded-md object-contain" />
                                    <button type="button" onClick={(e) => { e.preventDefault(); setFormData(prev => ({ ...prev, image: '' })); }}
                                        className="absolute right-3 top-3 inline-flex h-7 items-center gap-1 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-input)] px-2 text-[11px] font-semibold text-[var(--text-primary)]">
                                        <Trash2 size={12} /> Odebrat
                                    </button>
                                </>
                            ) : (
                                <>
                                    <Upload size={20} className="text-[var(--text-muted)]" />
                                    <b className="text-[13px] text-[var(--text-primary)]">Přetáhni screenshot sem</b>
                                    <span>nebo ho vlož (⌘V) · klikni pro výběr souboru</span>
                                </>
                            )}
                            <input type="file" className="hidden" accept="image/*" onChange={(e) => loadImageFile(e.target.files?.[0])} />
                        </label>
                    </div>

                    <div className="grid gap-1.5">
                        <span className={lab}>Účet</span>
                        <div className="max-h-48 overflow-y-auto rounded-md border border-[var(--border-subtle)] bg-[var(--bg-input)]" role="listbox" aria-label="Účet výplaty">
                            {groups.map(group => (
                                <React.Fragment key={group.archived ? 'archived' : group.firm}>
                                    {group.archived && <div className="sticky top-0 bg-[var(--bg-page)] px-2.5 py-1 text-[10.5px] font-semibold text-[var(--text-muted)]">Archivované / spálené</div>}
                                    {group.list.map(acc => {
                                        const selected = formData.accountId === acc.id;
                                        return (
                                            <button key={acc.id} type="button" role="option" aria-selected={selected} onClick={() => pickAccount(acc.id)}
                                                className={`flex w-full items-center gap-2 border-b border-[var(--border-subtle)] px-2.5 py-2 text-left text-[12.5px] last:border-b-0 ${selected ? 'bg-indigo-500/10 font-semibold text-[var(--text-primary)]' : 'text-[var(--text-primary)] hover:bg-[var(--bg-page)]'}`}>
                                                <FirmMark firm={accountFirmKey(acc)} size={18} />
                                                <span className="min-w-0 flex-1 truncate">{acc.name}</span>
                                                <span className="text-[11px] text-[var(--text-muted)]">{firmDisplayName(accountFirmKey(acc))}</span>
                                            </button>
                                        );
                                    })}
                                </React.Fragment>
                            ))}
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                        <div className="grid min-w-0 gap-1.5">
                            <label htmlFor="payout-gross" className={lab}>Hrubý zisk</label>
                            <div className={bigBox}><span className="font-mono text-xl font-bold text-[var(--text-muted)]">$</span>
                                <input id="payout-gross" type="number" inputMode="decimal" value={formData.grossAmount || ''} onChange={(e) => setGross(Number(e.target.value))} placeholder="0" className={bigInput} /></div>
                        </div>
                        <div className="grid min-w-0 gap-1.5">
                            <label htmlFor="payout-split" className={lab}>Profit split</label>
                            <div className={bigBox}>
                                <input id="payout-split" type="number" inputMode="decimal" value={formData.profitSplitUsed || ''} onChange={(e) => setSplit(Number(e.target.value))} placeholder="90" className={bigInput} />
                                <span className="font-mono text-xl font-bold text-[var(--text-muted)]">%</span></div>
                        </div>
                    </div>
                    <div className="flex items-baseline justify-between rounded-md border border-emerald-500/25 bg-emerald-500/10 px-3 py-2.5">
                        <span className="text-xs font-semibold text-[var(--text-secondary)]">Čistá výplata</span>
                        <b className="font-mono text-xl text-emerald-500">${(Number(formData.amount) || 0).toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b>
                    </div>

                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div className="grid gap-1.5">
                            <label htmlFor="payout-date" className={lab}>Datum</label>
                            <input id="payout-date" type="date" value={formData.date} onChange={(e) => setFormData({ ...formData, date: e.target.value })} className={field} />
                        </div>
                        <div className="grid gap-1.5">
                            <label htmlFor="payout-notes" className={lab}>Poznámka</label>
                            <input id="payout-notes" value={formData.notes || ''} onChange={(e) => setFormData({ ...formData, notes: e.target.value })} placeholder="nepovinné" className={field} />
                        </div>
                    </div>
                    {error && <p role="alert" className="text-xs font-semibold text-rose-500">{error}</p>}
                </div>

                <footer className="flex shrink-0 justify-end gap-1.5 border-t border-[var(--border-subtle)] bg-[var(--bg-page)]/40 px-4 py-3">
                    <button type="button" onClick={onClose} className={btnGhost}>Zrušit</button>
                    <button type="button" onClick={handleSave} disabled={isSaving} className={btnPrimary}>
                        {isSaving ? 'Ukládám…' : <><Plus size={14} /> {payout ? 'Uložit změny' : 'Uložit výplatu'}</>}
                    </button>
                </footer>
            </div>
        </div>,
        document.body,
    );
};

export default PayoutModal;
