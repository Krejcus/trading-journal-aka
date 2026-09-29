import { readRiskDisplaySession, writeRiskDisplaySession } from '../lib/riskDisplaySessionCache';
import { useEffect, useMemo, useState } from 'react';
import { retainedRiskDisplay, type RetainedRiskDisplay } from '../lib/retainedRiskDisplay';
import { formatReadAge } from '../lib/liveReadFreshness';
import type { LiveRiskDisplayState } from '../lib/liveBalanceDisplay';
const number = new Intl.NumberFormat('en-US', {maximumFractionDigits:0});
export function LiveRiskValue(props: {
  identity: string; storageScope?: string; enabled: boolean; value: number | null; confirmedAt: string | null;
  verified: boolean; legacy?: boolean; color: (value:number)=>string; label: string; detail?: string;
  state?: LiveRiskDisplayState; reason?: string | null;
  /** Velikost písma; výchozí `text-xs` drží desktopová tabulka. */
  sizeClass?: string;
}) {
  const size=props.sizeClass ?? 'text-xs';
  const restored=useMemo(()=>readRiskDisplaySession(props.storageScope,props.identity),[props.storageScope,props.identity]);
  const scopedKey=JSON.stringify([props.storageScope,props.identity]);
  const [previous,setPrevious]=useState<{scope:string;value:RetainedRiskDisplay|null}>({scope:scopedKey,value:restored});
  const base=previous.scope===scopedKey ? previous.value : restored;
  const display=retainedRiskDisplay(base,{key:props.identity,enabled:props.enabled,value:props.value,confirmedAt:props.confirmedAt,verified:props.verified});
  const amount=display?.value ?? null;
  const confirmedAt=display?.confirmedAt ?? null;
  const stale=display?.stale ?? true;
  useEffect(()=>{
    const next=amount!=null && confirmedAt ? {key:props.identity,value:amount,confirmedAt,stale} : null;
    setPrevious(old=>old.scope===scopedKey && old.value?.value===next?.value && old.value?.confirmedAt===next?.confirmedAt && old.value?.stale===next?.stale ? old : {scope:scopedKey,value:next});
    // Incomplete bootstrap never erases a cached amount; explicit disable does.
    if (next || !props.enabled) writeRiskDisplaySession(props.storageScope,props.identity,next);
  },[scopedKey,props.identity,props.storageScope,props.enabled,amount,confirmedAt,stale]);
  if (props.legacy) return <span className={`${size} tabular-nums font-bold ${props.color(props.value ?? 0)}`}>{props.enabled && props.value != null && Number.isFinite(props.value) ? number.format(props.value) : '—'}</span>;
  const state = display ? 'ready' : props.state ?? (props.enabled ? 'loading' : 'unavailable');
  if (!display && state === 'loading') return <span role="status" aria-label={`Načítám ${props.label}`} title={props.reason ?? undefined} className="inline-block h-2 w-9 rounded bg-[var(--border-subtle)]" />;
  if (!display) {
    const text = state === 'no-limit' ? 'bez limitu' : state === 'unknown-limit' ? 'limit neznámý' : 'nedostupné';
    return <span data-risk-display={state} className={`${size} tabular-nums font-bold text-[var(--text-secondary)]`} title={props.reason ?? undefined}>{text}</span>;
  }
  const age = Math.max(0, Date.now() - Date.parse(display.confirmedAt));
  return <span data-risk-display={display ? stale ? 'last-known' : 'verified' : 'unavailable'}
    className={`${size} tabular-nums font-bold ${stale ? 'text-[var(--text-secondary)]' : props.color(display.value)}`}
    title={`${props.label}${stale ? ` · poslední známá hodnota před ${formatReadAge(age)}, aktuální risk není ověřen` : ''} · ${new Date(display.confirmedAt).toLocaleString('cs-CZ')}${!stale && props.detail ? ' · '+props.detail : ''}`}
  >{display ? number.format(display.value) : '—'}</span>;
}
