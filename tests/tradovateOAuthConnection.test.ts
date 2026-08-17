import { describe, expect, it } from 'vitest';
import { parseTradovateOAuthStatus } from '../services/tradovateOAuthConnection';

describe('Tradovate OAuth client response validation', () => {
  it('accepts a valid status response', () => {
    expect(parseTradovateOAuthStatus({
      connected: true,
      environment: 'demo',
      connections: [],
    })).toMatchObject({ connected: true, environment: 'demo', connections: [] });
  });

  it('rejects a Vite fallback or incomplete API response before UI filtering', () => {
    expect(() => parseTradovateOAuthStatus({})).toThrow('Vercel dev');
    expect(() => parseTradovateOAuthStatus(null)).toThrow('Vercel dev');
  });
});
