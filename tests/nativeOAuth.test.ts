import { describe, expect, it } from 'vitest';
import { nativeOAuthErrorMessage, parseNativeOAuthCallback } from '../services/nativeOAuth';

describe('parseNativeOAuthCallback', () => {
  it('accepts only the dedicated native scheme', () => {
    expect(parseNativeOAuthCallback('alphatrade-lab://auth/callback?code=wrong')).toEqual({ kind: 'ignore' });
    expect(parseNativeOAuthCallback('https://example.test/?code=wrong')).toEqual({ kind: 'ignore' });
  });

  it('extracts a PKCE authorization code', () => {
    expect(parseNativeOAuthCallback('alphatrade-native://auth/callback?code=abc%20123')).toEqual({
      kind: 'code',
      code: 'abc 123',
    });
  });

  it('surfaces provider errors and missing codes', () => {
    expect(parseNativeOAuthCallback('alphatrade-native://auth/callback?error_description=Access%20denied')).toEqual({
      kind: 'error',
      message: 'Access denied',
    });
    expect(parseNativeOAuthCallback('alphatrade-native://auth/callback')).toEqual({
      kind: 'error',
      message: 'OAuth callback neobsahuje autorizační kód.',
    });
  });

  it('maps cancellation and callback failures to actionable Czech messages', () => {
    expect(nativeOAuthErrorMessage(new Error('Access denied by user'))).toBe('Přihlášení přes Google bylo zrušeno.');
    expect(nativeOAuthErrorMessage(new Error('redirect URL is not allowed'))).toContain('callback URL');
    expect(nativeOAuthErrorMessage(null)).toBe('Přihlášení přes Google se nepodařilo dokončit.');
  });
});
