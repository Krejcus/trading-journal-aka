import { describe, expect, it, vi } from 'vitest';
import { handleNativeCors } from '../server/nativeCors';

function response() {
  const headers = new Map<string, string>();
  const res = {
    setHeader: vi.fn((key: string, value: string) => headers.set(key, value)),
    status: vi.fn(),
    end: vi.fn(),
  } as any;
  res.status.mockReturnValue(res);
  return { res, headers };
}

describe('handleNativeCors', () => {
  it('allows only the Capacitor origin', () => {
    const { res, headers } = response();
    const handled = handleNativeCors(
      { method: 'OPTIONS', headers: { origin: 'capacitor://localhost' } } as any,
      res,
      ['POST'],
    );
    expect(handled).toBe(true);
    expect(headers.get('Access-Control-Allow-Origin')).toBe('capacitor://localhost');
    expect(res.status).toHaveBeenCalledWith(204);
  });

  it('rejects an unknown preflight origin', () => {
    const { res, headers } = response();
    handleNativeCors(
      { method: 'OPTIONS', headers: { origin: 'https://evil.example' } } as any,
      res,
      ['POST'],
    );
    expect(headers.has('Access-Control-Allow-Origin')).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('Capacitor dostane Max-Age a smí číst Server-Timing; cizí origin nic', () => {
    const native = response();
    handleNativeCors({ method: 'OPTIONS', headers: { origin: 'capacitor://localhost' } } as any, native.res, ['GET']);
    expect(native.headers.get('Access-Control-Max-Age')).toBe('600');
    expect(native.headers.get('Access-Control-Expose-Headers')).toBe('Server-Timing');
    expect(native.headers.get('Access-Control-Allow-Headers')).toBe('Authorization, Content-Type');
    const foreign = response();
    handleNativeCors({ method: 'OPTIONS', headers: { origin: 'https://evil.example' } } as any, foreign.res, ['GET']);
    expect(foreign.headers.has('Access-Control-Max-Age')).toBe(false);
    expect(foreign.headers.has('Access-Control-Expose-Headers')).toBe(false);
    const missing = response();
    handleNativeCors({ method: 'GET', headers: {} } as any, missing.res, ['GET']);
    expect(missing.headers.size).toBe(0);
  });
});
