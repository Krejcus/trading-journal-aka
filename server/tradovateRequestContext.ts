import { AsyncLocalStorage } from 'node:async_hooks';
import type { TradovateRequestPurpose } from '../lib/tradovateRequestControl';

/** Per-async-operation classification; parallel background jobs cannot borrow a write's exemption. */
type RequestLease = { active: boolean; parent: RequestScope | undefined; purpose: 'control' | 'management' };
type RequestScope = TradovateRequestPurpose | RequestLease;
const purpose = new AsyncLocalStorage<RequestScope>();
const current = (): TradovateRequestPurpose | undefined => {
  let scope = purpose.getStore();
  while (scope && typeof scope !== 'string') { if (scope.active) return scope.purpose; scope = scope.parent; }
  return typeof scope === 'string' ? scope : undefined;
};
const insideActiveLease = (leasePurpose: RequestLease['purpose']): boolean => {
  let scope = purpose.getStore();
  while (scope && typeof scope !== 'string') { if (scope.active) return scope.purpose === leasePurpose; scope = scope.parent; }
  return false;
};
const leased = <T>(leasePurpose: RequestLease['purpose'], run: () => Promise<T>): Promise<T> => {
  const lease: RequestLease = { active: true, parent: purpose.getStore(), purpose: leasePurpose };
  // ALS descendants outlive run(): expired priority must not leak into a
  // settlement timer or recovery job scheduled by the maintenance operation.
  return purpose.run(lease, async () => { try { return await run(); } finally { lease.active = false; } });
};
export const tradovateRequestContext = {
  current,
  accepted<T>(run: () => Promise<T>): Promise<T> { return purpose.run('management', run); },
  // Ustupuje jen trvalému accepted scope. Uvnitř vyhasínajícího lifecycle čtení si risk
  // čtení zakládá vlastní třídu, jinak by po vyhasnutí spadlo do background.
  risk<T>(run: () => Promise<T>): Promise<T> { return current() === 'management' && !insideActiveLease('management') ? run() : purpose.run('risk', run); },
  recovery<T>(run: () => Promise<T>): Promise<T> { return leased('control', run); },
  /**
   * Jedno ohraničené lifecycle čtení (dotažení OrderVersion ze streamu, stavové čtení pro
   * přijatou expozici) třídou accepted — jen když volající nemá vlastní třídu.
   * Na rozdíl od `accepted` po doběhnutí vyhasne: posluchač nebo časovač spuštěný uvnitř
   * čtení nezdědí výjimku z rozpočtu natrvalo.
   */
  lifecycleRead<T>(run: () => Promise<T>): Promise<T> { return current() === undefined ? leased('management', run) : run(); },
};
