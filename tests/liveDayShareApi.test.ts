import type { VercelRequest, VercelResponse } from '@vercel/node';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({
  createLiveDayShareAdminClient: vi.fn(() => ({})),
  readPublicLiveDayShareRow: vi.fn(),
  publicLiveDayShareFromRow: vi.fn(),
  resolveLiveDayShareOrigin: vi.fn(() => 'https://app.example.com'),
}));
vi.mock('../server/liveDayShareStore', () => store);

import handler from '../api/live-day-share/[token]';

const token = '11111111-1111-4111-8111-111111111111';
const snapshot = {
  token,
  tradeDate: '2026-09-21',
  owner: { name: 'Filip', avatar: null },
  summary: {
    rows: [{ accountId: 1, name: 'LFF0••••0007', firm: 'Lucid', value: 1584, state: 'confirmed', stale: false }],
    confirmed: 1584, confirmedCount: 1, accountCount: 1, partial: false, stale: false, noTradeCount: 0, unconfirmedCount: 0,
  },
  trades: 1,
  losingTrades: 0,
  theme: 'light',
  createdAt: '2026-09-21T10:00:00.000Z',
};

const responseHarness = () => {
  let statusCode = 200;
  let body: unknown;
  const headers = new Map<string, string>();
  const res = {
    setHeader: vi.fn((name: string, value: string) => headers.set(name, value)),
    status: vi.fn((code: number) => { statusCode = code; return res; }),
    json: vi.fn((value: unknown) => { body = value; return res; }),
    send: vi.fn((value: unknown) => { body = value; return res; }),
  } as unknown as VercelResponse;
  return { res, status: () => statusCode, body: () => body, headers };
};

const request = (query: Record<string, string>, accept = 'text/html') => ({
  method: 'GET', query, headers: { accept },
} as unknown as VercelRequest);

describe('LIVE day share endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.readPublicLiveDayShareRow.mockResolvedValue({ preview_path: `owner/${token}.png` });
    store.publicLiveDayShareFromRow.mockReturnValue(snapshot);
    store.resolveLiveDayShareOrigin.mockReturnValue('https://app.example.com');
  });

  it('returns only the sanitized public contract to the app', async () => {
    const harness = responseHarness();
    await handler(request({ token, format: 'json' }, 'application/json'), harness.res);
    expect(harness.status()).toBe(200);
    expect(harness.body()).toEqual(snapshot);
    expect(JSON.stringify(harness.body())).not.toContain('preview_path');
  });

  it('builds a rich preview and redirects a human to the interactive card', async () => {
    const harness = responseHarness();
    await handler(request({ token }), harness.res);
    const html = String(harness.body());
    expect(harness.status()).toBe(200);
    expect(html).toContain(`property="og:image" content="https://app.example.com/api/live-day-share-image/${token}"`);
    expect(html).toContain(`?dayShare=${token}`);
    expect(html).toContain('1200');
    expect(html).toContain('630');
  });

  it('člověku ukáže čitelnou stránku místo holého JSONu', async () => {
    // Nejčastější příčina: k odkazu se ve zprávě přilepila tečka, takže token
    // v adrese přestal být platné UUID. Příjemce nesmí skončit na {"error":…}.
    const damaged = responseHarness();
    await handler(request({ token: `${token}.` }), damaged.res);
    expect(damaged.status()).toBe(400);
    const page = String(damaged.body());
    expect(page).toContain('Odkaz je poškozený');
    expect(page).not.toContain('invalid-share-token');
    expect(damaged.headers.get('Content-Type')).toContain('text/html');
    expect(store.readPublicLiveDayShareRow).not.toHaveBeenCalled();

    store.readPublicLiveDayShareRow.mockResolvedValueOnce(null);
    store.publicLiveDayShareFromRow.mockReturnValueOnce(null);
    const gone = responseHarness();
    await handler(request({ token }), gone.res);
    expect(gone.status()).toBe(404);
    expect(String(gone.body())).toContain('Tato karta už není dostupná');
  });

  it('stroji zůstává JSON — crawler i appka se ptají přes Accept/format', async () => {
    const harness = responseHarness();
    await handler(request({ token: `${token}.` }, 'application/json'), harness.res);
    expect(harness.status()).toBe(400);
    expect(harness.body()).toEqual({ error: 'invalid-share-token' });
  });

  it('rejects guessed paths and missing shares without querying private data', async () => {
    const invalid = responseHarness();
    await handler(request({ token: '../private' }, 'application/json'), invalid.res);
    expect(invalid.status()).toBe(400);
    expect(store.readPublicLiveDayShareRow).not.toHaveBeenCalled();

    store.readPublicLiveDayShareRow.mockResolvedValueOnce(null);
    store.publicLiveDayShareFromRow.mockReturnValueOnce(null);
    const missing = responseHarness();
    await handler(request({ token }, 'application/json'), missing.res);
    expect(missing.status()).toBe(404);
  });
});
