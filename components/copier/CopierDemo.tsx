// UKÁZKA kopírky se smyšlenými daty — jen ve vývojové appce (localhost) a v appce v iPhonu; na produkčním webu se nenačítá.
// Slouží k ladění vzhledu: před obchodem, v obchodu, po obchodu, problém. Nic tu není skutečné a nic odsud
// neodchází: akce mění jen stav v paměti této záložky (INV-UI-01 — zobrazení nikdy nepovoluje příkaz).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { copierGates, copierGroupMembers, copierOpenPnl, type CopierAccount, type CopierGroup, type CopierGroupState, type CopierView } from '../../lib/rithmicCopierView';
import type { LiveDaySummary } from '../../lib/liveDaySummary';
import { LiveDayCard } from '../LiveDayCard';
import { RithmicCopierPhone, RithmicCopierScreen, type CopierActions } from './RithmicCopierScreen';
import type { CopierNewGroup } from './CopierParts';

export type CopierDemoScenario = 'before' | 'trade' | 'after' | 'problem';
export const COPIER_DEMO_SCENARIOS: Array<{ id: CopierDemoScenario; label: string }> = [
  { id: 'before', label: 'Před obchodem' }, { id: 'trade', label: 'V obchodu' }, { id: 'after', label: 'Po obchodu' }, { id: 'problem', label: 'Problém' },
];

const ENTRY = 21412.25, SL = 21398, TP = 21440, PV = 2;

interface Seed { id: string; name: string; firm: string; size: 50 | 100; ratio: number; first: number; slip: number; status?: CopierAccount['status']; off?: boolean; ddLeft: number; group?: 'main' | 'apex' | 'bulenox' | null }
/** `first` = výsledek prvního (ztrátového) obchodu dne na jeden kontrakt leadera; `slip` = skluz vstupu v bodech. */
const SEEDS: Seed[] = [
  { id: 'L1', name: 'Lucid Flex 50K •001', firm: 'LucidTrading', size: 50, ratio: 1, first: -62, slip: 0, ddLeft: 1840 },
  { id: 'L2', name: 'Lucid Flex 50K •002', firm: 'LucidTrading', size: 50, ratio: 1, first: -64, slip: 0.25, ddLeft: 1715 },
  { id: 'L3', name: 'Lucid Flex 50K •003', firm: 'LucidTrading', size: 50, ratio: 1, first: -66, slip: 0.5, ddLeft: 610 },
  { id: 'L4', name: 'Lucid Flex 50K •004', firm: 'LucidTrading', size: 50, ratio: 1, first: -62, slip: 0, ddLeft: 1420 },
  { id: 'L5', name: 'Lucid Flex 50K •005', firm: 'LucidTrading', size: 50, ratio: 0.5, first: -32, slip: 0.25, ddLeft: 1990 },
  { id: 'L7', name: 'Lucid Pro 100K •007', firm: 'LucidTrading', size: 100, ratio: 2, first: -126, slip: 0.25, ddLeft: 2870 },
  { id: 'A1', name: 'Apex 50K •117', firm: 'Apex', size: 50, ratio: 1, first: -66, slip: 0.5, ddLeft: 1150 },
  { id: 'A2', name: 'Apex 50K •118', firm: 'Apex', size: 50, ratio: 1, first: -64, slip: 0.25, ddLeft: 1680 },
  { id: 'L9', name: 'Lucid Flex 50K •009', firm: 'LucidTrading', size: 50, ratio: 1, first: -1000, slip: 0, status: 'dll-locked', off: true, ddLeft: 880 },
  { id: 'L12', name: 'Lucid Flex 50K •012', firm: 'LucidTrading', size: 50, ratio: 1, first: 0, slip: 0, off: true, ddLeft: 1750 },
  // skupina Apex (2 followeři → schéma s čarou ke každému)
  { id: 'A40', name: 'Apex 100K •140', firm: 'Apex', size: 100, ratio: 1, first: -58, slip: 0, ddLeft: 2610, group: 'apex' },
  { id: 'A41', name: 'Apex 50K •141', firm: 'Apex', size: 50, ratio: 0.5, first: -30, slip: 0.25, ddLeft: 1540, group: 'apex' },
  { id: 'A42', name: 'Apex 50K •142', firm: 'Apex', size: 50, ratio: 0.5, first: -31, slip: 0.5, ddLeft: 1880, group: 'apex' },
  // skupina Bulenox (1 follower)
  { id: 'B01', name: 'Bulenox 50K •B01', firm: 'Bulenox', size: 50, ratio: 1, first: 0, slip: 0, ddLeft: 1930, group: 'bulenox' },
  { id: 'B02', name: 'Bulenox 50K •B02', firm: 'Bulenox', size: 50, ratio: 1, first: 0, slip: 0, ddLeft: 1990, group: 'bulenox' },
  // volné účty (v žádné skupině) — pro průvodce novou skupinou
  { id: 'L13', name: 'Lucid Flex 50K •013', firm: 'LucidTrading', size: 50, ratio: 1, first: 0, slip: 0, ddLeft: 1750, group: null },
  { id: 'L14', name: 'Lucid Flex 50K •014', firm: 'LucidTrading', size: 50, ratio: 1, first: 0, slip: 0, ddLeft: 1750, group: null },
  { id: 'B03', name: 'Bulenox 50K •B03', firm: 'Bulenox', size: 50, ratio: 1, first: 0, slip: 0, ddLeft: 1990, group: null },
  { id: 'A50', name: 'Apex 50K •150', firm: 'Apex', size: 50, ratio: 1, first: 0, slip: 0, ddLeft: 2000, group: null },
];
const inGroup = (s: Seed, g: 'main' | 'apex' | 'bulenox') => (s.group === undefined ? 'main' : s.group) === g;
/** Kdo v jaké skupině obchoduje ve kterém scénáři: Hlavní vždy, Apex jen v obchodu a po něm, Bulenox dnes stojí. */
const ACTIVE: Record<CopierDemoScenario, Array<'main' | 'apex' | 'bulenox'>> = { before: [], trade: ['main', 'apex'], after: ['main', 'apex'], problem: ['main'] };
const LEADER = 'L1', LEADER_QTY = 2;

const START_STATE: Record<CopierDemoScenario, CopierGroupState> = { before: 'disarmed', trade: 'armed', after: 'armed', problem: 'halted' };

function build(scenario: CopierDemoScenario): CopierView {
  const accounts: Record<string, CopierAccount> = {};
  for (const s of SEEDS) {
    const lead = s.id === LEADER || s.id === 'A40' || s.id === 'B01', max = s.size === 100 ? 4 : 3;
    const qty = lead ? LEADER_QTY : Math.min(max, Math.max(1, Math.round(LEADER_QTY * s.ratio)));
    // Účet zamčený denním limitem patří jen do scénáře „Problém“; jinde je to obyčejný vypnutý follower.
    const locked = scenario === 'problem' && s.status === 'dll-locked';
    const active = (['main', 'apex', 'bulenox'] as const).some(g => inGroup(s, g) && ACTIVE[scenario].includes(g));
    const trades = active && (!s.off || locked);
    const inPos = active && (scenario === 'trade' || scenario === 'problem') && !s.off;
    const avg = ENTRY + s.slip;
    // Po obchodu: druhý obchod dne došel na TP.
    const win = scenario === 'after' && active && !s.off ? Math.round((TP - avg) * qty * PV) : 0;
    const realized = scenario === 'before' ? 0 : (trades ? s.first : 0) + win;
    accounts[s.id] = {
      id: s.id, name: s.name, firm: s.firm, balance: s.size * 1000 + (s.ddLeft - (s.size === 100 ? 3000 : 2000)) + realized,
      realizedToday: realized, dailyLossLimit: s.size === 100 ? 1500 : 1000, drawdownLeft: Math.max(0, s.ddLeft + Math.min(0, realized)), drawdownMax: s.size === 100 ? 3000 : 2000,
      position: inPos ? { side: 'long', quantity: lead || s.id === 'A40' ? LEADER_QTY : qty, averagePrice: avg, stop: SL, target: TP } : null,
      status: locked ? 'dll-locked' : 'active', copyOn: lead || !s.off, ratio: s.ratio, maxContracts: max, latencyMs: lead ? null : 58 + ((s.id.charCodeAt(1) * 13) % 70),
    };
  }
  if (scenario === 'problem') {
    accounts.L3 = { ...accounts.L3, position: { ...accounts.L3.position!, stop: null, target: null } };
    accounts.A1 = { ...accounts.A1, brokerQuantity: accounts.A1.position!.quantity + 1 };
  }
  const members = (g: 'main' | 'apex' | 'bulenox') => SEEDS.filter(s => inGroup(s, g)).map(s => s.id);
  const groups: CopierGroup[] = [
    { id: 'main', name: 'Hlavní', leaderId: LEADER, followerIds: members('main').filter(id => id !== LEADER), state: START_STATE[scenario] },
    { id: 'apex', name: 'Apex', leaderId: 'A40', followerIds: members('apex').filter(id => id !== 'A40'), state: ACTIVE[scenario].includes('apex') ? 'armed' : 'disarmed' },
    { id: 'bulenox', name: 'Bulenox', leaderId: 'B01', followerIds: members('bulenox').filter(id => id !== 'B01'), state: 'disarmed' },
  ];
  return { accounts, groups, pointValue: PV, price: ENTRY + 6 };
}

/** Karta dne z ukázkových účtů: realizovaný výsledek dne po účtech skupiny. */
function daySummary(view: CopierView, scenario: CopierDemoScenario): LiveDaySummary {
  const rows = view.groups.flatMap(copierGroupMembers).map((id, index) => {
    const a = view.accounts[id];
    const traded = scenario !== 'before' && (a.realizedToday ?? 0) !== 0;
    return { accountId: index + 1, name: a.name, firm: a.firm, value: traded ? a.realizedToday : null, state: traded ? 'confirmed' as const : 'no-trades' as const, stale: false };
  }).sort((x, y) => ((x.value == null) !== (y.value == null) ? (x.value == null ? 1 : -1) : (y.value ?? 0) - (x.value ?? 0)));
  const confirmed = rows.filter(r => r.value != null);
  return {
    rows, confirmed: confirmed.length ? confirmed.reduce((sum, r) => sum + r.value!, 0) : null, confirmedCount: confirmed.length, accountCount: rows.length,
    partial: false, stale: false, noTradeCount: rows.length - confirmed.length, unconfirmedCount: 0,
  };
}

const today = (): string => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

export default function CopierDemo({ scenario, narrow, isDark }: { scenario: CopierDemoScenario; narrow: boolean; isDark: boolean }) {
  const [view, setView] = useState<CopierView>(() => build(scenario));
  const ref = useRef(view); ref.current = view;
  const [day, setDay] = useState(false), [toast, setToast] = useState('');
  useEffect(() => { const v = build(scenario); ref.current = v; setView(v); }, [scenario]);
  const moving = Object.values(view.accounts).some(a => a.position);
  useEffect(() => {
    if (!moving) return undefined;
    const t = window.setInterval(() => setView(v => ({ ...v, price: Math.min(TP - 2, Math.max(SL + 3, Math.round(((v.price ?? ENTRY) + (Math.random() - 0.47) * 1.5) * 4) / 4)) })), 700);
    return () => window.clearInterval(t);
  }, [moving]);
  const say = useCallback((text: string) => { setToast(text); window.setTimeout(() => setToast(t => (t === text ? '' : t)), 3500); }, []);
  const patch = useCallback((fn: (v: CopierView) => CopierView) => setView(v => { const n = fn(v); ref.current = n; return n; }), []);
  const actions: CopierActions = useMemo(() => {
    const acc = (v: CopierView, id: string, p: Partial<CopierAccount>): CopierView => ({ ...v, accounts: { ...v.accounts, [id]: { ...v.accounts[id], ...p } } });
    const grp = (v: CopierView, id: string, p: Partial<CopierGroup>): CopierView => ({ ...v, groups: v.groups.map(g => (g.id === id ? { ...g, ...p } : g)) });
    const find = (id: string) => ref.current.groups.find(g => g.id === id)!;
    const close = (v: CopierView, id: string): CopierView => { const a = v.accounts[id]; return a?.position ? acc(v, id, { realizedToday: Math.round((a.realizedToday ?? 0) + copierOpenPnl(a, v.price, v.pointValue)), position: null, brokerQuantity: undefined }) : v; };
    return {
      onArm: (gid) => { const bad = copierGates(ref.current, find(gid)).find(g => !g.ok); if (bad) return { ok: false, gate: bad }; patch(x => grp(x, gid, { state: 'armed' })); return { ok: true }; },
      onDisarm: (gid) => patch(x => grp(x, gid, { state: 'disarmed' })),
      onKill: () => { patch(x => { const on = x.groups.some(g => g.state === 'kill'); return { ...x, groups: x.groups.map(g => ({ ...g, state: on ? 'disarmed' : 'kill' })) }; }); say('Ukázka: zastavení všech skupin (dalším klikem zrušíš).'); },
      onToggleCopy: (id) => { const a = ref.current.accounts[id]; if (a.copyOn && a.position) { say(`${a.name} má pozici, vypnout teď nejde.`); return; } patch(x => acc(x, id, { copyOn: !a.copyOn })); },
      onBulk: (_g, action, ids, value) => patch(x => ids.reduce((v, id) => (action === 'ratio' ? acc(v, id, { ratio: value ?? 1 }) : v.accounts[id].position && action === 'off' ? v : acc(v, id, { copyOn: action === 'on' })), x)),
      onTemplate: (gid, ratio, max) => { patch(x => find(gid).followerIds.reduce((v, id) => acc(v, id, { ratio, maxContracts: max }), x)); say(`Ukázka: followeři ×${ratio}, strop ${max}.`); },
      onFlatten: (gid) => { patch(x => grp(copierGroupMembers(find(gid)).reduce(close, x), gid, { state: 'disarmed' })); say('Ukázka: pozice skupiny zavřené.'); },
      onFixProtection: (id) => { patch(x => { const a = x.accounts[id]; return a.position ? acc(x, id, { position: { ...a.position, stop: SL, target: TP } }) : x; }); say('Ukázka: SL/TP doplněno podle leadera.'); },
      onClosePosition: (id) => { patch(x => close(x, id)); say('Ukázka: pozice účtu zavřená.'); },
      onDisableAccount: (id) => patch(x => acc(x, id, { copyOn: false })),
      onOpenDay: () => setDay(true),
      onCreateGroup: (g: CopierNewGroup) => {
        patch(x => {
          const withRules = g.followerIds.reduce((v, id) => acc(v, id, { ratio: g.ratio, maxContracts: g.maxContracts, copyOn: true }), x);
          return { ...withRules, groups: [...withRules.groups, { id: `new-${Date.now()}`, name: g.name, leaderId: g.leaderId, followerIds: g.followerIds, state: 'disarmed' }] };
        });
        say(`Ukázka: skupina ${g.name} založená (vypnutá).`);
      },
      onRenameGroup: (gid, name) => patch(x => grp(x, gid, { name })),
      onDeleteGroup: (gid) => { const name = find(gid)?.name; patch(x => ({ ...x, groups: x.groups.filter(g => g.id !== gid) })); say(`Ukázka: skupina ${name} smazaná, účty jsou volné.`); },
    };
  }, [patch, say]);
  const note = <><b>UKÁZKOVÁ DATA</b> — účty, pozice i čísla jsou smyšlené, skutečný účet tu teď není vidět a nic se nikam neposílá.{toast && <span style={{ marginLeft: 10, color: '#fde68a' }}>{toast}</span>}</>;
  return <>
    {narrow ? <RithmicCopierPhone view={view} actions={actions} isDark={isDark} note={note} /> : <RithmicCopierScreen view={view} actions={actions} isDark={isDark} note={note} />}
    {day && createPortal(
      <div role="dialog" aria-modal="true" aria-label="Karta dne (ukázka)" className="live-day-overlay fixed inset-0 z-[155] overflow-y-auto p-4 sm:p-7" onMouseDown={e => { if (e.target === e.currentTarget) setDay(false); }}>
        <div className="mx-auto flex min-h-full w-full max-w-[940px] items-center justify-center"><div className="w-full">
          <LiveDayCard summary={daySummary(view, scenario)} owner={{ name: 'Ukázka' }} tradeDate={today()} trades={scenario === 'before' ? 0 : scenario === 'after' ? 2 : 1} losingTrades={scenario === 'before' ? 0 : 1} formatName={n => n} onClose={() => setDay(false)} />
        </div></div>
      </div>, document.body)}
  </>;
}
