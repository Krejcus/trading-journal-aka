import { perfDuration } from '../lib/perfTrace';
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
  // Zrcadlo v paměti: auth-js čte session z úložiště u KAŽDÉHO požadavku (pod
  // zámkem), na iPhonu to byl bridge + Keychain pokaždé. Jediný zapisovatel
  // tohoto klíče je tento adaptér (widget má vlastní token), takže zrcadlo
  // je write-through a při chybě zápisu se zahodí.
  const mirror = new Map<string, string | null>();
  // Čtení zapíše do zrcadla jen tehdy, když mezitím neproběhl zápis/smazání.
  const generation = new Map<string, number>();
  const bump = (key: string) => generation.set(key, (generation.get(key) ?? 0) + 1);
  return {
    async getItem(key) {
      if (mirror.has(key)) return mirror.get(key) ?? null;
      const readGeneration = generation.get(key) ?? 0;
      const remember = (value: string | null) => {
        if ((generation.get(key) ?? 0) === readGeneration) mirror.set(key, value);
      };
      let secured: { value: string | null };
      const startedAt = typeof performance === 'undefined' ? 0 : performance.now();
      try {
        secured = await vault.secureGet({ key });
        if (startedAt) perfDuration('keychain:get', performance.now() - startedAt);
      } catch (error) {
        if (!isUnavailableNativeVaultError(error)) throw error;
        return legacyStorage.getItem(key);
      }
      if (secured.value !== null) {
        remember(secured.value);
        return secured.value;
      }

      const legacyValue = legacyStorage.getItem(key);
      if (legacyValue === null) {
        remember(null);
        return null;
      }
      await vault.secureSet({ key, value: legacyValue });
      legacyStorage.removeItem(key);
      remember(legacyValue);
      return legacyValue;
    },
    async setItem(key, value) {
      bump(key);
      mirror.delete(key);
      try {
        await vault.secureSet({ key, value });
      } catch (error) {
        if (!isUnavailableNativeVaultError(error)) throw error;
        legacyStorage.setItem(key, value);
        return;
      }
      legacyStorage.removeItem(key);
      mirror.set(key, value);
    },
    async removeItem(key) {
      bump(key);
      mirror.delete(key);
      try {
        await vault.secureRemove({ key });
      } catch (error) {
        if (!isUnavailableNativeVaultError(error)) throw error;
      }
      legacyStorage.removeItem(key);
      mirror.set(key, null);
    },
  };
}
