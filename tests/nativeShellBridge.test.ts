import { beforeEach, describe, expect, it, vi } from 'vitest';

const setShellTheme = vi.fn(() => Promise.resolve({ theme: 'light' }));
const reportRefreshComplete = vi.fn(() => Promise.resolve());
const setShellWorld = vi.fn(() => Promise.resolve({ world: 'backtest' }));

vi.mock('../utils/runtimeConfig', () => ({ isNativeBuild: true }));
vi.mock('../services/alphaTradeNativePlugin', () => ({
  alphaTradeNativePlugin: { setShellTheme, reportRefreshComplete, setShellWorld },
}));

describe('native shell Capacitor bridge', () => {
  beforeEach(() => {
    setShellTheme.mockClear();
    reportRefreshComplete.mockClear();
    setShellWorld.mockClear();
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
});
