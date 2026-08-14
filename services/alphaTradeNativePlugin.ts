import { registerPlugin } from '@capacitor/core';

/** One JS proxy for the single Swift plugin. Importing this module is idempotent. */
export const alphaTradeNativePlugin = registerPlugin<Record<string, (...args: any[]) => Promise<any>>>(
  'AlphaTradeNative',
);
