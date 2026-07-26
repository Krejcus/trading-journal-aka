import React, { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Maximize2, Pencil, Trash2, Trophy, X } from 'lucide-react';
import { Account, BusinessPayout, Trade } from '../types';
import { FIRM_LOGOS, firmInitials, firmOf } from '../utils/accountFirm';
import ImageZoomModal from './ImageZoomModal';

interface PayoutDetailModalProps {
    /** Výplaty ve stejném pořadí jako v seznamu — šipky se pohybují po tomto poli. */
    payouts: BusinessPayout[];
    index: number;
    onIndexChange: (index: number) => void;
    accounts: Account[];
    trades: Trade[];
    theme: 'dark' | 'light' | 'oled';
    formatValue: (usdAmount: number) => string;
    onEdit: (payout: BusinessPayout) => void;
    onDelete: (payout: BusinessPayout) => void;
    onClose: () => void;
}

const isLegacyPayout = (p: BusinessPayout) => String(p.id).startsWith('legacy_');

/** Datum čehokoliv → "YYYY-MM-DD" pro porovnávání i počítání unikátních dnů. */
const dayKey = (value?: string): string => {
    if (!value) return '';
    const s = String(value);
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    const d = new Date(s);
    return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
};

/** Kolik obchodních dní stálo dojít k této výplatě.
 *  Počítadlo se po každé výplatě nuluje → okno je (předchozí výplata ze
 *  stejného účtu, tato výplata]. U první výplaty se počítá od prvního obchodu.
 *  Obchodní den = den, kdy na účtu padl aspoň jeden obchod. */
export const tradingDaysForPayout = (
    payout: BusinessPayout,
    payouts: BusinessPayout[],
    trades: Trade[],
): { days: number; from: string } | null => {
    const end = dayKey(payout.date);
    if (!payout.accountId || !end) return null;

    const prevEnd = payouts
        .filter(p => p.accountId === payout.accountId && p.id !== payout.id)
        .map(p => dayKey(p.date))
        .filter(d => d && d < end)
        .sort()
        .pop() || '';

    const days = new Set(
        trades
            .filter(t => t.accountId === payout.accountId)
            .map(t => dayKey(t.date))
            .filter(d => d && d <= end && d > prevEnd),
    );

    return { days: days.size, from: prevEnd };
};

const formatFullDate = (dateStr: string) => {
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString('cs-CZ', { day: 'numeric', month: 'long', year: 'numeric' });
};

const PayoutDetailModal: React.FC<PayoutDetailModalProps> = ({
    payouts, index, onIndexChange, accounts, trades, theme, formatValue, onEdit, onDelete, onClose,
}) => {
    const isDark = theme !== 'light';
    const [zoomOpen, setZoomOpen] = useState(false);

    const payout = payouts[index];
    const hasPrev = index > 0;
    const hasNext = index < payouts.length - 1;

    const go = useCallback((dir: 1 | -1) => {
        const next = index + dir;
        if (next < 0 || next >= payouts.length) return;
        setZoomOpen(false);
        onIndexChange(next);
    }, [index, payouts.length, onIndexChange]);

    // Klávesnice: šipky listují, ESC zavírá. Když je otevřený zoom, ovládá si
    // klávesy sám (a jeho ESC zavře jen zoom, ne celou kartu).
    useEffect(() => {
        if (zoomOpen) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') { onClose(); return; }
            if (e.key === 'ArrowRight') go(1);
            if (e.key === 'ArrowLeft') go(-1);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [zoomOpen, go, onClose]);

    if (!payout) return null;

    const acc = accounts.find(a => a.id === payout.accountId);
    const firm = acc ? firmOf(acc) : '';
    const logo = firm ? FIRM_LOGOS[firm] : undefined;
    const legacy = isLegacyPayout(payout);
    const gross = payout.grossAmount || payout.amount;
    const split = payout.profitSplitUsed || 0;

    const run = tradingDaysForPayout(payout, payouts, trades);
    const runHint = !run || run.days === 0
        ? 'žádné obchody na tomto účtu'
        : run.from
            ? `od výplaty ${new Date(run.from).toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric' })}`
            : 'od prvního obchodu';

    const navBtn =`p-2 rounded-xl transition-all disabled:opacity-20 disabled:cursor-not-allowed ${isDark ? 'hover:bg-white/10 text-white' : 'hover:bg-slate-100 text-slate-900'}`;

    const Stat: React.FC<{ label: string; value: React.ReactNode; accent?: string; hint?: string }> = ({ label, value, accent, hint }) => (
        <div className={`px-4 py-3 rounded-2xl border ${isDark ? 'bg-white/[0.03] border-[var(--border-subtle)]' : 'bg-slate-50 border-slate-100'}`}>
            <p className="text-[9px] font-black uppercase tracking-widest text-slate-500">{label}</p>
            <p className={`mt-1 text-sm font-mono font-black ${accent || (isDark ? 'text-white' : 'text-slate-900')}`}>{value}</p>
            {hint && <p className="mt-0.5 text-[9px] font-bold text-slate-500 truncate">{hint}</p>}
        </div>
    );

    return (
        <>
            <div
                className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/60 backdrop-blur-md animate-in fade-in duration-200"
                onClick={onClose}
            >
                <div
                    onClick={(e) => e.stopPropagation()}
                    className={`w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-[32px] border shadow-2xl ${isDark ? 'bg-[var(--bg-card)] border-[var(--border-subtle)]' : 'bg-white border-slate-200'}`}
                >
                    {/* Hlavička: identita výplaty + listování */}
                    <div className={`sticky top-0 z-10 flex items-center gap-4 px-6 py-5 border-b backdrop-blur-xl ${isDark ? 'bg-[var(--bg-card)]/90 border-[var(--border-subtle)]' : 'bg-white/90 border-slate-100'}`}>
                        <div className={`w-11 h-11 shrink-0 rounded-2xl border overflow-hidden flex items-center justify-center ${isDark ? 'bg-white/5 border-white/10' : 'bg-slate-50 border-slate-200'}`}>
                            {logo
                                ? <img src={logo} alt={firm} className="w-full h-full object-contain p-1.5" />
                                : <span className="text-[10px] font-black text-slate-500">{firmInitials(firm || '?')}</span>}
                        </div>
                        <div className="min-w-0 flex-1">
                            <p className={`text-sm font-black truncate ${isDark ? 'text-white' : 'text-slate-900'}`}>{acc?.name || 'Neznámý účet'}</p>
                            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500 italic">{formatFullDate(payout.date)}</p>
                        </div>

                        <div className="flex items-center gap-1">
                            <button onClick={() => go(-1)} disabled={!hasPrev} aria-label="Předchozí výplata" className={navBtn}><ChevronLeft size={18} /></button>
                            <span className="min-w-[52px] text-center text-[10px] font-black tabular-nums text-slate-500">{index + 1} / {payouts.length}</span>
                            <button onClick={() => go(1)} disabled={!hasNext} aria-label="Další výplata" className={navBtn}><ChevronRight size={18} /></button>
                            <button onClick={onClose} aria-label="Zavřít" className="ml-1 p-2 text-slate-500 hover:text-rose-500 transition-all"><X size={20} /></button>
                        </div>
                    </div>

                    <div className="p-6 space-y-5">
                        {/* Čistá výplata — hlavní číslo */}
                        <div className={`px-6 py-5 rounded-3xl border text-center ${isDark ? 'bg-emerald-500/5 border-emerald-500/20' : 'bg-emerald-50 border-emerald-200'}`}>
                            <p className="text-[10px] font-black uppercase tracking-widest text-emerald-500">Čistá výplata</p>
                            <p className="mt-1 text-4xl font-black font-mono tracking-tighter text-emerald-500">{formatValue(payout.amount)}</p>
                        </div>

                        <div className="grid grid-cols-3 gap-3">
                            <Stat label="Hrubý zisk" value={formatValue(gross)} />
                            <Stat label="Profit split" value={split ? `${split} %` : '—'} />
                            <Stat
                                label="Obchodních dní"
                                value={run && run.days > 0 ? run.days : '—'}
                                hint={runHint}
                            />
                        </div>

                        {/* Důkaz výplaty */}
                        <div className="space-y-2">
                            <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">Důkaz výplaty</p>
                            {payout.image ? (
                                <button
                                    onClick={() => setZoomOpen(true)}
                                    className={`group relative w-full overflow-hidden rounded-2xl border transition-all hover:border-blue-500/50 ${isDark ? 'border-white/10 bg-black/20' : 'border-slate-200 bg-slate-50'}`}
                                >
                                    <img src={payout.image} alt="Důkaz výplaty" className="w-full max-h-72 object-contain" />
                                    <span className="absolute inset-0 flex items-center justify-center gap-2 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity text-white text-[10px] font-black uppercase tracking-widest">
                                        <Maximize2 size={14} /> Zvětšit
                                    </span>
                                </button>
                            ) : (
                                <div className={`flex flex-col items-center justify-center gap-2 py-10 rounded-2xl border border-dashed ${isDark ? 'border-white/10 text-slate-600' : 'border-slate-200 text-slate-400'}`}>
                                    <Trophy size={22} className="opacity-40" />
                                    <span className="text-[10px] font-black uppercase tracking-widest">Bez důkazu</span>
                                </div>
                            )}
                        </div>

                        {payout.notes && (
                            <div className="space-y-2">
                                <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">Poznámky</p>
                                <p className={`px-4 py-3 rounded-2xl border text-xs font-bold leading-relaxed whitespace-pre-wrap ${isDark ? 'bg-white/[0.03] border-[var(--border-subtle)] text-slate-300' : 'bg-slate-50 border-slate-100 text-slate-700'}`}>
                                    {payout.notes}
                                </p>
                            </div>
                        )}

                        {/* Editace až po vědomém kliknutí — karta je primárně na čtení. */}
                        {legacy ? (
                            <p className="text-center text-[10px] font-black uppercase tracking-widest text-slate-500">
                                Archivovaná výplata — nelze upravovat
                            </p>
                        ) : (
                            <div className="flex gap-3 pt-1">
                                <button
                                    onClick={() => onEdit(payout)}
                                    className="flex-1 flex items-center justify-center gap-2 py-3.5 rounded-2xl bg-blue-600 hover:bg-blue-500 text-white font-black uppercase text-[11px] tracking-widest transition-all active:scale-[0.98] shadow-lg shadow-blue-600/20"
                                >
                                    <Pencil size={14} /> Upravit
                                </button>
                                <button
                                    onClick={() => onDelete(payout)}
                                    aria-label="Smazat výplatu"
                                    className="px-5 rounded-2xl text-rose-500 border border-rose-500/30 hover:bg-rose-500/10 transition-all active:scale-95"
                                >
                                    <Trash2 size={16} />
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {zoomOpen && payout.image && (
                <ImageZoomModal src={payout.image} onClose={() => setZoomOpen(false)} />
            )}
        </>
    );
};

export default PayoutDetailModal;
