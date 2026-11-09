import { AsyncLocalStorage } from 'node:async_hooks';
import type { TradovateRequestPurpose } from '../lib/tradovateRequestControl';

/** Per-async-operation classification; parallel background jobs cannot borrow a write's exemption. */
const purpose = new AsyncLocalStorage<TradovateRequestPurpose>();
export const tradovateRequestContext = {
  current: () => purpose.getStore(),
  accepted<T>(run: () => Promise<T>): Promise<T> { return purpose.run('management', run); },
};
