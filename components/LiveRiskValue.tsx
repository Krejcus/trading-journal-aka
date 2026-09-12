import { readRiskDisplaySession, writeRiskDisplaySession } from '../lib/riskDisplaySessionCache';
import { useEffect, useMemo, useState } from 'react';
import { retainedRiskDisplay, type RetainedRiskDisplay } from '../lib/retainedRiskDisplay';
const number = new Intl.NumberFormat('en-US', {maximumFractionDigits:0});
export function LiveRiskValue(props: {
  identity: string; storageScope?: string; enabled: boolean; value: number | null; confirmedAt: string | null;
  verified: boolean; legacy?: boolean; color: (value:number)=>string; label: string; detail?: string;
}) {
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
  if (props.legacy) return <span className={`text-xs tabular-nums font-bold ${props.color(props.value ?? 0)}`}>{props.enabled && props.value != null && Number.isFinite(props.value) ? number.format(props.value) : '—'}</span>;
  if (!display && props.enabled) return <span role="status" aria-label={`Načítám ${props.label}`} className="inline-block h-2 w-9 rounded bg-[var(--border-subtle)]" />;
  return <span data-risk-display={display ? stale ? 'last-known' : 'verified' : 'unavailable'}
    className={`text-xs tabular-nums font-bold ${!display ? 'text-[var(--text-secondary)]' : props.color(display.value)}`}
    title={display ? `${props.label}${stale ? ' · poslední známá hodnota, aktuální risk není ověřen' : ''} · ${new Date(display.confirmedAt).toLocaleString('cs-CZ')}${!stale && props.detail ? ' · '+props.detail : ''}` : undefined}
  >{display ? number.format(display.value) : '—'}</span>;
}
