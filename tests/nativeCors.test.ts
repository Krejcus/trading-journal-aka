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
});
