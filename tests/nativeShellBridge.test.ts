import { beforeEach, describe, expect, it, vi } from 'vitest';

const setShellTheme = vi.fn(() => Promise.resolve({ theme: 'light' }));
const reportRefreshComplete = vi.fn(() => Promise.resolve());
const setShellWorld = vi.fn(() => Promise.resolve({ world: 'backtest' }));
const setShellPage = vi.fn(() => Promise.resolve({ page: 'live' }));
const setShellReview = vi.fn(() => Promise.resolve({ open: true }));
const setShellReviewCount = vi.fn(() => Promise.resolve({ count: 3 }));
const getShellTabs = vi.fn(() => Promise.resolve({ slots: ['dashboard', 'history', 'live'] }));
const setShellTabs = vi.fn(() => Promise.resolve({ slots: ['dashboard', 'history', 'live'] }));

vi.mock('../utils/runtimeConfig', () => ({ isNativeBuild: true }));
vi.mock('../services/alphaTradeNativePlugin', () => ({
  alphaTradeNativePlugin: { setShellTheme, reportRefreshComplete, setShellWorld, setShellPage, setShellReview, setShellReviewCount, getShellTabs, setShellTabs },
}));

describe('native shell Capacitor bridge', () => {
  beforeEach(() => {
    setShellTheme.mockClear();
    reportRefreshComplete.mockClear();
    setShellWorld.mockClear();
    setShellPage.mockClear();
    getShellTabs.mockClear();
    setShellTabs.mockClear();
    vi.stubGlobal('window', { location: { search: '' } });
  });

  it('sends a live theme change through the registered Capacitor plugin', async () => {
    const { reportNativeShellTheme } = await import('../utils/nativeShell');
    reportNativeShellTheme('light');
    await vi.waitFor(() => expect(setShellTheme).toHaveBeenCalledWith({ theme: 'light' }));
  });

  it('reports pull-to-refresh completion through the same reliable bridge', async () => {
    const { reportNativeRefreshComplete } = await import('../utils/nativeShell');
    reportNativeRefreshComplete(true);
    await vi.waitFor(() => expect(reportRefreshComplete).toHaveBeenCalledWith({ success: true }));
  });

  it('keeps the native More menu in the same live/backtest world', async () => {
    const { reportNativeShellWorld } = await import('../utils/nativeShell');
    reportNativeShellWorld('backtest');
    await vi.waitFor(() => expect(setShellWorld).toHaveBeenCalledWith({ world: 'backtest' }));
  });

  it('reports the active page so the native bar highlights the real tab', async () => {
    const { reportNativeShellPage } = await import('../utils/nativeShell');
    reportNativeShellPage('live');
    await vi.waitFor(() => expect(setShellPage).toHaveBeenCalledWith({ page: 'live' }));
  });

  it('reports the open review so the native bar keeps Hodnotit selected', async () => {
    const { reportNativeShellReview } = await import('../utils/nativeShell');
    reportNativeShellReview(true);
    await vi.waitFor(() => expect(setShellReview).toHaveBeenCalledWith({ open: true }));
  });

  it('reports the number of trades waiting for review as a whole number', async () => {
    const { reportNativeShellReviewCount } = await import('../utils/nativeShell');
    reportNativeShellReviewCount(3.7);
    await vi.waitFor(() => expect(setShellReviewCount).toHaveBeenCalledWith({ count: 3 }));
  });

  it('reads the configurable tab slots from the native shell', async () => {
    const { loadNativeShellTabs } = await import('../utils/nativeShell');
    await expect(loadNativeShellTabs()).resolves.toEqual(['dashboard', 'history', 'live']);
    expect(getShellTabs).toHaveBeenCalledTimes(1);
  });

  it('normalizes an invalid slot choice before it reaches the native shell', async () => {
    const { saveNativeShellTabs } = await import('../utils/nativeShell');
    await expect(saveNativeShellTabs(['live', 'live', 'live'])).resolves.toEqual(['dashboard', 'history', 'journal']);
    expect(setShellTabs).toHaveBeenCalledWith({ slots: ['dashboard', 'history', 'journal'] });
  });
});
