import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, Image as ImageIcon, LayoutGrid, List, Plus, Trash2, X } from 'lucide-react';
import PayoutModal from './PayoutModal';
import PayoutDetailModal from './PayoutDetailModal';
import ConfirmationModal from './ConfirmationModal';
import ExpenseModal from './ExpenseModal';
import FirmMark from './FirmMark';
import { SettingsSegment, btn, btnGhost, btnPrimary, revealOnHover, td, th } from './SettingsUi';
import {
    Trade,
    Account,
    BusinessExpense,
    BusinessPayout,
    PlaybookItem,
    BusinessGoal,
    BusinessResource,
    BusinessSettings,
    User,
    ConstitutionRule,
    CareerCheckpoint,
    DailyReview,
    WeeklyFocus
} from '../types';
import { currencyService, ExchangeRates } from '../services/currencyService';
import {
    accountCountInLabel, accountFirmKey, expenseFirmKeys, expenseMonth, firmDisplayName, firmSummaries, monthlyCashflow,
    type FirmSummary,
} from '../lib/businessFirms';

interface BusinessHubProps {
    theme: 'dark' | 'light' | 'oled';
    user: User;
    exchangeRates: ExchangeRates | null;
    trades: Trade[];
    accounts: Account[];
    expenses: BusinessExpense[];
    payouts: BusinessPayout[];
    playbook: PlaybookItem[];
    goals: BusinessGoal[];
    resources: BusinessResource[];
    settings: BusinessSettings;
    onUpdateExpenses: (expenses: BusinessExpense[]) => void;
    onUpdatePayouts: (payouts: BusinessPayout[]) => boolean | void | Promise<boolean | void>;
    onUpdatePlaybook: (items: PlaybookItem[]) => void;
    onUpdateGoals: (goals: BusinessGoal[]) => void;
    onUpdateResources: (resources: BusinessResource[]) => void;
    onUpdateSettings: (settings: BusinessSettings) => void;
    onUpdateAccounts: (accounts: Account[]) => void;
    constitutionRules: ConstitutionRule[];
    onUpdateConstitution: (rules: ConstitutionRule[]) => void;
    careerRoadmap: CareerCheckpoint[];
    onUpdateRoadmap: (roadmap: CareerCheckpoint[]) => void;
    dailyReviews: DailyReview[];
    weeklyFocusList: WeeklyFocus[];
    activeTab: 'financials' | 'goals';
    onTabChange: (tab: 'financials' | 'goals') => void;
}

const isReceived = (p: BusinessPayout) => (p.status || 'Received') === 'Received';
const isLegacyPayout = (p: BusinessPayout) => String(p.id).startsWith('legacy_');
const CATEGORY_LABELS: Record<string, string> = {
    Challenges: 'Challenge', Software: 'Software', Education: 'Vzdělávání', Hardware: 'Hardware', Taxes: 'Daně', Other: 'Ostatní',
};
const expenseKind = (e: BusinessExpense) => (e.category === 'Challenges' && /aktivac|activation/i.test(e.label) ? 'Aktivace' : CATEGORY_LABELS[e.category] ?? e.category);
const monthName = (month: string, withYear = true) => {
    const [y, m] = month.split('-').map(Number);
    const name = new Date(y, m - 1, 1).toLocaleString('cs-CZ', { month: 'long' });
    return withYear ? `${name} ${y}` : name;
};
const shortDate = (date: string) => {
    const d = new Date(date);
    return isNaN(d.getTime()) ? date : `${d.getDate()}. ${d.getMonth() + 1}.`;
};
const plural = (n: number, one: string, few: string, many: string) => (n === 1 ? one : n >= 2 && n <= 4 ? few : many);

/**
 * Byznys — kolik stojí účty a kolik se vrací. Čistá hotovost = výplaty − náklady;
 * měsíce s rozpisem, prop firmy s detailem, galerie důkazů výplat, náklady po měsících.
 */
const BusinessHub: React.FC<BusinessHubProps> = ({
    theme, user, exchangeRates, trades, accounts, expenses, payouts, onUpdateExpenses, onUpdatePayouts,
}) => {
    const targetCurrency = user.currency || 'USD';
    const formatValue = (usdAmount: number) => {
        if (!exchangeRates) return currencyService.format(usdAmount, 'USD');
        return currencyService.format(currencyService.convert(usdAmount, targetCurrency, exchangeRates), targetCurrency);
    };
    const signed = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${formatValue(Math.abs(v))}`;

    const [isAddingExpense, setIsAddingExpense] = useState(false);
    const [isAddingPayout, setIsAddingPayout] = useState(false);
    const [editingPayout, setEditingPayout] = useState<BusinessPayout | null>(null);
    const [detailPayoutId, setDetailPayoutId] = useState<string | null>(null);
    const [firmDetail, setFirmDetail] = useState<string | null>(null);
    const [itemToDelete, setItemToDelete] = useState<{ id: string; type: 'expense' | 'payout' } | null>(null);
    const [payoutView, setPayoutView] = useState<'gallery' | 'list'>('gallery');
    const [monthPop, setMonthPop] = useState<{ month: string; left: number; top: number; arrow: number } | null>(null);
    const monthsRef = useRef<HTMLDivElement>(null);
    const popRef = useRef<HTMLDivElement>(null);

    const firmKeys = useMemo(() => accounts.map(acc => accountFirmKey(acc)), [accounts]);
    const received = useMemo(() => payouts.filter(isReceived), [payouts]);
    const totalPaid = useMemo(() => received.reduce((s, p) => s + (Number(p.amount) || 0), 0), [received]);
    const totalCost = useMemo(() => expenses.reduce((s, e) => s + (Number(e.amount) || 0), 0), [expenses]);
    const net = totalPaid - totalCost;
    const roi = totalCost > 0 ? totalPaid / totalCost : null;
    const months = useMemo(() => monthlyCashflow(expenses, payouts), [expenses, payouts]);
    const costMonths = useMemo(() => new Set(expenses.map(e => expenseMonth(e.date)).filter(Boolean)).size, [expenses]);
    const firms = useMemo(() => firmSummaries(expenses, payouts, accounts), [expenses, payouts, accounts]);
    const maxMonthBar = Math.max(1, ...months.map(m => Math.max(m.paid, m.cost)));

    // Výplaty od nejnovější; detail listuje po tomhle pořadí.
    const sortedPayouts = useMemo(() => [...payouts].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()), [payouts]);
    const detailIndex = detailPayoutId ? sortedPayouts.findIndex(p => p.id === detailPayoutId) : -1;
    const accountOf = (p: BusinessPayout) => accounts.find(a => a.id === p.accountId);

    const expensesByMonth = useMemo(() => {
        const map = new Map<string, BusinessExpense[]>();
        [...expenses].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()).forEach(e => {
            const m = expenseMonth(e.date) || 'bez data';
            if (!map.has(m)) map.set(m, []);
            map.get(m)!.push(e);
        });
        return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]));
    }, [expenses]);
    const [openMonths, setOpenMonths] = useState<Set<string> | null>(null);
    const open = openMonths ?? new Set(expensesByMonth.slice(0, 2).map(([m]) => m));
    const toggleMonth = (m: string) => setOpenMonths(() => { const next = new Set(open); if (next.has(m)) next.delete(m); else next.add(m); return next; });

    // Bublina měsíce: zavře se klikem mimo nebo Escape.
    useEffect(() => {
        if (!monthPop) return;
        const close = (e: MouseEvent) => {
            const t = e.target as Node;
            if (popRef.current?.contains(t) || (t instanceof Element && t.closest('[data-month-cell]'))) return;
            setMonthPop(null);
        };
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMonthPop(null); };
        document.addEventListener('mousedown', close);
        document.addEventListener('keydown', onKey);
        return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', onKey); };
    }, [monthPop]);

    const openMonth = (month: string, el: HTMLElement) => {
        if (monthPop?.month === month) { setMonthPop(null); return; }
        const wrap = monthsRef.current?.getBoundingClientRect();
        const cell = el.getBoundingClientRect();
        if (!wrap) return;
        const width = Math.min(300, wrap.width - 28);
        const center = cell.left - wrap.left + cell.width / 2;
        const left = Math.max(14, Math.min(center - width / 2, wrap.width - width - 14));
        setMonthPop({ month, left, top: cell.bottom - wrap.top + 8, arrow: center - left - 5 });
    };

    const kpi = 'min-w-0 px-4 py-3.5';
    const kpiLabel = 'text-[11.5px] font-semibold text-[var(--text-secondary)]';
    const kpiValue = 'mt-1.5 font-mono text-[22px] font-extrabold tracking-tight tabular-nums sm:text-2xl';
    const kpiSub = 'mt-1 text-[11.5px] text-[var(--text-secondary)]';
    const sectionHead = 'flex min-h-[46px] flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b border-[var(--border-subtle)] px-4 py-2.5';

    const renderProof = (p: BusinessPayout, className = '') => p.image
        ? <img src={p.image} alt="Důkaz výplaty" loading="lazy" draggable={false} className={`h-full w-full object-cover object-left ${className}`} />
        : <span className="flex h-full w-full items-center justify-center text-[var(--text-muted)]" title="Důkaz se načítá nebo chybí"><ImageIcon size={18} className="opacity-40" /></span>;

    const payoutTile = (p: BusinessPayout, onOpen: () => void = () => setDetailPayoutId(p.id)) => {
        const acc = accountOf(p);
        return (
            <button key={p.id} type="button" onClick={onOpen} title={acc?.name}
                className="group relative aspect-[4/3] overflow-hidden rounded-md border border-[var(--border-subtle)] bg-[var(--bg-page)] text-left">
                <span className="block h-full w-full transition-transform duration-300 group-hover:scale-[1.04]">{renderProof(p)}</span>
                <span className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-1.5 bg-gradient-to-t from-slate-950/85 to-transparent px-2.5 pb-2 pt-5 text-white">
                    <b className="font-mono text-[13px] text-emerald-300">{formatValue(p.amount)}</b>
                    <span className="min-w-0 truncate text-right text-[10.5px] leading-tight opacity-90">{shortDate(p.date)}<br />{acc?.name || 'Neznámý účet'}</span>
                </span>
            </button>
        );
    };

    return (
        <div className="mx-auto max-w-[1400px] space-y-3 pb-32 pt-2">
            <div className="flex justify-end gap-1.5">
                <button type="button" onClick={() => setIsAddingExpense(true)} className={btn}><Plus size={14} /> Náklad</button>
                <button type="button" onClick={() => setIsAddingPayout(true)} className={btnPrimary}><Plus size={14} /> Výplata</button>
            </div>

            <div className="theme-card grid grid-cols-2 overflow-hidden rounded-lg lg:grid-cols-4 [&>div+div]:border-[var(--border-subtle)] [&>div:nth-child(2)]:border-l [&>div:nth-child(4)]:border-l [&>div:nth-child(n+3)]:border-t lg:[&>div:nth-child(3)]:border-l lg:[&>div:nth-child(n+3)]:border-t-0">
                <div className={kpi}>
                    <p className={kpiLabel}>Čistá hotovost</p>
                    <p className={`${kpiValue} ${net >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>{signed(net)}</p>
                    <p className={kpiSub}>výplaty − náklady</p>
                </div>
                <div className={kpi}>
                    <p className={kpiLabel}>Výplaty</p>
                    <p className={`${kpiValue} text-emerald-500`}>{formatValue(totalPaid)}</p>
                    <p className={kpiSub}><b className="font-semibold text-[var(--text-primary)]">{received.length}</b> {plural(received.length, 'výplata', 'výplaty', 'výplat')}{sortedPayouts[0] ? ` · poslední ${shortDate(sortedPayouts[0].date)}` : ''}</p>
                </div>
                <div className={kpi}>
                    <p className={kpiLabel}>Náklady</p>
                    <p className={`${kpiValue} text-[var(--text-primary)]`}>{formatValue(totalCost)}</p>
                    <p className={kpiSub}><b className="font-semibold text-[var(--text-primary)]">{expenses.length}</b> {plural(expenses.length, 'položka', 'položky', 'položek')}{costMonths ? <> · Ø <b className="font-semibold text-[var(--text-primary)]">{formatValue(totalCost / costMonths)}</b> / měsíc</> : null}</p>
                </div>
                <div className={kpi}>
                    <p className={kpiLabel}>Návratnost</p>
                    <p className={`${kpiValue} ${roi == null ? 'text-[var(--text-muted)]' : roi >= 1 ? 'text-emerald-500' : 'text-rose-500'}`}>{roi == null ? '—' : `${Math.round(roi * 100)} %`}</p>
                    <p className={kpiSub}>{roi == null ? 'zatím žádné náklady' : <>z každého <b className="font-semibold text-[var(--text-primary)]">$1</b> nákladů se vrátilo <b className="font-semibold text-[var(--text-primary)]">${roi.toFixed(2).replace('.', ',')}</b></>}</p>
                </div>
            </div>

            {months.length > 0 && (
                <section className="theme-card relative z-[5] rounded-lg">
                    <header className={sectionHead}>
                        <h2 className="text-[13.5px] font-bold text-[var(--text-primary)]">Měsíce</h2>
                        <span className="text-xs text-[var(--text-muted)]">klikni na měsíc pro rozpis</span>
                    </header>
                    <div ref={monthsRef} className="relative">
                        <div className="grid grid-cols-3 gap-1.5 p-3.5 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-[repeat(auto-fit,minmax(110px,1fr))]">
                            {months.map(m => {
                                const up = m.net >= 0;
                                const selected = monthPop?.month === m.month;
                                return (
                                    <button key={m.month} type="button" data-month-cell onClick={(e) => openMonth(m.month, e.currentTarget)} aria-expanded={selected}
                                        className={`min-w-0 rounded-md border px-2.5 py-2 text-left transition-shadow ${up ? 'border-emerald-500/30 bg-emerald-500/10' : 'border-rose-500/20 bg-rose-500/[0.07]'} ${selected ? 'ring-2 ring-indigo-500/40' : 'hover:ring-1 hover:ring-indigo-500/30'}`}>
                                        <p className="text-[11px] font-semibold capitalize text-[var(--text-secondary)]">{monthName(m.month, false)}</p>
                                        <p className={`mt-1 truncate font-mono text-xs font-semibold ${m.paid ? 'text-emerald-500' : 'text-[var(--text-muted)]'}`}>+{formatValue(m.paid)}</p>
                                        <p className="truncate font-mono text-xs font-semibold text-rose-500">−{formatValue(m.cost)}</p>
                                        <div className="mt-1.5 grid gap-[3px]" aria-hidden="true">
                                            <span className="block h-1 rounded-sm bg-emerald-500" style={{ width: `${(m.paid / maxMonthBar) * 100}%` }} />
                                            <span className="block h-1 rounded-sm bg-rose-500" style={{ width: `${(m.cost / maxMonthBar) * 100}%` }} />
                                        </div>
                                        <p className="mt-1.5 flex justify-between gap-1 border-t border-[var(--border-subtle)] pt-1.5 text-[10.5px] text-[var(--text-secondary)]">
                                            <span>měsíc</span><b className={`font-mono ${up ? 'text-emerald-500' : 'text-rose-500'}`}>{signed(m.net)}</b>
                                        </p>
                                    </button>
                                );
                            })}
                        </div>
                        {monthPop && (() => {
                            const m = months.find(x => x.month === monthPop.month);
                            if (!m) return null;
                            const monthPays = received.filter(p => expenseMonth(p.date) === m.month);
                            const monthCosts = expenses.filter(e => expenseMonth(e.date) === m.month);
                            const item = (key: string, date: string, firm: string, text: string, value: string, tone: string) => (
                                <div key={key} className="flex items-center gap-2 py-0.5 text-xs">
                                    <span className="w-11 shrink-0 whitespace-nowrap font-mono text-[10.5px] text-[var(--text-muted)]">{shortDate(date)}</span>
                                    <FirmMark firm={firm} size={16} />
                                    <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]">{text}</span>
                                    <span className={`font-mono text-[11.5px] font-semibold ${tone}`}>{value}</span>
                                </div>
                            );
                            return (
                                <div ref={popRef} role="dialog" aria-label={`Rozpis ${monthName(m.month)}`}
                                    className="glass-modal absolute z-20 w-[300px] max-w-[calc(100%-28px)]" style={{ left: monthPop.left, top: monthPop.top }}>
                                    <span aria-hidden="true" className="absolute -top-[6px] h-2.5 w-2.5 rotate-45 border-l border-t border-[var(--glass-border,var(--border-subtle))] bg-[var(--modal-bg,var(--bg-card))]" style={{ left: monthPop.arrow }} />
                                    <div className="flex items-baseline justify-between border-b border-[var(--border-subtle)] px-3 py-2.5">
                                        <b className="text-[13px] capitalize text-[var(--text-primary)]">{monthName(m.month)}</b>
                                        <span className={`font-mono text-[13px] font-bold ${m.net >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>{signed(m.net)}</span>
                                    </div>
                                    <div className="max-h-[50vh] overflow-y-auto">
                                        <div className="border-b border-[var(--border-subtle)] px-3 py-2">
                                            <p className="mb-1 flex justify-between text-[11px] font-semibold text-[var(--text-secondary)]"><span>Výplaty · {monthPays.length}</span><span className="text-emerald-500">+{formatValue(m.paid)}</span></p>
                                            {monthPays.length ? monthPays.map(p => item(p.id, p.date, accountFirmKey(accountOf(p)), accountOf(p)?.name || 'Neznámý účet', `+${formatValue(p.amount)}`, 'text-emerald-500'))
                                                : <p className="text-xs text-[var(--text-muted)]">žádná výplata</p>}
                                        </div>
                                        <div className="px-3 py-2">
                                            <p className="mb-1 flex justify-between text-[11px] font-semibold text-[var(--text-secondary)]"><span>Náklady · {monthCosts.length}</span><span className="text-rose-500">−{formatValue(m.cost)}</span></p>
                                            {monthCosts.map(e => item(e.id, e.date, expenseFirmKeys(e, firmKeys)[0], e.label, `−${formatValue(e.amount)}`, 'text-rose-500'))}
                                        </div>
                                    </div>
                                    <div className="flex justify-between border-t border-[var(--border-subtle)] px-3 py-2 text-[11.5px] text-[var(--text-secondary)]">
                                        <span>Hotovost po měsíci</span><b className={`font-mono ${m.cumulative >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>{signed(m.cumulative)}</b>
                                    </div>
                                </div>
                            );
                        })()}
                    </div>
                </section>
            )}

            <div className="grid gap-3 lg:grid-cols-2">
                <section className="theme-card min-w-0 overflow-hidden rounded-lg">
                    <header className={sectionHead}>
                        <h2 className="text-[13.5px] font-bold text-[var(--text-primary)]">Prop firmy</h2>
                        <span className="text-xs text-[var(--text-muted)]">klikni pro detail</span>
                    </header>
                    {firms.length === 0 ? <p className="px-4 py-6 text-center text-xs text-[var(--text-secondary)]">Zatím žádné náklady ani výplaty.</p> : (
                        <div className="overflow-x-auto">
                            <table className="w-full text-[12.5px] [&_tbody_tr:last-child_td]:border-b-0">
                                <thead><tr>
                                    <th className={th}>Firma</th>
                                    <th className={`${th} text-right`}>Náklady</th>
                                    <th className={`${th} text-right`}>Výplaty</th>
                                    <th className={`${th} text-right`}>Čistě</th>
                                    <th className={`${th} w-8`}><span className="sr-only">Detail</span></th>
                                </tr></thead>
                                <tbody>
                                    {firms.map(f => (
                                        <tr key={f.key} onClick={() => setFirmDetail(f.key)} className="cursor-pointer hover:bg-[var(--bg-page)]/60">
                                            <td className={td}><span className="inline-flex items-center gap-2 font-semibold text-[var(--text-primary)]"><FirmMark firm={f.key} size={20} />{firmDisplayName(f.key)}</span></td>
                                            <td className={`${td} text-right font-mono text-xs tabular-nums`}>{formatValue(f.cost)}</td>
                                            <td className={`${td} text-right font-mono text-xs tabular-nums`}>{f.paid ? formatValue(f.paid) : <span className="text-[var(--text-muted)]">—</span>}</td>
                                            <td className={`${td} text-right font-mono text-xs font-bold tabular-nums ${f.net >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>{signed(f.net)}</td>
                                            <td className={`${td} text-[var(--text-muted)]`}><ChevronRight size={14} /></td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </section>

                <section className="theme-card min-w-0 overflow-hidden rounded-lg">
                    <header className={sectionHead}>
                        <h2 className="text-[13.5px] font-bold text-[var(--text-primary)]">Výplaty</h2>
                        <span className="text-xs text-[var(--text-muted)]">{received.length} · {formatValue(totalPaid)}</span>
                        <div className="ml-auto">
                            <SettingsSegment label="Zobrazení výplat" value={payoutView} onChange={setPayoutView}
                                options={[{ value: 'gallery', label: <LayoutGrid size={13} aria-label="Galerie" />, title: 'Galerie důkazů' }, { value: 'list', label: <List size={13} aria-label="Seznam" />, title: 'Seznam' }]} />
                        </div>
                    </header>
                    <div className="max-h-[460px] overflow-y-auto">
                        {sortedPayouts.length === 0 ? (
                            <p className="px-4 py-6 text-center text-xs text-[var(--text-secondary)]">Zatím žádná výplata.</p>
                        ) : payoutView === 'gallery' ? (
                            <div className="grid grid-cols-2 gap-2 p-3.5 sm:grid-cols-3 lg:grid-cols-2 xl:grid-cols-3">{sortedPayouts.map(p => payoutTile(p))}</div>
                        ) : (
                            <table className="w-full text-[12.5px] [&_tbody_tr:last-child_td]:border-b-0">
                                <thead className="sticky top-0 z-[1] bg-[var(--bg-card)]"><tr>
                                    <th className={th}>Datum</th><th className={th}>Účet</th><th className={`${th} text-right`}>Částka</th><th className={`${th} w-14`}>Důkaz</th>
                                </tr></thead>
                                <tbody>
                                    {sortedPayouts.map(p => (
                                        <tr key={p.id} onClick={() => setDetailPayoutId(p.id)} className="cursor-pointer hover:bg-[var(--bg-page)]/60">
                                            <td className={`${td} text-[var(--text-secondary)]`}>{shortDate(p.date)}</td>
                                            <td className={td}><span className="inline-flex items-center gap-2 font-semibold text-[var(--text-primary)]"><FirmMark firm={accountFirmKey(accountOf(p))} size={18} />{accountOf(p)?.name || 'Neznámý účet'}{isLegacyPayout(p) && <span className="text-[10.5px] font-medium text-[var(--text-muted)]">archiv</span>}</span></td>
                                            <td className={`${td} text-right font-mono text-xs font-bold text-emerald-500`}>{formatValue(p.amount)}</td>
                                            <td className={td}><span className="block h-[27px] w-9 overflow-hidden rounded border border-[var(--border-subtle)]">{p.image ? renderProof(p) : <span className="grid h-full place-items-center text-[var(--text-muted)]"><ImageIcon size={11} /></span>}</span></td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                    </div>
                </section>
            </div>

            <section className="theme-card overflow-hidden rounded-lg">
                <header className={sectionHead}>
                    <h2 className="text-[13.5px] font-bold text-[var(--text-primary)]">Náklady</h2>
                    <span className="text-xs text-[var(--text-muted)]">{expenses.length} · {formatValue(totalCost)}</span>
                    {expensesByMonth.length > 2 && (
                        <button type="button" onClick={() => setOpenMonths(open.size === expensesByMonth.length ? new Set() : new Set(expensesByMonth.map(([m]) => m)))} className={`${btnGhost} ml-auto`}>
                            {open.size === expensesByMonth.length ? 'Sbalit vše' : 'Rozbalit vše'}
                        </button>
                    )}
                </header>
                {expenses.length === 0 ? <p className="px-4 py-6 text-center text-xs text-[var(--text-secondary)]">Zatím žádné náklady.</p> : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-[12.5px]">
                            <thead><tr>
                                <th className={`${th} w-[90px]`}>Datum</th>
                                <th className={th}>Popis</th>
                                <th className={`${th} hidden sm:table-cell`}>Firma</th>
                                <th className={`${th} hidden md:table-cell`}>Typ</th>
                                <th className={`${th} text-right`}>Částka</th>
                                <th className={`${th} w-10`}><span className="sr-only">Akce</span></th>
                            </tr></thead>
                            <tbody>
                                {expensesByMonth.map(([month, rows]) => {
                                    const isOpen = open.has(month);
                                    const sum = rows.reduce((s, e) => s + (Number(e.amount) || 0), 0);
                                    return (
                                        <React.Fragment key={month}>
                                            <tr onClick={() => toggleMonth(month)} aria-expanded={isOpen} className="cursor-pointer bg-[var(--bg-page)]/50">
                                                <td colSpan={6} className="h-9 border-b border-[var(--border-subtle)] px-4">
                                                    <div className="flex items-center justify-between gap-3">
                                                        <span className="inline-flex items-center gap-1.5 font-semibold capitalize text-[var(--text-primary)]">
                                                            <ChevronRight size={13} className={`text-[var(--text-muted)] transition-transform ${isOpen ? 'rotate-90' : ''}`} />
                                                            {month === 'bez data' ? month : monthName(month)}
                                                            <span className="font-medium normal-case text-[var(--text-muted)]">· {rows.length} {plural(rows.length, 'položka', 'položky', 'položek')}</span>
                                                        </span>
                                                        <span className="font-mono text-xs font-bold text-[var(--text-primary)]">{formatValue(sum)}</span>
                                                    </div>
                                                </td>
                                            </tr>
                                            {isOpen && rows.map(e => (
                                                <tr key={e.id} className="group hover:bg-[var(--bg-page)]/60">
                                                    <td className={`${td} text-[var(--text-secondary)]`}>{shortDate(e.date)}</td>
                                                    <td className={`${td} text-[var(--text-primary)]`}>{e.label}</td>
                                                    <td className={`${td} hidden sm:table-cell`}>
                                                        <span className="inline-flex flex-wrap gap-x-2.5 gap-y-1">{expenseFirmKeys(e, firmKeys).map(k => <span key={k} className="inline-flex items-center gap-1.5 text-xs text-[var(--text-primary)]"><FirmMark firm={k} size={16} />{firmDisplayName(k)}</span>)}</span>
                                                    </td>
                                                    <td className={`${td} hidden text-xs text-[var(--text-secondary)] md:table-cell`}>{expenseKind(e)}</td>
                                                    <td className={`${td} text-right font-mono text-xs font-semibold tabular-nums`}>{formatValue(e.amount)}</td>
                                                    <td className={`${td} text-right`}>
                                                        <button type="button" onClick={() => setItemToDelete({ id: e.id, type: 'expense' })} aria-label={`Smazat ${e.label}`} className={`inline-grid h-7 w-7 place-items-center rounded text-[var(--text-muted)] hover:text-rose-500 ${revealOnHover}`}><Trash2 size={13} /></button>
                                                    </td>
                                                </tr>
                                            ))}
                                        </React.Fragment>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </section>

            <ExpenseModal isOpen={isAddingExpense} onClose={() => setIsAddingExpense(false)} accounts={accounts}
                onSave={(exp) => onUpdateExpenses([...expenses, exp])} />

            <PayoutModal
                isOpen={isAddingPayout || !!editingPayout}
                onClose={() => { setIsAddingPayout(false); setEditingPayout(null); }}
                onSave={(payout) => payouts.some(p => p.id === payout.id) ? onUpdatePayouts(payouts.map(p => p.id === payout.id ? payout : p)) : onUpdatePayouts([...payouts, payout])}
                accounts={accounts}
                payout={editingPayout}
                theme={theme}
                user={user}
            />

            {detailIndex >= 0 && (
                <PayoutDetailModal
                    payouts={sortedPayouts}
                    index={detailIndex}
                    onIndexChange={(i) => setDetailPayoutId(sortedPayouts[i]?.id ?? null)}
                    accounts={accounts}
                    trades={trades}
                    theme={theme}
                    formatValue={formatValue}
                    onEdit={(p) => { setDetailPayoutId(null); setEditingPayout(p); }}
                    onDelete={(p) => { setDetailPayoutId(null); setItemToDelete({ id: p.id, type: 'payout' }); }}
                    onClose={() => setDetailPayoutId(null)}
                />
            )}

            {firmDetail && (
                <FirmDetailModal
                    summary={firms.find(f => f.key === firmDetail)}
                    expenses={expenses.filter(e => expenseFirmKeys(e, firmKeys).includes(firmDetail))}
                    payouts={sortedPayouts.filter(p => isReceived(p) && accountFirmKey(accountOf(p)) === firmDetail)}
                    accountOf={accountOf}
                    formatValue={formatValue}
                    signed={signed}
                    firmKeys={firmKeys}
                    renderTile={(p) => payoutTile(p, () => { setFirmDetail(null); setDetailPayoutId(p.id); })}
                    onClose={() => setFirmDetail(null)}
                />
            )}

            <ConfirmationModal
                isOpen={!!itemToDelete}
                onClose={() => setItemToDelete(null)}
                onConfirm={() => {
                    if (!itemToDelete) return;
                    if (itemToDelete.type === 'expense') onUpdateExpenses(expenses.filter(x => x.id !== itemToDelete.id));
                    if (itemToDelete.type === 'payout') onUpdatePayouts(payouts.filter(x => x.id !== itemToDelete.id));
                }}
                title={itemToDelete?.type === 'expense' ? 'Smazat náklad' : 'Smazat výplatu'}
                message="Opravdu chcete tuto položku trvale odstranit? Tato akce je nevratná."
                theme={theme}
            />
        </div>
    );
};

/** Detail prop firmy: souhrn, důkazy výplat a historie nákupů a výplat. */
function FirmDetailModal({ summary, expenses, payouts, accountOf, formatValue, signed, firmKeys, renderTile, onClose }: {
    summary?: FirmSummary;
    expenses: BusinessExpense[];
    payouts: BusinessPayout[];
    accountOf: (p: BusinessPayout) => Account | undefined;
    formatValue: (v: number) => string;
    signed: (v: number) => string;
    firmKeys: string[];
    renderTile: (p: BusinessPayout) => React.ReactNode;
    onClose: () => void;
}) {
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);
    if (!summary) return null;
    const roi = summary.cost > 0 ? Math.round((summary.paid / summary.cost) * 100) : null;
    const accountsBought = expenses.reduce((s, e) => s + accountCountInLabel(e.label), 0);
    const events = [
        ...expenses.map(e => ({ id: e.id, date: e.date, kind: 'cost' as const, text: e.label, value: -(Number(e.amount) || 0) / expenseFirmKeys(e, firmKeys).length })),
        ...payouts.map(p => ({ id: p.id, date: p.date, kind: 'payout' as const, text: accountOf(p)?.name || 'Neznámý účet', value: Number(p.amount) || 0 })),
    ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    const stat = (label: string, value: React.ReactNode, tone = 'text-[var(--text-primary)]') => (
        <div className="min-w-0 px-3 py-2.5"><p className="text-[11px] font-semibold text-[var(--text-secondary)]">{label}</p><p className={`mt-0.5 font-mono text-base font-bold ${tone}`}>{value}</p></div>
    );

    return createPortal(
        <div className="fixed inset-0 z-[200] flex items-start justify-center overflow-y-auto bg-black/50 p-4 pt-[6vh]" onMouseDown={onClose}>
            <div role="dialog" aria-modal="true" aria-label={firmDisplayName(summary.key)} className="glass-modal w-full max-w-[760px] overflow-hidden" onMouseDown={e => e.stopPropagation()}>
                <header className="flex items-center gap-3 border-b border-[var(--border-subtle)] px-4 py-3">
                    <FirmMark firm={summary.key} size={36} />
                    <div className="min-w-0">
                        <h2 className="text-[15px] font-bold text-[var(--text-primary)]">{firmDisplayName(summary.key)}</h2>
                        <p className="text-xs text-[var(--text-secondary)]">{summary.purchases} {plural(summary.purchases, 'nákup', 'nákupy', 'nákupů')} · {summary.payouts} {plural(summary.payouts, 'výplata', 'výplaty', 'výplat')} · ~{accountsBought} {plural(accountsBought, 'účet', 'účty', 'účtů')}</p>
                    </div>
                    <button type="button" onClick={onClose} aria-label="Zavřít" className={`${btnGhost} ml-auto w-[30px] px-0`}><X size={16} /></button>
                </header>
                <div className="grid gap-3.5 px-4 py-3.5">
                    <div className="grid grid-cols-2 overflow-hidden rounded-md border border-[var(--border-subtle)] sm:grid-cols-4 [&>div:nth-child(2)]:border-l [&>div:nth-child(4)]:border-l [&>div:nth-child(n+3)]:border-t sm:[&>div:nth-child(3)]:border-l sm:[&>div:nth-child(n+3)]:border-t-0 [&>div]:border-[var(--border-subtle)]">
                        {stat('Náklady', formatValue(summary.cost))}
                        {stat('Výplaty', formatValue(summary.paid), 'text-emerald-500')}
                        {stat('Čistě', signed(summary.net), summary.net >= 0 ? 'text-emerald-500' : 'text-rose-500')}
                        {stat('Návratnost', roi == null ? '—' : `${roi} %`, roi == null ? 'text-[var(--text-muted)]' : roi >= 100 ? 'text-emerald-500' : 'text-rose-500')}
                    </div>
                    <div className="grid gap-1.5">
                        <p className="text-[11.5px] font-semibold text-[var(--text-secondary)]">Důkazy výplat</p>
                        {payouts.length ? <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{payouts.map(p => renderTile(p))}</div>
                            : <p className="rounded-md border border-dashed border-[var(--border-subtle)] px-3 py-3 text-xs text-[var(--text-secondary)]">Od {firmDisplayName(summary.key)} zatím žádná výplata.</p>}
                    </div>
                    <div className="grid gap-1.5">
                        <p className="text-[11.5px] font-semibold text-[var(--text-secondary)]">Historie</p>
                        <div className="max-h-[320px] overflow-y-auto">
                            {events.map(ev => (
                                <div key={`${ev.kind}-${ev.id}`} className="grid grid-cols-[52px_1fr_auto] items-center gap-2.5 border-b border-[var(--border-subtle)] py-2 text-[12.5px] last:border-b-0">
                                    <span className="font-mono text-[11.5px] text-[var(--text-muted)]">{shortDate(ev.date)}</span>
                                    <span className="min-w-0 truncate text-[var(--text-primary)]">
                                        <span className={`mr-1.5 inline-block rounded px-1.5 text-[10.5px] font-semibold ${ev.kind === 'payout' ? 'bg-emerald-500/15 text-emerald-500' : 'bg-rose-500/10 text-rose-500'}`}>{ev.kind === 'payout' ? 'výplata' : 'nákup'}</span>
                                        {ev.text}
                                    </span>
                                    <span className={`font-mono text-xs font-bold ${ev.value >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>{signed(ev.value)}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            </div>
        </div>,
        document.body,
    );
}

export default BusinessHub;
