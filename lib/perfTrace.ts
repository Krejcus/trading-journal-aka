import { isNativeBuild } from '../utils/runtimeConfig';
import { alphaTradeNativePlugin } from '../services/alphaTradeNativePlugin';

/**
 * Časové značky výkonu pro měření na iPhonu. Do nativního logu jde jen název
 * fáze (omezená abeceda) a celé milisekundy — nikdy data, tokeny ani URL
 * s parametry. Na webu jen s `localStorage['at:dev:perf'] = '1'`.
 *
 * - `perfMark(name)`: okamžik od začátku načtení stránky (performance.now()).
 * - `perfDuration(name, ms)`: trvání (např. čekání na přihlášení u požadavku).
 */
const NAME = /^[a-z0-9:._-]{1,80}$/;
const MAX_ENTRIES = 400;

type PerfEntry = { name: string; ms: number; kind: 'mark' | 'dur' };
declare global {
  interface Window { __atPerf?: PerfEntry[] }
}

let enabledCache: boolean | null = null;
const enabled = (): boolean => {
  if (enabledCache != null) return enabledCache;
  let flag = false;
  try { flag = typeof localStorage !== 'undefined' && localStorage.getItem('at:dev:perf') === '1'; } catch { /* blocked */ }
  enabledCache = isNativeBuild || flag;
  return enabledCache;
};

let originSent = false;
const send = (name: string, ms: number) => {
  if (!isNativeBuild) return;
  void alphaTradeNativePlugin.perfTrace({ name, ms }).catch(() => undefined);
};

const record = (entry: PerfEntry) => {
  if (typeof window === 'undefined') return;
  const list = (window.__atPerf ??= []);
  if (list.length >= MAX_ENTRIES) return;
  list.push(entry);
  if (!originSent) {
    originSent = true;
    // Zarovnání s časy systémového logu: začátek načtení v ms od půlnoci UTC.
    send('origin:utc-ms-of-day', Math.round(performance.timeOrigin % 86_400_000));
  }
  send(entry.kind === 'dur' ? `${entry.name}:dur` : entry.name, entry.ms);
};

export const perfSlug = (value: string): string => value.toLowerCase()
  .replace(/^\/api\//, '').replace(/\?.*$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'x';

export function perfMark(name: string): void {
  if (!enabled() || !NAME.test(name) || typeof performance === 'undefined') return;
  record({ name, ms: Math.round(performance.now()), kind: 'mark' });
}

/** Značka jen při prvním výskytu (např. první vykreslení). */
const once = new Set<string>();
export function perfMarkOnce(name: string): void {
  if (once.has(name)) return;
  once.add(name);
  perfMark(name);
}

export function perfDuration(name: string, ms: number): void {
  if (!enabled() || !NAME.test(name) || !Number.isFinite(ms) || ms < 0) return;
  record({ name, ms: Math.round(ms), kind: 'dur' });
}

/** Server-Timing z odpovědi (`auth;dur=12, db;dur=80`) → `srv:<slug>:<metrika>`. */
export function perfServerTiming(slug: string, header: string | null): void {
  if (!header || !enabled()) return;
  for (const part of header.split(',')) {
    const [rawName, ...params] = part.trim().split(';');
    const metric = perfSlug(rawName ?? '');
    const dur = params.map(p => p.trim()).find(p => p.startsWith('dur='));
    if (metric && dur) perfDuration(`srv:${slug}:${metric}`, Number(dur.slice(4)));
  }
}
