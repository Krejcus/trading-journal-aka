// Simulace kopírky Rithmic pro zkušební stránky (jen paměť prohlížeče, žádná služba ani broker).
// Účty a skupiny vychází z ukázkových účtů lišty LIVE; ceny, pozice a akce jsou smyšlené.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SIMULATION_ACCOUNT_BAR } from './rithmic-simulation-accounts';
import { copierGates, copierOpenPnl, type CopierAccount, type CopierGroup, type CopierView } from '../../lib/rithmicCopierView';
import type { CopierActions } from '../../components/copier/RithmicCopierScreen';

const ENTRY = 21412.25, SL = 21398, TP = 21440, PV = 2;

function initial(): CopierView {
  const bar = SIMULATION_ACCOUNT_BAR;
  const main = bar.groups[0];
  const accounts: Record<string, CopierAccount> = {};
  let seed = 7; const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  for (const a of bar.accounts) {
    const big = /100K/.test(a.name);
    const f = main.followers.find(x => x.accountId === a.id);
    const isLead = a.id === main.leaderId;
    const status = a.status ?? 'active';
    const copyOn = isLead ? true : f ? (f.copying || status === 'unverifiable') : true;
    const ratio = f?.ratio ?? 1, max = big ? 4 : 3;
    const inMain = isLead || Boolean(f);
    const qty = Math.min(max, Math.max(1, Math.round(2 * ratio)));
    const hasPos = inMain && copyOn && (isLead || status === 'active');
    accounts[a.id] = {
      id: a.id, name: a.name, firm: a.firm, balance: (big ? 100000 : 50000) + Math.round((rnd() * 2600 - 300) / 5) * 5,
      realizedToday: a.realizedToday ?? 0, dailyLossLimit: a.dailyLossLimit ?? null, drawdownLeft: a.maxLossLeft ?? null, drawdownMax: big ? 3000 : 2000,
      position: hasPos ? { side: 'long', quantity: isLead ? 2 : qty, averagePrice: isLead ? ENTRY : ENTRY + Math.round(rnd() * 2) * 0.25, stop: SL, target: TP } : null,
      status, copyOn, ratio, maxContracts: max, latencyMs: 62 + Math.round(rnd() * 80),
    };
  }
  // leader simulace má propku jako většina followerů (jinak by všude svítilo „jiná propka“)
  if (accounts['LOCAL-SIM']) accounts['LOCAL-SIM'] = { ...accounts['LOCAL-SIM'], firm: 'LucidTrading' };
  const groups: CopierGroup[] = [
    { id: main.id, name: main.name, leaderId: main.leaderId, followerIds: main.followers.map(x => x.accountId), state: 'disarmed' },
    ...bar.groups.slice(1).map(g => ({ id: g.id, name: g.name, leaderId: g.leaderId, followerIds: g.followers.map(x => x.accountId), state: 'disarmed' as const })),
  ];
  return { accounts, groups, pointValue: PV, price: ENTRY + 4 };
}

export function useCopierSimulation(): { view: CopierView; actions: CopierActions; sim: { unprotect: () => void; mismatch: () => void; reset: () => void; note: string } } {
  const [view, setView] = useState<CopierView>(initial);
  const ref = useRef(view); ref.current = view;
  const [note, setNote] = useState('');
  const toast = (t: string) => { setNote(t); window.setTimeout(() => setNote(n => (n === t ? '' : n)), 3500); };
  // cena: náhodná procházka
  useEffect(() => {
    const t = window.setInterval(() => setView(v => ({ ...v, price: Math.round(((v.price ?? ENTRY) + (Math.random() - 0.48) * 1.5) * 4) / 4 })), 600);
    return () => window.clearInterval(t);
  }, []);
  const patch = useCallback((fn: (v: CopierView) => CopierView) => setView(v => { const n = fn(v); ref.current = n; return n; }), []);
  const acc = (v: CopierView, id: string, p: Partial<CopierAccount>): CopierView => ({ ...v, accounts: { ...v.accounts, [id]: { ...v.accounts[id], ...p } } });
  const grp = (v: CopierView, id: string, p: Partial<CopierGroup>): CopierView => ({ ...v, groups: v.groups.map(g => (g.id === id ? { ...g, ...p } : g)) });
  const actions: CopierActions = useMemo(() => ({
    onArm: (gid) => {
      const v = ref.current, g = v.groups.find(x => x.id === gid)!;
      const bad = copierGates(v, g).find(x => !x.ok);
      if (bad) return { ok: false, gate: bad };
      patch(x => grp(x, gid, { state: 'armed' })); return { ok: true };
    },
    onDisarm: (gid) => patch(x => grp(x, gid, { state: 'disarmed' })),
    onKill: () => { patch(x => ({ ...x, groups: x.groups.map(g => ({ ...g, state: g.state === 'kill' ? 'disarmed' : 'kill' })) })); toast('Kill: nové riziko zablokované (v simulaci znovu klikem zrušíš).'); },
    onToggleCopy: (id) => {
      const a = ref.current.accounts[id];
      if (a.copyOn && a.position) { toast(`${a.name} má pozici, vypnout ho teď nejde.`); return; }
      if (!a.copyOn && ref.current.groups.some(g => g.state === 'armed' && g.followerIds.includes(id))) { toast('Zapnout followera jde jen u vypnuté kopírky.'); return; }
      patch(x => acc(x, id, { copyOn: !a.copyOn }));
    },
    onBulk: (_gid, action, ids, value) => patch(x => ids.reduce((v2, id) => action === 'ratio' ? acc(v2, id, { ratio: value ?? 1 }) : (v2.accounts[id].position && action === 'off') ? v2 : acc(v2, id, { copyOn: action === 'on' }), x)),
    onTemplate: (gid, ratio, max) => {
      const g = ref.current.groups.find(x => x.id === gid)!;
      if (g.state === 'armed') { toast('Šablonu jde použít jen u vypnuté kopírky.'); return; }
      patch(x => g.followerIds.reduce((v2, id) => acc(v2, id, { ratio, maxContracts: max }), x)); toast(`Followeři: ×${ratio}, strop ${max} MNQ.`);
    },
    onFlatten: (gid) => {
      const g = ref.current.groups.find(x => x.id === gid)!;
      patch(x => { let v2 = x; for (const id of [g.leaderId, ...g.followerIds]) { const a = v2.accounts[id]; if (!a?.position) continue; v2 = acc(v2, id, { realizedToday: Math.round(a.realizedToday + copierOpenPnl(a, v2.price, v2.pointValue)), position: null, brokerQuantity: undefined }); } return grp(v2, gid, { state: g.state === 'armed' ? 'disarmed' : g.state }); });
      toast('Všechny pozice skupiny zavřené, kopírka vypnutá.');
    },
    onFixProtection: (id) => { patch(x => { const a = x.accounts[id]; return a.position ? acc(x, id, { position: { ...a.position, stop: SL, target: TP } }) : x; }); toast('SL/TP doplněno podle leadera.'); },
    onClosePosition: (id) => { patch(x => { const a = x.accounts[id]; return acc(x, id, { realizedToday: Math.round(a.realizedToday + copierOpenPnl(a, x.price, x.pointValue)), position: null, brokerQuantity: undefined }); }); toast('Pozice účtu zavřená.'); },
    onDisableAccount: (id) => patch(x => acc(x, id, { copyOn: false })),
    onNewGroup: () => toast('Nová skupina: průvodce přijde s kopírkou ve službě.'),
  }), [patch]); // eslint-disable-line react-hooks/exhaustive-deps
  const sim = {
    note,
    unprotect: () => { const v = ref.current, g = v.groups[0], id = g.followerIds.find(i => v.accounts[i].position && v.accounts[i].position!.stop != null); if (id) { patch(x => acc(x, id, { position: { ...x.accounts[id].position!, stop: null, target: null } })); toast(`${v.accounts[id].name}: broker ochranu odmítl.`); } },
    mismatch: () => { const v = ref.current, g = v.groups[0], id = g.followerIds.find(i => v.accounts[i].position && v.accounts[i].brokerQuantity == null); if (id) { patch(x => grp(acc(x, id, { brokerQuantity: x.accounts[id].position!.quantity + 1 }), g.id, { state: 'halted' })); toast('Neshoda pozic: skupina zastavena.'); } },
    reset: () => { const v = initial(); ref.current = v; setView(v); },
  };
  return { view, actions, sim };
}

export function SimBar({ sim }: { sim: ReturnType<typeof useCopierSimulation>['sim'] }) {
  return (
    <div style={{ position: 'fixed', left: 12, bottom: 12, zIndex: 1000, display: 'flex', gap: 6, alignItems: 'center', padding: 6, borderRadius: 10, background: 'rgba(15,18,35,.92)', border: '1px solid rgba(255,255,255,.12)', font: '600 12px system-ui', color: '#cbd5e1' }}>
      <span style={{ padding: '0 4px', opacity: 0.7 }}>Simulace</span>
      <button type="button" className="cp-btn" onClick={sim.unprotect}>Účet bez SL/TP</button>
      <button type="button" className="cp-btn" onClick={sim.mismatch}>Neshoda</button>
      <button type="button" className="cp-btn" onClick={sim.reset}>Obnovit</button>
      {sim.note && <span style={{ padding: '0 6px', color: '#fde68a' }}>{sim.note}</span>}
    </div>
  );
}
