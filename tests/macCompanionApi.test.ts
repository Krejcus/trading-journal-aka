import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authMock = vi.hoisted(() => ({ getSession: vi.fn() }));

vi.mock('../services/supabase', () => ({
  supabase: { auth: { getSession: authMock.getSession } },
}));
vi.mock('../utils/runtimeConfig', () => ({
  apiUrl: (path: string) => `https://alpha.test${path}`,
}));

import {
  confirmMacCompanionPairing,
  formatMacCompanionPairingCode,
  isValidMacCompanionPairingCode,
  listMacCompanionDevices,
  normalizeMacCompanionPairingCode,
  renameMacCompanionDevice,
  revokeMacCompanionDevice,
} from '../services/macCompanionApi';

const device = {
  id: '11111111-1111-4111-8111-111111111111',
  deviceName: 'Filipův MacBook',
  createdAt: '2026-09-01T09:00:00.000Z',
  pairedAt: '2026-09-01T09:01:00.000Z',
  lastSeenAt: '2026-09-01T09:02:00.000Z',
  revokedAt: null,
};

const response = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

describe('Mac companion PWA API client', () => {
  beforeEach(() => {
    authMock.getSession.mockResolvedValue({
      data: { session: { access_token: 'supabase-session-token' } },
      error: null,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('normalizuje pouze 12 znaků Crockford abecedy a formátuje je po čtyřech', () => {
    expect(normalizeMacCompanionPairingCode(' 7k2d-p9hx-w3qm ')).toBe('7K2DP9HXW3QM');
    expect(formatMacCompanionPairingCode('7k2dp9hxw3qm')).toBe('7K2D-P9HX-W3QM');
    expect(formatMacCompanionPairingCode('ilou7k2dp9hxw3qm')).toBe('7K2D-P9HX-W3QM');
    expect(isValidMacCompanionPairingCode('7K2D-P9HX-W3QM')).toBe(true);
    expect(isValidMacCompanionPairingCode('7K2D-P9HI-W3QM')).toBe(false);
  });

  it('načítá allowlist zařízení jen přes přihlášený Bearer endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      devices: [{ ...device, secretHash: 'must-not-escape', pairingCodeHash: 'must-not-escape' }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const devices = await listMacCompanionDevices();
    expect(devices).toEqual([device]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://alpha.test/api/mac-companion/devices',
      expect.objectContaining({
        method: 'GET',
        credentials: 'same-origin',
        headers: expect.objectContaining({
          Accept: 'application/json',
          Authorization: 'Bearer supabase-session-token',
        }),
      }),
    );
    expect(JSON.stringify(devices)).not.toContain('must-not-escape');
  });

  it('potvrzuje pouze normalizovaný jednorázový kód a nikdy neposílá worker credential', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ paired: true, device }, 201));
    vi.stubGlobal('fetch', fetchMock);

    await expect(confirmMacCompanionPairing('7k2d-p9hx-w3qm')).resolves.toEqual(device);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://alpha.test/api/mac-companion/pairing/confirm');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual(expect.objectContaining({ Authorization: 'Bearer supabase-session-token' }));
    expect(JSON.parse(String(init.body))).toEqual({ pairingCode: '7K2DP9HXW3QM' });
    expect(JSON.stringify(init.headers)).not.toContain('Device ');
    expect(url).not.toContain('tradovate');
    expect(url).not.toContain('copier-relay');
  });

  it('přejmenování ořízne název a revokace posílá pouze id zařízení', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ device: { ...device, deviceName: 'Domácí Mac' } }))
      .mockResolvedValueOnce(response({ revoked: true, deviceId: device.id }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(renameMacCompanionDevice(device.id, '  Domácí Mac  ')).resolves.toMatchObject({ deviceName: 'Domácí Mac' });
    await expect(revokeMacCompanionDevice(device.id)).resolves.toBe(device.id);

    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({
      deviceId: device.id,
      deviceName: 'Domácí Mac',
    });
    expect(JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body))).toEqual({ deviceId: device.id });
  });

  it('bez přihlášené session nevolá žádný endpoint', async () => {
    authMock.getSession.mockResolvedValue({ data: { session: null }, error: null });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(listMacCompanionDevices()).rejects.toMatchObject({ code: 'missing-auth-token', status: 401 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
