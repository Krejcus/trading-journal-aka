import { describe, expect, it, vi } from 'vitest';

import { createNativeSecureAuthStorage } from '../services/nativeSecureStorage';

function legacyStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    storage: {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      removeItem: vi.fn((key: string) => values.delete(key)),
    },
  };
}

function vault(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    api: {
      secureGet: vi.fn(async ({ key }: { key: string }) => ({ value: values.get(key) ?? null })),
      secureSet: vi.fn(async ({ key, value }: { key: string; value: string }) => { values.set(key, value); }),
      secureRemove: vi.fn(async ({ key }: { key: string }) => { values.delete(key); }),
    },
  };
}

describe('native secure auth storage', () => {
  it('migrates a legacy session to Keychain before deleting it', async () => {
    const legacy = legacyStorage({ 'alphatrade-auth-token': 'session-json' });
    const secure = vault();
    const storage = createNativeSecureAuthStorage(legacy.storage as unknown as Storage, secure.api);

    await expect(storage.getItem('alphatrade-auth-token')).resolves.toBe('session-json');
    expect(secure.values.get('alphatrade-auth-token')).toBe('session-json');
    expect(legacy.values.has('alphatrade-auth-token')).toBe(false);
    expect(secure.api.secureSet.mock.invocationCallOrder[0]).toBeLessThan(legacy.storage.removeItem.mock.invocationCallOrder[0]);
  });

  it('does not delete the recoverable legacy session when Keychain write fails', async () => {
    const legacy = legacyStorage({ token: 'keep-me' });
    const secure = vault();
    secure.api.secureSet.mockRejectedValueOnce(new Error('locked'));
    const storage = createNativeSecureAuthStorage(legacy.storage as unknown as Storage, secure.api);

    await expect(storage.getItem('token')).rejects.toThrow('locked');
    expect(legacy.values.get('token')).toBe('keep-me');
  });

  it('prefers Keychain and clears both stores on sign-out', async () => {
    const legacy = legacyStorage({ token: 'stale' });
    const secure = vault({ token: 'current' });
    const storage = createNativeSecureAuthStorage(legacy.storage as unknown as Storage, secure.api);

    await expect(storage.getItem('token')).resolves.toBe('current');
    await storage.removeItem('token');
    expect(secure.values.has('token')).toBe(false);
    expect(legacy.values.has('token')).toBe(false);
  });

  it('falls back when the Capacitor vault is not registered yet', async () => {
    const legacy = legacyStorage({ token: 'boot-session' });
    const secure = vault();
    secure.api.secureGet.mockRejectedValueOnce({ code: 'UNIMPLEMENTED' });
    secure.api.secureSet.mockRejectedValueOnce({ code: 'UNIMPLEMENTED' });
    const storage = createNativeSecureAuthStorage(legacy.storage as unknown as Storage, secure.api);

    await expect(storage.getItem('token')).resolves.toBe('boot-session');
    await storage.setItem('token', 'new-session');
    expect(legacy.values.get('token')).toBe('new-session');
  });

  it('still surfaces genuine Keychain failures', async () => {
    const legacy = legacyStorage();
    const secure = vault();
    secure.api.secureGet.mockRejectedValueOnce({ code: 'SECURITY_ERROR', message: 'Keychain denied' });
    const storage = createNativeSecureAuthStorage(legacy.storage as unknown as Storage, secure.api);

    await expect(storage.getItem('token')).rejects.toMatchObject({ code: 'SECURITY_ERROR' });
  });
});
