import type { RetainedRiskDisplay } from './retainedRiskDisplay';
import { tradovateDisplayTradeDate } from './tradovateDisplayDay';
interface StorageLike { getItem(key:string):string|null; setItem(key:string,value:string):void; removeItem(key:string):void }
function storageSafe(): StorageLike | undefined {
  try { return typeof window === 'undefined' ? undefined : window.sessionStorage; } catch { return undefined; }
}
const storageKey=(scope:string,identity:string)=>'alphatrade:risk-display:v1:'+JSON.stringify([scope,identity]);
export function readRiskDisplaySession(scope:string|undefined,identity:string,storage=storageSafe(),now=Date.now()):RetainedRiskDisplay|null {
  if (!scope || !storage) return null;
  try {
    const raw=JSON.parse(storage.getItem(storageKey(scope,identity)) ?? 'null');
    const at=Date.parse(raw?.confirmedAt ?? '');
    if (!raw || raw.key!==identity || typeof raw.value!=='number' || !Number.isFinite(raw.value)
      || !Number.isFinite(at) || at>now+1000 || now-at>86400000
      || tradovateDisplayTradeDate(at)!==tradovateDisplayTradeDate(now)) return null;
    return {key:identity,value:raw.value,confirmedAt:raw.confirmedAt,stale:true};
  } catch { return null; }
}
export function writeRiskDisplaySession(scope:string|undefined,identity:string,value:RetainedRiskDisplay|null,storage=storageSafe()):void {
  if (!scope || !storage) return;
  try {
    if (!value) { storage.removeItem(storageKey(scope,identity)); return; }
    if (value.key!==identity || !Number.isFinite(value.value) || !Number.isFinite(Date.parse(value.confirmedAt))) return;
    storage.setItem(storageKey(scope,identity),JSON.stringify({key:identity,value:value.value,confirmedAt:value.confirmedAt}));
  } catch { /* A blocked/full cache must not interrupt the dashboard. */ }
}
