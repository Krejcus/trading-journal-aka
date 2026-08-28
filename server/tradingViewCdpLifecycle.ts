import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const TRADINGVIEW_BINARY = '/Applications/TradingView.app/Contents/MacOS/TradingView';
const CDP_ORIGIN = 'http://127.0.0.1:9222';

export type TradingViewCdpEnsureResult =
  | 'ready'
  | 'auto-launch-disabled'
  | 'running-without-cdp'
  | 'launched'
  | 'launch-failed';

interface TradingViewCdpLifecycleDeps {
  fetchImpl?: typeof fetch;
  processRunning?: () => Promise<boolean>;
  launch?: () => Promise<void> | void;
}

const cdpReachable = async (fetchImpl: typeof fetch): Promise<boolean> => {
  try {
    const response = await fetchImpl(`${CDP_ORIGIN}/json/version`, {
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok;
  } catch {
    return false;
  }
};

const tradingViewRunning = async (): Promise<boolean> => {
  try {
    await execFileAsync('/usr/bin/pgrep', ['-x', 'TradingView']);
    return true;
  } catch {
    return false;
  }
};

const launchTradingViewWithCdp = (): void => {
  const child = spawn(TRADINGVIEW_BINARY, [
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=9222',
  ], { detached: true, stdio: 'ignore' });
  child.unref();
};

/**
 * Bezpečný lifecycle: existující TradingView nikdy nezabíjí ani nerestartuje.
 * Automaticky ho spustí jen tehdy, když neběží, a pouze po opt-inu instalace.
 */
export async function ensureTradingViewCdp(
  autoLaunch: boolean,
  deps: TradingViewCdpLifecycleDeps = {},
): Promise<TradingViewCdpEnsureResult> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  if (await cdpReachable(fetchImpl)) return 'ready';
  if (!autoLaunch) return 'auto-launch-disabled';
  if (await (deps.processRunning ?? tradingViewRunning)()) return 'running-without-cdp';
  try {
    await (deps.launch ?? launchTradingViewWithCdp)();
    return 'launched';
  } catch {
    return 'launch-failed';
  }
}
