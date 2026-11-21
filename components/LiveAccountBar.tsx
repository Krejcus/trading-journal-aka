// Horní lišta LIVE grafu: výběr účtu nebo kopírovací skupiny a P&L dne (účet + skupina).
// JEN ZOBRAZENÍ: výběr mění, čí čísla lišta ukazuje. Na který účet graf posílá příkazy, se tady
// nemění a nic odtud neodchází (INV-UI-*: nic zobrazovacího nesmí autorizovat příkaz).
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Layers, Search } from 'lucide-react';

export type LiveBarAccountStatus = 'active' | 'dll-locked' | 'breached' | 'unverifiable';

export interface LiveBarAccount {
  id: string;
  name: string;
  firm: string;
  /** Realizovaný P&L dne v USD (z vyplnění). */
  realizedToday: number;
  status?: LiveBarAccountStatus;
}

export interface LiveBarGroupFollower {
  accountId: string;
  /** Poměr k leaderovi (×0,5 …). */
  ratio: number;
  /** Follower dostává kopie (zapnutý a způsobilý). */
  copying: boolean;
}

export type LiveBarGroupState = 'ARMED' | 'DISARMED' | 'HALTED' | 'KILL';

export interface LiveBarGroup {
  id: string;
  name: string;
  leaderId: string;
  followers: readonly LiveBarGroupFollower[];
  state: LiveBarGroupState;
}

export interface LiveAccountBarData {
  accounts: readonly LiveBarAccount[];
  groups: readonly LiveBarGroup[];
  /** Účet, na který graf skutečně obchoduje (jeho otevřený P&L známe z pozice). */
  tradedAccountId: string;
}

export type LiveBarSelection = { kind: 'account'; id: string } | { kind: 'group'; id: string };

/**
 * Otevřený P&L účtu: obchodovaný účet má P&L z pozice; follower skupiny, kterou ten účet vede a která
 * je ARMED, nese stejný obchod v poměru. Ostatní účty nemají v tomto grafu známou pozici (0).
 */
export function liveBarOpenPnl(data: LiveAccountBarData, accountId: string, tradedOpenPnl: number | null): number {
  const open = tradedOpenPnl ?? 0;
  if (accountId === data.tradedAccountId) return open;
  const group = data.groups.find(item => item.leaderId === data.tradedAccountId && item.state === 'ARMED');
  const follower = group?.followers.find(item => item.accountId === accountId);
  return follower?.copying ? open * follower.ratio : 0;
}

/** P&L dne účtu = realizovaný + otevřený. */
export function liveBarAccountDay(data: LiveAccountBarData, accountId: string, tradedOpenPnl: number | null): number {
  const account = data.accounts.find(item => item.id === accountId);
  return (account?.realizedToday ?? 0) + liveBarOpenPnl(data, accountId, tradedOpenPnl);
}

/** P&L dne skupiny = leader + všichni followeři (i vypnutí, jejich dnešní výsledek k ní patří). */
export function liveBarGroupDay(data: LiveAccountBarData, group: LiveBarGroup, tradedOpenPnl: number | null): number {
  return [group.leaderId, ...group.followers.map(item => item.accountId)]
    .reduce((sum, id) => sum + liveBarAccountDay(data, id, tradedOpenPnl), 0);
}

/** Skupina, do které účet patří (jako leader nebo follower). */
export function liveBarGroupOf(data: LiveAccountBarData, accountId: string): LiveBarGroup | null {
  return data.groups.find(item => item.leaderId === accountId || item.followers.some(f => f.accountId === accountId)) ?? null;
}

const usd = (value: number) => `${value >= 0 ? '+' : '−'}${Math.abs(Math.round(value)).toLocaleString('cs-CZ')} USD`;
const tone = (value: number) => (value >= 0 ? 'text-emerald-500' : 'text-rose-500');
const STATE_DOT: Record<LiveBarGroupState, string> = { ARMED: 'bg-emerald-500', DISARMED: 'bg-amber-500', HALTED: 'bg-rose-500', KILL: 'bg-rose-500' };
const STATUS_TEXT: Partial<Record<LiveBarAccountStatus, string>> = { 'dll-locked': 'limit dne', breached: 'breached', unverifiable: 'neověřitelný' };

interface Props {
  data: LiveAccountBarData;
  /** Otevřený P&L obchodovaného účtu v USD (z pozice v grafu); null = bez pozice. */
  openPnl: number | null;
  isDark: boolean;
}

const LiveAccountBar: React.FC<Props> = ({ data, openPnl, isDark }) => {
  const [selection, setSelection] = useState<LiveBarSelection>({ kind: 'account', id: data.tradedAccountId });
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'accounts' | 'groups'>('accounts');
  const [query, setQuery] = useState('');
  const box = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (box.current && !box.current.contains(event.target as Node)) setOpen(false); };
    const esc = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);

  const accounts = useMemo(() => new Map(data.accounts.map(item => [item.id, item])), [data.accounts]);
  const selectedGroup = selection.kind === 'group' ? data.groups.find(item => item.id === selection.id) ?? null : null;
  const shownAccountId = selectedGroup ? selectedGroup.leaderId : selection.id;
  const shownAccount = accounts.get(shownAccountId) ?? null;
  const group = selectedGroup ?? liveBarGroupOf(data, shownAccountId);
  const accountDay = liveBarAccountDay(data, shownAccountId, openPnl);
  const groupDay = group ? liveBarGroupDay(data, group, openPnl) : null;
  const copying = group ? group.followers.filter(item => item.copying).length : 0;
  const traded = accounts.get(data.tradedAccountId);

  const q = query.trim().toLowerCase();
  const firms = useMemo(() => {
    const map = new Map<string, LiveBarAccount[]>();
    for (const item of data.accounts) {
      if (q && !`${item.name} ${item.firm}`.toLowerCase().includes(q)) continue;
      map.set(item.firm, [...(map.get(item.firm) ?? []), item]);
    }
    return [...map.entries()];
  }, [data.accounts, q]);

  const chip = `flex h-[30px] items-center gap-1.5 whitespace-nowrap rounded-lg border px-2.5 text-[11px] font-bold ${isDark ? 'border-white/10 bg-white/[0.04]' : 'border-slate-200 bg-white/70'}`;
  const panel = isDark ? 'border-white/10 bg-[#0d1219] text-slate-200' : 'border-slate-200 bg-white text-slate-800';
  const muted = isDark ? 'text-slate-500' : 'text-slate-400';
  const rowHover = isDark ? 'hover:bg-white/[0.06]' : 'hover:bg-slate-100';
  const rowOn = 'bg-indigo-500/12 ring-1 ring-inset ring-indigo-500/40';

  const roleText = (id: string) => {
    const g = liveBarGroupOf(data, id);
    if (!g) return 'samostatný účet';
    return g.leaderId === id ? `leader skupiny ${g.name}` : `follower ve skupině ${g.name}`;
  };

  return (
    <div ref={box} className="relative flex items-center gap-1" data-live-account-bar>
      <span className={chip} title={`P&L dne účtu ${shownAccount?.name ?? ''}: realizované + otevřené`} data-live-bar-account-pnl>
        <span className={muted}>{selectedGroup ? 'Leader dnes' : 'Dnes'}</span>
        <b className={`font-mono font-extrabold ${tone(accountDay)}`}>{usd(accountDay)}</b>
      </span>
      {group && groupDay !== null && <button type="button" onClick={() => { setTab('groups'); setOpen(true); }} className={`${chip} ${isDark ? 'hover:bg-white/[0.07]' : 'hover:bg-white'}`}
        title={`Skupina ${group.name} · ${group.state} · ${copying} kopíruje · P&L dne všech účtů skupiny`} data-live-bar-group-pnl>
        <i className={`h-[7px] w-[7px] rounded-full ${STATE_DOT[group.state]}`} />
        <Layers size={12} className={muted} />{group.name}
        <b className={`font-mono font-extrabold ${tone(groupDay)}`}>{usd(groupDay)}</b>
      </button>}
      <button type="button" onClick={() => setOpen(value => !value)} aria-expanded={open} data-live-bar-picker
        className="flex h-[30px] items-center gap-1.5 whitespace-nowrap rounded-lg border border-indigo-500/50 bg-indigo-500/10 px-2.5 text-[11px] font-extrabold text-indigo-400 hover:bg-indigo-500/20">
        {selectedGroup ? <><Layers size={12} />{selectedGroup.name}<span className="font-bold opacity-70">1 → {selectedGroup.followers.length}</span></>
          : <><span className="rounded bg-indigo-500/20 px-1.5 py-px text-[10px]">{shownAccount?.firm ?? '—'}</span>{shownAccount?.name ?? shownAccountId}</>}
        <ChevronDown size={12} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <div role="dialog" aria-label="Výběr účtu nebo skupiny" className={`absolute right-0 top-[calc(100%+6px)] z-[95] w-[420px] rounded-xl border p-2 shadow-2xl ${panel}`} data-live-bar-menu>
        <div className={`flex gap-1 rounded-lg p-0.5 ${isDark ? 'bg-white/[0.05]' : 'bg-slate-100'}`}>
          {(['accounts', 'groups'] as const).map(id => <button key={id} type="button" onClick={() => { setTab(id); setQuery(''); }}
            className={`h-8 flex-1 rounded-md text-[12px] font-extrabold ${tab === id ? isDark ? 'bg-white/10 text-white' : 'bg-white text-slate-900 shadow-sm' : muted}`}>
            {id === 'accounts' ? `Účty ${data.accounts.length}` : `Kopírovací skupiny ${data.groups.length}`}</button>)}
        </div>
        <label className={`mt-2 flex h-8 items-center gap-2 rounded-lg border px-2.5 ${isDark ? 'border-white/10 bg-white/[0.03]' : 'border-slate-200'}`}>
          <Search size={13} className={muted} />
          <input value={query} onChange={event => setQuery(event.target.value)} placeholder={tab === 'accounts' ? 'Hledat účet nebo propku…' : 'Hledat skupinu…'} className="w-full bg-transparent text-[12px] outline-none" />
        </label>
        <div className="mt-1 max-h-[380px] overflow-y-auto pr-0.5">
          {tab === 'accounts' ? firms.map(([firm, list]) => <div key={firm}>
            <div className={`flex items-center px-2 pb-1 pt-2.5 text-[10px] font-extrabold uppercase tracking-[0.08em] ${muted}`}>{firm}<span className="ml-auto">{list.length}</span></div>
            {list.map(item => {
              const day = liveBarAccountDay(data, item.id, openPnl);
              const dead = item.status === 'breached';
              const on = selection.kind === 'account' && selection.id === item.id;
              return <button key={item.id} type="button" disabled={dead} onClick={() => { setSelection({ kind: 'account', id: item.id }); setOpen(false); }}
                className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left disabled:opacity-40 ${on ? rowOn : rowHover}`} data-live-bar-account={item.id}>
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-indigo-500/80 text-[10px] font-black text-white">{item.firm.slice(0, 2).toUpperCase()}</span>
                <span className="min-w-0 flex-1"><b className="block truncate text-[12.5px]">{item.name}</b>
                  <span className={`block truncate text-[11px] ${muted}`}>{dead ? 'vyřazený · do LIVE nejde' : roleText(item.id)}{item.id === data.tradedAccountId ? ' · obchoduje graf' : ''}</span></span>
                <span className="flex flex-col items-end gap-0.5">
                  <b className={`font-mono text-[12px] ${tone(day)}`}>{usd(day)}</b>
                  {item.status && STATUS_TEXT[item.status] && <span className={`rounded px-1.5 text-[9.5px] font-extrabold ${item.status === 'dll-locked' ? 'bg-amber-500/15 text-amber-500' : 'bg-rose-500/15 text-rose-500'}`}>{STATUS_TEXT[item.status]}</span>}
                </span>
              </button>;
            })}
          </div>) : data.groups.filter(item => !q || `${item.name} ${accounts.get(item.leaderId)?.name ?? ''}`.toLowerCase().includes(q)).map(item => {
            const day = liveBarGroupDay(data, item, openPnl);
            const on = selection.kind === 'group' && selection.id === item.id;
            const inPos = item.followers.filter(f => f.copying).length;
            return <button key={item.id} type="button" onClick={() => { setSelection({ kind: 'group', id: item.id }); setOpen(false); }}
              className={`mb-1.5 block w-full rounded-lg border px-3 py-2.5 text-left ${isDark ? 'border-white/10' : 'border-slate-200'} ${on ? rowOn : rowHover}`} data-live-bar-group={item.id}>
              <span className="flex items-center gap-2"><i className={`h-2 w-2 rounded-full ${STATE_DOT[item.state]}`} /><b className="text-[13px]">{item.name}</b>
                <span className={`rounded px-1.5 text-[9.5px] font-extrabold ${item.state === 'ARMED' ? 'bg-emerald-500/15 text-emerald-500' : item.state === 'DISARMED' ? 'bg-amber-500/15 text-amber-500' : 'bg-rose-500/15 text-rose-500'}`}>{item.state}</span>
                <b className={`ml-auto font-mono text-[12.5px] ${tone(day)}`}>{usd(day)}</b></span>
              <span className={`mt-1 block text-[11px] ${muted}`}>Leader {accounts.get(item.leaderId)?.name ?? item.leaderId} → {item.followers.length} účtů · {inPos} kopíruje</span>
              <span className="mt-2 flex flex-wrap gap-[3px]">
                <i className="h-2.5 w-4 rounded-[3px] bg-indigo-500" title="leader" />
                {item.followers.map(f => {
                  const st = accounts.get(f.accountId)?.status;
                  const color = st === 'breached' || st === 'unverifiable' ? 'bg-rose-500' : st === 'dll-locked' ? 'bg-amber-500' : f.copying ? 'bg-emerald-500' : isDark ? 'bg-white/15' : 'bg-slate-300';
                  return <i key={f.accountId} className={`h-2.5 w-2.5 rounded-[3px] ${color}`} title={accounts.get(f.accountId)?.name ?? f.accountId} />;
                })}
              </span>
            </button>;
          })}
        </div>
        <p className={`mt-1 border-t px-1.5 pt-2 text-[11px] leading-snug ${muted} ${isDark ? 'border-white/10' : 'border-slate-200'}`}>
          Výběr mění jen to, čí P&L lišta ukazuje. Graf obchoduje dál účet {traded?.name ?? data.tradedAccountId}.
        </p>
      </div>}
    </div>
  );
};

export default LiveAccountBar;
