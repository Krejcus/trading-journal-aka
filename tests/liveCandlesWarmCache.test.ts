import { beforeEach, describe, expect, it, vi } from 'vitest';
import { preloadLiveCandles, loadLiveCandles } from '../services/liveCandles';

const mocks = vi.hoisted(() => ({
  userId: 'warm-user-0',
  download: vi.fn(),
}));

vi.mock('../services/supabase', () => ({
  supabase: {
    auth: { getSession: vi.fn(async () => ({ data: { session: { user: { id: mocks.userId } } } })) },
    storage: { from: vi.fn(() => ({ download: mocks.download })) },
  },
}));

const NOW = Date.UTC(2026, 9, 31, 9, 30, 0);
const file = () => new Blob([JSON.stringify({
  at: NOW,
  source: 'CME_MINI:MNQ1!',
  bars: [[Math.floor(NOW / 60_000) * 60, 31_000, 31_002, 30_999, 31_001, 10]],
})]);

describe('warm cache prvních LIVE svíček', () => {
  beforeEach(() => {
    mocks.userId = `warm-user-${crypto.randomUUID()}`;
    mocks.download.mockReset();
    mocks.download.mockResolvedValue({ data: file(), error: null });
  });

  it('přednačtený snapshot spotřebuje první graf bez druhého downloadu', async () => {
    await preloadLiveCandles('MNQ', NOW);
    const first = await loadLiveCandles('MNQ', NOW + 1_000);
    expect(first?.response.candles).toHaveLength(1);
    expect(mocks.download).toHaveBeenCalledOnce();

    await loadLiveCandles('MNQ', NOW + 2_000);
    expect(mocks.download).toHaveBeenCalledTimes(2);
  });

  it('otevření během rozpracovaného preloadu sdílí stejný request a nenechá kopii pro další poll', async () => {
    let resolveDownload: (value: { data: Blob; error: null }) => void = () => undefined;
    mocks.download.mockImplementationOnce(() => new Promise(resolve => { resolveDownload = resolve; }));
    const preload = preloadLiveCandles('MNQ', NOW);
    await vi.waitFor(() => expect(mocks.download).toHaveBeenCalledOnce());
    const open = loadLiveCandles('MNQ', NOW + 1);
    resolveDownload({ data: file(), error: null });
    await expect(Promise.all([preload, open])).resolves.toEqual([undefined, expect.objectContaining({ stale: false })]);
    expect(mocks.download).toHaveBeenCalledOnce();

    await loadLiveCandles('MNQ', NOW + 2);
    expect(mocks.download).toHaveBeenCalledTimes(2);
  });

  it('cache je svázaná s uživatelem a po 45 sekundách se nepoužije', async () => {
    await preloadLiveCandles('MNQ', NOW);
    mocks.userId = `other-${crypto.randomUUID()}`;
    await loadLiveCandles('MNQ', NOW + 1_000);
    expect(mocks.download).toHaveBeenCalledTimes(2);

    mocks.userId = `expiry-${crypto.randomUUID()}`;
    await preloadLiveCandles('MNQ', NOW);
    await loadLiveCandles('MNQ', NOW + 45_001);
    expect(mocks.download).toHaveBeenCalledTimes(4);
  });

  it('neúspěšný preload se necachuje a otevřený graf čtení normálně zopakuje', async () => {
    mocks.download
      .mockResolvedValueOnce({ data: null, error: { message: 'temporary' } })
      .mockResolvedValueOnce({ data: file(), error: null });
    await preloadLiveCandles('MNQ', NOW);
    await expect(loadLiveCandles('MNQ', NOW + 1)).resolves.toMatchObject({ stale: false });
    expect(mocks.download).toHaveBeenCalledTimes(2);
  });
});
