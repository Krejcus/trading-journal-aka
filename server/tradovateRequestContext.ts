import { AsyncLocalStorage } from 'node:async_hooks';
import type { TradovateRequestPurpose } from '../lib/tradovateRequestControl';

/** Per-async-operation classification; parallel background jobs cannot borrow a write's exemption. */
type RequestScope = TradovateRequestPurpose | { active: boolean; parent: RequestScope | undefined };
const purpose = new AsyncLocalStorage<RequestScope>();
const current = (): TradovateRequestPurpose | undefined => {
  let scope = purpose.getStore();
  while (scope && typeof scope !== 'string') { if (scope.active) return 'control'; scope = scope.parent; }
  return typeof scope === 'string' ? scope : undefined;
};
export const tradovateRequestContext = {
  current,
  accepted<T>(run: () => Promise<T>): Promise<T> { return purpose.run('management', run); },
  risk<T>(run: () => Promise<T>): Promise<T> { return current() === 'management' ? run() : purpose.run('risk', run); },
  recovery<T>(run: () => Promise<T>): Promise<T> {
    const lease = { active: true, parent: purpose.getStore() };
    // ALS descendants outlive run(): expired priority must not leak into a
    // settlement timer or recovery job scheduled by the maintenance operation.
    return purpose.run(lease, async () => { try { return await run(); } finally { lease.active = false; } });
  },
};
