import { alphaTradeNativePlugin } from './alphaTradeNativePlugin';

export interface AsyncStorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

interface SecureVault {
  secureGet(options: { key: string }): Promise<{ value: string | null }>;
  secureSet(options: { key: string; value: string }): Promise<void>;
  secureRemove(options: { key: string }): Promise<void>;
}

const AlphaTradeNative = alphaTradeNativePlugin as unknown as SecureVault;

function isUnavailableNativeVaultError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return candidate.code === 'UNIMPLEMENTED'
    || candidate.code === 'UNAVAILABLE'
    || (typeof candidate.message === 'string' && /not implemented|unimplemented|not available/i.test(candidate.message));
}

/**
 * Supabase auth storage for iOS. A legacy WebView value is deleted only after
 * the same value has been committed to Keychain, making migration recoverable.
 */
export function createNativeSecureAuthStorage(
  legacyStorage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
  vault: SecureVault = AlphaTradeNative,
): AsyncStorageLike {
  return {
    async getItem(key) {
      let secured: { value: string | null };
      try {
        secured = await vault.secureGet({ key });
      } catch (error) {
        if (!isUnavailableNativeVaultError(error)) throw error;
        return legacyStorage.getItem(key);
      }
      if (secured.value !== null) return secured.value;

      const legacyValue = legacyStorage.getItem(key);
      if (legacyValue === null) return null;
      await vault.secureSet({ key, value: legacyValue });
      legacyStorage.removeItem(key);
      return legacyValue;
    },
    async setItem(key, value) {
      try {
        await vault.secureSet({ key, value });
      } catch (error) {
        if (!isUnavailableNativeVaultError(error)) throw error;
        legacyStorage.setItem(key, value);
        return;
      }
      legacyStorage.removeItem(key);
    },
    async removeItem(key) {
      try {
        await vault.secureRemove({ key });
      } catch (error) {
        if (!isUnavailableNativeVaultError(error)) throw error;
      }
      legacyStorage.removeItem(key);
    },
  };
}
