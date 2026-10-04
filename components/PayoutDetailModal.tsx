import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Pencil, Trash2, Trophy, X } from 'lucide-react';
import { Account, BusinessPayout, Trade } from '../types';
import ImageZoomModal from './ImageZoomModal';
import FirmMark from './FirmMark';
import { accountFirmKey, firmDisplayName } from '../lib/businessFirms';
import { btn, btnDanger, btnGhost } from './SettingsUi';

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
    readOnly?: boolean;
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
): { days: number; tradeCount: number; from: string } | null => {
    const end = dayKey(payout.date);
    if (!payout.accountId || !end) return null;

    const prevEnd = payouts
        .filter(p => p.accountId === payout.accountId && p.id !== payout.id)
        .map(p => dayKey(p.date))
        .filter(d => d && d < end)
        .sort()
        .pop() || '';

    const tradesInRun = trades.filter(t => {
        if (t.accountId !== payout.accountId || t.executionStatus === 'Missed') return false;
        const date = dayKey(t.date);
        return Boolean(date && date <= end && date > prevEnd);
    });
    const days = new Set(tradesInRun.map(t => dayKey(t.date)));

    return { days: days.size, tradeCount: tradesInRun.length, from: prevEnd };
};

const formatFullDate = (dateStr: string) => {
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString('cs-CZ', { day: 'numeric', month: 'long', year: 'numeric' });
};

const PayoutDetailModal: React.FC<PayoutDetailModalProps> = ({
    payouts, index, onIndexChange, accounts, trades, formatValue, onEdit, onDelete, onClose, readOnly = false,
}) => {
    const [zoomOpen, setZoomOpen] = useState(false);
    // Posun obrázku: při listování odjede do strany a nový přijede z druhé;
    // při tažení prstem/myší jde s ním.
    const [offset, setOffset] = useState(0);
    const [fade, setFade] = useState(1);
    const [animating, setAnimating] = useState(false);
    const busy = useRef(false);
    const boxRef = useRef<HTMLDivElement>(null);
    const drag = useRef<{ x0: number; dx: number; moved: boolean } | null>(null);

    const payout = payouts[index];
    const hasPrev = index > 0;
    const hasNext = index < payouts.length - 1;
    const zoomPayouts = payouts
        .map((item, payoutIndex) => ({ payoutIndex, image: item.image }))
        .filter((item): item is { payoutIndex: number; image: string } => Boolean(item.image));
    const zoomImageIndex = zoomPayouts.findIndex(item => item.payoutIndex === index);

    const snapBack = () => { setAnimating(true); setOffset(0); setFade(1); };
    const slide = useCallback((dir: 1 | -1) => {
        if (busy.current) return;
        const next = index + dir;
        if (next < 0 || next >= payouts.length) { snapBack(); return; }
        busy.current = true;
        const width = boxRef.current?.clientWidth || 400;
        setZoomOpen(false);
        setAnimating(true); setOffset(-dir * width * 0.6); setFade(0);
        window.setTimeout(() => {
            setAnimating(false); onIndexChange(next); setOffset(dir * width * 0.6);
            requestAnimationFrame(() => requestAnimationFrame(() => {
                setAnimating(true); setOffset(0); setFade(1);
                window.setTimeout(() => { busy.current = false; }, 230);
            }));
        }, 200);
    }, [index, payouts.length, onIndexChange]);

    // Klávesnice: šipky listují, ESC zavírá. Když je otevřený zoom, ovládá si
    // klávesy sám (a jeho ESC zavře jen zoom, ne celou kartu).
    useEffect(() => {
        if (zoomOpen) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') { onClose(); return; }
            if (e.key === 'ArrowRight') slide(1);
            if (e.key === 'ArrowLeft') slide(-1);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [zoomOpen, slide, onClose]);

    if (!payout) return null;

    const acc = accounts.find(a => a.id === payout.accountId);
    const firm = accountFirmKey(acc);
    const legacy = isLegacyPayout(payout);
    const gross = payout.grossAmount || payout.amount;
    const split = payout.profitSplitUsed || 0;

    const run = tradingDaysForPayout(payout, payouts, trades);
    const runHint = !run || run.days === 0
        ? 'žádné obchody na tomto účtu'
        : run.from
            ? `od výplaty ${new Date(run.from).toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric' })}`
            : 'od prvního obchodu';

    const accountPayouts = payout.accountId
        ? payouts
            .filter(item => item.accountId === payout.accountId && (item.status || 'Received') === 'Received')
            .sort((a, b) => dayKey(a.date).localeCompare(dayKey(b.date)))
        : [];
    const accountPayoutIndex = accountPayouts.findIndex(item => item.id === payout.id);
    const payoutProgress = accountPayoutIndex >= 0
        ? {
            number: accountPayoutIndex + 1,
            cumulative: accountPayouts
                .slice(0, accountPayoutIndex + 1)
                .reduce((sum, item) => sum + (Number(item.amount) || 0), 0),
        }
        : null;

    const onPointerDown = (e: React.PointerEvent) => {
        if (busy.current) return;
        drag.current = { x0: e.clientX, dx: 0, moved: false };
        setAnimating(false);
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    };
    const onPointerMove = (e: React.PointerEvent) => {
        const d = drag.current; if (!d) return;
        d.dx = e.clientX - d.x0;
        if (Math.abs(d.dx) > 4) d.moved = true;
        if (!d.moved) return;
        setOffset(d.dx); setFade(Math.max(0.35, 1 - Math.abs(d.dx) / 500));
    };
    const onPointerUp = () => {
        const d = drag.current; drag.current = null; if (!d) return;
        if (!d.moved) { if (payout.image) setZoomOpen(true); return; }
        if (Math.abs(d.dx) > 60) slide(d.dx < 0 ? 1 : -1); else snapBack();
    };

    const Row: React.FC<{ label: string; children: React.ReactNode; hint?: string }> = ({ label, children, hint }) => (
        <div className="flex items-start justify-between gap-3 border-b border-[var(--border-subtle)] py-2 text-[12.5px] last:border-b-0">
            <dt className="text-[var(--text-secondary)]">{label}</dt>
            <dd className="text-right font-semibold text-[var(--text-primary)]">{children}{hint && <span className="block text-[11px] font-normal text-[var(--text-muted)]">{hint}</span>}</dd>
        </div>
    );

    return (
        <>
            <div className="fixed inset-0 z-[200] flex items-center justify-center overflow-y-auto bg-black/50 p-4" onClick={onClose}>
                <div
                    role="dialog" aria-modal="true" aria-label="Detail výplaty"
                    onClick={(e) => e.stopPropagation()}
                    className="glass-modal grid max-h-[92vh] w-full max-w-[calc(100vw-32px)] gap-2.5 overflow-y-auto p-2.5 sm:w-auto lg:grid-cols-[auto_270px]"
                >
                    <div
                        ref={boxRef}
                        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
                        className="relative grid cursor-grab touch-pan-y select-none place-items-center overflow-hidden rounded-md border border-[var(--border-subtle)] bg-[var(--text-primary)]/[0.04] active:cursor-grabbing"
                        title={payout.image ? 'Klikni pro zvětšení · táhni pro další výplatu' : 'Táhni pro další výplatu'}
                    >
                        <div className={`payout-slide ${animating ? 'is-animating' : ''}`} style={{ transform: `translateX(${offset}px)`, opacity: fade }}>
                            {payout.image ? (
                                <img src={payout.image} alt="Důkaz výplaty" draggable={false} className="block max-h-[76vh] w-auto max-w-full lg:max-w-[640px]" />
                            ) : (
                                <div className="flex h-[260px] w-[min(420px,calc(100vw-64px))] flex-col items-center justify-center gap-2 text-[var(--text-muted)]">
                                    <Trophy size={22} className="opacity-50" />
                                    <span className="text-xs font-semibold">Bez důkazu</span>
                                </div>
                            )}
                        </div>
                    </div>

                    <div className="flex min-w-0 flex-col px-1.5 pb-1 pt-1.5 lg:w-[270px]">
                        <div className="flex items-start justify-between gap-2 border-b border-[var(--border-subtle)] pb-3">
                            <div key={payout.id} className="animate-in fade-in duration-200">
                                <p className="text-[11.5px] font-semibold text-[var(--text-secondary)]">Výplata {index + 1} z {payouts.length}</p>
                                <p className="mt-0.5 font-mono text-[26px] font-extrabold leading-tight text-emerald-500">{formatValue(payout.amount)}</p>
                                {payoutProgress && (
                                    <p className="text-[11.5px] text-[var(--text-secondary)]">{payoutProgress.number}. výplata z účtu · celkem {formatValue(payoutProgress.cumulative)}</p>
                                )}
                            </div>
                            <button type="button" onClick={onClose} aria-label="Zavřít" className={`${btnGhost} w-[30px] px-0`}><X size={16} /></button>
                        </div>

                        <dl key={`meta-${payout.id}`} className="animate-in fade-in duration-200">
                            <Row label="Účet"><span className="inline-flex items-center gap-2"><FirmMark firm={firm} size={18} />{acc?.name || 'Neznámý účet'}</span></Row>
                            <Row label="Firma">{firmDisplayName(firm)}</Row>
                            <Row label="Datum">{formatFullDate(payout.date)}</Row>
                            <Row label="Hrubý zisk">{formatValue(gross)}</Row>
                            <Row label="Profit split">{split ? `${split} %` : '—'}</Row>
                            <Row label="Obchodních dní" hint={runHint}>{run && run.days > 0 ? run.days : '—'}</Row>
                            <Row label="Obchodů" hint={run?.from ? 'od předchozí výplaty' : 'od prvního obchodu'}>{run && run.tradeCount > 0 ? run.tradeCount : '—'}</Row>
                        </dl>
                        {payout.notes && (
                            <p className="mt-2 whitespace-pre-wrap rounded-md border border-[var(--border-subtle)] bg-[var(--bg-page)]/60 px-3 py-2 text-xs leading-relaxed text-[var(--text-primary)]">{payout.notes}</p>
                        )}
                        {legacy && <p className="mt-2 text-center text-[11.5px] text-[var(--text-muted)]">Archivovaná výplata — nelze upravovat</p>}

                        <div className="mt-auto grid gap-1.5 pt-3">
                            {!legacy && !readOnly && (
                                <div className="flex gap-1.5">
                                    <button type="button" onClick={() => onEdit(payout)} className={`${btnGhost} flex-1`}><Pencil size={13} /> Upravit</button>
                                    <button type="button" onClick={() => onDelete(payout)} className={`${btnDanger} flex-1`}><Trash2 size={13} /> Smazat</button>
                                </div>
                            )}
                            <div className="flex gap-1.5">
                                <button type="button" onClick={() => slide(-1)} disabled={!hasPrev} className={`${btn} flex-1`}><ArrowLeft size={13} /> Předchozí</button>
                                <button type="button" onClick={() => slide(1)} disabled={!hasNext} className={`${btn} flex-1`}>Další <ArrowRight size={13} /></button>
                            </div>
                            {payouts.length > 1 && payouts.length <= 24 && (
                                <div className="flex justify-center gap-1 pt-1" aria-hidden="true">
                                    {payouts.map((item, i) => <i key={item.id} className={`h-[5px] rounded-full transition-all ${i === index ? 'w-3.5 bg-indigo-500' : 'w-[5px] bg-[var(--border-subtle)]'}`} />)}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            {zoomOpen && zoomImageIndex >= 0 && (
                <ImageZoomModal
                    images={zoomPayouts.map(item => item.image)}
                    initialIndex={zoomImageIndex}
                    onIndexChange={(imageIndex) => onIndexChange(zoomPayouts[imageIndex].payoutIndex)}
                    onClose={() => setZoomOpen(false)}
                />
            )}
        </>
    );
};

export default PayoutDetailModal;
