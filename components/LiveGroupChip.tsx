import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import {
  followerInCopy,
  participatingFollowers,
  targetAccount,
  type LiveTradeAccount,
  type LiveTradeGroup,
  type LiveTradeMoney,
  type LiveTradeTarget,
} from '../lib/liveTradeTarget';
import type { LiveStatusTone } from '../services/liveStatusStrip';
import { chartGlassMenu } from '../services/chartGlass';
import { formatUsd } from './LiveOrderTicket';

/**
 * Čip skupiny v liště živého grafu a přehled účtů pod ním. Jen zobrazení —
 * zapnutí, vypnutí i nastavení kopírky zůstávají na Live Dashboardu
 * (INV-UI-02). Účty jsou zatím ukázková data (jen dev build) s výrazným
 * štítkem; skutečný stav kopírky ukazuje vedle samostatná pilulka ze stavu
 * workeru. Pozice se neukazují („—“), dokud je nedodá worker — nikdy „flat“.
 */

const TONE_TEXT: Record<LiveStatusTone, string> = {
  muted: 'text-slate-500', ok: 'text-emerald-500', warn: 'text-amber-600', danger: 'text-rose-500',
};

interface Props {
  isDark: boolean;
  group: LiveTradeGroup;
  target: LiveTradeTarget;
  /** Skutečný stav kopírky (chip „Kopírka“ ze stavové lišty LIVE). */
  copierChip: { value: string; tone: LiveStatusTone } | null;
  onOpenDashboard: () => void;
}

const LiveGroupChip: React.FC<Props> = ({ isDark, group, target, copierChip, onOpenDashboard }) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', escape); };
  }, [open]);

  const picked = targetAccount(group, target);
  const muted = isDark ? 'text-slate-400' : 'text-slate-500';
  const ink = isDark ? 'text-slate-100' : 'text-slate-900';
  const line = isDark ? 'border-white/[0.08]' : 'border-slate-900/[0.08]';
  const followers = participatingFollowers(group).length;
  const sampleTag = <span className="rounded bg-amber-500/20 px-1.5 py-px text-[9px] font-black uppercase tracking-[0.06em] text-amber-600">ukázka</span>;

  const status = (account: LiveTradeAccount): { text: string; tone: string; dot: string } => {
    if (picked?.id === account.id) return { text: 'single', tone: 'text-violet-500', dot: 'bg-violet-500' };
    if (account.role === 'leader') return { text: 'leader', tone: muted, dot: 'bg-blue-500' };
    if (account.role === 'outside') return { text: 'mimo skupinu', tone: muted, dot: 'bg-slate-400' };
    if (account.excluded) return { text: 'vyřazen', tone: muted, dot: 'bg-slate-400' };
    if (account.inactiveReason) return { text: 'nekopíruje', tone: 'text-amber-600', dot: 'bg-amber-500' };
    return { text: 've skupině', tone: muted, dot: 'bg-slate-400' };
  };
  const row = (account: LiveTradeAccount) => {
    const s = status(account);
    const money = (value: LiveTradeMoney, signed: boolean) => (value.value == null
      ? <span className={`text-right font-mono text-[10.5px] ${muted}`} title={value.note ?? 'Neznámo'}>—</span>
      : <span
        className={`text-right font-mono text-[10.5px] ${value.stale ? 'opacity-55' : ''} ${signed ? (value.value < 0 ? 'text-rose-500' : 'text-emerald-500') : ink}`}
        title={[value.stale ? 'Poslední známá hodnota, ne čerstvá' : null, value.note].filter(Boolean).join(' · ') || undefined}
      >{formatUsd(signed ? value.value : Math.max(0, value.value), signed)}</span>);
    return <div key={account.id} className={`grid grid-cols-[1.4fr_.7fr_.85fr_.85fr_minmax(78px,.9fr)] items-center gap-1.5 border-t px-2.5 py-[7px] text-[11px] ${line}`}>
      <span className={`flex min-w-0 items-center gap-1.5 truncate font-extrabold ${ink}`}>
        <i className={`h-[7px] w-[7px] shrink-0 rounded-full ${s.dot}`} />{account.name}
        {account.role === 'leader' && <em className={`text-[8.5px] font-extrabold not-italic uppercase tracking-[0.06em] ${muted}`}>leader</em>}
        {followerInCopy(account) && account.multiplier !== 1 && <em className={`text-[8.5px] font-extrabold not-italic ${muted}`}>×{account.multiplier}</em>}
      </span>
      <span className={`truncate font-mono text-[10.5px] ${account.position ? ink : muted}`} title={account.position ?? 'Pozice neověřené (staré nebo chybějící čtení)'}>{account.position ?? '—'}</span>
      {money(account.dayPnl, true)}
      {money(account.dayRemaining, false)}
      <span className={`whitespace-nowrap text-right text-[10px] font-extrabold ${s.tone}`} title={account.inactiveReason ?? undefined}>{s.text}</span>
    </div>;
  };

  return <div ref={rootRef} className="relative">
    <button
      type="button"
      onClick={() => setOpen(value => !value)}
      aria-haspopup="dialog"
      aria-expanded={open}
      title={group.sample ? 'Účty skupiny kopírky (ukázková data)' : 'Účty skupiny kopírky'}
      className={`flex h-[30px] items-center gap-2 whitespace-nowrap rounded-lg border px-2.5 text-[11px] font-bold ${line} ${open ? (isDark ? 'bg-white/10 text-white' : 'bg-white text-slate-950') : `${isDark ? 'text-slate-300 hover:bg-white/[0.06]' : 'text-slate-600 hover:bg-white/70'}`}`}
    >
      {group.sample && sampleTag}
      {picked
        ? <><i className="h-[7px] w-[7px] rounded-full bg-violet-500" />Jen {picked.name}</>
        : <>{group.leader.name} · leader → {followers}</>}
      <ChevronDown size={11} className={muted} />
    </button>
    {open && <div role="dialog" aria-label="Účty skupiny kopírky" className={`absolute right-0 top-[calc(100%+6px)] z-[90] grid w-[480px] gap-2 rounded-xl p-2.5 ${chartGlassMenu(isDark)}`}>
      <div className="flex items-center gap-2">
        <b className={`flex-1 text-[12.5px] font-black ${ink}`}>Účty skupiny</b>
        {copierChip && <span className={`text-[10.5px] font-extrabold ${TONE_TEXT[copierChip.tone]}`}>Kopírka: {copierChip.value}</span>}
      </div>
      {group.sample && <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-[10.5px] font-bold leading-snug text-amber-600">
        Ukázková data (vývojový přepínač) — jména účtů, dnešní výsledky a limity jsou vymyšlené.
      </div>}
      <div className={`grid overflow-hidden rounded-[10px] border ${isDark ? 'border-white/10 bg-white/[0.04]' : 'border-slate-900/10 bg-white/70'}`}>
        <div className={`grid grid-cols-[1.4fr_.7fr_.85fr_.85fr_minmax(78px,.9fr)] gap-1.5 px-2.5 py-1.5 text-[9px] font-extrabold uppercase tracking-[0.08em] ${muted}`}>
          <span>Účet</span><span>Pozice</span><span className="text-right">Dnes</span><span className="text-right">Do limitu</span><span className="text-right">Role</span>
        </div>
        {[group.leader, ...group.followers].map(row)}
        {group.outside.length > 0 && <div className={`border-t px-2.5 py-[5px] text-[8.5px] font-black uppercase tracking-[0.1em] ${line} ${muted} ${isDark ? 'bg-white/[0.02]' : 'bg-slate-900/[0.02]'}`}>Mimo skupinu</div>}
        {group.outside.map(row)}
      </div>
      <div className="flex items-center gap-2">
        <span className={`flex-1 text-[10px] leading-snug ${muted}`}>Zapnutí, vypnutí, nastavení a incidenty kopírky jsou na Live Dashboardu.</span>
        <button type="button" onClick={() => { setOpen(false); onOpenDashboard(); }} className={`h-[30px] whitespace-nowrap rounded-lg border px-3 text-[11px] font-extrabold ${line} ${isDark ? 'text-slate-200 hover:bg-white/[0.08]' : 'text-slate-700 hover:bg-white'}`}>Live Dashboard →</button>
      </div>
    </div>}
  </div>;
};

export default LiveGroupChip;
